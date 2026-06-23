use std::{
    fs,
    path::PathBuf,
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use tauri::AppHandle;

use crate::storage::{app_data_dir, db, set_setting, setting};

type CompatResult = Result<Value, String>;
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

fn success(value: Value) -> Value {
    match value {
        Value::Object(mut object) => {
            object.entry("success").or_insert(Value::Bool(true));
            Value::Object(object)
        }
        other => json!({ "success": true, "value": other }),
    }
}

fn arg_string(args: &[Value], index: usize) -> Option<String> {
    args.get(index)
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

fn mihomo_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app_data_dir(app)?.join("mihomo");
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    Ok(dir)
}

pub(crate) fn today_key() -> String {
    let mut command = Command::new("powershell.exe");
    command.args(["-NoProfile", "-Command", "Get-Date -Format yyyy-MM-dd"]);
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);
    let output = command.output();
    output
        .ok()
        .and_then(|out| String::from_utf8(out.stdout).ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| (now_millis() / 86_400_000).to_string())
}

fn extract_quoted_field(line: &str, key: &str) -> Option<String> {
    let marker = format!("{key}=\"");
    let start = line.find(&marker)? + marker.len();
    let mut escaped = false;
    let mut result = String::new();

    for ch in line[start..].chars() {
        if escaped {
            result.push(ch);
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            continue;
        }
        if ch == '"' {
            return Some(result);
        }
        result.push(ch);
    }

    None
}

fn parse_mihomo_log_line(line: &str) -> Value {
    let lower = line.to_ascii_lowercase();
    let level = if lower.contains("level=error") || lower.contains("[error]") {
        "error"
    } else if lower.contains("level=warning")
        || lower.contains("level=warn")
        || lower.contains("[warning]")
        || lower.contains("[warn]")
    {
        "warning"
    } else if lower.contains("level=debug") || lower.contains("[debug]") {
        "debug"
    } else {
        "info"
    };
    let payload = extract_quoted_field(line, "msg").unwrap_or_else(|| line.to_string());
    let time = extract_quoted_field(line, "time").unwrap_or_default();

    json!({
        "type": level,
        "payload": payload,
        "time": time
    })
}

fn read_mihomo_logs(app: &AppHandle, limit: usize) -> Result<Vec<Value>, String> {
    let log_path = mihomo_dir(app)?.join("mihomo.log");
    if !log_path.exists() {
        return Ok(vec![]);
    }

    let bytes = fs::read(log_path).map_err(|err| err.to_string())?;
    let content = String::from_utf8_lossy(&bytes);
    let lines = content
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>();
    let start = lines.len().saturating_sub(limit);

    Ok(lines[start..]
        .iter()
        .map(|line| parse_mihomo_log_line(line))
        .collect())
}

fn civil_from_unix_days(days: i64) -> (i32, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    let year = y + if month <= 2 { 1 } else { 0 };
    (year as i32, month as u32, day as u32)
}

fn log_file_timestamp() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or_default();
    let days = seconds.div_euclid(86_400);
    let seconds_of_day = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_unix_days(days);
    let hour = seconds_of_day / 3_600;
    let minute = (seconds_of_day % 3_600) / 60;
    let second = seconds_of_day % 60;

    format!("{year:04}-{month:02}-{day:02}-{hour:02}-{minute:02}-{second:02}")
}

fn log_value_to_text(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::String(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(text.to_string())
            }
        }
        Value::Number(number) => Some(number.to_string()),
        Value::Bool(value) => Some(value.to_string()),
        Value::Array(_) | Value::Object(_) => serde_json::to_string(value)
            .ok()
            .filter(|text| !text.is_empty()),
    }
}

fn first_log_field(entry: &Value, keys: &[&str]) -> Option<String> {
    let object = entry.as_object()?;
    keys.iter()
        .find_map(|key| object.get(*key).and_then(log_value_to_text))
}

fn normalize_saved_log_level(level: Option<String>) -> &'static str {
    match level
        .unwrap_or_else(|| "info".to_string())
        .to_ascii_lowercase()
        .as_str()
    {
        "error" => "ERROR",
        "warn" | "warning" => "WARNING",
        "debug" => "DEBUG",
        _ => "INFO",
    }
}

fn format_saved_log_entry(entry: &Value) -> String {
    if let Some(text) = entry.as_str() {
        return format!("{} [INFO] {}", log_file_timestamp(), text);
    }

    let timestamp =
        first_log_field(entry, &["time", "timestamp", "date"]).unwrap_or_else(log_file_timestamp);
    let level = normalize_saved_log_level(first_log_field(entry, &["type", "level"]));
    let content = first_log_field(entry, &["payload", "content", "message", "msg", "text"])
        .or_else(|| serde_json::to_string(entry).ok())
        .unwrap_or_default();

    format!("{timestamp} [{level}] {content}")
}

fn save_mihomo_logs(app: &AppHandle, log_entries: &Value) -> Result<PathBuf, String> {
    let logs_dir = app_data_dir(app)?.join("logs");
    fs::create_dir_all(&logs_dir).map_err(|err| err.to_string())?;
    let file_path = logs_dir.join(format!("mihomo-logs-{}.txt", log_file_timestamp()));

    let entries = match log_entries {
        Value::Array(entries) => entries.clone(),
        Value::Null => vec![],
        other => vec![other.clone()],
    };
    let content = entries
        .iter()
        .map(format_saved_log_entry)
        .collect::<Vec<_>>()
        .join("\n");

    fs::write(&file_path, content).map_err(|err| err.to_string())?;
    Ok(file_path)
}

