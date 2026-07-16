import { describe, expect, it } from "vitest";
import { REMAINING_TASKS } from "./constants";
import { estimateRemainingTasks } from "./remainingTasks";
import { activity } from "./testFixtures";

describe("remaining task estimate (spec §11 / §20 cases 9,10,11)", () => {
  it("case 9: fewer than 3 samples → insufficient data, no fake range", () => {
    const est = estimateRemainingTasks({
      taskType: "coding",
      activities: [
        activity({ taskType: "coding", usageDelta: 5 }),
        activity({ taskType: "coding", usageDelta: 6 }),
      ],
      currentUsedPercent: 40,
    });
    expect(est.sampleCount).toBe(2);
    expect(est.minimum).toBe(0);
    expect(est.maximum).toBe(0);
    expect(est.warnings.some((w) => w.includes(`${REMAINING_TASKS.MIN_SAMPLES}`))).toBe(true);
  });

  it("case 10: usageDelta <= 0 activities are ignored", () => {
    const est = estimateRemainingTasks({
      taskType: "coding",
      activities: [
        activity({ taskType: "coding", usageDelta: 0 }),
        activity({ taskType: "coding", usageDelta: -3 }),
        activity({ taskType: "coding", usageDelta: 5 }),
        activity({ taskType: "coding", usageDelta: 5 }),
      ],
      currentUsedPercent: 40,
    });
    // only two positive deltas → still insufficient
    expect(est.sampleCount).toBe(2);
    expect(est.minimum).toBe(0);
    expect(est.maximum).toBe(0);
  });

  it("produces a floor()-based range from quartiles with enough samples", () => {
    const est = estimateRemainingTasks({
      taskType: "coding",
      activities: [4, 5, 5, 6].map((d) => activity({ taskType: "coding", usageDelta: d })),
      currentUsedPercent: 40, // 60 available
    });
    expect(est.sampleCount).toBe(4);
    // q1=4.75, q3=5.25 → min=floor(60/5.25)=11, max=floor(60/4.75)=12
    expect(est.minimum).toBe(11);
    expect(est.maximum).toBe(12);
    expect(est.medianUsageDelta).toBe(5);
    expect(est.minimum).toBeLessThanOrEqual(est.maximum);
  });

  it("case 11: extreme deltas are excluded from the range", () => {
    const est = estimateRemainingTasks({
      taskType: "coding",
      activities: [5, 5, 5, 5, 5, 60].map((d) => activity({ taskType: "coding", usageDelta: d })),
      currentUsedPercent: 50, // 50 available
    });
    // the 60pp outlier must not crush the minimum to 0
    expect(est.minimum).toBeGreaterThanOrEqual(9);
    expect(est.warnings.some((w) => w.includes("異常") || w.includes("極端"))).toBe(true);
  });

  it("only same-type completed activities count", () => {
    const est = estimateRemainingTasks({
      taskType: "coding",
      activities: [
        activity({ taskType: "research", usageDelta: 5 }),
        activity({ taskType: "coding", usageDelta: 5, status: "cancelled" }),
        activity({ taskType: "coding", usageDelta: 5 }),
      ],
      currentUsedPercent: 40,
    });
    expect(est.sampleCount).toBe(1);
  });

  it("exhausted budget yields zero-range with warning", () => {
    const est = estimateRemainingTasks({
      taskType: "coding",
      activities: [5, 5, 5, 5].map((d) => activity({ taskType: "coding", usageDelta: d })),
      currentUsedPercent: 100,
    });
    expect(est.minimum).toBe(0);
    expect(est.maximum).toBe(0);
    expect(est.warnings.some((w) => w.includes("用盡"))).toBe(true);
  });
});
