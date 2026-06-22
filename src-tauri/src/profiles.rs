use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, State};

use crate::state::AppState;
use crate::storage::{
    app_data_dir, config_dir, db, decrypt_text_with_status, encrypt_text, set_setting, setting,
};

const FALLBACK_MINIMAL_CONFIG_FILE_NAME: &str = "flyclash-minimal.yaml";
const FALLBACK_MINIMAL_CONFIG_CONTENT: &str = r#"mixed-port: 7890
allow-lan: false
mode: rule
log-level: info
ipv6: false
find-process-mode: always
dns:
  enable: false
proxies: []
proxy-groups: []
rules:
  - MATCH,DIRECT
"#;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SubscriptionMeta {
    pub(crate) name: String,
    pub(crate) path: String,
    #[serde(default)]
    pub(crate) url: Option<String>,
    #[serde(default)]
    pub(crate) icon_url: Option<String>,
    #[serde(default)]
    pub(crate) used_traffic: Option<String>,
    #[serde(default)]
    pub(crate) remaining_traffic: Option<String>,
    #[serde(default)]
    pub(crate) expiry_date: Option<String>,
    #[serde(default)]
    pub(crate) last_updated: Option<String>,
    #[serde(default)]
    pub(crate) order: usize,
    #[serde(default)]
    pub(crate) overrides: Vec<String>,
    #[serde(default)]
    pub(crate) update_interval: u64,
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

fn sanitize_file_name(name: &str) -> String {
    let sanitized = name
        .chars()
        .map(|ch| match ch {
            '/' | '\\' | '?' | '%' | '*' | ':' | '|' | '"' | '<' | '>' => '_',
            _ => ch,
        })
        .collect::<String>();
    let trimmed = sanitized.trim();
    if trimmed.is_empty() {
        format!("subscription_{}", now_millis())
    } else {
        trimmed.to_string()
    }
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

pub(crate) fn read_subscriptions(app: &AppHandle) -> Result<Vec<SubscriptionMeta>, String> {
    let conn = db(app)?;
    let mut stmt = conn
        .prepare(
            r#"
            SELECT s.name, s.file_path, s.url, s.icon_url, s.updated_at, s.sort_order,
                   s.overrides, s.update_interval, si.used_traffic, si.total_traffic, si.expiry_timestamp
            FROM subscriptions s
            LEFT JOIN subscription_info si ON s.id = si.subscription_id
            ORDER BY s.sort_order ASC, s.created_at DESC
            "#,
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            let used: Option<u64> = row.get(8)?;
            let total: Option<u64> = row.get(9)?;
            let remaining = total
                .zip(used)
                .map(|(total, used)| total.saturating_sub(used));
            let overrides_raw: Option<String> = row.get(6)?;
            Ok(SubscriptionMeta {
                name: row.get(0)?,
                path: row.get(1)?,
                url: row.get(2)?,
                icon_url: row.get(3)?,
                used_traffic: used.map(format_traffic),
                remaining_traffic: remaining.map(format_traffic),
                expiry_date: row.get::<_, Option<u64>>(10)?.map(format_expiry_timestamp),
                last_updated: row.get::<_, i64>(4).ok().map(|value| value.to_string()),
                order: row.get::<_, i64>(5).unwrap_or(0) as usize,
                overrides: overrides_raw
                    .and_then(|raw| serde_json::from_str::<Vec<String>>(&raw).ok())
                    .unwrap_or_default(),
                update_interval: row.get::<_, i64>(7).unwrap_or(0) as u64,
            })
        })
        .map_err(|err| err.to_string())?;

    let mut items = Vec::new();
    for row in rows {
        items.push(row.map_err(|err| err.to_string())?);
    }
    Ok(items)
}

fn normalized_path_key(path: &Path) -> String {
    let value = path.to_string_lossy().replace('\\', "/");
    if cfg!(windows) {
        value.to_lowercase()
    } else {
        value
    }
}

