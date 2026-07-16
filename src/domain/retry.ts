// Notification retry policy (spec §9). Pure. Bounded attempts, exponential backoff, no infinite retry.

import { NOTIFICATION } from "./constants";
import type { NotificationDelivery } from "./types";

export type RetryDecision = {
  shouldRetry: boolean;
  /** Milliseconds to wait before the next attempt (0 when not retrying). */
  backoffMs: number;
  reason: string;
};

/** Exponential backoff for attempt N (1-based): BASE * 2^(N-1), capped. */
export function backoffForAttempt(attempt: number): number {
  const raw = NOTIFICATION.BACKOFF_BASE_MS * Math.pow(2, Math.max(0, attempt - 1));
  return Math.min(raw, NOTIFICATION.BACKOFF_MAX_MS);
}

export function decideRetry(delivery: Pick<NotificationDelivery, "status" | "attemptCount">): RetryDecision {
  if (delivery.status === "sent") {
    return { shouldRetry: false, backoffMs: 0, reason: "已成功送出，不需重試" };
  }
  if (delivery.status === "skipped") {
    return { shouldRetry: false, backoffMs: 0, reason: "已略過（去重或靜音）" };
  }
  if (delivery.attemptCount >= NOTIFICATION.MAX_ATTEMPTS) {
    return {
      shouldRetry: false,
      backoffMs: 0,
      reason: `已達最大重試次數 (${NOTIFICATION.MAX_ATTEMPTS})`,
    };
  }
  // status pending/failed and under the cap → retry with backoff for the NEXT attempt.
  return {
    shouldRetry: true,
    backoffMs: backoffForAttempt(delivery.attemptCount + 1),
    reason: "失敗，允許重試",
  };
}
