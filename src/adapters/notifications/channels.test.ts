import { describe, expect, it } from "vitest";
import type { NotificationChannelConfig } from "@/domain/types";
import { InMemoryNotifier } from "@/adapters/platform";
import {
  createCustomWebhookAdapter,
  createDesktopAdapter,
  createDiscordAdapter,
  createSlackAdapter,
  createTelegramAdapter,
} from "./channels";
import type { HttpPoster, HttpResponse } from "./http";
import { checkWebhookUrl, redactSecrets, redactUrl } from "./urlSafety";

const NOW = "2026-07-13T10:00:00.000Z";

function config(partial: Partial<NotificationChannelConfig> = {}): NotificationChannelConfig {
  return {
    id: "ch-1",
    type: "discord",
    displayName: "Test",
    enabled: true,
    eventPreferences: {
    quota_expiring: true, reset_expected: true,
      reset_confirmed: true,
      usage_warning: true,
      exhaustion_forecast: true,
      polling_failed: false,
      data_stale: false,
    },
    createdAt: NOW,
    updatedAt: NOW,
    ...partial,
  };
}

const MESSAGE = { title: "測試通知", body: "這是一則測試訊息。", severity: "info" as const };

function fakeHttp(
  response: HttpResponse | Error
): HttpPoster & { calls: Array<{ url: string; body: unknown }> } {
  const calls: Array<{ url: string; body: unknown }> = [];
  return {
    calls,
    async postJson(url, body) {
      calls.push({ url, body });
      if (response instanceof Error) throw response;
      return response;
    },
  };
}

describe("URL safety (spec: security / SSRF basics)", () => {
  it("accepts normal https URLs and rejects http/credentials/private hosts", () => {
    expect(checkWebhookUrl("https://discord.com/api/webhooks/1/abc").ok).toBe(true);
    expect(checkWebhookUrl("http://discord.com/api").ok).toBe(false);
    expect(checkWebhookUrl("https://user:pass@discord.com/x").ok).toBe(false);
    expect(checkWebhookUrl("https://127.0.0.1/hook").ok).toBe(false);
    expect(checkWebhookUrl("https://192.168.1.10/hook").ok).toBe(false);
    expect(checkWebhookUrl("https://169.254.169.254/latest").ok).toBe(false);
    expect(checkWebhookUrl("not a url").ok).toBe(false);
  });

  it("allows localhost only when explicitly opted in", () => {
    expect(checkWebhookUrl("http://localhost:3000/hook").ok).toBe(false);
    expect(checkWebhookUrl("http://localhost:3000/hook", { allowLocal: true }).ok).toBe(true);
  });

  it("redacts URLs down to origin + first segment", () => {
    expect(redactUrl("https://discord.com/api/webhooks/123/SECRETTOKEN")).toBe(
      "https://discord.com/api…"
    );
  });

  it("redacts secret substrings from error messages", () => {
    const msg = redactSecrets("failed to post to https://x.com/hook/SECRET123", ["SECRET123"]);
    expect(msg).not.toContain("SECRET123");
    expect(msg).toContain("[redacted]");
  });
});

