use serde::Serialize;
use serde_json::Value;
use std::{collections::{HashMap, HashSet}, fs, io::{BufRead, BufReader, Write}, path::{Path, PathBuf}, process::{Command, Stdio}, sync::{Mutex, OnceLock}, time::{Duration, Instant, SystemTime}};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsage {
    model: String,
    input_tokens: u64,
    cached_input_tokens: u64,
    cache_creation_tokens: u64,
    cache_read_tokens: u64,
    output_tokens: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetCredit {
    title: String,
    expires_at_unix: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalUsageReading {
    provider_id: String,
    limit_key: String,
    limit_name: String,
    used_percent: f64,
    window_minutes: u64,
    reset_at_unix: i64,
    captured_at: String,
    session_count: usize,
    model_usage: Vec<ModelUsage>,
    input_tokens: u64,
    cached_input_tokens: u64,
    output_tokens: u64,
    reset_available_count: u64,
    reset_credits: Vec<ResetCredit>,
    reset_credits_available: bool,
    quota_stale: bool,
    quota_captured_at: String,
    /// Claude Code's login has expired; the reading is the last cache and the user must re-run
    /// `/login`. Distinguishes "can't reach the provider" from "provider says you're signed out".
    auth_needs_login: bool,
}

fn codex_binary() -> String {
    let bundled = "/Applications/ChatGPT.app/Contents/Resources/codex";
    if Path::new(bundled).exists() { bundled.to_string() } else { "codex".to_string() }
}

fn read_codex_response(reader: &mut BufReader<impl std::io::Read>, request_id: i64) -> Result<Value, String> {
    let mut line = String::new();
    loop {
        line.clear();
        if reader.read_line(&mut line).map_err(|error| error.to_string())? == 0 {
            return Err(format!("Codex app-server 在回應 request {request_id} 前結束"));
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else { continue };
        if value.get("id").and_then(Value::as_i64) != Some(request_id) { continue; }
        if let Some(error) = value.get("error") { return Err(format!("Codex app-server: {error}")); }
        return value.get("result").cloned().ok_or_else(|| "Codex app-server 回應缺少 result".to_string());
    }
}

fn read_codex_app_server() -> Result<Value, String> {
    let mut child = Command::new(codex_binary())
        .args(["app-server", "--stdio"])
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null())
        .spawn().map_err(|error| format!("無法啟動 Codex app-server: {error}"))?;
    let mut stdin = child.stdin.take().ok_or_else(|| "無法開啟 Codex app-server stdin".to_string())?;
    let stdout = child.stdout.take().ok_or_else(|| "無法開啟 Codex app-server stdout".to_string())?;

    // The whole initialize → rateLimits exchange runs on a reader thread behind a timeout, mirroring
    // the Claude fetch. read_codex_response's read_line is blocking: an app-server that spawns but
    // never answers (ChatGPT app signed out, waiting on the network) would otherwise hang here
    // indefinitely — the observed multi-minute launches, since kill() below is never reached. On
    // timeout the child is killed, which closes the pipe and lets the thread unwind.
    let (sender, receiver) = std::sync::mpsc::channel::<Result<Value, String>>();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let exchange = (|| {
            writeln!(stdin, "{}", r#"{"id":1,"method":"initialize","params":{"clientInfo":{"name":"ai-usage-monitor","version":"0.1.0"},"capabilities":{"experimentalApi":true}}}"#).map_err(|error| error.to_string())?;
            stdin.flush().map_err(|error| error.to_string())?;
            read_codex_response(&mut reader, 1)?;
            writeln!(stdin, "{}", r#"{"id":2,"method":"account/rateLimits/read","params":null}"#).map_err(|error| error.to_string())?;
            stdin.flush().map_err(|error| error.to_string())?;
            read_codex_response(&mut reader, 2)
        })();
        let _ = sender.send(exchange);
    });
    let result = match receiver.recv_timeout(Duration::from_secs(20)) {
        Ok(outcome) => outcome,
        Err(_) => Err("Codex app-server 逾時未回應".to_string()),
    };
    let _ = child.kill();
    let _ = child.wait();
    result
}

fn jsonl_files(dir: &Path, files: &mut Vec<(SystemTime, PathBuf)>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() { jsonl_files(&path, files); }
        else if path.extension().and_then(|x| x.to_str()) == Some("jsonl") {
            let modified = entry.metadata().and_then(|m| m.modified()).unwrap_or(SystemTime::UNIX_EPOCH);
            files.push((modified, path));
        }
    }
}

fn timestamp_unix(value: &str) -> Option<i64> {
    OffsetDateTime::parse(value, &Rfc3339).ok().map(|t| t.unix_timestamp())
}

#[derive(Default)]
struct ClaudeUsageFetchState {
    last_attempt: Option<Instant>,
    fresh: Option<(i64, Vec<Value>)>,
    /// The last live fetch returned a valid response saying no subscription/limits are available
    /// — Claude Code's OAuth token has expired and needs `/login`. Sticky until a fetch succeeds.
    needs_login: bool,
}

/// Outcome of one live `get_usage` call.
enum ClaudeUsageFetch {
    /// Official limits were returned.
    Limits(Vec<Value>),
    /// The CLI answered but reported no available rate limits — the sign of an expired login,
    /// distinct from a transient failure because the request itself succeeded.
    NeedsLogin,
    /// Binary missing, timed out, or no parseable response. Say nothing about auth.
    Unavailable,
}

static CLAUDE_USAGE_FETCH: OnceLock<Mutex<ClaudeUsageFetchState>> = OnceLock::new();

/// Locate the Claude Code binary. A GUI app's PATH only carries system directories, so probe the
/// common install locations (native installer, Homebrew, npm global) before falling back to PATH.
fn claude_binary(home: &str) -> PathBuf {
    let candidates = [
        Path::new(home).join(".local/bin/claude"),
        PathBuf::from("/opt/homebrew/bin/claude"),
        PathBuf::from("/usr/local/bin/claude"),
        Path::new(home).join(".npm-global/bin/claude"),
    ];
    for candidate in candidates {
        if candidate.exists() { return candidate; }
    }
    PathBuf::from("claude")
}

/// Ask Claude Code for live official usage through the stream-json control protocol
/// (`get_usage`), which calls the provider's usage endpoint directly. This consumes no quota
/// and needs no terminal emulation; only the returned limits are read, never credentials.
fn fetch_claude_usage_via_cli(home: &str, cwd: &Path) -> ClaudeUsageFetch {
    let binary = claude_binary(home);
    let Ok(mut child) = Command::new(binary)
        .args(["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"])
        .current_dir(cwd)
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null())
        .spawn()
    else {
        return ClaudeUsageFetch::Unavailable;
    };
    let (Some(mut stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
        let _ = child.kill();
        let _ = child.wait();
        return ClaudeUsageFetch::Unavailable;
    };
    let request = r#"{"type":"control_request","request_id":"usage","request":{"subtype":"get_usage"}}"#;
    if writeln!(stdin, "{request}").and_then(|_| stdin.flush()).is_err() {
        let _ = child.kill();
        let _ = child.wait();
        return ClaudeUsageFetch::Unavailable;
    }
    let (sender, receiver) = std::sync::mpsc::channel::<Value>();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let Ok(value) = serde_json::from_str::<Value>(&line) else { continue };
                    if value.get("type").and_then(Value::as_str) == Some("control_response") {
                        let _ = sender.send(value);
                        break;
                    }
                }
            }
        }
    });
    let response = receiver.recv_timeout(Duration::from_secs(20)).ok();
    drop(stdin);
    let _ = child.kill();
    let _ = child.wait();
    let Some(response) = response else { return ClaudeUsageFetch::Unavailable };
    if response.pointer("/response/subtype").and_then(Value::as_str) != Some("success") {
        return ClaudeUsageFetch::Unavailable;
    }
    classify_usage_response(&response)
}

