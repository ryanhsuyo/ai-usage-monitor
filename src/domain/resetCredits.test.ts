import { describe, expect, it } from "vitest";
import { summarizeResetCredits } from "./resetCredits";

describe("summarizeResetCredits", () => {
  it("sorts credits and warns when the nearest one expires within 72 hours", () => {
    const summary = summarizeResetCredits(4, [
      { title: "Full reset", expiresAtUnix: Date.parse("2026-08-01T00:00:00Z") / 1000 },
      { title: "Full reset", expiresAtUnix: Date.parse("2026-07-18T00:00:00Z") / 1000 },
    ], "2026-07-17T00:00:00Z", 72, 97);
    expect(summary.nearestExpiry).toBe("2026-07-18T00:00:00.000Z");
    expect(summary.expiringSoon).toBe(true);
    expect(summary.expiryDates).toHaveLength(2);
    expect(summary.recommendations[0]).toMatchObject({ action: "use_now", message: "目前已使用 97%，建議現在使用" });
    expect(summary.recommendations[1]?.message).toContain("先用較早到期票券");
  });

  it("keeps the count when only a summary is available", () => {
    expect(summarizeResetCredits(3, [], "2026-07-17T00:00:00Z")).toEqual({
      availableCount: 3, nearestExpiry: undefined, expiringSoon: false, expiryDates: [], recommendations: [],
    });
  });

  it("waits for the automatic reset before consuming a later-expiring ticket", () => {
    const summary = summarizeResetCredits(1, [
      { title: "Full reset", expiresAtUnix: Date.parse("2026-07-27T12:00:00Z") / 1000 },
    ], "2026-07-17T00:00:00Z", 72, 30, "2026-07-23T00:00:00Z");
    expect(summary.recommendations[0]).toMatchObject({ action: "wait" });
    expect(summary.recommendations[0]?.message).toContain("先等官方重置");
    expect(summary.recommendations[0]?.latestUseAt).toBe("2026-07-27T06:00:00.000Z");
  });
});
