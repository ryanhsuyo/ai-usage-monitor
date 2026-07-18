use std::{
    fs::{self, OpenOptions},
    io::Write,
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::{json, Value};
use tauri::Manager;

const LOG_FILE: &str = "diagnostics.jsonl";
const MAX_LOG_BYTES: u64 = 512 * 1024;
const RETAIN_LOG_BYTES: usize = 256 * 1024;

fn timestamp_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn log_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let directory = app.path().app_data_dir().map_err(|error| error.to_string())?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory.join(LOG_FILE))
}

fn rotate_if_needed(path: &std::path::Path) -> Result<(), String> {
    if path.metadata().map(|metadata| metadata.len()).unwrap_or(0) <= MAX_LOG_BYTES {
        return Ok(());
    }
    let contents = fs::read(path).map_err(|error| error.to_string())?;
    let start = contents.len().saturating_sub(RETAIN_LOG_BYTES);
    let retained_start = contents[start..]
        .iter()
        .position(|byte| *byte == b'\n')
        .map(|offset| start + offset + 1)
        .unwrap_or(start);
    fs::write(path, &contents[retained_start..]).map_err(|error| error.to_string())
}

pub fn append(
    app: &tauri::AppHandle,
    level: &str,
    event: &str,
    detail: Option<&str>,
) -> Result<(), String> {
    let path = log_path(app)?;
    rotate_if_needed(&path)?;
    let entry = json!({
        "timestampUnixMs": timestamp_ms(),
        "level": level,
        "event": event,
        "detail": detail.map(|value| value.chars().take(500).collect::<String>()),
    });
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| error.to_string())?;
    writeln!(file, "{entry}").map_err(|error| error.to_string())
}

#[tauri::command]
pub fn diagnostic_log(
    app: tauri::AppHandle,
    level: String,
    event: String,
    detail: Option<String>,
) -> Result<(), String> {
    let safe_level = match level.as_str() {
        "warn" | "error" => level.as_str(),
        _ => "info",
    };
    append(&app, safe_level, &event, detail.as_deref())
}

#[tauri::command]
pub fn diagnostic_export(app: tauri::AppHandle) -> Result<String, String> {
    let path = log_path(&app)?;
    let contents = fs::read_to_string(path).unwrap_or_default();
    let events: Vec<Value> = contents
        .lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect();
    serde_json::to_string_pretty(&json!({
        "format": "ai-usage-monitor-diagnostics-v1",
        "appVersion": env!("CARGO_PKG_VERSION"),
        "platform": std::env::consts::OS,
        "exportedAtUnixMs": timestamp_ms(),
        "privacy": "No usage database, prompts, responses, tokens, webhook URLs, API keys, or secrets are included.",
        "events": events,
    }))
    .map_err(|error| error.to_string())
}
