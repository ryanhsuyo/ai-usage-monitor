# Handoff Log

## 2026-07-20 — 「同步失敗」通知從死碼變成真的會發

- 專案體檢發現：通知設定有「讀取本機用量發生錯誤時通知」開關、onboarding 也會寫入偏好，但 `pollingFailed` 這個 context 欄位**全專案沒有任何地方設成 true**，事件永遠不可能發出；而 collector 的 provider 級失敗又被內部 catch 吞掉，monitor 只看到「沒有新讀值」。等於使用者以為有保護、實際沒有——CLI 壞掉、路徑變動、登出都只會表現為數字怪怪的。
- `createLocalUsageCollector` 回傳型別由 `number` 改為 `{ inserted, failedProviders }`，明確區分「沒變化」與「讀不到」；5 個呼叫端一併更新。
- `monitorService` 把 `failedProviders` 傳進 `checkLimit`，依該額度所屬 provider 設定 `pollingFailed`。
- 事件 key 改為 provider 級（`claude:sync:polling_failed:<小時>`）：一次讀取失敗只發一則，不會因為 Claude 有三個額度就一小時吵三次。
- 測試：拆掉接線即失敗（已驗證），並涵蓋「健康的一輪不發」「別的 provider 失敗不算在這個額度頭上」「同 provider 多額度收斂成同一把 key」。
- **注意**：此事件預設為關閉（原設計「避免干擾」）。要收到需在通知設定 → 編輯管道 → 勾選「同步失敗」。
- 驗收：typecheck／lint／199 tests／tauri build 全綠。

## 2026-07-20 — 重置通知只在「重置當下」發送

- 使用者澄清需求：要一則重置通知，但**不要在重置後已經用了一些才通知**。
- 先前為了處理「電腦睡過重置點、醒來已用 34%」的情況，`confirmed_by_reset_change` 取消了「新讀值需 ≤5%」的限制（bbec5b2）。偵測放寬是對的（UI／歷史需要知道確實換週期了），但**通知**不該跟著放寬。
- 改為在通知層加新鮮度閘門：`RESET_NOTIFY_MAX_USED_PERCENT`（5%）。重置仍照常偵測與記錄，只有在新週期尚未被使用時才推播——這則通知的用途是「額度回來了、可以繼續做事」，一旦使用者已經在用，它就只是舊聞。
- 以 7/20 session 真實序列回放驗證：06:13（95%→0%，真正重置那一刻）發出唯一一則「Claude 額度已重置」，其後 0%／2%／3%／3%／4%／4% 全部靜默（含 1 秒抖動那兩筆）。
- 驗收：typecheck／lint／197 tests／tauri build 全綠。

## 2026-07-20 — 通知文案統一稽核

- 把資料庫裡實際送出過的所有 `notification_events` 撈出來逐則檢視，找到四個文案問題（都與重複無關，是內容本身）：
  1. **日期是美式英文格式**：`formatLocal` 用 `toLocaleString()`（跟隨 runtime locale），在全中文介面裡渲染成 `7/18/2026, 7:59:59 PM`。改用 `Intl.DateTimeFormat("zh-TW", …)`，與小工具 tooltip 一致（`7/25（週六） 下午08:00`）。
  2. **「平均每小時可使用約 242%」**：`suggestedPercentPerHour = 剩餘 ÷ 剩餘小時`，重置只剩十幾分鐘時分母趨近 0。改為僅在剩餘 ≥ 1 小時才給每小時建議，否則改說「距離重置不到 1 小時，剩餘額度可能來不及用完」。小工具 tooltip 同步修正。
  3. **「預估約 0 小時後耗盡」**：四捨五入把不到一小時說成 0。新增 `formatDuration`：<1 小時→「不到 1 小時」、<48 小時→小時、其餘→天（順帶解決週額度「距離重置仍有 168 小時」的可讀性）。
  4. **額度已用完仍說「即將用完」**：`usage_warning` 在剩餘 ≤1% 時改為「已用完／額度已用盡，需等待重置」並附上預計重置時間。
- 新增 5 個文案測試（含「不得出現 AM/PM 或 M/D/YYYY」「不得出現每小時建議」等反向斷言），並實際渲染六種情境人工確認語感。
- 驗收：typecheck／lint／195 tests／tauri build 全綠。

## 2026-07-20 — 通知重複全面稽核（第三、四個成因）

- 使用者再回報「額度預計已重置」在 Discord 出現兩則，要求全面檢查重複問題。稽核本機已送出的全部通知紀錄：**約四成是同一事件的重複**，成因共四個，前兩個已於稍早修掉：
  1. 錨點抖動 → 不同 event key（已修，`stableAnchor` + `isSameCycleEvent`）。
  2. Discord `content` 與 `embeds` 同內容 → 一則投遞顯示兩次（已修）。
  3. **新發現：dispatcher 的 delivery claim 是 check-then-insert**。兩個並行 run 都查不到既有 delivery 就都 insert，撞上 `uq_delivery_eventkey_channel` 後直接拋錯，讓**整個 monitor run 失敗**（scheduler_runs 實際留有多筆 `UNIQUE constraint failed` 的 failed run）。改為 insert 失敗時重查：確認是他人已claim就安靜跳過，否則才拋出真正的儲存錯誤。新測試以 fake DB 的同一唯一索引重現該錯誤訊息，移除容錯即失敗。
  4. **新發現：並行來源是殘留的 scheduler**。`useBootstrap` 的 cleanup 沒有 `scheduler.stop()`，dev 熱重載／StrictMode 重掛載每次都留下一個仍在跳的舊排程器——實測 `interval` 觸發在 0.5 秒內跑了四次，也解釋了相隔約 3 分鐘的同事件重複。cleanup 補上停止。
- **修正一則錯誤診斷（記錄以免重犯）**：原先判定 `runOnce` 的 in-flight 檢查前有 `await` 會造成 race，並據此改寫。實測把「bug」放回去測試仍然通過——JS 單執行緒下檢查與設旗標之間沒有 await，不會交錯。該改動已還原，只保留驗證單一執行的測試。
- 驗收：typecheck／lint／190 tests／tauri build 全綠。

## 2026-07-20 — Discord 一則通知不再顯示兩次

