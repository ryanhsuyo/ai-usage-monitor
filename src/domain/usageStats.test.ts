import { aggregateClaudeUsage, periodKey, summarizeUsagePeriods, weekStart, type DailyModelUsage } from "./usageStats";

function row(overrides: Partial<DailyModelUsage>): DailyModelUsage {
  return {
    date: "2026-07-19", model: "claude-opus-4-8",
    inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 0, messageCount: 1,
    ...overrides,
  };
}

describe("usage period bucketing", () => {
  it("maps dates to ISO Monday week starts", () => {
    expect(weekStart("2026-07-19")).toBe("2026-07-13"); // Sunday belongs to the Monday-13 week
    expect(weekStart("2026-07-13")).toBe("2026-07-13"); // Monday is its own week start
    expect(weekStart("2026-07-20")).toBe("2026-07-20"); // next Monday starts a new week
    expect(weekStart("2026-01-01")).toBe("2025-12-29"); // week can start in the previous year
  });

  it("derives period keys per granularity", () => {
    expect(periodKey("2026-07-19", "daily")).toBe("2026-07-19");
    expect(periodKey("2026-07-19", "weekly")).toBe("2026-07-13");
    expect(periodKey("2026-07-19", "monthly")).toBe("2026-07");
  });
});

describe("aggregateClaudeUsage", () => {
  const rows: DailyModelUsage[] = [
    row({ date: "2026-07-18", model: "claude-opus-4-8", inputTokens: 1000, outputTokens: 2000, cacheReadTokens: 500_000 }),
    row({ date: "2026-07-19", model: "claude-opus-4-8", inputTokens: 500, outputTokens: 1000 }),
    row({ date: "2026-07-19", model: "claude-fable-5", outputTokens: 1_000_000 }),
    row({ date: "2026-07-20", model: "claude-haiku-4-5-20251001", outputTokens: 200_000 }),
  ];

  it("aggregates daily periods newest first with per-model cost", () => {
    const daily = aggregateClaudeUsage(rows, "daily");
    expect(daily.map((p) => p.period)).toEqual(["2026-07-20", "2026-07-19", "2026-07-18"]);
    const day19 = daily[1]!;
    expect(day19.models.map((m) => m.model)).toEqual(["claude-fable-5", "claude-opus-4-8"]); // sorted by cost desc
    expect(day19.models[0]!.cost).toBeCloseTo(50, 5); // 1M output tokens at US$50/M
    expect(day19.messageCount).toBe(2);
  });

  it("prices dated snapshot model IDs via prefix match", () => {
    const daily = aggregateClaudeUsage(rows, "daily");
    const day20 = daily[0]!;
    expect(day20.models[0]!.cost).toBeCloseTo(1, 5); // 200K output at US$5/M
    expect(day20.hasUnpricedModels).toBe(false);
  });

  it("merges the 18th and 19th into one week but keeps the 20th separate", () => {
    const weekly = aggregateClaudeUsage(rows, "weekly");
    expect(weekly.map((p) => p.period)).toEqual(["2026-07-20", "2026-07-13"]);
    const week13 = weekly[1]!;
    expect(week13.inputTokens).toBe(1500);
    expect(week13.cacheReadTokens).toBe(500_000);
    // opus: (1500*5 + 500000*0.5 + 3000*25)/1e6 ; fable: 1M*50/1e6
    expect(week13.cost).toBeCloseTo((1500 * 5 + 500_000 * 0.5 + 3000 * 25) / 1e6 + 50, 5);
  });

  it("aggregates into months and flags unpriced models without dropping them", () => {
    const monthly = aggregateClaudeUsage([...rows, row({ date: "2026-07-01", model: "future-model", outputTokens: 10 })], "monthly");
    expect(monthly).toHaveLength(1);
    const july = monthly[0]!;
    expect(july.period).toBe("2026-07");
    expect(july.hasUnpricedModels).toBe(true);
    expect(july.models.find((m) => m.model === "future-model")!.cost).toBeUndefined();
    // Unpriced models contribute tokens but not cost.
    expect(july.outputTokens).toBe(2000 + 1000 + 1_000_000 + 200_000 + 10);
  });

  it("summarizes across periods", () => {
    const summary = summarizeUsagePeriods(aggregateClaudeUsage(rows, "daily"));
    expect(summary.messageCount).toBe(4);
    expect(summary.cost).toBeCloseTo(
      (1000 * 5 + 500_000 * 0.5 + 2000 * 25) / 1e6 + (500 * 5 + 1000 * 25) / 1e6 + 50 + 1,
      5
    );
  });
});