describe("channel adapters (spec §9)", () => {
  it("desktop: delegates to SystemNotifier", async () => {
    const notifier = new InMemoryNotifier();
    const adapter = createDesktopAdapter(notifier);
    const res = await adapter.send(config({ type: "desktop" }), {}, MESSAGE);
    expect(res.ok).toBe(true);
    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0]!.title).toBe("測試通知");
  });

  it("discord: posts content to the webhook and succeeds", async () => {
    const http = fakeHttp({ status: 204, ok: true });
    const adapter = createDiscordAdapter(http);
    const res = await adapter.send(
      config(),
      { secret: "https://discord.com/api/webhooks/1/tok" },
      MESSAGE
    );
    expect(res.ok).toBe(true);
    expect(http.calls[0]!.url).toContain("discord.com");
    expect((http.calls[0]!.body as { embeds: Array<{ title: string }> }).embeds[0]?.title).toContain("測試通知");
  });

  it("discord: missing/foreign webhook is rejected before any network call", async () => {
    const http = fakeHttp({ status: 200, ok: true });
    const adapter = createDiscordAdapter(http);
    const noSecret = await adapter.send(config(), {}, MESSAGE);
    expect(noSecret.ok).toBe(false);
    const wrongHost = await adapter.send(config(), { secret: "https://evil.com/hook" }, MESSAGE);
    expect(wrongHost.ok).toBe(false);
    expect(http.calls).toHaveLength(0);
  });

  it("discord: rejects lookalike domains and incomplete webhook paths", async () => {
    const http = fakeHttp({ status: 204, ok: true });
    const adapter = createDiscordAdapter(http);
    await expect(adapter.validateConfiguration(config(), { secret: "https://evil-discord.com/api/webhooks/1/token" })).resolves.toMatchObject({ ok: false });
    await expect(adapter.validateConfiguration(config(), { secret: "https://discord.com/channels/1/2" })).resolves.toMatchObject({ ok: false });
    expect(http.calls).toHaveLength(0);
  });

  it("discord: sends a product embed and disables mentions", async () => {
    const http = fakeHttp({ status: 204, ok: true });
    const adapter = createDiscordAdapter(http);
    await adapter.send(config(), { secret: "https://discord.com/api/webhooks/1/token" }, { title: "額度提醒", body: "剩餘 10%", severity: "warning" });
    expect(http.calls[0]?.body).toMatchObject({
      username: "AI Usage Monitor",
      allowed_mentions: { parse: [] },
      embeds: [{ title: "⚠️ 額度提醒", description: "剩餘 10%", color: 0xd49a3a }],
    });
  });

  it("discord: renders the message once — no plain-text copy alongside the embed", async () => {
    const http = fakeHttp({ status: 204, ok: true });
    const adapter = createDiscordAdapter(http);
    await adapter.send(config(), { secret: "https://discord.com/api/webhooks/1/token" }, MESSAGE);
    const body = http.calls[0]?.body as { content?: string; embeds: Array<{ title: string; description: string }> };
    // A `content` duplicate makes clients that do render embeds show the same text twice.
    expect(body.content ?? "").toBe("");
    expect(body.embeds).toHaveLength(1);
    expect(body.embeds[0]!.title).toContain("測試通知");
    expect(body.embeds[0]!.description).toBe("這是一則測試訊息。");
  });

  it("failure responses carry an error code and NEVER leak the secret", async () => {
    const secret = "https://discord.com/api/webhooks/1/SUPERSECRETTOKEN";
    const http = fakeHttp(new Error(`connect failed for ${secret}`));
    const adapter = createDiscordAdapter(http);
    const res = await adapter.send(config(), { secret }, MESSAGE);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.message).not.toContain("SUPERSECRETTOKEN");
      expect(res.errorCode).toBe("discord_network_error");
    }
  });

  it("slack: validates slack.com host and posts text payload", async () => {
    const http = fakeHttp({ status: 200, ok: true });
    const adapter = createSlackAdapter(http);
    const res = await adapter.send(
      config({ type: "slack" }),
      { secret: "https://hooks.slack.com/services/T/B/x" },
      MESSAGE
    );
    expect(res.ok).toBe(true);
    expect((http.calls[0]!.body as { text: string }).text).toContain("測試通知");
  });

  it("telegram: requires token format + chatId, posts to bot API", async () => {
    const http = fakeHttp({ status: 200, ok: true });
    const adapter = createTelegramAdapter(http);
    const badToken = await adapter.send(
      config({ type: "telegram", config: { chatId: "123" } }),
      { secret: "not-a-token" },
      MESSAGE
    );
    expect(badToken.ok).toBe(false);

    const noChat = await adapter.send(
      config({ type: "telegram" }),
      { secret: "12345:ABCDEFGHIJKLMNOPQRSTUVWX" },
      MESSAGE
    );
    expect(noChat.ok).toBe(false);

    const good = await adapter.send(
      config({ type: "telegram", config: { chatId: "123" } }),
      { secret: "12345:ABCDEFGHIJKLMNOPQRSTUVWX" },
      MESSAGE
    );
    expect(good.ok).toBe(true);
    expect(http.calls[0]!.url).toContain("api.telegram.org");
  });

  it("telegram: HTTP failure never leaks the bot token", async () => {
    const secret = "12345:ABCDEFGHIJKLMNOPQRSTUVWX";
    const http = fakeHttp(new Error(`404 for https://api.telegram.org/bot${secret}/sendMessage`));
    const adapter = createTelegramAdapter(http);
    const res = await adapter.send(
      config({ type: "telegram", config: { chatId: "123" } }),
      { secret },
      MESSAGE
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).not.toContain(secret);
  });

  it("custom webhook: posts a structured JSON payload", async () => {
    const http = fakeHttp({ status: 200, ok: true });
    const adapter = createCustomWebhookAdapter(http);
    const res = await adapter.send(
      config({ type: "custom_webhook" }),
      { secret: "https://example.com/hooks/ai-usage" },
      MESSAGE
    );
    expect(res.ok).toBe(true);
    const body = http.calls[0]!.body as Record<string, unknown>;
    expect(body.title).toBe("測試通知");
    expect(body.severity).toBe("info");
    expect(body.source).toBe("ai-usage-monitor");
  });

  it("custom webhook: private targets rejected unless allowLocal", async () => {
    const http = fakeHttp({ status: 200, ok: true });
    const adapter = createCustomWebhookAdapter(http);
    const rejected = await adapter.send(
      config({ type: "custom_webhook" }),
      { secret: "http://192.168.1.5/hook" },
      MESSAGE
    );
    expect(rejected.ok).toBe(false);

    const allowed = await adapter.send(
      config({ type: "custom_webhook", config: { allowLocal: "true" } }),
      { secret: "http://localhost:9000/hook" },
      MESSAGE
    );
    expect(allowed.ok).toBe(true);
  });
});
