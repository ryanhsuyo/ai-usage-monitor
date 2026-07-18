import { RUNWAY } from "./constants";
import type { ForecastResult } from "./types";
import { clamp, hoursBetween } from "./util";

export type RunwayStatus = "insufficient_data" | "comfortable" | "watch" | "slow_down";

export type UsageRunway = {
  safeDailyBudget?: number;
  currentDailyPace?: number;
  paceRatio?: number;
  paceDifferencePercent?: number;
  status: RunwayStatus;
};

export function computeUsageRunway(input: {
  forecast?: ForecastResult;
  remainingPercent: number;
  now: string;
  resetAt?: string;
}): UsageRunway {
  if (!input.forecast || !input.resetAt) return { status: "insufficient_data" };
  const hoursUntilReset = hoursBetween(input.now, input.resetAt);
  if (!Number.isFinite(hoursUntilReset) || hoursUntilReset <= 0) return { status: "insufficient_data" };

  const remaining = clamp(input.remainingPercent, 0, 100);
  const safeHourlyPace = remaining / hoursUntilReset;
  const safeDailyBudget = Math.min(remaining, safeHourlyPace * 24);
  const actualHourlyPace = input.forecast.burnRate24h
    ?? input.forecast.burnRateCurrentCycle
    ?? input.forecast.burnRate6h;

  if (actualHourlyPace === undefined || !Number.isFinite(actualHourlyPace)) {
    return { safeDailyBudget, status: "insufficient_data" };
  }

  const currentDailyPace = Math.max(0, actualHourlyPace * 24);
  const paceRatio = safeHourlyPace > 0 ? Math.max(0, actualHourlyPace) / safeHourlyPace : Number.POSITIVE_INFINITY;
  const paceDifferencePercent = Number.isFinite(paceRatio) ? (paceRatio - 1) * 100 : 100;
  const status = paceRatio > RUNWAY.SLOW_DOWN_PACE_RATIO
    ? "slow_down"
    : paceRatio > RUNWAY.COMFORTABLE_PACE_RATIO
      ? "watch"
      : "comfortable";

  return { safeDailyBudget, currentDailyPace, paceRatio, paceDifferencePercent, status };
}
