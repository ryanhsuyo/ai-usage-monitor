// Onboarding (spec §8 flow 1): first-run wizard. Channel setup is skippable; everything can be
// changed later in Settings.

import { useState } from "react";
import { CLAUDE_DEFAULT_PLANS } from "@/domain/constants";
import { DEFAULT_EVENT_PREFERENCES } from "@/domain/limitNotificationPreferences";
import { validateSnapshot } from "@/domain/snapshotValidation";
import type { LimitType, ProviderId } from "@/domain/types";
import { getAppServices } from "../appServices";
import { Switch, toast } from "../components/atoms";
import { useAppStore } from "../state/store";
import { newId, nowIso } from "@/services/ids";
import { SETTINGS_KEYS } from "@/services/settingsKeys";

const PROVIDERS: Array<{ id: ProviderId; label: string; hint: string }> = [
  { id: "claude", label: "Claude", hint: "Pro / Max 訂閱" },
  { id: "chatgpt", label: "ChatGPT", hint: "Plus / Pro 訂閱" },
  { id: "codex", label: "Codex", hint: "用量額度" },
  { id: "gemini", label: "Gemini", hint: "訂閱 / Credits" },
  { id: "cursor", label: "Cursor", hint: "Requests 額度" },
  { id: "custom", label: "自訂", hint: "任何有額度的服務" },
];

const TOTAL_STEPS = 5;

