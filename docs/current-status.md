# Current Status

> 後續 Agent：先讀這份，再執行 `git status`，然後看 `docs/handoff-log.md`。

**日期**：2026-07-16
**版本**：0.1.0（Phase 0 + Phase 1 + Phase 1.5 完成）

## 狀態總覽

| 項目 | 狀態 |
|---|---|
| `pnpm typecheck` | ✅ 0 errors（TS strict） |
| `pnpm lint` | ✅ 0 errors / 0 warnings |
| `pnpm test` | ✅ 119/119（11 檔） |
| `pnpm tauri build` | ✅ `.app` + `.dmg`（unsigned） |
| Rust `cargo check` | ✅ |

## 已完成

- Domain 純函式全套（burn rate / forecast / remaining tasks / reset detection / plan recommendation / confidence / dedup / retry / quiet hours / snapshot+import validation）＋門檻集中 `constants.ts`
- SQLite 13 表 + migration（Rust 註冊、啟動自動執行、可重複套用）
- Repository 層（SQL 只在 `adapters/storage`）＋ FakeSqlDatabase 測試替身
- Provider adapters：Manual 可用；Claude Browser / Claude Code Local / Codex Local / ChatGPT Browser 為誠實 `unsupported` stub
- 通知管道 ×5（desktop/discord/slack/telegram/custom webhook）＋ SSRF 檢查＋redaction
- SecretStore：Keychain（keyring crate）主、AES-GCM 加密檔備、InMemory 測試
- Services：MonitorService（每小時+啟動+single-flight+暫停）、NotificationDispatcher（去重/重試/靜音/最小間隔/總開關）、DemoData、Export/Import
- UI 8 頁 + Onboarding（使用者手寫設計語言 + 補 dark mode）；Demo Mode 橫幅；空/載入/錯誤/資料不足/低信心狀態
- Rust：tray menu、hide-on-close 背景執行、tray tooltip 更新、keyring 指令、quit
- 文件全套（README、AGENTS、docs/*）

## 未完成（Roadmap）

- Phase 2：Claude Code / Codex 本機整合
- Phase 3：Browser 自動同步
- Phase 4：Windows build（**架構邊界已保留**，TS 層無需改動）
- Phase 5：簽章 / notarization / 自動更新
- 已知小項：UI 測試有少量無害的 React `act()` warning（不影響結果）；`data_source_status` 表由 UI 靜態呈現，尚未持久化各來源的 lastRun 統計（scheduler_runs 有完整紀錄）

## 環境備註

- Node 18 → 鎖 Vite 6 / Vitest 2；升 Node 20+ 後才可升 Vite 7+
- 無簽章憑證 → unsigned build；首次開啟需右鍵→打開
- 產物：`src-tauri/target/release/bundle/macos/AI Usage Monitor.app`、`bundle/dmg/*.dmg`
