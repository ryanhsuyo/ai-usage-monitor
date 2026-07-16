// Notifications (spec §16.7): channel matrix, per-event toggles, quiet hours, test sends,
// delivery history. Secrets go straight into SecretStore; the DB only keeps a secretRef.

import { useMemo, useState } from "react";
import type {
  NotificationChannelConfig,
  NotificationChannelType,
  NotificationEventType,
} from "@/domain/types";
import { getAppServices } from "../appServices";
import { Badge, ConfirmDialog, Modal, Switch, toast } from "../components/atoms";
import { CHANNEL_TYPE_LABELS, EVENT_TYPE_LABELS, formatDateTime } from "../components/format";
import { useAppStore } from "../state/store";
import { newId, nowIso } from "@/services/ids";
import { SETTINGS_KEYS, settingBool } from "@/services/settingsKeys";

const EVENT_TYPES: NotificationEventType[] = [
  "reset_expected",
  "reset_confirmed",
  "usage_warning",
  "exhaustion_forecast",
  "polling_failed",
  "data_stale",
];

const DEFAULT_PREFS: Record<NotificationEventType, boolean> = {
  reset_expected: true,
  reset_confirmed: true,
  usage_warning: true,
  exhaustion_forecast: true,
  polling_failed: false,
  data_stale: false,
};

const SECRET_LABELS: Partial<Record<NotificationChannelType, { label: string; placeholder: string }>> = {
  discord: { label: "Discord Webhook URL", placeholder: "https://discord.com/api/webhooks/…" },
  slack: { label: "Slack Webhook URL", placeholder: "https://hooks.slack.com/services/…" },
  telegram: { label: "Telegram Bot Token", placeholder: "123456789:AAF…" },
  custom_webhook: { label: "Webhook URL", placeholder: "https://example.com/hooks/ai-usage" },
};

export function NotificationsPage() {
  const store = useAppStore();
  const [editing, setEditing] = useState<NotificationChannelConfig | "new" | undefined>();
  const [deleting, setDeleting] = useState<NotificationChannelConfig | undefined>();
  const [testing, setTesting] = useState<string | undefined>();

  const notificationsEnabled = settingBool(store.settings[SETTINGS_KEYS.notificationsEnabled], true);

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

  async function setMaster(on: boolean) {
    const services = await getAppServices();
    await services.settingsRepo.set(SETTINGS_KEYS.notificationsEnabled, String(on));
    await store.refresh();
  }

  return (
    <>
      <header>
        <div>
          <h1>Notifications</h1>
          <p>通知管道、事件矩陣與傳送紀錄</p>
        </div>
        <button type="button" className="primary" onClick={() => setEditing("new")}>
          ＋ 新增通知管道
        </button>
      </header>

      <div className="card" style={{ marginBottom: 16 }}>
        <Switch
          checked={notificationsEnabled}
          onChange={(v) => void setMaster(v)}
          label="啟用所有通知"
          description="總開關。關閉後任何管道都不會發送任何通知。"
        />
      </div>

      {store.channels.length === 0 ? (
        <p className="muted" style={{ padding: "10px 0 20px" }}>
          尚未設定任何通知管道。桌面通知不需要外部服務，建議先加一個。
        </p>
      ) : (
        <div className="table-wrap" style={{ marginBottom: 20 }}>
          <table className="data">
            <thead>
              <tr>
                <th>管道</th>
                <th>啟用</th>
                {EVENT_TYPES.map((t) => (
                  <th key={t}>{EVENT_TYPE_LABELS[t]}</th>
                ))}
                <th>最後傳送</th>
                <th aria-label="操作" />
              </tr>
            </thead>
            <tbody>
              {store.channels.map((c) => {
                const last = lastDeliveryByChannel.get(c.id);
                return (
                  <tr key={c.id}>
                    <td>
                      <strong>{c.displayName}</strong>
                      <div className="faint">{CHANNEL_TYPE_LABELS[c.type]}</div>
                    </td>
                    <td>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={c.enabled}
                        aria-label={`啟用 ${c.displayName}`}
                        className="switch"
                        disabled={!notificationsEnabled}
                        onClick={() => void toggleChannel(c, !c.enabled)}
                      />
                    </td>
                    {EVENT_TYPES.map((t) => (
                      <td key={t}>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={c.eventPreferences[t] === true}
                          aria-label={`${c.displayName} — ${EVENT_TYPE_LABELS[t]}`}
                          className="switch"
                          disabled={!notificationsEnabled || !c.enabled}
                          onClick={() => void toggleEvent(c, t, !(c.eventPreferences[t] === true))}
                        />
                      </td>
                    ))}
                    <td>
                      {last ? (
                        <>
                          <div className="mono">{last.at ? formatDateTime(last.at) : "—"}</div>
                          {last.status === "sent" && <Badge tone="ok">成功</Badge>}
                          {last.status === "failed" && <Badge tone="danger">失敗</Badge>}
                          {last.status === "skipped" && <Badge tone="neutral">略過</Badge>}
                        </>
                      ) : (
                        <span className="faint">—</span>
                      )}
                    </td>
                    <td>
                      <div className="row" style={{ justifyContent: "flex-end", flexWrap: "nowrap" }}>
                        <button
                          type="button"
                          className="btn sm"
                          disabled={testing === c.id}
                          onClick={() => void sendTest(c)}
                        >
                          {testing === c.id ? "測試中…" : "測試"}
                        </button>
                        <button type="button" className="btn ghost sm" onClick={() => setEditing(c)}>
                          編輯
                        </button>
                        <button type="button" className="btn ghost sm" onClick={() => setDeleting(c)}>
                          刪除
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

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
          channel={editing === "new" ? undefined : editing}
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

function ChannelFormModal(props: { channel?: NotificationChannelConfig; onClose: () => void }) {
  const store = useAppStore();
  const isNew = !props.channel;
  const [type, setType] = useState<NotificationChannelType>(props.channel?.type ?? "desktop");
  const [name, setName] = useState(props.channel?.displayName ?? "");
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

  async function save() {
    if (!name.trim()) {
      toast.error("請輸入管道名稱");
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
        quietHoursStart: quietStart || undefined,
        quietHoursEnd: quietEnd || undefined,
        minIntervalMinutes: minInterval.trim() === "" ? undefined : Number(minInterval),
        createdAt: props.channel?.createdAt ?? nowIso(),
        updatedAt: nowIso(),
      };
      await services.notificationRepo.saveChannel(channel);
      await store.refresh();
      toast.success(isNew ? "已新增通知管道" : "已更新通知管道");
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
          <span className="hint">僅存於系統安全儲存（Keychain / Credential Manager）。</span>
        </label>
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
          <input value={quietStart} onChange={(e) => setQuietStart(e.target.value)} placeholder="23:00" />
        </label>
        <label className="field">
          靜音結束（HH:MM）
          <input value={quietEnd} onChange={(e) => setQuietEnd(e.target.value)} placeholder="08:00" />
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
      <div className="modal-actions">
        <span />
        <button type="button" onClick={props.onClose}>
          取消
        </button>
        <button type="button" className="primary" onClick={() => void save()} disabled={saving}>
          {saving ? "儲存中…" : "儲存"}
        </button>
      </div>
    </Modal>
  );
}
