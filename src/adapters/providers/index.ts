// Provider adapters (spec §13). Manual + Demo are real; the rest are explicit `unsupported`
// stubs that NEVER fabricate snapshots or claim success.

import type { ProviderFetchResult, UsageProviderAdapter } from "@/ports";

function nowIso(): string {
  return new Date().toISOString();
}

export function unsupported(message: string): ProviderFetchResult {
  return { ok: false, errorCode: "unsupported", message, fetchedAt: nowIso() };
}

/**
 * Manual entry is not a fetchable source: polling it returns `manual_source` so the scheduler
 * knows there is nothing to pull (it must never invent a snapshot from thin air, spec §8 flow 7).
 */
export const ManualProviderAdapter: UsageProviderAdapter = {
  id: "manual",
  providerId: "custom",
  displayName: "手動輸入",
  supportsAutomaticPolling: false,
  async fetchUsage() {
    return {
      ok: false,
      errorCode: "manual_source",
      message: "手動資料來源不支援自動抓取，請在 App 內輸入用量。",
      fetchedAt: nowIso(),
    };
  },
};

/** Coming-later stubs. Each states its status honestly and returns `unsupported`. */
export const ClaudeBrowserAdapter: UsageProviderAdapter = {
  id: "claude-browser",
  providerId: "claude",
  displayName: "Claude Usage 頁面（Browser Automation）",
  supportsAutomaticPolling: false,
  async fetchUsage() {
    return unsupported("Claude Browser Adapter 尚未實作（Roadmap Phase 3）。");
  },
};

export const ClaudeCodeLocalAdapter: UsageProviderAdapter = {
  id: "claude-code-local",
  providerId: "claude",
  displayName: "Claude Code 本機資料",
  supportsAutomaticPolling: false,
  async fetchUsage() {
    return unsupported("Claude Code Local Adapter 尚未實作（Roadmap Phase 2）。");
  },
};

export const CodexLocalAdapter: UsageProviderAdapter = {
  id: "codex-local",
  providerId: "codex",
  displayName: "Codex 本機資料",
  supportsAutomaticPolling: false,
  async fetchUsage() {
    return unsupported("Codex Local Adapter 尚未實作（Roadmap Phase 2）。");
  },
};

export const ChatGPTBrowserAdapter: UsageProviderAdapter = {
  id: "chatgpt-browser",
  providerId: "chatgpt",
  displayName: "ChatGPT Usage 頁面（Browser Automation）",
  supportsAutomaticPolling: false,
  async fetchUsage() {
    return unsupported("ChatGPT Browser Adapter 尚未實作（Roadmap Phase 3）。");
  },
};

export const ALL_PROVIDER_ADAPTERS: UsageProviderAdapter[] = [
  ManualProviderAdapter,
  ClaudeBrowserAdapter,
  ClaudeCodeLocalAdapter,
  CodexLocalAdapter,
  ChatGPTBrowserAdapter,
];
