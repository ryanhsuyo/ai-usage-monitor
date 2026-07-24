# Handoff Log

## 2026-07-23 — 成本統計切頁卡住（彩虹球）：重量級指令改為非同步

- 使用者回報切到「成本統計」會轉圈／卡住很久，且這類停頓「蠻常發生」。彩虹球＝webview 主執行緒被卡。
- 根因：`read_claude_usage_daily`／`read_codex_usage_daily`／`read_claude_local_usage`／`read_codex_local_usage` 四個 `#[tauri::command]` 都是**同步 `pub fn`**。Tauri v2 的同步指令在主執行緒執行——解析全部 transcript 期間 UI 完全凍結。
- 量化：Claude 280MB／191 檔 = 855ms；Codex **1.6GB**／85 檔 = 2.16s。兩者由前端並行 invoke，但主執行緒序列化執行 ≈ 3 秒凍結，且只會隨紀錄增長。後兩個指令更在每次檔案監聽觸發的收集時執行（一用 Codex 就卡一下），即「蠻常發生」的來源。
- 修正：四個指令改 `pub async fn` + `tauri::async_runtime::spawn_blocking(inner)`，重活移到 blocking pool，主執行緒與 async runtime 皆保持回應。同步邏輯保留為 `_inner` 私有函式（live 測試改呼叫 `_inner`）。前端無需改動，`invoke` 本就 async，React 的 `loading` 轉圈會正常動畫而非卡死彩虹球。
- 15 Rust 測試綠；release build 通過。
- **可選後續（未做）**：`UsageStats` 每次切入都重新抓取（元件卸載後 `rows` 歸零），故每次仍有約 3 秒轉圈。若要再順，可把結果快取到 store／模組層做 stale-while-revalidate（先顯示上次資料、背景刷新）。

## 2026-07-22 — codex-auto-review 由「未定價」改為 gpt-5 完整層級定價

- 使用者比對成本統計頁與 ccusage：`codex-auto-review` 顯示「未定價」，但明明有大量用量。
- 查證：`codex-auto-review` 是 Codex session JSONL 裡 `turn_context` 事件的 `model` 值（自動審查代理），出現 1266 次，但 payload 無 `base_model`／`model_slug`，是個沒有公開 API 價的內部標籤，故 `codexPrice` 回 undefined → 未定價。
- 它其實跑在完整 gpt-5 模型上。以 Python 複刻 Rust 歸屬邏輯，codex-auto-review 的 token 用 gpt-5.5 費率 = **$28.01**，正好等於我們 Codex 總額（$693.54）與 ccusage（$721.55）的差額——ccusage 就是把這些 token 按完整層級定價。修正後三模型合計 $721.55，與 ccusage 分毫不差。
- 修正：`codexCost.ts` 加 `MODEL_ALIASES`，`codex-auto-review → gpt-5.5`（gpt-5.5／gpt-5.6-sol 費率相同，皆 5／0.5／30）。新增 `codexCost.test.ts` 5 例。
- **附帶發現（未修）**：`session_usage`（local_usage.rs:308）的 model 會被任何帶 `/payload/model` 的事件更新，且只保留該 session 最後一筆 `total_token_usage`（累計）——所以一個 session 若最後動作是 auto-review，整個 session 的累計 token 都記到 codex-auto-review 名下。因 codex-auto-review 與 gpt-5.5 費率相同，**總額不受影響**（ccusage 到分吻合可證），僅逐模型的列分配略有偏移。若日後要精準拆分需改為逐 delta 歸屬。

## 2026-07-22 — 啟動變慢／偶爾卡 5 分鐘：先畫再抓 + 補上 Codex 逾時

