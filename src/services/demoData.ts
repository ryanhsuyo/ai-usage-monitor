// Demo dataset (spec §18): one-click load / clear. Everything is tagged with the demo- prefix and
// source "demo"; no real secrets are created and no external notification can fire from demo rows
// (the demo Discord channel is saved DISABLED with no secretRef).

import type {
  NotificationChannelConfig,
  ProviderAccount,
  ResetEvent,
  SubscriptionPlan,
  UsageActivity,
  UsageLimit,
  UsageSnapshot,
} from "@/domain/types";
import type {
  NotificationRepository,
  ProviderRepository,
  ResetEventRepository,
  SettingsRepository,
  UsageActivityRepository,
  UsageSnapshotRepository,
} from "@/ports";
import { SETTINGS_KEYS } from "./settingsKeys";

const DAY = 24 * 3600_000;
const HOUR = 3600_000;

export type DemoDeps = {
  providerRepo: ProviderRepository;
  snapshotRepo: UsageSnapshotRepository;
  activityRepo: UsageActivityRepository;
  resetRepo: ResetEventRepository;
  notificationRepo: NotificationRepository;
  settingsRepo: SettingsRepository;
};

export const DEMO_IDS = {
  account: "demo-account-claude",
  plan: "demo-plan-max5x",
  weeklyLimit: "demo-limit-weekly",
  sessionLimit: "demo-limit-session",
  starterLimit: "demo-limit-starter",
  discordChannel: "demo-channel-discord",
} as const;