fn clear_mihomo_logs(app: &AppHandle) -> Result<(), String> {
    let log_path = mihomo_dir(app)?.join("mihomo.log");
    if log_path.exists() {
        fs::write(log_path, "").map_err(|err| err.to_string())?;
    }
    set_setting(app, "logs", json!([]))?;
    Ok(())
}

pub(crate) fn add_traffic_history(
    app: &AppHandle,
    upload: u64,
    download: u64,
) -> Result<(), String> {
    let date = today_key();
    let now = now_millis() as i64;
    db(app)?
        .execute(
            r#"
            INSERT INTO traffic_history (date, upload, download, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?4)
            ON CONFLICT(date) DO UPDATE SET
              upload = upload + excluded.upload,
              download = download + excluded.download,
              updated_at = excluded.updated_at
            "#,
            params![date, upload as i64, download as i64, now],
        )
        .map_err(|err| err.to_string())?;
    Ok(())
}

fn traffic_rows(app: &AppHandle, prefix: Option<String>) -> Result<Vec<Value>, String> {
    let conn = db(app)?;
    let (sql, bind): (&str, Option<String>) = if let Some(prefix) = prefix {
        (
            "SELECT date, upload, download FROM traffic_history WHERE date LIKE ?1 ORDER BY date ASC",
            Some(format!("{prefix}%")),
        )
    } else {
        (
            "SELECT date, upload, download FROM traffic_history ORDER BY date ASC",
            None,
        )
    };
    let mut stmt = conn.prepare(sql).map_err(|err| err.to_string())?;
    let rows = if let Some(bind) = bind {
        stmt.query_map(params![bind], |row| {
            Ok(json!({
                "date": row.get::<_, String>(0)?,
                "upload": row.get::<_, i64>(1)?,
                "download": row.get::<_, i64>(2)?
            }))
        })
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
    } else {
        stmt.query_map([], |row| {
            Ok(json!({
                "date": row.get::<_, String>(0)?,
                "upload": row.get::<_, i64>(1)?,
                "download": row.get::<_, i64>(2)?
            }))
        })
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
    };
    rows.map_err(|err| err.to_string())
}

fn traffic_by_date(app: &AppHandle, date: &str) -> Result<Value, String> {
    Ok(db(app)?
        .query_row(
            "SELECT date, upload, download FROM traffic_history WHERE date = ?1",
            params![date],
            |row| {
                Ok(json!({
                    "date": row.get::<_, String>(0)?,
                    "upload": row.get::<_, i64>(1)?,
                    "download": row.get::<_, i64>(2)?
                }))
            },
        )
        .optional()
        .map_err(|err| err.to_string())?
        .unwrap_or_else(|| json!({ "date": date, "upload": 0, "download": 0 })))
}

pub(crate) async fn handle_compat_call(
    app: &AppHandle,
    method: &str,
    args: &[Value],
) -> Option<CompatResult> {
    if !matches!(
        method,
        "getLogs"
            | "saveLogs"
            | "clearLogs"
            | "clear-logs"
            | "getTrafficToday"
            | "traffic-history:get-today"
            | "getTrafficByDate"
            | "traffic-history:get-by-date"
            | "getTrafficMonth"
            | "traffic-history:get-month"
            | "getTrafficYear"
            | "traffic-history:get-year"
    ) {
        return None;
    }

    Some(dispatch_compat_call(app, method, args).await)
}

async fn dispatch_compat_call(app: &AppHandle, method: &str, args: &[Value]) -> CompatResult {
    match method {
        "getLogs" => {
            let file_logs = read_mihomo_logs(app, 500)?;
            if file_logs.is_empty() {
                Ok(setting(app, "logs", json!([]))?)
            } else {
                Ok(json!(file_logs))
            }
        }
        "saveLogs" => {
            let file_path =
                save_mihomo_logs(app, args.first().unwrap_or(&Value::Array(Vec::new())))?;
            Ok(success(json!({
                "filePath": file_path.to_string_lossy()
            })))
        }
        "clearLogs" | "clear-logs" => {
            clear_mihomo_logs(app)?;
            Ok(success(json!({})))
        }
        "getTrafficToday" | "traffic-history:get-today" => Ok(success(
            json!({ "data": traffic_by_date(app, &today_key())? }),
        )),
        "getTrafficByDate" | "traffic-history:get-by-date" => {
            let date = arg_string(args, 0).unwrap_or_else(today_key);
            Ok(success(json!({ "data": traffic_by_date(app, &date)? })))
        }
        "getTrafficMonth" | "traffic-history:get-month" => {
            let prefix =
                arg_string(args, 0).unwrap_or_else(|| today_key().chars().take(7).collect());
            Ok(success(json!({ "data": traffic_rows(app, Some(prefix))? })))
        }
        "getTrafficYear" | "traffic-history:get-year" => {
            let prefix =
                arg_string(args, 0).unwrap_or_else(|| today_key().chars().take(4).collect());
            Ok(success(json!({ "data": traffic_rows(app, Some(prefix))? })))
        }
        _ => Err(format!("Unsupported telemetry method: {method}")),
    }
}
