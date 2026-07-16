# Provider Adapters

## 介面（`src/ports`）

```ts
type ProviderFetchResult =
  | { ok: true; snapshots: UsageSnapshot[]; fetchedAt: string }
  | { ok: false; errorCode: string; message: string; fetchedAt: string };

interface UsageProviderAdapter {
  id: string;
  providerId: ProviderId;
  displayName: string;
  supportsAutomaticPolling: boolean;
  fetchUsage(): Promise<ProviderFetchResult>;
}
```

## 現況（`src/adapters/providers/index.ts`）

| Adapter | 狀態 | 行為 |
|---|---|---|
| `ManualProviderAdapter` | ✅ 可用 | 不可抓取：回傳 `errorCode: "manual_source"`，排程知道無資料可拉、**不憑空造快照** |
| `JsonImportService` | ✅ 可用 | 走 Export/Import 服務（見 storage.md / §匯入） |
| Demo Provider | ✅ 可用 | `DemoDataService` 一鍵載入/清除，資料標記 `source: "demo"` |
| `ClaudeBrowserAdapter` | 🕓 Phase 3 | 回傳 `unsupported` |
| `ClaudeCodeLocalAdapter` | 🕓 Phase 2 | 回傳 `unsupported` |
| `CodexLocalAdapter` | 🕓 Phase 2 | 回傳 `unsupported` |
| `ChatGPTBrowserAdapter` | 🕓 Phase 3 | 回傳 `unsupported` |

## 鐵律

1. 未完成的 Adapter **必須**回傳 `{ ok: false, errorCode: "unsupported" }` — 不得回傳假快照、不得回傳成功。
2. 抓取失敗**不得**轉成 usedPercent 0%；失敗以 `valid=false + errorCode` 快照或 DataSourceRun 記錄。
3. 只有手動資料來源時，到達 resetAt 只能產生「**預計**已重置」事件，不得宣稱「已確認」。
4. 新 Provider 上線 = 實作此介面 + 在 Data Sources 頁註冊顯示；核心（forecast、通知）零改動。
5. 未來 Browser 類 Adapter 不得綁死單一 DOM selector（需可替換 selector strategy + parser health check）。
