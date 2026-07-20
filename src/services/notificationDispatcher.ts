// NotificationDispatcher (spec §9): persist candidate events, fan out to enabled channels,
// enforcing per-channel event preferences, dedup, quiet hours, min interval and bounded retry.
//
// Secrets are resolved from SecretStore at send time only and never persisted or logged.

import type { CandidateEvent } from "@/domain/notificationEvents";
import { isChannelNotificationEventEnabled } from "@/domain/limitNotificationPreferences";
import { shouldSend } from "@/domain/dedup";
import { isQuietAt } from "@/domain/quietHours";
import { passesMinInterval } from "@/domain/quietHours";
import { decideRetry } from "@/domain/retry";
import type {
  NotificationChannelConfig,
  NotificationDelivery,
  NotificationEvent,
} from "@/domain/types";
import type { NotificationChannelAdapter, NotificationRepository, SecretStore } from "@/ports";
import { newId, nowIso } from "./ids";

/**
 * How far back dedup looks for a prior delivery. Comfortably longer than the longest cycle
 * (weekly), so a repeat within the same cycle is always found while the query stays bounded.
 */
const DEDUP_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

export type DispatchSummary = {
  eventsPersisted: number;
  sent: number;
  skipped: number;
  failed: number;
};

export type DispatcherDeps = {
  repo: NotificationRepository;
  secretStore: SecretStore;
  adapters: Record<string, NotificationChannelAdapter>;
  /** Master switch — when false nothing is dispatched (spec: 可關閉所有通知). */
  notificationsEnabled: () => Promise<boolean>;
  now?: () => string;
};

