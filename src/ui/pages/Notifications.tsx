// Notifications (spec §16.7): channel matrix, per-event toggles, quiet hours, test sends,
// delivery history. Secrets go straight into SecretStore; the DB only keeps a secretRef.

import { useMemo, useState } from "react";
import type {
  NotificationChannelConfig,
  NotificationChannelType,
  NotificationEventType,
} from "@/domain/types";
import { normalizeHhMm } from "@/domain/quietHours";
import { getAppServices } from "../appServices";
import { Badge, ConfirmDialog, Modal, Switch, toast } from "../components/atoms";
import { CHANNEL_TYPE_LABELS, EVENT_TYPE_LABELS, formatDateTime } from "../components/format";
import { useAppStore } from "../state/store";
import { newId, nowIso } from "@/services/ids";
import { SETTINGS_KEYS, settingBool, settingNum } from "@/services/settingsKeys";
import {
  isLimitNotificationEventEnabled,
  isChannelNotificationEventEnabled,
  DEFAULT_CHANNEL_EVENT_PREFERENCES,
  parseLimitNotificationPreferences,
  parseLimitUsageWarningThresholds,
  limitUsageWarningThreshold,
  setLimitUsageWarningThreshold,
  setLimitNotificationEvent,
} from "@/domain/limitNotificationPreferences";

const EVENT_TYPES: NotificationEventType[] = [
  "quota_expiring",
  "reset_expected",
  "reset_confirmed",
  "usage_warning",
  "exhaustion_forecast",
  "polling_failed",
  "data_stale",
];

const DEFAULT_PREFS = DEFAULT_CHANNEL_EVENT_PREFERENCES;

const SECRET_LABELS: Partial<Record<NotificationChannelType, { label: string; placeholder: string }>> = {
  discord: { label: "Discord Webhook URL", placeholder: "https://discord.com/api/webhooks/…" },
  slack: { label: "Slack Webhook URL", placeholder: "https://hooks.slack.com/services/…" },
  telegram: { label: "Telegram Bot Token", placeholder: "123456789:AAF…" },
  custom_webhook: { label: "Webhook URL", placeholder: "https://example.com/hooks/ai-usage" },
};

const EVENT_DESCRIPTIONS: Record<NotificationEventType, string> = {
  quota_expiring: "仍有可用額度但已接近官方重置時間時提醒，避免未使用額度到期。",
  reset_expected: "到達官方預定重置時間時提醒你確認額度是否恢復。",
  reset_confirmed: "偵測到用量下降或重置時間前移，可能是臨時／提前重置。",
  usage_warning: "剩餘額度低於你設定的門檻時通知。",
  exhaustion_forecast: "依目前使用速度，可能在下次重置前耗盡時通知。",
  polling_failed: "讀取本機用量發生錯誤時通知；預設關閉以避免干擾。",
  data_stale: "長時間沒有取得新資料時通知；預設關閉。",
};

const PREVIEW_MESSAGES = {
  usage: { label: "即將用完", title: "Codex 週額度即將用完", body: "依目前資料，剩餘額度約 15%。", severity: "warning" as const },
  reset_credit: { label: "Reset 票券到期", title: "Codex Full reset 票券即將到期", body: "目前有 2 張可用，最早一張將於 7/21 20:00 到期。\n用量達 80% 再用；依目前資料，最晚安全使用時間約為 7/21 14:00。", severity: "info" as const },
  reset: { label: "提前重置", title: "Claude 額度可能臨時／提前重置", body: "目前已使用 8%。\n新的預計重置時間已更新。", severity: "info" as const },
  exhaustion: { label: "預估耗盡", title: "Claude 週額度可能在重置前用完", body: "依目前速度，預估約 6 小時後耗盡。\n距離重置仍有 18 小時。", severity: "warning" as const },
  failure: { label: "同步失敗", title: "Claude 同步失敗", body: "最近一次自動同步未成功，將於下次排程重試。", severity: "info" as const },
};
type PreviewKind = keyof typeof PREVIEW_MESSAGES;

