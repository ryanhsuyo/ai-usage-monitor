// Burn-rate computation (spec §11). Pure. Percentage-points consumed per hour.
//
// Rules enforced here:
//  - only VALID snapshots are considered;
//  - the caller passes snapshots for a single account+limit (we still sort defensively);
//  - capturedAt must be strictly increasing — near-simultaneous points (< MIN_INTERVAL) are merged;
//  - a usage DROP (delta < 0) is never counted as burn (covers "down without confirmed reset");
//  - segment-level outliers are excluded via IQR and surfaced as warnings;
//  - fewer / sparser data lowers confidence (reported via sampleCount and warnings).

import { BURN_RATE, TIME } from "./constants";
import type { UsageSnapshot } from "./types";
import { hoursBetween, outlierCount, withoutOutliers } from "./util";

export type BurnSegment = {
  fromIso: string;
  toIso: string;
  delta: number; // positive percentage points
  hours: number;
  rate: number; // delta / hours
};

export type BurnWindowResult = {
  rate?: number;
  segmentCount: number;
  outliersExcluded: number;
};

export type BurnRateResult = {
  burnRate6h?: number;
  burnRate24h?: number;
  burnRateCurrentCycle?: number;
  segments: BurnSegment[];
  window6h: BurnWindowResult;
  window24h: BurnWindowResult;
  cycle: BurnWindowResult;
  warnings: string[];
};

export type BurnRateOptions = {
  now: string;
  /** Start of the current cycle (e.g. last reset time). Segments before this are excluded from the cycle rate. */
  cycleStartIso?: string;
};

/** Merge/sort valid snapshots into a monotonic series with points at least MIN_INTERVAL apart. */
export function normalizeSeries(snapshots: UsageSnapshot[]): UsageSnapshot[] {
  const valid = snapshots
    .filter((s) => s.valid && Number.isFinite(s.usedPercent))
    .slice()
    .sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt));

  const kept: UsageSnapshot[] = [];
  for (const s of valid) {
    const last = kept[kept.length - 1];
    if (!last) {
      kept.push(s);
      continue;
    }
    const gapHours = hoursBetween(last.capturedAt, s.capturedAt);
    if (gapHours * 60 >= TIME.MIN_INTERVAL_MINUTES) {
      kept.push(s);
    }
    // else: too close to the previous kept point — treated as the same reading, skipped.
  }
  return kept;
}

function buildSegments(series: UsageSnapshot[]): BurnSegment[] {
  const segments: BurnSegment[] = [];
  for (let i = 1; i < series.length; i++) {
    const prev = series[i - 1] as UsageSnapshot;
    const curr = series[i] as UsageSnapshot;
    const delta = curr.usedPercent - prev.usedPercent;
    const hours = hoursBetween(prev.capturedAt, curr.capturedAt);
    if (hours <= 0) continue;
    if (delta < 0) continue; // a drop is never burn
    segments.push({
      fromIso: prev.capturedAt,
      toIso: curr.capturedAt,
      delta,
      hours,
      rate: delta / hours,
    });
  }
  return segments;
}

function rateOver(segments: BurnSegment[]): BurnWindowResult {
  if (segments.length === 0) return { rate: undefined, segmentCount: 0, outliersExcluded: 0 };
  const rates = segments.map((s) => s.rate);
  const excluded = outlierCount(rates, BURN_RATE.OUTLIER_IQR_FACTOR);
  const keptRates = new Set(withoutOutliers(rates, BURN_RATE.OUTLIER_IQR_FACTOR));
  const kept = segments.filter((s) => keptRates.has(s.rate));
  const use = kept.length > 0 ? kept : segments;
  const sumDelta = use.reduce((a, s) => a + s.delta, 0);
  const sumHours = use.reduce((a, s) => a + s.hours, 0);
  return {
    rate: sumHours > 0 ? sumDelta / sumHours : undefined,
    segmentCount: use.length,
    outliersExcluded: excluded,
  };
}

export function computeBurnRates(
  snapshots: UsageSnapshot[],
  opts: BurnRateOptions
): BurnRateResult {
  const warnings: string[] = [];
  const series = normalizeSeries(snapshots);
  const segments = buildSegments(series);

  const nowMs = Date.parse(opts.now);
  const within = (seg: BurnSegment, hours: number): boolean =>
    Date.parse(seg.toIso) >= nowMs - hours * TIME.HOUR_MS;

  const seg6 = segments.filter((s) => within(s, BURN_RATE.WINDOW_6H_HOURS));
  const seg24 = segments.filter((s) => within(s, BURN_RATE.WINDOW_24H_HOURS));
  const segCycle = opts.cycleStartIso
    ? segments.filter((s) => Date.parse(s.fromIso) >= Date.parse(opts.cycleStartIso as string))
    : segments;

  const window6h = rateOver(seg6);
  const window24h = rateOver(seg24);
  const cycle = rateOver(segCycle);

  if (segments.length === 0) {
    warnings.push("尚無足夠的用量變化可計算消耗速度");
  }
  const totalExcluded = window6h.outliersExcluded + window24h.outliersExcluded + cycle.outliersExcluded;
  if (totalExcluded > 0) {
    warnings.push("已排除異常的消耗速度樣本");
  }

  return {
    burnRate6h: window6h.rate,
    burnRate24h: window24h.rate,
    burnRateCurrentCycle: cycle.rate,
    segments,
    window6h,
    window24h,
    cycle,
    warnings,
  };
}
