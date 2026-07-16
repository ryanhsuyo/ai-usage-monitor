# Storage

## SQLite = App 內部檔案

- 引擎：`tauri-plugin-sql`（bundled SQLite）；使用者**不需要安裝任何東西**
- 路徑：`sqlite:app.db` → plugin 解析至 `appDataDir()`（Tauri Path API；程式不寫死路徑）
- macOS 實際位置：`~/Library/Application Support/com.aiusagemonitor.app/app.db`

## Migration

- 定義：`src-tauri/migrations/0001_init.sql`，由 `src-tauri/src/lib.rs::migrations()` 註冊
- Plugin 於首次連線時自動執行並記錄版本（`_sqlx_migrations`）；SQL 本身全用 `IF NOT EXISTS`，重複套用安全
- 新增 schema 變更 = 新增 `000N_*.sql` + 新 `Migration { version: N }`；**不修改舊 migration**

## 資料表（13）

`provider_accounts`、`subscription_plans`、`usage_limits`、`usage_snapshots`、`usage_activities`、`reset_events`、`data_source_status`、`scheduler_runs`、`notification_channels`、`notification_events`、`notification_deliveries`、`app_settings`、（migration 版本表由 plugin 管理）。

關鍵 index：
- `idx_snapshots_limit_captured (limit_id, captured_at)` — forecast 查詢主路徑
- `uq_delivery_eventkey_channel (event_key, channel_id)` UNIQUE — **通知去重的儲存層強制**

## Repository 邊界

- `src/ports` 定義 `ProviderRepository / UsageSnapshotRepository / UsageActivityRepository / ResetEventRepository / NotificationRepository / SettingsRepository / DataSourceRepository / SchedulerRepository`
- 實作在 `src/adapters/storage/repositories.ts`（**SQL 只存在這個檔＋migration**）
- 寫入用 `INSERT … ON CONFLICT DO UPDATE`（upsert 原子性）；FK `ON DELETE CASCADE` 維持一致性；PRAGMA foreign_keys = ON
- 測試以 `FakeSqlDatabase`（in-memory，模擬 upsert / unique index / where / order / limit）跑同一套 repository 程式碼

## 原則

- timestamp 一律 ISO 8601 UTC；UI 依系統時區顯示
- 快照歷史**只增不改**（匯入也不覆蓋既有 id）；錯誤讀值以 `valid=0 + error_code` 保留為失敗紀錄
- Secret 永不落地（見 security.md）；清除資料需 UI 二次確認
