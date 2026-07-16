import { beforeEach, describe, expect, it } from "vitest";
import { FakeSqlDatabase } from "@/adapters/storage/fakeDb";
import {
  createActivityRepository,
  createNotificationRepository,
  createProviderRepository,
  createResetEventRepository,
  createSchedulerRepository,
  createSettingsRepository,
  createSnapshotRepository,
} from "@/adapters/storage/repositories";
import { InMemorySecretStore } from "@/adapters/platform";
import type { CandidateEvent } from "@/domain/notificationEvents";
import type { NotificationChannelAdapter, NotificationResult } from "@/ports";
import { createDemoDataService, DEMO_IDS } from "./demoData";
import { createExportImportService } from "./exportImport";
import { createMonitorService } from "./monitorService";
import { createNotificationDispatcher } from "./notificationDispatcher";
import { SETTINGS_KEYS } from "./settingsKeys";

const NOW = "2026-07-15T10:00:00.000Z";

function makeRepos() {
  const db = new FakeSqlDatabase();
  return {
    db,
    providerRepo: createProviderRepository(db),
    snapshotRepo: createSnapshotRepository(db),
    activityRepo: createActivityRepository(db),
    resetRepo: createResetEventRepository(db),
    notificationRepo: createNotificationRepository(db),
    settingsRepo: createSettingsRepository(db),
    schedulerRepo: createSchedulerRepository(db),
  };
}

function fakeAdapter(
  type: NotificationChannelAdapter["type"],
  result: () => NotificationResult
): NotificationChannelAdapter & { sends: number } {
  const adapter = {
    type,
    sends: 0,
    async validateConfiguration() {
      return { ok: true } as const;
    },
    async send() {
      adapter.sends += 1;
      return result();
    },
  };
  return adapter;
}

function candidate(partial: Partial<CandidateEvent> = {}): CandidateEvent {
  return {
    eventKey: "claude:weekly:reset_confirmed:2026-07-20T07:00:00.000Z",
    eventType: "reset_confirmed",
    providerId: "claude",
    limitId: "lim-1",
    title: "Claude 額度已確認重置",
    body: "目前已使用 2%。",
    severity: "info",
    ...partial,
  };
}

