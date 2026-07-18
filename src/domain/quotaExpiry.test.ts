import { computeQuotaExpiry } from "./quotaExpiry";

describe("quota expiry insight", () => {
  it("warns a weekly allowance with meaningful unused quota in its final day", () => {
    const result = computeQuotaExpiry({
      now: "2026-07-17T12:00:00Z", resetAt: "2026-07-18T08:00:00Z",
      remainingPercent: 68, windowHours: 168,
    });
    expect(result.expiring).toBe(true);
    expect(result.warningLeadHours).toBe(24);
    expect(result.suggestedPercentPerHour).toBeCloseTo(3.4);
  });

  it("uses a shorter lead time for a five-hour allowance", () => {
    expect(computeQuotaExpiry({
      now: "2026-07-17T12:00:00Z", resetAt: "2026-07-17T13:30:00Z",
      remainingPercent: 40, windowHours: 5,
    }).expiring).toBe(false);
    expect(computeQuotaExpiry({
      now: "2026-07-17T12:45:00Z", resetAt: "2026-07-17T13:30:00Z",
      remainingPercent: 40, windowHours: 5,
    }).expiring).toBe(true);
  });

  it("does not add an expiry warning when little allowance remains", () => {
    expect(computeQuotaExpiry({
      now: "2026-07-17T12:00:00Z", resetAt: "2026-07-17T13:00:00Z",
      remainingPercent: 10, windowHours: 168,
    }).expiring).toBe(false);
  });
});