- 使用者回報打開要載入很久，多半 30 秒~1 分鐘，這次到 5 分鐘。5 分鐘不是「慢」是「卡住」。
- **兩個獨立成因**：
  1. **UI 被擋在即時抓取後面**（`useBootstrap`，App.tsx）。原順序是 `collectLocalUsage()` → `refresh()` → … → `setReady(true)`。第一步 spawn Claude CLI（實測 1.8–2.8s）與 Codex app-server，但畫面要的資料 `refresh()` 從 SQLite 一讀就有——即時抓取對首次渲染完全非必要。改為先 `refresh()` 畫出已存資料、回訪者（已有 limits）立刻 `setReady(true)`，即時抓取移到背景，抓完再 `refresh()` 一次更新數字。首次啟動（尚無 limits）維持等待，避免 onboarding 畫面閃現。
  2. **Codex 抓取無逾時**（`read_codex_app_server`，local_usage.rs）。Claude 那條用 reader thread + `recv_timeout(20s)`，Codex 卻是同步阻塞 `read_line` 迴圈。app-server 成功啟動但不回應（ChatGPT app 登出／等網路）時 `read_line` 永遠等待，且其後的 `child.kill()` 永遠到不了——就是那 30 秒~5 分鐘的間歇卡頓。改成同一套 thread + `recv_timeout(20s)` 模式包住整段 initialize → rateLimits 交握；逾時即 kill child，關閉 pipe 讓 thread 收尾。
- 合起來：即時抓取最壞 20 秒且在背景，回訪者的視窗幾乎立即顯示。
- 驗證：Claude CLI 逐次計時 1.76／2.79s；瀏覽器 1.5s 內已離開「載入中…」顯示內容；214 TS + 15 Rust 全綠；`cargo build` 通過。
- **未加**：Codex 逾時的專屬單元測試——`read_codex_app_server` 直接 spawn 真實 `codex` 子行程（與既有 `#[ignore]` live 測試同性質），要測逾時需把 reader 抽成可注入，暫不為此重構。

## 2026-07-22 — 修正成本統計與 ccusage 的落差

- 實機發現 7 月有 81 組同 message.id、usage 內容不同的副本；舊邏輯 first-seen wins 會依 filesystem 順序選到 0／partial 副本，至少少算 13,343 output tokens。
- Rust 全歷史聚合改為同一 message.id 各 token 欄取最大完整值，再只計一則訊息；新增 partial→complete／TTL 異常測試。實機重算 7 月 output 由 11,314,208 修正為 11,347,854。
- TTL 分項 5m／1h 防禦性限制在 cache-creation 總數內，避免異常副本造成顯示 token 與計價 token 不一致；Domain 補測試。
- 成本統計頁不再只在 mount 時讀一次：Claude transcript 事件會觸發重掃，並新增擷取時間與重新整理按鈕；掃描 single-flight，避免大型歷史重疊執行。

## 2026-07-22 — 極簡列標籤縮短、票券區拆行，橫條高度改為依列數計算

- 使用者要求：額度重置時刻與 reset 票券到期日不要擠在同一行（是兩個無關的時間點，並排會讀成一段區間），標籤縮短為 `Claude 5HR sub`／`Claude weekly`／`Fable weekly`。
- `compactLimitLabel` 依指定改寫；`strip-reset-tickets` 由 flex 單行改為 grid 三行（票數／重置時刻／到期日）。
- **順帶抓到既有缺陷**：橫條視窗 `set_resizable(false)`，高度是 Rust 端寫死的三檔常數，不看實際列數。`.strip-summary` 是 `height:100vh` + `justify-content:center` + `overflow:hidden`——溢出時上下對稱裁掉，沒有捲軸也不會反映在 `scrollHeight`，**靜默裁切**。實測 4 條額度時內容 138.8pt、可用 112pt，舊版單行票券就已經溢出約 3pt；改成三行會溢出 26.8pt。
- 修正：`strip_height(size, rows, tickets)` 依列數計算，度量值（padding／gap／列高／票券區高）在瀏覽器實測三個尺寸檔後寫進 Rust，另加 4pt 緩衝（度量只在一台機器上做，字型渲染略高就會再次靜默裁切）。列數經 IPC 傳入故 clamp 1–8。
- `widgetLimits` 的推導抽成 `selectWidgetLimits(store)`，由 `App` 與 `WindowControls` 共用——視窗是照這個數字開的，兩邊算法必須一致。
- 驗證：Rust 新增 3 個 `strip_layout_tests`（涵蓋實測值、各檔隨內容增長、異常列數 clamp）；瀏覽器實測 280×181 下內容 138.8／可用 143，餘裕 4.2pt，四個標籤皆未被 ellipsis 截斷。12 Rust + 213 TS 全綠。
- **副作用**：使用者的橫條(4 條額度 + Codex 票券)會從 150pt 變成 181pt。

