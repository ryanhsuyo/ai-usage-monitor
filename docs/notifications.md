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

## 事件類型（8）

由 `domain/notificationEvents.ts` 依 forecast/reset/新鮮度產生，文案一律用「預估／可能／依目前資料」。預設值集中在 `DEFAULT_EVENT_PREFERENCES`，管道與額度共用同一份。

| 事件 | 預設 | 何時發 |
|---|--:|---|
| `reset_confirmed` | 開 | 確認額度已重置（早於預定時間則標示為臨時／提前） |
| `usage_warning` | 開 | 剩餘低於門檻 |
| `usage_exhausted` | 開 | 額度真的用完（剩餘 ≤ `EXHAUSTED_REMAINING_PERCENT`） |
| `quota_expiring` | 開 | 剩餘額度來不及用完，或 Codex reset 票券可用／將到期 |
| `reset_expected` | 關 | 預定重置時間已過但尚未讀到新用量 |
| `exhaustion_forecast` | 關 | 依目前速度預估會在重置前耗盡 |
| `polling_failed` | 關 | 讀取本機用量失敗 |
| `data_stale` | 關 | 長時間沒有新資料 |

預設開啟的是使用者需要採取行動的四種狀態；預測與診斷類事件對「之後多半會自行解決」的狀態發話，故預設關閉但可逐額度開啟。

`usage_warning` 的門檻可在通知頁第 2 步設定為剩餘 1–50%；預設 15%。`usage_warning` 與 `usage_exhausted` **是兩個獨立事件、各自一把 key**：同一週期先發的「剩 10%」不會蓋掉之後的「已用完」。兩者互斥，同一額度在同一重置週期各只通知一次。

Discord 僅接受官方 `discord.com`／`discordapp.com` 的完整 `/api/webhooks/{id}/{token}` URL；訊息使用 Embed 呈現嚴重程度、標題、內容與時間，並設定 `allowed_mentions.parse=[]` 防止通知內容意外 ping 使用者或群組。通知頁提供「儲存並測試」，成功收到測試訊息才算完成串接。

## 每管道可獨立設定

啟用開關、8 個事件各自開關（矩陣 UI）、靜音時段（支援跨午夜）、最小通知間隔、測試按鈕、傳送歷史。另有全域總開關（關閉 = 任何管道都不送）。

新建的管道與從未調整過的額度都採用上表的預設值。外部管道由使用者自行新增，預設不存在。

Migration 0003 會把既有管道中舊版 onboarding 寫死的 `reset_expected`／`exhaustion_forecast` 移除，使其回歸預設；其餘偏好不動。

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