- 使用者回報同一則「額度即將用完」在 Discord 出現兩次。查 delivery 紀錄確認**只有一筆 Discord 投遞**（另一筆是桌面通知管道），排除重複發送。
- 真因在 payload：`discordPayload` 同時送出 `content`（純文字）與 `embeds`（同樣的 title／description）。這是 7/19 為了「客戶端偶爾不渲染 embed 會留下空訊息」加的保險，但在正常渲染 embed 的客戶端就會把同一段文字顯示兩次——截圖本身即證明 embed 正常渲染。
- 改為只送 embed（保留嚴重度顏色、footer、timestamp；⚠️／ℹ️／🚨 前綴仍在 title）。測試改為斷言「不得同時存在 content 副本」，避免日後有人再把保險加回來。
- Slack／Telegram／自訂 webhook 仍走 `plainText`，不受影響。
- 驗收：typecheck／lint／188 tests／tauri build 全綠。

## 2026-07-20 — 耗盡額度不再重複轟炸通知

- 使用者回報同一組「可能在重置前用完／即將用完」每輪都重發。查 `notification_deliveries` 找到真因：event key 尾端的重置時間在兩次輪詢間差 **1 秒**（`…16:02:16.000Z` vs `…16:02:17.000Z`），去重是字串完全比對，於是每次都被當成全新事件。
- 兩層修正：
  1. `buildEventKey` 以 `stableAnchor` 把錨點四捨五入到分鐘，止住 key churn（也不再灌爆 `notification_events`）。
  2. `isSameCycleEvent`：錨點相差在 `CYCLE_ANCHOR_TOLERANCE_MS`（30 分）內即視為同一週期，徹底免疫量化邊界翻轉。dispatcher 改以「管道 + 近 30 天」查詢既有 delivery 再做容差比對（`listDeliveries` 新增 `attemptedSince` 以限制掃描量）。
- 額外語意修正：`remainingPercent` ≤ `EXHAUSTED_REMAINING_PERCENT`（1%）時不再送 exhaustion_forecast——額度都用完了還說「預估 0 小時後耗盡」毫無意義；該週期的 usage_warning 仍會發一次。
- **解析陷阱（差點漏掉）**：真實 key 是 `codex:weekly:lim-0c36:exhaustion_forecast:…`，limitKey 自身含冒號，最初「取前三段」的解法在單元測試（簡化 key）中會過但實機完全無效。改為從右側正則抓取尾端 ISO，並把測試 key 全面換成含 limit id 的真實格式。
- 以 7/19 起真實 delivery 紀錄回放驗證：重複的一律被擋下，其餘照常送出（session/weekly 的 forecast 與 warning 各佔大宗）。
- 驗收：typecheck／lint／188 tests／tauri build 全綠。

## 2026-07-20 — 靜音時間輸入寬鬆化

- 使用者回報靜音欄位必須手打冒號，希望離開欄位時自動補完。
- Domain 新增純函式 `normalizeHhMm`：有分隔符時兩側各自照字面讀（`23:5` → 23:05，支援全形冒號與句點），純數字則以末兩位為分鐘（`2300` → 23:00、`930` → 09:30、`23`／`9` → 整點）。空字串視為「清除」，無法辨識時回傳 undefined，讓呼叫端保留使用者輸入並標記無效，而不是默默改寫。11 個新測試。
- 通知管道表單於 blur 正規化，並在下方顯示狀態提示：格式無效、只填一邊（靜音需兩邊都填才生效）、或已生效的時段摘要。儲存前再正規化一次並擋下無效值，避免存進去卻永遠不生效。
- 實機（瀏覽器預覽）逐一驗證：2300／23／9／930／23:5／23.30 皆正確補完，24 與 abc 保留原文並標記無效，清空正常。
- 驗收：typecheck／lint／183 tests／tauri build 全綠。

## 2026-07-20 — 重置通知誤導與 resets_at 抖動修正

- 使用者回報兩則通知問題，實查結果：
  1. 「23:00 後仍發通知」：三個管道的靜音時段欄位都是空值——表單裡的 23:00/08:00 只是 placeholder 範例，從未被儲存過；行為正常，屬 UX 誤導（管道編輯彈窗內的欄位太隱蔽）。
  2. 「額度預計已重置／尚未取得新的有效用量」：電腦睡過重置點，醒來第一輪 get_usage 其實已抓到新週期（session 34%、新 resets_at），但 confirmed 判定要求新讀值 ≤5%，34% 不符 → 降級 expected 並發出與事實矛盾的文案。
- 修正：`resets_at` 被官方推進到下一週期即為重置鐵證——`confirmed_by_reset_change` 不再要求用量 ≤5%（低用量僅提高信心 0.7→0.8）。新增 `resetAtAdvancedBetween`：advance 需超過 30 分鐘（`MIN_ADVANCE_MS`），排除 live fetch 每次 ±1 秒的 resets_at 抖動造成的假重置（此抖動在舊資料已實際觀察到 18:59:59↔19:00:00）。
- 通知文案：準時（now ≥ expectedResetAt）的 confirmed 重置改為「額度已重置／新週期已開始」；「臨時／提前重置」保留給真正早於預期的重置。
- 新增 4 個 domain 測試，總計 176。

## 2026-07-20 — 0.3.0 發版前掃描與修正

- 發版前全面掃描今日三個 commit 與先前懸置項，修正四件事：
  1. 成本統計表格 `periods.map` 的 Fragment 沒有 key（React 列表警告＋重繪風險）→ `<Fragment key>`。
  2. 滿額邏輯：原「任一額度 ≥99.5% 即暫停刷新」會凍結其他額度數字，且暫停期間 15 分鐘後 stale 判定把已知的 100% 藏成「等待官方更新」→ 改為**全部**額度滿才暫停，全滿等重置期間不標 stale。
  3. `claude` 執行檔只找 `~/.local/bin`＋PATH（GUI App 的 PATH 無使用者目錄）→ 依序探測 native installer／Homebrew／npm global。
  4. 快照灌水：24h 滾動 token metadata 每次收集都在變，note 比對永遠「有變化」導致同值快照重複寫入（實測單秒 ×24、三天 1000 筆）→ 新增 `isDeferrableMetadataRefresh`：同一官方讀值（percent/resetAt/stale flag 不變）的純 metadata 更新最多 10 分鐘一次；官方數值或 stale flag 變化永不延遲。含 6 個新測試。
- 版本升 0.3.0（package.json／tauri.conf.json／Cargo.toml／APP_VERSION）。
- 驗收：typecheck／lint／172 tests（20 檔）／cargo check／兩個 live 測試／tauri build 全綠。
- 已知未修（低風險，記錄備查）：get_usage 失敗時 20 秒 timeout 內持鎖；換帳號後行程內 fresh 快取可能沿用數分鐘；Keychain 遷移按「拒絕」不會被記住，會於下次送通知時再詢問。

