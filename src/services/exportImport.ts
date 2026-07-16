// JSON export / import (spec §15). Export NEVER contains secret values — channels are exported
// with their preferences and secretRef only (the ref is a keychain pointer, not a secret).
// Import validates first (domain/importValidation) and never destroys existing data on failure.

import { EXPORT_SCHEMA_VERSION } from "@/domain/constants";
import { validateImport, type ImportValidationResult } from "@/domain/importValidation";
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

export type ExportImportDeps = {
  providerRepo: ProviderRepository;
  snapshotRepo: UsageSnapshotRepository;
  activityRepo: UsageActivityRepository;
  resetRepo: ResetEventRepository;
  notificationRepo: NotificationRepository;
  settingsRepo: SettingsRepository;
  appVersion: string;
};

export type ExportedBundle = {
  schemaVersion: number;
  exportedAt: string;
  appVersion: string;
  providerAccounts: ProviderAccount[];
  plans: SubscriptionPlan[];
  limits: UsageLimit[];
  snapshots: UsageSnapshot[];
  activities: UsageActivity[];
  resetEvents: ResetEvent[];
  notificationChannels: Array<Omit<NotificationChannelConfig, "config">>;
  settings: Record<string, string>;
};

export type ImportMode = "merge" | "replace";

export type ImportSummary = {
  validation: ImportValidationResult;
  applied: boolean;
  counts: Record<string, number>;
};

export function createExportImportService(deps: ExportImportDeps) {
  async function exportBundle(): Promise<ExportedBundle> {
    const settings = await deps.settingsRepo.getAll();
    // Settings whitelist: everything in app_settings is non-secret by design, but be explicit
    // about excluding anything that ever looks secret-ish.
    const safeSettings: Record<string, string> = {};
    for (const [k, v] of Object.entries(settings)) {
      if (/secret|token|webhook|password|cookie/i.test(k)) continue;
      safeSettings[k] = v;
    }

    const channels = await deps.notificationRepo.listChannels();

    return {
      schemaVersion: EXPORT_SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      appVersion: deps.appVersion,
      providerAccounts: await deps.providerRepo.listAccounts(),
      plans: await deps.providerRepo.listPlans(),
      limits: await deps.providerRepo.listLimits(),
      snapshots: await deps.snapshotRepo.listAll(),
      activities: await deps.activityRepo.listAll(),
      resetEvents: await deps.resetRepo.listAll(),
      // Non-secret channel preferences only. `config` may hold user-entered values (chat ids,
      // header templates) — excluded by default to be safe. secretRef is a keychain pointer.
      notificationChannels: channels.map(({ config: _config, ...rest }) => rest),
      settings: safeSettings,
    };
  }

  async function importBundle(raw: unknown, mode: ImportMode): Promise<ImportSummary> {
    const validation = validateImport(raw);
    const counts: Record<string, number> = {};
    if (!validation.ok) {
      return { validation, applied: false, counts };
    }

    const bundle = raw as ExportedBundle;

    if (mode === "replace") {
      // Deletion order respects FK cascades; existing data is only removed AFTER validation.
      for (const s of await deps.snapshotRepo.listAll()) await deps.snapshotRepo.deleteById(s.id);
      for (const a of await deps.activityRepo.listAll()) await deps.activityRepo.deleteById(a.id);
      for (const l of await deps.providerRepo.listLimits()) await deps.providerRepo.deleteLimit(l.id);
      for (const p of await deps.providerRepo.listPlans()) await deps.providerRepo.deletePlan(p.id);
      for (const acc of await deps.providerRepo.listAccounts())
        await deps.providerRepo.deleteAccount(acc.id);
    }

    const existingSnapshotIds = new Set((await deps.snapshotRepo.listAll()).map((s) => s.id));
    const existingActivityIds = new Set((await deps.activityRepo.listAll()).map((a) => a.id));
    const existingResetIds = new Set((await deps.resetRepo.listAll()).map((r) => r.id));

    for (const acc of bundle.providerAccounts ?? []) {
      await deps.providerRepo.saveAccount(acc as ProviderAccount);
      counts.providerAccounts = (counts.providerAccounts ?? 0) + 1;
    }
    for (const p of bundle.plans ?? []) {
      await deps.providerRepo.savePlan(p as SubscriptionPlan);
      counts.plans = (counts.plans ?? 0) + 1;
    }
    for (const l of bundle.limits ?? []) {
      const lim = l as UsageLimit;
      await deps.providerRepo.saveLimit({
        ...lim,
        timezone: lim.timezone ?? "UTC",
        active: lim.active ?? true,
        monitoringEnabled: lim.monitoringEnabled ?? true,
        notifyEnabled: lim.notifyEnabled ?? true,
      });
      counts.limits = (counts.limits ?? 0) + 1;
    }
    for (const s of bundle.snapshots ?? []) {
      const sn = s as UsageSnapshot;
      if (existingSnapshotIds.has(sn.id)) continue; // never overwrite history
      await deps.snapshotRepo.insert(sn);
      counts.snapshots = (counts.snapshots ?? 0) + 1;
    }
    for (const a of bundle.activities ?? []) {
      const act = a as UsageActivity;
      if (existingActivityIds.has(act.id)) continue;
      await deps.activityRepo.insert({ ...act, status: act.status ?? "completed" });
      counts.activities = (counts.activities ?? 0) + 1;
    }
    for (const r of bundle.resetEvents ?? []) {
      const ev = r as ResetEvent;
      if (existingResetIds.has(ev.id)) continue;
      await deps.resetRepo.insert(ev);
      counts.resetEvents = (counts.resetEvents ?? 0) + 1;
    }
    // Channels: preferences only; enabled state is preserved but secrets must be re-entered.
    for (const c of bundle.notificationChannels ?? []) {
      const ch = c as NotificationChannelConfig;
      await deps.notificationRepo.saveChannel({ ...ch, config: undefined });
      counts.notificationChannels = (counts.notificationChannels ?? 0) + 1;
    }
    for (const [k, v] of Object.entries(bundle.settings ?? {})) {
      if (k === SETTINGS_KEYS.demoMode || k === SETTINGS_KEYS.onboardingCompleted) continue;
      if (typeof v === "string") await deps.settingsRepo.set(k, v);
    }

    return { validation, applied: true, counts };
  }

  return { exportBundle, importBundle };
}

export type ExportImportService = ReturnType<typeof createExportImportService>;