fn path_matches_candidate(
    requested: &str,
    requested_canonical: Option<&Path>,
    candidate: &Path,
) -> bool {
    let requested_key = normalized_path_key(Path::new(requested));
    let candidate_key = normalized_path_key(candidate);
    if requested_key == candidate_key {
        return true;
    }

    match (requested_canonical, fs::canonicalize(candidate).ok()) {
        (Some(requested), Some(candidate)) => requested == candidate,
        _ => false,
    }
}

pub(crate) fn resolve_subscription_path(
    app: &AppHandle,
    file_path: &str,
) -> Result<Option<String>, String> {
    let requested = file_path.trim();
    if requested.is_empty() {
        return Ok(None);
    }

    let subscriptions = read_subscriptions(app)?;
    if let Some(subscription) = subscriptions.iter().find(|item| item.path == requested) {
        return Ok(Some(subscription.path.clone()));
    }

    let requested_canonical = fs::canonicalize(requested).ok();
    for subscription in subscriptions {
        if subscription.path.starts_with("flyclash-db://") {
            let exported = exported_config_path(app, &subscription.path)?;
            if path_matches_candidate(requested, requested_canonical.as_deref(), &exported) {
                return Ok(Some(subscription.path));
            }
            continue;
        }

        if path_matches_candidate(
            requested,
            requested_canonical.as_deref(),
            Path::new(&subscription.path),
        ) {
            return Ok(Some(subscription.path));
        }
    }

    Ok(None)
}

pub(crate) fn normalize_config_reference(
    app: &AppHandle,
    file_path: &str,
) -> Result<String, String> {
    let requested = file_path.trim();
    if requested.is_empty() {
        return Ok(String::new());
    }
    Ok(resolve_subscription_path(app, requested)?.unwrap_or_else(|| requested.to_string()))
}

pub(crate) fn save_last_config(app: &AppHandle, config_path: &str) -> Result<(), String> {
    let config_path = normalize_config_reference(app, config_path)?;
    set_setting(app, "active_config", Value::String(config_path))
}

pub(crate) fn emit_active_config_changed(app: &AppHandle, config_path: Option<&str>) {
    let payload = config_path
        .map(|path| Value::String(path.to_string()))
        .unwrap_or(Value::Null);
    let _ = app.emit("active-config-changed", payload);
}

pub(crate) fn sync_runtime_active_config_from_settings(
    app: &AppHandle,
    state: &State<'_, AppState>,
) -> Result<Option<String>, String> {
    let active_config = read_last_config(app)?;
    {
        let mut runtime = state.runtime.lock().expect("runtime mutex poisoned");
        runtime.core.set_active_config(active_config.clone());
    }
    emit_active_config_changed(app, active_config.as_deref());
    Ok(active_config)
}

pub(crate) fn read_last_config(app: &AppHandle) -> Result<Option<String>, String> {
    let active = setting(app, "active_config", Value::Null)?
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);
    active
        .map(|path| normalize_config_reference(app, &path).map(Some))
        .unwrap_or(Ok(None))
}

pub(crate) fn current_active_config(
    app: &AppHandle,
    state: &State<'_, AppState>,
) -> Option<String> {
    let active = state
        .runtime
        .lock()
        .expect("runtime mutex poisoned")
        .core
        .active_config_owned()
        .or_else(|| read_last_config(app).ok().flatten());
    active.and_then(|path| normalize_config_reference(app, &path).ok())
}

fn format_traffic(bytes: u64) -> String {
    let units = ["B", "KB", "MB", "GB", "TB"];
    let mut size = bytes as f64;
    let mut unit = 0usize;
    while size >= 1024.0 && unit < units.len() - 1 {
        size /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{} {}", bytes, units[unit])
    } else {
        format!("{:.2} {}", size, units[unit])
    }
}