## 2026-07-19 — ccusage 風格成本統計頁

- 需求：像 `npx ccusage daily/weekly/monthly` 一樣看見「到底花了多少」。
- Rust 新增 `read_claude_usage_daily(utc_offset_minutes)`：掃描 `~/.claude/projects` 全部 jsonl，依 `message.id`（fallback `requestId`）跨檔案去重、跳過 `<synthetic>`，以呼叫端時區把 timestamp 分桶成每日×模型 token 統計。live 測試（`cargo test -- --ignored`）實測 數百 MB 的本機歷史約 0.46 秒。
- Domain 新增 `usageStats.ts`：`aggregateClaudeUsage` 聚合 daily／weekly（ISO 週一起算）／monthly，含每模型 API 等值成本、未定價模型旗標；`summarizeUsagePeriods` 出全期間總計。10 個新 Vitest。
- `claudeCost.ts` 定價表改為官方牌價並補齊模型（Fable/Mythos $10/$50、Opus 4.5–4.8 $5/$25、Sonnet 4.5–5 $3/$15、Haiku 4.5 $1/$5；cache 寫 1.25×、讀 0.1×），新增 `claudePrice` 前綴比對支援 `claude-haiku-4-5-20251001` 這類帶日期字尾 ID。注意：既有 Fable 12/70 舊估價修正為官方 10/50，UI 各處 API 等值金額會略降。
- UI 新增 `usageStats` 頁與側欄「成本統計」：期間彙總卡片＋表格（多模型期間逐模型分項）、每日／每週／每月切換；瀏覽器模式如實顯示需桌面 App。已在瀏覽器預覽驗證路由與空狀態、以 live 測試驗證真實資料路徑。
- 快取寫入依 TTL 計價：解析 transcript `usage.cache_creation.ephemeral_5m/1h_input_tokens`，5 分鐘寫入 1.25×、1 小時寫入 2×（Claude Code 即為 1h TTL；無分項時保守以 1h 計）；Sonnet 5 促銷價（$2/$10）計至 2026-08-31 由 `claudePrice(model, nowIso)` 自動切換。
- 與 `npx ccusage@latest monthly --json` 實測對帳：2026-07 Claude 四模型（fable/opus/sonnet/haiku）成本差距 0.02%–0.3%（時間差與月界時區），sonnet 分毫不差；合計 兩者差距在 0.3% 以內。
- 全數驗收綠：typecheck／lint／167 tests／cargo check／tauri build。

## 2026-07-19 — 未簽章 build 不再反覆觸發 Keychain 授權彈窗

- 使用者回報：啟動時 macOS 反覆跳出「ai-usage-monitor wants to use your confidential information stored in "com.aiusagemonitor.app"」。
- 根因：app 無簽章憑證（`security find-identity` 0 valid），Tauri 產物為 linker ad-hoc 簽名且 identifier 含每次 build 變動的 hash；Keychain ACL 綁定簽名身分，因此每次重建都被視為不同 app，讀舊 build 建立的 Discord webhook secret 一定重新授權，「永遠允許」也只對單一 build 有效。
- 解法：新增 `app_signature_is_adhoc` command（`codesign -dv` 認 `Signature=adhoc`；已用實際產物與 Apple 簽名的系統 binary 驗證判定）。ad-hoc build 的 `createBestSecretStore` 視 Keychain 為不可靠，改用既有 AES-GCM 加密檔備援；`createMigratingSecretStore` 在首次讀取時把 Keychain 舊 secret 一次性搬入加密檔並刪除 Keychain 項目——最後允許一次授權後，之後所有重建永不再彈窗。拒絕授權則回報缺 secret，使用者可在通知頁重存 webhook。
- 正式簽章（Phase 5）後 `app_signature_is_adhoc` 為 false，自動回到 Keychain 主路徑。新增 6 個 migrating store 測試，總計 155 tests。

## 2026-07-19 — Claude 官方額度改用 stream-json `get_usage`，PTY 打字方案下線

- 使用者回報：Claude 已重置且持續使用中，UI 仍長時間顯示「等待官方更新」。實機重現兩個根因：
  1. 隱藏 PTY 送出的 `/usage` 完全沒有進入 Claude Code 2.1.215 的 TUI（輸出僅有啟動 banner，連字元回顯都沒有）；快取更新其實來自 Claude Code 啟動後自己的抓取，且該寫檔有 `wIg=300000`（5 分鐘）節流，等待 `fetchedAtMs` 前進的 45 秒窗口經常落空。
  2. quotaStale 門檻 1 分鐘 < 刷新節流 4 分鐘：活躍使用時活動永遠比快取新，百分比被永久隱藏。
- 解法：改用官方 stream-json 控制協定。`claude -p --input-format stream-json --output-format stream-json --verbose` 送 `{"type":"control_request","request":{"subtype":"get_usage"}}`，約 2 秒收到 `control_response`，內含 `rate_limits.limits`（與快取同構的 kind／percent／resets_at）。實測 0 tokens／0 cost；不讀 OAuth 憑證，Claude Code 內部自行呼叫 `/api/oauth/usage`。
- Rust 端 `fetch_claude_usage_via_cli` 同步取得後直接建快照，並保存行程內 fresh 副本（因 Claude Code 落盤節流，行程內副本可比 `~/.claude.json` 新）；離線／失敗時退回檔案快取。刷新條件（resetAt 到點優先、滿額等待、活動觸發、30 分鐘保底、4 分鐘節流）不變。
- quotaStale 門檻放寬到 15 分鐘：只有多輪刷新皆失敗才隱藏百分比，不再於正常使用時閃爍「等待官方更新」。
- 新增 `#[ignore]` live 測試 `fetch_claude_usage_live`（`cargo test -- --ignored`）驗證真機協定；typecheck／lint／149 vitest 全綠。

## 2026-07-19 — 修正 `/status` 不會自行載入 Usage

- 實機重現：`.claude.json` 官方 fetchedAt 停在 15:43、5h resetAt 已於 17:00 到期，18:39 transcript 仍有活動；UI 顯示等待更新是正確的新鮮度保護。
- Claude Code 2.1.215 的 `/status` 預設停在 Status 分頁，沒有發出 usage request；切到 Usage 後官方請求仍逾時超過 40 秒，確認當下 Provider 未回資料，而非 SQLite／React 漏更新。
- 隱藏 PTY 改回直接 `/usage`，但不再固定 4 秒取消；最多等待 45 秒，以 fetchedAt 真正前進判定成功。官方恢復時 `.claude.json` watcher 會立即收集並刷新 UI。