### 同日修正：額度重置時刻歸位到 Codex 那一列

- 使用者問「重置 7/29 01:23 是重置什麼」——那是 **Codex 每週額度**自己的重置（`reset_at = 2026-07-28T17:23:36Z`），不是票券的。放在標題為 `Reset 3 張` 的區塊底下，會被讀成票券的屬性。分類本來就錯，加字說明只是掩蓋。
- 移到 Codex 那一列右側，與倒數並排：`重置 4d0h · 7/29 01:23`。判斷要不要用票，靠的正是「票的到期日」對上「額度自己回滿的日期」，而 `4d0h` 沒辦法跟 `7/28` 直接比對。只有持有票券的列會加上時刻。
- 列標籤的 `·票N` 拿掉：下方區塊已經以 `Reset 3 張` 開頭，同一個數字沒必要出現兩次。
- 票券區回到兩行，`tickets` 度量重量為 24／28／31（small／medium／large），高度變 170pt。
- 版面驗證涵蓋最長的情況（`stripRightInfo` 預設同時顯示重置與用完）：medium 標籤 33.8 + 狀態 176.8 / 可用 258；small 29.4 + 153.3 / 可用 222，四個標籤皆未 ellipsis，無水平溢出。

## 2026-07-22 — 「已用完」獨立成一則通知，預設事件收斂為四種

- 使用者列出他預期的通知集合：正常重置一次、剩 10% 一次、異常重置一次、用完一次；並回報 Fable 週額度到 100% 卻沒收到通知。
- **實查**：`usage_snapshots` 顯示 Fable 於 05:09 到 100%，同時刻 `scheduler_runs` 記錄 `success / 4 limits, 0 sent`。原因不是門檻也不是開關，是去重：7/20 08:34 已對同一週期發過 `claude:weekly:lim-8dae:usage_warning:2026-07-25T12:00`，而「剩 10%」與「已用完」共用這把 key，標題只是依剩餘量在兩種文案間切換。先發的那則吃掉了整個週期，額度填滿的過程完全無聲。
- 修正：拆成 `usage_warning`（剩餘 ≤ 門檻）與新的 `usage_exhausted`（≤ `EXHAUSTED_REMAINING_PERCENT`），互斥且各自一把 key，同週期各發一次。測試除了斷言文案，另外釘住「兩者 eventKey 不同」——這正是原本的失效點。
- **預設事件收斂**：依使用者選擇保留票券提醒，`reset_expected` 與 `exhaustion_forecast` 改為預設關閉（仍可逐額度開啟）。兩者都對「之後會自行解決」的狀態發話，出現頻率遠高於實際有用的次數。
- `DEFAULT_CHANNEL_EVENT_PREFERENCES` 更名為 `DEFAULT_EVENT_PREFERENCES`，並讓 `isLimitNotificationEventEnabled` 也回退到它。原本每個額度硬編碼「未設定即開啟」，導致同一個事件在管道層預設關、在額度層預設開。
- **migration 0003**：既有管道的 `event_preferences` 由舊版 onboarding 寫死了全部事件為 `true`，只改預設值碰不到它們。以 `json_remove` 只拔掉這兩個鍵，其餘偏好原封不動。已用使用者資料庫的副本乾跑驗證。
- 驗證：213 TS + 9 Rust 全綠；另在 dev server 實際讀出通知設定頁的 40 個開關狀態，四種（含票券）為 on、其餘為 off，逐額度與逐管道一致。
- **未做**：`reset_expected` 的文案「請開啟 App 更新或同步資料」在登入過期時是錯的（真因是 token 失效）。該事件現已預設關閉，故先不處理；若要修，需把 `auth_needs_login` 從 collector 一路帶進 `NotificationContext`。

## 2026-07-21 — 登入過期時明確提示重新登入，不再只顯示「等待官方更新」

