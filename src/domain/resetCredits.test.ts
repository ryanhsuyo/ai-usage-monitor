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
    expect(summary.recommendations[0]).toMatchObject({ action: "use_now", message: "目前已使用 97%，建議使用這 1 張" });
    expect(summary.recommendations[1]?.message).toContain("排在前一張之後");
  });

  it("keeps the count when only a summary is available", () => {
    const summary = summarizeResetCredits(3, [], "2026-07-17T00:00:00Z");
    expect(summary).toMatchObject({
      availableCount: 3, nearestExpiry: undefined, expiringSoon: false, expiryDates: [], recommendations: [],
    });
    // Without per-credit detail the count alone still supports advice, and at 0% used that
    // advice is to hold rather than spend.
    expect(summary.plan?.message).toContain("先不用票");
  });

  it("waits for the automatic reset before consuming a later-expiring ticket", () => {
    const summary = summarizeResetCredits(1, [
      { title: "Full reset", expiresAtUnix: Date.parse("2026-07-27T12:00:00Z") / 1000 },
    ], "2026-07-17T00:00:00Z", 72, 30, "2026-07-23T00:00:00Z");
    expect(summary.recommendations[0]).toMatchObject({ action: "wait" });
    expect(summary.recommendations[0]?.message).toContain("官方重置");
    expect(summary.recommendations[0]?.latestUseAt).toBe("2026-07-27T06:00:00.000Z");
  });

  it("names the official reset date so the reader can judge which day to spend a credit", () => {
    // "先等官方重置" alone made the user work out the date before deciding.
    const summary = summarizeResetCredits(
      2,
      [{ title: "Full reset", expiresAtUnix: Math.floor(Date.parse("2026-08-01T00:00:00Z") / 1000) }],
      "2026-07-20T00:00:00Z",
      72,
      30, // below the use-now threshold, so the advice is to wait
      "2026-07-25T12:00:00Z" // official reset lands before the credit expires
    );
    const advice = summary.recommendations[0]!.message;
    expect(advice).toContain("官方重置");
    expect(advice).toMatch(/7\/25/); // the actual day, not just "wait for it"
  });

  it("advises one credit at a time and sizes the gap against the burn rate", () => {
    // The user's own case: a full quota lasts them about two days, the official reset is five
    // days out, and three credits are banked. Spending all three at once would throw two away —
    // redeeming one starts a fresh quota immediately.
    const twoDaysPerCredit = 100 / 48; // 100 points of quota over 48 hours
    const summary = summarizeResetCredits(
      3,
      [1, 2, 3].map((d) => ({ title: "Full reset", expiresAtUnix: Math.floor(Date.parse(`2026-08-0${d}T00:00:00Z`) / 1000) })),
      "2026-07-20T00:00:00Z",
      72,
      95, // quota nearly spent, so acting now is reasonable
      "2026-07-25T00:00:00Z", // five days until the official reset
      twoDaysPerCredit
    );
    const plan = summary.plan!;
    expect(plan.message).toContain("用 1 張");
    expect(plan.message).toContain("還剩 2 張");
    expect(plan.hoursPerCredit).toBeCloseTo(48, 5);
    expect(plan.estimatedNeeded).toBe(3); // 5 days ÷ 2 days per credit, rounded up
    expect(plan.message).toMatch(/約 2 天/); // what one credit buys
    expect(plan.message).toMatch(/約 5 天/); // what still has to be covered
    // Never phrased as spending the stack.
    expect(plan.message).not.toMatch(/用完全部|全部使用|使用 3 張/);
  });

  it("says to hold the credits while the current quota still has room", () => {
    const summary = summarizeResetCredits(
      2,
      [{ title: "Full reset", expiresAtUnix: Math.floor(Date.parse("2026-08-01T00:00:00Z") / 1000) }],
      "2026-07-20T00:00:00Z", 72,
      40, // plenty left
      "2026-07-25T00:00:00Z", 100 / 48
    );
    expect(summary.plan!.message).toContain("先不用票");
    expect(summary.plan!.message).toContain("40%");
  });

  it("warns when the banked credits cannot cover the wait", () => {
    const summary = summarizeResetCredits(
      1,
      [{ title: "Full reset", expiresAtUnix: Math.floor(Date.parse("2026-08-10T00:00:00Z") / 1000) }],
      "2026-07-20T00:00:00Z", 72, 95,
      "2026-07-30T00:00:00Z", // ten days out
      100 / 48 // one credit lasts two days
    );
    expect(summary.plan!.estimatedNeeded).toBe(5);
    expect(summary.plan!.message).toContain("只有 1 張");
    expect(summary.plan!.message).toContain("放慢");
  });

  it("still advises without a burn rate, just without the projection", () => {
    const summary = summarizeResetCredits(
      2,
      [{ title: "Full reset", expiresAtUnix: Math.floor(Date.parse("2026-08-01T00:00:00Z") / 1000) }],
      "2026-07-20T00:00:00Z", 72, 95, "2026-07-25T00:00:00Z"
      // no burn rate — a brand-new install has no history yet
    );
    expect(summary.plan!.message).toContain("用 1 張");
    expect(summary.plan!.estimatedNeeded).toBeUndefined();
    expect(summary.plan!.message).toContain("再依當時用量決定");
  });
});
