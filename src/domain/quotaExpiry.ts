import { THRESHOLDS } from "./constants";
import { hoursBetween, isValidIso } from "./util";

export type QuotaExpiryInsight = {
  expiring: boolean;
  hoursUntilReset?: number;
  warningLeadHours?: number;
  suggestedPercentPerHour?: number;
};

export function computeQuotaExpiry(input: {
  now: string;
  resetAt?: string;
  remainingPercent?: number;
  windowHours?: number;
}): QuotaExpiryInsight {
  if (!input.resetAt || !isValidIso(input.now) || !isValidIso(input.resetAt)) return { expiring: false };
  if (input.remainingPercent === undefined || !Number.isFinite(input.remainingPercent)) return { expiring: false };
  const hoursUntilReset = hoursBetween(input.now, input.resetAt);
  if (hoursUntilReset <= 0) return { expiring: false, hoursUntilReset };
  const warningLeadHours = Math.min(
    THRESHOLDS.QUOTA_EXPIRY_MAX_LEAD_HOURS,
    Math.max(THRESHOLDS.QUOTA_EXPIRY_MIN_LEAD_HOURS, (input.windowHours ?? 120) * THRESHOLDS.QUOTA_EXPIRY_WINDOW_RATIO)
  );
  const expiring = hoursUntilReset <= warningLeadHours
    && input.remainingPercent >= THRESHOLDS.QUOTA_EXPIRY_MIN_REMAINING_PERCENT;
  return {
    expiring,
    hoursUntilReset,
    warningLeadHours,
    suggestedPercentPerHour: expiring ? input.remainingPercent / hoursUntilReset : undefined,
  };
}
