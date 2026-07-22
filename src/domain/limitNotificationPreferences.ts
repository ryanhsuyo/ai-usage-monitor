import type { NotificationEventType } from "./types";

/**
 * What is announced out of the box, for both channels and individual limits.
 *
 * The default set is deliberately small — one notice per state the user has to act on: the quota
 * came back, it is nearly gone, it is gone, and a Codex reset credit is worth spending. Predictive
 * ("可能在重置前用完") and diagnostic ("預計重置時間到了但沒有新資料") events fire on states that
 * later resolve themselves, so they arrive far more often than they turn out to matter; they stay
 * available per limit but off unless asked for.
 */
export const DEFAULT_EVENT_PREFERENCES: Record<NotificationEventType, boolean> = {
  quota_expiring: true,
  reset_confirmed: true,
  usage_warning: true,
  usage_exhausted: true,
  reset_expected: false,
  exhaustion_forecast: false,
  polling_failed: false,
  data_stale: false,
};

export function isChannelNotificationEventEnabled(
  preferences: Partial<Record<NotificationEventType, boolean>>,
  eventType: NotificationEventType
): boolean {
  return preferences[eventType] ?? DEFAULT_EVENT_PREFERENCES[eventType];
}

export type LimitNotificationPreferences = Record<
  string,
  Partial<Record<NotificationEventType, boolean>>
>;

export type LimitUsageWarningThresholds = Record<string, number>;

export function parseLimitUsageWarningThresholds(raw: string | undefined): LimitUsageWarningThresholds {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, number] =>
      typeof entry[1] === "number" && Number.isFinite(entry[1]) && entry[1] >= 1 && entry[1] <= 50
    ));
  } catch {
    return {};
  }
}

export function limitUsageWarningThreshold(
  thresholds: LimitUsageWarningThresholds,
  limitId: string,
  fallback: number
): number {
  return thresholds[limitId] ?? fallback;
}

export function setLimitUsageWarningThreshold(
  thresholds: LimitUsageWarningThresholds,
  limitId: string,
  value: number
): LimitUsageWarningThresholds {
  return { ...thresholds, [limitId]: Math.min(50, Math.max(1, Math.round(value))) };
}

export function parseLimitNotificationPreferences(raw: string | undefined): LimitNotificationPreferences {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as LimitNotificationPreferences;
  } catch {
    return {};
  }
}

export function isLimitNotificationEventEnabled(
  preferences: LimitNotificationPreferences,
  limitId: string,
  eventType: NotificationEventType
): boolean {
  // Unset falls through to the shared defaults rather than "on", so a limit the user has never
  // opened announces the same events a channel does.
  return preferences[limitId]?.[eventType] ?? DEFAULT_EVENT_PREFERENCES[eventType];
}

export function setLimitNotificationEvent(
  preferences: LimitNotificationPreferences,
  limitId: string,
  eventType: NotificationEventType,
  enabled: boolean
): LimitNotificationPreferences {
  return {
    ...preferences,
    [limitId]: { ...preferences[limitId], [eventType]: enabled },
  };
}
