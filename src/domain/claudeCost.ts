import type { CodexModelUsage } from "./codexCost";

export type ClaudeModelUsage = CodexModelUsage & {
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
};

// Official Claude API list prices (USD per 1M tokens, 2026-06 pricing).
// Cache write = 1.25x input (5-minute TTL), cache read = 0.1x input.
const PRICES: Record<string, { input: number; cacheCreation: number; cacheRead: number; output: number }> = {
  "claude-fable-5": { input: 10, cacheCreation: 12.5, cacheRead: 1, output: 50 },
  "claude-mythos-5": { input: 10, cacheCreation: 12.5, cacheRead: 1, output: 50 },
  "claude-opus-4-8": { input: 5, cacheCreation: 6.25, cacheRead: 0.5, output: 25 },
  "claude-opus-4-7": { input: 5, cacheCreation: 6.25, cacheRead: 0.5, output: 25 },
  "claude-opus-4-6": { input: 5, cacheCreation: 6.25, cacheRead: 0.5, output: 25 },
  "claude-opus-4-5": { input: 5, cacheCreation: 6.25, cacheRead: 0.5, output: 25 },
  "claude-sonnet-5": { input: 3, cacheCreation: 3.75, cacheRead: 0.3, output: 15 },
  "claude-sonnet-4-6": { input: 3, cacheCreation: 3.75, cacheRead: 0.3, output: 15 },
  "claude-sonnet-4-5": { input: 3, cacheCreation: 3.75, cacheRead: 0.3, output: 15 },
  "claude-haiku-4-5": { input: 1, cacheCreation: 1.25, cacheRead: 0.1, output: 5 },
};

// Longest key first so "claude-opus-4-5-20251101" resolves to opus-4-5, never a shorter cousin.
const PRICE_KEYS = Object.keys(PRICES).sort((a, b) => b.length - a.length);

/** Price table lookup tolerating dated snapshot IDs like `claude-haiku-4-5-20251001`. */
export function claudePrice(model: string) {
  const key = model.toLowerCase();
  if (PRICES[key]) return PRICES[key];
  const prefix = PRICE_KEYS.find((candidate) => key.startsWith(`${candidate}-`));
  return prefix ? PRICES[prefix] : undefined;
}

export function estimateClaudeApiEquivalent(models: ClaudeModelUsage[]) {
  return models.map((usage) => {
    const price = claudePrice(usage.model);
    const cost = price ? (
      usage.inputTokens * price.input +
      (usage.cacheCreationTokens ?? 0) * price.cacheCreation +
      (usage.cacheReadTokens ?? usage.cachedInputTokens) * price.cacheRead +
      usage.outputTokens * price.output
    ) / 1_000_000 : undefined;
    return { ...usage, cost };
  });
}
