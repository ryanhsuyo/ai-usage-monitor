import type { DataSourceRepository, DiagnosticLogger, ProviderRepository, UsageSnapshotRepository } from "@/ports";
import { estimateCodexApiEquivalent } from "@/domain/codexCost";
import { newId, nowIso } from "./ids";

export type LocalUsageReading = {
  providerId: "codex" | "claude";
  limitKey: string;
  limitName: string;
  usedPercent: number;
  windowMinutes: number;
  resetAtUnix: number;
  capturedAt: string;
  sessionCount: number;
  modelUsage: Array<{ model: string; inputTokens: number; cachedInputTokens: number; cacheCreationTokens?: number; cacheReadTokens?: number; outputTokens: number }>;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  resetAvailableCount?: number;
  resetCredits?: Array<{ title: string; expiresAtUnix?: number }>;
  resetCreditsAvailable?: boolean;
  quotaStale?: boolean;
  quotaCapturedAt?: string;
};

export function buildCodexMetadata(reading: LocalUsageReading) {
  const estimate = estimateCodexApiEquivalent(reading.modelUsage);
  return { kind: "codex-local", scope: `${reading.windowMinutes}-minute-cycle`, sessionCount: reading.sessionCount, models: reading.modelUsage, inputTokens: reading.inputTokens, cachedInputTokens: reading.cachedInputTokens, outputTokens: reading.outputTokens, resetAvailableCount: reading.resetAvailableCount ?? 0, resetCredits: reading.resetCredits ?? [], resetCreditsAvailable: reading.resetCreditsAvailable ?? false, ...estimate, pricingBasis: estimate.unpricedModels.length === 0 ? "openai-api-2026-07-16" : "partially-unavailable" };
}

export function buildClaudeMetadata(reading: LocalUsageReading) {
  return { kind: "claude-local-24h", period: "rolling-24-hours", sessionCount: reading.sessionCount, models: reading.modelUsage, inputTokens: reading.inputTokens, cachedInputTokens: reading.cachedInputTokens, outputTokens: reading.outputTokens, quotaStale: reading.quotaStale ?? false, quotaCapturedAt: reading.quotaCapturedAt ?? reading.capturedAt };
}

// Rolling token metadata (24h window) drifts on every collection, so a "changed note" alone must
// not insert a new snapshot each time — that floods the history with identical official readings.
const METADATA_REFRESH_MIN_MS = 10 * 60 * 1000;

/**
 * True when the only difference against the latest stored snapshot is volatile token metadata
 * (same official percent/reset/stale flag) and the last write is recent enough to skip.
 */
export function isDeferrableMetadataRefresh(
  latest: { usedPercent: number; resetAt?: string; note?: string; capturedAt: string } | undefined,
  reading: Pick<LocalUsageReading, "providerId" | "usedPercent" | "quotaStale">,
  resetAt: string | undefined,
  nowIso: string
): boolean {
  if (!latest) return false;
  if (latest.usedPercent !== reading.usedPercent || latest.resetAt !== resetAt) return false;
  if (reading.providerId === "claude"
    && latest.note?.includes(`"quotaStale":${reading.quotaStale === true}`) !== true) return false;
  return Date.parse(nowIso) - Date.parse(latest.capturedAt) < METADATA_REFRESH_MIN_MS;
}

export type LocalUsageProvider = "codex" | "claude";

export type LocalUsageCollection = {
  /** Snapshots written this run. */
  inserted: number;
  /**
   * Providers whose read failed. Distinct from "nothing changed": their numbers are now
   * unknown rather than merely unchanged, which is what makes a sync failure worth reporting.
   */
  failedProviders: LocalUsageProvider[];
};

let collectorInFlight: Promise<LocalUsageCollection> | undefined;

