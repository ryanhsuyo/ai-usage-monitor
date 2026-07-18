// Ports — interfaces only. Adapters implement these; services depend on them.
// No implementation code, no platform imports here.

import type {
  DataSourceStatus,
  NotificationChannelConfig,
  NotificationChannelType,
  NotificationDelivery,
  NotificationEvent,
  ProviderAccount,
  ProviderId,
  ResetEvent,
  SchedulerRun,
  SubscriptionPlan,
  UsageActivity,
  UsageLimit,
  UsageSnapshot,
} from "@/domain/types";

// ---------- Platform capabilities (spec §5) ----------

export interface SystemNotifier {
  send(input: { title: string; body: string }): Promise<void>;
}

export interface AutoStartService {
  isEnabled(): Promise<boolean>;
  enable(): Promise<void>;
  disable(): Promise<void>;
}

export interface BackgroundRuntime {
  isRunning(): Promise<boolean>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface UsageCacheWatcher {
  watchClaudeCache(onChange: () => void): Promise<() => void>;
}

export interface DiagnosticLogger {
  log(level: "info" | "warn" | "error", event: string, detail?: string): Promise<void>;
  exportText(): Promise<string>;
}

export interface SecretStore {
  setSecret(key: string, value: string): Promise<void>;
  getSecret(key: string): Promise<string | null>;
  deleteSecret(key: string): Promise<void>;
}

// ---------- Provider adapters (spec §13) ----------

export type ProviderFetchResult =
  | { ok: true; snapshots: UsageSnapshot[]; fetchedAt: string }
  | { ok: false; errorCode: string; message: string; fetchedAt: string };

export interface UsageProviderAdapter {
  id: string;
  providerId: ProviderId;
  displayName: string;
  supportsAutomaticPolling: boolean;
  fetchUsage(): Promise<ProviderFetchResult>;
}

// ---------- Notification channel adapters (spec §9) ----------

export type ValidationResult = { ok: true } | { ok: false; message: string };

export type NotificationResult =
  | { ok: true; deliveredAt: string }
  | { ok: false; errorCode: string; message: string };

export type NotificationMessage = {
  title: string;
  body: string;
  severity: "info" | "warning" | "critical";
};

/** Runtime inputs an adapter needs beyond the persisted config: the resolved secret value. */
export type ChannelRuntime = {
  /** The secret resolved from SecretStore (webhook URL / bot token). Never persisted. */
  secret?: string;
};

export interface NotificationChannelAdapter {
  type: NotificationChannelType;
  validateConfiguration(
    config: NotificationChannelConfig,
    runtime: ChannelRuntime
  ): Promise<ValidationResult>;
  send(
    config: NotificationChannelConfig,
    runtime: ChannelRuntime,
    message: NotificationMessage
  ): Promise<NotificationResult>;
}

// ---------- Repositories (spec §14) ----------

export interface ProviderRepository {
  listAccounts(): Promise<ProviderAccount[]>;
  saveAccount(account: ProviderAccount): Promise<void>;
  deleteAccount(id: string): Promise<void>;
  listPlans(): Promise<SubscriptionPlan[]>;
  savePlan(plan: SubscriptionPlan): Promise<void>;
  deletePlan(id: string): Promise<void>;
  listLimits(): Promise<UsageLimit[]>;
  saveLimit(limit: UsageLimit): Promise<void>;
  deleteLimit(id: string): Promise<void>;
}

export interface UsageSnapshotRepository {
  insert(snapshot: UsageSnapshot): Promise<void>;
  listByLimit(limitId: string, opts?: { sinceIso?: string; limit?: number }): Promise<UsageSnapshot[]>;
  latestValidByLimit(limitId: string): Promise<UsageSnapshot | undefined>;
  deleteById(id: string): Promise<void>;
  listAll(): Promise<UsageSnapshot[]>;
}

export interface UsageActivityRepository {
  insert(activity: UsageActivity): Promise<void>;
  update(activity: UsageActivity): Promise<void>;
  listByLimit(limitId: string): Promise<UsageActivity[]>;
  listAll(): Promise<UsageActivity[]>;
  deleteById(id: string): Promise<void>;
}

export interface ResetEventRepository {
  insert(event: ResetEvent): Promise<void>;
  listByLimit(limitId: string): Promise<ResetEvent[]>;
  latestByLimit(limitId: string): Promise<ResetEvent | undefined>;
  listAll(): Promise<ResetEvent[]>;
}

export interface NotificationRepository {
  listChannels(): Promise<NotificationChannelConfig[]>;
  saveChannel(channel: NotificationChannelConfig): Promise<void>;
  deleteChannel(id: string): Promise<void>;
  insertEvent(event: NotificationEvent): Promise<void>;
  listEvents(opts?: { limit?: number }): Promise<NotificationEvent[]>;
  findEventByKey(eventKey: string): Promise<NotificationEvent | undefined>;
  insertDelivery(delivery: NotificationDelivery): Promise<void>;
  updateDelivery(delivery: NotificationDelivery): Promise<void>;
  listDeliveries(opts?: { eventKey?: string; channelId?: string }): Promise<NotificationDelivery[]>;
  lastSentAtForChannel(channelId: string): Promise<string | undefined>;
}

export interface SettingsRepository {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  getAll(): Promise<Record<string, string>>;
}

export interface DataSourceRepository {
  list(): Promise<DataSourceStatus[]>;
  save(status: DataSourceStatus): Promise<void>;
}

export interface SchedulerRepository {
  insertRun(run: SchedulerRun): Promise<void>;
  updateRun(run: SchedulerRun): Promise<void>;
  latestRun(): Promise<SchedulerRun | undefined>;
  hasRunningRun(): Promise<boolean>;
}

// ---------- Low-level database boundary ----------
// Repositories talk SQL through this tiny port so tests can swap in an in-memory fake and the app
// can use tauri-plugin-sql. It is the ONLY place SQL crosses a boundary.

export interface SqlDatabase {
  execute(sql: string, params?: unknown[]): Promise<void>;
  select<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}
