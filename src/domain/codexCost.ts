export type CodexModelUsage = {
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
};

const OPENAI_PRICES: Record<string, { input: number; cached: number; output: number }> = {
  "gpt-5.5": { input: 5, cached: 0.5, output: 30 },
  "gpt-5.6-sol": { input: 5, cached: 0.5, output: 30 },
  "gpt-5.6-terra": { input: 2.5, cached: 0.25, output: 15 },
  "gpt-5.6-luna": { input: 1, cached: 0.1, output: 6 },
};

// Codex logs some turns under an agent label instead of a base model. codex-auto-review is the
// automatic code-review pass; it runs on the full gpt-5 model, so it is priced at that tier.
// Pricing it (rather than leaving it "unpriced") is what reconciles the Codex total with ccusage
// to the cent — ccusage attributes the same tokens to the full-tier price.
const MODEL_ALIASES: Record<string, string> = {
  "codex-auto-review": "gpt-5.5",
};

export function codexPrice(model: string) {
  const normalized = model.toLowerCase().replace(/-\d{4}-\d{2}-\d{2}$/, "");
  return OPENAI_PRICES[MODEL_ALIASES[normalized] ?? normalized];
}

export function estimateCodexApiEquivalent(models: CodexModelUsage[]) {
  let usd = 0;
  let pricedModelCount = 0;
  const unpricedModels: string[] = [];
  for (const usage of models) {
    const price = codexPrice(usage.model);
    if (!price) {
      unpricedModels.push(usage.model);
      continue;
    }
    pricedModelCount++;
    const uncached = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
    usd += (uncached * price.input + usage.cachedInputTokens * price.cached + usage.outputTokens * price.output) / 1_000_000;
  }
  return { apiEquivalentUsd: pricedModelCount > 0 ? usd : undefined, unpricedModels };
}
