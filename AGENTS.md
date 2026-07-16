# AGENTS.md — AI Agent 工作規範

後續在此 repo 工作的 AI Agent 必須遵守以下規則。

## 開始任何工作之前

1. **先讀 `docs/current-status.md`** — 了解目前完成度與已知限制。
2. **先執行 `git status`** — 確認工作樹狀態；不可在不了解既有修改來源時動工。
3. 讀 `docs/architecture.md` 與 `docs/domain-model.md` 了解分層邊界。

## 硬性規則

1. 不得修改與任務無關的檔案。
2. **Domain 規則必須有測試**：`src/domain/` 內任何行為變更都要有對應的 Vitest 測試。
3. 不得以 Demo Data 冒充真實 Provider 資料；未實作的 Adapter 必須回傳 `unsupported`，不得回傳假成功。
4. **不得把 Secret 寫入 repo**：不在程式碼、測試 fixture、文件中放真實 Webhook URL、Token、API Key。
5. 驗收（typecheck + lint + test + build）全過後可以 local commit。
6. **永遠不得 `git push`**，不得修改遠端設定。
7. 每次完成工作必須更新 `docs/current-status.md`。
8. 每次完成工作必須在 `docs/handoff-log.md` 追加一筆交接紀錄。
9. **平台相關能力必須走 Adapter**（`src/ports/` 介面 + `src/adapters/platform/` 實作）。
10. 不得將 macOS（或任何 OS）邏輯寫進 `src/domain/`。
11. 計算邏輯是純函式，不得直接寫在 React Component 內。
12. SQL 只能出現在 `src/adapters/storage/`；Domain 與 UI 不碰 SQL。
13. Secret Value 只能經過 `SecretStore` 介面；SQLite 只存 `secretRef`。
14. 所有預測文案使用「預估／可能／依目前資料」等字眼，不得宣稱官方保證。

## 驗收指令

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm tauri build
```

## 分層地圖（改哪層看哪裡）

| 要改什麼 | 位置 |
|---|---|
| 計算規則 / 門檻 | `src/domain/*.ts`（門檻集中在 `constants.ts`） |
| 新 Provider 整合 | `src/adapters/providers/` 實作 `UsageProviderAdapter` |
| 新通知管道 | `src/adapters/notifications/` 實作 `NotificationChannelAdapter` |
| 平台能力（通知/自啟/tray） | `src/ports/` + `src/adapters/platform/` + `src-tauri/src/` |
| 資料表 / SQL | `src-tauri/migrations/`（新增 migration，不改舊檔）+ `src/adapters/storage/` |
| 排程 / 通知決策流程 | `src/services/` |
| 頁面 | `src/ui/pages/` |
