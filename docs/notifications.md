# Notifications

## 管道（`src/adapters/notifications/channels.ts`）

| 管道 | 傳輸 | Secret |
|---|---|---|
| Desktop | `tauri-plugin-notification` | 無 |
| Discord | Webhook POST（product embed、停用 mentions） | Webhook URL（Keychain） |
| Slack | Incoming Webhook POST `{ text }` | Webhook URL（Keychain） |
| Telegram | `api.telegram.org/bot<token>/sendMessage` | Bot Token（Keychain）＋ chatId（非密，存 config） |
| Custom Webhook | POST `{ title, body, severity, source, sentAt }` | URL（Keychain） |

統一介面 `NotificationChannelAdapter { validateConfiguration, send }`；HTTP 走 `tauri-plugin-http`（Rust 端）。

## 事件類型（7）

`quota_expiring`、`reset_expected`、`reset_confirmed`、`usage_warning`、`exhaustion_forecast`、`polling_failed`、`data_stale` — 由 `domain/notificationEvents.ts` 依 forecast/reset/新鮮度產生，文案一律用「預估／可能／依目前資料」。

`usage_warning` 的門檻可在通知頁第 2 步設定為剩餘 1–50%；預設 15%。門檻套用到所有啟用此事件的額度，同一額度在同一重置週期只通知一次。

Discord 僅接受官方 `discord.com`／`discordapp.com` 的完整 `/api/webhooks/{id}/{token}` URL；訊息使用 Embed 呈現嚴重程度、標題、內容與時間，並設定 `allowed_mentions.parse=[]` 防止通知內容意外 ping 使用者或群組。通知頁提供「儲存並測試」，成功收到測試訊息才算完成串接。

## 每管道可獨立設定

啟用開關、6 個事件各自開關（矩陣 UI）、靜音時段（支援跨午夜）、最小通知間隔、測試按鈕、傳送歷史。另有全域總開關（關閉 = 任何管道都不送）。

預設矩陣（Onboarding 建立的桌面通知）：

| 管道 | 啟用 | 預計重置 | 臨時／提前重置 | 即將用完 | 耗盡預測 | 同步失敗 | 資料過期 |
|---|--:|--:|--:|--:|--:|--:|--:|
| 桌面通知 | 開 | 開 | 開 | 開 | 開 | 關 | 關 |
| 外部管道 | 使用者自行新增，預設不存在 | | | | | | |

## 去重（絕不重複騷擾）

- 穩定 eventKey：`{provider}:{limitKey}:{eventType}:{anchorIso}`（例 `claude:weekly:lim123:reset_confirmed:2026-07-20T07:00:00.000Z`）
- 發送前查 `(eventKey, channelId)` 是否已 `sent` → 已成功**永不重發**
- 儲存層雙保險：`notification_deliveries` 的 UNIQUE index
- 不同管道各自可送一次

## 重試

失敗允許重試，上限 **3 次**；退避 30s × 2^(n−1)，封頂 15 分鐘；`sent`/`skipped` 不重試；重試在每次排程 run 的 `retryFailed()` 執行 — 不會每小時無限轟炸。

## 測試通知

每個管道提供「測試」：即送一則固定測試訊息（繞過去重），成功顯示 toast、失敗顯示**已脫敏**的原因（不含完整 URL/Token）。

## 通知內容範例

見規格 §9：預計重置／臨時或提前重置／即將用完／資料過期四種文案已實作於 `notificationEvents.ts`，皆為估算措辭。
