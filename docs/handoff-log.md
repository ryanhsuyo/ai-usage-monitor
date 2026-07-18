# Handoff Log

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
