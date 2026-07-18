//! OS keychain-backed secret storage commands.
//!
//! Uses the `keyring` crate which maps to the macOS Keychain and the Windows Credential Manager.
//! Secret *values* live only here — never in SQLite or JSON export. The frontend `SecretStore`
//! port calls these commands and falls back to an encrypted file if the keychain is unavailable.
//!
//! All errors are returned as opaque strings; callers must NOT log the secret value.

use keyring::Entry;

// Kept stable across the v0.2 bundle-id migration so existing Discord/Webhook
// credentials remain available without copying or exposing their values.
const SERVICE: &str = "com.aiusagemonitor.app";

fn entry(key: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, key).map_err(|e| format!("keyring-init-failed: {e}"))
}

#[tauri::command]
pub fn secret_set(key: String, value: String) -> Result<(), String> {
    let e = entry(&key)?;
    e.set_password(&value)
        .map_err(|err| format!("keyring-set-failed: {err}"))
}

#[tauri::command]
pub fn secret_get(key: String) -> Result<Option<String>, String> {
    let e = entry(&key)?;
    match e.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(format!("keyring-get-failed: {err}")),
    }
}

#[tauri::command]
pub fn secret_delete(key: String) -> Result<(), String> {
    let e = entry(&key)?;
    match e.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(format!("keyring-delete-failed: {err}")),
    }
}

/// Probe whether the OS keychain is usable in this environment. The frontend uses the result to
/// decide between the keychain-backed store and the encrypted-file fallback.
#[tauri::command]
pub fn secret_backend_available() -> bool {
    // A round-trip write/read/delete on a throwaway key is the most reliable probe.
    let probe_key = "__backend_probe__";
    let Ok(e) = entry(probe_key) else {
        return false;
    };
    if e.set_password("probe").is_err() {
        return false;
    }
    let ok = matches!(e.get_password(), Ok(_));
    let _ = e.delete_credential();
    ok
}
