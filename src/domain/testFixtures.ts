// Shared builders for domain tests. Not shipped in the app bundle (only imported by *.test.ts).

import type { UsageActivity, UsageSnapshot, TaskType } from "./types";

export const T0 = "2026-07-13T00:00:00.000Z";

export function at(hoursFromT0: number): string {
  return new Date(Date.parse(T0) + hoursFromT0 * 3600_000).toISOString();
}

let seq = 0;

export function snap(partial: Partial<UsageSnapshot> & { usedPercent: number; capturedAt: string }): UsageSnapshot {
  seq += 1;
  return {
    id: `snap-${seq}`,
    providerId: "claude",
    accountId: "acc-1",
    limitId: "limit-1",
    remainingPercent: 100 - partial.usedPercent,
    source: "manual",
    valid: true,
    confidence: 1,
    ...partial,
  };
}

export function activity(
  partial: Partial<UsageActivity> & { taskType: TaskType; usageDelta?: number }
): UsageActivity {
  seq += 1;
  return {
    id: `act-${seq}`,
    providerId: "claude",
    accountId: "acc-1",
    limitId: "limit-1",
    startedAt: at(0),
    endedAt: at(1),
    status: "completed",
    ...partial,
  };
}
