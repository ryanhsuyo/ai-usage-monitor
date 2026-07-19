// One-way secret migration wrapper: reads fall back to a legacy store once, then the value is
// re-saved into the primary store and removed from the legacy one.
//
// Used when an ad-hoc-signed macOS build switches from the OS keychain to the encrypted-file
// store: existing keychain secrets (e.g. Discord webhooks) migrate the first time they are
// needed — the OS shows its permission dialog one last time — and every later read is silent.

import type { SecretStore } from "@/ports";

export function createMigratingSecretStore(primary: SecretStore, legacy: SecretStore): SecretStore {
  return {
    async setSecret(key, value) {
      await primary.setSecret(key, value);
      await legacy.deleteSecret(key).catch(() => undefined);
    },
    async getSecret(key) {
      const value = await primary.getSecret(key);
      if (value !== null) return value;
      let legacyValue: string | null;
      try {
        legacyValue = await legacy.getSecret(key);
      } catch {
        // Denied or unavailable legacy backend: report "missing" so the caller surfaces a
        // normal missing-secret error; the user can re-save the secret into the primary store.
        return null;
      }
      if (legacyValue === null) return null;
      await primary.setSecret(key, legacyValue);
      await legacy.deleteSecret(key).catch(() => undefined);
      return legacyValue;
    },
    async deleteSecret(key) {
      await primary.deleteSecret(key);
      await legacy.deleteSecret(key).catch(() => undefined);
    },
  };
}