## 2026-07-19 — 自動執行 Claude `/status` 並確認快取更新

- 根因：使用者手動 `/status` 可更新額度，但 Adapter 送的是 `/usage`，且固定 4 秒後取消；新版 Claude Code 的官方請求尚未完成就被中止。
- macOS Adapter 改在隱藏 PTY 執行與使用者成功路徑相同的 `/status`，每 500ms 只檢查 `.claude.json` 的 `fetchedAtMs` 是否前進，成功即退出、最長等待 25 秒。
- 不擷取終端輸出，不讀 OAuth Token，不產生模型 turns／tokens；既有四分鐘嘗試節流保留，避免官方服務異常時反覆啟動 Claude。

## 2026-07-19 — UI 跟隨 Claude／Codex 活動檔案同步

- 根因：原本只有監聽 `~/.claude.json` 官方快取；實際對話活動先寫入 Claude transcript／Codex session，因此官方快取不動時 UI 最久需等五分鐘排程。
- 平台 Adapter 新增本機活動監聽，遞迴監聽 `~/.claude/projects` 與 `~/.codex/sessions`；500ms 檔案事件合併後再做 1 秒 provider 級 debounce，避免串流寫入反覆觸發。
- 活動後只收集變動的 Provider；有新 snapshot 時立即刷新 UI 與 tray。既有五分鐘排程保留作為檔案監聽不可用或漏接時的 fallback。

## 2026-07-19 — Claude 舊額度不再顯示成即時數字

- 實機確認 Claude Code 2.1.215 的 `/api/oauth/usage` 在隱藏 PTY 超過 30 秒仍未完成，且 `cachedUsageUtilization.fetchedAtMs` 停在 11:46；背景刷新不可視為成功。
- Rust reading 新增 quotaStale／quotaCapturedAt；transcript 活動比官方快取新超過 1 分鐘即標記，不修改或讀取 OAuth 憑證。
- 極簡列與一般小工具在 stale 時隱藏舊百分比，改顯示「等待官方更新」；資料來源頁同步顯示原因，Token／成本 metadata 繼續可用。
- stale 狀態以本次收集時間、confidence 0 寫入，讓它可靠取代過去錯誤較新的 0% 快照，但不參與耗盡預測；官方快取更新後再恢復正常百分比。

## 2026-07-19 — 區分 Claude 訂閱額度與 API 活動

- 實機狀態：官方快取 11:46 回傳 Session 0%，12:18 仍有 transcript 活動，而 Claude Code 2.1.215 啟動畫面顯示 `API Usage Billing`；兩者可同時成立。
- 修正 snapshot capturedAt：只採官方 `cachedUsageUtilization.fetchedAtMs`，不再用較新的 transcript timestamp 包裝舊百分比；transcript 仍只用於 Token／API 等值 metadata。
- compact 5h 標籤改為「Claude 5 小時（訂閱）」，降低使用者把 API 計費工作誤認為會消耗訂閱額度的風險。

## 2026-07-19 — 僅滿額時等待 resetAt

- 更正需求解讀：一般使用期間恢復「活動後同步＋30 分鐘保底」，盡可能維持 Claude 額度新鮮。
- 只有任一官方 limit 已達 99.5% 且 resetAt 仍在未來時，才暫停背景 `/usage` 並直接等到重置時間。
- resetAt 到點的確認優先於滿額等待；若官方尚未切週期，仍使用 4 分鐘 retry throttle。

## 2026-07-19 — Claude 僅在 resetAt 到點確認

- 移除 transcript 新活動觸發與每 30 分鐘 heartbeat；已有官方快取時，Adapter 平常完全不主動執行 Claude `/usage`。
- 前端仍每 30 秒比對已知 resetAt；到點才啟動官方 `/usage` 確認，若提供商尚未更新則以 4 分鐘 throttle 重試。
- 無 cachedUsageUtilization 的新安裝保留一次 bootstrap，避免永遠無法取得第一組 resetAt。

## 2026-07-19 — Claude resetAt 事件驅動確認

- 沿用前端每 30 秒 reset boundary 檢查：官方 `resetAt` 到點後立即呼叫 Monitor，觸發真正 `/usage` 確認新週期。
- Rust 刷新條件改為 reset 到點、transcript 活動比官方快取新超過 1 分鐘，或快取已超過 30 分鐘；平常不再每 4–6 分鐘啟動 Claude CLI。
- 4 分鐘只作為失敗與官方延遲的 retry throttle；到期仍未換週期時可有限重試，不會把預期時間當成已確認重置。

## 2026-07-19 — 修正 Claude 重置後額度不刷新

- 實機確認 Claude Code 2.1.214 的 `claude -p /usage` 只回傳 0-token session summary，不會更新 `cachedUsageUtilization`；舊的自動刷新是假成功。
- 官方快取曾停在 Session 100% 且 resetAt 已過；真正互動 `/usage` 後立即更新為 Session 0%，既有檔案監聽也成功寫入 SQLite。
- macOS 改在快取超過 4 分鐘時，於 Claude 已信任的專案目錄以隱藏 pseudo-terminal 執行真正 `/usage`，隨後自動退出；不讀 OAuth 憑證、不保存輸出、不消耗模型 Token。

## 2026-07-19 — 採用通用視窗圖示語彙

- 最小化改用 macOS／Windows 都熟悉的單一橫線 Minus；極簡使用 Panel 收合／展開，其他使用 Pin、Picture-in-Picture、Maximize。
- 圖示統一為 Lucide 風格的 24px viewBox、2px round stroke，不新增整套 icon library 依賴。

## 2026-07-19 — 視窗控制圖示語意重設計

- 四顆控制改為同一套 16px 線框 SVG：視窗進 Dock、卡片／橫條雙向切換、圖釘、浮窗／全螢幕展開。
- 每個圖示會依「按下後的結果」切換，並保留完整 tooltip、按鈕標籤與 aria 狀態；compact 模式只隱藏文字而保留清楚圖形。

## 2026-07-19 — 修正 compact 最小化與模式圖示

- 原生 `minimize_window` 在執行前明確啟用視窗 miniaturizable，修正 macOS 無邊框小工具按下收起沒有反應。
- 極簡／小工具切換不再使用難以辨識的減號，改為橫條 `▬` 與卡片 `▦`，並補充明確 tooltip。

## 2026-07-19 — 原生 Dock 最小化

