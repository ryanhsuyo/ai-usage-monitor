# Handoff Log

## 2026-07-16 — 初始交付：Phase 0 + 1 + 1.5 完整 MVP

**Agent**: Claude (Fable 5)
**範圍**: 從空資料夾建立完整可執行的 macOS 桌面 MVP。

### 做了什麼

1. `git init` + Tauri 2 + React 18 + TS strict + Vite 6 + Vitest 2（pnpm；Node 18 相容版本鎖定）
2. Domain 純函式 + 64 domain 測試（規格 §20 的 25 個案例全覆蓋）
3. SQLite migration（13 表）+ repository 層 + 9 repo 測試
4. Provider/Notification/Platform adapters + SecretStore（Keychain 主 + 加密檔備）
5. Services（Monitor/Dispatcher/Demo/ExportImport）+ 15 測試
6. UI 8 頁 + Onboarding + 12 UI 測試；沿用使用者手寫的 `global.css` 設計語言與 App 原型視覺，補 dark mode 與元件樣式
7. Rust native：tray、hide-on-close、keyring、migrations
8. 文件全套；typecheck/lint/test/build 全綠；unsigned .app/.dmg

### 過程中的重要事件

- **使用者中途搬移專案**：`~/Desktop/code/ai-usage-management` → `~/Developer/`，另建空的 `ai-usage-monitor`。已將專案更名合併至 `~/Developer/ai-usage-monitor`（rmdir 空資料夾 + mv，無資料損失）。
- **使用者手寫了 `global.css` 與 App.tsx 原型**（localStorage 版總覽頁）。處理方式：保留其設計語言（深側欄、teal、卡片、provider 色標→`PROVIDER_BRANDS`），以 SQLite 版完整功能取代 localStorage 原型；原型的視覺模式移植進 Dashboard 與各頁。
- **`withoutOutliers` 修正**：IQR=0（多數值相同）時原本跳過過濾導致極端值漏網；改為一律過濾（相同值天然保留）。

### 下一步建議（按價值排序）

1. Phase 2 `ClaudeCodeLocalAdapter`：解析 Claude Code 本機 transcript/statusline → 自動活動紀錄（最高價值、無爬蟲風險）
2. `data_source_status` 持久化各 adapter 的 lastRun/lastSuccess/lastError（表已建好）
3. 週期 reset rule 引擎（`usage_limits.reset_rule` 欄位已預留）：手動來源也能自動推算下次 resetAt
4. Windows build 驗證（見 docs/cross-platform.md 清單）
