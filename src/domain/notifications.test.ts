import { describe, expect, it } from "vitest";
import { NOTIFICATION } from "./constants";
import { alreadyDelivered, buildEventKey, shouldSend } from "./dedup";
import { evaluateNotificationEvents } from "./notificationEvents";
import { backoffForAttempt, decideRetry } from "./retry";
import { isInQuietHours, isQuietAt, passesMinInterval } from "./quietHours";
import type { NotificationDelivery } from "./types";
import { at } from "./testFixtures";

function delivery(partial: Partial<NotificationDelivery>): NotificationDelivery {
  return {
    id: "d-1",
    eventId: "e-1",
    eventKey: "claude:weekly:reset_confirmed:2026-07-20T07:00:00.000Z",
    channelId: "ch-1",
    status: "sent",
    attemptCount: 1,
    ...partial,
  };
}

describe("notification dedup (spec §9 / §20 cases 19,20,21)", () => {
  it("builds stable, readable event keys", () => {
    expect(
      buildEventKey({
        providerId: "claude",
        limitKey: "weekly",
        eventType: "reset_confirmed",
        anchorIso: "2026-07-20T07:00:00.000Z",
      })
    ).toBe("claude:weekly:reset_confirmed:2026-07-20T07:00:00.000Z");
  });

  it("case 19+21: an already-sent (eventKey, channel) pair is never sent again", () => {
    const sent = [delivery({})];
    expect(alreadyDelivered(sent[0]!.eventKey, "ch-1", sent)).toBe(true);
    expect(shouldSend(sent[0]!.eventKey, "ch-1", sent)).toBe(false);
  });

  it("case 20: different channels may each deliver the same event once", () => {
    const sent = [delivery({ channelId: "ch-1" })];
    expect(shouldSend(sent[0]!.eventKey, "ch-2", sent)).toBe(true);
  });

  it("a failed delivery does not block a retry-send", () => {
    const failed = [delivery({ status: "failed" })];
    expect(shouldSend(failed[0]!.eventKey, "ch-1", failed)).toBe(true);
  });
});

describe("notification retry (spec §9 / §20 case 22)", () => {
  it("retries failures up to the max attempt count", () => {
    expect(decideRetry({ status: "failed", attemptCount: 1 }).shouldRetry).toBe(true);
    expect(decideRetry({ status: "failed", attemptCount: NOTIFICATION.MAX_ATTEMPTS }).shouldRetry).toBe(
      false
    );
  });

  it("never retries a successful or skipped delivery", () => {
    expect(decideRetry({ status: "sent", attemptCount: 1 }).shouldRetry).toBe(false);
    expect(decideRetry({ status: "skipped", attemptCount: 0 }).shouldRetry).toBe(false);
  });

  it("backoff grows exponentially and is capped", () => {
    expect(backoffForAttempt(1)).toBe(NOTIFICATION.BACKOFF_BASE_MS);
    expect(backoffForAttempt(2)).toBe(NOTIFICATION.BACKOFF_BASE_MS * 2);
    expect(backoffForAttempt(20)).toBe(NOTIFICATION.BACKOFF_MAX_MS);
  });
});

describe("quiet hours (spec §9 / §20 case 23)", () => {
  it("suppresses inside a same-day window", () => {
    expect(isInQuietHours({ start: "09:00", end: "17:00" }, 10 * 60)).toBe(true);
    expect(isInQuietHours({ start: "09:00", end: "17:00" }, 18 * 60)).toBe(false);
  });

  it("handles windows that wrap past midnight", () => {
    const q = { start: "22:00", end: "07:00" };
    expect(isInQuietHours(q, 23 * 60)).toBe(true);
    expect(isInQuietHours(q, 3 * 60)).toBe(true);
    expect(isInQuietHours(q, 12 * 60)).toBe(false);
  });

  it("no window configured → never quiet", () => {
    expect(isInQuietHours({}, 0)).toBe(false);
    expect(isQuietAt({}, new Date())).toBe(false);
  });

  it("min-interval gate", () => {
    expect(passesMinInterval(undefined, 30, at(1))).toBe(true);
    expect(passesMinInterval(at(0), 30, at(0.25))).toBe(false); // 15 min < 30
    expect(passesMinInterval(at(0), 30, at(1))).toBe(true); // 60 min ≥ 30
    expect(passesMinInterval(at(0), 0, at(0.01))).toBe(true); // disabled
  });
});

