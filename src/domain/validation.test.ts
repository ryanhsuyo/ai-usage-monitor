import { describe, expect, it } from "vitest";
import { computeConfidence, levelFor } from "./confidence";
import { validateImport } from "./importValidation";
import { validateSnapshot } from "./snapshotValidation";

describe("snapshot validation (spec §8 flow 4 / §20 case 5)", () => {
  it("accepts a consistent manual snapshot and normalizes the pair", () => {
    const v = validateSnapshot({ usedPercent: 40, capturedAt: "2026-07-13T10:00:00Z" });
    expect(v.valid).toBe(true);
    expect(v.normalized).toEqual({ usedPercent: 40, remainingPercent: 60 });
  });

  it("rejects out-of-range percentages", () => {
    expect(validateSnapshot({ usedPercent: 120, capturedAt: "2026-07-13T10:00:00Z" }).valid).toBe(false);
    expect(validateSnapshot({ usedPercent: -3, capturedAt: "2026-07-13T10:00:00Z" }).valid).toBe(false);
  });

  it("rejects used+remaining that do not reconcile", () => {
    const v = validateSnapshot({
      usedPercent: 40,
      remainingPercent: 40,
      capturedAt: "2026-07-13T10:00:00Z",
    });
    expect(v.valid).toBe(false);
  });

  it("rejects malformed timestamps", () => {
    expect(validateSnapshot({ usedPercent: 10, capturedAt: "not-a-date" }).valid).toBe(false);
    expect(
      validateSnapshot({ usedPercent: 10, capturedAt: "2026-07-13T10:00:00Z", resetAt: "later" }).valid
    ).toBe(false);
  });

  it("case 5: an errored fetch is never accepted as a 0% reading", () => {
    const v = validateSnapshot({
      usedPercent: 0,
      capturedAt: "2026-07-13T10:00:00Z",
      errorCode: "fetch_failed",
    });
    expect(v.valid).toBe(false);
    expect(v.errors[0]).toContain("error");
  });
});

describe("confidence (spec §12)", () => {
  it("maps values to levels at the documented boundaries", () => {
    expect(levelFor(0.2)).toBe("low");
    expect(levelFor(0.39)).toBe("low");
    expect(levelFor(0.5)).toBe("medium");
    expect(levelFor(0.69)).toBe("medium");
    expect(levelFor(0.7)).toBe("high");
  });

  it("zero samples → zero confidence with a reason", () => {
    const c = computeConfidence({ sampleCount: 0 });
    expect(c.value).toBe(0);
    expect(c.level).toBe("low");
    expect(c.reasons.length).toBeGreaterThan(0);
  });

  it("small samples, staleness and manual-only all reduce confidence with reasons", () => {
    const good = computeConfidence({ sampleCount: 10, ageHoursOfLatest: 0.5 });
    const bad = computeConfidence({
      sampleCount: 2,
      ageHoursOfLatest: 9,
      manualOnly: true,
    });
    expect(bad.value).toBeLessThan(good.value);
    expect(bad.reasons.join()).toContain("2 筆");
    expect(bad.reasons.join()).toContain("手動");
    expect(bad.reasons.join()).toContain("小時");
  });

  it("cross-reset and outliers reduce confidence", () => {
    const base = computeConfidence({ sampleCount: 8 });
    const worse = computeConfidence({ sampleCount: 8, crossReset: true, outlierCount: 2 });
    expect(worse.value).toBeLessThan(base.value);
  });
});

describe("import validation (spec §15 / §20 cases 24,25)", () => {
  const validBundle = {
    schemaVersion: 1,
    exportedAt: "2026-07-13T00:00:00Z",
    appVersion: "0.1.0",
    providerAccounts: [{ id: "a1", providerId: "claude", displayName: "Main" }],
    plans: [{ id: "p1", accountId: "a1", name: "Max 5x", monthlyPrice: 100 }],
    limits: [{ id: "l1", planId: "p1", type: "weekly" }],
    snapshots: [{ id: "s1", limitId: "l1", usedPercent: 40, capturedAt: "2026-07-13T00:00:00Z" }],
    activities: [{ id: "act1", limitId: "l1", taskType: "coding", startedAt: "2026-07-13T00:00:00Z" }],
    resetEvents: [{ id: "r1", limitId: "l1", detectedAt: "2026-07-13T00:00:00Z" }],
    notificationChannels: [],
    settings: {},
  };

  it("accepts a well-formed bundle", () => {
    const r = validateImport(validBundle);
    expect(r.ok).toBe(true);
    expect(r.collections.every((c) => c.invalid === 0)).toBe(true);
  });

  it("rejects a non-object payload", () => {
    expect(validateImport("junk").ok).toBe(false);
    expect(validateImport(null).ok).toBe(false);
  });

  it("rejects a newer schemaVersion than supported", () => {
    const r = validateImport({ ...validBundle, schemaVersion: 999 });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain("schemaVersion");
  });

  it("case 25: invalid rows are counted per collection, never crashing the report", () => {
    const r = validateImport({
      ...validBundle,
      snapshots: [
        ...validBundle.snapshots,
        { id: "bad", limitId: "l1" }, // missing usedPercent/capturedAt
        "not-an-object",
      ],
    });
    const snaps = r.collections.find((c) => c.name === "snapshots")!;
    expect(snaps.valid).toBe(1);
    expect(snaps.invalid).toBe(2);
    expect(snaps.invalidReasons.length).toBeGreaterThan(0);
  });

  it("case 24: secret-looking fields are flagged for stripping, never imported silently", () => {
    const r = validateImport({
      ...validBundle,
      notificationChannels: [
        { id: "c1", type: "discord", webhookUrl: "https://discord.com/api/webhooks/x/y" },
      ],
    });
    expect(r.strippedSecretKeys).toContain("webhookUrl");
    expect(r.warnings.join()).toContain("機密");
  });

  it("secretRef itself is allowed (it is a reference, not a secret)", () => {
    const r = validateImport({
      ...validBundle,
      notificationChannels: [{ id: "c1", type: "discord", secretRef: "notification-channel:discord:c1" }],
    });
    expect(r.strippedSecretKeys).toHaveLength(0);
  });
});
