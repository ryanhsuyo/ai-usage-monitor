import { describe, expect, it } from "vitest";
import { computeBurnRates, normalizeSeries } from "./burnRate";
import { at, snap } from "./testFixtures";

describe("burn rate (spec §11 / §20 cases 1,2,3,5,6,7,8,11)", () => {
  it("case 1: normal increase produces a positive rate", () => {
    const snaps = [
      snap({ usedPercent: 10, capturedAt: at(0) }),
      snap({ usedPercent: 20, capturedAt: at(2) }),
      snap({ usedPercent: 30, capturedAt: at(4) }),
    ];
    const r = computeBurnRates(snaps, { now: at(4) });
    expect(r.burnRateCurrentCycle).toBeCloseTo(5, 5); // 20pp over 4h
    expect(r.burnRate6h).toBeCloseTo(5, 5);
  });

  it("case 2: flat usage yields a zero rate (not undefined)", () => {
    const snaps = [
      snap({ usedPercent: 40, capturedAt: at(0) }),
      snap({ usedPercent: 40, capturedAt: at(3) }),
    ];
    const r = computeBurnRates(snaps, { now: at(3) });
    expect(r.burnRateCurrentCycle).toBe(0);
  });

  it("case 3: usage drop without confirmed reset is NOT counted as burn", () => {
    const snaps = [
      snap({ usedPercent: 50, capturedAt: at(0) }),
      snap({ usedPercent: 20, capturedAt: at(2) }), // drop — must be ignored
      snap({ usedPercent: 30, capturedAt: at(4) }),
    ];
    const r = computeBurnRates(snaps, { now: at(4) });
    // Only the 20→30 segment counts: 10pp / 2h = 5pp/h
    expect(r.burnRateCurrentCycle).toBeCloseTo(5, 5);
    expect(r.segments).toHaveLength(1);
  });

  it("case 5: invalid snapshots (fetch failure) are excluded, never treated as 0%", () => {
    const snaps = [
      snap({ usedPercent: 30, capturedAt: at(0) }),
      snap({ usedPercent: 0, capturedAt: at(1), valid: false, errorCode: "fetch_failed" }),
      snap({ usedPercent: 40, capturedAt: at(2) }),
    ];
    const r = computeBurnRates(snaps, { now: at(2) });
    // 30→40 over 2h = 5pp/h; the invalid 0% reading must not create a drop or a spike.
    expect(r.burnRateCurrentCycle).toBeCloseTo(5, 5);
    expect(r.segments).toHaveLength(1);
  });

  it("case 6: out-of-order timestamps are sorted before computing", () => {
    const snaps = [
      snap({ usedPercent: 30, capturedAt: at(4) }),
      snap({ usedPercent: 10, capturedAt: at(0) }),
      snap({ usedPercent: 20, capturedAt: at(2) }),
    ];
    const r = computeBurnRates(snaps, { now: at(4) });
    expect(r.burnRateCurrentCycle).toBeCloseTo(5, 5);
  });

  it("cases 7+8: caller filters by account+limit; series from mixed input stays usable", () => {
    // The service layer passes one account+limit; normalizeSeries defensively sorts and merges.
    const series = normalizeSeries([
      snap({ usedPercent: 10, capturedAt: at(0) }),
      snap({ usedPercent: 12, capturedAt: at(0.05) }), // 3 min later — merged (min interval)
      snap({ usedPercent: 20, capturedAt: at(2) }),
    ]);
    expect(series).toHaveLength(2);
  });

  it("minimum interval: readings closer than 10 minutes are treated as one", () => {
    const snaps = [
      snap({ usedPercent: 10, capturedAt: at(0) }),
      snap({ usedPercent: 11, capturedAt: at(0.1) }), // 6 min
      snap({ usedPercent: 20, capturedAt: at(1) }),
    ];
    const r = computeBurnRates(snaps, { now: at(1) });
    expect(r.segments).toHaveLength(1);
    expect(r.burnRateCurrentCycle).toBeCloseTo(10, 5);
  });

  it("case 11: extreme outlier segments are excluded and flagged", () => {
    const snaps = [
      snap({ usedPercent: 10, capturedAt: at(0) }),
      snap({ usedPercent: 12, capturedAt: at(1) }),
      snap({ usedPercent: 14, capturedAt: at(2) }),
      snap({ usedPercent: 16, capturedAt: at(3) }),
      snap({ usedPercent: 18, capturedAt: at(4) }),
      snap({ usedPercent: 80, capturedAt: at(5) }), // 62pp in one hour — extreme
    ];
    const r = computeBurnRates(snaps, { now: at(5) });
    expect(r.cycle.outliersExcluded).toBeGreaterThan(0);
    expect(r.burnRateCurrentCycle).toBeCloseTo(2, 5);
    expect(r.warnings.some((w) => w.includes("異常"))).toBe(true);
  });

  it("empty input yields no rates and a warning", () => {
    const r = computeBurnRates([], { now: at(0) });
    expect(r.burnRateCurrentCycle).toBeUndefined();
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it("cycle rate only uses segments after cycleStartIso", () => {
    const snaps = [
      snap({ usedPercent: 80, capturedAt: at(-10) }),
      snap({ usedPercent: 90, capturedAt: at(-9) }), // previous cycle: 10pp/h
      snap({ usedPercent: 2, capturedAt: at(0) }),
      snap({ usedPercent: 6, capturedAt: at(2) }), // current cycle: 2pp/h
    ];
    const r = computeBurnRates(snaps, { now: at(2), cycleStartIso: at(0) });
    expect(r.burnRateCurrentCycle).toBeCloseTo(2, 5);
  });
});
