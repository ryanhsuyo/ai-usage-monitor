// Plan recommendation (spec §11). Pure. All thresholds come from constants (never hardcoded here).
// Plans are never treated as precise token capacities — this reasons purely about utilization.

import { computeConfidence } from "./confidence";
import { PLAN_RECOMMENDATION as P } from "./constants";
import type { PlanRecommendation } from "./types";

export type CycleSummary = {
  /** Peak utilization reached during the cycle, 0..100. */
  utilization: number;
  /** Whether the limit was exhausted before its reset. */
  exhaustedEarly: boolean;
  /** How many hours before reset exhaustion occurred (0 if it did not). */
  earlyHours: number;
  /** Whether extra credits were needed during the cycle. */
  usedExtraCredits?: boolean;
};

export type PlanRecommendationInput = {
  cycles: CycleSummary[];
  totalDaysOfData: number;
};

function avg(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

export function recommendPlan(input: PlanRecommendationInput): PlanRecommendation {
  const complete = input.cycles;
  const hasEnough = complete.length >= P.MIN_CYCLES || input.totalDaysOfData >= P.MIN_DAYS;

  if (!hasEnough) {
    return {
      recommendation: "insufficient_data",
      confidence: computeConfidence({ sampleCount: complete.length, healthySampleCount: P.MIN_CYCLES })
        .value,
      reasons: [
        `需要至少 ${P.MIN_CYCLES} 個完整週期或 ${P.MIN_DAYS} 天有效資料（目前 ${complete.length} 週期 / ${input.totalDaysOfData} 天）。`,
      ],
      evaluatedCycles: complete.length,
    };
  }

  // Evaluate the most recent up-to-4 complete cycles.
  const recent = complete.slice(-P.MIN_CYCLES);
  const avgUtil = avg(recent.map((c) => c.utilization));
  const earlyCycles = recent.filter((c) => c.exhaustedEarly);
  const earlyExhaustedCycles = earlyCycles.length;
  const avgEarlyHours = avg(earlyCycles.map((c) => c.earlyHours));
  const frequentExtraCredits =
    recent.filter((c) => c.usedExtraCredits).length >= Math.ceil(recent.length / 2);

  const conf = computeConfidence({
    sampleCount: recent.length,
    healthySampleCount: P.MIN_CYCLES,
  });

  const base = {
    confidence: conf.value,
    fourWeekAverageUtilization: Math.round(avgUtil * 10) / 10,
    earlyExhaustedCycles,
    evaluatedCycles: recent.length,
  };

  // Upgrade
  if (
    earlyExhaustedCycles >= P.UPGRADE_MIN_EARLY_EXHAUSTED_CYCLES &&
    avgUtil >= P.UPGRADE_MIN_AVG_UTILIZATION &&
    avgEarlyHours >= P.UPGRADE_MIN_AVG_EARLY_HOURS
  ) {
    return {
      ...base,
      recommendation: "upgrade",
      reasons: [
        `最近 ${recent.length} 個週期中有 ${earlyExhaustedCycles} 個提前用完`,
        `平均利用率約 ${base.fourWeekAverageUtilization}%`,
        `平均提前耗盡約 ${Math.round(avgEarlyHours)} 小時`,
      ],
    };
  }

  // Downgrade
  if (
    avgUtil < P.DOWNGRADE_MAX_AVG_UTILIZATION &&
    earlyExhaustedCycles === 0 &&
    !frequentExtraCredits
  ) {
    return {
      ...base,
      recommendation: "downgrade",
      reasons: [
        `平均利用率僅約 ${base.fourWeekAverageUtilization}%`,
        "近期沒有任何週期提前用完",
        "沒有經常使用額外 Credits",
      ],
    };
  }

  // Keep (default)
  const keepReasons: string[] = [];
  if (avgUtil >= P.KEEP_MIN_UTILIZATION && avgUtil <= P.KEEP_MAX_UTILIZATION) {
    keepReasons.push(`平均利用率約 ${base.fourWeekAverageUtilization}%，落在合理範圍`);
  } else if (earlyExhaustedCycles > 0) {
    keepReasons.push("偶爾提前用完，但尚未達到建議升級的標準");
  } else {
    keepReasons.push("目前使用模式與方案大致相符");
  }
  return { ...base, recommendation: "keep", reasons: keepReasons };
}
