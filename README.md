# AI Usage Monitor

本機優先的 AI 訂閱用量監控桌面工具 — 追蹤額度、預測耗盡時間、提醒重置、建議方案。

它不只是顯示 token 數字，而是回答：

1. 我目前的 AI 訂閱方案是否划算？
2. 照目前速度，本週額度什麼時候用完？
3. 要撐到重置，每天的安全使用預算是多少？
4. 下一次額度什麼時候重置？
5. 重置（預計或確認）時能不能主動通知我？
6. 哪些任務、模型或專案最消耗額度？
7. 我應該升級、維持還是降級方案？

第一版以 **Claude** 為主要 Provider，架構可擴充至 Codex、ChatGPT、Gemini、Cursor、API credits 等任何有額度與重置週期的服務。

> ⚠️ 所有預測（耗盡時間、剩餘次數、方案建議）都是**統計估算**，不是官方數字。UI 一律顯示可信度（含原因），資料不足時直接說「資料不足」。

## MVP 功能

- **自動本機資料來源**：Codex sessions 與 Claude Code `/usage` 快取；另支援手動快照、活動紀錄、JSON 匯入及 Demo 資料
- **Dashboard 四卡**：目前用量／用量續航／安全使用節奏／方案建議；相似任務次數僅在樣本足夠時顯示為進階估算
- **用量歷史**：趨勢圖（自製 SVG，無重型圖表依賴）、重置事件標記、擷取失敗標記、篩選與刪除
- **活動紀錄**：開始→完成任務自動計算 usageDelta；依類型／專案／模型統計
- **重置偵測**：「預計已重置」與「確認已重置」嚴格分開；單筆 0% 絕不當成重置
- **每小時背景排程**：啟動時立即檢查一次；single-flight 防重入；可暫停
- **通知**：桌面通知＋Discord／Slack／Telegram／自訂 Webhook；每管道×每事件矩陣開關、靜音時段、最小間隔、測試按鈕、去重（同事件同管道成功後絕不重發）、有限次退避重試
- **Menu Bar 常駐**：關窗後背景執行、立即檢查、暫停／恢復監控、完全退出
- **JSON 匯出／匯入**：schema 版本化；匯出**永不包含 Secret**；匯入先驗證、Merge/Replace 二擇、失敗不破壞既有資料
- **Secret 安全**：Webhook URL／Bot Token 存 macOS Keychain（keyring crate；不可用時退回 App Data 內 AES-GCM 加密檔），SQLite 只存 `secretRef`

## 技術架構

- **Tauri 2 + React 18 + TypeScript (strict) + Vite 6**，套件管理 pnpm
- **SQLite**（`tauri-plugin-sql`，migration 由 Rust 註冊、啟動時自動執行）— 使用者**不需要安裝或設定 SQLite**，它是 App 內部檔案
- **分層**：`domain/`（純函式，無 React/SQL/OS）→ `ports/`（介面）→ `adapters/`（providers、notifications、platform、storage）→ `services/` → `ui/`
- **測試**：Vitest 2 + React Testing Library；119 個測試涵蓋 domain 規則、repository、channel adapter、services、UI

```
src/
  domain/        純計算：burn rate、forecast、reset detection、plan recommendation、
                 confidence、dedup、retry、quiet hours、驗證
  ports/         介面：SecretStore、SystemNotifier、AutoStart、BackgroundRuntime、
                 Provider/Notification Adapter、Repositories、SqlDatabase
  adapters/
    providers/     Manual + 未完成 stub（回傳 unsupported）
    notifications/ Desktop / Discord / Slack / Telegram / Custom Webhook
    platform/      Tauri 實作 + InMemory 測試替身 + 加密檔 SecretStore fallback
    storage/       SQLite repositories（SQL 只存在這裡）+ FakeSqlDatabase
  services/      MonitorService(排程檢查)、NotificationDispatcher(去重/重試/靜音)、
                 DemoData、Export/Import
  ui/            8 頁面 + Onboarding + 元件
src-tauri/       Rust：migrations、keyring 指令、tray、關窗隱藏、plugins
```

## 使用者安裝（macOS）

> **尚未提供預先建置的 .dmg。** 目前請依下方「開發」章節自行建置（`pnpm tauri build`）。
> 打包好的下載版會發佈在 [Releases](../../releases)。

打包版發佈後的安裝流程：

```
下載 .dmg → 拖進 Applications → 打開 App → 完成初次設定 → 開始使用
```

屆時不需要 Node.js、Rust、SQLite、Terminal、資料庫設定或任何 Server。

