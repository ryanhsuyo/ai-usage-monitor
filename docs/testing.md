# Testing

執行：`pnpm test`（Vitest 2 + jsdom + React Testing Library）。**119 tests / 11 files，全綠**。

## Domain 單元測試（`src/domain/*.test.ts`，64 tests）

- `burnRate.test.ts` — 正常增加、用量不變、下降不計、抓取失敗不當 0%、時序錯亂、最小間隔合併、極端值排除、cycle 邊界（規格案例 1,2,3,5,6,7,8,11）
- `forecast.test.ts` — 會/不會在重置前用完（案例 13,14）、零 burn、無資料、過期降信心、短視窗降信心
- `remainingTasks.test.ts` — 樣本不足、delta≤0 忽略、四分位範圍、極端值、跨類型隔離、額度用盡（案例 9,10,11）
- `resetDetection.test.ts` — 確認 drop、失敗 0% 不確認、門檻、信心加成、resetAt 推進、expected≠confirmed（案例 4,5,12）
- `planRecommendation.test.ts` — upgrade/keep/downgrade/insufficient（案例 15–18）、extra credits 擋降級、28 天門檻
- `notifications.test.ts` — eventKey 穩定、去重（案例 19,20,21）、重試上限與退避（案例 22）、靜音時段跨午夜（案例 23）、六種事件產生、估算措辭
- `validation.test.ts` — 快照驗證（含錯誤不轉 0%）、confidence 邊界與原因、匯入驗證（機密欄位偵測＝案例 24、壞列不炸＝案例 25）

## Repository 測試（`repositories.test.ts`，9 tests）

CRUD round-trip、upsert 不重複、latest-valid 查詢、刪除、活動更新、**(event_key, channel_id) unique 去重**、channel 無 secret 值、settings、scheduler single-flight。

## Services 測試（`services.test.ts`，15 tests）

Dispatcher：同事件單管道一次、雙管道各一次、事件偏好、總開關、靜音 skipped、重試 3 次封頂、測試通知失敗訊息。
Monitor：manual-only 只給 expected、不造假快照、confirmed 不重複、polling 停用跳過。
Export/Import：無 Secret、invalid 拒絕不傷資料、merge 不覆蓋、replace 換全套。
Demo：載入內容完整、清除乾淨。

## Channel Adapter 測試（`channels.test.ts`，13 tests）

URL 安全（https/私網段/credentials/localhost opt-in）、redaction、五管道成功/失敗、**Secret 不進錯誤訊息**。

## UI 測試（`ui.test.tsx`，12 tests）

Dashboard 空狀態、資料不足不顯示假估算、方案建議 insufficient、低信心顯示原因、新增/拒絕手動快照、Demo 載入與清除、通知矩陣開關、總開關 disable、測試通知成功/失敗、Settings 開關（背景/自啟）、History 重置與失敗標記、**Secret 不出現在匯出與 UI 資料**。

## 慣例

- 測試資料一律假值；不得放真實 Webhook/Token
- 新 domain 行為必須先有測試（見 AGENTS.md）
- 平台能力測試用 InMemory 替身，不依賴 macOS