/// Read a successful `control_response` into a fetch outcome. `rate_limits_available: false` is
/// the CLI's own word for "not signed in / no subscription", which we must surface as a login
/// prompt rather than another silent "waiting for official update".
fn classify_usage_response(response: &Value) -> ClaudeUsageFetch {
    if let Some(limits) = response.pointer("/response/response/rate_limits/limits").and_then(Value::as_array) {
        if !limits.is_empty() {
            return ClaudeUsageFetch::Limits(limits.clone());
        }
    }
    match response.pointer("/response/response/rate_limits_available").and_then(Value::as_bool) {
        Some(false) => ClaudeUsageFetch::NeedsLogin,
        _ => ClaudeUsageFetch::Unavailable,
    }
}

/// Whether the last live fetch reported an expired login. Read after `read_claude_local_usage`
/// has run its refresh.
fn claude_needs_login() -> bool {
    CLAUDE_USAGE_FETCH
        .get_or_init(|| Mutex::new(ClaudeUsageFetchState::default()))
        .lock()
        .map(|state| state.needs_login)
        .unwrap_or(false)
}

fn all_full_waiting_for_reset(limits: &[Value], now: i64) -> bool {
    !limits.is_empty() && limits.iter().all(|limit| {
        limit.get("percent").and_then(Value::as_f64).is_some_and(|percent| percent >= 99.5)
            && limit.get("resets_at").and_then(Value::as_str).and_then(timestamp_unix)
                .is_some_and(|reset| reset > now)
    })
}

fn refreshed_claude_limits(
    home: &str,
    root: &Value,
    cached_fetched_ms: i64,
    cached_limits: Option<&Vec<Value>>,
    latest_activity_at: Option<&str>,
) -> Option<(i64, Vec<Value>)> {
    let state_lock = CLAUDE_USAGE_FETCH.get_or_init(|| Mutex::new(ClaudeUsageFetchState::default()));
    let Ok(mut state) = state_lock.lock() else { return None };

    // Prefer an in-process live fetch over the on-disk cache: Claude Code throttles its own
    // cache-file writes, so a successful fetch can be newer than anything in ~/.claude.json.
    let fresh_snapshot = state.fresh.clone();
    let (fetched_ms, limits) = match &fresh_snapshot {
        Some((fresh_ms, fresh_limits)) if *fresh_ms > cached_fetched_ms => (*fresh_ms, Some(fresh_limits)),
        _ => (cached_fetched_ms, cached_limits),
    };
    let now = OffsetDateTime::now_utc().unix_timestamp();
    let now_ms = now * 1_000;
    let reset_due = limits.is_some_and(|limits| limits.iter().any(|limit| {
        limit.get("resets_at").and_then(Value::as_str).and_then(timestamp_unix)
            .is_some_and(|reset| reset <= now)
    }));
    // Refresh pauses only when EVERY limit is full and waiting on a future reset — nothing can
    // change until then. A single full limit must not pause refresh: the other limits keep moving.
    let full_waiting_for_reset = limits.is_some_and(|limits| all_full_waiting_for_reset(limits, now));
    let activity_newer_than_cache = latest_activity_at.and_then(timestamp_unix)
        .is_some_and(|activity| activity * 1_000 > fetched_ms + 60_000);
    let heartbeat_due = fetched_ms <= 0 || now_ms.saturating_sub(fetched_ms) >= 30 * 60 * 1_000;
    let throttled = state.last_attempt.is_some_and(|at| at.elapsed() < Duration::from_secs(4 * 60));

    // A full quota cannot change before its advertised reset, so avoid pointless refreshes until
    // that boundary. Otherwise keep normal usage reasonably fresh after activity and via a
    // low-frequency heartbeat. A due reset always takes precedence and is confirmed immediately.
    let refresh_due = if reset_due { true } else if full_waiting_for_reset { false } else { activity_newer_than_cache || heartbeat_due };
    if refresh_due && !throttled {
        let cwd = root.get("projects").and_then(Value::as_object).and_then(|projects| {
            projects.iter().find_map(|(path, settings)| {
                (settings.get("hasTrustDialogAccepted").and_then(Value::as_bool) == Some(true)
                    && Path::new(path).is_dir()).then(|| PathBuf::from(path))
            })
        }).unwrap_or_else(|| PathBuf::from(home));
        state.last_attempt = Some(Instant::now());
        match fetch_claude_usage_via_cli(home, &cwd) {
            ClaudeUsageFetch::Limits(fresh_limits) => {
                state.needs_login = false;
                let fresh_ms = OffsetDateTime::now_utc().unix_timestamp() * 1_000;
                state.fresh = Some((fresh_ms, fresh_limits.clone()));
                return Some((fresh_ms, fresh_limits));
            }
            ClaudeUsageFetch::NeedsLogin => state.needs_login = true,
            ClaudeUsageFetch::Unavailable => {}
        }
    }
    match &state.fresh {
        Some((fresh_ms, fresh_limits)) if *fresh_ms > cached_fetched_ms => Some((*fresh_ms, fresh_limits.clone())),
        _ => None,
    }
}

