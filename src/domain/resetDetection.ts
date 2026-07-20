// Reset detection (spec §11). Pure.
//
// A "confirmed" reset requires a real usage drop (or an advanced reset timestamp) — a single
// snapshot reading 0 is NOT sufficient on its own. "Expected time reached" is kept strictly
// separate and NEVER claims confirmation.

import { RESET_DETECTION } from "./constants";
import type { ResetDetectionMethod, UsageSnapshot } from "./types";
import { isValidIso, toMs } from "./util";

export type ResetDetectionInput = {
  previous?: UsageSnapshot;
  current?: UsageSnapshot;
  now: string;
  /** The reset time we were expecting for the current cycle. */
  expectedResetAt?: string;
  /** True when the provider/current snapshot advanced resetAt to the next cycle. */
  resetAtAdvanced?: boolean;
  /** Count of consecutive recent valid snapshots that stayed at a low usage level. */
  consecutiveLowReadings?: number;
};

export type ResetDetectionOutcome = {
  kind: "confirmed" | "expected" | "none";
  method?: ResetDetectionMethod;
  confidence: number;
  previousUsedPercent?: number;
  currentUsedPercent?: number;
  expectedResetAt?: string;
  reasons: string[];
};

const NONE: ResetDetectionOutcome = { kind: "none", confidence: 0, reasons: [] };

/**
 * Whether the provider advanced resetAt to a NEW cycle. Live usage fetches jitter resets_at by
 * around a second within the same cycle, so a real advance must exceed a meaningful margin.
 */
export function resetAtAdvancedBetween(previousResetAt?: string, latestResetAt?: string): boolean {
  if (!isValidIso(previousResetAt) || !isValidIso(latestResetAt)) return false;
  return toMs(latestResetAt!) - toMs(previousResetAt!) > RESET_DETECTION.MIN_ADVANCE_MS;
}

export function detectReset(input: ResetDetectionInput): ResetDetectionOutcome {
  const { previous, current } = input;

  // --- Confirmation path (needs a valid, error-free current reading) ---
  if (current && current.valid && !current.errorCode) {
    const curUsed = current.usedPercent;

    // (a) confirmed by usage drop
    if (previous && previous.valid) {
      const prevUsed = previous.usedPercent;
      const drop = prevUsed - curUsed;
      const candidate =
        prevUsed >= RESET_DETECTION.PREV_USED_MIN &&
        curUsed <= RESET_DETECTION.CURR_USED_MAX &&
        drop >= RESET_DETECTION.MIN_DROP;

      if (candidate) {
        let confidence = 0.75;
        const reasons = [`用量由 ${prevUsed}% 降至 ${curUsed}%`];
        if (input.resetAtAdvanced) {
          confidence += 0.15;
          reasons.push("重置時間已更新至下一週期");
        }
        if ((input.consecutiveLowReadings ?? 0) >= 2) {
          confidence += 0.1;
          reasons.push("連續多筆低用量快照");
        }
        return {
          kind: "confirmed",
          method: "confirmed_by_usage_drop",
          confidence: Math.min(confidence, 1),
          previousUsedPercent: prevUsed,
          currentUsedPercent: curUsed,
          expectedResetAt: input.expectedResetAt,
          reasons,
        };
      }
    }

    // (b) confirmed by reset-timestamp change. The provider advancing resets_at to the next
    // cycle is authoritative on its own — usage may already have re-accumulated when the app
    // was asleep across the boundary, so a low current reading only raises confidence.
    if (input.resetAtAdvanced) {
      const usageLow = curUsed <= RESET_DETECTION.CURR_USED_MAX;
      return {
        kind: "confirmed",
        method: "confirmed_by_reset_change",
        confidence: usageLow ? 0.8 : 0.7,
        previousUsedPercent: previous?.usedPercent,
        currentUsedPercent: curUsed,
        expectedResetAt: input.expectedResetAt,
        reasons: usageLow
          ? ["重置時間已更新且用量已降低"]
          : [`重置時間已更新至下一週期，新週期已使用 ${Math.round(curUsed)}%`],
      };
    }
  }

  // --- Expected path (time reached but no confirming reading) ---
  if (isValidIso(input.expectedResetAt) && toMs(input.now) >= toMs(input.expectedResetAt)) {
    return {
      kind: "expected",
      method: "expected_time_reached",
      confidence: 0.4,
      previousUsedPercent: previous?.usedPercent,
      currentUsedPercent: current?.usedPercent,
      expectedResetAt: input.expectedResetAt,
      reasons: ["預計重置時間已到達，但尚未取得可確認的新用量"],
    };
  }

  return NONE;
}
