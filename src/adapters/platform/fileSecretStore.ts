// Encrypted-file fallback secret store.
//
// Used ONLY when the OS keychain is unavailable (probe fails). Secrets are AES-GCM encrypted with
// a random key kept in a separate file inside the app data directory.
//
// HONESTY NOTE (also in docs/security.md): because the key lives on the same disk, this fallback
// protects against casual inspection and accidental export/grep — it is NOT as strong as the OS
// keychain. The active backend is surfaced in Settings so the user knows which one is in use.

import type { SecretStore } from "@/ports";

const KEY_FILE = "secret-store.key";
const DATA_FILE = "secret-store.enc.json";

type EncEntry = { iv: string; data: string };
type EncFile = Record<string, EncEntry>;

function b64encode(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function createFileSecretStore(): Promise<SecretStore> {
  const fs = await import("@tauri-apps/plugin-fs");
  const { BaseDirectory } = fs;
  const opts = { baseDir: BaseDirectory.AppData };

  async function loadKey(): Promise<CryptoKey> {
    let raw: Uint8Array;
    if (await fs.exists(KEY_FILE, opts)) {
      raw = b64decode(await fs.readTextFile(KEY_FILE, opts));
    } else {
      raw = crypto.getRandomValues(new Uint8Array(32));
      await fs.writeTextFile(KEY_FILE, b64encode(raw), opts);
    }
    return crypto.subtle.importKey("raw", raw.buffer as ArrayBuffer, "AES-GCM", false, [
      "encrypt",
      "decrypt",
    ]);
  }

  async function loadFile(): Promise<EncFile> {
    if (!(await fs.exists(DATA_FILE, opts))) return {};
    try {
      return JSON.parse(await fs.readTextFile(DATA_FILE, opts)) as EncFile;
    } catch {
      return {};
    }
  }

  async function saveFile(data: EncFile): Promise<void> {
    await fs.writeTextFile(DATA_FILE, JSON.stringify(data), opts);
  }

  return {
    async setSecret(key, value) {
      const cryptoKey = await loadKey();
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const enc = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        cryptoKey,
        new TextEncoder().encode(value)
      );
      const file = await loadFile();
      file[key] = { iv: b64encode(iv), data: b64encode(enc) };
      await saveFile(file);
    },
    async getSecret(key) {
      const file = await loadFile();
      const entry = file[key];
      if (!entry) return null;
      try {
        const cryptoKey = await loadKey();
        const dec = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: b64decode(entry.iv).buffer as ArrayBuffer },
          cryptoKey,
          b64decode(entry.data).buffer as ArrayBuffer
        );
        return new TextDecoder().decode(dec);
      } catch {
        return null;
      }
    },
    async deleteSecret(key) {
      const file = await loadFile();
      delete file[key];
      await saveFile(file);
    },
  };
}
