import { claudePrice, estimateClaudeApiEquivalent } from "./claudeCost";

describe("Claude local API-equivalent cost", () => {
  it("prices Fable and Opus cache creation/read separately at official list prices", () => {
    const result = estimateClaudeApiEquivalent([
      { model: "claude-fable-5", inputTokens: 126, outputTokens: 47057, cachedInputTokens: 33268850, cacheCreationTokens: 1519808, cacheReadTokens: 33268850 },
      { model: "claude-opus-4-8", inputTokens: 44, outputTokens: 20647, cachedInputTokens: 1499782, cacheCreationTokens: 62510, cacheReadTokens: 1499782 },
    ]);
    expect(result[0]!.cost).toBeCloseTo(54.62, 1);
    expect(result[1]!.cost).toBeCloseTo(1.66, 1);
  });

  it("resolves dated snapshot IDs to the base model price", () => {
    expect(claudePrice("claude-haiku-4-5-20251001")).toEqual(claudePrice("claude-haiku-4-5"));
    expect(claudePrice("claude-opus-4-5-20251101")).toEqual(claudePrice("claude-opus-4-5"));
    expect(claudePrice("claude-opus-4-5-20251101")!.input).toBe(5);
  });

  it("leaves unknown models unpriced", () => {
    expect(estimateClaudeApiEquivalent([{ model: "future", inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 }])[0]!.cost).toBeUndefined();
    expect(claudePrice("claude-fable")).toBeUndefined();
  });
});