- 視窗控制新增獨立「收起」按鈕，透過 Rust 原生命令執行與 macOS `⌘M` 相同的最小化。
- 最小化不覆寫小工具／極簡偏好，從 Dock 圖示恢復後維持原本模式。
- 四顆控制按鈕重新預留拖曳區寬度，避免按鈕與原生拖曳手勢互相遮擋。

## 2026-07-19 — 完整／極簡／小工具三段切換

- 極簡按鈕不再只在小工具模式出現；完整視窗可一鍵進入 strip，並同步保存 widget + strip 狀態。
- strip 狀態按同一顆按鈕切回 240×300 widget；右側箭頭仍負責直接恢復完整視窗，三種尺寸路徑明確。

## 2026-07-19 — v0.2 發布識別與資料遷移

- 版本升為 0.2.0；bundle identifier 從不建議的 `com.aiusagemonitor.app` 改為 `com.aiusagemonitor.desktop`。
- macOS setup 在新資料庫不存在時，一次性複製舊 app.db（含 WAL/SHM）、診斷與加密備援檔；不覆蓋已存在的新資料。
- Keychain service 刻意維持 `com.aiusagemonitor.app`，避免讀出再重寫 Secret；本機查無 Code Signing identity，因此簽章與 notarization 仍需 Apple Developer 憑證。

## 2026-07-19 — 資料來源同步可觀測性

- Data Sources 表格新增最近嘗試、成功資料年齡與下次同步欄位；最近錯誤仍只顯示已脫敏的 adapter 錯誤。
- 5 分鐘本機來源依 `lastRunAt` 顯示下次時間；尚未執行時明示 App 啟動即同步，未實作來源不顯示虛假排程。

## 2026-07-19 — 通知情境預覽

- NotificationDispatcher `sendTest` 支援可選 preview message，仍走相同 SecretStore、adapter 與 Discord payload，不寫入正式事件／delivery 去重紀錄。
- 通知頁提供五種預覽情境及每管道「傳送預覽」按鈕；原本測試按鈕改名「測試連線」，用途更清楚。

## 2026-07-19 — 小工具透明度偏好

- 新增 `widget.idleOpacity`（40–100，預設 72）與 `widget.hoverOpaque`（預設 true）。
- WindowControls 將設定同步為 CSS custom property 與 class，不需要重啟原生視窗；設定頁變更後立即套用。
- 原生 WebView 透明背景及完整模式實色恢復維持不變。

## 2026-07-19 — Codex Reset 票券通知

- MonitorService 從既有 `codex-local` snapshot metadata 安全解析 Full reset 張數與到期日，不接觸 Secret 或對話內容。
- Domain 通知評估使用 `summarizeResetCredits`：72 小時內到期或用量達 80% 時產生 `quota_expiring` 候選，文案包含建議及到期前 6 小時的最晚安全時間。
- event key 加入 `reset-credit` scope 並以票券到期日為 anchor，和一般額度到期事件互不衝突，且不會每次同步重複發送。

## 2026-07-19 — 即將用完通知門檻

- 原有 `thresholds.usageWarningRemainingPercent` 已被 MonitorService 使用，但入口只藏在 Settings；通知頁第 2 步現在直接顯示剩餘百分比輸入。
- 接受 1–50% 整數，無效值會恢復目前設定並提示；儲存後刷新 settings，下一次同步立即套用。
- 事件仍使用重置週期 anchor 去重，同一額度跨過門檻後每週期最多通知一次，不會每 5 分鐘重複發送。

## 2026-07-19 — 小工具拖曳與閒置透明度

- 原本僅有頂端 28px 隱形拖曳區，改為顯示六點與「拖曳」提示，compact 與 strip 模式皆可從左上區域移動視窗，右側控制按鈕維持可點擊。
- 實機發現透明 macOS WebView 未接受 HTML drag-region 提示；把手的 primary `mousedown` 現改呼叫 Rust `start_window_dragging`，直接啟動 OS 原生移動操作，HTML 屬性只保留為 fallback。
- Tauri 主視窗啟用透明背景；完整模式仍由頁面背景完整覆蓋，小工具模式使用帶 blur 的半透明底。
- 僅靠設定檔與 CSS 在實機仍可能留下不透明 WebView 底色；`set_window_mode` 現在於 widget／strip 設 `Color(0,0,0,0)`，完整模式恢復 `Color(246,247,249,255)`。
- 小工具閒置透明度為 72%，滑鼠移入或 `focus-within` 時恢復 100%，兼顧低干擾與操作可讀性。

## 2026-07-19 — Discord 空白通知修正

- Discord Webhook 已成功建立訊息但僅依賴 Embed 時，部分客戶端可能顯示只有發送者、沒有可見文字的空白外殼。
- Discord payload 現在同時包含 2,000 字元內的純文字 `content` 與原有 product Embed；純文字保證標題與內容可見，Embed 保留顏色、時間與產品資訊。
- Adapter 測試新增純文字 fallback 驗證，並確認 mentions 仍維持停用。

## 2026-07-17 — Claude 用量主動刷新

**Agent**: Codex
**範圍**: 修正 Claude 小工具必須等使用者手動 `/status`／`/usage` 才有進度。

- 逆向確認 Claude Code 2.1.212 的 `/usage` 走官方 `/api/oauth/usage`，並標記 `supportsNonInteractive`。
- 實機執行 `claude -p /usage --output-format json --no-session-persistence --tools ''`：取得官方 56%／37%／64%，結果為 0 turns、0 input/output/cache tokens、0 API duration、0 cost。
- Rust Claude Local Adapter 在讀取 `.claude.json` 前執行上述官方控制指令，讓 Claude 自己刷新快取；不讀取或保存 OAuth Token。
- 加入 process 內 4 分鐘節流，避免 `.claude.json` watcher 與 5 分鐘排程造成連續查詢；指令失敗時保留舊快取與誠實狀態。

## 2026-07-17 — Discord Webhook 產品化串接

**Agent**: Codex
**範圍**: 將既有 Discord 基礎 POST 補成使用者可一次完成的安全串接流程。

- 驗證限制為 Discord 官方網域與完整 `/api/webhooks/{id}/{token}` path，拒絕 lookalike domain 與頻道頁 URL。
- 訊息改為 Discord Embed，依 info/warning/critical 顯示顏色、標題、內容、footer 與 timestamp；停用 allowed mentions。
- Discord 表單新增「儲存並測試」；Webhook 先進 SecretStore，設定進 SQLite，隨即真實發送。失敗時顯示已脫敏錯誤並保持表單開啟。
- 新增 adapter 安全與 payload tests、UI 按鈕測試。

