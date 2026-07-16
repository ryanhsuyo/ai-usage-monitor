# Calculation Rules

全部實作於 `src/domain/`（純函式），門檻集中於 `src/domain/constants.ts`。

## Burn Rate（`burnRate.ts`）

`burnRate = usage percentage delta / elapsed hours`，分 6h / 24h / 本週期三個視窗。

- 只用 `valid` 快照；同一 account+limit；capturedAt 防禦性排序
- 相距 < 10 分鐘的讀值合併為同一筆（`TIME.MIN_INTERVAL_MINUTES`）
- **下降的 delta 一律不計入 burn**（未確認 reset 的下降不會污染速度）
- 抓取失敗絕不轉成 0%（invalid 快照直接排除）
- 段速率以 IQR×1.5 排除極端值並在 warnings 標示
- 樣本少 → confidence 低

## Estimated Exhaustion（`forecast.ts`）

`hoursToExhaust = (100 − used) / selectedBurnRate`

Burn rate 選擇順序：**24h（≥2 段）→ 本週期 → 6h（降信心）**；rate ≤ 0 時不提供耗盡時間。
輸出含 `estimatedExhaustionAt / willExhaustBeforeReset / confidence / sampleCount / warnings`。

## Estimated Remaining at Reset

`clamp(100 − (used + burnRate × hoursUntilReset), 0, 100)`；零 burn 時 = 目前剩餘。

## Remaining Task Estimate（`remainingTasks.ts`）

同類型已完成活動的 usageDelta 四分位數：

- `minimum = floor(available / Q3)`、`maximum = floor(available / Q1)`
- 忽略 delta ≤ 0；IQR 排除極端值；**< 3 筆 → 資料不足，不給範圍**
- 顯示範圍而非單一精確數字；不假裝知道官方剩餘訊息數

## Reset Detection（`resetDetection.ts`）

確認候選：`prev ≥ 20 ∧ curr ≤ 5 ∧ drop ≥ 20 ∧ current valid ∧ 無 errorCode`（基礎信心 0.75）。
加信心：resetAt 已推進（+0.15）、連續 ≥2 筆低用量（+0.1）。
`resetAt 推進 ∧ curr ≤ 5` 亦可獨立確認（`confirmed_by_reset_change`，0.8）。
`expected_time_reached`（到時未見新資料，0.4）**永遠不稱「已確認」**，只提醒使用者回 App 更新。

## Plan Recommendation（`planRecommendation.ts`）

門檻（`PLAN_RECOMMENDATION`）：需 ≥4 完整週期或 ≥28 天資料，否則 `insufficient_data`。

- **Upgrade**：近 4 週期 ≥3 次提前用完 ∧ 平均利用率 ≥90% ∧ 平均提前 ≥12h
- **Downgrade**：平均利用率 <45% ∧ 0 次提前用完 ∧ 未常用額外 credits
- **Keep**：其餘（50–90% 利用率、偶爾提前用完等）

週期摘要由 `ui/derive.ts::buildCycleSummaries` 從快照+確認重置事件推導（用量 ≥98% 視為提前耗盡）。

## Confidence（`confidence.ts`）

0–1 乘法模型：樣本數（線性至健康值）、資料新鮮度（>8h 大幅衰減）、手動-only ×0.85、跨 reset ×0.7、每個極端值 −10%（下限 0.5）、高變異 ×0.8、序列缺漏 ×0.85、demo 標示。
等級：低 ≤0.39 < 中 ≤0.69 < 高。**UI 一律同時顯示等級與原因清單。**

## 通知決策（`dedup.ts` / `retry.ts` / `quietHours.ts`）

- eventKey = `provider:limitKey:eventType:anchorIso`（anchor 為該週期 reset 或整點桶）
- 同 (eventKey, channelId) 成功後永不重發（另有 DB unique index 雙保險）
- 失敗重試上限 3 次；退避 30s × 2^n，上限 15 分鐘
- 靜音時段支援跨午夜；最小間隔以最近成功送出時間計
