// Confidence scoring (spec §12). Produces a value in [0,1], a level, and the human-readable
// reasons behind it. Every forecast / estimate / recommendation carries one of these.

import { CONFIDENCE } from "./constants";
import type { ConfidenceLevel, ConfidenceResult, DataSourceReliability } from "./types";
import { clamp } from "./util";

export type ConfidenceFactors = {
  /** Number of usable data points behind the result. */
  sampleCount: number;
  /** Sample count considered "healthy" (full marks). Defaults to 6. */
  healthySampleCount?: number;
  /** Age in hours of the most recent successful data point. */
  ageHoursOfLatest?: number;
  /** True when all inputs came from manual entry. */
  manualOnly?: boolean;
  /** True when the window spans a reset boundary. */
  crossReset?: boolean;
  /** Number of outliers detected among the inputs. */
  outlierCount?: number;
  /** Coefficient of variation (stddev/mean) of the underlying data, if meaningful. */
  variability?: number;
  /** True when there are notable gaps in the series. */
  hasGaps?: boolean;
  /** Reliability of the originating data source. */
  sourceReliability?: DataSourceReliability;
};

export function levelFor(value: number): ConfidenceLevel {
  if (value <= CONFIDENCE.LOW_MAX) return "low";
  if (value <= CONFIDENCE.MEDIUM_MAX) return "medium";
  return "high";
}

export function computeConfidence(f: ConfidenceFactors): ConfidenceResult {
  const reasons: string[] = [];
  let value = 1;

  const healthy = f.healthySampleCount ?? 6;
  if (f.sampleCount <= 0) {
    return { value: 0, level: "low", reasons: ["沒有可用的資料"] };
  }
  // Sample-count factor scales linearly up to `healthy`.
  const sampleFactor = clamp(f.sampleCount / healthy, 0.15, 1);
  value *= sampleFactor;
  if (f.sampleCount < healthy) {
    reasons.push(`只有 ${f.sampleCount} 筆有效資料`);
  }

  // Freshness.
  if (f.ageHoursOfLatest !== undefined) {
    if (f.ageHoursOfLatest >= CONFIDENCE.STALE_AFTER_HOURS) {
      value *= 0.45;
      reasons.push(`最近一次成功更新已超過 ${Math.round(f.ageHoursOfLatest)} 小時`);
    } else if (f.ageHoursOfLatest > CONFIDENCE.FRESH_WITHIN_HOURS) {
      const decay = clamp(
        1 - (f.ageHoursOfLatest - CONFIDENCE.FRESH_WITHIN_HOURS) /
          (CONFIDENCE.STALE_AFTER_HOURS * 1.5),
        0.6,
        1
      );
      value *= decay;
    }
  }

  if (f.manualOnly) {
    value *= 0.85;
    reasons.push("目前資料全部來自手動輸入");
  }

  if (f.crossReset) {
    value *= 0.7;
    reasons.push("資料區間跨越了一次重置");
  }

  if (f.outlierCount && f.outlierCount > 0) {
    value *= clamp(1 - 0.1 * f.outlierCount, 0.5, 1);
    reasons.push(`偵測到 ${f.outlierCount} 筆極端值`);
  }

  if (f.variability !== undefined && f.variability > 0.6) {
    value *= 0.8;
    reasons.push("消耗速度變化較大");
  }

  if (f.hasGaps) {
    value *= 0.85;
    reasons.push("資料序列有缺漏");
  }

  switch (f.sourceReliability) {
    case "demo":
      reasons.push("資料來自 Demo 範例");
      break;
    case "imported":
      value *= 0.95;
      break;
    default:
      break;
  }

  value = clamp(value, 0, 1);
  return { value, level: levelFor(value), reasons };
}
