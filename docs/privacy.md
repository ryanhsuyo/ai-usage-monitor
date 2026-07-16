# Privacy

## 原則：本機優先

- 使用資料（快照、活動、方案、設定）**預設不離開本機**。
- 沒有雲端後端、沒有 Supabase、沒有帳號系統、沒有分析遙測、沒有自動上傳。
- SQLite 資料檔存於 App Data Directory（macOS：`~/Library/Application Support/com.aiusagemonitor.app/app.db`）。

## 帳號與密碼

- 本產品**不需要**你的 Claude / OpenAI / Google 帳號密碼，也沒有任何輸入密碼的地方。
- 不保存任何明文密碼。
- Browser Automation（讀取 usage 頁面）**預設未啟用且尚未實作**；未來實作時將使用你既有的瀏覽器登入狀態，仍不會索取帳密。

## Secret 儲存

- Discord/Slack Webhook URL、Telegram Bot Token 等一律存**系統安全儲存**（macOS Keychain；Windows 版將用 Credential Manager）。
- Keychain 不可用時退回 App Data 內 AES-GCM 加密檔（Settings 會顯示目前使用哪個 backend）。
- SQLite 只儲存 `secretRef` 指標，永不儲存 Secret 值。

## JSON 匯出

- 匯出檔**預設排除**所有 Secret：Webhook URL、Token、API Key、Cookie、Session、憑證一律不進匯出檔。
- 匯入時若偵測到疑似機密欄位會忽略並警告，不會匯入。

## 外部通知的資料流

- 只有**你主動啟用**的通知管道才會對外送資料。
- 送出的內容僅為通知文字（例如「Claude 額度已確認重置，目前已使用 2%」），會傳到你設定的 Discord / Slack / Telegram / 自訂 Webhook 對應的第三方服務。
- 不啟用外部通知時，資料完全不外傳。桌面通知只經過作業系統。

## 未來

- 若未來加入 Cloud Sync 或匿名診斷，一定是**另行取得明確同意的 opt-in**，且預設關閉。
