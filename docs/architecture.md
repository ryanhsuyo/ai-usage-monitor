# Architecture

## 分層

```
┌─────────────────────────────────────────────┐
│ ui/          React 頁面與元件（UI state only）│
├─────────────────────────────────────────────┤
│ services/    協調流程：MonitorService、        │
│              NotificationDispatcher、Demo、   │
│              Export/Import、Scheduler        │
├─────────────────────────────────────────────┤
│ ports/       介面（依賴反轉的邊界）             │
├──────────────┬──────────────┬───────────────┤
│ adapters/    │ adapters/    │ adapters/     │
│ storage      │ notifications│ platform      │
│ (SQL 唯一居所)│ (5 channels) │ (Tauri/OS)    │
├──────────────┴──────────────┴───────────────┤
│ domain/      純函式 + 型別。無 React、無 SQL、  │
│              無 OS、無 I/O                    │
└─────────────────────────────────────────────┘
src-tauri/    Rust native：migrations 註冊、keyring、tray、
              hide-on-close、plugins（sql/notification/autostart/http/…）
```

## 關鍵規則

- **Domain 純函式**：`burnRate/forecast/resetDetection/planRecommendation/confidence/dedup/retry/quietHours/validation` 全部無副作用，直接可測。
- **Ports 介面**：services 依賴 `src/ports` 的介面，不依賴實作。測試用 InMemory/Fake 替身。
- **SQL 只在 storage adapter**：repositories 做 snake_case ↔ camelCase 映射；`SqlDatabase` port 讓測試換成 `FakeSqlDatabase`。
- **平台能力只在 platform adapter + Rust**：React 不直接呼叫 OS。Tray handler（Rust）只轉發事件到 webview，不含業務邏輯。
- **Secret 流向**：UI → `SecretStore.setSecret(ref, value)` → Keychain。DB/匯出檔只見 `secretRef`。發送通知時 dispatcher 以 ref 換 value，用完即丟，錯誤訊息先 redact。

## 組合根

`src/ui/appServices.ts` 是唯一的組合點：偵測 Tauri runtime → 真實實作；否則（jsdom 測試、純瀏覽器預覽）→ in-memory 替身。UI 與測試共用同一套 wiring。

## 背景流程（每小時 + 啟動時）

```
Scheduler (setInterval) → MonitorService.runOnce(trigger)
  1. 設定檢查（polling 開？暫停？）＋ single-flight guard
  2. 每個 active+monitored limit：
     a. 讀快照 → detectReset()（confirmed / expected / none）
     b. 需要時寫入 ResetEvent（同 anchor 不重複；expected 可升級成 confirmed）
     c. computeForecast()（burn rate 6h/24h/cycle → 耗盡時間 → 重置時剩餘）
     d. evaluateNotificationEvents()（穩定 eventKey）
  3. NotificationDispatcher.dispatch(candidates)
     — 事件持久化（同 key 不重建）→ 每個啟用管道：
       事件偏好 → 去重 → 有限重試 → 靜音時段 → 最小間隔 → adapter.send()
  4. retryFailed()（退避上限 3 次）
  5. 寫 scheduler_runs
```

## 跨平台

所有 OS 能力（通知、autostart、tray、背景執行、secret、檔案對話框、資料目錄）都經由 port + Tauri 跨平台 plugin。Windows 支援 = 補 Rust bundle 設定與驗證，TS 層不需改動（見 docs/cross-platform.md）。
