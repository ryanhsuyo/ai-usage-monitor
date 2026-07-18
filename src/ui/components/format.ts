// Display formatting helpers. Dates render in the user's local timezone (storage is UTC).

export function formatDateTime(iso: string | undefined): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  return new Date(t).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatRelative(iso: string | undefined, nowMs = Date.now()): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const diffMin = Math.round((nowMs - t) / 60000);
  if (Math.abs(diffMin) < 1) return "剛剛";
  if (diffMin > 0) {
    if (diffMin < 60) return `${diffMin} 分鐘前`;
    const h = Math.floor(diffMin / 60);
    if (h < 24) return `${h} 小時前`;
    return `${Math.floor(h / 24)} 天前`;
  }
  const ahead = -diffMin;
  if (ahead < 60) return `${ahead} 分鐘後`;
  const h = Math.round(ahead / 60);
  if (h < 24) return `${h} 小時後`;
  const days = Math.floor(h / 24);
  const remH = h % 24;
  return remH > 0 ? `${days} 天 ${remH} 小時後` : `${days} 天後`;
}

export function formatCountdown(iso: string | undefined, nowMs = Date.now()): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const diffMs = t - nowMs;
  if (diffMs <= 0) return "已到期";
  const totalMin = Math.floor(diffMs / 60000);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) return `${d} 天 ${h} 小時`;
  if (h > 0) return `${h} 小時 ${m} 分`;
  return `${m} 分鐘`;
}

export function formatCompactCountdown(iso: string | undefined, nowMs = Date.now()): string | undefined {
  if (!iso) return undefined;
  const target = Date.parse(iso);
  if (!Number.isFinite(target)) return undefined;
  const diffMs = target - nowMs;
  if (diffMs <= 0) return "重置中";
  const totalMinutes = Math.floor(diffMs / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}天${hours}時`;
  if (hours > 0) return `${hours}時${minutes}分`;
  return `${minutes}分`;
}

export function pct(value: number | undefined, digits = 0): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  return `${value.toFixed(digits)}%`;
}

export const TASK_TYPE_LABELS: Record<string, string> = {
  short_chat: "簡短問答",
  general_chat: "一般問答",
  coding: "Coding",
  large_context: "Large Context",
  research: "研究",
  custom: "自訂",
};

export const SOURCE_LABELS: Record<string, string> = {
  manual: "手動輸入",
  json_import: "JSON 匯入",
  demo: "Demo",
  cli: "CLI",
  browser: "Browser",
  api: "API",
};

export const EVENT_TYPE_LABELS: Record<string, string> = {
  quota_expiring: "額度即將到期",
  reset_expected: "預計重置",
  reset_confirmed: "臨時／提前重置",
  usage_warning: "即將用完",
  exhaustion_forecast: "耗盡預測",
  polling_failed: "同步失敗",
  data_stale: "資料過期",
};

/** Provider branding (mark + colour) — carried over from the original dashboard prototype. */
export const PROVIDER_BRANDS: Record<string, { label: string; mark: string; color: string }> = {
  codex: { label: "Codex", mark: "CX", color: "#23b5a5" },
  claude: { label: "Claude", mark: "CL", color: "#d97757" },
  chatgpt: { label: "ChatGPT", mark: "GP", color: "#7c6ce7" },
  gemini: { label: "Gemini", mark: "GE", color: "#4385f5" },
  cursor: { label: "Cursor", mark: "CU", color: "#656b78" },
  custom: { label: "自訂", mark: "AI", color: "#656b78" },
};

export const CHANNEL_TYPE_LABELS: Record<string, string> = {
  desktop: "桌面通知",
  discord: "Discord",
  slack: "Slack",
  telegram: "Telegram",
  custom_webhook: "自訂 Webhook",
};
