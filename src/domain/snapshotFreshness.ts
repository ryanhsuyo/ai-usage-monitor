import type { UsageSnapshot } from "./types";
import { isValidIso } from "./util";

export type SnapshotCycleState = "current" | "awaiting_provider_refresh";

/**
 * Once resetAt has passed, the reading belongs to the previous provider cycle until the provider
 * advances resetAt. We hide its percentage instead of inventing a zero-percent snapshot.
 */
export function snapshotCycleState(snapshot: UsageSnapshot | undefined, nowIso: string): SnapshotCycleState {
  if (!snapshot?.resetAt || !isValidIso(snapshot.resetAt) || !isValidIso(nowIso)) return "current";
  return Date.parse(nowIso) >= Date.parse(snapshot.resetAt) ? "awaiting_provider_refresh" : "current";
}
