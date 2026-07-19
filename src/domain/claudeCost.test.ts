import { claudePrice, estimateClaudeApiEquivalent } from "./claudeCost";

describe("Claude local API-equivalent cost", () => {
  it("prices Fable and Opus with 1h-TTL cache writes (Claude Code default)", () => {
    const result = estimateClaudeApiEquivalent([
      { model: "claude-fable-5", inputTokens: 126, outputTokens: 47057, cachedInputTokens: 33268850, cacheCreationTokens: 1519808, cacheReadTokens: 33268850 },
      { model: "claude-opus-4-8", inputTokens: 44, outputTokens: 20647, cachedInputTokens: 1499782, cacheCreationTokens: 62510, cacheReadTokens: 1499782 },
    ]);
    // fable: (126*10 + 1519808*20 + 33268850*1 + 47057*50)/1e6
    expect(result[0]!.cost).toBeCloseTo(66.02, 1);
    // opus: (44*5 + 62510*10 + 1499782*0.5 + 20647*25)/1e6
    expect(result[1]!.cost).toBeCloseTo(1.89, 1);
  });

  it("derives cache rates from input price (5m = 1.25x, 1h = 2x, read = 0.1x)", () => {
    const opus = claudePrice("claude-opus-4-8")!;
    expect(opus).toMatchObject({ input: 5, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5, output: 25 });
  });

  it("resolves dated snapshot IDs to the base model price", () => {
    expect(claudePrice("claude-haiku-4-5-20251001")).toEqual(claudePrice("claude-haiku-4-5"));
    expect(claudePrice("claude-opus-4-5-20251101")).toEqual(claudePrice("claude-opus-4-5"));
    expect(claudePrice("claude-opus-4-5-20251101")!.input).toBe(5);
  });

  it("applies Sonnet 5 introductory pricing until 2026-08-31 only", () => {
    expect(claudePrice("claude-sonnet-5", "2026-07-19T00:00:00Z")!.input).toBe(2);
    expect(claudePrice("claude-sonnet-5", "2026-08-31T23:59:59Z")!.output).toBe(10);
    expect(claudePrice("claude-sonnet-5", "2026-09-01T00:00:00Z")!.input).toBe(3);
    // Other Sonnet generations are unaffected.
    expect(claudePrice("claude-sonnet-4-6", "2026-07-19T00:00:00Z")!.input).toBe(3);
  });

  it("leaves unknown models unpriced", () => {
    expect(estimateClaudeApiEquivalent([{ model: "future", inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 }])[0]!.cost).toBeUndefined();
    expect(claudePrice("claude-fable")).toBeUndefined();
  });
});
