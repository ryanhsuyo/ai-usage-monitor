import { describe, expect, it } from "vitest";
import { recommendPlan, type CycleSummary } from "./planRecommendation";

function cycle(partial: Partial<CycleSummary>): CycleSummary {
  return { utilization: 70, exhaustedEarly: false, earlyHours: 0, ...partial };
}

describe("plan recommendation (spec §11 / §20 cases 15-18)", () => {
  it("case 18: fewer than 4 cycles AND under 28 days → insufficient_data", () => {
    const r = recommendPlan({ cycles: [cycle({}), cycle({})], totalDaysOfData: 14 });
    expect(r.recommendation).toBe("insufficient_data");
    expect(r.reasons[0]).toContain("28");
  });

  it("case 15: upgrade when ≥3 of 4 cycles exhausted early, avg util ≥90, avg early ≥12h", () => {
    const r = recommendPlan({
      cycles: [
        cycle({ utilization: 100, exhaustedEarly: true, earlyHours: 20 }),
        cycle({ utilization: 100, exhaustedEarly: true, earlyHours: 15 }),
        cycle({ utilization: 95, exhaustedEarly: true, earlyHours: 14 }),
        cycle({ utilization: 88 }),
      ],
      totalDaysOfData: 28,
    });
    expect(r.recommendation).toBe("upgrade");
    expect(r.earlyExhaustedCycles).toBe(3);
    expect(r.reasons.length).toBeGreaterThan(0);
  });

  it("case 16: keep when utilization sits in the healthy band", () => {
    const r = recommendPlan({
      cycles: [
        cycle({ utilization: 60 }),
        cycle({ utilization: 75 }),
        cycle({ utilization: 65 }),
        cycle({ utilization: 70 }),
      ],
      totalDaysOfData: 28,
    });
    expect(r.recommendation).toBe("keep");
  });

  it("keep when occasionally exhausted early but below upgrade bar", () => {
    const r = recommendPlan({
      cycles: [
        cycle({ utilization: 100, exhaustedEarly: true, earlyHours: 5 }),
        cycle({ utilization: 70 }),
        cycle({ utilization: 60 }),
        cycle({ utilization: 65 }),
      ],
      totalDaysOfData: 28,
    });
    expect(r.recommendation).toBe("keep");
  });

  it("case 17: downgrade when avg util < 45, no early exhaustion, no extra credits", () => {
    const r = recommendPlan({
      cycles: [
        cycle({ utilization: 30 }),
        cycle({ utilization: 40 }),
        cycle({ utilization: 35 }),
        cycle({ utilization: 25 }),
      ],
      totalDaysOfData: 28,
    });
    expect(r.recommendation).toBe("downgrade");
  });

  it("no downgrade when extra credits were frequently used", () => {
    const r = recommendPlan({
      cycles: [
        cycle({ utilization: 30, usedExtraCredits: true }),
        cycle({ utilization: 40, usedExtraCredits: true }),
        cycle({ utilization: 35 }),
        cycle({ utilization: 25 }),
      ],
      totalDaysOfData: 28,
    });
    expect(r.recommendation).not.toBe("downgrade");
  });

  it("28 days of data qualifies even with fewer than 4 cycles", () => {
    const r = recommendPlan({
      cycles: [cycle({ utilization: 60 }), cycle({ utilization: 62 }), cycle({ utilization: 64 })],
      totalDaysOfData: 30,
    });
    expect(r.recommendation).not.toBe("insufficient_data");
  });
});
