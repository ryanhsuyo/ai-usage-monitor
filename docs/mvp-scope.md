# MVP Scope（Phase 0 + 1 + 1.5）

## In scope（已交付）

- 手動輸入、JSON 匯入、Demo Provider、手動活動紀錄
- Provider Adapter interface + 未完成 stub（回傳 `unsupported`）
- Onboarding（Provider → 方案 → 額度 → 首筆用量 → 行為設定 → 可跳過的外部通知）
- Dashboard 四卡（用量／預測／剩餘任務／方案建議，含可信度與原因）
- Usage History（SVG 趨勢圖、重置/失敗標記、篩選、刪除）
- Activity Tracking（開始/完成/取消/補記、統計）
- Plans 管理（帳號/方案/額度 CRUD、Claude 範本可改）
- 每小時 Scheduler + 啟動檢查 + single-flight + 可暫停
- Reset Detection（expected 與 confirmed 嚴格分開）
- 通知：Desktop / Discord / Slack / Telegram / Custom Webhook
  - 管道×事件矩陣、靜音時段、最小間隔、測試、去重、退避重試、傳送歷史
- Secret Store（Keychain 主 + 加密檔備 + InMemory 測試）
- SQLite（13 表、migration、repository 邊界、transaction-safe upsert）
- JSON Export（無 Secret）/ Import（驗證 → Merge/Replace → 失敗不破壞）
- Menu Bar 常駐、關窗背景執行、Auto Start 開關、完全退出
- 119 個自動化測試、typecheck/lint/build 全綠、unsigned .app/.dmg

## Out of scope（Roadmap）

- Playwright/Browser 自動同步（Phase 3）
- Claude Code / Codex 本機整合（Phase 2）
- Windows build（Phase 4；架構邊界已保留）
- 簽章、notarization、自動更新（Phase 5）