## 2026-07-17 — Reset 票券實際未顯示

**Agent**: Codex
**範圍**: 修正 UI 已完成但最新 Codex snapshot 一直保存 `resetAvailableCount: 0`。

- 實機 DB 證實票券 metadata 為 0；同時直接查詢官方 app-server 得到剩餘 3 張（7/27、8/1、8/13），確認是內部 app-server request 時序問題。
- Rust 改為讀到 initialize response 後才送 `account/rateLimits/read`，取得結果後主動結束 child process。
- 新增 `resetCreditsAvailable`，查詢失敗不再降級成「確定 0 張」。
- 極簡列直接顯示 `Codex·票N`；失敗顯示 `Codex·票?`。一般小工具也直接在 Codex 卡片標題顯示張數或同步失敗。
- 依後續回饋，極簡小工具新增固定底部票券列，直接顯示目前張數與全部到期日，不再要求 hover。

## 2026-07-17 — 重置後不再沿用舊週期用量

**Agent**: Codex
**範圍**: 修正供應商快取要等手動 `/status`／`/usage` 才更新時，舊百分比被誤當成新週期用量。

- 新增純 Domain `snapshotCycleState`，到達官方 `resetAt` 後將最新 snapshot 視為上一週期資料。
- Dashboard、一般小工具、極簡列與 tray 改顯示「等待新週期資料」，不顯示舊百分比，也不假造 0%。
- UI 每 30 秒檢查 reset 邊界，同一 limit + resetAt 主動刷新一次；固定排程仍負責後續補抓。
- Codex app-server 可直接取得新週期；Claude 若本機快取未更新則誠實保持待確認，直到 Claude 寫入新資料。

## 2026-07-17 — Codex Full reset 到期資訊

**Agent**: Codex
**範圍**: 對齊 Codex `/usage` 的 Usage limit resets，而非週額度自動重置。

- `read_codex_local_usage` 優先啟動使用者已登入的 Codex app-server，呼叫唯讀 `account/rateLimits/read`；失敗時仍回退 session JSONL 額度資料。
- 保存 `availableCount` 與 available credits 的標題、到期 Unix 時間，不保存 opaque credit ID，也不提供自動 consume。
- 一般小工具顯示「Full reset N 張／最近 M/D 到期」；極簡 Codex 單列 hover 顯示張數與全部到期日，最近 72 小時到期時警示。
- 新增純 Domain `summarizeResetCredits` 與測試。
- 驗收：typecheck、lint、140 tests、cargo check、Tauri `.app` + `.dmg` build 全通過。
- 後續補強：一般小工具列出全部 reset 票券；純 Domain 依到期順序、目前用量與官方自動 resetAt 產生「現在用／等 80%／先等官方重置」建議，並顯示到期前 6 小時的最晚安全時間。

## 2026-07-17 — macOS 選單列產品圖示

**Agent**: Codex
**範圍**: 修正選單列圖示為白色方塊，建立可辨識的產品符號。

- 根因是將具有不透明紫色背景的 Dock icon 設為 macOS template icon，系統會把整塊 alpha mask 轉為單色。
- 新增透明背景的 18pt@2x 單色「用量圓環＋指針」tray icon，Rust tray 改載入專用 PNG；Dock／App bundle 繼續使用彩色 icon。
- 保留 `icon_as_template(true)`，讓 macOS 自動因應亮色／暗色選單列切換黑白。

## 2026-07-17 — 未使用額度即將到期提醒

**Agent**: Codex
**範圍**: 讓使用者知道哪筆 Claude／Codex 額度即將重置，避免剩餘額度未使用就失效。

- 新增純 Domain `computeQuotaExpiry`：警示窗為週期的 20%，限制在 1–24 小時；剩餘至少 20% 才視為值得提醒。
- 新增 `quota_expiring` 通知事件，依 provider resetAt 去重，每個週期只通知一次；文案包含剩餘比例、確切重置時間與平均每小時可用比例。
- 通知設定可針對每筆額度獨立開關「額度即將到期」，預設開啟。
- 極簡列接近到期時顯示橘色警示與 `⚠`；hover 補充剩餘比例及建議使用速度。

## 2026-07-17 — Claude 快取改為檔案事件監聽

**Agent**: Codex
**範圍**: 以桌面 App 常見的事件驅動方式取代每 2 秒檔案 metadata 輪詢。

- 新增 `UsageCacheWatcher` platform port；Tauri adapter 使用 `tauri-plugin-fs` watch feature，瀏覽器／測試使用 no-op adapter。
- 監聽 `$HOME` 非遞迴事件並只接受 `.claude.json`，可涵蓋直接寫入及暫存檔 rename 覆蓋；300ms debounce 合併同一次儲存的多個 OS 事件。
- 前端收到事件才執行 Claude collector 與 store refresh；卸載時 unwatch。既有每 5 分鐘 scheduler 仍作為漏事件補抓。
- capability 僅開放 home 頂層 scope 與 watch／unwatch，不開放遞迴家目錄存取。

## 2026-07-17 — Claude `/usage` 即時刷新

**Agent**: Codex
**範圍**: 修正終端額度已更新但極簡小工具仍短暫顯示上一筆的時間差。

- 實查確認 `.claude.json` 與 SQLite 已是 98%／32%／54%，截圖中的 57%／28%／46% 是 30 秒輪詢尚未到期的 UI 舊狀態。
- 新增原生 `claude_usage_cache_version`，只回傳 `.claude.json` 修改時間，不解析內容。
- UI 每 2 秒檢查版本；只有修改時間變化才跑 Claude collector、transcript 聚合、SQLite insert 與 store refresh，避免高頻完整掃描。

## 2026-07-17 — 極簡尺寸與顯示內容設定

**Agent**: Codex
**範圍**: 將反覆調整的極簡視窗尺寸及右側資訊改為使用者偏好。

- `app_settings` 新增 `widget.stripSize` 與 `widget.stripRightInfo`，預設為中尺寸及同時顯示重置／預估用完。
- 設定頁提供小 240×134、中 280×150、大 330×172，以及重置、預估用完、兩者、API 等值金額四種右側模式。
- 尺寸變更會更新 CSS typography 並呼叫原生視窗命令立即重設尺寸、重新吸附右上；重新啟動後仍保留。
- 金額模式只顯示有可靠定價 metadata 的數值，否則顯示 `--`。

## 2026-07-17 — 極簡模式整體放大

**Agent**: Codex
**範圍**: 依實機閱讀距離放大極簡模式，但維持小工具定位。

