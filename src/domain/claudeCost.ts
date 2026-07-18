import type { CodexModelUsage } from "./codexCost";

export type ClaudeModelUsage = CodexModelUsage & {
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
};

const PRICES: Record<string, { input: number; cacheCreation: number; cacheRead: number; output: number }> = {
  "claude-fable-5": { input: 12, cacheCreation: 15, cacheRead: 1.2, output: 70 },
  "claude-opus-4-8": { input: 6, cacheCreation: 7.5, cacheRead: 0.6, output: 25 },
};

export function estimateClaudeApiEquivalent(models: ClaudeModelUsage[]) {
  return models.map((usage) => {
    const price = PRICES[usage.model.toLowerCase()];
    const cost = price ? (
      usage.inputTokens * price.input +
      (usage.cacheCreationTokens ?? 0) * price.cacheCreation +
      (usage.cacheReadTokens ?? usage.cachedInputTokens) * price.cacheRead +
      usage.outputTokens * price.output
    ) / 1_000_000 : undefined;
    return { ...usage, cost };
  });
}