- 實查使用者「Claude 三條又抓不到」：官方資料停在 8.5 小時前。直接以 `get_usage` 控制協定測試，回應 `subscription_type: null`、`rate_limits_available: false`——Claude Code 的 OAuth token（Keychain 中 `expiresAt: 0`）已失效，CLI 直接短路（505ms 返回、未發網路請求）。
- 過程更正一則誤判：先以為是我跑在 Claude Code 工作階段內、`ANTHROPIC_BASE_URL` 等環境變數污染子行程；改用 `env -i` 完全乾淨環境重測結果相同，排除此因，確認是憑證本身。
- 問題：這個訊號原本被 `fetch_claude_usage_via_cli` 的 `?` 默默丟棄，與「暫時抓不到」混為一談，都顯示「等待官方更新」。使用者只能查資料庫才知道要重新登入。
- 修正（Rust）：`fetch_claude_usage_via_cli` 改回傳 `ClaudeUsageFetch` enum（`Limits`／`NeedsLogin`／`Unavailable`）；`classify_usage_response` 以 `rate_limits_available: false` 判定 `NeedsLogin`（成功回應但無訂閱），與逾時／找不到 binary（`Unavailable`）明確區分。全域狀態記 `needs_login`，成功即清除；reading 新增 `auth_needs_login`。
- 修正（UI）：`authNeedsLogin` 經 metadata 傳到前端。極簡列顯示「需重新登入 Claude」、小工具徽章顯示「需登入」、tooltip 說明「在終端機執行 claude 後輸入 /login，完成後最多 5 分鐘自動恢復」；資料來源頁 lastError 同步。
- **Codex 不同機制**：Codex 走 app-server `account/rateLimits/read`，token 由 Codex/ChatGPT app 管理，不受 Claude CLI 憑證影響；其登出表現為 app-server 連線失敗（另一條錯誤路徑），不套用此旗標。
- 測試：Rust 新增 `classify_usage_response` 三情境（NeedsLogin／Limits／Unavailable），並更新 live 測試改用 enum。9 Rust + 212 TS 全綠。

## 2026-07-21 — 時長與時刻改用互不相似的格式

- 依使用者指定：時長用 `18h32m`，時刻用 `12:32`。兩者字形完全不同，不需要讀到句尾才能分辨（上一版的「後」字後綴仍要讀完整串）。
- `formatCompactCountdown`：`4d0h`／`18h32m`／`45m`。比原本的中文寫法更短，緩解極簡列的寬度壓力。
- 時刻全面改 24 小時制（`hourCycle: "h23"`）：`7/25（週六） 20:00`，比 `下午08:00` 更短也更不易誤讀。
- **順手消除格式漂移的根源**：`App.tsx` 內原本有四處各自寫的 `Intl.DateTimeFormat` 設定，導致同一個 App 出現不同時間格式。改為統一呼叫 domain 的 `formatLocalDateTime`（含星期）與新增的 `formatLocalDateTimeShort`（無星期，給像素受限處）。剩餘的純日期（`7/27`）無歧義，維持原樣。
- 測試斷言改為 `18h32m`，並把反向斷言擴大為「不得產生 `\d+[時:]\d+` 這種形狀」。212 tests 全綠。

## 2026-07-21 — 倒數不再讀起來像時刻

- 使用者回報「分不出來是多久還是幾點幾分」。`formatCompactCountdown` 產生的 `18時32分` **就是中文寫 18:32 的方式**；而同一個小工具現在還會顯示真正的重置時刻（`重置 7/26 上午12:02`），兩者外觀幾乎相同。
- 倒數一律加上「後」：`4天0時後`、`18時32分後`、`45分後`。評估過 `18小時32分後`（更明確但多 4 字元）與 `18h32m`（最短但中英混排），選最小幅度且維持中文的寫法。
- 版面安全性以 CSS 確認而非目測：右側 `.strip-status` 為 `flex: none`（不被壓縮）、左側 `.strip-label strong` 有 `text-overflow: ellipsis`，故多出的字只會讓過長標籤省略，時間永遠完整。
- `format.ts` 原本沒有任何測試，補上 4 個，含反向斷言「不得產生 `^\d+時\d+分$` 這種可被讀成時刻的字串」。212 tests 全綠。

