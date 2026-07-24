use serde::Serialize;
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInventoryItem {
    pub key: String,
    pub name: String,
    pub platform: String,
    pub description: String,
    pub source: String,
    pub version: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillUsageItem {
    pub key: String,
    pub name: String,
    pub platform: String,
    pub confirmed_all_time: u64,
    pub confirmed_30d: u64,
    pub probable_all_time: u64,
    pub probable_30d: u64,
    pub last_used_at: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillMonitorSnapshot {
    pub captured_at: String,
    pub inventory: Vec<SkillInventoryItem>,
    pub usage: Vec<SkillUsageItem>,
    pub warnings: Vec<String>,
}

fn walk_files(root: &Path, file_name: Option<&str>, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            walk_files(&path, file_name, out);
        } else if file_name.map_or(true, |wanted| {
            path.file_name().and_then(|v| v.to_str()) == Some(wanted)
                || path.extension().and_then(|v| v.to_str()) == Some(wanted)
        }) {
            out.push(path);
        }
    }
}

fn frontmatter_value(text: &str, key: &str) -> String {
    if !text.starts_with("---") {
        return String::new();
    }
    text.lines()
        .skip(1)
        .take_while(|line| *line != "---")
        .find_map(|line| {
            let (candidate, value) = line.split_once(':')?;
            (candidate.trim() == key).then(|| value.trim().trim_matches(['"', '\'']).to_string())
        })
        .unwrap_or_default()
}

fn source_and_version(path: &Path) -> (String, Option<String>) {
    let parts: Vec<_> = path
        .components()
        .filter_map(|part| part.as_os_str().to_str())
        .collect();
    if let Some(cache_at) = parts.iter().position(|part| *part == "cache") {
        let source = parts
            .get(cache_at + 1)
            .copied()
            .unwrap_or("plugin")
            .to_string();
        let version = parts.get(cache_at + 3).map(|value| value.to_string());
        return (source, version);
    }
    let source = if path.to_string_lossy().contains("/.agents/") {
        "shared"
    } else {
        "personal"
    };
    (source.to_string(), None)
}

fn collect_inventory(home: &Path) -> Vec<SkillInventoryItem> {
    let roots = [
        ("codex", home.join(".codex/skills")),
        ("codex", home.join(".codex/plugins/cache")),
        ("codex", home.join(".agents/skills")),
        ("claude", home.join(".claude/skills")),
        ("claude", home.join(".claude/plugins/cache")),
    ];
    let mut items = BTreeMap::new();
    for (platform, root) in roots {
        let mut files = Vec::new();
        walk_files(&root, Some("SKILL.md"), &mut files);
        for path in files {
            let Ok(text) = fs::read_to_string(&path) else {
                continue;
            };
            let fallback = path
                .parent()
                .and_then(Path::file_name)
                .and_then(|v| v.to_str())
                .unwrap_or("unknown");
            let name = {
                let parsed = frontmatter_value(&text, "name");
                if parsed.is_empty() {
                    fallback.to_string()
                } else {
                    parsed
                }
            };
            let description = frontmatter_value(&text, "description");
            let (source, version) = source_and_version(&path);
            let key = format!("{platform}:{name}");
            let item = SkillInventoryItem {
                key: key.clone(),
                name,
                platform: platform.to_string(),
                description,
                source,
                version,
            };
            // Cache entries are encountered after personal entries and represent the active plugin copy.
            items.insert(key, item);
        }
    }
    items.into_values().collect()
}

fn timestamp_30d(timestamp: Option<&str>, cutoff: i64) -> bool {
    timestamp
        .and_then(|value| OffsetDateTime::parse(value, &Rfc3339).ok())
        .map_or(false, |value| value.unix_timestamp() >= cutoff)
}

fn update_usage(
    usage: &mut BTreeMap<String, SkillUsageItem>,
    platform: &str,
    name: &str,
    timestamp: Option<&str>,
    probable: bool,
    cutoff: i64,
) {
    let key = format!("{platform}:{name}");
    let item = usage.entry(key.clone()).or_insert_with(|| SkillUsageItem {
        key,
        name: name.to_string(),
        platform: platform.to_string(),
        ..Default::default()
    });
    if probable {
        item.probable_all_time += 1;
        if timestamp_30d(timestamp, cutoff) {
            item.probable_30d += 1;
        }
    } else {
        item.confirmed_all_time += 1;
        if timestamp_30d(timestamp, cutoff) {
            item.confirmed_30d += 1;
        }
    }
    if let Some(timestamp) = timestamp {
        if item
            .last_used_at
            .as_deref()
            .map_or(true, |previous| timestamp > previous)
        {
            item.last_used_at = Some(timestamp.to_string());
        }
    }
}

fn find_claude_skill_calls(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::Object(map) => {
            if map.get("type").and_then(Value::as_str) == Some("tool_use")
                && map.get("name").and_then(Value::as_str) == Some("Skill")
            {
                if let Some(name) = map
                    .get("input")
                    .and_then(Value::as_object)
                    .and_then(|input| input.get("skill").or_else(|| input.get("name")))
                    .and_then(Value::as_str)
                {
                    out.push(name.to_string());
                }
            }
            map.values()
                .for_each(|child| find_claude_skill_calls(child, out));
        }
        Value::Array(values) => values
            .iter()
            .for_each(|child| find_claude_skill_calls(child, out)),
        _ => {}
    }
}

fn strings(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::String(text) => out.push(text.clone()),
        Value::Array(values) => values.iter().for_each(|child| strings(child, out)),
        Value::Object(map) => map.values().for_each(|child| strings(child, out)),
        _ => {}
    }
}