fn session_usage(path: &Path, cycle_start: i64) -> Option<(String, String, ModelUsage)> {
    let body = fs::read_to_string(path).ok()?;
    let mut model = "unknown".to_string();
    let mut latest: Option<(String, ModelUsage)> = None;
    for line in body.lines() {
        let Ok(root) = serde_json::from_str::<Value>(line) else { continue };
        if let Some(value) = root.pointer("/payload/model").and_then(Value::as_str) { model = value.to_string(); }
        if root.pointer("/payload/type").and_then(Value::as_str) != Some("token_count") { continue; }
        let timestamp = root.get("timestamp").and_then(Value::as_str).unwrap_or("");
        if timestamp_unix(timestamp).unwrap_or(0) < cycle_start { continue; }
        let usage = root.pointer("/payload/info/total_token_usage")?;
        latest = Some((timestamp.to_string(), ModelUsage {
            model: model.clone(),
            input_tokens: usage.get("input_tokens").and_then(Value::as_u64).unwrap_or(0),
            cached_input_tokens: usage.get("cached_input_tokens").and_then(Value::as_u64).unwrap_or(0),
            cache_creation_tokens: 0,
            cache_read_tokens: usage.get("cached_input_tokens").and_then(Value::as_u64).unwrap_or(0),
            output_tokens: usage.get("output_tokens").and_then(Value::as_u64).unwrap_or(0),
        }));
    }
    latest.map(|(timestamp, usage)| (timestamp, model, usage))
}

#[tauri::command]
pub fn read_codex_local_usage() -> Result<Vec<LocalUsageReading>, String> {
    let home = std::env::var("HOME").map_err(|_| "找不到使用者目錄".to_string())?;
    let mut files = Vec::new();
    jsonl_files(&Path::new(&home).join(".codex/sessions"), &mut files);
    files.sort_by(|a, b| b.0.cmp(&a.0));

    let app_server_result = read_codex_app_server();
    let reset_credits_available = app_server_result.is_ok();
    let app_server = app_server_result.ok();
    let reset_available_count = app_server.as_ref().and_then(|value| value.pointer("/rateLimitResetCredits/availableCount")).and_then(Value::as_u64).unwrap_or(0);
    let reset_credits = app_server.as_ref().and_then(|value| value.pointer("/rateLimitResetCredits/credits")).and_then(Value::as_array)
        .map(|credits| credits.iter().filter(|credit| credit.get("status").and_then(Value::as_str) == Some("available")).map(|credit| ResetCredit {
            title: credit.get("title").and_then(Value::as_str).unwrap_or("Full reset").to_string(),
            expires_at_unix: credit.get("expiresAt").and_then(Value::as_i64),
        }).collect::<Vec<_>>()).unwrap_or_default();

    // Prefer the authenticated app-server snapshot. Session JSONL remains the offline fallback.
    let mut anchors: Vec<(String, String, f64, u64, i64, String)> = Vec::new();
    if let Some(snapshot) = app_server.as_ref().and_then(|value| value.pointer("/rateLimitsByLimitId/codex").or_else(|| value.get("rateLimits"))) {
        for (key, label) in [("primary", "Codex 主要額度"), ("secondary", "Codex 次要額度")] {
            let Some(limit) = snapshot.get(key).filter(|value| !value.is_null()) else { continue };
            let (Some(used), Some(window), Some(reset)) = (limit.get("usedPercent").and_then(Value::as_f64), limit.get("windowDurationMins").and_then(Value::as_u64), limit.get("resetsAt").and_then(Value::as_i64)) else { continue };
            let name = if window == 10080 { "Codex 每週額度" } else if window == 300 { "Codex 5 小時額度" } else { label };
            anchors.push((key.into(), name.into(), used, window, reset, OffsetDateTime::now_utc().format(&Rfc3339).unwrap_or_default()));
        }
    }
    for (_, path) in &files {
        if !anchors.is_empty() { break; }
        let Ok(body) = fs::read_to_string(path) else { continue };
        for line in body.lines().rev() {
            let Ok(root) = serde_json::from_str::<Value>(line) else { continue };
            if root.pointer("/payload/type").and_then(Value::as_str) != Some("token_count") { continue; }
            let Some(limits) = root.pointer("/payload/rate_limits") else { continue };
            let captured = root.get("timestamp").and_then(Value::as_str).unwrap_or("").to_string();
            for (key, label) in [("primary", "Codex 主要額度"), ("secondary", "Codex 次要額度")] {
                let Some(limit) = limits.get(key).filter(|v| !v.is_null()) else { continue };
                let (Some(used), Some(window), Some(reset)) = (limit.get("used_percent").and_then(Value::as_f64), limit.get("window_minutes").and_then(Value::as_u64), limit.get("resets_at").and_then(Value::as_i64)) else { continue };
                let name = if window == 10080 { "Codex 每週額度" } else if window == 300 { "Codex 5 小時額度" } else { label };
                anchors.push((key.into(), name.into(), used, window, reset, captured.clone()));
            }
            if !anchors.is_empty() { break; }
        }
        if !anchors.is_empty() { break; }
    }
    if anchors.is_empty() { return Err("Codex session 尚未包含用量額度；請先在 Codex 完成一次對話".into()); }

    anchors.into_iter().map(|(key, name, used, window, reset, captured)| {
        let cycle_start = reset - (window as i64 * 60);
        let mut by_model: HashMap<String, ModelUsage> = HashMap::new();
        let mut session_count = 0;
        for (_, path) in &files {
            let Some((_timestamp, model, usage)) = session_usage(path, cycle_start) else { continue };
            session_count += 1;
            let entry = by_model.entry(model.clone()).or_insert_with(|| ModelUsage { model, ..Default::default() });
            entry.input_tokens += usage.input_tokens;
            entry.cached_input_tokens += usage.cached_input_tokens;
            entry.cache_creation_tokens += usage.cache_creation_tokens;
            entry.cache_read_tokens += usage.cache_read_tokens;
            entry.output_tokens += usage.output_tokens;
        }
        let mut model_usage: Vec<_> = by_model.into_values().collect();
        model_usage.sort_by(|a, b| b.input_tokens.cmp(&a.input_tokens));
        Ok(LocalUsageReading {
            provider_id: "codex".into(), limit_key: format!("codex-{key}-{window}"), limit_name: name,
            used_percent: used, window_minutes: window, reset_at_unix: reset, captured_at: captured.clone(),
            session_count, input_tokens: model_usage.iter().map(|u| u.input_tokens).sum(),
            cached_input_tokens: model_usage.iter().map(|u| u.cached_input_tokens).sum(),
            output_tokens: model_usage.iter().map(|u| u.output_tokens).sum(), model_usage,
            reset_available_count, reset_credits: reset_credits.clone(), reset_credits_available,
            quota_stale: false, quota_captured_at: captured.clone(), auth_needs_login: false,
        })
    }).collect()
}