export function createNotificationDispatcher(deps: DispatcherDeps) {
  const now = deps.now ?? nowIso;

  async function persistEvent(candidate: CandidateEvent): Promise<NotificationEvent> {
    const existing = await deps.repo.findEventByKey(candidate.eventKey);
    if (existing) return existing;
    const event: NotificationEvent = {
      id: newId("evt"),
      eventKey: candidate.eventKey,
      eventType: candidate.eventType,
      providerId: candidate.providerId,
      accountId: candidate.accountId,
      limitId: candidate.limitId,
      title: candidate.title,
      body: candidate.body,
      severity: candidate.severity,
      createdAt: now(),
    };
    await deps.repo.insertEvent(event);
    return event;
  }

  /**
   * Claim the delivery slot for this (event, channel). Returns undefined when another run won
   * the claim — the unique index on (event_key, channel_id) is the arbiter, so a concurrent
   * dispatcher can neither send the same notification twice nor crash the run it lost.
   */
  async function deliveryFor(
    event: NotificationEvent,
    channel: NotificationChannelConfig
  ): Promise<NotificationDelivery | undefined> {
    const existing = await deps.repo.listDeliveries({
      eventKey: event.eventKey,
      channelId: channel.id,
    });
    if (existing[0]) return existing[0];
    const fresh: NotificationDelivery = {
      id: newId("del"),
      eventId: event.id,
      eventKey: event.eventKey,
      channelId: channel.id,
      status: "pending",
      attemptCount: 0,
    };
    try {
      await deps.repo.insertDelivery(fresh);
    } catch (error) {
      const raced = await deps.repo.listDeliveries({
        eventKey: event.eventKey,
        channelId: channel.id,
      });
      if (raced[0]) return undefined; // lost the race; the winner owns the send
      throw error; // a genuine storage failure, not a duplicate claim
    }
    return fresh;
  }

  async function attemptSend(
    event: NotificationEvent,
    channel: NotificationChannelConfig,
    delivery: NotificationDelivery
  ): Promise<"sent" | "failed" | "skipped"> {
    const adapter = deps.adapters[channel.type];
    if (!adapter) {
      await deps.repo.updateDelivery({
        ...delivery,
        status: "failed",
        attemptCount: delivery.attemptCount + 1,
        attemptedAt: now(),
        errorCode: "no_adapter",
        errorMessage: `未知的通知管道類型 ${channel.type}`,
      });
      return "failed";
    }

    let secret: string | undefined;
    if (channel.secretRef) {
      secret = (await deps.secretStore.getSecret(channel.secretRef)) ?? undefined;
    }

    const result = await adapter.send(channel, { secret }, {
      title: event.title,
      body: event.body,
      severity: event.severity,
    });

    if (result.ok) {
      await deps.repo.updateDelivery({
        ...delivery,
        status: "sent",
        attemptCount: delivery.attemptCount + 1,
        attemptedAt: now(),
        deliveredAt: result.deliveredAt,
        errorCode: undefined,
        errorMessage: undefined,
      });
      return "sent";
    }
    await deps.repo.updateDelivery({
      ...delivery,
      status: "failed",
      attemptCount: delivery.attemptCount + 1,
      attemptedAt: now(),
      errorCode: result.errorCode,
      errorMessage: result.message, // already redacted by the adapter
    });
    return "failed";
  }

  return {
    /** Dispatch a batch of candidate events to all eligible channels. */
    async dispatch(candidates: CandidateEvent[]): Promise<DispatchSummary> {
      const summary: DispatchSummary = { eventsPersisted: 0, sent: 0, skipped: 0, failed: 0 };
      if (candidates.length === 0) return summary;
      if (!(await deps.notificationsEnabled())) {
        summary.skipped = candidates.length;
        return summary;
      }

      const channels = (await deps.repo.listChannels()).filter((c) => c.enabled);

      for (const candidate of candidates) {
        const event = await persistEvent(candidate);
        summary.eventsPersisted += 1;

        for (const channel of channels) {
          // per-channel event preference
          if (!isChannelNotificationEventEnabled(channel.eventPreferences, event.eventType)) continue;

          // Dedup: never resend a successfully-sent (event, channel) for the same cycle. The
          // lookup is per channel rather than per exact key so a provider timestamp that drifted
          // between polls still matches its earlier delivery (see isSameCycleEvent).
          const deliveries = await deps.repo.listDeliveries({
            channelId: channel.id,
            attemptedSince: new Date(Date.parse(now()) - DEDUP_LOOKBACK_MS).toISOString(),
          });
          if (!shouldSend(event.eventKey, channel.id, deliveries)) continue;

          const delivery = await deliveryFor(event, channel);
          if (!delivery) continue; // another run is already delivering this one

          // bounded retry
          const retry = decideRetry(delivery);
          if (delivery.attemptCount > 0 && !retry.shouldRetry) continue;

          // quiet hours — evaluated in the user's local time
          if (
            isQuietAt(
              { start: channel.quietHoursStart, end: channel.quietHoursEnd },
              new Date(Date.parse(now()))
            )
          ) {
            await deps.repo.updateDelivery({ ...delivery, status: "skipped", attemptedAt: now(), errorCode: "quiet_hours" });
            summary.skipped += 1;
            continue;
          }

          // per-channel minimum interval
          const lastSent = await deps.repo.lastSentAtForChannel(channel.id);
          if (!passesMinInterval(lastSent, channel.minIntervalMinutes, now())) {
            await deps.repo.updateDelivery({ ...delivery, status: "skipped", attemptedAt: now(), errorCode: "min_interval" });
            summary.skipped += 1;
            continue;
          }

          const outcome = await attemptSend(event, channel, delivery);
          if (outcome === "sent") summary.sent += 1;
          else if (outcome === "failed") summary.failed += 1;
          else summary.skipped += 1;
        }
      }
      return summary;
    },

    /** Retry previously failed deliveries that are still under the attempt cap. */
    async retryFailed(): Promise<DispatchSummary> {
      const summary: DispatchSummary = { eventsPersisted: 0, sent: 0, skipped: 0, failed: 0 };
      if (!(await deps.notificationsEnabled())) return summary;
      const channels = (await deps.repo.listChannels()).filter((c) => c.enabled);
      const channelById = new Map(channels.map((c) => [c.id, c]));

      const failed = (await deps.repo.listDeliveries()).filter((d) => d.status === "failed");
      for (const delivery of failed) {
        const retry = decideRetry(delivery);
        if (!retry.shouldRetry) continue;
        const channel = channelById.get(delivery.channelId);
        if (!channel) continue;
        const event = await deps.repo.findEventByKey(delivery.eventKey);
        if (!event) continue;
        const outcome = await attemptSend(event, channel, delivery);
        if (outcome === "sent") summary.sent += 1;
        else summary.failed += 1;
      }
      return summary;
    },

    /** Send a test message straight to one channel (bypasses dedup; used by Settings). */
    async sendTest(
      channel: NotificationChannelConfig,
      preview?: { title: string; body: string; severity: "info" | "warning" | "critical" }
    ): Promise<{ ok: boolean; message?: string }> {
      const adapter = deps.adapters[channel.type];
      if (!adapter) return { ok: false, message: `未知的通知管道類型 ${channel.type}` };
      let secret: string | undefined;
      if (channel.secretRef) {
        secret = (await deps.secretStore.getSecret(channel.secretRef)) ?? undefined;
      }
      const result = await adapter.send(channel, { secret }, preview ?? {
        title: "AI Usage Monitor 測試通知",
        body: "如果你看到這則訊息，表示通知管道設定成功。",
        severity: "info",
      });
      return result.ok ? { ok: true } : { ok: false, message: result.message };
    },
  };
}

export type NotificationDispatcher = ReturnType<typeof createNotificationDispatcher>;
