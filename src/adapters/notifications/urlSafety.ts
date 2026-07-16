// Webhook URL safety + redaction (spec: Security — SSRF basic limits, log redaction).
// Pure helpers; used by every outbound channel adapter.

const PRIVATE_HOST_PATTERNS: RegExp[] = [
  /^localhost$/i,
  /^127\./,
  /^0\.0\.0\.0$/,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./, // link-local / cloud metadata
  /^\[?::1\]?$/,
  /^\[?fe80:/i,
  /^\[?fc/i, // unique-local ipv6
  /^\[?fd/i,
];

export type UrlCheck = { ok: true; url: URL } | { ok: false; message: string };

/**
 * Validate an outbound webhook URL: https only, no credentials in URL, no private/loopback hosts.
 * `allowLocal` exists for explicit user-opted custom webhooks to localhost tooling.
 */
export function checkWebhookUrl(raw: string, opts?: { allowLocal?: boolean }): UrlCheck {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, message: "URL 格式無效" };
  }
  if (url.username || url.password) {
    return { ok: false, message: "URL 不可內含帳號密碼" };
  }
  const isLocal = PRIVATE_HOST_PATTERNS.some((p) => p.test(url.hostname));
  if (url.protocol !== "https:") {
    // http allowed only for explicitly-permitted local targets
    if (!(opts?.allowLocal && url.protocol === "http:" && isLocal)) {
      return { ok: false, message: "僅允許 https URL" };
    }
  }
  if (isLocal && !opts?.allowLocal) {
    return { ok: false, message: "不允許指向內部或保留位址" };
  }
  return { ok: true, url };
}

/** Redact a URL for logs/errors: keep origin + first path segment, drop the rest. */
export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    const seg = url.pathname.split("/").filter(Boolean)[0];
    return `${url.origin}/${seg ?? ""}…`;
  } catch {
    return "[invalid-url]";
  }
}

/** Redact any secret-looking token in an arbitrary error message. */
export function redactSecrets(message: string, secrets: Array<string | undefined>): string {
  let out = message;
  for (const s of secrets) {
    if (s && s.length >= 6) {
      out = out.split(s).join("[redacted]");
    }
  }
  return out;
}
