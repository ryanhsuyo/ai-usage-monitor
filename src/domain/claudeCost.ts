import type { CodexModelUsage } from "./codexCost";

export type ClaudeModelUsage = CodexModelUsage & {
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
};

export type ClaudeModelPrice = {
  input: number;
  /** Cache write, 5-minute TTL: 1.25x input. */
  cacheWrite5m: number;
  /** Cache write, 1-hour TTL: 2x input. Claude Code writes its prompt cache with this TTL. */
  cacheWrite1h: number;
  /** Cache read: 0.1x input. */
  cacheRead: number;
  output: number;
};

function tier(input: number, output: number): ClaudeModelPrice {
  return { input, cacheWrite5m: input * 1.25, cacheWrite1h: input * 2, cacheRead: input * 0.1, output };
}

// Official Claude API list prices (USD per 1M tokens, 2026-06 pricing).
const PRICES: Record<string, ClaudeModelPrice> = {
  "claude-fable-5": tier(10, 50),
  "claude-mythos-5": tier(10, 50),
  "claude-opus-4-8": tier(5, 25),
  "claude-opus-4-7": tier(5, 25),
  "claude-opus-4-6": tier(5, 25),
  "claude-opus-4-5": tier(5, 25),
  "claude-sonnet-5": tier(3, 15),
  "claude-sonnet-4-6": tier(3, 15),
  "claude-sonnet-4-5": tier(3, 15),
  "claude-haiku-4-5": tier(1, 5),
};

// Sonnet 5 launched with introductory pricing through 2026-08-31.
const SONNET_5_INTRO_UNTIL = "2026-09-01";
const SONNET_5_INTRO = tier(2, 10);

// Longest key first so "claude-opus-4-5-20251101" resolves to opus-4-5, never a shorter cousin.
const PRICE_KEYS = Object.keys(PRICES).sort((a, b) => b.length - a.length);

/** Price table lookup tolerating dated snapshot IDs like `claude-haiku-4-5-20251001`. */
export function claudePrice(model: string, nowIso?: string): ClaudeModelPrice | undefined {
  const key = model.toLowerCase();
  const base = PRICES[key]
    ?? (() => {
      const prefix = PRICE_KEYS.find((candidate) => key.startsWith(`${candidate}-`));
      return prefix ? PRICES[prefix] : undefined;
    })();
  if (!base) return undefined;
  const isSonnet5 = key === "claude-sonnet-5" || key.startsWith("claude-sonnet-5-");
  if (isSonnet5 && (nowIso ?? new Date().toISOString()) < SONNET_5_INTRO_UNTIL) return SONNET_5_INTRO;
  return base;
}

export function estimateClaudeApiEquivalent(models: ClaudeModelUsage[]) {
  return models.map((usage) => {
    const price = claudePrice(usage.model);
    // No per-TTL breakdown at this call site; Claude Code cache writes are 1-hour TTL.
    const cost = price ? (
      usage.inputTokens * price.input +
      (usage.cacheCreationTokens ?? 0) * price.cacheWrite1h +
      (usage.cacheReadTokens ?? usage.cachedInputTokens) * price.cacheRead +
      usage.outputTokens * price.output
    ) / 1_000_000 : undefined;
    return { ...usage, cost };
  });
}
