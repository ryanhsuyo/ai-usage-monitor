// Notification deduplication (spec §9). Pure.
//
// Each notifiable event has a STABLE key. Before sending on a channel we check whether that
// (eventKey, channelId) pair was already delivered successfully; if so we never send again.

import { NOTIFICATION } from "./constants";
import type { NotificationDelivery, NotificationEventType, ProviderId } from "./types";

export type EventKeyParts = {
  providerId: ProviderId | string;
  /** A stable label for the limit/window, e.g. "weekly" or a limit id. */
  limitKey: string;
  eventType: NotificationEventType;
  /** The cycle anchor — typically the reset time this event belongs to (ISO). */
  anchorIso: string;
};

/**
 * Round an anchor to the minute. Providers restate the same reset moment with sub-second drift
 * between polls, and an anchor that moves mints a new key — which reads as a brand-new event and
 * re-notifies. Distinct cycles are hours apart, so a minute of resolution loses nothing.
 */
export function stableAnchor(anchorIso: string): string {
  const ms = Date.parse(anchorIso);
  if (Number.isNaN(ms)) return anchorIso;
  return new Date(Math.round(ms / 60_000) * 60_000).toISOString();
}

/** e.g. `claude:weekly:reset_confirmed:2026-07-20T07:00:00.000Z` */
export function buildEventKey(parts: EventKeyParts): string {
  return `${parts.providerId}:${parts.limitKey}:${parts.eventType}:${stableAnchor(parts.anchorIso)}`;
}

/**
 * Split a key into its identity (everything but the anchor) and the anchor's timestamp.
 * Matched from the right: both the limit key and the trailing ISO anchor contain colons, so
 * counting fields from the left would mistake an event type for the timestamp.
 */
function splitEventKey(eventKey: string): { identity: string; anchorMs?: number } {
  const match = /^(.*):(\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})?)$/.exec(eventKey);
  if (!match) return { identity: eventKey };
  const anchorMs = Date.parse(match[2]!);
  return { identity: match[1]!, anchorMs: Number.isNaN(anchorMs) ? undefined : anchorMs };
}

/**
 * Do two keys describe the same event in the same cycle? Anchors within
 * CYCLE_ANCHOR_TOLERANCE_MS count as one cycle, so provider timestamp drift between polls
 * cannot mint a "new" event and re-notify about a quota the user already heard about.
 */
export function isSameCycleEvent(eventKey: string, otherKey: string): boolean {
  if (eventKey === otherKey) return true;
  const a = splitEventKey(eventKey);
  const b = splitEventKey(otherKey);
  if (a.identity !== b.identity) return false;
  if (a.anchorMs === undefined || b.anchorMs === undefined) return false;
  return Math.abs(a.anchorMs - b.anchorMs) <= NOTIFICATION.CYCLE_ANCHOR_TOLERANCE_MS;
}

/** True when this event has already been SENT successfully on this channel (skip re-send). */
export function alreadyDelivered(
  eventKey: string,
  channelId: string,
  deliveries: NotificationDelivery[]
): boolean {
  return deliveries.some(
    (d) => d.channelId === channelId && d.status === "sent" && isSameCycleEvent(eventKey, d.eventKey)
  );
}

/** Decide whether to send: not already delivered on this channel. */
export function shouldSend(
  eventKey: string,
  channelId: string,
  deliveries: NotificationDelivery[]
): boolean {
  return !alreadyDelivered(eventKey, channelId, deliveries);
}
