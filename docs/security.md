# Security

## Secret Store

- 介面：`src/ports::SecretStore`（set/get/delete）。
- 主要實作：Rust `keyring` crate → macOS Keychain（service = `com.aiusagemonitor.app`）；Windows 版將對應 Credential Manager。
- Fallback：Keychain probe 失敗時改用 App Data 內 AES-GCM 加密檔（`secret-store.enc.json` + `secret-store.key`）。**誠實聲明**：fallback 的金鑰與密文在同一磁碟，防的是誤匯出與隨手翻閱，強度不等同 OS Keychain。目前使用的 backend 顯示於 Data Sources 頁。
- 測試用 `InMemorySecretStore`；fixture 一律使用假值，repo 內不得出現真實 Secret。

## Redaction（記錄與錯誤訊息脫敏）

- `redactUrl()`：URL 只留 origin + 第一段路徑（`https://discord.com/api…`）。
- `redactSecrets()`：錯誤訊息中出現的 Secret 值替換為 `[redacted]`；所有 channel adapter 的失敗回傳都先經過它。
- 通知傳送紀錄（`notification_deliveries.error_message`）存的是已脫敏訊息。
- 測試明確驗證 Webhook URL / Bot Token 不出現在錯誤、匯出檔與 channel rows（`channels.test.ts`、`ui.test.tsx`）。

## Webhook 驗證與 SSRF 基本限制

`checkWebhookUrl()`（`src/adapters/notifications/urlSafety.ts`）：

- 僅允許 `https:`；URL 內含帳密直接拒絕
- 拒絕 loopback / 私有網段 / link-local（127.\*、10.\*、192.168.\*、172.16–31.\*、169.254.\*、::1、fe80/fc/fd）
- Discord/Slack 額外檢查網域（discord.com / \*.slack.com）
- 自訂 Webhook 需明確 opt-in 才允許 localhost（UI 中有風險說明）

**自訂 Webhook 風險**：內容會 POST 到你指定的任意 https 端點，請只指向你信任的服務。

## 匯出與匯入

- Export：settings 白名單過濾（key 含 secret/token/webhook/password/cookie 者剔除）；channel 只匯出偏好與 `secretRef`。
- Import：先 `validateImport()`（schema 版本、型別、機密欄位偵測）再落地；驗證失敗完全不動既有資料；Replace 前自動先做一次匯出備份。

## 其他

- 通知重試有上限（3 次、指數退避、封頂 15 分鐘），不會無限轟炸外部服務。
- SQLite 寫入經 repository 統一路徑；dedup 由 `(event_key, channel_id)` unique index 在儲存層強制。
- Tauri HTTP 權限範圍限定 `https://**`（capabilities/default.json）。