fn scan_claude(home: &Path, usage: &mut BTreeMap<String, SkillUsageItem>, cutoff: i64) {
    let mut files = Vec::new();
    walk_files(&home.join(".claude/projects"), Some("jsonl"), &mut files);
    for path in files {
        let Ok(file) = fs::File::open(path) else {
            continue;
        };
        for line in BufReader::new(file).lines().map_while(Result::ok) {
            let Ok(value) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            let timestamp = value.get("timestamp").and_then(Value::as_str);
            let mut calls = Vec::new();
            find_claude_skill_calls(&value, &mut calls);
            for name in calls {
                update_usage(usage, "claude", &name, timestamp, false, cutoff);
            }
        }
    }
}

fn extract_explicit_skills(text: &str, known: &BTreeSet<String>) -> BTreeSet<String> {
    text.split(|character: char| {
        character.is_whitespace()
            || matches!(character, ',' | '，' | ')' | '）' | ']' | '}' | '"' | '\'')
    })
    .filter_map(|token| token.strip_prefix('$'))
    .map(|token| {
        token.trim_matches(|character: char| {
            !character.is_alphanumeric() && !matches!(character, '-' | '_' | ':')
        })
    })
    .filter(|name| known.contains(*name))
    .map(str::to_string)
    .collect()
}

fn scan_codex(
    home: &Path,
    inventory: &[SkillInventoryItem],
    usage: &mut BTreeMap<String, SkillUsageItem>,
    cutoff: i64,
) {
    let known: BTreeSet<String> = inventory
        .iter()
        .filter(|item| item.platform == "codex")
        .flat_map(|item| {
            let mut names = vec![item.name.clone()];
            if let Some((_, suffix)) = item.name.rsplit_once(':') {
                names.push(suffix.to_string());
            }
            names
        })
        .collect();
    let mut files = Vec::new();
    walk_files(&home.join(".codex/sessions"), Some("jsonl"), &mut files);
    walk_files(
        &home.join(".codex/archived_sessions"),
        Some("jsonl"),
        &mut files,
    );
    for path in files {
        let Ok(file) = fs::File::open(path) else {
            continue;
        };
        for line in BufReader::new(file).lines().map_while(Result::ok) {
            let Ok(value) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            let timestamp = value.get("timestamp").and_then(Value::as_str);
            let payload = value.get("payload").unwrap_or(&value);
            let role = payload.get("role").and_then(Value::as_str);
            let mut content = Vec::new();
            strings(payload, &mut content);
            if role == Some("user") {
                for name in content
                    .iter()
                    .flat_map(|text| extract_explicit_skills(text, &known))
                {
                    update_usage(usage, "codex", &name, timestamp, false, cutoff);
                }
            } else if role != Some("developer") {
                let joined = content.join("\n");
                if joined.contains("SKILL.md") {
                    for name in &known {
                        let slash = format!("/{name}/SKILL.md");
                        if joined.contains(&slash) {
                            update_usage(usage, "codex", name, timestamp, true, cutoff);
                        }
                    }
                }
            }
        }
    }
}

#[tauri::command]
pub async fn read_skill_monitor() -> Result<SkillMonitorSnapshot, String> {
    tauri::async_runtime::spawn_blocking(build_skill_monitor)
        .await
        .map_err(|error| format!("Skill scan worker failed: {error}"))?
}

fn build_skill_monitor() -> Result<SkillMonitorSnapshot, String> {
    // Shared with the usage readers: a Windows GUI process has USERPROFILE, not HOME.
    let home = crate::local_usage::user_home_dir()?;
    let captured = OffsetDateTime::now_utc();
    let cutoff = captured.unix_timestamp() - 30 * 24 * 60 * 60;
    let inventory = collect_inventory(&home);
    let mut usage = BTreeMap::new();
    scan_claude(&home, &mut usage, cutoff);
    scan_codex(&home, &inventory, &mut usage, cutoff);
    Ok(SkillMonitorSnapshot {
        captured_at: captured.format(&Rfc3339).map_err(|error| error.to_string())?,
        inventory,
        usage: usage.into_values().collect(),
        warnings: vec![
            "Claude：Skill 工具呼叫為確定紀錄。".to_string(),
            "Codex：明確 $skill 為確定紀錄；SKILL.md 讀取為推定紀錄。平台未提供官方 Skill telemetry。".to_string(),
        ],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_claude_skill_tool_calls() {
        let value = serde_json::json!({"content":[{"type":"tool_use","name":"Skill","input":{"skill":"tdd"}}]});
        let mut calls = Vec::new();
        find_claude_skill_calls(&value, &mut calls);
        assert_eq!(calls, vec!["tdd"]);
    }

    #[test]
    fn explicit_codex_calls_require_dollar_prefix_and_known_name() {
        let known = BTreeSet::from(["stop-slop".to_string()]);
        assert_eq!(
            extract_explicit_skills("use $stop-slop please", &known),
            BTreeSet::from(["stop-slop".to_string()])
        );
        assert!(extract_explicit_skills("metadata mentions stop-slop", &known).is_empty());
    }

    #[test]
    fn parses_frontmatter_without_treating_body_as_metadata() {
        let text = "---\nname: useful-skill\ndescription: Does useful work\n---\nname: ignored";
        assert_eq!(frontmatter_value(text, "name"), "useful-skill");
        assert_eq!(frontmatter_value(text, "description"), "Does useful work");
    }
}
