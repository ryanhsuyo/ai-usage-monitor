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
    let mut reader = BufReader::new(stdout);
    writeln!(stdin, "{}", r#"{"id":1,"method":"initialize","params":{"clientInfo":{"name":"ai-usage-monitor","version":"0.1.0"},"capabilities":{"experimentalApi":true}}}"#).map_err(|error| error.to_string())?;
    stdin.flush().map_err(|error| error.to_string())?;
    read_codex_response(&mut reader, 1)?;
    writeln!(stdin, "{}", r#"{"id":2,"method":"account/rateLimits/read","params":null}"#).map_err(|error| error.to_string())?;
    stdin.flush().map_err(|error| error.to_string())?;
    let result = read_codex_response(&mut reader, 2);
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

static CLAUDE_USAGE_REFRESH: OnceLock<Mutex<Option<Instant>>> = OnceLock::new();

fn refresh_claude_usage_cache(home: &str, root: &Value) {
    let refresh = CLAUDE_USAGE_REFRESH.get_or_init(|| Mutex::new(None));
    let Ok(mut last_attempt) = refresh.lock() else { return };
    if last_attempt.as_ref().is_some_and(|at| at.elapsed() < Duration::from_secs(4 * 60)) { return; }

    let fetched_ms = root.pointer("/cachedUsageUtilization/fetchedAtMs").and_then(Value::as_i64).unwrap_or(0);
    let reset_due = root.pointer("/cachedUsageUtilization/utilization/limits").and_then(Value::as_array)
        .is_some_and(|limits| limits.iter().any(|limit| {
            limit.get("resets_at").and_then(Value::as_str).and_then(timestamp_unix)
                .is_some_and(|reset| reset <= OffsetDateTime::now_utc().unix_timestamp())
        }));
    // With an existing cache, wait for the provider's advertised reset boundary. Claude Code
    // itself updates ordinary in-cycle usage while it is running; this background command exists
    // only to confirm that a due reset actually happened. A missing cache gets one bootstrap try.
    if fetched_ms > 0 && !reset_due { return; }

    let trusted_dir = root.get("projects").and_then(Value::as_object).and_then(|projects| {
        projects.iter().find_map(|(path, settings)| {
            (settings.get("hasTrustDialogAccepted").and_then(Value::as_bool) == Some(true)
                && Path::new(path).is_dir()).then(|| PathBuf::from(path))
        })
    });
    let Some(trusted_dir) = trusted_dir else { return };
    *last_attempt = Some(Instant::now());
    drop(last_attempt);

    let local = Path::new(home).join(".local/bin/claude");
    let binary = if local.exists() { local } else { PathBuf::from("claude") };

    // `claude -p /usage` is treated as an ordinary zero-token prompt by recent Claude Code
    // versions and does not refresh cachedUsageUtilization. On macOS, run the official slash
    // command in a hidden pseudo-terminal instead. It reports zero turns/tokens/cost; no output
    // or credential is captured. The file watcher ingests the refreshed cache asynchronously.
    #[cfg(target_os = "macos")]
    std::thread::spawn(move || {
        use std::io::Write;
        let Ok(mut child) = Command::new("/usr/bin/script")
            .arg("-q").arg("/dev/null").arg(binary)
            .current_dir(trusted_dir)
            .stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null())
            .spawn() else { return };
        let Some(mut stdin) = child.stdin.take() else { let _ = child.kill(); return };
        std::thread::sleep(Duration::from_secs(1));
        let _ = stdin.write_all(b"/usage\r");
        let _ = stdin.flush();
        std::thread::sleep(Duration::from_secs(4));
        let _ = stdin.write_all(b"\x1b");
        let _ = stdin.flush();
        std::thread::sleep(Duration::from_secs(1));
        let _ = stdin.write_all(b"\x03\x03");
        drop(stdin);
        let _ = child.wait();
    });
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
            used_percent: used, window_minutes: window, reset_at_unix: reset, captured_at: captured,
            session_count, input_tokens: model_usage.iter().map(|u| u.input_tokens).sum(),
            cached_input_tokens: model_usage.iter().map(|u| u.cached_input_tokens).sum(),
            output_tokens: model_usage.iter().map(|u| u.output_tokens).sum(), model_usage,
            reset_available_count, reset_credits: reset_credits.clone(), reset_credits_available,
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

#[tauri::command]
pub fn read_claude_local_usage() -> Result<Vec<LocalUsageReading>, String> {
    let home = std::env::var("HOME").map_err(|_| "找不到使用者目錄".to_string())?;
    let body = fs::read_to_string(Path::new(&home).join(".claude.json"))
        .map_err(|_| "找不到 Claude Code 本機設定".to_string())?;
    let root: Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    let cached = root.get("cachedUsageUtilization")
        .ok_or_else(|| "Claude Code 尚未快取 /usage 資料；請先執行一次 /usage".to_string())?;
    let fetched_ms = cached.get("fetchedAtMs").and_then(Value::as_i64).unwrap_or(0);
    let captured_at = OffsetDateTime::from_unix_timestamp_nanos(fetched_ms as i128 * 1_000_000)
        .ok().and_then(|t| t.format(&Rfc3339).ok()).unwrap_or_default();
    let limits = cached.pointer("/utilization/limits").and_then(Value::as_array)
        .ok_or_else(|| "Claude Code /usage 快取沒有額度資料".to_string())?;
    let since = OffsetDateTime::now_utc().unix_timestamp() - 24 * 60 * 60;
    let (model_usage, session_count, transcript_captured_at) = claude_recent_usage(&home, since);
    refresh_claude_usage_cache(&home, &root);
    let captured_at = transcript_captured_at.filter(|timestamp| timestamp > &captured_at).unwrap_or(captured_at);
    let input_tokens = model_usage.iter().map(|usage| usage.input_tokens).sum();
    let cached_input_tokens = model_usage.iter().map(|usage| usage.cache_read_tokens).sum();
    let output_tokens = model_usage.iter().map(|usage| usage.output_tokens).sum();

    let mut readings = Vec::new();
    for limit in limits {
        let kind = limit.get("kind").and_then(Value::as_str).unwrap_or("");
        let Some(percent) = limit.get("percent").and_then(Value::as_f64) else { continue };
        let (name, window) = match kind {
            "session" => ("Claude Current session".to_string(), 300),
            "weekly_all" => ("Claude Weekly（全模型）".to_string(), 10080),
            "weekly_scoped" => {
                let model = limit.pointer("/scope/model/display_name").and_then(Value::as_str).unwrap_or("模型");
                (format!("Claude Weekly（{model}）"), 10080)
            }
            _ => continue,
        };
        let reset = limit.get("resets_at").and_then(Value::as_str).and_then(timestamp_unix).unwrap_or(0);
        readings.push(LocalUsageReading {
            provider_id: "claude".into(),
            limit_key: format!("claude-{kind}-{}", limit.pointer("/scope/model/display_name").and_then(Value::as_str).unwrap_or("all")),
            limit_name: name, used_percent: percent, window_minutes: window,
            reset_at_unix: reset, captured_at: captured_at.clone(), session_count,
            model_usage: model_usage.clone(), input_tokens, cached_input_tokens, output_tokens,
            reset_available_count: 0, reset_credits: Vec::new(), reset_credits_available: false,
        });
    }
    if readings.is_empty() { return Err("Claude Code /usage 快取沒有可用額度".into()); }
    Ok(readings)
}