- 視窗由 240×134 logical points 調為 280×150，最小尺寸同步提高。
- Provider 標籤、百分比、重置／耗盡倒數、hover 成本摘要與進度條同步放大，四筆額度仍能完整顯示。

## 2026-07-17 — 極簡列文字可讀性

**Agent**: Codex
**範圍**: 改善 240px 極簡小工具右側資訊的辨識度。

- 百分比由 8px 提升為 9px 並加重，重置／用完倒數由 6.5px 提升為 7.25px。
- 分別補上亮色與暗色模式的高對比文字色，維持既有小工具尺寸與單行排版。

## 2026-07-17 — 極簡定位與 Claude hover 舊快照升級

**Agent**: Codex
**範圍**: 修正小工具右緣位置，並排除 Claude hover 沒有成本資料的根因。

- 極簡／小工具模式改為水平 0 邊距，貼齊目前螢幕右緣；垂直仍保留 12px，避免貼住選單列。
- 確認既有 SQLite 最新 Claude 快照仍為 `claude-code-usage-cache`，原 collector 因官方 `capturedAt` 相同而跳過新 metadata。
- collector 現在依完整快照內容去重；遇到同時間但 metadata 已增強時，以 +1ms 寫入一次，確保 latest query 選到 `claude-local-24h`，後續相同內容不會重複寫入。

## 2026-07-17 — Phase 2 本機額度整合與小工具化

**Agent**: Codex
**範圍**: 將 Claude Code／Codex 真實本機額度接入，並把桌面 App 改為可日常常駐的小工具。

### 做了什麼

1. Codex：解析 `~/.codex/sessions` 的官方 5h／Weekly rate limits，彙總 active cycle token 並估算 API 等值成本。
2. Claude Code：解析 `~/.claude.json` 的 `cachedUsageUtilization`，匯入 Session、Weekly all-models 與 scoped-model 額度。
3. 本機 collector 每 5 分鐘執行，single-flight 防重入；資料來源健康狀態持久化 last run／success／error。
4. 新增完整、小工具、極簡多來源三種視窗模式，支援右上角吸附與置頂。
5. Data Sources 新增立即同步與來源診斷，不再把已完成的 Local integrations 顯示為 Coming Later。

### 已知限制

- Claude Code 額度取自官方 `/usage` 本機快取；App 不接觸 OAuth token。若從未建立快取，需先在 Claude Code 執行 `/usage`。
- Phase 2 尚未把 transcript 自動轉為 UsageActivity，也未提供 context window `/compact` 提醒。

### 視窗互動修正

- 控制列不再兼任 Tauri drag region，改用獨立頂部拖曳區，避免拖曳事件吞掉按鈕點擊。
- 移除 widget 的失焦即隱藏行為，避免 macOS `show()`／`set_focus()` 間的短暫失焦讓視窗無法操作。
- 極簡列高度改為 112px，完整容納三筆額度；Claude 額度標籤區分 5h、Weekly 與 scoped model，避免底列和文字被裁切。
- 極簡列改用自解釋中文標籤：Claude 5 小時、Claude 全模型本週、Fable 本週。
- 一般視窗從 widget mode 展開時會在恢復尺寸後呼叫原生 `center()`，不再沿用右上角座標而卡在螢幕右側。
- Widget／strip mode 透過 Tauri `set_visible_on_all_workspaces(true)` 加入 macOS 所有 Spaces；展開一般視窗時設回 false。

### Dashboard 續航與安全節奏

- 新增純 Domain `computeUsageRunway` 與測試，依剩餘比例、重置時間及 burn rate 計算每日安全預算、目前每日速度與 pace ratio。
- 主畫面以「用量續航／使用節奏」取代固定出現的「相似任務還能做幾次」。
- 相似任務估算保留為進階區塊，只有任一類型具備至少 3 筆有效活動時才顯示，避免假精準與空卡。
- 所有續航計算完全在本機執行，不呼叫 Claude、Codex 或其他 AI API。

### Claude 額度即時一致性

- 問題根因：主排程每 5 分鐘才讀 `~/.claude.json`，剛執行 Claude Code `/usage` 時小工具會暫時顯示舊快取快照。
- 新增每 30 秒的 Claude-only 輕量本機輪詢；只讀 JSON 檔，內容變更才寫 snapshot／刷新 UI，不呼叫 API、不消耗額度。
- 極簡列由 3 筆提高為 4 筆並固定優先順序：Claude 5h、Claude 全模型本週、Claude scoped model 本週、Codex。
- 發現早期版本曾為三種 Claude 額度各建立兩個相同 `reset_rule` 的 limits；collector 現在以最新快照所在 limit 為 canonical，將其餘重複項停用但不刪除歷史資料。

### 穩定性收斂

- 移除 widget mode 每 1.5 秒呼叫 `snap_widget_to_top_right` 的前端 timer；原生 `set_widget_mode`／`set_strip_mode` 已會在切換時定位，不需每小時 2,400 次重複呼叫。
- Claude 30 秒本機輪詢改為 content-aware：只有來源 `capturedAt` 或錯誤內容改變時才更新 `data_source_status`，未變時不寫 SQLite。
- UI 仍只在新增 snapshot 時 refresh，因此靜止狀態不會每 30 秒重載所有 repositories。

### 小螢幕完整視窗佈局

- 一般視窗不再固定使用 1180×820；依目前 monitor logical points 設為 86%×82%，範圍 720–1100 × 520–760，再呼叫原生 `center()`，避免 Retina 螢幕右側被裁切。
- 完整模式的置頂／小工具控制列由 `top: 34px` 移至 `top: 5px` 的頂部保留區；widget／strip mode 仍保有各自位置，避免覆蓋頁面 header action。

### 極簡列重置倒數

- 每筆額度右側由單純百分比改為「百分比 · 距離重置」，例如 `33% · 4時30分`、`25% · 1天2時`。
- 新增 UI formatter `formatCompactCountdown`；倒數使用列元件內的 `useNow()` 更新，不觸發資料同步或 SQLite 寫入。

## 2026-07-17 — 穩定性基礎：視窗狀態、資料去重、診斷匯出

**範圍**：收斂容易卡住或顯示不一致的底層狀態，並建立不碰使用者內容的問題回報能力。

### 做了什麼