## 2026-07-21 — 不再顯示重置之後才會發生的「用完」時間

- 使用者回報：Claude 5 小時額度顯示「0% · 重置 -- · 用完 18時32分」。5 小時的視窗不可能 18 小時後才用完——那時它早已重置三輪。
- 查資料：11:56 那筆快照確實是 0%，但官方沒回傳 `resets_at`（故顯示「重置 --」）；12:02 已抓到新週期 7%／17:00 重置，顯示會自行修正。真正的缺陷是那個「用完」。
- 根因：`computeForecast` 早就算出 `willExhaustBeforeReset`，但極簡列**完全沒用它**，只看信心值就照顯示耗盡時間。估算落在重置之後時，那個數字描述的是不可能發生的事。
- 依專案規範把判斷抽成 domain 純函式 `shouldShowExhaustion(forecast, minConfidence)`：估算落在重置後即不顯示；無法比較（沒有重置時間）時仍顯示，只是不宣稱與重置的關係；低信心與無估算照舊隱藏。
- tooltip 的「預估耗盡」相應區分「本週期用不完」與「資料不足」，不再把前者誤報為後者。Dashboard 旁邊已有「會在重置前用完？」欄位，維持原樣。
- 故障注入驗證：移除該判斷後測試立即失敗。208 tests 全綠。

## 2026-07-21 — 極簡列底部票券行補上建議與重置時刻

- 使用者回報：Codex 已 100%、有 3 張票，底部卻只列到期日不給建議；Codex 那條也只有「重置 4天4時」的倒數，看不到幾號幾點。
- 根因：底部票券行呼叫 `summarizeResetCredits` 時**只傳了張數與到期清單**，沒有傳 `usedPercent`／`automaticResetAt`／`burnRatePerHour`，於是用量一律當 0%，`use_now` 永遠不可能成立——不是文案問題，是根本沒拿到判斷所需的資料。
- 修正：改為傳入該額度最新快照的用量與重置時間，並就地計算 forecast 取得 `burnRate24h`（與 hover 浮層同一套資料）。
- 底部行改為兩段：`Reset 3 張 · 建議用 1 張` ／ `重置 7/26 上午12:02 · 到期 7/27、8/1、8/13`。
- 以資料庫中的真實 Codex 快照（100%、resetAt 2026-07-25T16:02:15Z、3 張票）回放驗證輸出。204 tests 全綠。

## 2026-07-21 — 極簡列補上重置時刻，票券建議完全不提張數

- **極簡列 hover 沒有重置時間**：Codex 與 Claude 的 hover 浮層各自顯示成本／票券與 Token，但都沒有「幾號幾點重置」——列上只有「4天6時」這種倒數，使用者得自己推算。兩個浮層最上方都補上「額度重置　7/25（週六） 上午08:00」。
- **票券建議移除張數措辭**：上一版仍會說「約需 3 張」，雖然動作是「用 1 張」，但提到張數就容易讀成要一次用多張。改為只判斷「這 1 張夠不夠撐到重置」：
  - 撐得到 →「這 1 張預計就能撐到重置」
  - 撐不到 →「這 1 張撐不到重置，用完後再視當時用量決定下一張」
  - 連剩下的票也不夠 →「這 1 張撐不到重置，剩下的票也不夠補滿，後段可能要放慢」
  `estimatedNeeded` 仍保留在型別中供 UI 判斷，只是不再寫進使用者看到的句子。
- 測試新增反向斷言：建議文字不得出現 `需 N 張`／`全部使用` 等字樣。204 tests 全綠。

## 2026-07-21 — Reset 票券改為「一次一張」並估算需要幾張

