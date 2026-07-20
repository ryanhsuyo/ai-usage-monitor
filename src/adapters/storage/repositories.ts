// Repository layer (spec §14). The ONLY module that writes SQL against the schema.
// Domain objects in, domain objects out; snake_case ↔ camelCase mapping happens here.

import type {
  DataSourceStatus,
  NotificationChannelConfig,
  NotificationDelivery,
  NotificationEvent,
  NotificationEventType,
  ProviderAccount,
  ResetEvent,
  SchedulerRun,
  SubscriptionPlan,
  UsageActivity,
  UsageLimit,
  UsageSnapshot,
} from "@/domain/types";
import type {
  DataSourceRepository,
  NotificationRepository,
  ProviderRepository,
  SchedulerRepository,
  SettingsRepository,
  SqlDatabase,
  UsageActivityRepository,
  UsageSnapshotRepository,
  ResetEventRepository,
} from "@/ports";

type Row = Record<string, unknown>;

const s = (v: unknown): string => String(v);
const sOpt = (v: unknown): string | undefined => (v === null || v === undefined ? undefined : String(v));
const n = (v: unknown): number => Number(v);
const nOpt = (v: unknown): number | undefined =>
  v === null || v === undefined ? undefined : Number(v);
const b = (v: unknown): boolean => v === 1 || v === true || v === "1";

// ---------- Provider / plans / limits ----------

export function createProviderRepository(db: SqlDatabase): ProviderRepository {
  return {
    async listAccounts() {
      const rows = await db.select<Row>("SELECT * FROM provider_accounts ORDER BY created_at");
      return rows.map(
        (r): ProviderAccount => ({
          id: s(r.id),
          providerId: s(r.provider_id) as ProviderAccount["providerId"],
          displayName: s(r.display_name),
          active: b(r.active),
          createdAt: s(r.created_at),
          updatedAt: s(r.updated_at),
        })
      );
    },
    async saveAccount(a) {
      await db.execute(
        `INSERT INTO provider_accounts (id, provider_id, display_name, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET provider_id=excluded.provider_id,
           display_name=excluded.display_name, active=excluded.active, updated_at=excluded.updated_at`,
        [a.id, a.providerId, a.displayName, a.active ? 1 : 0, a.createdAt, a.updatedAt]
      );
    },
    async deleteAccount(id) {
      await db.execute("DELETE FROM provider_accounts WHERE id = ?", [id]);
    },
    async listPlans() {
      const rows = await db.select<Row>("SELECT * FROM subscription_plans ORDER BY created_at");
      return rows.map(
        (r): SubscriptionPlan => ({
          id: s(r.id),
          providerId: s(r.provider_id) as SubscriptionPlan["providerId"],
          accountId: s(r.account_id),
          name: s(r.name),
          monthlyPrice: n(r.monthly_price),
          currency: s(r.currency),
          relativeCapacity: nOpt(r.relative_capacity),
          active: b(r.active),
          startedAt: sOpt(r.started_at),
          createdAt: s(r.created_at),
          updatedAt: s(r.updated_at),
        })
      );
    },
    async savePlan(p) {
      await db.execute(
        `INSERT INTO subscription_plans
           (id, provider_id, account_id, name, monthly_price, currency, relative_capacity, active, started_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET provider_id=excluded.provider_id, account_id=excluded.account_id,
           name=excluded.name, monthly_price=excluded.monthly_price, currency=excluded.currency,
           relative_capacity=excluded.relative_capacity, active=excluded.active,
           started_at=excluded.started_at, updated_at=excluded.updated_at`,
        [
          p.id,
          p.providerId,
          p.accountId,
          p.name,
          p.monthlyPrice,
          p.currency,
          p.relativeCapacity ?? null,
          p.active ? 1 : 0,
          p.startedAt ?? null,
          p.createdAt,
          p.updatedAt,
        ]
      );
    },
    async deletePlan(id) {
      await db.execute("DELETE FROM subscription_plans WHERE id = ?", [id]);
    },
    async listLimits() {
      const rows = await db.select<Row>("SELECT * FROM usage_limits ORDER BY created_at");
      return rows.map(
        (r): UsageLimit => ({
          id: s(r.id),
          planId: s(r.plan_id),
          name: s(r.name),
          type: s(r.type) as UsageLimit["type"],
          model: sOpt(r.model),
          windowHours: nOpt(r.window_hours),
          resetRule: sOpt(r.reset_rule),
          timezone: s(r.timezone),
          active: b(r.active),
          monitoringEnabled: b(r.monitoring_enabled),
          notifyEnabled: b(r.notify_enabled),
          createdAt: s(r.created_at),
          updatedAt: s(r.updated_at),
        })
      );
    },
    async saveLimit(l) {
      await db.execute(
        `INSERT INTO usage_limits
           (id, plan_id, name, type, model, window_hours, reset_rule, timezone, active, monitoring_enabled, notify_enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET plan_id=excluded.plan_id, name=excluded.name, type=excluded.type,
           model=excluded.model, window_hours=excluded.window_hours, reset_rule=excluded.reset_rule,
           timezone=excluded.timezone, active=excluded.active,
           monitoring_enabled=excluded.monitoring_enabled, notify_enabled=excluded.notify_enabled,
           updated_at=excluded.updated_at`,
        [
          l.id,
          l.planId,
          l.name,
          l.type,
          l.model ?? null,
          l.windowHours ?? null,
          l.resetRule ?? null,
          l.timezone,
          l.active ? 1 : 0,
          l.monitoringEnabled ? 1 : 0,
          l.notifyEnabled ? 1 : 0,
          l.createdAt,
          l.updatedAt,
        ]
      );
    },
    async deleteLimit(id) {
      await db.execute("DELETE FROM usage_limits WHERE id = ?", [id]);
    },
  };
}