fn claude_recent_usage(home: &str, since_unix: i64) -> (Vec<ModelUsage>, usize, Option<String>) {
    let mut files = Vec::new();
    jsonl_files(&Path::new(home).join(".claude/projects"), &mut files);
    let mut seen_messages = HashSet::new();
    let mut sessions = HashSet::new();
    let mut by_model: HashMap<String, ModelUsage> = HashMap::new();
    let mut latest_timestamp: Option<String> = None;
    for (modified, path) in files {
        if modified.duration_since(SystemTime::UNIX_EPOCH).map(|duration| duration.as_secs() as i64).unwrap_or(0) < since_unix {
            continue;
        }
        let Ok(body) = fs::read_to_string(path) else { continue };
        for line in body.lines() {
            let Ok(root) = serde_json::from_str::<Value>(line) else { continue };
            let timestamp = root.get("timestamp").and_then(Value::as_str).unwrap_or("");
            if timestamp_unix(timestamp).unwrap_or(0) < since_unix { continue; }
            let Some(usage) = root.pointer("/message/usage") else { continue };
            let message_id = root.pointer("/message/id").and_then(Value::as_str)
                .or_else(|| root.get("requestId").and_then(Value::as_str))
                .unwrap_or("");
            if message_id.is_empty() || !seen_messages.insert(message_id.to_string()) { continue; }
            if latest_timestamp.as_deref().map(|latest| timestamp > latest).unwrap_or(true) {
                latest_timestamp = Some(timestamp.to_string());
            }
            let model = root.pointer("/message/model").and_then(Value::as_str).unwrap_or("unknown").to_string();
            if let Some(session) = root.get("sessionId").and_then(Value::as_str) { sessions.insert(session.to_string()); }
            let entry = by_model.entry(model.clone()).or_insert_with(|| ModelUsage { model, ..Default::default() });
            entry.input_tokens += usage.get("input_tokens").and_then(Value::as_u64).unwrap_or(0);
            entry.cache_creation_tokens += usage.get("cache_creation_input_tokens").and_then(Value::as_u64).unwrap_or(0);
            entry.cache_read_tokens += usage.get("cache_read_input_tokens").and_then(Value::as_u64).unwrap_or(0);
            entry.cached_input_tokens += usage.get("cache_read_input_tokens").and_then(Value::as_u64).unwrap_or(0);
            entry.output_tokens += usage.get("output_tokens").and_then(Value::as_u64).unwrap_or(0);
        }
    }
    let mut models: Vec<_> = by_model.into_values().collect();
    models.sort_by(|a, b| b.output_tokens.cmp(&a.output_tokens));
    (models, sessions.len(), latest_timestamp)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyModelUsage {
    provider_id: String,
    date: String,
    model: String,
    input_tokens: u64,
    cache_creation_tokens: u64,
    #[serde(rename = "cacheCreation5mTokens")]
    cache_creation_5m_tokens: u64,
    #[serde(rename = "cacheCreation1hTokens")]
    cache_creation_1h_tokens: u64,
    cache_read_tokens: u64,
    output_tokens: u64,
    message_count: u64,
}

/// Aggregate the full local Claude Code transcript history into per-day, per-model token totals
/// (ccusage-style). Dates are bucketed in the caller's timezone via `utc_offset_minutes`.
#[tauri::command]
pub fn read_claude_usage_daily(utc_offset_minutes: i32) -> Result<Vec<DailyModelUsage>, String> {
    let home = std::env::var("HOME").map_err(|_| "找不到使用者目錄".to_string())?;
    let mut files = Vec::new();
    jsonl_files(&Path::new(&home).join(".claude/projects"), &mut files);
    if files.is_empty() {
        return Err("找不到 Claude Code 本機對話紀錄（~/.claude/projects）".into());
    }
    let bodies: Vec<String> = files.iter().filter_map(|(_, path)| fs::read_to_string(path).ok()).collect();
    aggregate_daily_usage(bodies.iter().flat_map(|body| body.lines()), utc_offset_minutes)
}

/// Aggregate Codex desktop/CLI session history, including archived sessions. Each token-count
/// event contains a delta in `last_token_usage`; using that delta avoids assigning a session's
/// cumulative total to the final model when the user switches models mid-session.
#[tauri::command]
pub fn read_codex_usage_daily(utc_offset_minutes: i32) -> Result<Vec<DailyModelUsage>, String> {
    let home = std::env::var("HOME").map_err(|_| "找不到使用者目錄".to_string())?;
    let mut files = Vec::new();
    jsonl_files(&Path::new(&home).join(".codex/sessions"), &mut files);
    jsonl_files(&Path::new(&home).join(".codex/archived_sessions"), &mut files);
    if files.is_empty() {
        return Err("找不到 Codex 本機對話紀錄（~/.codex/sessions）".into());
    }
    let bodies: Vec<String> = files.iter().filter_map(|(_, path)| fs::read_to_string(path).ok()).collect();
    aggregate_codex_daily_usage(bodies.iter().flat_map(|body| body.lines()), utc_offset_minutes)
}

fn aggregate_codex_daily_usage<'a>(
    lines: impl Iterator<Item = &'a str>,
    utc_offset_minutes: i32,
) -> Result<Vec<DailyModelUsage>, String> {
    let date_format = time::format_description::parse_borrowed::<2>("[year]-[month]-[day]")
        .map_err(|error| error.to_string())?;
    let mut current_model: Option<String> = None;
    let mut by_day_model: HashMap<(String, String), DailyModelUsage> = HashMap::new();
    for line in lines {
        let Ok(root) = serde_json::from_str::<Value>(line) else { continue };
        if root.get("type").and_then(Value::as_str) == Some("turn_context") {
            if let Some(model) = root.pointer("/payload/model").and_then(Value::as_str) {
                current_model = Some(model.to_string());
            }
            continue;
        }
        if root.pointer("/payload/type").and_then(Value::as_str) != Some("token_count") { continue; }
        let Some(usage) = root.pointer("/payload/info/last_token_usage") else { continue };
        let Some(model) = current_model.as_deref() else { continue };
        let Some(unix) = root.get("timestamp").and_then(Value::as_str).and_then(timestamp_unix) else { continue };
        let Ok(local) = OffsetDateTime::from_unix_timestamp(unix + i64::from(utc_offset_minutes) * 60) else { continue };
        let Ok(date) = local.date().format(&date_format) else { continue };
        let entry = by_day_model.entry((date.clone(), model.to_string())).or_insert_with(|| DailyModelUsage {
            provider_id: "codex".to_string(), date, model: model.to_string(),
            input_tokens: 0, cache_creation_tokens: 0, cache_creation_5m_tokens: 0, cache_creation_1h_tokens: 0,
            cache_read_tokens: 0, output_tokens: 0, message_count: 0,
        });
        let total_input = usage.get("input_tokens").and_then(Value::as_u64).unwrap_or(0);
        let cached_input = usage.get("cached_input_tokens").and_then(Value::as_u64).unwrap_or(0);
        // Codex includes cached input in input_tokens. Keep uncached Input and Cache Read in
        // separate columns, matching Claude transcripts and ccusage.
        entry.input_tokens += total_input.saturating_sub(cached_input);
        entry.cache_read_tokens += cached_input;
        entry.output_tokens += usage.get("output_tokens").and_then(Value::as_u64).unwrap_or(0);
        entry.message_count += 1;
    }
    let mut rows: Vec<DailyModelUsage> = by_day_model.into_values().collect();
    rows.sort_by(|a, b| a.date.cmp(&b.date).then_with(|| a.model.cmp(&b.model)));
    Ok(rows)
}