fn parse_subscription_userinfo(
    header: Option<&str>,
) -> (Option<String>, Option<String>, Option<String>) {
    let Some(header) = header else {
        return (None, None, None);
    };

    let mut upload = 0u64;
    let mut download = 0u64;
    let mut total = 0u64;
    let mut expire = 0u64;

    for part in header.split(';') {
        let mut pair = part.trim().splitn(2, '=');
        let key = pair.next().unwrap_or_default().trim();
        let value = pair
            .next()
            .and_then(|value| value.trim().parse::<u64>().ok())
            .unwrap_or_default();
        match key {
            "upload" => upload = value,
            "download" => download = value,
            "total" => total = value,
            "expire" => expire = value,
            _ => {}
        }
    }

    let used = upload.saturating_add(download);
    let remaining = total.saturating_sub(used);
    (
        (used > 0).then(|| format_traffic(used)),
        (total > 0).then(|| format_traffic(remaining)),
        (expire > 0).then(|| expire.to_string()),
    )
}

fn header_u64(headers: &reqwest::header::HeaderMap, name: &str) -> Option<u64> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<u64>().ok())
}

pub(crate) fn subscription_info_from_headers(
    headers: &reqwest::header::HeaderMap,
) -> (Option<String>, Option<String>, Option<String>) {
    let (mut used, mut remaining, mut expire) = parse_subscription_userinfo(
        headers
            .get("subscription-userinfo")
            .and_then(|value| value.to_str().ok()),
    );

    let upload = header_u64(headers, "subscription-userinfo-upload");
    let download = header_u64(headers, "subscription-userinfo-download");
    let total = header_u64(headers, "subscription-userinfo-total");

    if upload.is_some() || download.is_some() {
        used = Some(format_traffic(
            upload.unwrap_or(0).saturating_add(download.unwrap_or(0)),
        ));
    }

    if let Some(total) = total {
        remaining = Some(format_traffic(total.saturating_sub(
            upload.unwrap_or(0).saturating_add(download.unwrap_or(0)),
        )));
    }

    if let Some(value) = header_u64(headers, "subscription-userinfo-expire") {
        expire = Some(value.to_string());
    }

    (used, remaining, expire)
}

fn days_from_civil(year: i32, month: u32, day: u32) -> Option<i64> {
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }

    let year = year - i32::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month_prime = month as i32 + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * month_prime + 2) / 5 + day as i32 - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;

    Some((era * 146_097 + day_of_era - 719_468) as i64)
}

fn civil_from_days(days: i64) -> (i32, u32, u32) {
    let days = days + 719_468;
    let era = if days >= 0 { days } else { days - 146_096 } / 146_097;
    let day_of_era = days - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era as i32 + era as i32 * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    let year = year + i32::from(month <= 2);

    (year, month as u32, day as u32)
}

pub(crate) fn parse_expiry_timestamp(value: &str) -> Option<u64> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }

    if let Ok(timestamp) = value.parse::<u64>() {
        return Some(timestamp);
    }

    let normalized = value.replace('/', "-");
    let mut parts = normalized.split('-');
    let year = parts.next()?.parse::<i32>().ok()?;
    let month = parts.next()?.parse::<u32>().ok()?;
    let day = parts.next()?.parse::<u32>().ok()?;
    if parts.next().is_some() {
        return None;
    }

    let days = days_from_civil(year, month, day)?;
    (days >= 0).then(|| days as u64 * 86_400)
}

fn format_expiry_timestamp(value: u64) -> String {
    let seconds = if value > 10_000_000_000 {
        value / 1000
    } else {
        value
    };
    let (year, month, day) = civil_from_days((seconds / 86_400) as i64);
    format!("{year:04}-{month:02}-{day:02}")
}

pub(crate) fn allowed_subscription_ua_key(value: &str) -> bool {
    matches!(
        value,
        "Clash" | "Mihomo" | "MihomoParty" | "Chrome" | "FlyClash"
    )
}

