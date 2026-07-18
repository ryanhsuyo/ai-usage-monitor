// Central registry of app_settings keys + defaults (spec §6 defaults).

export const SETTINGS_KEYS = {
  notificationsEnabled: "notifications.enabled",
  limitEventPreferences: "notifications.limitEventPreferences",
  limitUsageWarningThresholds: "notifications.limitUsageWarningThresholds",
  pollingEnabled: "polling.enabled",
  pollingIntervalHours: "polling.intervalHours",
  backgroundEnabled: "background.enabled",
  autostartEnabled: "autostart.enabled",
  timezone: "app.timezone",
  usageWarningRemainingPercent: "thresholds.usageWarningRemainingPercent",
  dataStaleHours: "thresholds.dataStaleHours",
  exhaustionWarningLeadHours: "thresholds.exhaustionWarningLeadHours",
  demoMode: "app.demoMode",
  onboardingCompleted: "app.onboardingCompleted",
  monitoringPaused: "monitoring.paused",
  secretBackend: "app.secretBackend",
  stripSize: "widget.stripSize",
  stripRightInfo: "widget.stripRightInfo",
  widgetIdleOpacity: "widget.idleOpacity",
  widgetHoverOpaque: "widget.hoverOpaque",
} as const;

export const SETTINGS_DEFAULTS: Record<string, string> = {
  [SETTINGS_KEYS.notificationsEnabled]: "true",
  [SETTINGS_KEYS.limitEventPreferences]: "{}",
  [SETTINGS_KEYS.limitUsageWarningThresholds]: "{}",
  [SETTINGS_KEYS.pollingEnabled]: "true",
  [SETTINGS_KEYS.pollingIntervalHours]: "1",
  [SETTINGS_KEYS.backgroundEnabled]: "true",
  [SETTINGS_KEYS.autostartEnabled]: "false",
  [SETTINGS_KEYS.usageWarningRemainingPercent]: "15",
  [SETTINGS_KEYS.dataStaleHours]: "8",
  [SETTINGS_KEYS.exhaustionWarningLeadHours]: "6",
  [SETTINGS_KEYS.demoMode]: "false",
  [SETTINGS_KEYS.onboardingCompleted]: "false",
  [SETTINGS_KEYS.monitoringPaused]: "false",
  [SETTINGS_KEYS.stripSize]: "medium",
  [SETTINGS_KEYS.stripRightInfo]: "both",
  [SETTINGS_KEYS.widgetIdleOpacity]: "72",
  [SETTINGS_KEYS.widgetHoverOpaque]: "true",
};

export type StripSize = "small" | "medium" | "large";
export type StripRightInfo = "reset" | "exhaustion" | "both" | "cost";

export function settingStripSize(value: string | undefined): StripSize {
  return value === "small" || value === "large" ? value : "medium";
}

export function settingStripRightInfo(value: string | undefined): StripRightInfo {
  return value === "reset" || value === "exhaustion" || value === "cost" ? value : "both";
}

export function settingBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value === "true";
}

export function settingNum(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
