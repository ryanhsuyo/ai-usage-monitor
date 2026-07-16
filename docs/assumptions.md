# Assumptions（實作過程的合理假設）

1. **App 名稱與 bundle id**：使用者選定 `ai-usage-monitor`；顯示名 "AI Usage Monitor"、bundle id `com.aiusagemonitor.app`。原資料夾 `ai-usage-management` 已由使用者搬移，工作目錄更名為 `~/Developer/ai-usage-monitor`。
2. **Node 18 環境**：鎖定 Vite 6 / Vitest 2（Node 18 相容），不用需要 Node 20+ 的 Vite 7 / Vitest 3。
3. **Secret Store 策略**：使用者要求「最安全、符合產品」→ OS Keychain 為主（keyring crate），probe 失敗自動退回 AES-GCM 加密檔並於 UI 標示。
4. **Claude 預設方案數字**（Pro $20 / Max 5x $100 / Max 20x $200，容量 1x/5x/20x）僅為可編輯的起始範本，非官方保證。
5. **確認重置門檻**：prev ≥ 20%、curr ≤ 5%、drop ≥ 20pp，取自規格 §11 候選條件；提前耗盡認定為週期內用量 ≥ 98%。
6. **週期摘要推導**：Plan recommendation 需要的 cycle summary 由「確認重置事件」切割快照序列而得；只有 ≥2 筆快照的完整週期才列入評估。
7. **通知 anchor**：usage_warning / exhaustion_forecast 以「下一次 resetAt」為 dedup anchor（同週期只發一次）；data_stale / polling_failed 以整點時間桶為 anchor（最多每小時一次）。
8. **HTTP 出口**：外部通知走 `tauri-plugin-http`（Rust 端，無瀏覽器 CORS 限制），capability 限 `https://**`。
9. **UI 設計語言**：沿用使用者在 `global.css` / App 原型中手寫的視覺（深色側欄、teal 主色、卡片樣式、provider 色標），我在同語言下補齊 dark mode 與缺少的元件樣式；localStorage 原型功能已由 SQLite 版完整取代。
10. **min-width 780px**：沿用使用者 CSS 的桌面優先假設；視窗最小尺寸設 900×640。
11. **時間儲存**：一律 ISO 8601 UTC 字串；顯示用系統時區。`usage_limits.timezone` 保留給未來的 reset rule 計算。
12. **通知重試**：在每次排程 run 內做一次 `retryFailed()`（上限 3 次、退避檢查），不另起獨立計時器。
13. **瀏覽器預覽模式**：非 Tauri 環境（`pnpm dev` 直接開瀏覽器、jsdom 測試）自動退回 in-memory 資料層，方便開發與測試；正式 App 一律走 SQLite。
14. **未簽章 build**：環境無開發者憑證，交付 unsigned .app/.dmg（規格 §25 允許）。