1. 將一般／小工具／極簡細條的尺寸、位置、視窗裝飾、置頂與所有 Spaces 設定合併為單一 Tauri `set_window_mode` 命令；切回一般模式會依目前螢幕自適應並置中。
2. 新增 migration v2：同一 plan + reset rule 的重複額度合併至最早的 canonical row，快照、活動、reset 與通知歷史全部改指 canonical，再建立 partial unique index 防止復發。
3. 新增 `DiagnosticLogger` platform port 與 Tauri／InMemory adapters。本機 JSONL 上限 512 KiB，輪替後保留約 256 KiB。
4. 設定頁新增「匯出診斷資料」；內容只含版本、平台、視窗模式與同步事件，不含資料庫用量、提示詞、回覆、Token 數、Webhook URL、API key 或其他 Secret。
5. migration 已以含四種歷史關聯的重複 fixture 實際演練，合併後四種關聯皆保留。

### 後續注意

- 診斷 detail 必須維持低基數、非敏感的狀態摘要；不可直接寫入 exception payload、檔案內容或 Provider 回應。
- collector 內的 runtime duplicate detection 保留作為舊資料與異常狀況的 defense-in-depth；正常情況由資料庫 unique index 保證。

### 極簡列耗盡預測

- 每個極簡額度列直接使用既有 Domain `computeForecast`，不呼叫任何 AI 或外部 API。
- 預測可信度至少 35% 且存在未來耗盡時間時，右側顯示「耗 + 倒數」；否則保留「重 + 倒數」。
- hover 原生提示同時顯示已使用比例、完整預估耗盡日期、額度重置日期與可信度；資料不足會明確標示，不製造假精準。

### macOS 視窗座標與小工具捲動

- 根因：`set_size()` 後立即讀取 `outer_size()`，macOS 偶爾仍回傳上一模式的尺寸，造成 compact 右上角及 full 置中都沿用錯誤座標。
- 原生層改用已知的目標 logical width／height 乘 monitor scale，直接計算 physical top-right／center 座標；current monitor 不存在時回退 primary monitor。
- 小工具的 provider list 設為可收縮的 flex scrolling region，內容多於高度時可滾動，header／footer 不跟著消失。
- `codexMeta` 現在驗證三種 token 欄位為 finite，且只為 Codex provider 解析，避免 Claude note 產生 `NaNK tokens`。

### 通知設定資訊架構與 Discord 串接

- 通知頁由技術性 channel matrix 改成三段式：① 哪些額度需要通知（直接更新 `UsageLimit.notifyEnabled`）② 什麼事件要通知（可一次套用所有管道）③ 通知傳到哪裡。
- 每個管道仍可展開「進階」獨立調整事件偏好；既有 dispatcher、去重、靜音時段與最小間隔行為不變。
- 提供桌面通知快速建立與 Discord 快速連接。Discord modal 說明「編輯頻道 → 整合 → Webhook → 複製 URL → 測試」流程。
- Discord Webhook URL 仍只經 `SecretStore` 存入 Keychain／安全備援檔；SQLite、匯出資料與診斷檔都不包含 URL。
- UI 測試新增通知目標持久化與 Discord 引導，總測試數為 125。

### 小工具 Token／美元 hover

- Codex 小工具卡片與極簡列的 native tooltip 顯示目前週期總 Token、其中快取輸入 Token、以及已知模型依 API 價格換算的美元等值。
- 文案固定標示「API 等值成本，不是訂閱實際扣款」；未知模型或 Claude 官方快取未提供 token metadata 時顯示資料不足，不做假估算。

### 每個額度獨立通知事件

- 通知目標卡可各自展開六種事件，因此 Claude 5h、Claude 全模型週、Claude scoped model 週與 Codex 週額度不再共用同一組事件選擇。
- 細項存於 `notifications.limitEventPreferences` JSON setting，由純 Domain parser／setter 處理；malformed／缺少資料時安全回退為預設啟用。
- MonitorService 產生候選事件後依 limit ID + event type 過濾；重置偵測與歷史記錄仍正常執行，只有使用者關閉的通知不派送。
- 新增 Domain、service、UI 覆蓋，總計 128 tests／14 files。

### 重置文案與部分成本估算

- UI 的 `reset_confirmed` 改稱「臨時／提前重置」，通知標題使用「可能」措辭；資料庫 event type 與 detection method 不變。
- 實際 Codex snapshot 同時包含已定價的 `gpt-5.6-sol` 與無公開價格的 `codex-auto-review`。成本計算改為回傳已定價模型小計及未定價模型清單，不再因一個未知模型放棄整筆估算。
- 舊 snapshot 若只有 `models` 而沒有 `apiEquivalentUsd`，UI 會透過純 Domain cost estimator 即時計算，因此不必等下一個用量快照才看到金額。
- 小工具卡片直接顯示 `API 等值 ≥ $...`，hover 顯示 token、快取 token、未定價模型與非實際扣款聲明。

### macOS 重複 tray 圖示

- 根因不是重複程序：`tauri.conf.json.app.trayIcon` 會自動建立 tray，`src-tauri/src/lib.rs` setup 又以相同 `main-tray` ID 建立帶選單的 tray。
- 移除 config 靜態宣告，保留 Rust tray，因為後者負責 Open／Check Now／Pause／Notifications／Quit 與點擊顯示小工具等行為。

### 極簡列自繪成本 tooltip

- Tauri 無邊框 WebView 中 HTML `title` 沒有可靠顯示，改為 `.strip-hover` 自繪浮層。
- 初版曾以整個極簡視窗作為浮層；依使用者回饋已由下一項的 inline hover 取代。
- 後續依使用者回饋改為 inline hover：正常狀態每列同時顯示 `重置 … · 用完 …`；hover Codex 時只以同高度成本摘要替換 Codex 自己的 label + meter，其他列完全不被覆蓋。

### Claude transcript 成本 hover

- Rust `read_claude_local_usage` 同時掃描近 24 小時有修改的 `~/.claude/projects/**/*.jsonl`，只抽取 timestamp、sessionId、message.id/model/usage，不讀取或保存對話內容。
- 同一 Claude assistant response 可能以不同 UUID 重複寫入，聚合以 `message.id`（fallback requestId）去重，避免成本被乘上 2–3 倍。
- 分開累加 input、output、cache creation、cache read；Fable 5 與 Opus 4.8 經純 Domain 價格函式估算 API 等值，未知模型保留 Token 並標示未定價。
- 三種 Claude 額度共用同一份近 24 小時成本摘要；hover 各自那一列時顯示 Claude 合計及 Fable／Opus 分項，不覆蓋其他列。
- 新增 domain／metadata tests，總計 131 tests／15 files。

## 2026-07-16 — 初始交付：Phase 0 + 1 + Phase 1.5 完整 MVP

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
