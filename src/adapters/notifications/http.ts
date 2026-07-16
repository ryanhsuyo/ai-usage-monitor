// Tiny HTTP boundary for outbound notifications. The real implementation uses the Tauri HTTP
// plugin (Rust-side, no browser CORS restrictions); tests inject a fake.

export type HttpResponse = { status: number; ok: boolean; bodyText?: string };

export interface HttpPoster {
  postJson(url: string, body: unknown, headers?: Record<string, string>): Promise<HttpResponse>;
}

/** Production implementation backed by @tauri-apps/plugin-http. Imported lazily so that unit
 *  tests (jsdom) never load Tauri internals. */
export function createTauriHttpPoster(): HttpPoster {
  return {
    async postJson(url, body, headers) {
      const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
      const res = await tauriFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(headers ?? {}) },
        body: JSON.stringify(body),
      });
      let bodyText: string | undefined;
      try {
        bodyText = await res.text();
      } catch {
        bodyText = undefined;
      }
      return { status: res.status, ok: res.ok, bodyText };
    },
  };
}