- 使用者回報建議像是要他「全部使用」。實際通知原文為「目前有 3 張可用…**建議現在使用**」——沒有說用幾張，讀起來就是把整疊燒掉；而 Full reset 一贖回就立刻開始新週期，多贖的等於直接丟掉。
- 三層修正：
  1. **文案明確化**：標題改「建議使用 1 張」，逐張建議改「建議使用這 1 張」，排隊中的票改「排在前一張之後」。
  2. **新增 `plan`（整體建議）**：永遠只談下一張，並回報用後還剩幾張。
  3. **接上消耗速度**：新增 `burnRatePerHour` 參數（呼叫端傳 `forecast.burnRate24h`），以「100 點 ÷ 每小時消耗」推得「1 張可撐多久」，再與「距離官方重置還有多久」相比，估出撐到重置約需幾張。
- 實際輸出（使用者的情境：一張撐 2 天、距離重置 5 天、有 3 張）：
  `建議現在用 1 張（用後還剩 2 張）；依近期速度 1 張可撐約 2 天；距離 7/25（週六） 上午08:00 重置還有約 5 天；照這個速度撐到重置約需 3 張，用完這張再看要不要下一張`
- 其他分支：用量 <80% 說「先不用票」；票數不足以撐到重置時明說「只有 N 張，後段可能要放慢」；沒有歷史資料（新安裝）時省略推估但仍建議一次一張。
- 小工具 tooltip 與極簡列 hover 改顯示 `plan.message`；通知 body 亦改用它。新增 4 個測試（含使用者原始情境），更新 3 個斷言舊文案的既有測試。204 tests 全綠。

## 2026-07-21 — 重置與票券建議直接給出日期

- 使用者回報：通知只說「距離重置還有約 5 天」，而 Reset 票券建議只說「先等官方重置」——要判斷「哪天用票划算」還得自己換算日期。
- `util.ts` 新增共用的 `formatLocalDateTime`（zh-TW，與小工具 tooltip 同格式）與 `formatUntil`（把「時長」與「落在哪一刻」綁在一起）；`notificationEvents.ts` 原本自己寫了一份 `Intl.DateTimeFormat`，改為共用，去掉重複。
- 三處文案補上實際日期：
  - exhaustion_forecast：`距離重置還有約 5 天（7/25（週六） 下午08:00）`
  - quota_expiring 的重置在即分支：同樣附日期
  - `resetCredits`：`先等 7/25（週六） 下午08:00 官方重置，下一輪達 80% 再用`
- 小工具與極簡列的票券 hover 直接吃 domain 的 message，因此一併生效，不需改 UI。
- 測試：新增「票券建議必須含實際日期」的斷言（`/7\/25/`），並更新一個仍在斷言舊文案的既有測試。200 tests 全綠。

## 2026-07-20 — Discord 改為純文字（修正我自己稍早的錯誤判斷）

- 使用者回報 Discord 出現**完全空白**的訊息。查 delivery 紀錄：內容是完整的（「Claude 週額度即將用完／剩餘額度約 7%」），把當下程式產生的 payload 印出來也完全合法（title／description／color／footer／timestamp 齊全）——所以是客戶端沒有渲染 embed。
- **這推翻了我今早的判斷**：當時看到重複訊息就推論「embed 渲染正常，可以拿掉純文字保險」，正確結論其實是「embed **有時**不渲染」。原本的保險有其道理，錯的是它用「同時送 content + embed」來做，於是能渲染時就變成同一段話出現兩次。
- 改為**只送純文字**（`**⚠️ 標題**\n內文`）：一次渲染、且永遠看得見。失去嚴重度顏色與 footer，但 ⚠️／ℹ️／🚨 前綴已承載緊急度；順手移除不再使用的顏色表。
- 測試同時鎖住兩個方向：不得出現 `embeds`（空殼風險）、`content` 必須恰好是完整訊息（重複風險）。
- 驗收：typecheck／lint／199 tests／tauri build 全綠。

## 2026-07-20 — Rust 解析層補上自動測試

- 體檢時列為最高風險：`local_usage.rs` 518 行是全 App 數字的來源（額度、token、成本），卻只有 2 個 `#[ignore]` 實機測試——上游一改格式不會報錯，只會靜靜給出錯的數字。
- 為了可測，把兩段解析核心從檔案 I/O 抽成純函式：
  - `aggregate_daily_usage(lines, utc_offset)`：成本頁的每日×模型彙總。
  - `claude_limit_descriptor(limit)`：官方 `limits` 陣列 → App 額度模型（kind／名稱／視窗／key／重置時間）。