> 為未簽章（unsigned）建置：第一次開啟需在「系統設定 → 隱私權與安全性」允許，或對 App 右鍵→打開。正式簽章與 notarization 在 Roadmap Phase 5。

## 使用者安裝（Windows 10 / 11）

Windows x64 測試版使用 NSIS 安裝程式：

```text
下載 AI Usage Monitor_*_x64-setup.exe → 執行 → 完成安裝
```

未簽章測試版可能出現 Microsoft Defender SmartScreen。點擊「其他資訊」後選擇
「仍要執行」即可繼續；公司管理的電腦可能由系統管理原則禁止未簽章程式。
Windows 版仍需在實際 Windows 10／11 電腦驗證視窗、tray、自動啟動與本機
Claude Code／Codex 安裝路徑，交叉編譯成功不等同完成實機驗收。

## 開發

### 環境需求

需要 **Node.js 18+**、**pnpm**、**Rust stable**，以及 macOS 的 **Xcode Command Line Tools**。
先確認你已經有哪些：

```bash
node -v      # 需 v18 以上
pnpm -v
rustc -V
xcode-select -p
```

任何一項缺少時，依下列安裝（皆為官方建議方式）：

```bash
# Xcode Command Line Tools —— 編譯 Rust 的前提，先裝這個
xcode-select --install

# Node.js：用 Homebrew，或到 https://nodejs.org 下載 LTS 安裝檔
brew install node

# pnpm：Node 內建 corepack 即可啟用，不需另外下載
corepack enable && corepack prepare pnpm@latest --activate

# Rust：官方 rustup，安裝後重開終端機或執行 source "$HOME/.cargo/env"
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

### 指令

```bash
pnpm install
pnpm tauri dev        # 開發模式（完整 App，含 tray 與 SQLite）
pnpm dev              # 純瀏覽器預覽（自動退回 in-memory 資料，不落地）

pnpm typecheck        # TypeScript strict
pnpm lint             # ESLint（0 warning 門檻）
pnpm test             # Vitest 全部測試
pnpm tauri build      # 產出 .app 與 .dmg（src-tauri/target/release/bundle/）
```

> **首次 `pnpm tauri dev` 或 `pnpm tauri build` 需要編譯 600 多個 Rust crate，約數分鐘且期間幾乎沒有輸出——這是正常的，不是當掉。** 之後的建置會使用快取，數秒即可完成。

## 資料儲存位置

- SQLite 資料檔：`{appDataDir}/app.db`（macOS v0.2 起為 `~/Library/Application Support/com.aiusagemonitor.desktop/`），一律透過 Tauri Path API 取得；升級時由原生層遷移舊目錄
- Secret：macOS Keychain（service `com.aiusagemonitor.app`）；Keychain 不可用時為 App Data 內 AES-GCM 加密檔
- Settings 頁有「開啟資料目錄」按鈕

## 通知管道設定

Notifications 頁 → 新增通知管道 → 選類型 → 貼上 Webhook URL / Bot Token（僅存系統安全儲存）→ 儲存 → **測試** → 依事件開關矩陣調整。每個管道可設定靜音時段與最小通知間隔；總開關可一鍵關閉所有通知。

## 隱私

- 本機優先：使用資料**預設不離開這台電腦**；沒有雲端後端、沒有帳號系統、沒有遙測
- 不需要、也不會保存你的 Claude 帳號密碼
- Browser Automation 預設未啟用（未實作）
- 啟用 Discord/Slack/Telegram/Webhook 時，**通知內容**會送到對應第三方服務 — 由你自行決定是否啟用
- JSON 匯出預設排除所有 Secret
- 詳見 [docs/privacy.md](docs/privacy.md)、[docs/security.md](docs/security.md)

## 目前限制

- Claude Code 與 Codex 可自動同步；ChatGPT 等 Browser 資料來源仍在 Roadmap Phase 3
- Claude 額度以 `~/.claude.json` 的官方 `/usage` 快取為準；若快取尚未建立，先在 Claude Code 執行一次 `/usage`
- Windows 版未建置（架構已預留邊界：Credential Manager、System Tray、Toast 均走 interface）；見 [docs/roadmap.md](docs/roadmap.md)
- 未簽章、無自動更新（Phase 5）
- 預測基於使用百分比的統計趨勢，非官方 token 計數

## Roadmap

Phase 2：本機額度整合已完成，後續補自動活動與 context warning → Phase 3：Browser 用量同步 → Phase 4：Windows → Phase 5：簽章與公開發布。詳見 [docs/roadmap.md](docs/roadmap.md)。

## 授權

[MIT](LICENSE)。
