# Current Status

> 後續 Agent：先讀這份，再執行 `git status`，然後看 `docs/handoff-log.md`。

**日期**：2026-07-17
**版本**：0.2.0（Phase 0 + Phase 1 + Phase 1.5 + Phase 2 本機額度整合）

## 狀態總覽

| 項目 | 狀態 |
|---|---|
| `pnpm typecheck` | ✅ 0 errors（TS strict） |
| `pnpm lint` | ✅ 0 errors / 0 warnings |
| `pnpm test` | ✅ 148/148（18 檔） |
| `pnpm tauri build` | ✅ `.app` + `.dmg`（unsigned） |
| Rust `cargo check` | ✅ |

## 已完成

- Domain 純函式全套（burn rate / forecast / remaining tasks / reset detection / plan recommendation / confidence / dedup / retry / quiet hours / snapshot+import validation）＋門檻集中 `constants.ts`
- SQLite 13 表 + 2 個 migrations（Rust 註冊、啟動自動執行；v2 合併重複額度並保留歷史關聯）
- Repository 層（SQL 只在 `adapters/storage`）＋ FakeSqlDatabase 測試替身
- Provider adapters：Manual 可用；Claude Browser / Claude Code Local / Codex Local / ChatGPT Browser 為誠實 `unsupported` stub
- 通知管道 ×5（desktop/discord/slack/telegram/custom webhook）＋ SSRF 檢查＋redaction
- SecretStore：Keychain（keyring crate）主、AES-GCM 加密檔備、InMemory 測試
- Services：MonitorService（每小時+啟動+single-flight+暫停）、NotificationDispatcher（去重/重試/靜音/最小間隔/總開關）、DemoData、Export/Import
- UI 8 頁 + Onboarding（使用者手寫設計語言 + 補 dark mode）；Demo Mode 橫幅；空/載入/錯誤/資料不足/低信心狀態
- Rust：tray menu、hide-on-close 背景執行、tray tooltip 更新、keyring 指令、quit
- Codex Local：自動解析 `~/.codex/sessions` 官方 rate-limit payload、token 與 API 等值成本
- Claude Code Local：自動解析 `~/.claude.json` 的官方 `/usage` 快取（Session／Weekly／模型 Weekly）
- 240px 小工具、134px 極簡多來源列、右上角吸附與可選置頂
- 小工具使用獨立拖曳區，控制按鈕可正常點擊；失焦不再自動隱藏
- 從小工具展開為一般視窗時，恢復 1180×820 後自動置中
- 小工具／極簡模式加入 macOS 所有 Spaces，切換虛擬桌面時持續可見；一般視窗恢復單一 Space
- 本機資料每 5 分鐘同步；資料來源頁顯示最近成功／錯誤並支援立即同步
- Dashboard 將「問幾次」降為樣本足夠才顯示的進階估算；主卡改為用量續航與每日安全使用節奏（純本機計算）
- Claude `/usage` 快取每 30 秒本機檢查一次，變更即刷新；極簡列顯示 Claude 5h／全模型週／模型週與 Codex 共四列
- Local collector 會自動偵測相同 plan + reset rule 的重複 limits，保留歷史但只啟用最新的一組
- 穩定性：移除每 1.5 秒原生視窗定位；Claude 輪詢在快取未變／錯誤未變時不寫 SQLite、不刷新 UI
- 一般視窗依目前螢幕 logical size 使用 86%×82% 自適應後置中；完整模式控制列移至頂部保留區，不覆蓋頁面按鈕
- 極簡列每筆額度顯示官方 resetAt 的緊湊倒數（如 4時30分／1天2時），每 30 秒只更新該列文字
- 視窗模式改為單一原生命令原子切換尺寸、裝飾、位置、置頂與 Spaces，避免多指令只完成一半
- `usage_limits` 以 `(plan_id, reset_rule)` partial unique index 防止自動來源再次建立重複額度
- 本機隱私安全診斷紀錄（512 KiB 自動輪替）與設定頁匯出；不含用量內容、對話、Token 或 Secret
- 極簡列在可信度足夠時直接顯示預估耗盡倒數（如「耗 2時30分」），資料不足時回退顯示重置倒數；hover 顯示完整耗盡／重置日期與可信度
- macOS 視窗定位不再於切換後讀取可能過期的 `outer_size`；改以目標 logical size 和 monitor scale 計算實體座標，完整模式可靠置中、compact 模式可靠吸附右上
- 小工具卡片清單可獨立垂直滾動，標題與同步 footer 固定；Claude metadata 不再誤判為 Codex token metadata 而顯示 `NaNK tokens`
- 通知頁改為三段式設定：先選監控額度，再選通知事件，最後連接桌面／Discord 等管道；Discord 表單內建 Webhook 建立與測試說明
- Codex 小工具卡片與極簡列 hover 顯示目前週期 Token、快取輸入 Token 與 API 等值美元成本，並明示不是訂閱實際扣款；無可靠 metadata 時不估算
- 每個額度可獨立設定六種通知事件；MonitorService 依 limit ID 過濾候選事件，未設定的舊額度維持全部事件可用的相容預設
- 使用者文案將 `reset_confirmed` 顯示為「臨時／提前重置」；Codex 成本支援部分定價，遇到 `codex-auto-review` 等無公開價格模型時直接顯示已知模型最低 API 等值（`≥ US$`）
- 移除 `tauri.conf.json` 重複的靜態 tray 宣告，只保留 Rust 動態 tray，修正 macOS 選單列同時出現兩個 App 圖示
- 極簡列改用 App 自繪 hover 浮層，不依賴 Tauri WebView 不穩定的原生 `title`；Codex 浮層顯示 Token、API 等值美元、未定價模型與估算聲明
- 極簡列每個額度固定同時顯示「重置」與「用完」倒數，無耗盡預測時顯示 `--`；Codex hover 僅替換自己那一列為成本摘要，不再覆蓋整個小工具
- Claude 本機 transcript 近 24 小時聚合：依 `message.id` 去重並按 Fable／Opus 等模型計算 input、output、cache creation/read 與 API 等值；Claude 各額度 inline hover 顯示總額與模型分項
- 極簡小工具水平貼齊目前螢幕可用區右緣（頂部仍保留 12px）；collector 可在官方額度擷取時間未變時一次性升級舊 Claude 快照 metadata，避免 hover 因舊快照而沒有成本資料
- 極簡小工具右側百分比與重置／耗盡資訊提高字級、字重及明暗模式對比，不增加視窗寬度
- 依實機可讀性回饋將極簡模式放大為 280×150：主要標籤 10.5px、倒數 8.5px、進度條 5px，仍維持四列緊湊摘要
- 設定頁可持久化選擇極簡尺寸（小 240×134／中 280×150／大 330×172）與右側資訊（重置／預估用完／兩者／API 等值金額）；切換後立即套用
- Claude `/usage` 改用 OS 原生檔案事件監聽家目錄中的 `.claude.json` 建立／修改／替換；300ms debounce 後才收集與刷新，另保留 5 分鐘排程補抓
- 新增「額度即將到期」洞察與獨立通知：5h 額度最後約 1h、週額度最後約 24h，仍剩至少 20% 才提醒；顯示確切重置時間、剩餘比例及到期前平均可用速度
- macOS 選單列使用獨立透明 template icon（用量圓環＋指針），不再把彩色 Dock icon 的不透明底轉成白色方塊
- Codex Local 優先透過已登入的官方 app-server `account/rateLimits/read` 取得即時額度與 Full reset credits；小工具顯示可用張數、最近到期日，72 小時內以警示色突出，極簡列 hover 列出所有到期日。只讀取清單，不會自動使用 reset
- Full reset 清單逐張顯示到期日與建議：最早到期優先、用量達 80% 建議使用、保留到期前 6 小時為最晚安全時間；若官方自動重置較早，建議等重置後下一輪用高再使用。文案屬依目前資料的本機建議，不宣稱官方保證
- 到達 snapshot 官方 `resetAt` 後，Dashboard、一般小工具、極簡列與 tray 不再沿用上一週期百分比，改顯示「等待新週期資料」；每 30 秒偵測 reset 邊界並主動刷新一次。Codex 由 app-server 取得新週期，Claude 快取未更新時維持待確認，不虛構 0% 官方用量
- 修正 Codex app-server 初始化與 rate-limit 查詢連續送出造成票券結果偶發遺失：現在等待 initialize response 後才查詢。`resetCreditsAvailable` 區分「確定 0 張」與「查詢失敗」；極簡列固定顯示 `Codex·票N`，失敗時顯示 `票?`，不再把錯誤冒充 0 張
- 極簡小工具在四條用量下方固定顯示 Reset 票券摘要，例如 `Reset 3 張｜到期 7/27、8/1、8/13`；不需 hover。三種尺寸各有對應字級，日期過長時只在該行省略，不影響用量列
- Discord Webhook 串接補齊：嚴格限制官方網域與完整 webhook path、以 product Embed 顯示通知並停用 mentions；新增「儲存並測試」一次完成 Keychain 保存與真實發送，測試失敗時保留表單與已脫敏錯誤
- Claude 用量同步不再等待使用者手動 `/status`／`/usage`：Rust Adapter 在收集前執行官方非互動 `claude -p /usage --no-session-persistence --tools ''`，讓 Claude 自己更新 OAuth usage 快取。實機驗證 0 turns、0 model tokens、0 API cost；4 分鐘節流避免檔案事件與 5 分鐘排程重複觸發
- Discord 通知同時送出可見純文字與詳細 Embed；即使 Discord 客戶端暫時未渲染 Embed，也不會只留下沒有內容的 Webhook 訊息
- 小工具／極簡模式加入可辨識的六點拖曳把手，按下時直接啟動 OS 原生視窗移動，不依賴透明 macOS WebView 不穩定的 HTML drag region；切換模式時 Rust 同步設定原生 WebView 透明／實色背景，閒置降至 72% 不遮視線，hover／鍵盤操作時恢復完整清晰度
- 通知頁第 2 步可直接設定「即將用完」的剩餘額度門檻（1–50%）；已啟用該事件的各額度在低於門檻後依週期去重通知一次
- Codex Full reset 票券在 72 小時內到期，或目前用量達 80% 建議使用時，會透過既有「額度即將到期」事件通知；文案含張數、到期時間、建議與最晚安全使用時間，按票券到期日去重
- 設定頁可調整小工具閒置不透明度（40–100%）與「滑鼠移入恢復清晰」；變更後立即套用並持久化
- 通知頁可選擇五種情境並對指定管道傳送預覽：即將用完、Reset 票券到期、提前重置、預估耗盡、同步失敗；連線測試與情境預覽分開
- 資料來源頁逐來源顯示最近嘗試、最近成功資料年齡、下次預定同步與最近錯誤；立即同步完成後回報實際新增讀值數或資料已最新
- 發布版本升至 0.2.0，bundle identifier 改為 `com.aiusagemonitor.desktop`；macOS 首次啟動自動複製舊 `com.aiusagemonitor.app` App Data，Keychain service 維持舊值以保留通知 Secret
- 視窗控制支援完整視窗一鍵縮到最小極簡條；極簡狀態按同一顆按鈕會展開成 240×300 小工具，箭頭按鈕仍可直接恢復完整視窗
- 視窗控制另提供 macOS 標準「收進 Dock（⌘M）」；最小化不改變完整／小工具／極簡模式，從 Dock 恢復時回到原本狀態
- macOS 無邊框 compact 視窗在最小化前會明確恢復原生 miniaturizable 能力；極簡／小工具切換圖示改為 `▬`／`▦`，避免與 Dock 收起混淆
- 四顆視窗控制改用一致線框 SVG，分別具象呈現「視窗進 Dock、卡片壓成橫條／展開、圖釘、浮動小視窗／四角展開」，不再依賴難辨識的 Unicode 符號
- 文件全套（README、AGENTS、docs/*）

## 未完成（Roadmap）

- Phase 2 尚餘：transcript → 自動活動紀錄、context window warning；Full reset 到期目前已在小工具警示，尚未加入獨立通知事件
- Phase 3：Browser 自動同步
- Phase 4：Windows build（**架構邊界已保留**，TS 層無需改動）
- Phase 5：簽章 / notarization / 自動更新
- 已知小項：UI 測試有少量無害的 React `act()` warning（不影響結果）；Claude 官方額度以 Claude Code 本機快取為準，快取的新鮮度由 Claude Code 控制。過期快取不再顯示成目前用量，但在 Claude 寫入新快取前無法確認新週期精確百分比

## 環境備註

- Node 18 → 鎖 Vite 6 / Vitest 2；升 Node 20+ 後才可升 Vite 7+
- 無簽章憑證 → unsigned build；首次開啟需右鍵→打開
- 產物：`src-tauri/target/release/bundle/macos/AI Usage Monitor.app`、`bundle/dmg/*.dmg`