// ---------- Snapshots ----------

function rowToSnapshot(r: Row): UsageSnapshot {
  return {
    id: s(r.id),
    providerId: s(r.provider_id) as UsageSnapshot["providerId"],
    accountId: s(r.account_id),
    limitId: s(r.limit_id),
    usedPercent: n(r.used_percent),
    remainingPercent: n(r.remaining_percent),
    resetAt: sOpt(r.reset_at),
    capturedAt: s(r.captured_at),
    source: s(r.source) as UsageSnapshot["source"],
    valid: b(r.valid),
    confidence: n(r.confidence),
    errorCode: sOpt(r.error_code),
    note: sOpt(r.note),
  };
}

export function createSnapshotRepository(db: SqlDatabase): UsageSnapshotRepository {
  return {
    async insert(sn) {
      await db.execute(
        `INSERT INTO usage_snapshots
           (id, provider_id, account_id, limit_id, used_percent, remaining_percent, reset_at, captured_at, source, valid, confidence, error_code, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          sn.id,
          sn.providerId,
          sn.accountId,
          sn.limitId,
          sn.usedPercent,
          sn.remainingPercent,
          sn.resetAt ?? null,
          sn.capturedAt,
          sn.source,
          sn.valid ? 1 : 0,
          sn.confidence,
          sn.errorCode ?? null,
          sn.note ?? null,
        ]
      );
    },
    async listByLimit(limitId, opts) {
      const clauses = ["limit_id = ?"];
      const params: unknown[] = [limitId];
      if (opts?.sinceIso) {
        clauses.push("captured_at >= ?");
        params.push(opts.sinceIso);
      }
      let sql = `SELECT * FROM usage_snapshots WHERE ${clauses.join(" AND ")} ORDER BY captured_at`;
      if (opts?.limit) sql += ` LIMIT ${Math.floor(opts.limit)}`;
      const rows = await db.select<Row>(sql, params);
      return rows.map(rowToSnapshot);
    },
    async latestValidByLimit(limitId) {
      const rows = await db.select<Row>(
        "SELECT * FROM usage_snapshots WHERE limit_id = ? AND valid = 1 ORDER BY captured_at DESC LIMIT 1",
        [limitId]
      );
      return rows[0] ? rowToSnapshot(rows[0]) : undefined;
    },
    async deleteById(id) {
      await db.execute("DELETE FROM usage_snapshots WHERE id = ?", [id]);
    },
    async listAll() {
      const rows = await db.select<Row>("SELECT * FROM usage_snapshots ORDER BY captured_at");
      return rows.map(rowToSnapshot);
    },
  };
}

// ---------- Activities ----------

function rowToActivity(r: Row): UsageActivity {
  return {
    id: s(r.id),
    providerId: s(r.provider_id) as UsageActivity["providerId"],
    accountId: s(r.account_id),
    limitId: s(r.limit_id),
    model: sOpt(r.model),
    projectName: sOpt(r.project_name),
    taskType: s(r.task_type) as UsageActivity["taskType"],
    startedAt: s(r.started_at),
    endedAt: sOpt(r.ended_at),
    usageBefore: nOpt(r.usage_before),
    usageAfter: nOpt(r.usage_after),
    usageDelta: nOpt(r.usage_delta),
    inputTokens: nOpt(r.input_tokens),
    outputTokens: nOpt(r.output_tokens),
    contextTokens: nOpt(r.context_tokens),
    status: s(r.status) as UsageActivity["status"],
    note: sOpt(r.note),
  };
}

const ACTIVITY_COLS = `id, provider_id, account_id, limit_id, model, project_name, task_type,
  started_at, ended_at, usage_before, usage_after, usage_delta, input_tokens, output_tokens,
  context_tokens, status, note`;

function activityParams(a: UsageActivity): unknown[] {
  return [
    a.id,
    a.providerId,
    a.accountId,
    a.limitId,
    a.model ?? null,
    a.projectName ?? null,
    a.taskType,
    a.startedAt,
    a.endedAt ?? null,
    a.usageBefore ?? null,
    a.usageAfter ?? null,
    a.usageDelta ?? null,
    a.inputTokens ?? null,
    a.outputTokens ?? null,
    a.contextTokens ?? null,
    a.status,
    a.note ?? null,
  ];
}

export function createActivityRepository(db: SqlDatabase): UsageActivityRepository {
  return {
    async insert(a) {
      await db.execute(
        `INSERT INTO usage_activities (${ACTIVITY_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        activityParams(a)
      );
    },
    async update(a) {
      await db.execute(
        `UPDATE usage_activities SET model=?, project_name=?, task_type=?, started_at=?, ended_at=?,
           usage_before=?, usage_after=?, usage_delta=?, input_tokens=?, output_tokens=?,
           context_tokens=?, status=?, note=? WHERE id=?`,
        [
          a.model ?? null,
          a.projectName ?? null,
          a.taskType,
          a.startedAt,
          a.endedAt ?? null,
          a.usageBefore ?? null,
          a.usageAfter ?? null,
          a.usageDelta ?? null,
          a.inputTokens ?? null,
          a.outputTokens ?? null,
          a.contextTokens ?? null,
          a.status,
          a.note ?? null,
          a.id,
        ]
      );
    },
    async listByLimit(limitId) {
      const rows = await db.select<Row>(
        "SELECT * FROM usage_activities WHERE limit_id = ? ORDER BY started_at",
        [limitId]
      );
      return rows.map(rowToActivity);
    },
    async listAll() {
      const rows = await db.select<Row>("SELECT * FROM usage_activities ORDER BY started_at");
      return rows.map(rowToActivity);
    },
    async deleteById(id) {
      await db.execute("DELETE FROM usage_activities WHERE id = ?", [id]);
    },
  };
}

// ---------- Reset events ----------

function rowToResetEvent(r: Row): ResetEvent {
  return {
    id: s(r.id),
    providerId: s(r.provider_id) as ResetEvent["providerId"],
    accountId: s(r.account_id),
    limitId: s(r.limit_id),
    previousUsedPercent: nOpt(r.previous_used_percent),
    currentUsedPercent: nOpt(r.current_used_percent),
    expectedResetAt: sOpt(r.expected_reset_at),
    detectedAt: s(r.detected_at),
    detectionMethod: s(r.detection_method) as ResetEvent["detectionMethod"],
    confidence: n(r.confidence),
  };
}

export function createResetEventRepository(db: SqlDatabase): ResetEventRepository {
  return {
    async insert(e) {
      await db.execute(
        `INSERT INTO reset_events
           (id, provider_id, account_id, limit_id, previous_used_percent, current_used_percent, expected_reset_at, detected_at, detection_method, confidence)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          e.id,
          e.providerId,
          e.accountId,
          e.limitId,
          e.previousUsedPercent ?? null,
          e.currentUsedPercent ?? null,
          e.expectedResetAt ?? null,
          e.detectedAt,
          e.detectionMethod,
          e.confidence,
        ]
      );
    },
    async listByLimit(limitId) {
      const rows = await db.select<Row>(
        "SELECT * FROM reset_events WHERE limit_id = ? ORDER BY detected_at",
        [limitId]
      );
      return rows.map(rowToResetEvent);
    },
    async latestByLimit(limitId) {
      const rows = await db.select<Row>(
        "SELECT * FROM reset_events WHERE limit_id = ? ORDER BY detected_at DESC LIMIT 1",
        [limitId]
      );
      return rows[0] ? rowToResetEvent(rows[0]) : undefined;
    },
    async listAll() {
      const rows = await db.select<Row>("SELECT * FROM reset_events ORDER BY detected_at");
      return rows.map(rowToResetEvent);
    },
  };
}

// ---------- Notifications ----------

function rowToChannel(r: Row): NotificationChannelConfig {
  let prefs: Record<NotificationEventType, boolean>;
  try {
    prefs = JSON.parse(s(r.event_preferences));
  } catch {
    prefs = {} as Record<NotificationEventType, boolean>;
  }
  let config: Record<string, string> | undefined;
  try {
    config = r.config_json ? JSON.parse(s(r.config_json)) : undefined;
  } catch {
    config = undefined;
  }
  return {
    id: s(r.id),
    type: s(r.type) as NotificationChannelConfig["type"],
    displayName: s(r.display_name),
    enabled: b(r.enabled),
    secretRef: sOpt(r.secret_ref),
    config,
    eventPreferences: prefs,
    quietHoursStart: sOpt(r.quiet_hours_start),
    quietHoursEnd: sOpt(r.quiet_hours_end),
    minIntervalMinutes: nOpt(r.min_interval_minutes),
    createdAt: s(r.created_at),
    updatedAt: s(r.updated_at),
  };
}

export function createNotificationRepository(db: SqlDatabase): NotificationRepository {
  return {
    async listChannels() {
      const rows = await db.select<Row>("SELECT * FROM notification_channels ORDER BY created_at");
      return rows.map(rowToChannel);
    },
    async saveChannel(c) {
      await db.execute(
        `INSERT INTO notification_channels
           (id, type, display_name, enabled, secret_ref, config_json, event_preferences, quiet_hours_start, quiet_hours_end, min_interval_minutes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET type=excluded.type, display_name=excluded.display_name,
           enabled=excluded.enabled, secret_ref=excluded.secret_ref, config_json=excluded.config_json,
           event_preferences=excluded.event_preferences, quiet_hours_start=excluded.quiet_hours_start,
           quiet_hours_end=excluded.quiet_hours_end, min_interval_minutes=excluded.min_interval_minutes,
           updated_at=excluded.updated_at`,
        [
          c.id,
          c.type,
          c.displayName,
          c.enabled ? 1 : 0,
          c.secretRef ?? null,
          c.config ? JSON.stringify(c.config) : null,
          JSON.stringify(c.eventPreferences),
          c.quietHoursStart ?? null,
          c.quietHoursEnd ?? null,
          c.minIntervalMinutes ?? null,
          c.createdAt,
          c.updatedAt,
        ]
      );
    },
    async deleteChannel(id) {
      await db.execute("DELETE FROM notification_channels WHERE id = ?", [id]);
    },
    async insertEvent(e) {
      await db.execute(
        `INSERT INTO notification_events
           (id, event_key, event_type, provider_id, account_id, limit_id, title, body, severity, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          e.id,
          e.eventKey,
          e.eventType,
          e.providerId ?? null,
          e.accountId ?? null,
          e.limitId ?? null,
          e.title,
          e.body,
          e.severity,
          e.createdAt,
        ]
      );
    },
    async listEvents(opts) {
      let sql = "SELECT * FROM notification_events ORDER BY created_at DESC";
      if (opts?.limit) sql += ` LIMIT ${Math.floor(opts.limit)}`;
      const rows = await db.select<Row>(sql);
      return rows.map(
        (r): NotificationEvent => ({
          id: s(r.id),
          eventKey: s(r.event_key),
          eventType: s(r.event_type) as NotificationEvent["eventType"],
          providerId: sOpt(r.provider_id) as NotificationEvent["providerId"],
          accountId: sOpt(r.account_id),
          limitId: sOpt(r.limit_id),
          title: s(r.title),
          body: s(r.body),
          severity: s(r.severity) as NotificationEvent["severity"],
          createdAt: s(r.created_at),
        })
      );
    },
    async findEventByKey(eventKey) {
      const rows = await db.select<Row>(
        "SELECT * FROM notification_events WHERE event_key = ? LIMIT 1",
        [eventKey]
      );
      const r = rows[0];
      if (!r) return undefined;
      return {
        id: s(r.id),
        eventKey: s(r.event_key),
        eventType: s(r.event_type) as NotificationEvent["eventType"],
        providerId: sOpt(r.provider_id) as NotificationEvent["providerId"],
        accountId: sOpt(r.account_id),
        limitId: sOpt(r.limit_id),
        title: s(r.title),
        body: s(r.body),
        severity: s(r.severity) as NotificationEvent["severity"],
        createdAt: s(r.created_at),
      };
    },
    async insertDelivery(d) {
      await db.execute(
        `INSERT INTO notification_deliveries
           (id, event_id, event_key, channel_id, status, attempt_count, attempted_at, delivered_at, error_code, error_message)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          d.id,
          d.eventId,
          d.eventKey,
          d.channelId,
          d.status,
          d.attemptCount,
          d.attemptedAt ?? null,
          d.deliveredAt ?? null,
          d.errorCode ?? null,
          d.errorMessage ?? null,
        ]
      );
    },
    async updateDelivery(d) {
      await db.execute(
        `UPDATE notification_deliveries SET status=?, attempt_count=?, attempted_at=?, delivered_at=?,
           error_code=?, error_message=? WHERE id=?`,
        [
          d.status,
          d.attemptCount,
          d.attemptedAt ?? null,
          d.deliveredAt ?? null,
          d.errorCode ?? null,
          d.errorMessage ?? null,
          d.id,
        ]
      );
    },
    async listDeliveries(opts) {
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (opts?.eventKey) {
        clauses.push("event_key = ?");
        params.push(opts.eventKey);
      }
      if (opts?.channelId) {
        clauses.push("channel_id = ?");
        params.push(opts.channelId);
      }
      if (opts?.attemptedSince) {
        clauses.push("attempted_at >= ?");
        params.push(opts.attemptedSince);
      }
      const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
      const rows = await db.select<Row>(
        `SELECT * FROM notification_deliveries${where} ORDER BY attempted_at DESC`,
        params
      );
      return rows.map(
        (r): NotificationDelivery => ({
          id: s(r.id),
          eventId: s(r.event_id),
          eventKey: s(r.event_key),
          channelId: s(r.channel_id),
          status: s(r.status) as NotificationDelivery["status"],
          attemptCount: n(r.attempt_count),
          attemptedAt: sOpt(r.attempted_at),
          deliveredAt: sOpt(r.delivered_at),
          errorCode: sOpt(r.error_code),
          errorMessage: sOpt(r.error_message),
        })
      );
    },
    async lastSentAtForChannel(channelId) {
      const rows = await db.select<Row>(
        "SELECT delivered_at FROM notification_deliveries WHERE channel_id = ? AND status = 'sent' ORDER BY delivered_at DESC LIMIT 1",
        [channelId]
      );
      return rows[0] ? sOpt(rows[0].delivered_at) : undefined;
    },
  };
}

// ---------- Settings ----------

export function createSettingsRepository(db: SqlDatabase): SettingsRepository {
  return {
    async get(key) {
      const rows = await db.select<Row>("SELECT value FROM app_settings WHERE key = ?", [key]);
      return rows[0] ? s(rows[0].value) : undefined;
    },
    async set(key, value) {
      await db.execute(
        `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
        [key, value, new Date().toISOString()]
      );
    },
    async getAll() {
      const rows = await db.select<Row>("SELECT key, value FROM app_settings");
      const out: Record<string, string> = {};
      for (const r of rows) out[s(r.key)] = s(r.value);
      return out;
    },
  };
}

// ---------- Data sources ----------

export function createDataSourceRepository(db: SqlDatabase): DataSourceRepository {
  return {
    async list() {
      const rows = await db.select<Row>("SELECT * FROM data_source_status ORDER BY adapter_id");
      return rows.map(
        (r): DataSourceStatus => ({
          id: s(r.id),
          providerId: s(r.provider_id) as DataSourceStatus["providerId"],
          adapterId: s(r.adapter_id),
          displayName: s(r.display_name),
          enabled: b(r.enabled),
          supportsAutomaticPolling: b(r.supports_automatic_polling),
          reliability: s(r.reliability) as DataSourceStatus["reliability"],
          lastRunAt: sOpt(r.last_run_at),
          lastSuccessAt: sOpt(r.last_success_at),
          lastError: sOpt(r.last_error),
          updatedAt: s(r.updated_at),
        })
      );
    },
    async save(st) {
      await db.execute(
        `INSERT INTO data_source_status
           (id, provider_id, adapter_id, display_name, enabled, supports_automatic_polling, reliability, last_run_at, last_success_at, last_error, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET provider_id=excluded.provider_id, adapter_id=excluded.adapter_id,
           display_name=excluded.display_name, enabled=excluded.enabled,
           supports_automatic_polling=excluded.supports_automatic_polling, reliability=excluded.reliability,
           last_run_at=excluded.last_run_at, last_success_at=excluded.last_success_at,
           last_error=excluded.last_error, updated_at=excluded.updated_at`,
        [
          st.id,
          st.providerId,
          st.adapterId,
          st.displayName,
          st.enabled ? 1 : 0,
          st.supportsAutomaticPolling ? 1 : 0,
          st.reliability,
          st.lastRunAt ?? null,
          st.lastSuccessAt ?? null,
          st.lastError ?? null,
          st.updatedAt,
        ]
      );
    },
  };
}

// ---------- Scheduler runs ----------

export function createSchedulerRepository(db: SqlDatabase): SchedulerRepository {
  return {
    async insertRun(run) {
      await db.execute(
        "INSERT INTO scheduler_runs (id, started_at, finished_at, status, trigger, detail) VALUES (?, ?, ?, ?, ?, ?)",
        [run.id, run.startedAt, run.finishedAt ?? null, run.status, run.trigger, run.detail ?? null]
      );
    },
    async updateRun(run) {
      await db.execute(
        "UPDATE scheduler_runs SET finished_at=?, status=?, detail=? WHERE id=?",
        [run.finishedAt ?? null, run.status, run.detail ?? null, run.id]
      );
    },
    async latestRun() {
      const rows = await db.select<Row>(
        "SELECT * FROM scheduler_runs ORDER BY started_at DESC LIMIT 1"
      );
      const r = rows[0];
      if (!r) return undefined;
      return {
        id: s(r.id),
        startedAt: s(r.started_at),
        finishedAt: sOpt(r.finished_at),
        status: s(r.status) as SchedulerRun["status"],
        trigger: s(r.trigger) as SchedulerRun["trigger"],
        detail: sOpt(r.detail),
      };
    },
    async hasRunningRun() {
      const rows = await db.select<Row>(
        "SELECT COUNT(*) as cnt FROM scheduler_runs WHERE status = 'running'"
      );
      return n(rows[0]?.cnt ?? 0) > 0;
    },
  };
}
