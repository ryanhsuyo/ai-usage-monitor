import { buildClaudeMetadata, buildCodexMetadata, isDeferrableMetadataRefresh, type LocalUsageReading } from "./localUsageCollector";
import { settingStripRightInfo, settingStripSize } from "./settingsKeys";

function reading(overrides: Partial<LocalUsageReading> = {}): LocalUsageReading {
  return {
    providerId: "codex", limitKey: "codex-primary-10080", limitName: "Codex 每週額度",
    usedPercent: 20, windowMinutes: 10080, resetAtUnix: 1_800_000_000,
    capturedAt: "2026-07-17T00:00:00Z", sessionCount: 2,
    inputTokens: 1_100_000, cachedInputTokens: 1_000_000, outputTokens: 10_000,
    modelUsage: [{ model: "gpt-5.6-sol", inputTokens: 1_100_000, cachedInputTokens: 1_000_000, outputTokens: 10_000 }],
    ...overrides,
  };
}

describe("Codex local usage pricing", () => {
  it("prices uncached input, cached input and output separately", () => {
    const meta = buildCodexMetadata(reading({
      resetAvailableCount: 2,
      resetCredits: [{ title: "Full reset", expiresAtUnix: 1_800_000_100 }],
      resetCreditsAvailable: true,
    }));
    expect(meta.apiEquivalentUsd).toBeCloseTo(1.3, 6);
    expect(meta.sessionCount).toBe(2);
    expect(meta.scope).toBe("10080-minute-cycle");
    expect(meta.resetAvailableCount).toBe(2);
    expect(meta.resetCredits).toEqual([{ title: "Full reset", expiresAtUnix: 1_800_000_100 }]);
    expect(meta.resetCreditsAvailable).toBe(true);
  });

  it("returns a labelled minimum estimate when only some models have public pricing", () => {
    const meta = buildCodexMetadata(reading({ modelUsage: [
      { model: "gpt-5.6-sol", inputTokens: 1000, cachedInputTokens: 0, outputTokens: 0 },
      { model: "future-model", inputTokens: 1000, cachedInputTokens: 0, outputTokens: 0 },
    ] }));
    expect(meta.apiEquivalentUsd).toBeCloseTo(0.005, 8);
    expect(meta.unpricedModels).toEqual(["future-model"]);
    expect(meta.pricingBasis).toBe("partially-unavailable");
  });
});

describe("Claude local usage metadata", () => {
  it("preserves per-model transcript usage for hover breakdowns", () => {
    const meta = buildClaudeMetadata(reading({
      providerId: "claude",
      modelUsage: [{ model: "claude-fable-5", inputTokens: 2, cachedInputTokens: 20, cacheCreationTokens: 10, cacheReadTokens: 20, outputTokens: 3 }],
    }));
    expect(meta.kind).toBe("claude-local-24h");
    expect(meta.models[0]?.model).toBe("claude-fable-5");
  });

  it("preserves official quota freshness separately from transcript activity", () => {
    const meta = buildClaudeMetadata(reading({
      providerId: "claude",
      capturedAt: "2026-07-19T03:46:02Z",
      quotaStale: true,
      quotaCapturedAt: "2026-07-19T03:46:02Z",
    }));
    expect(meta.quotaStale).toBe(true);
    expect(meta.quotaCapturedAt).toBe("2026-07-19T03:46:02Z");
  });
});

describe("isDeferrableMetadataRefresh", () => {
  const latest = {
    usedPercent: 20,
    resetAt: "2027-01-15T00:00:00.000Z",
    note: 'AUTO:{"kind":"claude-local-24h","quotaStale":false}',
    capturedAt: "2026-07-19T12:00:00Z",
  };
  const claudeReading = { providerId: "claude" as const, usedPercent: 20, quotaStale: false };

  it("defers a metadata-only change within the 10-minute window", () => {
    expect(isDeferrableMetadataRefresh(latest, claudeReading, latest.resetAt, "2026-07-19T12:05:00Z")).toBe(true);
  });

  it("writes again once the window has passed", () => {
    expect(isDeferrableMetadataRefresh(latest, claudeReading, latest.resetAt, "2026-07-19T12:10:01Z")).toBe(false);
  });

  it("never defers official reading changes", () => {
    expect(isDeferrableMetadataRefresh(latest, { ...claudeReading, usedPercent: 21 }, latest.resetAt, "2026-07-19T12:05:00Z")).toBe(false);
    expect(isDeferrableMetadataRefresh(latest, claudeReading, "2027-01-16T00:00:00.000Z", "2026-07-19T12:05:00Z")).toBe(false);
    expect(isDeferrableMetadataRefresh(undefined, claudeReading, latest.resetAt, "2026-07-19T12:05:00Z")).toBe(false);
  });

  it("never defers a Claude stale-flag flip", () => {
    expect(isDeferrableMetadataRefresh(latest, { ...claudeReading, quotaStale: true }, latest.resetAt, "2026-07-19T12:05:00Z")).toBe(false);
  });

  it("applies the window to Codex readings without a stale flag", () => {
    const codexLatest = { ...latest, note: 'AUTO:{"kind":"codex-local"}' };
    expect(isDeferrableMetadataRefresh(codexLatest, { providerId: "codex", usedPercent: 20 }, latest.resetAt, "2026-07-19T12:05:00Z")).toBe(true);
  });
});

describe("compact widget settings", () => {
  it("accepts supported values and safely falls back for unknown values", () => {
    expect(settingStripSize("large")).toBe("large");
    expect(settingStripSize("huge")).toBe("medium");
    expect(settingStripRightInfo("cost")).toBe("cost");
    expect(settingStripRightInfo("unknown")).toBe("both");
  });
});