export function NotificationsPage() {
  const store = useAppStore();
  const [editing, setEditing] = useState<NotificationChannelConfig | NotificationChannelType | undefined>();
  const [deleting, setDeleting] = useState<NotificationChannelConfig | undefined>();
  const [testing, setTesting] = useState<string | undefined>();
  const [previewKind, setPreviewKind] = useState<PreviewKind>("usage");

  const notificationsEnabled = settingBool(store.settings[SETTINGS_KEYS.notificationsEnabled], true);
  const usageWarningRemainingPercent = Math.min(50, Math.max(1,
    settingNum(store.settings[SETTINGS_KEYS.usageWarningRemainingPercent], 15)
  ));
  const limitEventPreferences = useMemo(
    () => parseLimitNotificationPreferences(store.settings[SETTINGS_KEYS.limitEventPreferences]),
    [store.settings]
  );
  const limitUsageWarningThresholds = useMemo(
    () => parseLimitUsageWarningThresholds(store.settings[SETTINGS_KEYS.limitUsageWarningThresholds]),
    [store.settings]
  );

  const lastDeliveryByChannel = useMemo(() => {
    const map = new Map<string, { at?: string; status: string }>();
    for (const d of store.deliveries) {
      const cur = map.get(d.channelId);
      const at = d.deliveredAt ?? d.attemptedAt;
      if (!cur || (at && (!cur.at || at > cur.at))) {
        map.set(d.channelId, { at, status: d.status });
      }
    }
    return map;
  }, [store.deliveries]);

  async function toggleChannel(channel: NotificationChannelConfig, enabled: boolean) {
    const services = await getAppServices();
    await services.notificationRepo.saveChannel({ ...channel, enabled, updatedAt: nowIso() });
    await store.refresh();
  }

  async function toggleLimit(limitId: string, notifyEnabled: boolean) {
    const services = await getAppServices();
    const limit = store.limits.find((item) => item.id === limitId);
    if (!limit) return;
    await services.providerRepo.saveLimit({ ...limit, notifyEnabled, updatedAt: nowIso() });
    await store.refresh();
  }

  async function toggleLimitEvent(
    limitId: string,
    eventType: NotificationEventType,
    enabled: boolean
  ) {
    const services = await getAppServices();
    const next = setLimitNotificationEvent(limitEventPreferences, limitId, eventType, enabled);
    await services.settingsRepo.set(SETTINGS_KEYS.limitEventPreferences, JSON.stringify(next));
    await store.refresh();
  }

  async function toggleEventForAll(eventType: NotificationEventType, on: boolean) {
    const services = await getAppServices();
    await Promise.all(store.channels.map((channel) => services.notificationRepo.saveChannel({
      ...channel,
      eventPreferences: { ...channel.eventPreferences, [eventType]: on },
      updatedAt: nowIso(),
    })));
    await store.refresh();
  }

  async function toggleEvent(
    channel: NotificationChannelConfig,
    eventType: NotificationEventType,
    on: boolean
  ) {
    const services = await getAppServices();
    await services.notificationRepo.saveChannel({
      ...channel,
      eventPreferences: { ...channel.eventPreferences, [eventType]: on },
      updatedAt: nowIso(),
    });
    await store.refresh();
  }

  async function sendTest(channel: NotificationChannelConfig) {
    setTesting(channel.id);
    try {
      const services = await getAppServices();
      const res = await services.dispatcher.sendTest(channel);
      if (res.ok) toast.success(`已送出測試通知到 ${channel.displayName}`);
      else toast.error(`測試失敗：${res.message ?? "未知錯誤"}`);
    } finally {
      setTesting(undefined);
    }
  }

  async function sendPreview(channel: NotificationChannelConfig) {
    setTesting(channel.id);
    try {
      const services = await getAppServices();
      const res = await services.dispatcher.sendTest(channel, PREVIEW_MESSAGES[previewKind]);
      if (res.ok) toast.success(`已送出「${PREVIEW_MESSAGES[previewKind].label}」預覽`);
      else toast.error(`預覽失敗：${res.message ?? "未知錯誤"}`);
    } finally {
      setTesting(undefined);
    }
  }

  async function setMaster(on: boolean) {
    const services = await getAppServices();
    await services.settingsRepo.set(SETTINGS_KEYS.notificationsEnabled, String(on));
    await store.refresh();
  }

  async function saveUsageWarningThreshold(input: HTMLInputElement) {
    const value = Number(input.value);
    if (!Number.isFinite(value) || value < 1 || value > 50) {
      input.value = String(usageWarningRemainingPercent);
      toast.error("即將用完門檻請設定為 1% 到 50%");
      return;
    }
    const normalized = Math.round(value);
    const services = await getAppServices();
    await services.settingsRepo.set(SETTINGS_KEYS.usageWarningRemainingPercent, String(normalized));
    await store.refresh();
    input.value = String(normalized);
    toast.success(`已設定：剩餘 ${normalized}% 時通知`);
  }

  async function saveLimitUsageWarningThreshold(limitId: string, input: HTMLInputElement) {
    const fallback = usageWarningRemainingPercent;
    const current = limitUsageWarningThreshold(limitUsageWarningThresholds, limitId, fallback);
    const value = Number(input.value);
    if (!Number.isFinite(value) || value < 1 || value > 50) {
      input.value = String(current);
      toast.error("個別門檻請設定為 1% 到 50%");
      return;
    }
    const next = setLimitUsageWarningThreshold(limitUsageWarningThresholds, limitId, value);
    const services = await getAppServices();
    await services.settingsRepo.set(SETTINGS_KEYS.limitUsageWarningThresholds, JSON.stringify(next));
    await store.refresh();
    toast.success(`已設定此額度：剩餘 ${next[limitId]}% 時通知`);
  }

  return (
    <>
      <header>
        <div>
          <h1>通知設定</h1>
          <p>先選擇要關心的額度，再決定何時通知、傳到哪裡</p>
        </div>
      </header>

      <div className="card" style={{ marginBottom: 16 }}>
        <Switch
          checked={notificationsEnabled}
          onChange={(v) => void setMaster(v)}
          label="啟用所有通知"
          description="總開關。關閉後任何管道都不會發送任何通知。"
        />
      </div>

      <div className="notification-step">
        <div className="notification-step-heading"><span>1</span><div><h2>哪些額度需要通知？</h2><p>關閉的額度仍會顯示用量，但不會產生通知。</p></div></div>
        <div className="notification-target-grid">
          {store.limits.filter((limit) => limit.active).map((limit) => {
            const plan = store.plans.find((item) => item.id === limit.planId);
            return <article className="notification-target" key={limit.id}>
              <div className="notification-choice">
                <div><strong>{limit.name}</strong><small>{plan?.providerId === "claude" ? "Claude Code" : plan?.providerId === "codex" ? "Codex" : plan?.name ?? "AI 額度"}</small></div>
                <button type="button" role="switch" aria-checked={limit.notifyEnabled} aria-label={`通知 ${limit.name}`} className="switch" disabled={!notificationsEnabled} onClick={() => void toggleLimit(limit.id, !limit.notifyEnabled)} />
              </div>
              <details className="notification-target-events">
                <summary>分開設定這個額度的通知事件</summary>
                <label className="limit-threshold-field">
                  <span><strong>即將用完門檻</strong><small>只套用到這個額度</small></span>
                  <span>剩餘 <input
                    key={limitUsageWarningThreshold(limitUsageWarningThresholds, limit.id, usageWarningRemainingPercent)}
                    type="number" min={1} max={50} step={1}
                    defaultValue={limitUsageWarningThreshold(limitUsageWarningThresholds, limit.id, usageWarningRemainingPercent)}
                    aria-label={`${limit.name} — 即將用完門檻`}
                    disabled={!notificationsEnabled || !limit.notifyEnabled}
                    onBlur={(event) => void saveLimitUsageWarningThreshold(limit.id, event.currentTarget)}
                  /> %</span>
                </label>
                {EVENT_TYPES.map((eventType) => {
                  const enabled = isLimitNotificationEventEnabled(limitEventPreferences, limit.id, eventType);
                  return <div className="switch-row" key={eventType}>
                    <div><div className="switch-label">{EVENT_TYPE_LABELS[eventType]}</div><div className="switch-desc">{EVENT_DESCRIPTIONS[eventType]}</div></div>
                    <button type="button" role="switch" aria-checked={enabled} aria-label={`${limit.name} — ${EVENT_TYPE_LABELS[eventType]}`} className="switch" disabled={!notificationsEnabled || !limit.notifyEnabled} onClick={() => void toggleLimitEvent(limit.id, eventType, !enabled)} />
                  </div>;
                })}
              </details>
            </article>;
          })}
        </div>
      </div>

      <div className="notification-step">
        <div className="notification-step-heading"><span>2</span><div><h2>什麼情況要通知？</h2><p>這裡會套用到所有已連接的通知管道，仍可在各管道展開進階調整。</p></div></div>
        <div className="card notification-threshold">
          <div>
            <strong>即將用完門檻</strong>
            <p>當已啟用「即將用完」的額度剩餘低於這個比例，就傳送一次通知。</p>
          </div>
          <label>
            剩餘
            <input
              key={usageWarningRemainingPercent}
              type="number"
              min={1}
              max={50}
              step={1}
              defaultValue={usageWarningRemainingPercent}
              aria-label="即將用完門檻（剩餘百分比）"
              onBlur={(event) => void saveUsageWarningThreshold(event.currentTarget)}
            />
            % 時通知
          </label>
        </div>
        <div className="card notification-event-list">
          {EVENT_TYPES.map((eventType) => {
            const allOn = store.channels.length > 0 && store.channels.every((channel) => isChannelNotificationEventEnabled(channel.eventPreferences, eventType));
            return <div className="switch-row" key={eventType}>
              <div><div className="switch-label">{EVENT_TYPE_LABELS[eventType]}</div><div className="switch-desc">{EVENT_DESCRIPTIONS[eventType]}</div></div>
              <button type="button" role="switch" aria-checked={allOn} aria-label={`所有管道 — ${EVENT_TYPE_LABELS[eventType]}`} className="switch" disabled={!notificationsEnabled || store.channels.length === 0} onClick={() => void toggleEventForAll(eventType, !allOn)} />
            </div>;
          })}
          {store.channels.length === 0 && <p className="faint">連接至少一個通知管道後即可設定事件。</p>}
        </div>
      </div>

      <div className="notification-step">
        <div className="notification-step-heading"><span>3</span><div><h2>通知傳到哪裡？</h2><p>桌面通知最簡單；Discord 可讓手機與其他電腦也收到。</p></div></div>
        <div className="row" style={{ marginBottom: 14 }}>
          {!store.channels.some((channel) => channel.type === "desktop") && <button type="button" className="btn" onClick={() => setEditing("desktop")}>＋ 啟用桌面通知</button>}
          <button type="button" className="primary" onClick={() => setEditing("discord")}>＋ 連接 Discord</button>
          <button type="button" className="btn ghost" onClick={() => setEditing("slack")}>其他管道</button>
          <span className="spacer" />
          <label className="notification-preview-select">預覽情境 <select value={previewKind} onChange={(event) => setPreviewKind(event.target.value as PreviewKind)}>{Object.entries(PREVIEW_MESSAGES).map(([key, value]) => <option value={key} key={key}>{value.label}</option>)}</select></label>
        </div>
        <div className="notification-channel-grid">
          {store.channels.map((channel) => {
            const last = lastDeliveryByChannel.get(channel.id);
            return <article className="card notification-channel" key={channel.id}>
              <div className="card-title"><div><h3>{channel.displayName}</h3><span className="faint">{CHANNEL_TYPE_LABELS[channel.type]}</span></div><button type="button" role="switch" aria-checked={channel.enabled} aria-label={`啟用 ${channel.displayName}`} className="switch" disabled={!notificationsEnabled} onClick={() => void toggleChannel(channel, !channel.enabled)} /></div>
              <p className="faint">{last?.at ? `最後傳送：${formatDateTime(last.at)}（${last.status === "sent" ? "成功" : last.status === "failed" ? "失敗" : "略過"}）` : "尚未傳送"}</p>
              <details className="notification-advanced"><summary>進階：這個管道接收哪些事件</summary>{EVENT_TYPES.map((eventType) => { const enabled = isChannelNotificationEventEnabled(channel.eventPreferences, eventType); return <div className="switch-row" key={eventType}><span className="switch-label">{EVENT_TYPE_LABELS[eventType]}</span><button type="button" role="switch" aria-checked={enabled} aria-label={`${channel.displayName} — ${EVENT_TYPE_LABELS[eventType]}`} className="switch" disabled={!notificationsEnabled || !channel.enabled} onClick={() => void toggleEvent(channel, eventType, !enabled)} /></div>; })}</details>
              <div className="row" style={{ marginTop: 12 }}><button type="button" className="btn sm" disabled={testing === channel.id} onClick={() => void sendTest(channel)}>{testing === channel.id ? "傳送中…" : "測試連線"}</button><button type="button" className="btn sm" disabled={testing === channel.id} onClick={() => void sendPreview(channel)}>傳送預覽</button><button type="button" className="btn ghost sm" onClick={() => setEditing(channel)}>編輯</button><button type="button" className="btn ghost sm" onClick={() => setDeleting(channel)}>刪除</button></div>
            </article>;
          })}
          {store.channels.length === 0 && <div className="card"><strong>尚未連接通知管道</strong><p className="faint">建議先啟用桌面通知，不需要建立任何外部帳號。</p></div>}
        </div>
      </div>

      <div className="section-title">
        <h2>最近通知事件</h2>
        <span>{store.events.length} 筆</span>
      </div>
      {store.events.length === 0 ? (
        <p className="faint">尚無通知事件。</p>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>時間</th>
                <th>類型</th>
                <th>標題</th>
                <th>內容</th>
              </tr>
            </thead>
            <tbody>
              {store.events.slice(0, 30).map((e) => (
                <tr key={e.id}>
                  <td className="mono">{formatDateTime(e.createdAt)}</td>
                  <td>
                    <Badge tone={e.severity === "warning" ? "warn" : e.severity === "critical" ? "danger" : "neutral"}>
                      {EVENT_TYPE_LABELS[e.eventType]}
                    </Badge>
                  </td>
                  <td>{e.title}</td>
                  <td className="faint" style={{ whiteSpace: "pre-line" }}>
                    {e.body}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <ChannelFormModal
          channel={typeof editing === "object" ? editing : undefined}
          initialType={typeof editing === "string" ? editing : undefined}
          onClose={() => setEditing(undefined)}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title={`刪除通知管道「${deleting.displayName}」？`}
          body="會一併刪除系統安全儲存中的對應 Secret。此動作無法復原。"
          confirmLabel="刪除"
          danger
          onConfirm={() =>
            void (async () => {
              const services = await getAppServices();
              if (deleting.secretRef) {
                await services.secretStore.deleteSecret(deleting.secretRef).catch(() => undefined);
              }
              await services.notificationRepo.deleteChannel(deleting.id);
              await store.refresh();
              toast.success("已刪除通知管道");
              setDeleting(undefined);
            })()
          }
          onCancel={() => setDeleting(undefined)}
        />
      )}
    </>
  );
}

// ---------- channel form ----------

function ChannelFormModal(props: { channel?: NotificationChannelConfig; initialType?: NotificationChannelType; onClose: () => void }) {
  const store = useAppStore();
  const isNew = !props.channel;
  const [type, setType] = useState<NotificationChannelType>(props.channel?.type ?? props.initialType ?? "desktop");
  const [name, setName] = useState(props.channel?.displayName ?? CHANNEL_TYPE_LABELS[props.initialType ?? "desktop"] ?? "");
  const [secret, setSecret] = useState("");
  const [chatId, setChatId] = useState(props.channel?.config?.chatId ?? "");
  const [allowLocal, setAllowLocal] = useState(props.channel?.config?.allowLocal === "true");
  const [quietStart, setQuietStart] = useState(props.channel?.quietHoursStart ?? "");
  const [quietEnd, setQuietEnd] = useState(props.channel?.quietHoursEnd ?? "");
  const [minInterval, setMinInterval] = useState(
    props.channel?.minIntervalMinutes !== undefined ? String(props.channel.minIntervalMinutes) : ""
  );
  const [saving, setSaving] = useState(false);

  const needsSecret = type !== "desktop";
  const secretMeta = SECRET_LABELS[type];

  // Quiet hours accept loose entry; normalize on blur and surface why a value won't take effect.
  const normalizedQuietStart = normalizeHhMm(quietStart);
  const normalizedQuietEnd = normalizeHhMm(quietEnd);
  const quietStartInvalid = normalizedQuietStart === undefined;
  const quietEndInvalid = normalizedQuietEnd === undefined;
  const quietHalfSet = Boolean(normalizedQuietStart) !== Boolean(normalizedQuietEnd);
  const quietWindow = normalizedQuietStart && normalizedQuietEnd
    ? `${normalizedQuietStart}–${normalizedQuietEnd}`
    : undefined;

  async function save(testAfterSave = false) {
    if (!name.trim()) {
      toast.error("請輸入管道名稱");
      return;
    }
    // Saving can be triggered without blurring the field, so normalize here too rather than
    // persisting text that quiet-hours evaluation would silently ignore.
    if (normalizedQuietStart === undefined || normalizedQuietEnd === undefined) {
      toast.error("靜音時間格式無法辨識，請輸入 0–23 時、0–59 分");
      return;
    }
    setSaving(true);
    try {
      const services = await getAppServices();
      const id = props.channel?.id ?? newId("ch");
      let secretRef = props.channel?.secretRef;

      if (needsSecret && secret.trim()) {
        secretRef = `notification-channel:${type}:${id}`;
        await services.secretStore.setSecret(secretRef, secret.trim());
      }
      if (needsSecret && isNew && !secret.trim()) {
        toast.error(`請輸入${secretMeta?.label ?? "Secret"}`);
        setSaving(false);
        return;
      }

      const config: Record<string, string> = {};
      if (type === "telegram" && chatId.trim()) config.chatId = chatId.trim();
      if (type === "custom_webhook" && allowLocal) config.allowLocal = "true";

      const channel: NotificationChannelConfig = {
        id,
        type,
        displayName: name.trim(),
        enabled: props.channel?.enabled ?? true,
        secretRef,
        config: Object.keys(config).length > 0 ? config : undefined,
        eventPreferences: props.channel?.eventPreferences ?? { ...DEFAULT_PREFS },
        quietHoursStart: normalizedQuietStart || undefined,
        quietHoursEnd: normalizedQuietEnd || undefined,
        minIntervalMinutes: minInterval.trim() === "" ? undefined : Number(minInterval),
        createdAt: props.channel?.createdAt ?? nowIso(),
        updatedAt: nowIso(),
      };
      await services.notificationRepo.saveChannel(channel);
      await store.refresh();
      if (testAfterSave) {
        const result = await services.dispatcher.sendTest(channel);
        if (!result.ok) {
          toast.error(`設定已儲存，但 Discord 測試失敗：${result.message ?? "未知錯誤"}`);
          return;
        }
        toast.success("Discord 已連接，測試訊息已送出");
      } else {
        toast.success(isNew ? "已新增通知管道" : "已更新通知管道");
      }
      props.onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      title={isNew ? "新增通知管道" : `編輯 ${props.channel?.displayName}`}
      subtitle="Webhook URL 與 Token 存放在系統安全儲存，不會進入資料庫或匯出檔"
      onClose={props.onClose}
    >
      {isNew && (
        <label className="field">
          管道類型
          <select
            value={type}
            onChange={(e) => {
              const t = e.target.value as NotificationChannelType;
              setType(t);
              if (!name.trim() || Object.values(CHANNEL_TYPE_LABELS).includes(name)) {
                setName(CHANNEL_TYPE_LABELS[t] ?? "");
              }
            }}
          >
            {Object.entries(CHANNEL_TYPE_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="field">
        名稱
        <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </label>
      {needsSecret && secretMeta && (
        <label className="field">
          {secretMeta.label}
          <input
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder={isNew ? secretMeta.placeholder : "留空表示沿用既有設定"}
            autoComplete="off"
          />
          <span className="hint">僅存於系統安全儲存（Keychain / Credential Manager）或本機加密檔，不進資料庫。</span>
        </label>
      )}
      {type === "discord" && (
        <div className="discord-guide">
          <strong>如何取得 Discord Webhook URL</strong>
          <ol><li>在 Discord 對目標頻道按「編輯頻道」</li><li>選擇「整合」→「Webhook」→「新增 Webhook」</li><li>複製 Webhook URL，貼到上方欄位</li><li>儲存後按「測試」，確認頻道收到訊息</li></ol>
          <span>網址只會存入系統 Keychain 或本機加密檔（見資料來源頁），不會寫入資料庫或診斷檔。</span>
        </div>
      )}
      {type === "telegram" && (
        <label className="field">
          Chat ID
          <input value={chatId} onChange={(e) => setChatId(e.target.value)} placeholder="例如 -1001234567890" />
        </label>
      )}
      {type === "custom_webhook" && (
        <Switch
          checked={allowLocal}
          onChange={setAllowLocal}
          label="允許 localhost 目標"
          description="預設拒絕內部位址以降低 SSRF 風險；只有在你自己架的本機服務時才開啟。"
        />
      )}
      <div className="form-row-3">
        <label className="field">
          靜音開始（HH:MM）
          <input
            value={quietStart}
            onChange={(e) => setQuietStart(e.target.value)}
            onBlur={(e) => setQuietStart(normalizeHhMm(e.target.value) ?? e.target.value)}
            placeholder="23:00"
            aria-invalid={quietStartInvalid}
          />
        </label>
        <label className="field">
          靜音結束（HH:MM）
          <input
            value={quietEnd}
            onChange={(e) => setQuietEnd(e.target.value)}
            onBlur={(e) => setQuietEnd(normalizeHhMm(e.target.value) ?? e.target.value)}
            placeholder="08:00"
            aria-invalid={quietEndInvalid}
          />
        </label>
        <label className="field">
          最小間隔（分鐘）
          <input
            type="number"
            min={0}
            value={minInterval}
            onChange={(e) => setMinInterval(e.target.value)}
            placeholder="0"
          />
        </label>
      </div>
      <span className={`hint ${quietStartInvalid || quietEndInvalid || quietHalfSet ? "hint-warn" : ""}`}>
        {quietStartInvalid || quietEndInvalid
          ? "靜音時間格式無法辨識，請輸入 0–23 時、0–59 分（可直接打 2300 或 23）。"
          : quietHalfSet
            ? "靜音時段需要同時填寫開始與結束時間，只填一邊不會生效。"
            : quietWindow
              ? `此管道在每天 ${quietWindow} 之間不發送通知（略過不補發）。`
              : "留空表示不設靜音時段；可直接輸入 2300 或 23，離開欄位會自動補成 23:00。"}
      </span>
      <div className="modal-actions">
        <span />
        <button type="button" onClick={props.onClose}>
          取消
        </button>
        <button type="button" className="primary" onClick={() => void save()} disabled={saving}>
          {saving ? "處理中…" : type === "discord" ? "僅儲存" : "儲存"}
        </button>
        {type === "discord" && <button type="button" className="primary" onClick={() => void save(true)} disabled={saving}>
          {saving ? "測試中…" : "儲存並測試"}
        </button>}
      </div>
    </Modal>
  );
}
