// View-model derivation: turns stored snapshots/resets/activities into the inputs the domain
// calculators need. Pure; no I/O.

import type { CycleSummary } from "@/domain/planRecommendation";
import type { ResetEvent, UsageSnapshot } from "@/domain/types";

const EXHAUSTED_AT = 98; // used% considered "effectively exhausted" for cycle summaries

/**
 * Split the snapshot history into cycles using confirmed reset events as boundaries and summarize
 * each COMPLETED cycle for the plan recommender. The current (open) cycle is excluded.
 */
export function buildCycleSummaries(
  snapshots: UsageSnapshot[],
  resetEvents: ResetEvent[]
): CycleSummary[] {
  const valid = snapshots
    .filter((s) => s.valid)
    .slice()
    .sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt));
  const confirmed = resetEvents
    .filter((e) => e.detectionMethod !== "expected_time_reached")
    .slice()
    .sort((a, b) => Date.parse(a.detectedAt) - Date.parse(b.detectedAt));

  if (valid.length === 0 || confirmed.length === 0) return [];

  const summaries: CycleSummary[] = [];
  let cycleStart = Date.parse(valid[0]!.capturedAt);

  for (const reset of confirmed) {
    const cycleEnd = Date.parse(reset.detectedAt);
    const inCycle = valid.filter((s) => {
      const t = Date.parse(s.capturedAt);
      return t >= cycleStart && t < cycleEnd;
    });
    if (inCycle.length >= 2) {
      const peak = Math.max(...inCycle.map((s) => s.usedPercent));
      const exhausted = inCycle.find((s) => s.usedPercent >= EXHAUSTED_AT);
      const resetTarget = reset.expectedResetAt ? Date.parse(reset.expectedResetAt) : cycleEnd;
      const earlyHours = exhausted
        ? Math.max(0, (resetTarget - Date.parse(exhausted.capturedAt)) / 3600_000)
        : 0;
      summaries.push({
        utilization: peak,
        exhaustedEarly: Boolean(exhausted) && earlyHours > 0.5,
        earlyHours,
      });
    }
    cycleStart = cycleEnd;
  }
  return summaries;
}

/** Days spanned by valid data (for the 28-day plan-recommendation gate). */
export function daysOfData(snapshots: UsageSnapshot[]): number {
  const valid = snapshots.filter((s) => s.valid);
  if (valid.length < 2) return 0;
  const times = valid.map((s) => Date.parse(s.capturedAt));
  return (Math.max(...times) - Math.min(...times)) / (24 * 3600_000);
}

/** Latest valid snapshot (the "current" reading). */
export function latestValid(snapshots: UsageSnapshot[]): UsageSnapshot | undefined {
  return snapshots
    .filter((s) => s.valid)
    .slice()
    .sort((a, b) => Date.parse(b.capturedAt) - Date.parse(a.capturedAt))[0];
}

/** Start of the current cycle = last confirmed reset, if any. */
export function currentCycleStart(resetEvents: ResetEvent[]): string | undefined {
  const confirmed = resetEvents
    .filter((e) => e.detectionMethod !== "expected_time_reached")
    .sort((a, b) => Date.parse(b.detectedAt) - Date.parse(a.detectedAt));
  return confirmed[0]?.detectedAt;
}
