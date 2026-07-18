import {
  isChannelNotificationEventEnabled,
  isLimitNotificationEventEnabled,
  parseLimitNotificationPreferences,
  parseLimitUsageWarningThresholds,
  limitUsageWarningThreshold,
  setLimitUsageWarningThreshold,
  setLimitNotificationEvent,
} from "./limitNotificationPreferences";

describe("per-limit notification preferences", () => {
  it("enables a newly introduced expiry event for legacy channel settings", () => {
    expect(isChannelNotificationEventEnabled({}, "quota_expiring")).toBe(true);
    expect(isChannelNotificationEventEnabled({ quota_expiring: false }, "quota_expiring")).toBe(false);
  });
  it("defaults missing and malformed settings to enabled", () => {
    expect(isLimitNotificationEventEnabled(parseLimitNotificationPreferences(undefined), "a", "usage_warning")).toBe(true);
    expect(isLimitNotificationEventEnabled(parseLimitNotificationPreferences("not-json"), "a", "usage_warning")).toBe(true);
  });

  it("updates one event without changing another limit", () => {
    const initial = setLimitNotificationEvent({}, "claude-5h", "usage_warning", false);
    const next = setLimitNotificationEvent(initial, "codex-weekly", "reset_confirmed", false);
    expect(isLimitNotificationEventEnabled(next, "claude-5h", "usage_warning")).toBe(false);
    expect(isLimitNotificationEventEnabled(next, "claude-5h", "reset_confirmed")).toBe(true);
    expect(isLimitNotificationEventEnabled(next, "codex-weekly", "reset_confirmed")).toBe(false);
  });

  it("stores an independent usage warning threshold for each limit", () => {
    const values = setLimitUsageWarningThreshold(
      setLimitUsageWarningThreshold({}, "claude-5h", 20),
      "codex-weekly",
      30
    );
    expect(limitUsageWarningThreshold(values, "claude-5h", 15)).toBe(20);
    expect(limitUsageWarningThreshold(values, "codex-weekly", 15)).toBe(30);
    expect(limitUsageWarningThreshold(values, "other", 15)).toBe(15);
    expect(parseLimitUsageWarningThresholds(JSON.stringify({ a: 25, bad: 99, text: "10" }))).toEqual({ a: 25 });
  });
});
