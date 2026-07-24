// First-run setup: discover supported local sources and ask only for behaviour preferences.
// Subscription prices and current usage are provider data, not onboarding questions.

import { useState } from "react";
import { DEFAULT_EVENT_PREFERENCES } from "@/domain/limitNotificationPreferences";
import { SETTINGS_KEYS } from "@/services/settingsKeys";
import { getAppServices } from "../appServices";
import { Switch, toast } from "../components/atoms";
import { useAppStore } from "../state/store";
import { newId, nowIso } from "@/services/ids";

const TOTAL_STEPS = 3;

type SyncResult = {
  claude: "detected" | "not_found";
  codex: "detected" | "not_found";
};

export function OnboardingPage() {
  const store = useAppStore();
  const [step, setStep] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncResult>();
  const [desktopNotif, setDesktopNotif] = useState(true);
  const [hourlyPolling, setHourlyPolling] = useState(true);
  const [background, setBackground] = useState(true);
  const [autostart, setAutostart] = useState(false);
  const [finishing, setFinishing] = useState(false);

  async function detectLocalSources(): Promise<SyncResult> {
    setSyncing(true);
    try {
      const services = await getAppServices();
      await services.collectLocalUsage();
      await store.refresh();
      const accounts = await services.providerRepo.listAccounts();
      const result: SyncResult = {
        claude: accounts.some((account) => account.providerId === "claude") ? "detected" : "not_found",
        codex: accounts.some((account) => account.providerId === "codex") ? "detected" : "not_found",
      };
      setSyncResult(result);
      return result;
    } finally {
      setSyncing(false);
    }
  }

  async function finish() {
    setFinishing(true);
    try {
      const services = await getAppServices();
      await detectLocalSources().catch(() => undefined);
      const now = nowIso();

      if (desktopNotif && !(await services.notificationRepo.listChannels()).some((channel) => channel.type === "desktop")) {
        await services.notificationRepo.saveChannel({
          id: newId("ch"),
          type: "desktop",
          displayName: "桌面通知",
          enabled: true,
          eventPreferences: { ...DEFAULT_EVENT_PREFERENCES },
          createdAt: now,
          updatedAt: now,
        });
      }

      await services.settingsRepo.set(SETTINGS_KEYS.notificationsEnabled, String(desktopNotif));
      await services.settingsRepo.set(SETTINGS_KEYS.pollingEnabled, String(hourlyPolling));
      await services.settingsRepo.set(SETTINGS_KEYS.backgroundEnabled, String(background));
      if (background) await services.backgroundRuntime.start();
      else await services.backgroundRuntime.stop();
      if (autostart) {
        await services.autoStart.enable().catch(() => toast.error("開機自動啟動設定失敗，可稍後在設定重試"));
        await services.settingsRepo.set(SETTINGS_KEYS.autostartEnabled, "true");
      }
      await services.settingsRepo.set(SETTINGS_KEYS.onboardingCompleted, "true");

      await store.refresh();
      store.navigate("dashboard");
      toast.success("設定完成；找到的本機用量會自動同步");
    } catch (err) {
      toast.error(`初始化失敗：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setFinishing(false);
    }
  }

  async function skipWithDemo() {
    const services = await getAppServices();
    await services.demo.load();
    await services.settingsRepo.set(SETTINGS_KEYS.onboardingCompleted, "true");
    await store.refresh();
    store.navigate("dashboard");
    toast.success("已載入 Demo 資料，可隨時在設定清除");
  }

  const sourceStatus = (status: SyncResult[keyof SyncResult] | undefined) =>
    status === "detected" ? "已偵測" : status === "not_found" ? "尚未找到" : "將自動偵測";

  return (
    <div className="wizard">
      <div className="brand" style={{ color: "inherit", paddingBottom: 18 }}>
        <span className="brand-mark">◔</span>
        <div>
          AI Usage Monitor
          <small style={{ letterSpacing: 1.2 }}>LOCAL-FIRST USAGE TRACKING</small>
        </div>
      </div>
      <div className="wizard-steps" aria-label={`步驟 ${step + 1} / ${TOTAL_STEPS}`}>
        {Array.from({ length: TOTAL_STEPS }, (_, i) => (
          <div key={i} className={i <= step ? "done" : ""} />
        ))}
      </div>

      <div className="wizard-panel">
        {step === 0 && (
          <>
            <h2 style={{ marginBottom: 6 }}>自動尋找用量來源</h2>
            <p className="muted" style={{ marginBottom: 18 }}>
              不需要輸入帳號、方案或月費。App 只會讀取這台電腦已有的官方本機資料。
            </p>
            <div className="onboarding-sources">
              <article className="onboarding-source">
                <div>
                  <strong>Claude Code</strong>
                  <p className="faint">讀取 Claude Code 本機的官方用量快取</p>
                </div>
                <span className={syncResult?.claude === "detected" ? "source-detected" : ""}>
                  {sourceStatus(syncResult?.claude)}
                </span>
              </article>
              <article className="onboarding-source">
                <div>
                  <strong>OpenAI / Codex</strong>
                  <p className="faint">Codex 與支援的代理功能可能共用方案額度；同步 Codex 本機用量</p>
                </div>
                <span className={syncResult?.codex === "detected" ? "source-detected" : ""}>
                  {sourceStatus(syncResult?.codex)}
                </span>
              </article>
              <article className="onboarding-source unavailable">
                <div>
                  <strong>ChatGPT 網頁聊天</strong>
                  <p className="faint">一般網頁聊天有獨立限制，目前沒有官方個人額度 API 可供自動同步</p>
                </div>
                <span>目前不支援</span>
              </article>
            </div>
            <button
              type="button"
              className="btn"
              disabled={syncing}
              onClick={() => void detectLocalSources().catch((error) => {
                toast.error(`偵測失敗：${error instanceof Error ? error.message : String(error)}`);
              })}
            >
              {syncing ? "偵測中…" : syncResult ? "重新偵測" : "開始偵測"}
            </button>
            <p className="faint" style={{ marginTop: 12 }}>
              沒找到也可以繼續；安裝或登入 Claude Code / Codex 後，App 會再次自動同步。
            </p>
          </>
        )}

        {step === 1 && (
          <>
            <h2 style={{ marginBottom: 6 }}>背景行為</h2>
            <p className="muted" style={{ marginBottom: 8 }}>全部可以之後在設定調整。</p>
            <Switch checked={desktopNotif} onChange={setDesktopNotif} label="桌面通知" description="重置與用量警告以系統通知提醒（建議開啟）" />
            <Switch checked={hourlyPolling} onChange={setHourlyPolling} label="背景同步" description="定期同步用量並偵測重置（建議開啟）" />
            <Switch checked={background} onChange={setBackground} label="關閉視窗後背景執行" description="關窗後留在選單列繼續監控（建議開啟）" />
            <Switch checked={autostart} onChange={setAutostart} label="開機自動啟動" description="預設關閉" />
          </>
        )}

        {step === 2 && (
          <>
            <h2 style={{ marginBottom: 6 }}>設定完成</h2>
            <p className="muted" style={{ marginBottom: 14 }}>
              App 會顯示 Provider 回傳的額度、重置時間與本機 Token 成本。訂閱方案與月費不是計算額度的必要資料，
              如有記帳需求，可稍後在「方案與額度」中補充。
            </p>
            <p className="muted">
              Discord 等外部通知可在「通知設定」頁面新增並測試；Secret 只存於系統安全儲存。
            </p>
          </>
        )}

        <div className="modal-actions" style={{ marginTop: 22 }}>
          <span>
            <button type="button" className="btn ghost" onClick={() => void skipWithDemo()}>
              先用 Demo 資料看看
            </button>
          </span>
          {step > 0 && <button type="button" onClick={() => setStep((s) => s - 1)}>上一步</button>}
          {step < TOTAL_STEPS - 1 ? (
            <button type="button" className="primary" onClick={() => setStep((s) => s + 1)}>下一步</button>
          ) : (
            <button type="button" className="primary" disabled={finishing || syncing} onClick={() => void finish()}>
              {finishing ? "設定中…" : "完成設定"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
