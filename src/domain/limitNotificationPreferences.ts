import type { NotificationEventType } from "./types";

export const DEFAULT_CHANNEL_EVENT_PREFERENCES: Record<NotificationEventType, boolean> = {
  quota_expiring: true,
  reset_expected: true,
  reset_confirmed: true,
  usage_warning: true,
  exhaustion_forecast: true,
  polling_failed: false,
  data_stale: false,
};

export function isChannelNotificationEventEnabled(
  preferences: Partial<Record<NotificationEventType, boolean>>,
  eventType: NotificationEventType
): boolean {
  return preferences[eventType] ?? DEFAULT_CHANNEL_EVENT_PREFERENCES[eventType];
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
  return preferences[limitId]?.[eventType] !== false;
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
