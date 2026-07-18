# Roadmap

## ✅ Phase 0 — Foundation（本次完成）

專案初始化、Tauri App Shell、文件、Domain Model、純函式計算規則、Repository 介面、Provider/Notification/Platform Adapter、測試架構、SQLite Migration、Secret Store 邊界。

## ✅ Phase 1 — Manual-first MVP（本次完成）

Onboarding、Provider Account／Plan／Limit、手動快照、Dashboard 四卡、Usage History、Activity Tracking、Forecast、Remaining Task Estimate、Plan Recommendation、Demo Data、JSON 匯入匯出、Settings、每小時 Scheduler、Menu Bar、Background Monitoring、桌面通知、測試、Build。

## ✅ Phase 1.5 — External Notifications（本次完成）

Discord／Slack／Telegram／自訂 Webhook、Secret Store、通知偏好矩陣、測試通知、去重、重試、靜音時段、傳送歷史。

## Phase 2 — Local Integrations（進行中）

- ✅ Claude Code `/usage` 官方本機快取解析（Session／Weekly／模型 Weekly）
- ✅ Codex 本機歷史、官方 rate-limit 與 token/cost 統計
- ✅ 每 5 分鐘同步、資料來源健康狀態與立即同步
- 自動辨識專案與模型 → 自動建立 UsageActivity
- Context window warning 與 `/compact` 建議

## Phase 3 — Browser Usage Sync（未實作）

- Playwright 讀取 Claude / ChatGPT usage 頁（使用既有 Browser Profile，不保存帳密）
- 可替換 Selector Strategy + Parser Health Check（避免綁死單一 DOM）
- Stale data 偵測、每小時自動同步、Confirmed Reset 通知
- Adapter 已預留：`ClaudeBrowserAdapter`、`ChatGPTBrowserAdapter`

## Phase 4 — Windows（未實作，邊界已保留）

- Windows System Tray / Toast 通知 / Credential Manager / Auto Start / App Data 路徑
- `.msi` 與 `.exe` 打包、Windows 上驗證 keyring 與 autostart plugin
- TS 層無需改動（全部走 port）；主要工作在 Rust bundle 設定與 QA

## Phase 5 — Public Release（未實作）

- macOS Code Signing + Notarization、Windows Signing
- Auto Update、Release Channel
- Onboarding Polish、Privacy Review
- Optional 匿名診斷（opt-in）
- Provider Plugin SDK（第三方可掛 Adapter）
