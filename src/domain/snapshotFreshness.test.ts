import { describe, expect, it } from "vitest";
import { snapshotCycleState } from "./snapshotFreshness";
import { snap } from "./testFixtures";

describe("snapshotCycleState", () => {
  it("marks the old cycle as awaiting provider refresh after resetAt", () => {
    expect(snapshotCycleState(snap({ usedPercent: 80, capturedAt: "2026-07-17T07:00:00Z", resetAt: "2026-07-17T08:00:00Z" }), "2026-07-17T08:00:01Z"))
      .toBe("awaiting_provider_refresh");
  });

  it("keeps a reading current before resetAt or without a reset time", () => {
    expect(snapshotCycleState(snap({ usedPercent: 80, capturedAt: "2026-07-17T07:00:00Z", resetAt: "2026-07-17T08:00:00Z" }), "2026-07-17T07:59:59Z")).toBe("current");
    expect(snapshotCycleState(snap({ usedPercent: 80, capturedAt: "2026-07-17T07:00:00Z", resetAt: undefined }), "2026-07-17T09:00:00Z")).toBe("current");
  });
});