/// Fold transcript lines into per-day, per-model totals. Kept free of the filesystem so the
/// parsing contract with Claude Code's transcript format can be tested directly: a silent shape
/// change here shows up as wrong money on the cost page rather than as an error.
fn aggregate_daily_usage<'a>(
    lines: impl Iterator<Item = &'a str>,
    utc_offset_minutes: i32,
) -> Result<Vec<DailyModelUsage>, String> {
    let date_format = time::format_description::parse_borrowed::<2>("[year]-[month]-[day]")
        .map_err(|error| error.to_string())?;
    // Claude can copy the same message into resumed/parent/sidechain transcripts. Some copies
    // are zeroed or contain an earlier partial output. Keep one logical message and merge each
    // counter by maximum instead of letting filesystem traversal order decide which copy wins.
    let mut messages: HashMap<String, DailyModelUsage> = HashMap::new();
    let mut by_day_model: HashMap<(String, String), DailyModelUsage> = HashMap::new();
    for line in lines {
        let Ok(root) = serde_json::from_str::<Value>(line) else { continue };
        let Some(usage) = root.pointer("/message/usage") else { continue };
        let message_id = root.pointer("/message/id").and_then(Value::as_str)
            .or_else(|| root.get("requestId").and_then(Value::as_str))
            .unwrap_or("");
        if message_id.is_empty() { continue; }
        let model = root.pointer("/message/model").and_then(Value::as_str).unwrap_or("unknown");
        if model == "<synthetic>" { continue; }
        let Some(unix) = root.get("timestamp").and_then(Value::as_str).and_then(timestamp_unix) else { continue };
        let Ok(local) = OffsetDateTime::from_unix_timestamp(unix + i64::from(utc_offset_minutes) * 60) else { continue };
        let Ok(date) = local.date().format(&date_format) else { continue };
        let candidate = DailyModelUsage {
            provider_id: "claude".to_string(), date, model: model.to_string(),
            input_tokens: usage.get("input_tokens").and_then(Value::as_u64).unwrap_or(0),
            cache_creation_tokens: usage.get("cache_creation_input_tokens").and_then(Value::as_u64).unwrap_or(0),
            cache_creation_5m_tokens: usage.pointer("/cache_creation/ephemeral_5m_input_tokens").and_then(Value::as_u64).unwrap_or(0),
            cache_creation_1h_tokens: usage.pointer("/cache_creation/ephemeral_1h_input_tokens").and_then(Value::as_u64).unwrap_or(0),
            cache_read_tokens: usage.get("cache_read_input_tokens").and_then(Value::as_u64).unwrap_or(0),
            output_tokens: usage.get("output_tokens").and_then(Value::as_u64).unwrap_or(0),
            message_count: 1,
        };
        messages.entry(message_id.to_string()).and_modify(|existing| {
            existing.input_tokens = existing.input_tokens.max(candidate.input_tokens);
            existing.cache_creation_tokens = existing.cache_creation_tokens.max(candidate.cache_creation_tokens);
            existing.cache_creation_5m_tokens = existing.cache_creation_5m_tokens.max(candidate.cache_creation_5m_tokens);
            existing.cache_creation_1h_tokens = existing.cache_creation_1h_tokens.max(candidate.cache_creation_1h_tokens);
            existing.cache_read_tokens = existing.cache_read_tokens.max(candidate.cache_read_tokens);
            existing.output_tokens = existing.output_tokens.max(candidate.output_tokens);
        }).or_insert(candidate);
    }
    for mut message in messages.into_values() {
        // Malformed/partial duplicate copies sometimes retain a TTL detail while their total is
        // zero. A pricing split may never exceed the provider's cache-creation total.
        message.cache_creation_5m_tokens = message.cache_creation_5m_tokens.min(message.cache_creation_tokens);
        message.cache_creation_1h_tokens = message.cache_creation_1h_tokens
            .min(message.cache_creation_tokens - message.cache_creation_5m_tokens);
        let entry = by_day_model.entry((message.date.clone(), message.model.clone())).or_insert_with(|| DailyModelUsage {
            provider_id: "claude".to_string(), date: message.date.clone(), model: message.model.clone(),
            input_tokens: 0, cache_creation_tokens: 0, cache_creation_5m_tokens: 0, cache_creation_1h_tokens: 0,
            cache_read_tokens: 0, output_tokens: 0, message_count: 0,
        });
        entry.input_tokens += message.input_tokens;
        entry.cache_creation_tokens += message.cache_creation_tokens;
        entry.cache_creation_5m_tokens += message.cache_creation_5m_tokens;
        entry.cache_creation_1h_tokens += message.cache_creation_1h_tokens;
        entry.cache_read_tokens += message.cache_read_tokens;
        entry.output_tokens += message.output_tokens;
        entry.message_count += 1;
    }
    let mut rows: Vec<DailyModelUsage> = by_day_model.into_values().collect();
    rows.sort_by(|a, b| a.date.cmp(&b.date).then_with(|| a.model.cmp(&b.model)));
    Ok(rows)
}