- 新增 8 個測試，全部餵真實 JSON 形狀：token 加總與 TTL 分項、跨檔案 message id 去重、非計費行（壞 JSON／無 usage／無 id／`<synthetic>`／無時間戳）一律略過、時區分桶（23:30Z 在 UTC+8 屬隔天）、三種 limit kind 的映射與 key 穩定性、無法辨識的 kind 必須跳過而非猜測、滿額暫停需「全部」額度皆滿且未到期、RFC3339 解析。
- **以故障注入驗證測試有效**：把 `ephemeral_5m_input_tokens` 改名 → 彙總測試失敗；把 `/scope/model/display_name` 改路徑 → 映射測試失敗。重構後實機 live 測試仍通過（跑在本機完整 transcript 歷史上）。
- 驗收：cargo test 8 passed／typecheck／lint／199 vitest／tauri build 全綠。

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
- 以本機真實 delivery 紀錄回放驗證：重複的那些一律被擋下，其餘照常送出（session/weekly 的 forecast 與 warning 各佔大宗）。
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
- Rust 新增 `read_claude_usage_daily(utc_offset_minutes)`：掃描 `~/.claude/projects` 全部 jsonl，依 `message.id`（fallback `requestId`）跨檔案去重、跳過 `<synthetic>`，以呼叫端時區把 timestamp 分桶成每日×模型 token 統計。live 測試（`cargo test -- --ignored`）在數百 MB 的本機歷史上約 0.5 秒完成。
- Domain 新增 `usageStats.ts`：`aggregateClaudeUsage` 聚合 daily／weekly（ISO 週一起算）／monthly，含每模型 API 等值成本、未定價模型旗標；`summarizeUsagePeriods` 出全期間總計。10 個新 Vitest。
- `claudeCost.ts` 定價表改為官方牌價並補齊模型（Fable/Mythos $10/$50、Opus 4.5–4.8 $5/$25、Sonnet 4.5–5 $3/$15、Haiku 4.5 $1/$5；cache 寫 1.25×、讀 0.1×），新增 `claudePrice` 前綴比對支援 `claude-haiku-4-5-20251001` 這類帶日期字尾 ID。注意：既有 Fable 12/70 舊估價修正為官方 10/50，UI 各處 API 等值金額會略降。
- UI 新增 `usageStats` 頁與側欄「成本統計」：期間彙總卡片＋表格（多模型期間逐模型分項）、每日／每週／每月切換；瀏覽器模式如實顯示需桌面 App。已在瀏覽器預覽驗證路由與空狀態、以 live 測試驗證真實資料路徑。
- 快取寫入依 TTL 計價：解析 transcript `usage.cache_creation.ephemeral_5m/1h_input_tokens`，5 分鐘寫入 1.25×、1 小時寫入 2×（Claude Code 即為 1h TTL；無分項時保守以 1h 計）；Sonnet 5 促銷價（$2/$10）計至 2026-08-31 由 `claudePrice(model, nowIso)` 自動切換。
- 與 `npx ccusage@latest monthly --json` 對同一份本機資料交叉驗證：四個模型（fable/opus/sonnet/haiku）逐項成本差距 0.02%–0.3%（來自兩次執行的時間差與月界時區），sonnet 完全一致。
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
# 2026-07-22 — 成本統計補齊 Codex 與 GPT-5.6

- 根因：既有成本統計只呼叫 `read_claude_usage_daily`，完全沒有掃描 Codex session，並非單純前端漏顯示。
- 新增 `read_codex_usage_daily`，掃 active + archived JSONL，以 `last_token_usage` delta 配對當下 `turn_context.model`，避免 cumulative total 或模型切換造成重複／錯置。
- 統計頁同時載入 Claude 與 Codex；單一來源失敗時仍顯示另一來源並提示。表格新增來源欄，local usage 更新事件涵蓋兩個 Provider。
- Codex 支援 `gpt-5.5`、`gpt-5.6-sol/terra/luna` 定價；Input 與 cached input 分欄並分別計價。
- 實機掃描 85 個 daily×model rows，確認 2026-07 有 `gpt-5.5`、`gpt-5.6-sol` 與 `codex-auto-review`。

