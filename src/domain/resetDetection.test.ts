import { describe, expect, it } from "vitest";
import { detectReset, resetAtAdvancedBetween } from "./resetDetection";
import { at, snap } from "./testFixtures";

describe("reset detection (spec §11 / §20 cases 4,5,12)", () => {
  it("case 4: confirmed reset on a real usage drop", () => {
    const out = detectReset({
      previous: snap({ usedPercent: 85, capturedAt: at(0) }),
      current: snap({ usedPercent: 2, capturedAt: at(1) }),
      now: at(1),
      expectedResetAt: at(0.5),
    });
    expect(out.kind).toBe("confirmed");
    expect(out.method).toBe("confirmed_by_usage_drop");
    expect(out.confidence).toBeGreaterThanOrEqual(0.75);
  });

  it("case 5: a fetch-failure snapshot reading 0 must NOT confirm a reset", () => {
    const out = detectReset({
      previous: snap({ usedPercent: 85, capturedAt: at(0) }),
      current: snap({ usedPercent: 0, capturedAt: at(1), valid: false, errorCode: "fetch_failed" }),
      now: at(1),
    });
    expect(out.kind).toBe("none");
  });

  it("small dips below thresholds do not confirm", () => {
    const out = detectReset({
      previous: snap({ usedPercent: 15, capturedAt: at(0) }), // below PREV_USED_MIN
      current: snap({ usedPercent: 2, capturedAt: at(1) }),
      now: at(1),
    });
    expect(out.kind).toBe("none");
  });

  it("boosted confidence when resetAt advanced and consecutive low readings exist", () => {
    const base = detectReset({
      previous: snap({ usedPercent: 85, capturedAt: at(0) }),
      current: snap({ usedPercent: 2, capturedAt: at(1) }),
      now: at(1),
    });
    const boosted = detectReset({
      previous: snap({ usedPercent: 85, capturedAt: at(0) }),
      current: snap({ usedPercent: 2, capturedAt: at(1) }),
      now: at(1),
      resetAtAdvanced: true,
      consecutiveLowReadings: 2,
    });
    expect(boosted.confidence).toBeGreaterThan(base.confidence);
  });

  it("confirmed by reset-timestamp change when usage is already low", () => {
    const out = detectReset({
      previous: snap({ usedPercent: 4, capturedAt: at(0) }),
      current: snap({ usedPercent: 3, capturedAt: at(1) }),
      now: at(1),
      resetAtAdvanced: true,
    });
    expect(out.kind).toBe("confirmed");
    expect(out.method).toBe("confirmed_by_reset_change");
  });

  it("confirms via advanced resetAt even when the new cycle already re-accumulated usage", () => {
    // App slept across the boundary; first fresh reading is 34% in the NEW cycle.
    const out = detectReset({
      previous: snap({ usedPercent: 80, capturedAt: at(0) }),
      current: snap({ usedPercent: 34, capturedAt: at(8) }),
      now: at(8),
      expectedResetAt: at(5),
      resetAtAdvanced: true,
    });
    expect(out.kind).toBe("confirmed");
    expect(out.method).toBe("confirmed_by_reset_change");
    expect(out.confidence).toBeCloseTo(0.7, 5);
    expect(out.reasons.join()).toContain("34%");
  });

  it("resetAtAdvancedBetween ignores sub-second provider jitter but accepts a real cycle change", () => {
    expect(resetAtAdvancedBetween("2026-07-19T18:59:59Z", "2026-07-19T19:00:00Z")).toBe(false); // jitter
    expect(resetAtAdvancedBetween("2026-07-19T19:00:00Z", "2026-07-20T00:00:00Z")).toBe(true); // next cycle
    expect(resetAtAdvancedBetween(undefined, "2026-07-20T00:00:00Z")).toBe(false);
    expect(resetAtAdvancedBetween("2026-07-20T00:00:00Z", "2026-07-19T19:00:00Z")).toBe(false); // went backwards
  });

  it("does not re-detect a reset half an hour into the new cycle (real 7/20 session trace)", () => {
    // The session reset at 06:10 (95% → 0%). Half an hour later usage was quietly climbing,
    // but two consecutive live fetches restated resets_at one second apart — which used to
    // register as a fresh reset and pushed "額度可能臨時／提前重置，目前已使用 4%".
    const out = detectReset({
      previous: snap({ usedPercent: 3, capturedAt: "2026-07-20T06:31:45Z", resetAt: "2026-07-20T11:09:59Z" }),
      current: snap({ usedPercent: 4, capturedAt: "2026-07-20T06:36:00Z", resetAt: "2026-07-20T11:10:00Z" }),
      now: "2026-07-20T06:40:52Z",
      expectedResetAt: "2026-07-20T11:09:59Z",
      resetAtAdvanced: resetAtAdvancedBetween("2026-07-20T11:09:59Z", "2026-07-20T11:10:00Z"),
    });
    expect(out.kind).toBe("none");
  });

  it("case 12: expected reset time reached without confirming data → 'expected', never 'confirmed'", () => {
    const out = detectReset({
      previous: snap({ usedPercent: 70, capturedAt: at(0) }),
      current: undefined, // no new reading
      now: at(10),
      expectedResetAt: at(8),
    });
    expect(out.kind).toBe("expected");
    expect(out.method).toBe("expected_time_reached");
    expect(out.confidence).toBeLessThan(0.75);
  });

  it("before the expected time with no drop → none", () => {
    const out = detectReset({
      previous: snap({ usedPercent: 50, capturedAt: at(0) }),
      current: snap({ usedPercent: 55, capturedAt: at(1) }),
      now: at(1),
      expectedResetAt: at(8),
    });
    expect(out.kind).toBe("none");
  });
});