pub(crate) fn parse_traffic_string(value: &str) -> Option<u64> {
    let mut parts = value.split_whitespace();
    let number = parts.next()?.parse::<f64>().ok()?;
    let unit = parts.next().unwrap_or("B").to_uppercase();
    let multiplier = match unit.as_str() {
        "KB" | "KIB" => 1024f64,
        "MB" | "MIB" => 1024f64 * 1024f64,
        "GB" | "GIB" => 1024f64 * 1024f64 * 1024f64,
        "TB" | "TIB" => 1024f64 * 1024f64 * 1024f64 * 1024f64,
        _ => 1f64,
    };
    Some((number * multiplier) as u64)
}

pub(crate) fn config_content(app: &AppHandle, file_path: &str) -> Result<String, String> {
    let file_path = normalize_config_reference(app, file_path)?;
    if file_path.starts_with("flyclash-db://") {
        let conn = db(app)?;
        let encrypted = conn
            .query_row(
                "SELECT config_cipher FROM subscriptions WHERE file_path = ?1",
                params![&file_path],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|err| err.to_string())?
            .ok_or_else(|| "配置不存在".to_string())?;
        return match decrypt_text_with_status(app, &encrypted) {
            Ok((content, used_legacy_key)) => {
                if used_legacy_key {
                    if let Err(error) = save_config_content(app, &file_path, &content) {
                        eprintln!(
                            "[subscription-crypto] failed to migrate legacy config key: {error}"
                        );
                    }
                } else if let Err(error) = sync_exported_config(app, &file_path, &content) {
                    eprintln!("[subscription-export] failed to refresh exported config: {error}");
                }
                Ok(content)
            }
            Err(decrypt_error) => {
                let exported = exported_config_path(app, &file_path)?;
                if exported.is_file() {
                    match fs::read_to_string(&exported) {
                        Ok(content) if !content.trim().is_empty() => {
                            if let Err(error) = save_config_content(app, &file_path, &content) {
                                eprintln!(
                                    "[subscription-crypto] failed to recover exported config: {error}"
                                );
                            }
                            return Ok(content);
                        }
                        Ok(_) => {}
                        Err(error) => {
                            eprintln!(
                                "[subscription-export] failed to read exported config fallback: {error}"
                            );
                        }
                    }
                }
                Err(decrypt_error)
            }
        };
    }

    fs::read_to_string(&file_path).map_err(|err| err.to_string())
}

pub(crate) fn save_config_content(
    app: &AppHandle,
    file_path: &str,
    content: &str,
) -> Result<(), String> {
    let file_path = normalize_config_reference(app, file_path)?;
    if file_path.starts_with("flyclash-db://") {
        let encrypted = encrypt_text(app, content)?;
        let updated = db(app)?
            .execute(
                "UPDATE subscriptions SET config_cipher = ?1, updated_at = ?2 WHERE file_path = ?3",
                params![encrypted, now_millis() as i64, &file_path],
            )
            .map_err(|err| err.to_string())?;
        if updated == 0 {
            return Err("订阅不存在".to_string());
        }
        if let Err(error) = sync_exported_config(app, &file_path, content) {
            eprintln!("[subscription-export] failed to export updated config: {error}");
        }
        return Ok(());
    }

    fs::write(&file_path, content).map_err(|err| err.to_string())
}