# 2026-07-23 — 防止 macOS 一般 Quit 中斷背景監測

- 系統 unified log 證實正式版不是 crash：收到 Dock 發出的 `(aevt,quit)`，AppKit 回覆 `applicationShouldTerminate:YES` 後 voluntary exit。
- 背景模式啟用時攔截無 exit code 的使用者 Quit（`⌘Q`／Dock Quit），隱藏主視窗並繼續執行；程式內 `app.exit(0)` 帶 exit code，Settings／tray 的明確 Quit 不受影響。
- 新增退出來源診斷事件與 Rust 決策測試。

# 2026-07-24 — 未簽章測試版 DMG 安裝提醒

- 新增 760×500 自訂 DMG 背景，開啟 Finder 安裝視窗即可看到 App → Applications 拖曳方向。
- 背景直接提供 Gatekeeper 阻擋後的中英文處理方式：「系統設定 → 隱私權與安全性 → 仍要打開」，並明示安全確認仍須由使用者完成。
- Tauri DMG 設定固定視窗尺寸及兩個圖示位置，避免圖示覆蓋提醒內容；沒有加入會誤導成安全授權的 License Agreement。

# 2026-07-24 — Windows 10/11 x64 未簽章測試版

- 新增 `tauri.windows.conf.json`，Windows bundle 固定產生 NSIS；macOS private API feature 改為 target-specific，Windows 編譯不再帶入。
- Rust 使用者目錄加入 `USERPROFILE` fallback；Claude/Codex binary 加入 Windows 候選路徑。前端檔案事件將 `\` 正規化，Windows 上也能辨識 `.claude.json`。
- Windows 不呼叫 macOS Spaces API，也不套用 macOS 使用者 Quit 攔截；tray template icon 只在 macOS 啟用，避免 Windows 圖示被當成單色模板。
- `cargo-xwin check` 通過；產出 x86_64 Windows GUI PE 與 unsigned NSIS installer。SHA-256：`6f2f98d974f87bdaae0da63531521fa91e762eac561476b146fe6fa199980cc9`。
- 限制：目前僅完成 macOS host 交叉編譯與靜態格式檢查，尚未在 Windows 10/11 實機驗證安裝、WebView2、tray、自啟與 Claude/Codex 實際路徑。

# 2026-07-24 — 首次設定改為自動偵測

- 移除 onboarding 的 Provider 手選、帳號名稱、方案／月費／幣別、手動百分比與重置時間，避免要求使用者填入 App 無法驗證且監控不需要的資料。
- 首頁改列 Claude Code、OpenAI / Codex 兩個可自動偵測的本機來源；可立即重新偵測，未找到時仍可完成設定並由背景同步稍後補上。
- ChatGPT 網頁聊天保留為清楚的不可用狀態：一般 ChatGPT 模型限制並非 Codex 本機額度，且目前沒有官方個人額度 API，不能假裝自動抓取。
- Onboarding 縮為三步，並新增 UI 測試，確保不再出現帳號與月費欄位。

# 2026-07-24 — UI/UX 正式發布前整理

- 依 UI/UX Pro Max 檢查結果保留既有深灰＋teal 產品語言，不進行無必要的整體換色或版型重做。
- 極簡列的成本／Token 詳情可用 hover、滑鼠點擊、Enter 或 Space 開關；focus 與展開狀態只影響所選列。
- 提高極簡列及小工具的關鍵字級與文字對比，同步更新 Rust strip 高度計算與測試，避免較大字體被原生視窗裁切。
- 側欄與小工具選單統一為同一組 outline SVG，不再混用 Unicode 結構 icon。
- Switch 與視窗控制擴大可點範圍；Modal 開啟時移入焦點、Tab/Shift+Tab 留在對話框、關閉後回到原控制，並新增 UI 測試。
- 加入 `prefers-reduced-motion`，以及 780px 以下縮成 icon rail 的桌面響應式布局，改善 Windows 高 DPI 與分割視窗。