struct ClaudeLimitDescriptor {
    limit_key: String,
    name: String,
    window: u64,
    percent: f64,
    reset: i64,
}

/// Map one entry of Claude Code's official `limits` array onto the app's limit model. This is the
/// contract with an upstream JSON shape we do not control, so it is kept pure and covered by
/// tests: an unrecognised kind must be skipped rather than guessed at, and the limit key has to
/// stay stable or the app starts a second limit row for the same quota.
fn claude_limit_descriptor(limit: &Value) -> Option<ClaudeLimitDescriptor> {
    let kind = limit.get("kind").and_then(Value::as_str).unwrap_or("");
    let percent = limit.get("percent").and_then(Value::as_f64)?;
    let scoped_model = limit.pointer("/scope/model/display_name").and_then(Value::as_str);
    let (name, window) = match kind {
        "session" => ("Claude Current session".to_string(), 300),
        "weekly_all" => ("Claude Weekly（全模型）".to_string(), 10080),
        "weekly_scoped" => (format!("Claude Weekly（{}）", scoped_model.unwrap_or("模型")), 10080),
        _ => return None,
    };
    Some(ClaudeLimitDescriptor {
        limit_key: format!("claude-{kind}-{}", scoped_model.unwrap_or("all")),
        name,
        window,
        percent,
        reset: limit.get("resets_at").and_then(Value::as_str).and_then(timestamp_unix).unwrap_or(0),
    })
}

