// Forecast: estimated exhaustion time + estimated remaining at reset (spec §11). Pure.

import { computeBurnRates, type BurnRateResult } from "./burnRate";
import { computeConfidence } from "./confidence";
import type { DataSourceReliability, ForecastResult, UsageSnapshot } from "./types";
import { clamp, hoursBetween } from "./util";

export type ForecastInput = {
  limitId: string;
  snapshots: UsageSnapshot[];
  /** The latest valid snapshot used as "current". If omitted, the most recent valid snapshot is used. */
  now: string;
  /** Next reset time, if known. */
  resetAt?: string;
  /** Start of the current cycle (last reset), used for the cycle burn rate. */
  cycleStartIso?: string;
  manualOnly?: boolean;
  sourceReliability?: DataSourceReliability;
};

/** Burn-rate selection order: 24h (if enough) → current cycle → 6h (low confidence). */
export function selectBurnRate(burn: BurnRateResult): {
  rate?: number;
  basis: "24h" | "cycle" | "6h" | "none";
  lowConfidenceBasis: boolean;
} {
  if (burn.window24h.rate !== undefined && burn.window24h.segmentCount >= 2) {
    return { rate: burn.window24h.rate, basis: "24h", lowConfidenceBasis: false };
  }
  if (burn.cycle.rate !== undefined && burn.cycle.segmentCount >= 1) {
    return { rate: burn.cycle.rate, basis: "cycle", lowConfidenceBasis: false };
  }
  if (burn.window6h.rate !== undefined) {
    return { rate: burn.window6h.rate, basis: "6h", lowConfidenceBasis: true };
  }
  return { rate: undefined, basis: "none", lowConfidenceBasis: true };
}

function latestValid(snapshots: UsageSnapshot[]): UsageSnapshot | undefined {
  return snapshots
    .filter((s) => s.valid && Number.isFinite(s.usedPercent))
    .slice()
    .sort((a, b) => Date.parse(b.capturedAt) - Date.parse(a.capturedAt))[0];
}

export function computeForecast(input: ForecastInput): ForecastResult {
  const warnings: string[] = [];
  const current = latestValid(input.snapshots);
  const burn = computeBurnRates(input.snapshots, {
    now: input.now,
    cycleStartIso: input.cycleStartIso,
  });

  const validSampleCount = burn.segments.length;

  if (!current) {
    return {
      limitId: input.limitId,
      calculatedAt: input.now,
      confidence: 0,
      sampleCount: 0,
      warnings: ["沒有有效的用量快照可供預測"],
      burnRate6h: burn.burnRate6h,
      burnRate24h: burn.burnRate24h,
      burnRateCurrentCycle: burn.burnRateCurrentCycle,
    };
  }

  const selected = selectBurnRate(burn);
  const usedPercent = current.usedPercent;
  const remainingPercent = clamp(100 - usedPercent, 0, 100);

  let estimatedExhaustionAt: string | undefined;
  let willExhaustBeforeReset: boolean | undefined;
  let estimatedRemainingAtReset: number | undefined;

  if (selected.rate !== undefined && selected.rate > 0) {
    const hoursToExhaust = remainingPercent / selected.rate;
    estimatedExhaustionAt = new Date(
      Date.parse(input.now) + hoursToExhaust * 60 * 60 * 1000
    ).toISOString();

    if (input.resetAt) {
      const hoursUntilReset = hoursBetween(input.now, input.resetAt);
      if (hoursUntilReset > 0) {
        willExhaustBeforeReset = hoursToExhaust < hoursUntilReset;
        const usageAtReset = usedPercent + selected.rate * hoursUntilReset;
        estimatedRemainingAtReset = clamp(100 - usageAtReset, 0, 100);
      }
    }
  } else {
    if (selected.rate === undefined) {
      warnings.push("依目前資料尚無法估算消耗速度");
    } else {
      warnings.push("目前消耗速度為零或下降，暫不提供耗盡時間");
    }
    // With no positive burn, nothing is consumed before reset.
    if (input.resetAt) {
      estimatedRemainingAtReset = remainingPercent;
      willExhaustBeforeReset = false;
    }
  }

  if (selected.lowConfidenceBasis && selected.rate !== undefined) {
    warnings.push("僅有短期資料，預測可信度較低");
  }
  warnings.push(...burn.warnings);

  const ageHours = hoursBetween(current.capturedAt, input.now);
  const conf = computeConfidence({
    sampleCount: Math.max(validSampleCount, 1),
    ageHoursOfLatest: ageHours,
    manualOnly: input.manualOnly,
    sourceReliability: input.sourceReliability,
    outlierCount:
      burn.window24h.outliersExcluded +
      burn.window6h.outliersExcluded +
      burn.cycle.outliersExcluded,
  });
  // Short-basis forecasts are additionally penalised.
  const confValue = selected.lowConfidenceBasis ? conf.value * 0.7 : conf.value;

  return {
    limitId: input.limitId,
    calculatedAt: input.now,
    estimatedExhaustionAt,
    estimatedRemainingAtReset,
    willExhaustBeforeReset,
    burnRate6h: burn.burnRate6h,
    burnRate24h: burn.burnRate24h,
    burnRateCurrentCycle: burn.burnRateCurrentCycle,
    confidence: clamp(confValue, 0, 1),
    sampleCount: validSampleCount,
    warnings: [...new Set([...warnings, ...conf.reasons])],
  };
}
