// MonitorService — the hourly/launch check (spec §8 flow 7). One pass:
//   guard single-flight → per monitored limit: detect reset → forecast → evaluate events →
//   dispatch notifications → record run. With manual-only sources it NEVER fabricates snapshots;
//   reaching resetAt can only produce a "reset expected" event, never a confirmed one.

import { computeForecast } from "@/domain/forecast";
import { detectReset } from "@/domain/resetDetection";
import {
  isLimitNotificationEventEnabled,
  limitUsageWarningThreshold,
  parseLimitNotificationPreferences,
  parseLimitUsageWarningThresholds,
} from "@/domain/limitNotificationPreferences";
import {
  evaluateNotificationEvents,
  type CandidateEvent,
} from "@/domain/notificationEvents";
import type { ForecastResult, ResetEvent, UsageLimit, UsageSnapshot } from "@/domain/types";
import type {
  ProviderRepository,
  ResetEventRepository,
  SchedulerRepository,
  SettingsRepository,
  UsageSnapshotRepository,
} from "@/ports";
import { newId, nowIso } from "./ids";
import type { NotificationDispatcher } from "./notificationDispatcher";
import { SETTINGS_KEYS, settingBool, settingNum } from "./settingsKeys";

const PROVIDER_LABELS: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  chatgpt: "ChatGPT",
  gemini: "Gemini",
  cursor: "Cursor",
  custom: "Custom",
};

const LIMIT_TYPE_LABELS: Record<string, string> = {
  rolling_session: "Session 額度",
  weekly: "週額度",
  weekly_model: "模型週額度",
  context: "Context 額度",
  credits: "Credits",
  custom: "自訂額度",
};

function codexResetCreditMetadata(note: string | undefined): {
  resetAvailableCount?: number;
  resetCredits?: Array<{ title: string; expiresAtUnix?: number }>;
} | undefined {
  if (!note?.startsWith("AUTO:")) return undefined;
  try {
    const parsed = JSON.parse(note.slice(5)) as Record<string, unknown>;
    if (parsed.kind !== "codex-local") return undefined;
    return {
      resetAvailableCount: typeof parsed.resetAvailableCount === "number" ? parsed.resetAvailableCount : undefined,
      resetCredits: Array.isArray(parsed.resetCredits)
        ? parsed.resetCredits.filter((item): item is { title: string; expiresAtUnix?: number } =>
            Boolean(item) && typeof item === "object" && typeof (item as { title?: unknown }).title === "string"
          )
        : undefined,
    };
  } catch {
    return undefined;
  }
}

export type LimitCheckResult = {
  limit: UsageLimit;
  forecast: ForecastResult;
  latest?: UsageSnapshot;
  resetEventRecorded?: ResetEvent;
  candidates: CandidateEvent[];
};

export type MonitorRunResult = {
  ranAt: string;
  skipped: boolean;
  reason?: string;
  checks: LimitCheckResult[];
  dispatched: { sent: number; skipped: number; failed: number };
};

export type MonitorDeps = {
  providerRepo: ProviderRepository;
  snapshotRepo: UsageSnapshotRepository;
  resetRepo: ResetEventRepository;
  schedulerRepo: SchedulerRepository;
  settingsRepo: SettingsRepository;
  dispatcher: NotificationDispatcher;
  now?: () => string;
  collectLocalUsage?: () => Promise<number>;
};