export function OnboardingPage() {
  const store = useAppStore();
  const [step, setStep] = useState(0);

  // step 1: provider + account
  const [providerId, setProviderId] = useState<ProviderId>("claude");
  const [accountName, setAccountName] = useState("我的 Claude 帳號");
  // step 2: plan
  const [planName, setPlanName] = useState("Max 5x");
  const [price, setPrice] = useState("100");
  const [currency, setCurrency] = useState("USD");
  // step 3: limit + first usage
  const [limitType, setLimitType] = useState<LimitType>("weekly");
  const [usedPercent, setUsedPercent] = useState("");
  const [resetAt, setResetAt] = useState("");
  // step 4: behaviour
  const [desktopNotif, setDesktopNotif] = useState(true);
  const [hourlyPolling, setHourlyPolling] = useState(true);
  const [background, setBackground] = useState(true);
  const [autostart, setAutostart] = useState(false);
  const [finishing, setFinishing] = useState(false);

  async function finish() {
    setFinishing(true);
    try {
      const services = await getAppServices();
      const now = nowIso();

      const accountId = newId("acc");
      await services.providerRepo.saveAccount({
        id: accountId,
        providerId,
        displayName: accountName.trim() || PROVIDERS.find((p) => p.id === providerId)!.label,
        active: true,
        createdAt: now,
        updatedAt: now,
      });

      const planId = newId("plan");
      await services.providerRepo.savePlan({
        id: planId,
        providerId,
        accountId,
        name: planName.trim() || "My Plan",
        monthlyPrice: Number(price) || 0,
        currency: currency.trim() || "USD",
        relativeCapacity: CLAUDE_DEFAULT_PLANS.find((p) => p.name === planName)?.relativeCapacity,
        active: true,
        startedAt: now,
        createdAt: now,
        updatedAt: now,
      });

      const limitId = newId("lim");
      await services.providerRepo.saveLimit({
        id: limitId,
        planId,
        name:
          limitType === "weekly"
            ? "Weekly（全模型）"
            : limitType === "rolling_session"
              ? "5-hour Session"
              : "額度限制",
        type: limitType,
        windowHours: limitType === "rolling_session" ? 5 : undefined,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
        active: true,
        monitoringEnabled: true,
        notifyEnabled: true,
        createdAt: now,
        updatedAt: now,
      });

      // first snapshot (optional but encouraged)
      if (usedPercent.trim() !== "") {
        const capturedIso = now;
        const resetIso = resetAt ? new Date(resetAt).toISOString() : undefined;
        const validation = validateSnapshot({
          usedPercent: Number(usedPercent),
          capturedAt: capturedIso,
          resetAt: resetIso,
        });
        if (validation.valid && validation.normalized) {
          await services.snapshotRepo.insert({
            id: newId("snap"),
            providerId,
            accountId,
            limitId,
            usedPercent: validation.normalized.usedPercent,
            remainingPercent: validation.normalized.remainingPercent,
            resetAt: resetIso,
            capturedAt: capturedIso,
            source: "manual",
            valid: true,
            confidence: 1,
            note: "Onboarding 初始快照",
          });
        }
      }

      // desktop notification channel
      if (desktopNotif) {
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
        await services.autoStart.enable().catch(() => toast.error("開機自動啟動設定失敗，可稍後在 Settings 重試"));
        await services.settingsRepo.set(SETTINGS_KEYS.autostartEnabled, "true");
      }
      await services.settingsRepo.set(SETTINGS_KEYS.onboardingCompleted, "true");

      await store.refresh();
      store.navigate("dashboard");
      toast.success("設定完成，歡迎使用 AI Usage Monitor！");
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
    toast.success("已載入 Demo 資料，可隨時在 Settings 清除");
  }

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
            <h2 style={{ marginBottom: 6 }}>歡迎 👋</h2>
            <p className="muted" style={{ marginBottom: 18 }}>
              這是一個本機優先的 AI 訂閱用量監控工具。所有資料留在你的電腦上；不需要帳號、不需要雲端。
              先選擇你要監控的服務。
            </p>
            <div className="cards" style={{ gridTemplateColumns: "repeat(2, 1fr)", marginBottom: 6 }}>
              {PROVIDERS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className="usage-card"
                  style={{
                    textAlign: "left",
                    border: providerId === p.id ? "2px solid #286f66" : undefined,
                    padding: 14,
                  }}
                  onClick={() => {
                    setProviderId(p.id);
                    setAccountName(`我的 ${p.label} 帳號`);
                  }}
                  aria-pressed={providerId === p.id}
                >
                  <strong>{p.label}</strong>
                  <p className="faint" style={{ marginTop: 3 }}>
                    {p.hint}
                  </p>
                </button>
              ))}
            </div>
            <label className="field">
              帳號顯示名稱
              <input value={accountName} onChange={(e) => setAccountName(e.target.value)} />
            </label>
          </>
        )}

        {step === 1 && (
          <>
            <h2 style={{ marginBottom: 6 }}>訂閱方案</h2>
            <p className="muted" style={{ marginBottom: 14 }}>
              預設數字只是起點，之後都可以修改。
            </p>
            {providerId === "claude" && (
              <label className="field">
                範本
                <select
                  value={planName}
                  onChange={(e) => {
                    setPlanName(e.target.value);
                    const p = CLAUDE_DEFAULT_PLANS.find((x) => x.name === e.target.value);
                    if (p) {
                      setPrice(String(p.monthlyPrice));
                      setCurrency(p.currency);
                    }
                  }}
                >
                  {CLAUDE_DEFAULT_PLANS.map((p) => (
                    <option key={p.name} value={p.name}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="field">
              方案名稱
              <input value={planName} onChange={(e) => setPlanName(e.target.value)} />
            </label>
            <div className="form-row">
              <label className="field">
                月費
                <input type="number" min={0} value={price} onChange={(e) => setPrice(e.target.value)} />
              </label>
              <label className="field">
                幣別
                <input value={currency} onChange={(e) => setCurrency(e.target.value)} />
              </label>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <h2 style={{ marginBottom: 6 }}>額度限制與目前用量</h2>
            <p className="muted" style={{ marginBottom: 14 }}>
              選擇主要監控的額度視窗，並輸入目前的使用百分比（可留空，之後再補）。
            </p>
            <label className="field">
              額度類型
              <select value={limitType} onChange={(e) => setLimitType(e.target.value as LimitType)}>
                <option value="weekly">Weekly（全模型週額度）</option>
                <option value="rolling_session">5-hour Session（滾動）</option>
                <option value="credits">Credits</option>
                <option value="custom">自訂</option>
              </select>
            </label>
            <div className="form-row">
              <label className="field">
                目前已使用（%）
                <div className="percent-input">
                  <input
                    type="number"
                    min={0}
                    max={100}
                    step={0.1}
                    value={usedPercent}
                    onChange={(e) => setUsedPercent(e.target.value)}
                    placeholder="選填"
                  />
                  <span>%</span>
                </div>
              </label>
              <label className="field">
                下一次重置時間
                <input type="datetime-local" value={resetAt} onChange={(e) => setResetAt(e.target.value)} />
              </label>
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <h2 style={{ marginBottom: 6 }}>背景行為</h2>
            <p className="muted" style={{ marginBottom: 8 }}>
              全部可以之後在 Settings 調整。
            </p>
            <Switch checked={desktopNotif} onChange={setDesktopNotif} label="桌面通知" description="重置與用量警告以系統通知提醒（建議開啟）" />
            <Switch checked={hourlyPolling} onChange={setHourlyPolling} label="每小時背景檢查" description="定期更新預測並偵測重置（建議開啟）" />
            <Switch checked={background} onChange={setBackground} label="關閉視窗後背景執行" description="關窗後留在選單列繼續監控（建議開啟）" />
            <Switch checked={autostart} onChange={setAutostart} label="開機自動啟動" description="預設關閉" />
          </>
        )}

        {step === 4 && (
          <>
            <h2 style={{ marginBottom: 6 }}>外部通知（選填）</h2>
            <p className="muted" style={{ marginBottom: 14 }}>
              Discord / Slack / Telegram / 自訂 Webhook 可以在之後的 <strong>Notifications</strong> 頁面新增並測試。
              Webhook URL 與 Token 只會存放在 macOS Keychain 等系統安全儲存或本機加密檔，不會進資料庫或匯出檔。
            </p>
            <p className="muted">按「完成設定」進入 Dashboard。</p>
          </>
        )}

        <div className="modal-actions" style={{ marginTop: 22 }}>
          <span>
            <button type="button" className="btn ghost" onClick={() => void skipWithDemo()}>
              先用 Demo 資料看看
            </button>
          </span>
          {step > 0 && (
            <button type="button" onClick={() => setStep((s) => s - 1)}>
              上一步
            </button>
          )}
          {step < TOTAL_STEPS - 1 ? (
            <button type="button" className="primary" onClick={() => setStep((s) => s + 1)}>
              下一步
            </button>
          ) : (
            <button type="button" className="primary" disabled={finishing} onClick={() => void finish()}>
              {finishing ? "設定中…" : "完成設定"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
