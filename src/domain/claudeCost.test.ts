import { estimateClaudeApiEquivalent } from "./claudeCost";

describe("Claude local API-equivalent cost", () => {
  it("prices Fable and Opus cache creation/read separately", () => {
    const result = estimateClaudeApiEquivalent([
      { model: "claude-fable-5", inputTokens: 126, outputTokens: 47057, cachedInputTokens: 33268850, cacheCreationTokens: 1519808, cacheReadTokens: 33268850 },
      { model: "claude-opus-4-8", inputTokens: 44, outputTokens: 20647, cachedInputTokens: 1499782, cacheCreationTokens: 62510, cacheReadTokens: 1499782 },
    ]);
    expect(result[0]!.cost).toBeCloseTo(66.02, 1);
    expect(result[1]!.cost).toBeCloseTo(1.89, 1);
  });

  it("leaves unknown models unpriced", () => {
    expect(estimateClaudeApiEquivalent([{ model: "future", inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 }])[0]!.cost).toBeUndefined();
  });
});
