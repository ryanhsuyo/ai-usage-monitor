// ccusage-style aggregation of local Claude Code transcript usage into
// daily / weekly / monthly periods with API-equivalent cost per model.

import { claudePrice } from "./claudeCost";

export type DailyModelUsage = {
  date: string; // YYYY-MM-DD (local)
  model: string;
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  messageCount: number;
};

export type PeriodGranularity = "daily" | "weekly" | "monthly";

export type ModelPeriodUsage = {
  model: string;
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  messageCount: number;
  /** API-equivalent USD; undefined when the model has no known list price. */
  cost?: number;
};

export type PeriodUsage = {
  /** Bucket key: YYYY-MM-DD (daily), week-start Monday YYYY-MM-DD (weekly), YYYY-MM (monthly). */
  period: string;
  models: ModelPeriodUsage[];
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  messageCount: number;
  /** Sum over priced models only. */
  cost: number;
  hasUnpricedModels: boolean;
};

/** Monday-of-week for a YYYY-MM-DD date string (date-only strings parse as UTC). */
export function weekStart(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return date;
  const daysSinceMonday = (parsed.getUTCDay() + 6) % 7;
  parsed.setUTCDate(parsed.getUTCDate() - daysSinceMonday);
  return parsed.toISOString().slice(0, 10);
}

export function periodKey(date: string, granularity: PeriodGranularity): string {
  if (granularity === "monthly") return date.slice(0, 7);
  if (granularity === "weekly") return weekStart(date);
  return date;
}

export function aggregateClaudeUsage(rows: DailyModelUsage[], granularity: PeriodGranularity): PeriodUsage[] {
  const byPeriod = new Map<string, Map<string, ModelPeriodUsage>>();
  for (const row of rows) {
    const key = periodKey(row.date, granularity);
    let models = byPeriod.get(key);
    if (!models) {
      models = new Map();
      byPeriod.set(key, models);
    }
    let entry = models.get(row.model);
    if (!entry) {
      entry = { model: row.model, inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 0, messageCount: 0 };
      models.set(row.model, entry);
    }
    entry.inputTokens += row.inputTokens;
    entry.cacheCreationTokens += row.cacheCreationTokens;
    entry.cacheReadTokens += row.cacheReadTokens;
    entry.outputTokens += row.outputTokens;
    entry.messageCount += row.messageCount;
  }

  const periods: PeriodUsage[] = [];
  for (const [period, models] of byPeriod) {
    const modelRows = [...models.values()].map((entry) => {
      const price = claudePrice(entry.model);
      const cost = price ? (
        entry.inputTokens * price.input +
        entry.cacheCreationTokens * price.cacheCreation +
        entry.cacheReadTokens * price.cacheRead +
        entry.outputTokens * price.output
      ) / 1_000_000 : undefined;
      return { ...entry, cost };
    });
    modelRows.sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0) || b.outputTokens - a.outputTokens);
    periods.push({
      period,
      models: modelRows,
      inputTokens: modelRows.reduce((sum, m) => sum + m.inputTokens, 0),
      cacheCreationTokens: modelRows.reduce((sum, m) => sum + m.cacheCreationTokens, 0),
      cacheReadTokens: modelRows.reduce((sum, m) => sum + m.cacheReadTokens, 0),
      outputTokens: modelRows.reduce((sum, m) => sum + m.outputTokens, 0),
      messageCount: modelRows.reduce((sum, m) => sum + m.messageCount, 0),
      cost: modelRows.reduce((sum, m) => sum + (m.cost ?? 0), 0),
      hasUnpricedModels: modelRows.some((m) => m.cost === undefined),
    });
  }
  // Newest period first, matching a "how much did I spend recently" reading order.
  periods.sort((a, b) => b.period.localeCompare(a.period));
  return periods;
}

export function summarizeUsagePeriods(periods: PeriodUsage[]) {
  return {
    inputTokens: periods.reduce((sum, p) => sum + p.inputTokens, 0),
    cacheCreationTokens: periods.reduce((sum, p) => sum + p.cacheCreationTokens, 0),
    cacheReadTokens: periods.reduce((sum, p) => sum + p.cacheReadTokens, 0),
    outputTokens: periods.reduce((sum, p) => sum + p.outputTokens, 0),
    messageCount: periods.reduce((sum, p) => sum + p.messageCount, 0),
    cost: periods.reduce((sum, p) => sum + p.cost, 0),
    hasUnpricedModels: periods.some((p) => p.hasUnpricedModels),
  };
}
