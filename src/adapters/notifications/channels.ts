// Notification channel adapters (spec §9). Five channels behind one interface.
//
// Secrets (webhook URLs / bot tokens) arrive via `runtime.secret`, resolved from SecretStore by
// the dispatcher. They are never logged and never appear in returned error messages — errors are
// passed through `redactSecrets`/`redactUrl` first.

import type {
  ChannelRuntime,
  HttpPosterLike,
  NotificationChannelAdapter,
  NotificationMessage,
  NotificationResult,
  SystemNotifier,
  ValidationResult,
} from "./deps";
import { checkWebhookUrl, redactSecrets, redactUrl } from "./urlSafety";

function nowIso(): string {
  return new Date().toISOString();
}

function failure(errorCode: string, message: string, secrets: Array<string | undefined>): NotificationResult {
  return { ok: false, errorCode, message: redactSecrets(message, secrets) };
}

const SEVERITY_PREFIX: Record<NotificationMessage["severity"], string> = {
  info: "ℹ️",
  warning: "⚠️",
  critical: "🚨",
};

function plainText(message: NotificationMessage): string {
  return `${SEVERITY_PREFIX[message.severity]} ${message.title}\n${message.body}`;
}

function discordPayload(message: NotificationMessage) {
  // Plain text, exactly once. An embed carries severity colour and a footer, but a client that
  // declines to render it leaves a completely empty message — observed in the wild, and worse
  // than plain text. Sending both (the earlier attempt at a safety net) shows the same words
  // twice wherever embeds *do* render. Text always renders, and the severity glyph carries the
  // urgency the colour used to.
  const content = `**${SEVERITY_PREFIX[message.severity]} ${message.title}**\n${message.body}`;
  return {
    username: "AI Usage Monitor",
    content: content.slice(0, 2000),
    allowed_mentions: { parse: [] },
  };
}

// ---------- Desktop ----------

export function createDesktopAdapter(notifier: SystemNotifier): NotificationChannelAdapter {
  return {
    type: "desktop",
    async validateConfiguration(): Promise<ValidationResult> {
      return { ok: true };
    },
    async send(_config, _runtime, message): Promise<NotificationResult> {
      try {
        await notifier.send({ title: message.title, body: message.body });
        return { ok: true, deliveredAt: nowIso() };
      } catch (err) {
        return failure("desktop_failed", err instanceof Error ? err.message : String(err), []);
      }
    },
  };
}

// ---------- Discord ----------

export function createDiscordAdapter(http: HttpPosterLike): NotificationChannelAdapter {
  return {
    type: "discord",
    async validateConfiguration(_config, runtime): Promise<ValidationResult> {
      if (!runtime.secret) return { ok: false, message: "尚未設定 Webhook URL" };
      const check = checkWebhookUrl(runtime.secret);
      if (!check.ok) return check;
      if (!/(^|\.)discord(?:app)?\.com$/i.test(check.url.hostname)) {
        return { ok: false, message: "這不是 Discord Webhook 網域" };
      }
      if (!/^\/api\/webhooks\/[^/]+\/[^/]+\/?$/i.test(check.url.pathname)) {
        return { ok: false, message: "Discord Webhook URL 格式不完整" };
      }
      return { ok: true };
    },
    async send(config, runtime, message): Promise<NotificationResult> {
      const valid = await this.validateConfiguration(config, runtime);
      if (!valid.ok) return failure("invalid_config", valid.message, [runtime.secret]);
      try {
        const res = await http.postJson(runtime.secret as string, discordPayload(message));
        if (!res.ok) {
          return failure("discord_http_error", `Discord 回應 HTTP ${res.status}`, [runtime.secret]);
        }
        return { ok: true, deliveredAt: nowIso() };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return failure(
          "discord_network_error",
          `無法連線 ${redactUrl(runtime.secret as string)}: ${msg}`,
          [runtime.secret]
        );
      }
    },
  };
}

// ---------- Slack ----------

