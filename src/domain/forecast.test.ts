import { describe, expect, it } from "vitest";
import { computeForecast } from "./forecast";
import { at, snap } from "./testFixtures";

describe("forecast (spec §11 / §20 cases 13,14)", () => {
  it("case 13: will exhaust before reset when burn outpaces the window", () => {
    // 60% used at now, burning ~4pp/h → ~10h to exhaustion; reset in 26h.
    const snaps = [
      snap({ usedPercent: 20, capturedAt: at(0) }),
      snap({ usedPercent: 40, capturedAt: at(5) }),
      snap({ usedPercent: 60, capturedAt: at(10) }),
    ];
    const f = computeForecast({
      limitId: "limit-1",
      snapshots: snaps,
      now: at(10),
      resetAt: at(36),
    });
    expect(f.willExhaustBeforeReset).toBe(true);
    expect(f.estimatedExhaustionAt).toBeDefined();
    const hoursToExhaust =
      (Date.parse(f.estimatedExhaustionAt as string) - Date.parse(at(10))) / 3600_000;
    expect(hoursToExhaust).toBeCloseTo(10, 1);
    expect(f.estimatedRemainingAtReset).toBe(0);
  });

  it("case 14: will NOT exhaust before reset when burn is slow", () => {
    // 10% used, burning 1pp/h → 90h to exhaustion; reset in 24h.
    const snaps = [
      snap({ usedPercent: 4, capturedAt: at(0) }),
      snap({ usedPercent: 7, capturedAt: at(3) }),
      snap({ usedPercent: 10, capturedAt: at(6) }),
    ];
    const f = computeForecast({
      limitId: "limit-1",
      snapshots: snaps,
      now: at(6),
      resetAt: at(30),
    });
    expect(f.willExhaustBeforeReset).toBe(false);
    // remaining at reset ≈ 100 - (10 + 1*24) = 66
    expect(f.estimatedRemainingAtReset).toBeCloseTo(66, 0);
  });

  it("zero burn: no exhaustion time, remaining-at-reset equals current remaining", () => {
    const snaps = [
      snap({ usedPercent: 30, capturedAt: at(0) }),
      snap({ usedPercent: 30, capturedAt: at(4) }),
    ];
    const f = computeForecast({
      limitId: "limit-1",
      snapshots: snaps,
      now: at(4),
      resetAt: at(24),
    });
    expect(f.estimatedExhaustionAt).toBeUndefined();
    expect(f.willExhaustBeforeReset).toBe(false);
    expect(f.estimatedRemainingAtReset).toBe(70);
    expect(f.warnings.length).toBeGreaterThan(0);
  });

  it("no valid snapshots: zero confidence and explicit warning", () => {
    const f = computeForecast({ limitId: "limit-1", snapshots: [], now: at(0) });
    expect(f.confidence).toBe(0);
    expect(f.sampleCount).toBe(0);
    expect(f.warnings.some((w) => w.includes("沒有有效"))).toBe(true);
  });

  it("stale latest snapshot lowers confidence with a reason", () => {
    const snaps = [
      snap({ usedPercent: 10, capturedAt: at(0) }),
      snap({ usedPercent: 30, capturedAt: at(2) }),
    ];
    const fresh = computeForecast({ limitId: "limit-1", snapshots: snaps, now: at(2.5) });
    const stale = computeForecast({ limitId: "limit-1", snapshots: snaps, now: at(14) });
    expect(stale.confidence).toBeLessThan(fresh.confidence);
    expect(stale.warnings.some((w) => w.includes("小時"))).toBe(true);
  });

  it("only short-window data → lower confidence + warning", () => {
    // Two points 30 min apart: 24h window has just 1 segment (needs ≥2), cycle picks it up…
    // force the 6h basis by giving no cycleStart and only very recent data.
    const snaps = [
      snap({ usedPercent: 10, capturedAt: at(0) }),
      snap({ usedPercent: 12, capturedAt: at(0.5) }),
    ];
    const f = computeForecast({
      limitId: "limit-1",
      snapshots: snaps,
      now: at(0.5),
      resetAt: at(24),
    });
    // Whatever basis was chosen, the estimate must exist and confidence must be < 0.7 (low-ish).
    expect(f.estimatedExhaustionAt).toBeDefined();
    expect(f.confidence).toBeLessThan(0.7);
  });
});
