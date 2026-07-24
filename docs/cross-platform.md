# Cross-platform

第一版交付 macOS；Windows 相容性由架構保證，不由本次建置驗證。

## 平台能力對照

| 能力 | Port | macOS 實作（本次） | Windows 路徑（Phase 4） |
|---|---|---|---|
| 系統通知 | `SystemNotifier` | tauri-plugin-notification（NSUserNotification） | 同 plugin（Toast） |
| Secret | `SecretStore` | keyring crate → Keychain | keyring crate → Credential Manager（已編譯進 binary） |
| App Data | （plugin 內建） | `appDataDir()` → Application Support | `appDataDir()` → AppData/Roaming |
| 自動啟動 | `AutoStartService` | tauri-plugin-autostart（LaunchAgent） | 同 plugin（Registry） |
| 系統列 | Rust tray | macOS Menu Bar（icon as template） | 同一套 Tauri tray API |
| 關窗背景執行 | `BackgroundRuntime` | hide-on-close（Rust WindowEvent） | 同一套程式碼 |
| 檔案選擇器 | dialog plugin | ✅ | 同 plugin |
| 開啟資料目錄 | opener plugin | ✅ | 同 plugin |

## 禁止事項（已遵守）

- ❌ React component 直接跑 `osascript` — 沒有任何 osascript
- ❌ 寫死 `~/Library/...` — 路徑一律 Tauri Path API
- ❌ 平台判斷散落 UI — 平台分支只在 `adapters/platform` 與 Rust
- ❌ macOS 行為進 Domain — domain 零 OS 依賴（有測試佐證：domain 測試在 jsdom 全綠）

## 如何產出各平台安裝檔

**不能從 macOS 交叉編譯**：Tauri 連結的是各平台自己的 webview（WebKit／WebView2／WebKitGTK），
安裝檔格式也由原生工具產生。因此各平台必須在該平台上建置。

`.github/workflows/release.yml` 用三個 runner 各自建置：

| 平台 | Runner | 產出 |
|---|---|---|
| macOS | `macos-latest` | `.dmg`（universal，經 `pnpm package:universal` 重簽） |
| Windows | `windows-latest` | `.msi` / `.exe`（NSIS） |
| Linux | `ubuntu-22.04` | `.deb` / `.AppImage` |

推送 `v*` 標籤會建立**草稿** release 並附上三平台檔案；也可從 Actions 頁面手動執行只取 artifacts。

`bundle.targets` 已設為 `all`，各平台會產出自己格式的安裝檔。

## Windows 剩餘工作清單

1. ~~在 Windows 機器跑 `pnpm tauri build`~~（已由 CI 涵蓋；**尚未有人在實機驗證執行結果**）
2. 驗證 keyring（Credential Manager）、autostart、tray、Toast 行為
3. Windows 專屬 QA：高 DPI、關窗行為、開機自啟
4. `main.rs` 已含 `windows_subsystem = "windows"`（release 不開 console）