export function createSlackAdapter(http: HttpPosterLike): NotificationChannelAdapter {
  return {
    type: "slack",
    async validateConfiguration(_config, runtime): Promise<ValidationResult> {
      if (!runtime.secret) return { ok: false, message: "尚未設定 Webhook URL" };
      const check = checkWebhookUrl(runtime.secret);
      if (!check.ok) return check;
      if (!/(^|\.)slack\.com$/i.test(check.url.hostname)) {
        return { ok: false, message: "這不是 Slack Webhook 網域" };
      }
      return { ok: true };
    },
    async send(config, runtime, message): Promise<NotificationResult> {
      const valid = await this.validateConfiguration(config, runtime);
      if (!valid.ok) return failure("invalid_config", valid.message, [runtime.secret]);
      try {
        const res = await http.postJson(runtime.secret as string, { text: plainText(message) });
        if (!res.ok) {
          return failure("slack_http_error", `Slack 回應 HTTP ${res.status}`, [runtime.secret]);
        }
        return { ok: true, deliveredAt: nowIso() };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return failure(
          "slack_network_error",
          `無法連線 ${redactUrl(runtime.secret as string)}: ${msg}`,
          [runtime.secret]
        );
      }
    },
  };
}

// ---------- Telegram ----------

export function createTelegramAdapter(http: HttpPosterLike): NotificationChannelAdapter {
  return {
    type: "telegram",
    async validateConfiguration(config, runtime): Promise<ValidationResult> {
      if (!runtime.secret) return { ok: false, message: "尚未設定 Bot Token" };
      if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(runtime.secret)) {
        return { ok: false, message: "Bot Token 格式不正確" };
      }
      if (!config.config?.chatId) {
        return { ok: false, message: "尚未設定 Chat ID" };
      }
      return { ok: true };
    },
    async send(config, runtime, message): Promise<NotificationResult> {
      const valid = await this.validateConfiguration(config, runtime);
      if (!valid.ok) return failure("invalid_config", valid.message, [runtime.secret]);
      try {
        const url = `https://api.telegram.org/bot${runtime.secret}/sendMessage`;
        const res = await http.postJson(url, {
          chat_id: config.config?.chatId,
          text: plainText(message),
        });
        if (!res.ok) {
          return failure("telegram_http_error", `Telegram 回應 HTTP ${res.status}`, [runtime.secret]);
        }
        return { ok: true, deliveredAt: nowIso() };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return failure("telegram_network_error", `Telegram 傳送失敗: ${msg}`, [runtime.secret]);
      }
    },
  };
}

// ---------- Custom webhook ----------

export function createCustomWebhookAdapter(http: HttpPosterLike): NotificationChannelAdapter {
  return {
    type: "custom_webhook",
    async validateConfiguration(config, runtime): Promise<ValidationResult> {
      if (!runtime.secret) return { ok: false, message: "尚未設定 Webhook URL" };
      const allowLocal = config.config?.allowLocal === "true";
      return checkWebhookUrl(runtime.secret, { allowLocal });
    },
    async send(config, runtime, message): Promise<NotificationResult> {
      const valid = await this.validateConfiguration(config, runtime);
      if (!valid.ok) return failure("invalid_config", valid.message, [runtime.secret]);
      try {
        const res = await http.postJson(runtime.secret as string, {
          title: message.title,
          body: message.body,
          severity: message.severity,
          source: "ai-usage-monitor",
          sentAt: nowIso(),
        });
        if (!res.ok) {
          return failure("webhook_http_error", `Webhook 回應 HTTP ${res.status}`, [runtime.secret]);
        }
        return { ok: true, deliveredAt: nowIso() };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return failure(
          "webhook_network_error",
          `無法連線 ${redactUrl(runtime.secret as string)}: ${msg}`,
          [runtime.secret]
        );
      }
    },
  };
}

export type ChannelAdapters = Record<string, NotificationChannelAdapter>;

export function createChannelAdapters(deps: {
  notifier: SystemNotifier;
  http: HttpPosterLike;
}): ChannelAdapters {
  return {
    desktop: createDesktopAdapter(deps.notifier),
    discord: createDiscordAdapter(deps.http),
    slack: createSlackAdapter(deps.http),
    telegram: createTelegramAdapter(deps.http),
    custom_webhook: createCustomWebhookAdapter(deps.http),
  };
}

// keep ChannelRuntime referenced for callers importing from this module
export type { ChannelRuntime };
