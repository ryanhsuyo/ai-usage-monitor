-- ai-usage-monitor initial schema (v1)
-- All timestamps are ISO 8601 UTC strings. No secret values are ever stored here;
-- notification channels reference secrets by `secret_ref` only.
-- This migration is idempotent-safe (IF NOT EXISTS) so it can be re-applied without error.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS provider_accounts (
  id            TEXT PRIMARY KEY,
  provider_id   TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS subscription_plans (
  id                TEXT PRIMARY KEY,
  provider_id       TEXT NOT NULL,
  account_id        TEXT NOT NULL,
  name              TEXT NOT NULL,
  monthly_price     REAL NOT NULL DEFAULT 0,
  currency          TEXT NOT NULL DEFAULT 'USD',
  relative_capacity REAL,
  active            INTEGER NOT NULL DEFAULT 1,
  started_at        TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES provider_accounts (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS usage_limits (
  id                 TEXT PRIMARY KEY,
  plan_id            TEXT NOT NULL,
  name               TEXT NOT NULL,
  type               TEXT NOT NULL,
  model              TEXT,
  window_hours       REAL,
  reset_rule         TEXT,
  timezone           TEXT NOT NULL DEFAULT 'UTC',
  active             INTEGER NOT NULL DEFAULT 1,
  monitoring_enabled INTEGER NOT NULL DEFAULT 1,
  notify_enabled     INTEGER NOT NULL DEFAULT 1,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  FOREIGN KEY (plan_id) REFERENCES subscription_plans (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS usage_snapshots (
  id                TEXT PRIMARY KEY,
  provider_id       TEXT NOT NULL,
  account_id        TEXT NOT NULL,
  limit_id          TEXT NOT NULL,
  used_percent      REAL NOT NULL,
  remaining_percent REAL NOT NULL,
  reset_at          TEXT,
  captured_at       TEXT NOT NULL,
  source            TEXT NOT NULL,
  valid             INTEGER NOT NULL DEFAULT 1,
  confidence        REAL NOT NULL DEFAULT 1,
  error_code        TEXT,
  note              TEXT,
  FOREIGN KEY (limit_id) REFERENCES usage_limits (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_snapshots_limit_captured
  ON usage_snapshots (limit_id, captured_at);
CREATE INDEX IF NOT EXISTS idx_snapshots_account
  ON usage_snapshots (account_id, captured_at);

CREATE TABLE IF NOT EXISTS usage_activities (
  id            TEXT PRIMARY KEY,
  provider_id   TEXT NOT NULL,
  account_id    TEXT NOT NULL,
  limit_id      TEXT NOT NULL,
  model         TEXT,
  project_name  TEXT,
  task_type     TEXT NOT NULL,
  started_at    TEXT NOT NULL,
  ended_at      TEXT,
  usage_before  REAL,
  usage_after   REAL,
  usage_delta   REAL,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  context_tokens INTEGER,
  status        TEXT NOT NULL DEFAULT 'completed',
  note          TEXT,
  FOREIGN KEY (limit_id) REFERENCES usage_limits (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_activities_limit_type
  ON usage_activities (limit_id, task_type);

CREATE TABLE IF NOT EXISTS reset_events (
  id                    TEXT PRIMARY KEY,
  provider_id           TEXT NOT NULL,
  account_id            TEXT NOT NULL,
  limit_id              TEXT NOT NULL,
  previous_used_percent REAL,
  current_used_percent  REAL,
  expected_reset_at     TEXT,
  detected_at           TEXT NOT NULL,
  detection_method      TEXT NOT NULL,
  confidence            REAL NOT NULL DEFAULT 0.5,
  FOREIGN KEY (limit_id) REFERENCES usage_limits (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_reset_events_limit
  ON reset_events (limit_id, detected_at);

CREATE TABLE IF NOT EXISTS data_source_status (
  id                       TEXT PRIMARY KEY,
  provider_id              TEXT NOT NULL,
  adapter_id               TEXT NOT NULL,
  display_name             TEXT NOT NULL,
  enabled                  INTEGER NOT NULL DEFAULT 0,
  supports_automatic_polling INTEGER NOT NULL DEFAULT 0,
  reliability              TEXT NOT NULL DEFAULT 'manual',
  last_run_at              TEXT,
  last_success_at          TEXT,
  last_error               TEXT,
  updated_at               TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scheduler_runs (
  id           TEXT PRIMARY KEY,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  status       TEXT NOT NULL,
  trigger      TEXT NOT NULL,
  detail       TEXT
);
CREATE INDEX IF NOT EXISTS idx_scheduler_runs_started
  ON scheduler_runs (started_at);

CREATE TABLE IF NOT EXISTS notification_channels (
  id                TEXT PRIMARY KEY,
  type              TEXT NOT NULL,
  display_name      TEXT NOT NULL,
  enabled           INTEGER NOT NULL DEFAULT 0,
  secret_ref        TEXT,
  config_json       TEXT,
  event_preferences TEXT NOT NULL DEFAULT '{}',
  quiet_hours_start TEXT,
  quiet_hours_end   TEXT,
  min_interval_minutes INTEGER,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notification_events (
  id           TEXT PRIMARY KEY,
  event_key    TEXT NOT NULL,
  event_type   TEXT NOT NULL,
  provider_id  TEXT,
  account_id   TEXT,
  limit_id     TEXT,
  title        TEXT NOT NULL,
  body         TEXT NOT NULL,
  severity     TEXT NOT NULL DEFAULT 'info',
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notification_events_key
  ON notification_events (event_key);

CREATE TABLE IF NOT EXISTS notification_deliveries (
  id            TEXT PRIMARY KEY,
  event_id      TEXT NOT NULL,
  event_key     TEXT NOT NULL,
  channel_id    TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  attempted_at  TEXT,
  delivered_at  TEXT,
  error_code    TEXT,
  error_message TEXT
);
-- Enforce dedup: a given event_key may only be delivered once per channel (successfully).
CREATE UNIQUE INDEX IF NOT EXISTS uq_delivery_eventkey_channel
  ON notification_deliveries (event_key, channel_id);

CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
