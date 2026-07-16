// Notification deduplication (spec §9). Pure.
//
// Each notifiable event has a STABLE key. Before sending on a channel we check whether that
// (eventKey, channelId) pair was already delivered successfully; if so we never send again.

import type { NotificationDelivery, NotificationEventType, ProviderId } from "./types";

export type EventKeyParts = {
  providerId: ProviderId | string;
  /** A stable label for the limit/window, e.g. "weekly" or a limit id. */
  limitKey: string;
  eventType: NotificationEventType;
  /** The cycle anchor — typically the reset time this event belongs to (ISO). */
  anchorIso: string;
};

/** e.g. `claude:weekly:reset_confirmed:2026-07-20T07:00:00.000Z` */
export function buildEventKey(parts: EventKeyParts): string {
  return `${parts.providerId}:${parts.limitKey}:${parts.eventType}:${parts.anchorIso}`;
}

/** True when this event has already been SENT successfully on this channel (skip re-send). */
export function alreadyDelivered(
  eventKey: string,
  channelId: string,
  deliveries: NotificationDelivery[]
): boolean {
  return deliveries.some(
    (d) => d.eventKey === eventKey && d.channelId === channelId && d.status === "sent"
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
