import { computeUsageRunway } from "./runway";
import type { ForecastResult } from "./types";

const forecast = (rate: number | undefined): ForecastResult => ({
  limitId: "l1", calculatedAt: "2026-07-17T00:00:00Z", confidence: 0.8,
  sampleCount: 4, warnings: [], burnRate24h: rate,
});

describe("usage runway", () => {
  it("computes a safe daily budget and flags pace above budget", () => {
    const result = computeUsageRunway({
      forecast: forecast(1), remainingPercent: 50,
      now: "2026-07-17T00:00:00Z", resetAt: "2026-07-19T00:00:00Z",
    });
    expect(result.safeDailyBudget).toBe(25);
    expect(result.currentDailyPace).toBe(24);
    expect(result.paceRatio).toBeCloseTo(0.96);
    expect(result.status).toBe("watch");
  });

  it("asks the user to slow down when current pace exceeds the safe pace", () => {
    const result = computeUsageRunway({
      forecast: forecast(2), remainingPercent: 50,
      now: "2026-07-17T00:00:00Z", resetAt: "2026-07-19T00:00:00Z",
    });
    expect(result.status).toBe("slow_down");
    expect(result.paceDifferencePercent).toBeCloseTo(92);
  });

  it("returns insufficient data without a reset time or burn rate", () => {
    expect(computeUsageRunway({ forecast: forecast(1), remainingPercent: 50, now: "2026-07-17T00:00:00Z" }).status).toBe("insufficient_data");
    expect(computeUsageRunway({ forecast: forecast(undefined), remainingPercent: 50, now: "2026-07-17T00:00:00Z", resetAt: "2026-07-19T00:00:00Z" }).status).toBe("insufficient_data");
  });
});
