# Domain Model

完整型別定義見 `src/domain/types.ts`（single source of truth）。本文為導讀。

## 實體關係

```
ProviderAccount 1 ─── n SubscriptionPlan 1 ─── n UsageLimit
                                                   │
                 ┌──────────────┬─────────────────┼──────────────┐
                 n              n                 n              n
           UsageSnapshot  UsageActivity      ResetEvent   (ForecastResult)*
                                                            *計算結果，不落地
NotificationChannelConfig 1 ─── n NotificationDelivery n ─── 1 NotificationEvent
```

## 核心型別速覽

| 型別 | 意義 | 關鍵欄位 |
|---|---|---|
| `ProviderAccount` | 一個服務帳號 | providerId ∈ claude/codex/chatgpt/gemini/cursor/custom |
| `SubscriptionPlan` | 訂閱方案 | monthlyPrice、currency、relativeCapacity（相對容量，非精確 token） |
| `UsageLimit` | 一個額度視窗 | type ∈ rolling_session/weekly/weekly_model/context/credits/custom；monitoringEnabled、notifyEnabled |
| `UsageSnapshot` | 一次用量讀值 | usedPercent/remainingPercent、capturedAt、resetAt、source、valid、errorCode |
| `UsageActivity` | 一次任務 | taskType、usageBefore/After/Delta、status ∈ in_progress/completed/cancelled |
| `ResetEvent` | 重置事件 | detectionMethod ∈ confirmed_by_usage_drop / confirmed_by_reset_change / expected_time_reached / manual |
| `ForecastResult` | 預測輸出 | estimatedExhaustionAt、willExhaustBeforeReset、burnRate6h/24h/cycle、confidence、warnings |
| `RemainingTaskEstimate` | 剩餘次數 | minimum/maximum 範圍、sampleCount、confidence |
| `PlanRecommendation` | 方案建議 | upgrade/keep/downgrade/insufficient_data + reasons |
| `NotificationChannelConfig` | 通知管道 | type、secretRef（**只存指標**）、eventPreferences、quietHours、minInterval |
| `NotificationEvent` | 通知事件 | eventKey（穩定去重鍵）、severity |
| `NotificationDelivery` | 每管道傳送狀態 | status ∈ pending/sent/failed/skipped、attemptCount |

## 邊界鐵律

- Domain 不 import React、不碰 SQL、不知道作業系統
- UI state 不混入 domain 型別
- Secret value 永不出現在任何 domain 型別（只有 `secretRef`）
- 時間一律 ISO 8601 UTC 字串