describe("notification event generation (spec §9)", () => {
  const baseCtx = {
    providerId: "claude" as const,
    providerLabel: "Claude",
    limitId: "limit-1",
    limitKey: "weekly",
    limitLabel: "週額度",
    now: at(10),
  };

  it("emits reset_expected with hedged copy (never claims confirmation)", () => {
    const events = evaluateNotificationEvents({
      ...baseCtx,
      resetOutcome: {
        kind: "expected",
        method: "expected_time_reached",
        confidence: 0.4,
        expectedResetAt: at(8),
        reasons: [],
      },
    });
    const e = events.find((x) => x.eventType === "reset_expected");
    expect(e).toBeDefined();
    expect(e!.title).toContain("預計");
    expect(e!.title).not.toContain("確認");
    expect(e!.eventKey).toContain("reset_expected");
  });

  it("warns when meaningful unused weekly allowance is close to expiry", () => {
    const events = evaluateNotificationEvents({
      ...baseCtx,
      now: at(10),
      nextResetAt: at(30),
      remainingPercent: 68,
      windowHours: 168,
    });
    const event = events.find((item) => item.eventType === "quota_expiring");
    expect(event?.title).toContain("即將到期");
    expect(event?.body).toContain("68%");
    expect(event?.body).toContain("平均每小時");
  });

  it("emits reset_confirmed with the new usage and next reset", () => {
    const events = evaluateNotificationEvents({
      ...baseCtx,
      currentUsedPercent: 2,
      nextResetAt: at(178),
      resetOutcome: {
        kind: "confirmed",
        method: "confirmed_by_usage_drop",
        confidence: 0.9,
        expectedResetAt: at(8),
        reasons: [],
      },
    });
    const e = events.find((x) => x.eventType === "reset_confirmed");
    expect(e).toBeDefined();
    expect(e!.body).toContain("2%");
  });

  it("labels an on-time confirmed reset as 已重置, not 臨時／提前", () => {
    const events = evaluateNotificationEvents({
      ...baseCtx,
      currentUsedPercent: 34,
      resetOutcome: {
        kind: "confirmed",
        method: "confirmed_by_reset_change",
        confidence: 0.7,
        expectedResetAt: at(8), // now is at(10) — boundary already passed
        reasons: [],
      },
    });
    const e = events.find((x) => x.eventType === "reset_confirmed");
    expect(e!.title).toContain("額度已重置");
    expect(e!.title).not.toContain("臨時");
    expect(e!.body).toContain("新週期已開始");
    expect(e!.body).toContain("34%");
  });

  it("labels a reset before the expected boundary as 臨時／提前重置", () => {
    const events = evaluateNotificationEvents({
      ...baseCtx,
      currentUsedPercent: 1,
      resetOutcome: {
        kind: "confirmed",
        method: "confirmed_by_usage_drop",
        confidence: 0.9,
        expectedResetAt: at(20), // now is at(10) — reset arrived early
        reasons: [],
      },
    });
    const e = events.find((x) => x.eventType === "reset_confirmed");
    expect(e!.title).toContain("臨時／提前重置");
    expect(e!.body).not.toContain("新週期已開始");
  });

  it("emits exhaustion_forecast with hedged wording when exhausting before reset", () => {
    const events = evaluateNotificationEvents({
      ...baseCtx,
      nextResetAt: at(36),
      forecast: {
        limitId: "limit-1",
        calculatedAt: at(10),
        estimatedExhaustionAt: at(24),
        willExhaustBeforeReset: true,
        confidence: 0.8,
        sampleCount: 5,
        warnings: [],
      },
    });
    const e = events.find((x) => x.eventType === "exhaustion_forecast");
    expect(e).toBeDefined();
    expect(e!.body).toMatch(/預估|可能|依目前/);
    expect(e!.severity).toBe("warning");
  });

  it("emits usage_warning at the remaining threshold", () => {
    const events = evaluateNotificationEvents({ ...baseCtx, remainingPercent: 10 });
    expect(events.some((x) => x.eventType === "usage_warning")).toBe(true);
  });

  it("emits a deduplicated expiry event for a Codex reset credit", () => {
    const expiresAtUnix = Math.floor(Date.parse(at(30)) / 1000);
    const events = evaluateNotificationEvents({
      ...baseCtx,
      providerId: "codex",
      providerLabel: "Codex",
      currentUsedPercent: 85,
      resetCreditsAvailable: 2,
      resetCredits: [{ title: "Full reset", expiresAtUnix }],
    });
    const event = events.find((item) => item.title.includes("Full reset"));
    expect(event?.eventType).toBe("quota_expiring");
    expect(event?.body).toMatch(/最晚安全使用時間|依目前資料/);
    expect(event?.severity).toBe("warning");
  });

  it("emits data_stale after the staleness threshold", () => {
    const events = evaluateNotificationEvents({ ...baseCtx, lastSuccessAt: at(0), now: at(10) });
    expect(events.some((x) => x.eventType === "data_stale")).toBe(true);
  });

  it("emits polling_failed when the run failed", () => {
    const events = evaluateNotificationEvents({ ...baseCtx, pollingFailed: true });
    expect(events.some((x) => x.eventType === "polling_failed")).toBe(true);
  });

  it("quiet context emits nothing", () => {
    const events = evaluateNotificationEvents({ ...baseCtx, remainingPercent: 80 });
    expect(events).toHaveLength(0);
  });

  it("same cycle → same eventKey (dedup-stable across runs)", () => {
    const mk = () =>
      evaluateNotificationEvents({
        ...baseCtx,
        nextResetAt: at(36),
        remainingPercent: 10,
      }).find((x) => x.eventType === "usage_warning")!.eventKey;
    expect(mk()).toBe(mk());
  });
});