export function createDemoDataService(deps: DemoDeps) {
  return {
    async load(nowIso = new Date().toISOString()): Promise<void> {
      const now = Date.parse(nowIso);
      const iso = (t: number) => new Date(t).toISOString();

      const account: ProviderAccount = {
        id: DEMO_IDS.account,
        providerId: "claude",
        displayName: "Demo Claude 帳號",
        active: true,
        createdAt: iso(now - 28 * DAY),
        updatedAt: nowIso,
      };
      await deps.providerRepo.saveAccount(account);

      const plan: SubscriptionPlan = {
        id: DEMO_IDS.plan,
        providerId: "claude",
        accountId: account.id,
        name: "Max 5x (Demo)",
        monthlyPrice: 100,
        currency: "USD",
        relativeCapacity: 5,
        active: true,
        startedAt: iso(now - 28 * DAY),
        createdAt: iso(now - 28 * DAY),
        updatedAt: nowIso,
      };
      await deps.providerRepo.savePlan(plan);

      // Weekly limit resets every Monday 15:00 UTC; find the next one from "now".
      const nextMonday = new Date(now);
      nextMonday.setUTCHours(15, 0, 0, 0);
      while (nextMonday.getUTCDay() !== 1 || nextMonday.getTime() <= now) {
        nextMonday.setTime(nextMonday.getTime() + DAY);
      }
      const nextResetMs = nextMonday.getTime();

      const weekly: UsageLimit = {
        id: DEMO_IDS.weeklyLimit,
        planId: plan.id,
        name: "Weekly（全模型）",
        type: "weekly",
        timezone: "UTC",
        active: true,
        monitoringEnabled: true,
        notifyEnabled: true,
        createdAt: iso(now - 28 * DAY),
        updatedAt: nowIso,
      };
      const session: UsageLimit = {
        id: DEMO_IDS.sessionLimit,
        planId: plan.id,
        name: "5-hour Session",
        type: "rolling_session",
        windowHours: 5,
        timezone: "UTC",
        active: true,
        monitoringEnabled: true,
        notifyEnabled: true,
        createdAt: iso(now - 28 * DAY),
        updatedAt: nowIso,
      };
      // The "insufficient data" showcase: a fresh limit with a single snapshot.
      const starter: UsageLimit = {
        id: DEMO_IDS.starterLimit,
        planId: plan.id,
        name: "Opus 週額度（資料不足示範）",
        type: "weekly_model",
        model: "opus",
        timezone: "UTC",
        active: true,
        monitoringEnabled: true,
        notifyEnabled: false,
        createdAt: iso(now - DAY),
        updatedAt: nowIso,
      };
      await deps.providerRepo.saveLimit(weekly);
      await deps.providerRepo.saveLimit(session);
      await deps.providerRepo.saveLimit(starter);

      // --- Weekly snapshots: 3 cycles over ~21 days, two confirmed resets, current cycle
      //     burning fast enough that exhaustion-before-reset is likely. ---
      const snapshots: UsageSnapshot[] = [];
      let sid = 0;
      const pushSnap = (limitId: string, t: number, used: number, resetAtMs: number) => {
        snapshots.push({
          id: `demo-snap-${++sid}`,
          providerId: "claude",
          accountId: account.id,
          limitId,
          usedPercent: Math.round(used * 10) / 10,
          remainingPercent: Math.round((100 - used) * 10) / 10,
          resetAt: iso(resetAtMs),
          capturedAt: iso(t),
          source: "demo",
          valid: true,
          confidence: 1,
        });
      };

      // cycle boundaries (Mondays before nextReset)
      const reset2 = nextResetMs - 7 * DAY; // start of current cycle
      const reset1 = nextResetMs - 14 * DAY;
      const cycle0Start = nextResetMs - 21 * DAY;

      // Cycle A (finished, hit ~97%)
      for (let i = 0; i < 14; i++) {
        const t = cycle0Start + (i * 12 + 6) * HOUR;
        if (t >= reset1) break;
        pushSnap(DEMO_IDS.weeklyLimit, t, Math.min(97, 4 + i * 7.2), reset1);
      }
      // Cycle B (finished, moderate ~72%)
      for (let i = 0; i < 14; i++) {
        const t = reset1 + (i * 12 + 5) * HOUR;
        if (t >= reset2) break;
        pushSnap(DEMO_IDS.weeklyLimit, t, Math.min(72, 3 + i * 5.4), reset2);
      }
      // Cycle C (current, fast burn — may exhaust before reset)
      const hoursIntoCycle = Math.max(6, Math.floor((now - reset2) / HOUR));
      for (let h = 4; h <= hoursIntoCycle; h += 8) {
        const used = Math.min(93, 2 + h * 1.15);
        pushSnap(DEMO_IDS.weeklyLimit, reset2 + h * HOUR, used, nextResetMs);
      }
      // one failed capture marker in the current cycle
      snapshots.push({
        id: `demo-snap-${++sid}`,
        providerId: "claude",
        accountId: account.id,
        limitId: DEMO_IDS.weeklyLimit,
        usedPercent: 0,
        remainingPercent: 0,
        capturedAt: iso(reset2 + 30 * HOUR),
        source: "demo",
        valid: false,
        confidence: 0,
        errorCode: "fetch_failed",
        note: "示範：一次抓取失敗（不會被當成 0%）",
      });

      // Session limit: a couple of recent readings
      pushSnap(DEMO_IDS.sessionLimit, now - 3 * HOUR, 35, now + 2 * HOUR);
      pushSnap(DEMO_IDS.sessionLimit, now - 1 * HOUR, 58, now + 2 * HOUR);

      // Starter limit: exactly one snapshot → insufficient data everywhere
      pushSnap(DEMO_IDS.starterLimit, now - 5 * HOUR, 12, nextResetMs);

      for (const sn of snapshots) await deps.snapshotRepo.insert(sn);

      // --- Reset events for the two completed cycles ---
      const resets: ResetEvent[] = [
        {
          id: "demo-reset-1",
          providerId: "claude",
          accountId: account.id,
          limitId: DEMO_IDS.weeklyLimit,
          previousUsedPercent: 97,
          currentUsedPercent: 3,
          expectedResetAt: iso(reset1),
          detectedAt: iso(reset1 + 2 * HOUR),
          detectionMethod: "confirmed_by_usage_drop",
          confidence: 0.9,
        },
        {
          id: "demo-reset-2",
          providerId: "claude",
          accountId: account.id,
          limitId: DEMO_IDS.weeklyLimit,
          previousUsedPercent: 72,
          currentUsedPercent: 2,
          expectedResetAt: iso(reset2),
          detectedAt: iso(reset2 + 1 * HOUR),
          detectionMethod: "confirmed_by_usage_drop",
          confidence: 0.9,
        },
      ];
      for (const e of resets) await deps.resetRepo.insert(e);

      // --- Activities: 14 items across types (≥3 coding / general / large_context) ---
      const mk = (
        i: number,
        taskType: UsageActivity["taskType"],
        startHoursAgo: number,
        delta: number,
        project: string,
        model = "sonnet"
      ): UsageActivity => ({
        id: `demo-act-${i}`,
        providerId: "claude",
        accountId: account.id,
        limitId: DEMO_IDS.weeklyLimit,
        model,
        projectName: project,
        taskType,
        startedAt: iso(now - startHoursAgo * HOUR),
        endedAt: iso(now - (startHoursAgo - 1) * HOUR),
        usageBefore: 30,
        usageAfter: 30 + delta,
        usageDelta: delta,
        status: "completed",
      });
      const activities: UsageActivity[] = [
        mk(1, "coding", 60, 6.5, "backend-api", "opus"),
        mk(2, "coding", 52, 5.2, "backend-api", "opus"),
        mk(3, "coding", 44, 7.1, "frontend-app"),
        mk(4, "coding", 30, 5.8, "frontend-app", "opus"),
        mk(5, "general_chat", 58, 1.2, "adhoc"),
        mk(6, "general_chat", 41, 0.9, "adhoc"),
        mk(7, "general_chat", 26, 1.5, "adhoc"),
        mk(8, "short_chat", 55, 0.4, "adhoc"),
        mk(9, "short_chat", 38, 0.3, "adhoc"),
        mk(10, "short_chat", 22, 0.5, "adhoc"),
        mk(11, "large_context", 47, 11.4, "data-migration", "opus"),
        mk(12, "large_context", 33, 9.8, "data-migration", "opus"),
        mk(13, "large_context", 18, 12.6, "data-migration", "opus"),
        mk(14, "research", 12, 3.1, "market-research"),
      ];
      for (const a of activities) await deps.activityRepo.insert(a);

      // --- Demo Discord channel: DISABLED, no secretRef, cannot send anything ---
      const channel: NotificationChannelConfig = {
        id: DEMO_IDS.discordChannel,
        type: "discord",
        displayName: "Demo Discord（未啟用示範）",
        enabled: false,
        eventPreferences: {
          quota_expiring: true, reset_expected: false,
          reset_confirmed: true,
          usage_warning: true,
          exhaustion_forecast: true,
          polling_failed: false,
          data_stale: false,
        },
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      await deps.notificationRepo.saveChannel(channel);

      // Sample delivery history (one success, one failure) tied to a demo event.
      await deps.notificationRepo.insertEvent({
        id: "demo-evt-1",
        eventKey: `demo:weekly:reset_confirmed:${iso(reset2)}`,
        eventType: "reset_confirmed",
        providerId: "claude",
        accountId: account.id,
        limitId: DEMO_IDS.weeklyLimit,
        title: "Claude 額度可能臨時／提前重置（Demo）",
        body: "目前已使用 2%。",
        severity: "info",
        createdAt: iso(reset2 + 1 * HOUR),
      });
      await deps.notificationRepo.insertDelivery({
        id: "demo-del-1",
        eventId: "demo-evt-1",
        eventKey: `demo:weekly:reset_confirmed:${iso(reset2)}`,
        channelId: DEMO_IDS.discordChannel,
        status: "sent",
        attemptCount: 1,
        attemptedAt: iso(reset2 + 1 * HOUR),
        deliveredAt: iso(reset2 + 1 * HOUR),
      });
      await deps.notificationRepo.insertEvent({
        id: "demo-evt-2",
        eventKey: `demo:weekly:usage_warning:${iso(nextResetMs)}`,
        eventType: "usage_warning",
        providerId: "claude",
        accountId: account.id,
        limitId: DEMO_IDS.weeklyLimit,
        title: "Claude 週額度即將用完（Demo）",
        body: "剩餘額度約 12%。",
        severity: "warning",
        createdAt: iso(now - 2 * HOUR),
      });
      await deps.notificationRepo.insertDelivery({
        id: "demo-del-2",
        eventId: "demo-evt-2",
        eventKey: `demo:weekly:usage_warning:${iso(nextResetMs)}`,
        channelId: DEMO_IDS.discordChannel,
        status: "failed",
        attemptCount: 3,
        attemptedAt: iso(now - 2 * HOUR),
        errorCode: "discord_http_error",
        errorMessage: "Discord 回應 HTTP 404（示範資料）",
      });

      await deps.settingsRepo.set(SETTINGS_KEYS.demoMode, "true");
    },

    async clear(): Promise<void> {
      // Delete in dependency order. Demo rows all carry the demo- prefix.
      const snapshots = await deps.snapshotRepo.listAll();
      for (const s of snapshots) {
        if (s.id.startsWith("demo-")) await deps.snapshotRepo.deleteById(s.id);
      }
      const activities = await deps.activityRepo.listAll();
      for (const a of activities) {
        if (a.id.startsWith("demo-")) await deps.activityRepo.deleteById(a.id);
      }
      // reset events cascade with the limit rows in real SQLite; delete explicitly for safety
      const limits = await deps.providerRepo.listLimits();
      for (const l of limits) {
        if (l.id.startsWith("demo-")) await deps.providerRepo.deleteLimit(l.id);
      }
      const plans = await deps.providerRepo.listPlans();
      for (const p of plans) {
        if (p.id.startsWith("demo-")) await deps.providerRepo.deletePlan(p.id);
      }
      const accounts = await deps.providerRepo.listAccounts();
      for (const a of accounts) {
        if (a.id.startsWith("demo-")) await deps.providerRepo.deleteAccount(a.id);
      }
      const channels = await deps.notificationRepo.listChannels();
      for (const c of channels) {
        if (c.id.startsWith("demo-")) await deps.notificationRepo.deleteChannel(c.id);
      }
      await deps.settingsRepo.set(SETTINGS_KEYS.demoMode, "false");
    },
  };
}

export type DemoDataService = ReturnType<typeof createDemoDataService>;
