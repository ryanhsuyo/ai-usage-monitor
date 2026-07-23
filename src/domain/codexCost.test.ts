import { codexPrice, estimateCodexApiEquivalent } from "./codexCost";

describe("codex pricing", () => {
  it("resolves the codex-auto-review agent label to the full gpt-5 tier", () => {
    // The auto-review pass is logged under an agent name, not a base model. Leaving it unpriced
    // is what put "未定價" on a row with real usage and left the Codex total ~$28 short of ccusage.
    expect(codexPrice("codex-auto-review")).toEqual(codexPrice("gpt-5.5"));
    expect(codexPrice("codex-auto-review")).toBeDefined();
  });

  it("strips a dated snapshot suffix before looking up the price", () => {
    expect(codexPrice("gpt-5.5-2026-01-15")).toEqual(codexPrice("gpt-5.5"));
  });

  it("still reports a genuinely unknown model as unpriced", () => {
    expect(codexPrice("gpt-6-imaginary")).toBeUndefined();
  });

  it("prices auto-review usage instead of dropping it from the total", () => {
    const withReview = estimateCodexApiEquivalent([
      { model: "gpt-5.5", inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 100_000 },
      { model: "codex-auto-review", inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 100_000 },
    ]);
    const base = estimateCodexApiEquivalent([
      { model: "gpt-5.5", inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 100_000 },
    ]);
    // Two identical priced rows cost exactly twice one, and nothing lands in unpricedModels.
    expect(withReview.apiEquivalentUsd).toBeCloseTo((base.apiEquivalentUsd ?? 0) * 2, 6);
    expect(withReview.unpricedModels).toEqual([]);
  });

  it("subtracts the cached portion from input before charging the full rate", () => {
    // 1M input of which 0.4M was a cache read: 0.6M @ $5 + 0.4M @ $0.5 + 0.1M output @ $30.
    const { apiEquivalentUsd } = estimateCodexApiEquivalent([
      { model: "gpt-5.5", inputTokens: 1_000_000, cachedInputTokens: 400_000, outputTokens: 100_000 },
    ]);
    expect(apiEquivalentUsd).toBeCloseTo((600_000 * 5 + 400_000 * 0.5 + 100_000 * 30) / 1_000_000, 6);
  });
});
