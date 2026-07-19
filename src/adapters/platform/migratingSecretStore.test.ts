import { describe, expect, it } from "vitest";
import { createMigratingSecretStore } from "./migratingSecretStore";
import { InMemorySecretStore } from "./index";
import type { SecretStore } from "@/ports";

function failingStore(error: Error): SecretStore {
  return {
    setSecret: async () => { throw error; },
    getSecret: async () => { throw error; },
    deleteSecret: async () => { throw error; },
  };
}

describe("createMigratingSecretStore", () => {
  it("reads from the primary store without touching legacy when present", async () => {
    const primary = new InMemorySecretStore();
    const legacy = failingStore(new Error("keyring-get-failed"));
    await primary.setSecret("a", "primary-value");
    const store = createMigratingSecretStore(primary, legacy);
    expect(await store.getSecret("a")).toBe("primary-value");
  });

  it("migrates a legacy secret into primary on first read and removes it from legacy", async () => {
    const primary = new InMemorySecretStore();
    const legacy = new InMemorySecretStore();
    await legacy.setSecret("webhook", "https://example.invalid/hook");
    const store = createMigratingSecretStore(primary, legacy);

    expect(await store.getSecret("webhook")).toBe("https://example.invalid/hook");
    expect(await primary.getSecret("webhook")).toBe("https://example.invalid/hook");
    expect(await legacy.getSecret("webhook")).toBeNull();
    // Second read is served by primary alone.
    expect(await store.getSecret("webhook")).toBe("https://example.invalid/hook");
  });

  it("returns null when the legacy read is denied instead of surfacing the error", async () => {
    const primary = new InMemorySecretStore();
    const legacy = failingStore(new Error("keyring-get-failed: user denied"));
    const store = createMigratingSecretStore(primary, legacy);
    expect(await store.getSecret("webhook")).toBeNull();
  });

  it("writes to primary and best-effort deletes the legacy copy", async () => {
    const primary = new InMemorySecretStore();
    const legacy = new InMemorySecretStore();
    await legacy.setSecret("webhook", "old-value");
    const store = createMigratingSecretStore(primary, legacy);

    await store.setSecret("webhook", "new-value");
    expect(await primary.getSecret("webhook")).toBe("new-value");
    expect(await legacy.getSecret("webhook")).toBeNull();
  });

  it("set still succeeds when the legacy delete fails", async () => {
    const primary = new InMemorySecretStore();
    const legacy = failingStore(new Error("keyring-delete-failed"));
    const store = createMigratingSecretStore(primary, legacy);
    await store.setSecret("webhook", "value");
    expect(await primary.getSecret("webhook")).toBe("value");
  });

  it("deletes from both stores and tolerates legacy failure", async () => {
    const primary = new InMemorySecretStore();
    const legacy = failingStore(new Error("keyring-delete-failed"));
    const store = createMigratingSecretStore(primary, legacy);
    await primary.setSecret("webhook", "value");
    await store.deleteSecret("webhook");
    expect(await primary.getSecret("webhook")).toBeNull();
  });
});
