// Remaining-task estimate (spec §11). Pure. Produces a RANGE, never a single precise number,
// and requires at least MIN_SAMPLES valid same-type activities.

import { computeConfidence } from "./confidence";
import { REMAINING_TASKS } from "./constants";
import type { RemainingTaskEstimate, TaskType, UsageActivity } from "./types";
import { clamp, median, quantile, withoutOutliers } from "./util";

export type RemainingTasksInput = {
  taskType: TaskType;
  activities: UsageActivity[]; // any set; filtered internally by taskType + positive delta
  currentUsedPercent: number;
  manualOnly?: boolean;
};

export function estimateRemainingTasks(input: RemainingTasksInput): RemainingTaskEstimate {
  const warnings: string[] = [];

  const deltas = input.activities
    .filter(
      (a) =>
        a.taskType === input.taskType &&
        a.status === "completed" &&
        typeof a.usageDelta === "number" &&
        Number.isFinite(a.usageDelta) &&
        (a.usageDelta as number) > 0 // ignore <= 0 and cross-reset noise
    )
    .map((a) => a.usageDelta as number);

  if (deltas.length < REMAINING_TASKS.MIN_SAMPLES) {
    return {
      taskType: input.taskType,
      minimum: 0,
      maximum: 0,
      sampleCount: deltas.length,
      confidence: computeConfidence({ sampleCount: deltas.length }).value,
      warnings: [
        `至少需要 ${REMAINING_TASKS.MIN_SAMPLES} 筆有效的同類活動紀錄才能估算（目前 ${deltas.length} 筆）。`,
      ],
    };
  }

  const cleaned = withoutOutliers(deltas, REMAINING_TASKS.OUTLIER_IQR_FACTOR);
  const excluded = deltas.length - cleaned.length;
  if (excluded > 0) warnings.push("已排除異常的用量樣本");

  const available = clamp(100 - input.currentUsedPercent, 0, 100);
  const lowerQ = quantile(cleaned, 0.25) as number; // smaller delta → more tasks (maximum)
  const upperQ = quantile(cleaned, 0.75) as number; // larger delta → fewer tasks (minimum)
  const med = median([...cleaned].sort((a, b) => a - b));

  const minimum = upperQ > 0 ? Math.floor(available / upperQ) : 0;
  const maximum = lowerQ > 0 ? Math.floor(available / lowerQ) : 0;

  if (available <= 0) warnings.push("目前額度已用盡，無法再進行同類任務");

  const conf = computeConfidence({
    sampleCount: cleaned.length,
    manualOnly: input.manualOnly,
    outlierCount: excluded,
  });

  return {
    taskType: input.taskType,
    minimum: Math.min(minimum, maximum),
    maximum: Math.max(minimum, maximum),
    medianUsageDelta: med,
    sampleCount: cleaned.length,
    confidence: conf.value,
    warnings: [...new Set([...warnings, ...conf.reasons])],
  };
}