export function createLocalUsageCollector(
  providerRepo: ProviderRepository,
  snapshotRepo: UsageSnapshotRepository,
  dataSourceRepo: DataSourceRepository,
  diagnostics: DiagnosticLogger,
  enabled: boolean
) {
  return async (onlyProviders?: Array<"codex" | "claude">): Promise<LocalUsageCollection> => {
    if (!enabled) return { inserted: 0, failedProviders: [] };
    if (collectorInFlight) return collectorInFlight;
    collectorInFlight = (async () => {
    const failedProviders: LocalUsageProvider[] = [];
    const { invoke } = await import("@tauri-apps/api/core");
    const sourceStatuses = await dataSourceRepo.list();
    const collect = async (providerId: "codex" | "claude", command: string, displayName: string) => {
      const ranAt = nowIso();
      const previous = sourceStatuses.find((status) => status.adapterId === `${providerId}-local`);
      try {
        const result = await invoke<LocalUsageReading[]>(command);
        // Index access rather than .at(-1): the project targets ES2021, where .at() is not in
        // lib, and a fresh clone fails `pnpm typecheck` on it.
        const capturedTimes = result.map((reading) => reading.capturedAt).filter(Boolean).sort();
        const sourceCapturedAt = capturedTimes[capturedTimes.length - 1] ?? ranAt;
        const staleError = providerId === "claude" && result.some((reading) => reading.quotaStale)
          ? "Claude 有新活動，但官方 /usage 快取尚未更新；目前不顯示舊額度百分比"
          : undefined;
        if (!previous || previous.lastSuccessAt !== sourceCapturedAt || previous.lastError !== staleError) {
          await dataSourceRepo.save({ id: `${providerId}-local`, providerId, adapterId: `${providerId}-local`, displayName, enabled: true, supportsAutomaticPolling: true, reliability: "automated", lastRunAt: ranAt, lastSuccessAt: sourceCapturedAt, lastError: staleError, updatedAt: ranAt });
          await diagnostics.log("info", "local_usage_source_updated", `${providerId};readings=${result.length}`).catch(() => undefined);
        }
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!previous || previous.lastError !== message) {
          await dataSourceRepo.save({ id: `${providerId}-local`, providerId, adapterId: `${providerId}-local`, displayName, enabled: true, supportsAutomaticPolling: true, reliability: "automated", lastRunAt: ranAt, lastSuccessAt: previous?.lastSuccessAt, lastError: message, updatedAt: ranAt });
          await diagnostics.log("warn", "local_usage_source_failed", providerId).catch(() => undefined);
        }
        failedProviders.push(providerId);
        return [];
      }
    };
    const wants = (provider: "codex" | "claude") => !onlyProviders || onlyProviders.includes(provider);
    const [codex, claude] = await Promise.all([
      wants("codex") ? collect("codex", "read_codex_local_usage", "Codex 本機資料") : Promise.resolve([]),
      wants("claude") ? collect("claude", "read_claude_local_usage", "Claude Code /usage 本機快取") : Promise.resolve([]),
    ]);
    const readings = [...codex, ...claude];
    if (!readings.length) return { inserted: 0, failedProviders };
    const now = nowIso();
    const accounts = await providerRepo.listAccounts();
    const plans = await providerRepo.listPlans();
    const limits = await providerRepo.listLimits();
    let inserted = 0;
    for (const reading of readings) {
      let account = accounts.find((a) => a.providerId === reading.providerId);
      if (!account) {
        account = { id: newId("acc"), providerId: reading.providerId, displayName: reading.providerId === "codex" ? "本機 Codex" : "本機 Claude Code", active: true, createdAt: now, updatedAt: now };
        await providerRepo.saveAccount(account); accounts.push(account);
      }
      let plan = plans.find((p) => p.accountId === account!.id);
      if (!plan) {
        plan = { id: newId("plan"), providerId: reading.providerId, accountId: account.id, name: "自動偵測方案", monthlyPrice: 0, currency: "USD", active: true, createdAt: now, updatedAt: now };
        await providerRepo.savePlan(plan); plans.push(plan);
      }
      let limit = limits.find((l) => l.planId === plan!.id && l.resetRule === reading.limitKey);
      if (!limit && reading.providerId === "claude" && reading.limitKey.startsWith("claude-weekly_all-")) {
        limit = limits.find((l) => l.planId === plan!.id && l.type === "weekly" && (l.name.includes("全模型") || l.name === "Weekly"));
        if (limit) {
          limit = { ...limit, name: reading.limitName, resetRule: reading.limitKey, windowHours: 168, updatedAt: now };
          await providerRepo.saveLimit(limit);
          const index = limits.findIndex((item) => item.id === limit!.id);
          limits[index] = limit;
        }
      }
      if (!limit) {
        limit = { id: newId("lim"), planId: plan.id, name: reading.limitName, type: reading.windowMinutes === 10080 ? "weekly" : "rolling_session", windowHours: reading.windowMinutes / 60, resetRule: reading.limitKey, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", active: true, monitoringEnabled: true, notifyEnabled: true, createdAt: now, updatedAt: now };
        await providerRepo.saveLimit(limit);
        limits.push(limit);
      }
      const duplicateLimits = limits.filter((item) => item.planId === plan!.id && item.resetRule === reading.limitKey);
      if (duplicateLimits.length > 1) {
        await diagnostics.log("warn", "duplicate_limits_detected", `${reading.providerId};count=${duplicateLimits.length}`).catch(() => undefined);
        const withLatest = await Promise.all(duplicateLimits.map(async (item) => ({
          item,
          latest: await snapshotRepo.latestValidByLimit(item.id),
        })));
        withLatest.sort((a, b) => Date.parse(b.latest?.capturedAt ?? "") - Date.parse(a.latest?.capturedAt ?? ""));
        limit = withLatest[0]!.item;
        for (const duplicate of withLatest.slice(1)) {
          if (!duplicate.item.active) continue;
          const disabled = { ...duplicate.item, active: false, monitoringEnabled: false, notifyEnabled: false, updatedAt: now };
          await providerRepo.saveLimit(disabled);
          const index = limits.findIndex((item) => item.id === disabled.id);
          limits[index] = disabled;
        }
      }
      const latest = await snapshotRepo.latestValidByLimit(limit.id);
      const resetAt = reading.resetAtUnix > 0 ? new Date(reading.resetAtUnix * 1000).toISOString() : undefined;
      const note = `AUTO:${JSON.stringify(reading.providerId === "codex" ? buildCodexMetadata(reading) : buildClaudeMetadata(reading))}`;
      const sameReading = latest
        && latest.usedPercent === reading.usedPercent
        && latest.resetAt === resetAt
        && latest.note === note;
      if (sameReading) continue;
      if (isDeferrableMetadataRefresh(latest, reading, resetAt, now)) continue;

      // A collector upgrade can enrich an otherwise unchanged provider reading. Give that
      // one-time metadata upgrade a deterministic newer key so latestValidByLimit selects it;
      // subsequent polls are deduplicated by content above.
      // A stale Claude quota is an observation made by this collection run, even
      // though the embedded official quota timestamp is older. Store it as the
      // latest snapshot so an older, misleading percentage cannot remain visible.
      const requestedCapturedAt = reading.quotaStale ? now : (reading.capturedAt || now);
      const capturedAt = latest?.capturedAt === requestedCapturedAt
        ? new Date(Date.parse(requestedCapturedAt) + 1).toISOString()
        : requestedCapturedAt;
      await snapshotRepo.insert({ id: newId("snap"), providerId: reading.providerId, accountId: account.id, limitId: limit.id, usedPercent: reading.usedPercent, remainingPercent: 100 - reading.usedPercent, resetAt, capturedAt, source: "cli", valid: true, confidence: reading.quotaStale ? 0 : 1, note });
      inserted++;
    }
      return { inserted, failedProviders };
    })();
    try {
      return await collectorInFlight;
    } finally {
      collectorInFlight = undefined;
    }
  };
}