pub(crate) fn ensure_minimal_mihomo_config(app: &AppHandle) -> Result<String, String> {
    let path = config_dir(app)?.join(FALLBACK_MINIMAL_CONFIG_FILE_NAME);
    fs::write(&path, FALLBACK_MINIMAL_CONFIG_CONTENT).map_err(|err| err.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

pub(crate) fn exported_config_path(app: &AppHandle, file_path: &str) -> Result<PathBuf, String> {
    let name = file_path
        .strip_prefix("flyclash-db://")
        .unwrap_or(file_path)
        .trim()
        .trim_end_matches(".yaml")
        .trim_end_matches(".yml");
    let file_name = format!("{}.yaml", sanitize_file_name(name));
    let dir = app_data_dir(app)?.join("exported-configs");
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    Ok(dir.join(file_name))
}

pub(crate) fn sync_exported_config(
    app: &AppHandle,
    file_path: &str,
    content: &str,
) -> Result<(), String> {
    if !file_path.starts_with("flyclash-db://") {
        return Ok(());
    }

    let path = exported_config_path(app, file_path)?;
    fs::write(path, content).map_err(|err| err.to_string())
}

pub(crate) fn rename_exported_config(
    app: &AppHandle,
    old_path: &str,
    new_path: &str,
) -> Result<(), String> {
    if old_path == new_path
        || !old_path.starts_with("flyclash-db://")
        || !new_path.starts_with("flyclash-db://")
    {
        return Ok(());
    }

    let old_export = exported_config_path(app, old_path)?;
    if !old_export.exists() {
        return Ok(());
    }

    let new_export = exported_config_path(app, new_path)?;
    if let Some(parent) = new_export.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    fs::rename(&old_export, &new_export)
        .or_else(|_| {
            fs::copy(&old_export, &new_export)?;
            fs::remove_file(&old_export)
        })
        .map_err(|err| err.to_string())?;
    Ok(())
}

pub(crate) fn materialize_config_for_open(
    app: &AppHandle,
    target: &str,
) -> Result<PathBuf, String> {
    let target = normalize_config_reference(app, target)?;
    if target.starts_with("flyclash-db://") {
        let content = config_content(app, &target)?;
        let path = exported_config_path(app, &target)?;
        fs::write(&path, content).map_err(|err| err.to_string())?;
        Ok(path)
    } else {
        Ok(PathBuf::from(target))
    }
}

pub(crate) fn config_display_name(file_path: &str) -> Option<String> {
    let trimmed = file_path.trim();
    if trimmed.is_empty() {
        return None;
    }

    let display_path = trimmed.strip_prefix("flyclash-db://").unwrap_or(trimmed);
    Path::new(display_path)
        .file_name()
        .and_then(|name| name.to_str())
        .or_else(|| display_path.rsplit(['/', '\\']).next())
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(ToString::to_string)
}

pub(crate) fn save_subscription(
    app: &AppHandle,
    url: Option<String>,
    content: String,
    custom_name: Option<String>,
    info: Option<Value>,
) -> Result<Value, String> {
    if content.trim().is_empty() {
        return Ok(json!({
            "success": false,
            "error": "订阅内容为空，无法保存"
        }));
    }

    let name = custom_name
        .as_deref()
        .filter(|name| !name.trim().is_empty())
        .map(|name| name.trim().to_string())
        .or_else(|| {
            url.as_deref()
                .and_then(|url| reqwest::Url::parse(url).ok())
                .and_then(|url| url.host_str().map(ToString::to_string))
        })
        .unwrap_or_else(|| format!("subscription_{}", now_millis()));
    let info = info.unwrap_or(Value::Null);
    let used_traffic = info.get("usedTraffic").and_then(Value::as_str);
    let remaining_traffic = info.get("remainingTraffic").and_then(Value::as_str);
    let used_bytes = used_traffic.and_then(parse_traffic_string);
    let remaining_bytes = remaining_traffic.and_then(parse_traffic_string);
    let total_bytes = match (used_bytes, remaining_bytes) {
        (Some(used), Some(remaining)) => Some(used + remaining),
        (Some(used), None) => Some(used),
        (None, Some(remaining)) => Some(remaining),
        _ => None,
    };
    let expiry = info
        .get("expiryDate")
        .and_then(Value::as_str)
        .and_then(parse_expiry_timestamp);
    let encrypted = encrypt_text(app, &content)?;
    let conn = db(app)?;
    let now = now_millis() as i64;
    let order = conn
        .query_row("SELECT COUNT(*) FROM subscriptions", [], |row| {
            row.get::<_, i64>(0)
        })
        .unwrap_or(0);
    let base_name = sanitize_file_name(&name);
    let mut logical_path = format!("flyclash-db://{base_name}.yaml");
    let mut suffix = 2usize;
    while conn
        .query_row(
            "SELECT 1 FROM subscriptions WHERE file_path = ?1",
            params![logical_path],
            |_| Ok(()),
        )
        .optional()
        .map_err(|err| err.to_string())?
        .is_some()
    {
        logical_path = format!("flyclash-db://{base_name}-{suffix}.yaml");
        suffix += 1;
    }

    conn.execute(
        r#"
        INSERT INTO subscriptions (name, file_path, url, config_cipher, created_at, updated_at, sort_order)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
        "#,
        params![name, logical_path, url, encrypted, now, now, order],
    )
    .map_err(|err| err.to_string())?;

    let sub_id = conn
        .query_row(
            "SELECT id FROM subscriptions WHERE file_path = ?1",
            params![logical_path],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|err| err.to_string())?;
    conn.execute(
        "DELETE FROM subscription_info WHERE subscription_id = ?1",
        params![sub_id],
    )
    .map_err(|err| err.to_string())?;
    if used_bytes.is_some() || total_bytes.is_some() || expiry.is_some() {
        conn.execute(
            "INSERT INTO subscription_info (subscription_id, used_traffic, total_traffic, expiry_timestamp) VALUES (?1, ?2, ?3, ?4)",
            params![sub_id, used_bytes.map(|v| v as i64), total_bytes.map(|v| v as i64), expiry.map(|v| v as i64)],
        )
        .map_err(|err| err.to_string())?;
    }

    if let Err(error) = sync_exported_config(app, &logical_path, &content) {
        eprintln!("[subscription-export] failed to export saved config: {error}");
    }

    Ok(json!({ "success": true, "filePath": logical_path }))
}

pub(crate) fn save_subscription_info(
    app: &AppHandle,
    file_path: &str,
    info: &Value,
) -> Result<(), String> {
    let file_path =
        resolve_subscription_path(app, file_path)?.unwrap_or_else(|| file_path.trim().to_string());
    let used_traffic = info.get("usedTraffic").and_then(Value::as_str);
    let remaining_traffic = info.get("remainingTraffic").and_then(Value::as_str);
    let used_bytes = used_traffic.and_then(parse_traffic_string);
    let remaining_bytes = remaining_traffic.and_then(parse_traffic_string);
    let total_bytes = match (used_bytes, remaining_bytes) {
        (Some(used), Some(remaining)) => Some(used + remaining),
        (Some(used), None) => Some(used),
        (None, Some(remaining)) => Some(remaining),
        _ => None,
    };
    let expiry = info
        .get("expiryDate")
        .and_then(Value::as_str)
        .and_then(parse_expiry_timestamp);

    let conn = db(app)?;
    let sub_id = conn
        .query_row(
            "SELECT id FROM subscriptions WHERE file_path = ?1",
            params![&file_path],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|err| err.to_string())?;
    let Some(sub_id) = sub_id else {
        return Ok(());
    };

    conn.execute(
        "DELETE FROM subscription_info WHERE subscription_id = ?1",
        params![sub_id],
    )
    .map_err(|err| err.to_string())?;

    if used_bytes.is_some() || total_bytes.is_some() || expiry.is_some() {
        conn.execute(
            "INSERT INTO subscription_info (subscription_id, used_traffic, total_traffic, expiry_timestamp) VALUES (?1, ?2, ?3, ?4)",
            params![
                sub_id,
                used_bytes.map(|value| value as i64),
                total_bytes.map(|value| value as i64),
                expiry.map(|value| value as i64)
            ],
        )
        .map_err(|err| err.to_string())?;
    }

    Ok(())
}

pub(crate) fn delete_subscription(app: &AppHandle, file_path: &str) -> Result<Value, String> {
    let Some(file_path) = resolve_subscription_path(app, file_path)? else {
        return Ok(json!({ "success": false, "error": "订阅不存在" }));
    };
    let conn = db(app)?;
    let changed = conn
        .execute(
            "DELETE FROM subscriptions WHERE file_path = ?1",
            params![&file_path],
        )
        .map_err(|err| err.to_string())?;
    if changed == 0 {
        return Ok(json!({ "success": false, "error": "订阅不存在" }));
    }
    Ok(success(json!({ "deleted": true, "filePath": file_path })))
}

pub(crate) fn edit_subscription(app: &AppHandle, params: Value) -> Result<Value, String> {
    let old_path_raw = params
        .get("oldPath")
        .and_then(Value::as_str)
        .ok_or_else(|| "missing oldPath".to_string())?;
    let Some(old_path) = resolve_subscription_path(app, old_path_raw)? else {
        return Ok(json!({ "success": false, "error": "订阅不存在" }));
    };
    let new_name = params
        .get("newName")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("subscription");
    let conn = db(app)?;
    let exists = conn
        .query_row(
            "SELECT 1 FROM subscriptions WHERE file_path = ?1",
            params![&old_path],
            |_| Ok(()),
        )
        .optional()
        .map_err(|err| err.to_string())?
        .is_some();
    if !exists {
        return Ok(json!({ "success": false, "error": "订阅不存在" }));
    }

    let candidate_path = format!("flyclash-db://{}.yaml", sanitize_file_name(new_name));
    let new_path = if candidate_path == old_path {
        old_path.clone()
    } else {
        let occupied = conn
            .query_row(
                "SELECT 1 FROM subscriptions WHERE file_path = ?1",
                params![&candidate_path],
                |_| Ok(()),
            )
            .optional()
            .map_err(|err| err.to_string())?
            .is_some();
        if occupied {
            return Ok(json!({ "success": false, "error": "该配置名称已存在" }));
        }
        candidate_path
    };

    let changed = conn
        .execute(
        "UPDATE subscriptions SET name = ?1, file_path = ?2, url = ?3, icon_url = ?4, updated_at = ?5 WHERE file_path = ?6",
        params![&new_name, &new_path, params.get("newUrl").and_then(Value::as_str), params.get("iconUrl").and_then(Value::as_str), now_millis() as i64, &old_path],
    )
        .map_err(|err| err.to_string())?;
    if changed == 0 {
        return Ok(json!({ "success": false, "error": "订阅未更新" }));
    }
    if let Err(error) = rename_exported_config(app, &old_path, &new_path) {
        eprintln!("[subscription-export] failed to rename exported config: {error}");
    }
    Ok(success(json!({ "oldPath": old_path, "newPath": new_path })))
}

pub(crate) fn update_subscription(
    app: &AppHandle,
    file_path: &str,
    config_data: &str,
    sub_url: Option<String>,
    info: Option<Value>,
) -> Result<Value, String> {
    if file_path.trim().is_empty() {
        return Ok(Value::Bool(false));
    }
    if config_data.trim().is_empty() {
        return Ok(Value::Bool(false));
    }
    let Some(file_path) = resolve_subscription_path(app, file_path)? else {
        return Ok(Value::Bool(false));
    };

    let exists = db(app)?
        .query_row(
            "SELECT id FROM subscriptions WHERE file_path = ?1",
            params![&file_path],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|err| err.to_string())?
        .is_some();
    if !exists {
        return Ok(Value::Bool(false));
    }

    save_config_content(app, &file_path, config_data)?;
    let url_value = sub_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    db(app)?
        .execute(
            "UPDATE subscriptions SET url = ?1, updated_at = ?2 WHERE file_path = ?3",
            params![url_value, now_millis() as i64, &file_path],
        )
        .map_err(|err| err.to_string())?;

    if let Some(info) = info {
        save_subscription_info(app, &file_path, &info)?;
    }

    Ok(Value::Bool(true))
}
