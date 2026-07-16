import { describe, expect, it } from "vitest";
import { detectReset } from "./resetDetection";
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