#[tauri::command]
pub fn read_claude_local_usage() -> Result<Vec<LocalUsageReading>, String> {
    let home = std::env::var("HOME").map_err(|_| "找不到使用者目錄".to_string())?;
    let body = fs::read_to_string(Path::new(&home).join(".claude.json"))
        .map_err(|_| "找不到 Claude Code 本機設定".to_string())?;
    let root: Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    let cached_fetched_ms = root.pointer("/cachedUsageUtilization/fetchedAtMs").and_then(Value::as_i64).unwrap_or(0);
    let cached_limits = root.pointer("/cachedUsageUtilization/utilization/limits")
        .and_then(Value::as_array).cloned();
    let since = OffsetDateTime::now_utc().unix_timestamp() - 24 * 60 * 60;
    let (model_usage, session_count, transcript_captured_at) = claude_recent_usage(&home, since);
    let (fetched_ms, limits) = match refreshed_claude_limits(&home, &root, cached_fetched_ms, cached_limits.as_ref(), transcript_captured_at.as_deref()) {
        Some((fresh_ms, fresh_limits)) => (fresh_ms, fresh_limits),
        None => (cached_fetched_ms, cached_limits
            .ok_or_else(|| "Claude Code 尚未快取 /usage 資料；請先執行一次 /usage".to_string())?),
    };
    let captured_at = OffsetDateTime::from_unix_timestamp_nanos(fetched_ms as i128 * 1_000_000)
        .ok().and_then(|t| t.format(&Rfc3339).ok()).unwrap_or_default();
    // Quota freshness must remain the official usage fetch time. Transcript activity only
    // enriches token/cost metadata; promoting its timestamp would make an old percentage look
    // freshly confirmed even when the official reading did not update. The reading is hidden as
    // stale only once activity outruns the official quota by well over the refresh cadence,
    // i.e. live refreshes have kept failing. Exception: when every limit is full and waiting on
    // its reset, refresh is deliberately paused and the (100%) reading is still exact — keep it.
    let all_full = all_full_waiting_for_reset(&limits, OffsetDateTime::now_utc().unix_timestamp());
    let quota_stale = !all_full && transcript_captured_at.as_deref().and_then(timestamp_unix)
        .is_some_and(|activity| activity * 1_000 > fetched_ms + 15 * 60 * 1_000);
    let input_tokens = model_usage.iter().map(|usage| usage.input_tokens).sum();
    let cached_input_tokens = model_usage.iter().map(|usage| usage.cache_read_tokens).sum();
    let output_tokens = model_usage.iter().map(|usage| usage.output_tokens).sum();
    let auth_needs_login = claude_needs_login();

    let mut readings = Vec::new();
    for limit in limits {
        let Some(descriptor) = claude_limit_descriptor(&limit) else { continue };
        let ClaudeLimitDescriptor { limit_key, name, window, percent, reset } = descriptor;
        readings.push(LocalUsageReading {
            provider_id: "claude".into(),
            limit_key,
            limit_name: name, used_percent: percent, window_minutes: window,
            reset_at_unix: reset, captured_at: captured_at.clone(), session_count,
            model_usage: model_usage.clone(), input_tokens, cached_input_tokens, output_tokens,
            reset_available_count: 0, reset_credits: Vec::new(), reset_credits_available: false,
            quota_stale, quota_captured_at: captured_at.clone(), auth_needs_login,
        });
    }
    if readings.is_empty() { return Err("Claude Code /usage 快取沒有可用額度".into()); }
    Ok(readings)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // One transcript line in Claude Code's real shape.
    fn line(id: &str, model: &str, ts: &str, usage: Value) -> String {
        json!({ "timestamp": ts, "message": { "id": id, "model": model, "usage": usage } }).to_string()
    }

    fn codex_context(model: &str, ts: &str) -> String {
        json!({ "timestamp": ts, "type": "turn_context", "payload": { "model": model } }).to_string()
    }

    fn codex_tokens(ts: &str, input: u64, cached: u64, output: u64) -> String {
        json!({ "timestamp": ts, "type": "event_msg", "payload": { "type": "token_count", "info": {
            "last_token_usage": { "input_tokens": input, "cached_input_tokens": cached, "output_tokens": output }
        } } }).to_string()
    }

    #[test]
    fn codex_daily_usage_attributes_deltas_to_the_active_model() {
        let lines = [
            codex_context("gpt-5.5", "2026-07-19T01:00:00Z"),
            codex_tokens("2026-07-19T01:01:00Z", 100, 80, 10),
            codex_context("gpt-5.6-sol", "2026-07-19T02:00:00Z"),
            codex_tokens("2026-07-19T02:01:00Z", 200, 150, 20),
        ];
        let rows = aggregate_codex_daily_usage(lines.iter().map(String::as_str), 0).expect("aggregate");
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].provider_id, "codex");
        assert_eq!((rows[0].model.as_str(), rows[0].input_tokens, rows[0].cache_read_tokens), ("gpt-5.5", 20, 80));
        assert_eq!((rows[1].model.as_str(), rows[1].output_tokens), ("gpt-5.6-sol", 20));
    }

    #[test]
    fn codex_daily_usage_uses_the_callers_timezone_and_skips_cumulative_totals() {
        let lines = [
            codex_context("gpt-5.6-terra", "2026-07-19T23:00:00Z"),
            json!({ "timestamp": "2026-07-19T23:30:00Z", "type": "event_msg", "payload": {
                "type": "token_count", "info": {
                    "total_token_usage": { "input_tokens": 999_999 },
                    "last_token_usage": { "input_tokens": 7, "cached_input_tokens": 3, "output_tokens": 2 }
                }
            } }).to_string(),
        ];
        let rows = aggregate_codex_daily_usage(lines.iter().map(String::as_str), 8 * 60).expect("aggregate");
        assert_eq!(rows[0].date, "2026-07-20");
        assert_eq!(rows[0].input_tokens, 4);
    }

    #[test]
    fn usage_response_signals_login_when_no_limits_are_available() {
        // The real payload from an expired login: success envelope, rate_limits_available false.
        let expired = json!({ "response": { "response": {
            "subscription_type": null, "rate_limits_available": false, "rate_limits": null } } });
        assert!(matches!(classify_usage_response(&expired), ClaudeUsageFetch::NeedsLogin));

        let ok = json!({ "response": { "response": { "rate_limits_available": true, "rate_limits": {
            "limits": [{ "kind": "session", "percent": 20.0, "resets_at": "2026-07-25T12:00:00Z" }] } } } });
        assert!(matches!(classify_usage_response(&ok), ClaudeUsageFetch::Limits(l) if l.len() == 1));

        // Empty limits but no explicit "unavailable" — a shape we don't understand, not a claim
        // that the user is signed out. Must not nag them to log in.
        let empty = json!({ "response": { "response": { "rate_limits": { "limits": [] } } } });
        assert!(matches!(classify_usage_response(&empty), ClaudeUsageFetch::Unavailable));
    }

    #[test]
    fn daily_usage_sums_tokens_per_day_and_model() {
        let lines = [
            line("m1", "claude-opus-4-8", "2026-07-19T01:00:00.000Z",
                 json!({ "input_tokens": 10, "output_tokens": 100, "cache_read_input_tokens": 1000,
                         "cache_creation_input_tokens": 500,
                         "cache_creation": { "ephemeral_5m_input_tokens": 200, "ephemeral_1h_input_tokens": 300 } })),
            line("m2", "claude-opus-4-8", "2026-07-19T02:00:00.000Z",
                 json!({ "input_tokens": 5, "output_tokens": 50 })),
            line("m3", "claude-fable-5", "2026-07-19T03:00:00.000Z",
                 json!({ "input_tokens": 1, "output_tokens": 7 })),
        ];
        let rows = aggregate_daily_usage(lines.iter().map(String::as_str), 0).expect("aggregate");
        assert_eq!(rows.len(), 2, "one row per (day, model)");
        let opus = rows.iter().find(|r| r.model == "claude-opus-4-8").expect("opus row");
        assert_eq!(opus.date, "2026-07-19");
        assert_eq!((opus.input_tokens, opus.output_tokens), (15, 150));
        assert_eq!(opus.cache_read_tokens, 1000);
        // The TTL split drives cache-write pricing (5m = 1.25x input, 1h = 2x).
        assert_eq!((opus.cache_creation_tokens, opus.cache_creation_5m_tokens, opus.cache_creation_1h_tokens), (500, 200, 300));
        assert_eq!(opus.message_count, 2);
    }

    #[test]
    fn daily_usage_counts_each_message_once_across_files() {
        // The same message id appears in two transcripts (resumed session); counting it twice
        // would inflate the cost page.
        let usage = json!({ "input_tokens": 10, "output_tokens": 10 });
        let lines = [
            line("dup", "claude-opus-4-8", "2026-07-19T01:00:00.000Z", usage.clone()),
            line("dup", "claude-opus-4-8", "2026-07-19T01:00:00.000Z", usage.clone()),
        ];
        let rows = aggregate_daily_usage(lines.iter().map(String::as_str), 0).expect("aggregate");
        assert_eq!(rows[0].message_count, 1);
        assert_eq!(rows[0].output_tokens, 10);
    }

    #[test]
    fn daily_usage_keeps_the_most_complete_duplicate_copy() {
        let lines = [
            line("dup", "claude-opus-4-8", "2026-07-19T01:00:00.000Z",
                 json!({ "input_tokens": 0, "output_tokens": 0, "cache_creation_input_tokens": 0,
                         "cache_creation": { "ephemeral_1h_input_tokens": 500 } })),
            line("dup", "claude-opus-4-8", "2026-07-19T01:00:00.000Z",
                 json!({ "input_tokens": 2, "output_tokens": 100, "cache_creation_input_tokens": 400,
                         "cache_creation": { "ephemeral_1h_input_tokens": 500 } })),
        ];
        let rows = aggregate_daily_usage(lines.iter().map(String::as_str), 0).expect("aggregate");
        assert_eq!(rows[0].message_count, 1);
        assert_eq!((rows[0].input_tokens, rows[0].output_tokens), (2, 100));
        assert_eq!((rows[0].cache_creation_tokens, rows[0].cache_creation_1h_tokens), (400, 400));
    }

    #[test]
    fn daily_usage_skips_lines_that_are_not_billable_messages() {
        let usage = json!({ "input_tokens": 10, "output_tokens": 10 });
        let lines = [
            "not json at all".to_string(),
            json!({ "timestamp": "2026-07-19T01:00:00.000Z", "type": "summary" }).to_string(), // no usage
            line("", "claude-opus-4-8", "2026-07-19T01:00:00.000Z", usage.clone()),            // no id
            line("s1", "<synthetic>", "2026-07-19T01:00:00.000Z", usage.clone()),              // local-only
            json!({ "message": { "id": "no-ts", "model": "claude-opus-4-8", "usage": usage } }).to_string(),
        ];
        assert!(aggregate_daily_usage(lines.iter().map(String::as_str), 0).expect("aggregate").is_empty());
    }

    #[test]
    fn daily_usage_buckets_dates_in_the_callers_timezone() {
        // 23:30Z on the 19th is already the 20th in UTC+8 — the day a Taipei user would expect.
        let lines = [line("m1", "claude-opus-4-8", "2026-07-19T23:30:00.000Z", json!({ "output_tokens": 1 }))];
        let utc = aggregate_daily_usage(lines.iter().map(String::as_str), 0).expect("utc");
        let taipei = aggregate_daily_usage(lines.iter().map(String::as_str), 8 * 60).expect("taipei");
        assert_eq!(utc[0].date, "2026-07-19");
        assert_eq!(taipei[0].date, "2026-07-20");
    }

    #[test]
    fn claude_limits_map_onto_the_apps_limit_model() {
        let session = claude_limit_descriptor(&json!({
            "kind": "session", "percent": 66.0, "resets_at": "2026-07-19T13:59:59.865244+00:00", "scope": null
        })).expect("session limit");
        assert_eq!(session.limit_key, "claude-session-all");
        assert_eq!(session.name, "Claude Current session");
        assert_eq!(session.window, 300);
        assert_eq!(session.percent, 66.0);
        assert_eq!(session.reset, 1784469599);

        let scoped = claude_limit_descriptor(&json!({
            "kind": "weekly_scoped", "percent": 51.0, "resets_at": "2026-07-25T11:59:59.865714+00:00",
            "scope": { "model": { "id": null, "display_name": "Fable" } }
        })).expect("scoped limit");
        assert_eq!(scoped.limit_key, "claude-weekly_scoped-Fable");
        assert_eq!(scoped.name, "Claude Weekly（Fable）");
        assert_eq!(scoped.window, 10080);

        let weekly = claude_limit_descriptor(&json!({ "kind": "weekly_all", "percent": 27.0, "resets_at": null }))
            .expect("weekly limit");
        assert_eq!(weekly.limit_key, "claude-weekly_all-all");
        assert_eq!(weekly.reset, 0, "a missing reset must not be invented");
    }

    #[test]
    fn claude_limits_skip_shapes_the_app_cannot_model() {
        // A kind we do not understand must be dropped, not guessed at — inventing a window or
        // name would surface a fabricated limit row in the UI.
        assert!(claude_limit_descriptor(&json!({ "kind": "tangelo", "percent": 10.0 })).is_none());
        assert!(claude_limit_descriptor(&json!({ "kind": "session" })).is_none(), "no percent");
    }

    #[test]
    fn full_quota_pause_needs_every_limit_full_and_unreset() {
        let future = OffsetDateTime::now_utc().unix_timestamp() + 3600;
        let now = OffsetDateTime::now_utc().unix_timestamp();
        let full = |percent: f64, reset: i64| json!({
            "percent": percent,
            "resets_at": OffsetDateTime::from_unix_timestamp(reset).unwrap().format(&Rfc3339).unwrap(),
        });
        assert!(all_full_waiting_for_reset(&[full(100.0, future), full(99.5, future)], now));
        // One limit still has headroom: the others keep moving, so refreshing must continue.
        assert!(!all_full_waiting_for_reset(&[full(100.0, future), full(40.0, future)], now));
        // Full but the reset is already due — confirming the new cycle takes priority.
        assert!(!all_full_waiting_for_reset(&[full(100.0, now - 60)], now));
        assert!(!all_full_waiting_for_reset(&[], now), "no limits is not a paused state");
    }

    #[test]
    fn timestamps_parse_rfc3339_and_reject_anything_else() {
        assert_eq!(timestamp_unix("2026-07-19T13:59:59.865244+00:00"), Some(1784469599));
        assert_eq!(timestamp_unix("2026-07-19T13:59:59Z"), Some(1784469599));
        assert_eq!(timestamp_unix("2026-07-19 13:59:59"), None);
        assert_eq!(timestamp_unix(""), None);
    }

    #[test]
    #[ignore = "live check: reads the real ~/.claude/projects transcript history"]
    fn read_claude_usage_daily_live() {
        let started = Instant::now();
        let rows = read_claude_usage_daily(8 * 60).expect("daily usage");
        assert!(!rows.is_empty());
        // Full JSON dump on stdout so the result can be cross-checked against ccusage.
        println!("{}", serde_json::to_string(&rows).expect("serialize"));
        eprintln!("rows={} elapsed={:?}", rows.len(), started.elapsed());
    }

    #[test]
    #[ignore = "live check: reads the real ~/.codex session history"]
    fn read_codex_usage_daily_live() {
        let started = Instant::now();
        let rows = read_codex_usage_daily(8 * 60).expect("daily usage");
        assert!(!rows.is_empty());
        assert!(rows.iter().any(|row| row.model.starts_with("gpt-5.")));
        println!("{}", serde_json::to_string(&rows).expect("serialize"));
        eprintln!("rows={} elapsed={:?}", rows.len(), started.elapsed());
    }

    #[test]
    #[ignore = "live check: needs a logged-in local Claude Code install and network access"]
    fn fetch_claude_usage_live() {
        let home = std::env::var("HOME").expect("HOME");
        let ClaudeUsageFetch::Limits(limits) = fetch_claude_usage_via_cli(&home, Path::new(&home)) else {
            panic!("expected live usage limits — is Claude Code logged in?");
        };
        assert!(limits.iter().any(|limit| {
            limit.get("kind").and_then(Value::as_str).is_some()
                && limit.get("percent").and_then(Value::as_f64).is_some()
                && limit.get("resets_at").and_then(Value::as_str).and_then(timestamp_unix).is_some()
        }), "limits missing expected fields: {limits:?}");
    }
}