export function createMonitorService(deps: MonitorDeps) {
  const now = deps.now ?? nowIso;
  let inFlight = false;

  async function checkLimit(limit: UsageLimit, accountProviderId: string): Promise<LimitCheckResult> {
    const snapshots = await deps.snapshotRepo.listByLimit(limit.id);
    const valid = snapshots.filter((s) => s.valid);
    const latest = valid[valid.length - 1];
    const previous = valid[valid.length - 2];

    // Reset detection against the previous cycle's expectation.
    const expectedResetAt = previous?.resetAt ?? latest?.resetAt;
    const resetAtAdvanced = Boolean(
      latest?.resetAt && previous?.resetAt && Date.parse(latest.resetAt) > Date.parse(previous.resetAt)
    );

    const lowReadings = [...valid]
      .reverse()
      .filter((s) => s.usedPercent <= 5).length;

    const outcome = detectReset({
      previous,
      current: latest,
      now: now(),
      expectedResetAt,
      resetAtAdvanced,
      consecutiveLowReadings: lowReadings,
    });

    // Record the reset event once per anchor (avoid duplicating on every hourly run).
    let resetEventRecorded: ResetEvent | undefined;
    if (outcome.kind !== "none") {
      const latestRecorded = await deps.resetRepo.latestByLimit(limit.id);
      const sameAnchor =
        latestRecorded &&
        latestRecorded.expectedResetAt === outcome.expectedResetAt &&
        latestRecorded.detectionMethod === outcome.method;
      // An "expected" event is superseded by a "confirmed" one for the same anchor.
      const upgradeable =
        latestRecorded &&
        latestRecorded.expectedResetAt === outcome.expectedResetAt &&
        latestRecorded.detectionMethod === "expected_time_reached" &&
        outcome.kind === "confirmed";
      if (!sameAnchor || upgradeable) {
        resetEventRecorded = {
          id: newId("reset"),
          providerId: (latest?.providerId ?? accountProviderId) as ResetEvent["providerId"],
          accountId: latest?.accountId ?? "",
          limitId: limit.id,
          previousUsedPercent: outcome.previousUsedPercent,
          currentUsedPercent: outcome.currentUsedPercent,
          expectedResetAt: outcome.expectedResetAt,
          detectedAt: now(),
          detectionMethod: outcome.method ?? "manual",
          confidence: outcome.confidence,
        };
        await deps.resetRepo.insert(resetEventRecorded);
      }
    }

    // Cycle start = last confirmed reset (for cycle burn rate).
    const resetEvents = await deps.resetRepo.listByLimit(limit.id);
    const lastConfirmed = [...resetEvents]
      .reverse()
      .find((e) => e.detectionMethod !== "expected_time_reached");

    const manualOnly = valid.every((s) => s.source === "manual" || s.source === "json_import");
    const isDemo = valid.length > 0 && valid.every((s) => s.source === "demo");

    const forecast = computeForecast({
      limitId: limit.id,
      snapshots,
      now: now(),
      resetAt: latest?.resetAt,
      cycleStartIso: lastConfirmed?.detectedAt,
      manualOnly,
      sourceReliability: isDemo ? "demo" : manualOnly ? "manual" : "automated",
    });

    const settings = await deps.settingsRepo.getAll();
    const limitPreferences = parseLimitNotificationPreferences(
      settings[SETTINGS_KEYS.limitEventPreferences]
    );
    const globalUsageWarningThreshold = settingNum(
      settings[SETTINGS_KEYS.usageWarningRemainingPercent],
      15
    );
    const limitUsageWarningThresholds = parseLimitUsageWarningThresholds(
      settings[SETTINGS_KEYS.limitUsageWarningThresholds]
    );
    const candidates = limit.notifyEnabled
      ? evaluateNotificationEvents({
          providerId: (latest?.providerId ?? "custom") as CandidateEvent["providerId"] & string,
          providerLabel: PROVIDER_LABELS[latest?.providerId ?? "custom"] ?? "AI",
          accountId: latest?.accountId,
          limitId: limit.id,
          limitKey: `${limit.type}:${limit.id.slice(0, 8)}`,
          limitLabel: LIMIT_TYPE_LABELS[limit.type] ?? limit.name,
          now: now(),
          currentUsedPercent: latest?.usedPercent,
          remainingPercent: latest ? latest.remainingPercent : undefined,
          nextResetAt: latest?.resetAt,
          windowHours: limit.windowHours,
          forecast,
          resetOutcome: outcome.kind === "none" ? undefined : outcome,
          lastSuccessAt: latest?.capturedAt,
          resetCredits: codexResetCreditMetadata(latest?.note)?.resetCredits,
          resetCreditsAvailable: codexResetCreditMetadata(latest?.note)?.resetAvailableCount,
          settings: {
            usageWarningRemainingPercent: settingNum(
              String(limitUsageWarningThreshold(
                limitUsageWarningThresholds,
                limit.id,
                globalUsageWarningThreshold
              )),
              globalUsageWarningThreshold
            ),
            dataStaleHours: settingNum(settings[SETTINGS_KEYS.dataStaleHours], 8),
            exhaustionWarningLeadHours: settingNum(
              settings[SETTINGS_KEYS.exhaustionWarningLeadHours],
              6
            ),
          },
        }).filter((candidate) =>
          isLimitNotificationEventEnabled(limitPreferences, limit.id, candidate.eventType)
        )
      : [];

    return { limit, forecast, latest, resetEventRecorded, candidates };
  }

  return {
    async runOnce(trigger: "launch" | "interval" | "manual"): Promise<MonitorRunResult> {
      const ranAt = now();

      const settings = await deps.settingsRepo.getAll();
      if (
        trigger === "interval" &&
        (!settingBool(settings[SETTINGS_KEYS.pollingEnabled], true) ||
          settingBool(settings[SETTINGS_KEYS.monitoringPaused], false))
      ) {
        return { ranAt, skipped: true, reason: "polling disabled or paused", checks: [], dispatched: { sent: 0, skipped: 0, failed: 0 } };
      }

      if (inFlight) {
        return { ranAt, skipped: true, reason: "already running", checks: [], dispatched: { sent: 0, skipped: 0, failed: 0 } };
      }
      inFlight = true;

      const run = { id: newId("run"), startedAt: ranAt, status: "running" as const, trigger };
      await deps.schedulerRepo.insertRun(run);

      try {
        await deps.collectLocalUsage?.().catch(() => 0);
        const limits = (await deps.providerRepo.listLimits()).filter(
          (l) => l.active && l.monitoringEnabled
        );
        const plans = await deps.providerRepo.listPlans();
        const planById = new Map(plans.map((p) => [p.id, p]));

        const checks: LimitCheckResult[] = [];
        const allCandidates: CandidateEvent[] = [];
        for (const limit of limits) {
          const providerId = planById.get(limit.planId)?.providerId ?? "custom";
          const result = await checkLimit(limit, providerId);
          checks.push(result);
          allCandidates.push(...result.candidates);
        }

        const dispatchSummary = await deps.dispatcher.dispatch(allCandidates);
        const retrySummary = await deps.dispatcher.retryFailed();

        await deps.schedulerRepo.updateRun({
          ...run,
          finishedAt: now(),
          status: "success",
          detail: `${checks.length} limits, ${dispatchSummary.sent + retrySummary.sent} sent`,
        });

        return {
          ranAt,
          skipped: false,
          checks,
          dispatched: {
            sent: dispatchSummary.sent + retrySummary.sent,
            skipped: dispatchSummary.skipped,
            failed: dispatchSummary.failed + retrySummary.failed,
          },
        };
      } catch (err) {
        await deps.schedulerRepo.updateRun({
          ...run,
          finishedAt: now(),
          status: "failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        throw err;
      } finally {
        inFlight = false;
      }
    },
  };
}

export type MonitorService = ReturnType<typeof createMonitorService>;

/** Wall-clock scheduler: run on launch + every N hours. Pure JS timer; the decision logic
 *  (enabled/paused/single-flight) lives in MonitorService, not here. */
export function createScheduler(monitor: MonitorService, intervalHours: number) {
  let timer: ReturnType<typeof setInterval> | undefined;
  return {
    start() {
      if (timer) return;
      void monitor.runOnce("launch").catch(() => undefined);
      timer = setInterval(
        () => void monitor.runOnce("interval").catch(() => undefined),
        Math.max(0.1, intervalHours) * 3600_000
      );
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    isRunning() {
      return timer !== undefined;
    },
  };
}