async function saveChannel(
  repos: ReturnType<typeof makeRepos>,
  overrides: Partial<Parameters<typeof repos.notificationRepo.saveChannel>[0]> = {}
) {
  await repos.notificationRepo.saveChannel({
    id: "ch-1",
    type: "desktop",
    displayName: "Desktop",
    enabled: true,
    eventPreferences: {
      reset_expected: true,
      reset_confirmed: true,
      usage_warning: true,
      exhaustion_forecast: true,
      polling_failed: false,
      data_stale: false,
    },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
}

describe("NotificationDispatcher (spec §9 / §20 cases 19-23)", () => {
  let repos: ReturnType<typeof makeRepos>;
  let secretStore: InMemorySecretStore;

  beforeEach(() => {
    repos = makeRepos();
    secretStore = new InMemorySecretStore();
  });

  function dispatcher(adapters: Record<string, NotificationChannelAdapter>, enabled = true) {
    return createNotificationDispatcher({
      repo: repos.notificationRepo,
      secretStore,
      adapters,
      notificationsEnabled: async () => enabled,
      now: () => NOW,
    });
  }

  it("case 19+21: the same event is delivered once, re-dispatch does not resend", async () => {
    await saveChannel(repos);
    const desktop = fakeAdapter("desktop", () => ({ ok: true, deliveredAt: NOW }));
    const d = dispatcher({ desktop });
    const first = await d.dispatch([candidate()]);
    expect(first.sent).toBe(1);
    const second = await d.dispatch([candidate()]);
    expect(second.sent).toBe(0);
    expect(desktop.sends).toBe(1);
  });

  it("case 20: two channels each deliver the same event once", async () => {
    await saveChannel(repos, { id: "ch-1", type: "desktop" });
    await saveChannel(repos, { id: "ch-2", type: "discord" });
    const desktop = fakeAdapter("desktop", () => ({ ok: true, deliveredAt: NOW }));
    const discord = fakeAdapter("discord", () => ({ ok: true, deliveredAt: NOW }));
    const d = dispatcher({ desktop, discord });
    const summary = await d.dispatch([candidate()]);
    expect(summary.sent).toBe(2);
    expect(desktop.sends).toBe(1);
    expect(discord.sends).toBe(1);
  });

  it("per-channel event preferences gate delivery", async () => {
    await saveChannel(repos, {
      eventPreferences: {
        reset_expected: false,
        reset_confirmed: false, // this event type is off
        usage_warning: true,
        exhaustion_forecast: true,
        polling_failed: false,
        data_stale: false,
      },
    });
    const desktop = fakeAdapter("desktop", () => ({ ok: true, deliveredAt: NOW }));
    const d = dispatcher({ desktop });
    const summary = await d.dispatch([candidate()]);
    expect(summary.sent).toBe(0);
    expect(desktop.sends).toBe(0);
  });

  it("master switch off: nothing is dispatched at all", async () => {
    await saveChannel(repos);
    const desktop = fakeAdapter("desktop", () => ({ ok: true, deliveredAt: NOW }));
    const d = dispatcher({ desktop }, false);
    const summary = await d.dispatch([candidate()]);
    expect(summary.sent).toBe(0);
    expect(desktop.sends).toBe(0);
  });

  it("case 23: quiet hours mark the delivery skipped, not sent", async () => {
    // NOW is 10:00 UTC → quiet window covering it
    await saveChannel(repos, { quietHoursStart: "00:00", quietHoursEnd: "23:59" });
    const desktop = fakeAdapter("desktop", () => ({ ok: true, deliveredAt: NOW }));
    const d = dispatcher({ desktop });
    const summary = await d.dispatch([candidate()]);
    expect(summary.skipped).toBe(1);
    expect(desktop.sends).toBe(0);
    const deliveries = await repos.notificationRepo.listDeliveries({});
    expect(deliveries[0]!.status).toBe("skipped");
    expect(deliveries[0]!.errorCode).toBe("quiet_hours");
  });

  it("case 22: failures retry up to the cap and then stop", async () => {
    await saveChannel(repos);
    const desktop = fakeAdapter("desktop", () => ({
      ok: false,
      errorCode: "desktop_failed",
      message: "boom",
    }));
    const d = dispatcher({ desktop });
    await d.dispatch([candidate()]); // attempt 1
    await d.retryFailed(); // attempt 2
    await d.retryFailed(); // attempt 3 (cap)
    await d.retryFailed(); // must NOT attempt again
    expect(desktop.sends).toBe(3);
    const deliveries = await repos.notificationRepo.listDeliveries({});
    expect(deliveries[0]!.attemptCount).toBe(3);
    expect(deliveries[0]!.status).toBe("failed");
  });

  it("test notification returns adapter failure message", async () => {
    const desktop = fakeAdapter("desktop", () => ({
      ok: false,
      errorCode: "x",
      message: "沒有權限",
    }));
    const d = dispatcher({ desktop });
    const res = await d.sendTest({
      id: "ch-t",
      type: "desktop",
      displayName: "d",
      enabled: true,
      eventPreferences: {
        reset_expected: true,
        reset_confirmed: true,
        usage_warning: true,
        exhaustion_forecast: true,
        polling_failed: true,
        data_stale: true,
      },
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(res.ok).toBe(false);
    expect(res.message).toBe("沒有權限");
  });
});

describe("MonitorService (spec §8 flow 7)", () => {
  let repos: ReturnType<typeof makeRepos>;

  beforeEach(async () => {
    repos = makeRepos();
    await repos.providerRepo.saveAccount({
      id: "acc-1",
      providerId: "claude",
      displayName: "Main",
      active: true,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await repos.providerRepo.savePlan({
      id: "plan-1",
      providerId: "claude",
      accountId: "acc-1",
      name: "Max 5x",
      monthlyPrice: 100,
      currency: "USD",
      active: true,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await repos.providerRepo.saveLimit({
      id: "lim-1",
      planId: "plan-1",
      name: "Weekly",
      type: "weekly",
      timezone: "UTC",
      active: true,
      monitoringEnabled: true,
      notifyEnabled: true,
      createdAt: NOW,
      updatedAt: NOW,
    });
  });

  function monitor(now = NOW) {
    const dispatcher = createNotificationDispatcher({
      repo: repos.notificationRepo,
      secretStore: new InMemorySecretStore(),
      adapters: { desktop: fakeAdapter("desktop", () => ({ ok: true, deliveredAt: now })) },
      notificationsEnabled: async () => true,
      now: () => now,
    });
    return createMonitorService({
      providerRepo: repos.providerRepo,
      snapshotRepo: repos.snapshotRepo,
      resetRepo: repos.resetRepo,
      schedulerRepo: repos.schedulerRepo,
      settingsRepo: repos.settingsRepo,
      dispatcher,
      now: () => now,
    });
  }

  async function insertSnap(id: string, capturedAt: string, used: number, resetAt?: string) {
    await repos.snapshotRepo.insert({
      id,
      providerId: "claude",
      accountId: "acc-1",
      limitId: "lim-1",
      usedPercent: used,
      remainingPercent: 100 - used,
      resetAt,
      capturedAt,
      source: "manual",
      valid: true,
      confidence: 1,
    });
  }

  it("manual-only + resetAt reached → records an EXPECTED reset (never confirmed), no fabricated snapshots", async () => {
    await insertSnap("s1", "2026-07-15T00:00:00.000Z", 70, "2026-07-15T08:00:00.000Z");
    const result = await monitor().runOnce("manual"); // NOW is 10:00, past resetAt 08:00
    expect(result.skipped).toBe(false);
    const resets = await repos.resetRepo.listByLimit("lim-1");
    expect(resets).toHaveLength(1);
    expect(resets[0]!.detectionMethod).toBe("expected_time_reached");
    // no new snapshots were invented
    expect(await repos.snapshotRepo.listAll()).toHaveLength(1);
  });

  it("usage drop → records a CONFIRMED reset and does not duplicate on the next run", async () => {
    await insertSnap("s1", "2026-07-15T06:00:00.000Z", 80, "2026-07-15T08:00:00.000Z");
    await insertSnap("s2", "2026-07-15T09:00:00.000Z", 2, "2026-07-22T08:00:00.000Z");
    const m = monitor();
    await m.runOnce("manual");
    await m.runOnce("manual");
    const resets = await repos.resetRepo.listByLimit("lim-1");
    const confirmed = resets.filter((r) => r.detectionMethod === "confirmed_by_usage_drop");
    expect(confirmed).toHaveLength(1);
  });

  it("produces a forecast per monitored limit and skips when polling disabled", async () => {
    await insertSnap("s1", "2026-07-15T06:00:00.000Z", 30, "2026-07-16T08:00:00.000Z");
    await insertSnap("s2", "2026-07-15T09:00:00.000Z", 45, "2026-07-16T08:00:00.000Z");
    const result = await monitor().runOnce("manual");
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]!.forecast.burnRateCurrentCycle).toBeGreaterThan(0);

    await repos.settingsRepo.set(SETTINGS_KEYS.pollingEnabled, "false");
    const skipped = await monitor().runOnce("interval");
    expect(skipped.skipped).toBe(true);
  });
});

describe("Export / Import (spec §15 / §20 cases 24,25)", () => {
  let repos: ReturnType<typeof makeRepos>;

  function service() {
    return createExportImportService({
      providerRepo: repos.providerRepo,
      snapshotRepo: repos.snapshotRepo,
      activityRepo: repos.activityRepo,
      resetRepo: repos.resetRepo,
      notificationRepo: repos.notificationRepo,
      settingsRepo: repos.settingsRepo,
      appVersion: "0.1.0-test",
    });
  }

  beforeEach(async () => {
    repos = makeRepos();
    await repos.providerRepo.saveAccount({
      id: "acc-1",
      providerId: "claude",
      displayName: "Main",
      active: true,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await repos.snapshotRepo.insert({
      id: "s1",
      providerId: "claude",
      accountId: "acc-1",
      limitId: "lim-1",
      usedPercent: 40,
      remainingPercent: 60,
      capturedAt: NOW,
      source: "manual",
      valid: true,
      confidence: 1,
    });
  });

  it("case 24: export contains no secret values even when channels have secrets configured", async () => {
    await repos.notificationRepo.saveChannel({
      id: "ch-1",
      type: "discord",
      displayName: "Discord",
      enabled: true,
      secretRef: "notification-channel:discord:ch-1",
      config: { chatId: "12345" },
      eventPreferences: {
        reset_expected: false,
        reset_confirmed: true,
        usage_warning: true,
        exhaustion_forecast: true,
        polling_failed: false,
        data_stale: false,
      },
      createdAt: NOW,
      updatedAt: NOW,
    });
    const bundle = await service().exportBundle();
    const json = JSON.stringify(bundle);
    expect(json).not.toContain("https://discord.com");
    expect(json).not.toContain("chatId");
    // secretRef (a pointer) is allowed
    expect(json).toContain("notification-channel:discord:ch-1");
    expect(bundle.schemaVersion).toBe(1);
    expect(bundle.snapshots).toHaveLength(1);
  });

  it("case 25: invalid import is rejected and existing data is untouched", async () => {
    const before = await repos.snapshotRepo.listAll();
    const summary = await service().importBundle({ schemaVersion: 999 }, "replace");
    expect(summary.applied).toBe(false);
    expect(await repos.snapshotRepo.listAll()).toEqual(before);
  });

  it("merge import adds new rows without overwriting existing history", async () => {
    const bundle = await service().exportBundle();
    bundle.snapshots.push({ ...bundle.snapshots[0]!, id: "s2", usedPercent: 50, remainingPercent: 50 });
    const summary = await service().importBundle(bundle, "merge");
    expect(summary.applied).toBe(true);
    expect(summary.counts.snapshots).toBe(1); // only the new one
    expect(await repos.snapshotRepo.listAll()).toHaveLength(2);
  });

  it("replace import swaps the dataset after validation", async () => {
    const bundle = await service().exportBundle();
    bundle.snapshots = [{ ...bundle.snapshots[0]!, id: "only", usedPercent: 5, remainingPercent: 95 }];
    const summary = await service().importBundle(bundle, "replace");
    expect(summary.applied).toBe(true);
    const all = await repos.snapshotRepo.listAll();
    expect(all).toHaveLength(1);
    expect(all[0]!.id).toBe("only");
  });
});

describe("Demo data (spec §18)", () => {
  it("loads a tagged demo dataset and clears it completely", async () => {
    const repos = makeRepos();
    const demo = createDemoDataService({
      providerRepo: repos.providerRepo,
      snapshotRepo: repos.snapshotRepo,
      activityRepo: repos.activityRepo,
      resetRepo: repos.resetRepo,
      notificationRepo: repos.notificationRepo,
      settingsRepo: repos.settingsRepo,
    });
    await demo.load(NOW);

    expect(await repos.settingsRepo.get(SETTINGS_KEYS.demoMode)).toBe("true");
    expect((await repos.providerRepo.listLimits()).length).toBe(3);
    const snaps = await repos.snapshotRepo.listAll();
    expect(snaps.length).toBeGreaterThanOrEqual(20);
    expect(snaps.every((s) => s.source === "demo")).toBe(true);
    expect((await repos.activityRepo.listAll()).length).toBeGreaterThanOrEqual(12);
    expect((await repos.resetRepo.listAll()).length).toBeGreaterThanOrEqual(2);

    // demo channel is disabled and has no secret
    const channels = await repos.notificationRepo.listChannels();
    const demoChannel = channels.find((c) => c.id === DEMO_IDS.discordChannel)!;
    expect(demoChannel.enabled).toBe(false);
    expect(demoChannel.secretRef).toBeUndefined();

    await demo.clear();
    expect(await repos.settingsRepo.get(SETTINGS_KEYS.demoMode)).toBe("false");
    expect(await repos.snapshotRepo.listAll()).toHaveLength(0);
    expect(await repos.activityRepo.listAll()).toHaveLength(0);
    expect(await repos.providerRepo.listAccounts()).toHaveLength(0);
    expect((await repos.notificationRepo.listChannels()).find((c) => c.id.startsWith("demo-"))).toBeUndefined();
  });
});
