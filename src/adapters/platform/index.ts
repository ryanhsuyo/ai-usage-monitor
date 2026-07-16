// Platform capability adapters (spec §5). All OS-specific behavior is confined here behind the
// ports. React components never touch Tauri APIs directly for these capabilities.
//
// Every Tauri import is dynamic so unit tests (jsdom, no Tauri runtime) can import this module
// safely and use the InMemory fakes instead.

import type {
  AutoStartService,
  BackgroundRuntime,
  SecretStore,
  SystemNotifier,
} from "@/ports";

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

// ---------- System notifier ----------

export function createTauriNotifier(): SystemNotifier {
  return {
    async send({ title, body }) {
      const notification = await import("@tauri-apps/plugin-notification");
      let granted = await notification.isPermissionGranted();
      if (!granted) {
        granted = (await notification.requestPermission()) === "granted";
      }
      if (!granted) throw new Error("notification permission not granted");
      notification.sendNotification({ title, body });
    },
  };
}

export class InMemoryNotifier implements SystemNotifier {
  public sent: Array<{ title: string; body: string }> = [];
  async send(input: { title: string; body: string }): Promise<void> {
    this.sent.push(input);
  }
}

// ---------- Auto start ----------

export function createTauriAutoStart(): AutoStartService {
  return {
    async isEnabled() {
      const autostart = await import("@tauri-apps/plugin-autostart");
      return autostart.isEnabled();
    },
    async enable() {
      const autostart = await import("@tauri-apps/plugin-autostart");
      await autostart.enable();
    },
    async disable() {
      const autostart = await import("@tauri-apps/plugin-autostart");
      await autostart.disable();
    },
  };
}

export class InMemoryAutoStart implements AutoStartService {
  private enabled = false;
  async isEnabled(): Promise<boolean> {
    return this.enabled;
  }
  async enable(): Promise<void> {
    this.enabled = true;
  }
  async disable(): Promise<void> {
    this.enabled = false;
  }
}

// ---------- Background runtime (hide-on-close) ----------

export function createTauriBackgroundRuntime(): BackgroundRuntime {
  let running = true; // default ON per spec §6
  return {
    async isRunning() {
      return running;
    },
    async start() {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("set_hide_on_close", { value: true });
      running = true;
    },
    async stop() {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("set_hide_on_close", { value: false });
      running = false;
    },
  };
}

export class InMemoryBackgroundRuntime implements BackgroundRuntime {
  private running = true;
  async isRunning(): Promise<boolean> {
    return this.running;
  }
  async start(): Promise<void> {
    this.running = true;
  }
  async stop(): Promise<void> {
    this.running = false;
  }
}

// ---------- Secret store ----------

/**
 * Keychain-backed store via Rust `keyring` commands (macOS Keychain / Windows Credential Manager).
 * SQLite only ever sees `secretRef` strings; the values live here.
 */
export function createTauriSecretStore(): SecretStore {
  return {
    async setSecret(key, value) {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("secret_set", { key, value });
    },
    async getSecret(key) {
      const { invoke } = await import("@tauri-apps/api/core");
      return await invoke<string | null>("secret_get", { key });
    },
    async deleteSecret(key) {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("secret_delete", { key });
    },
  };
}

export class InMemorySecretStore implements SecretStore {
  private map = new Map<string, string>();
  async setSecret(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }
  async getSecret(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }
  async deleteSecret(key: string): Promise<void> {
    this.map.delete(key);
  }
}

/**
 * Pick the best available secret store: OS keychain when the probe succeeds, otherwise an
 * app-data encrypted-file fallback (see fileSecretStore.ts). Never silently downgrades without
 * reporting which backend is active.
 */
export async function createBestSecretStore(): Promise<{ store: SecretStore; backend: "keychain" | "file" }> {
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    const available = await invoke<boolean>("secret_backend_available");
    if (available) {
      return { store: createTauriSecretStore(), backend: "keychain" };
    }
  } catch {
    // fall through to file fallback
  }
  const { createFileSecretStore } = await import("./fileSecretStore");
  return { store: await createFileSecretStore(), backend: "file" };
}
