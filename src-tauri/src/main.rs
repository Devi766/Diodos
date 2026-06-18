#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose, Engine as _};
use regex::Regex;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::{
    fs, io,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

type CompatResult = Result<Value, String>;

#[derive(Default)]
struct RuntimeState {
    mihomo: Option<Child>,
    active_config: Option<String>,
    last_traffic: Option<TrafficSnapshot>,
}

#[derive(Default)]
struct AppState {
    runtime: Mutex<RuntimeState>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubscriptionMeta {
    name: String,
    path: String,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    icon_url: Option<String>,
    #[serde(default)]
    used_traffic: Option<String>,
    #[serde(default)]
    remaining_traffic: Option<String>,
    #[serde(default)]
    expiry_date: Option<String>,
    #[serde(default)]
    last_updated: Option<String>,
    #[serde(default)]
    order: usize,
    #[serde(default)]
    overrides: Vec<String>,
    #[serde(default)]
    update_interval: u64,
}

#[derive(Debug, Clone)]
struct TrafficSnapshot {
    up: u64,
    down: u64,
    timestamp: u128,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompatRequest {
    method: String,
    #[serde(default)]
    args: Vec<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FetchOptions {
    #[serde(default = "default_method")]
    method: String,
    #[serde(default)]
    headers: Map<String, Value>,
    #[serde(default)]
    body: Option<Value>,
    #[serde(default)]
    timeout: Option<u64>,
    #[serde(default)]
    url: Option<String>,
}

fn default_method() -> String {
    "GET".to_string()
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

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|err| err.to_string())?;
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    Ok(dir)
}

fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app_data_dir(app)?.join("config");
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    Ok(dir)
}

fn mihomo_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app_data_dir(app)?.join("mihomo");
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    Ok(dir)
}

fn database_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(config_dir(app)?.join("flyclash.db"))
}

fn encryption_key_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join(".runtime-key"))
}

fn load_or_create_key(app: &AppHandle) -> Result<[u8; 32], String> {
    let key_path = encryption_key_path(app)?;
    if key_path.exists() {
        let bytes = fs::read(key_path).map_err(|err| err.to_string())?;
        let digest = Sha256::digest(&bytes);
        let mut key = [0u8; 32];
        key.copy_from_slice(&digest);
        return Ok(key);
    }

    let mut seed = [0u8; 32];
    getrandom::getrandom(&mut seed).map_err(|err| err.to_string())?;
    fs::write(key_path, seed).map_err(|err| err.to_string())?;
    Ok(seed)
}

fn encrypt_text(app: &AppHandle, plain: &str) -> Result<String, String> {
    let key = load_or_create_key(app)?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|err| err.to_string())?;
    let mut nonce_bytes = [0u8; 12];
    getrandom::getrandom(&mut nonce_bytes).map_err(|err| err.to_string())?;
    let cipher_text = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), plain.as_bytes())
        .map_err(|err| err.to_string())?;
    let mut payload = nonce_bytes.to_vec();
    payload.extend(cipher_text);
    Ok(general_purpose::STANDARD.encode(payload))
}

fn decrypt_text(app: &AppHandle, encoded: &str) -> Result<String, String> {
    let payload = general_purpose::STANDARD
        .decode(encoded)
        .map_err(|err| err.to_string())?;
    if payload.len() < 13 {
        return Err("encrypted payload is too short".to_string());
    }
    let (nonce, cipher_text) = payload.split_at(12);
    let key = load_or_create_key(app)?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|err| err.to_string())?;
    let plain = cipher
        .decrypt(Nonce::from_slice(nonce), cipher_text)
        .map_err(|err| err.to_string())?;
    String::from_utf8(plain).map_err(|err| err.to_string())
}

fn db(app: &AppHandle) -> Result<Connection, String> {
    let conn = Connection::open(database_path(app)?).map_err(|err| err.to_string())?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|err| err.to_string())?;
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS subscriptions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          file_path TEXT NOT NULL UNIQUE,
          url TEXT,
          config_cipher TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          update_interval INTEGER DEFAULT 0,
          overrides TEXT DEFAULT '[]',
          icon_url TEXT DEFAULT '',
          sort_order INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS subscription_info (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          subscription_id INTEGER NOT NULL,
          used_traffic INTEGER,
          total_traffic INTEGER,
          expiry_timestamp INTEGER,
          FOREIGN KEY (subscription_id) REFERENCES subscriptions(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          type TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS traffic_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          date TEXT NOT NULL UNIQUE,
          upload INTEGER NOT NULL DEFAULT 0,
          download INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS overrides (
          id TEXT PRIMARY KEY,
          item_json TEXT NOT NULL,
          content_cipher TEXT,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_subscriptions_file_path ON subscriptions(file_path);
        CREATE INDEX IF NOT EXISTS idx_subscription_info_subscription_id ON subscription_info(subscription_id);
        CREATE INDEX IF NOT EXISTS idx_traffic_history_date ON traffic_history(date);
        CREATE INDEX IF NOT EXISTS idx_overrides_sort_order ON overrides(sort_order);
        "#,
    )
    .map_err(|err| err.to_string())?;

    for ddl in [
        "ALTER TABLE subscriptions ADD COLUMN config_cipher TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE subscriptions ADD COLUMN overrides TEXT DEFAULT '[]'",
        "ALTER TABLE subscriptions ADD COLUMN update_interval INTEGER DEFAULT 0",
        "ALTER TABLE subscriptions ADD COLUMN icon_url TEXT DEFAULT ''",
        "ALTER TABLE subscriptions ADD COLUMN sort_order INTEGER DEFAULT 0",
    ] {
        let _ = conn.execute(ddl, []);
    }

    Ok(conn)
}

fn read_settings(app: &AppHandle) -> Result<Map<String, Value>, String> {
    let conn = db(app)?;
    let mut stmt = conn
        .prepare("SELECT key, value, type FROM settings")
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            let key: String = row.get(0)?;
            let raw: String = row.get(1)?;
            let kind: String = row.get(2)?;
            Ok((key, raw, kind))
        })
        .map_err(|err| err.to_string())?;

    let mut settings = Map::new();
    for row in rows {
        let (key, raw, kind) = row.map_err(|err| err.to_string())?;
        let value = match kind.as_str() {
            "number" => raw
                .parse::<f64>()
                .ok()
                .and_then(serde_json::Number::from_f64)
                .map(Value::Number)
                .unwrap_or(Value::Null),
            "boolean" => Value::Bool(raw == "true"),
            "json" => serde_json::from_str::<Value>(&raw).unwrap_or(Value::Null),
            _ => Value::String(raw),
        };
        settings.insert(key, value);
    }
    Ok(settings)
}

fn write_settings(app: &AppHandle, settings: &Map<String, Value>) -> Result<(), String> {
    let conn = db(app)?;
    for (key, value) in settings {
        let (raw, kind) = serialize_setting_value(value);
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value, type) VALUES (?1, ?2, ?3)",
            params![key, raw, kind],
        )
        .map_err(|err| err.to_string())?;
    }
    Ok(())
}

fn serialize_setting_value(value: &Value) -> (String, &'static str) {
    match value {
        Value::String(value) => (value.clone(), "string"),
        Value::Number(value) => (value.to_string(), "number"),
        Value::Bool(value) => (value.to_string(), "boolean"),
        other => (other.to_string(), "json"),
    }
}

fn setting(app: &AppHandle, key: &str, fallback: Value) -> Result<Value, String> {
    let settings = read_settings(app)?;
    Ok(settings.get(key).cloned().unwrap_or(fallback))
}

fn set_setting(app: &AppHandle, key: &str, value: Value) -> Result<(), String> {
    let mut settings = read_settings(app)?;
    settings.insert(key.to_string(), value);
    write_settings(app, &settings)
}

fn read_subscriptions(app: &AppHandle) -> Result<Vec<SubscriptionMeta>, String> {
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
                expiry_date: row
                    .get::<_, Option<u64>>(10)?
                    .map(|value| value.to_string()),
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

fn write_subscriptions(app: &AppHandle, items: &[SubscriptionMeta]) -> Result<(), String> {
    let conn = db(app)?;
    for item in items {
        conn.execute(
            "UPDATE subscriptions SET sort_order = ?1, overrides = ?2, update_interval = ?3 WHERE file_path = ?4",
            params![
                item.order as i64,
                serde_json::to_string(&item.overrides).map_err(|err| err.to_string())?,
                item.update_interval as i64,
                item.path
            ],
        )
        .map_err(|err| err.to_string())?;
    }
    Ok(())
}

fn save_last_config(app: &AppHandle, config_path: &str) -> Result<(), String> {
    set_setting(app, "active_config", Value::String(config_path.to_string()))
}

fn read_last_config(app: &AppHandle) -> Result<Option<String>, String> {
    Ok(setting(app, "active_config", Value::Null)?
        .as_str()
        .map(ToString::to_string))
}

fn arg_string(args: &[Value], index: usize) -> Option<String> {
    args.get(index)
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

fn arg_bool(args: &[Value], index: usize) -> Option<bool> {
    args.get(index).and_then(Value::as_bool)
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

fn unsupported(method: &str) -> Value {
    json!({
        "success": false,
        "error": format!("{method} is not implemented in the Tauri runtime yet")
    })
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

async fn fetch_subscription(app: &AppHandle, url: &str) -> CompatResult {
    let mut valid_url = url.trim().to_string();
    if !valid_url.starts_with("http://") && !valid_url.starts_with("https://") {
        valid_url = format!("https://{valid_url}");
    }

    let ua = setting(app, "subscription-ua", json!("FlyClash"))?
        .as_str()
        .unwrap_or("FlyClash")
        .to_string();
    let response = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .danger_accept_invalid_certs(true)
        .build()
        .map_err(|err| err.to_string())?
        .get(valid_url)
        .header("User-Agent", ua)
        .send()
        .await
        .map_err(|err| err.to_string())?;

    if !response.status().is_success() {
        return Ok(json!({
            "success": false,
            "error": format!("获取订阅失败: {}", response.status())
        }));
    }

    let (used, remaining, expire) = parse_subscription_userinfo(
        response
            .headers()
            .get("subscription-userinfo")
            .and_then(|value| value.to_str().ok()),
    );
    let content = response.text().await.map_err(|err| err.to_string())?;

    Ok(success(json!({
        "content": content,
        "subscriptionInfo": {
            "usedTraffic": used,
            "remainingTraffic": remaining,
            "expiryDate": expire
        }
    })))
}

fn save_subscription(
    app: &AppHandle,
    url: Option<String>,
    content: String,
    custom_name: Option<String>,
    info: Option<Value>,
) -> CompatResult {
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
    let logical_path = format!("flyclash-db://{}.yaml", sanitize_file_name(&name));
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
        .and_then(|value| value.parse::<u64>().ok());
    let encrypted = encrypt_text(app, &content)?;
    let conn = db(app)?;
    let now = now_millis() as i64;
    let order = conn
        .query_row("SELECT COUNT(*) FROM subscriptions", [], |row| {
            row.get::<_, i64>(0)
        })
        .unwrap_or(0);

    conn.execute(
        r#"
        INSERT INTO subscriptions (name, file_path, url, config_cipher, created_at, updated_at, sort_order)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
        ON CONFLICT(file_path) DO UPDATE SET
          name = excluded.name,
          url = excluded.url,
          config_cipher = excluded.config_cipher,
          updated_at = excluded.updated_at
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

    Ok(json!({ "success": true, "filePath": logical_path }))
}

fn delete_subscription(app: &AppHandle, file_path: &str) -> CompatResult {
    let conn = db(app)?;
    conn.execute(
        "DELETE FROM subscriptions WHERE file_path = ?1",
        params![file_path],
    )
    .map_err(|err| err.to_string())?;
    Ok(Value::Bool(true))
}

fn edit_subscription(app: &AppHandle, params: Value) -> CompatResult {
    let old_path = params
        .get("oldPath")
        .and_then(Value::as_str)
        .ok_or_else(|| "missing oldPath".to_string())?;
    let new_name = params
        .get("newName")
        .and_then(Value::as_str)
        .unwrap_or("subscription");
    let new_url = params
        .get("newUrl")
        .and_then(Value::as_str)
        .map(ToString::to_string);
    let icon_url = params
        .get("iconUrl")
        .and_then(Value::as_str)
        .map(ToString::to_string);
    let mut items = read_subscriptions(app)?;
    let mut new_path = old_path.to_string();
    if let Some(item) = items.iter_mut().find(|item| item.path == old_path) {
        item.name = new_name.to_string();
        item.url = new_url;
        item.icon_url = icon_url;
        let candidate_string = format!("flyclash-db://{}.yaml", sanitize_file_name(new_name));
        if candidate_string != old_path {
            item.path = candidate_string.clone();
            new_path = candidate_string;
        }
    }

    let conn = db(app)?;
    conn.execute(
        "UPDATE subscriptions SET name = ?1, file_path = ?2, url = ?3, icon_url = ?4, updated_at = ?5 WHERE file_path = ?6",
        params![new_name, new_path, params.get("newUrl").and_then(Value::as_str), params.get("iconUrl").and_then(Value::as_str), now_millis() as i64, old_path],
    )
    .map_err(|err| err.to_string())?;
    Ok(success(json!({ "newPath": new_path })))
}

fn parse_traffic_string(value: &str) -> Option<u64> {
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

fn config_content(app: &AppHandle, file_path: &str) -> Result<String, String> {
    if file_path.starts_with("flyclash-db://") {
        let conn = db(app)?;
        let encrypted = conn
            .query_row(
                "SELECT config_cipher FROM subscriptions WHERE file_path = ?1",
                params![file_path],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|err| err.to_string())?
            .ok_or_else(|| "配置不存在".to_string())?;
        return decrypt_text(app, &encrypted);
    }

    fs::read_to_string(file_path).map_err(|err| err.to_string())
}

fn save_config_content(app: &AppHandle, file_path: &str, content: &str) -> Result<(), String> {
    if file_path.starts_with("flyclash-db://") {
        let encrypted = encrypt_text(app, content)?;
        db(app)?
            .execute(
                "UPDATE subscriptions SET config_cipher = ?1, updated_at = ?2 WHERE file_path = ?3",
                params![encrypted, now_millis() as i64, file_path],
            )
            .map_err(|err| err.to_string())?;
        return Ok(());
    }

    fs::write(file_path, content).map_err(|err| err.to_string())
}

fn config_yaml(app: &AppHandle, file_path: &str) -> Result<serde_yaml::Value, String> {
    let content = config_content(app, file_path)?;
    serde_yaml::from_str::<serde_yaml::Value>(&content).map_err(|err| err.to_string())
}

fn save_config_yaml(
    app: &AppHandle,
    file_path: &str,
    yaml: &serde_yaml::Value,
) -> Result<(), String> {
    let content = serde_yaml::to_string(yaml).map_err(|err| err.to_string())?;
    save_config_content(app, file_path, &content)
}

fn yaml_key(key: &str) -> serde_yaml::Value {
    serde_yaml::Value::String(key.to_string())
}

fn yaml_section(app: &AppHandle, file_path: Option<String>, key: &str) -> CompatResult {
    if let Some(file_path) = file_path {
        let yaml = config_yaml(app, &file_path)?;
        let value = yaml.get(key).cloned().unwrap_or(serde_yaml::Value::Null);
        return Ok(success(
            json!({ "config": serde_json::to_value(value).unwrap_or(Value::Null) }),
        ));
    }

    Ok(success(json!({
        "config": setting(app, key, json!({}))?
    })))
}

fn yaml_save_section(
    app: &AppHandle,
    file_path: Option<String>,
    key: &str,
    value: Value,
) -> CompatResult {
    if let Some(file_path) = file_path {
        let mut yaml = config_yaml(app, &file_path)?;
        if !matches!(yaml, serde_yaml::Value::Mapping(_)) {
            yaml = serde_yaml::Value::Mapping(Default::default());
        }
        if let serde_yaml::Value::Mapping(map) = &mut yaml {
            let section = serde_yaml::to_value(value).map_err(|err| err.to_string())?;
            map.insert(yaml_key(key), section);
        }
        save_config_yaml(app, &file_path, &yaml)?;
        return Ok(success(json!({})));
    }

    set_setting(app, key, value)?;
    Ok(success(json!({})))
}

fn yaml_root_pick(app: &AppHandle, file_path: Option<String>, keys: &[&str]) -> CompatResult {
    let Some(file_path) = file_path else {
        return Ok(success(json!({ "config": {} })));
    };
    let yaml = config_yaml(app, &file_path)?;
    let mut output = Map::new();
    for key in keys {
        if let Some(value) = yaml.get(*key) {
            output.insert(
                (*key).to_string(),
                serde_json::to_value(value).unwrap_or(Value::Null),
            );
        }
    }
    Ok(success(json!({ "config": output })))
}

fn yaml_root_merge(app: &AppHandle, file_path: Option<String>, value: Value) -> CompatResult {
    let Some(file_path) = file_path else {
        set_setting(app, "kernel", value)?;
        return Ok(success(json!({})));
    };
    let mut yaml = config_yaml(app, &file_path)?;
    if !matches!(yaml, serde_yaml::Value::Mapping(_)) {
        yaml = serde_yaml::Value::Mapping(Default::default());
    }
    if let (serde_yaml::Value::Mapping(map), Value::Object(object)) = (&mut yaml, value) {
        for (key, value) in object {
            map.insert(
                yaml_key(&key),
                serde_yaml::to_value(value).map_err(|err| err.to_string())?,
            );
        }
    }
    save_config_yaml(app, &file_path, &yaml)?;
    Ok(success(json!({})))
}

fn find_mihomo_executable(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(custom) = setting(app, "kernelPath", Value::Null)?
        .as_str()
        .filter(|path| Path::new(path).exists())
    {
        return Ok(PathBuf::from(custom));
    }

    let exe_name = if cfg!(windows) {
        "mihomo.exe"
    } else {
        "mihomo"
    };
    let mut candidates = Vec::new();
    candidates.push(app_data_dir(app)?.join("cores").join(exe_name));
    candidates.push(PathBuf::from("cores").join(exe_name));
    candidates.push(PathBuf::from("extra").join("sidecar").join(exe_name));
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("sidecar").join(exe_name));
        candidates.push(resource_dir.join("cores").join(exe_name));
    }

    candidates
        .into_iter()
        .find(|path| path.exists())
        .ok_or_else(|| {
            "未找到 Mihomo 内核，请将 mihomo.exe 放到 extra/sidecar 或应用数据 cores 目录"
                .to_string()
        })
}

fn cores_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app_data_dir(app)?.join("cores");
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    Ok(dir)
}

fn core_file_name(core_type: &str, specific_version: Option<&str>) -> String {
    let ext = if cfg!(windows) { ".exe" } else { "" };
    match (core_type, specific_version) {
        ("mihomo-alpha", _) => format!("mihomo-alpha{ext}"),
        ("mihomo-smart", _) => format!("mihomo-smart{ext}"),
        ("mihomo-specific", Some(version)) => format!("mihomo-{version}{ext}"),
        _ => format!("mihomo{ext}"),
    }
}

fn core_path(
    app: &AppHandle,
    core_type: Option<&str>,
    specific_version: Option<&str>,
) -> Result<PathBuf, String> {
    if core_type.is_none() {
        if let Some(custom) = setting(app, "core_custom_path", Value::Null)?
            .as_str()
            .filter(|path| Path::new(path).exists())
        {
            return Ok(PathBuf::from(custom));
        }
    }
    let core_type = core_type
        .map(ToString::to_string)
        .or_else(|| {
            setting(app, "core_type", json!("mihomo"))
                .ok()
                .and_then(|value| value.as_str().map(ToString::to_string))
        })
        .unwrap_or_else(|| "mihomo".to_string());
    Ok(cores_dir(app)?.join(core_file_name(&core_type, specific_version)))
}

fn core_current_config(app: &AppHandle) -> CompatResult {
    let core_type = setting(app, "core_type", json!("mihomo"))?;
    let specific_version = setting(app, "core_specific_version", Value::Null)?;
    let custom_path = setting(app, "core_custom_path", Value::Null)?;
    let path = core_path(app, core_type.as_str(), specific_version.as_str())?;
    Ok(success(json!({
        "config": {
            "coreType": core_type,
            "specificVersion": specific_version,
            "customPath": custom_path
        },
        "corePath": path.to_string_lossy(),
        "exists": path.exists()
    })))
}

fn core_installed(app: &AppHandle) -> CompatResult {
    let mut cores = Vec::new();
    for dir in [cores_dir(app)?, PathBuf::from("extra").join("sidecar")] {
        if !dir.exists() {
            continue;
        }
        for entry in fs::read_dir(dir).map_err(|err| err.to_string())? {
            let entry = entry.map_err(|err| err.to_string())?;
            let path = entry.path();
            let name = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("");
            if name.to_lowercase().contains("mihomo") {
                cores.push(json!({
                    "name": name,
                    "path": path.to_string_lossy(),
                    "coreType": if name.contains("alpha") { "mihomo-alpha" } else { "mihomo" },
                    "exists": true
                }));
            }
        }
    }
    Ok(success(json!({ "cores": cores })))
}

fn core_repo(core_type: &str) -> (&'static str, &'static str, Option<&'static str>) {
    match core_type {
        "mihomo-smart" => ("vernesong", "mihomo", Some("Prerelease-Alpha")),
        "mihomo-alpha" => ("MetaCubeX", "mihomo", Some("Prerelease-Alpha")),
        _ => ("MetaCubeX", "mihomo", None),
    }
}

async fn github_json(url: &str) -> Result<Value, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|err| err.to_string())?
        .get(url)
        .header("User-Agent", "FlyClash-Tauri")
        .send()
        .await
        .map_err(|err| err.to_string())?
        .error_for_status()
        .map_err(|err| err.to_string())?
        .json::<Value>()
        .await
        .map_err(|err| err.to_string())
}

async fn latest_release(core_type: &str) -> Result<Value, String> {
    let (owner, repo, tag) = core_repo(core_type);
    if let Some(tag) = tag {
        let url = format!("https://api.github.com/repos/{owner}/{repo}/releases/tags/{tag}");
        return github_json(&url).await;
    }
    let url = format!("https://api.github.com/repos/{owner}/{repo}/releases/latest");
    github_json(&url).await
}

async fn release_versions(core_type: &str, limit: usize) -> Result<Vec<Value>, String> {
    let (owner, repo, _) = core_repo(core_type);
    let url = format!("https://api.github.com/repos/{owner}/{repo}/releases?per_page={limit}");
    let releases = github_json(&url).await?;
    Ok(releases
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|release| {
            json!({
                "version": release.get("tag_name").cloned().unwrap_or(Value::Null),
                "name": release.get("name").cloned().unwrap_or(Value::Null),
                "publishedAt": release.get("published_at").cloned().unwrap_or(Value::Null),
                "prerelease": release.get("prerelease").cloned().unwrap_or(Value::Bool(false))
            })
        })
        .collect())
}

fn wanted_asset_name() -> (&'static str, &'static str) {
    let os = if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    };
    let arch = if cfg!(target_arch = "x86_64") {
        "amd64"
    } else if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "386"
    };
    (os, arch)
}

fn select_release_asset(release: &Value) -> Option<Value> {
    let (os, arch) = wanted_asset_name();
    release
        .get("assets")?
        .as_array()?
        .iter()
        .find(|asset| {
            let name = asset
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_lowercase();
            name.contains(os)
                && name.contains(arch)
                && (name.ends_with(".zip") || name.ends_with(".gz"))
        })
        .cloned()
}

async fn download_to(url: &str, path: &Path) -> Result<(), String> {
    let bytes = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|err| err.to_string())?
        .get(url)
        .header("User-Agent", "FlyClash-Tauri")
        .send()
        .await
        .map_err(|err| err.to_string())?
        .error_for_status()
        .map_err(|err| err.to_string())?
        .bytes()
        .await
        .map_err(|err| err.to_string())?;
    fs::write(path, bytes).map_err(|err| err.to_string())
}

fn extract_core_archive(archive: &Path, dest: &Path) -> Result<(), String> {
    let file = fs::File::open(archive).map_err(|err| err.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|err| err.to_string())?;
    for index in 0..zip.len() {
        let mut entry = zip.by_index(index).map_err(|err| err.to_string())?;
        let name = entry.name().to_lowercase();
        if name.contains("mihomo") && !name.ends_with('/') {
            let mut out = fs::File::create(dest).map_err(|err| err.to_string())?;
            io::copy(&mut entry, &mut out).map_err(|err| err.to_string())?;
            return Ok(());
        }
    }
    Err("下载包中未找到 mihomo 可执行文件".to_string())
}

async fn download_core(app: &AppHandle, core_type: &str, version: Option<String>) -> CompatResult {
    let release = if let Some(version) = version.clone() {
        let (owner, repo, _) = core_repo(core_type);
        github_json(&format!(
            "https://api.github.com/repos/{owner}/{repo}/releases/tags/{version}"
        ))
        .await?
    } else {
        latest_release(core_type).await?
    };
    let tag = release
        .get("tag_name")
        .and_then(Value::as_str)
        .unwrap_or("latest")
        .to_string();
    let asset = select_release_asset(&release)
        .ok_or_else(|| "未找到当前平台可用的 mihomo 下载资源".to_string())?;
    let download_url = asset
        .get("browser_download_url")
        .and_then(Value::as_str)
        .ok_or_else(|| "release asset 缺少下载链接".to_string())?;
    let archive_name = asset
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("mihomo.zip");
    if !archive_name.to_lowercase().ends_with(".zip") {
        return Ok(json!({
            "success": false,
            "error": "当前 Tauri 下载器暂只支持 zip 内核包"
        }));
    }
    let tmp = cores_dir(app)?.join(format!("{archive_name}.tmp"));
    download_to(download_url, &tmp).await?;
    let dest = core_path(app, Some(core_type), version.as_deref().or(Some(&tag)))?;
    extract_core_archive(&tmp, &dest)?;
    let _ = fs::remove_file(tmp);
    Ok(success(json!({
        "version": tag,
        "path": dest.to_string_lossy()
    })))
}

fn set_windows_proxy(enabled: bool, host: &str, port: u16) -> Result<(), String> {
    if !cfg!(windows) {
        return Ok(());
    }
    let key = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings";
    let enable_value = if enabled { "1" } else { "0" };
    let server = format!("{host}:{port}");
    let status = Command::new("reg")
        .args([
            "add",
            key,
            "/v",
            "ProxyEnable",
            "/t",
            "REG_DWORD",
            "/d",
            enable_value,
            "/f",
        ])
        .status()
        .map_err(|err| err.to_string())?;
    if !status.success() {
        return Err("写入 ProxyEnable 失败".to_string());
    }
    if enabled {
        let status = Command::new("reg")
            .args([
                "add",
                key,
                "/v",
                "ProxyServer",
                "/t",
                "REG_SZ",
                "/d",
                &server,
                "/f",
            ])
            .status()
            .map_err(|err| err.to_string())?;
        if !status.success() {
            return Err("写入 ProxyServer 失败".to_string());
        }
    }
    let _ = Command::new("RUNDLL32.EXE")
        .args(["inetcpl.cpl,ClearMyTracksByProcess", "8"])
        .status();
    Ok(())
}

fn controller_host(app: &AppHandle) -> String {
    setting(app, "controllerHost", json!("127.0.0.1"))
        .ok()
        .and_then(|value| value.as_str().map(ToString::to_string))
        .unwrap_or_else(|| "127.0.0.1".to_string())
}

fn controller_port(app: &AppHandle) -> u16 {
    setting(app, "controllerPort", json!(9090))
        .ok()
        .and_then(|value| {
            value
                .as_u64()
                .map(|port| port as u16)
                .or_else(|| value.as_str().and_then(|port| port.parse::<u16>().ok()))
        })
        .unwrap_or(9090)
}

fn controller_secret(app: &AppHandle) -> String {
    setting(app, "secret", json!(""))
        .ok()
        .and_then(|value| value.as_str().map(ToString::to_string))
        .unwrap_or_default()
}

fn prepare_runtime_config(app: &AppHandle, config_path: &str) -> Result<PathBuf, String> {
    let content = config_content(app, config_path)?;
    let mut yaml = serde_yaml::from_str::<serde_yaml::Value>(&content)
        .unwrap_or_else(|_| serde_yaml::Value::Mapping(Default::default()));

    if let serde_yaml::Value::Mapping(map) = &mut yaml {
        map.insert(
            serde_yaml::Value::String("external-controller".to_string()),
            serde_yaml::Value::String(format!("{}:{}", controller_host(app), controller_port(app))),
        );
        let secret = controller_secret(app);
        if !secret.is_empty() {
            map.insert(
                serde_yaml::Value::String("secret".to_string()),
                serde_yaml::Value::String(secret),
            );
        }
    }

    let runtime_path = mihomo_dir(app)?.join("work-config.yaml");
    let runtime_content = serde_yaml::to_string(&yaml).unwrap_or(content);
    fs::write(&runtime_path, runtime_content).map_err(|err| err.to_string())?;
    Ok(runtime_path)
}

async fn request_http(
    app: &AppHandle,
    target: Option<String>,
    options: Option<Value>,
) -> CompatResult {
    let options = match options {
        Some(value) => {
            serde_json::from_value::<FetchOptions>(value).map_err(|err| err.to_string())?
        }
        None => FetchOptions {
            method: default_method(),
            headers: Map::new(),
            body: None,
            timeout: None,
            url: None,
        },
    };

    let endpoint = target.or(options.url.clone()).unwrap_or_default();
    if endpoint.is_empty() {
        return Err("missing request url".to_string());
    }

    let url = if endpoint.starts_with("http://") || endpoint.starts_with("https://") {
        endpoint
    } else {
        format!(
            "http://{}:{}{}",
            controller_host(app),
            controller_port(app),
            endpoint
        )
    };

    let timeout = Duration::from_millis(options.timeout.unwrap_or(30_000));
    let client = reqwest::Client::builder()
        .timeout(timeout)
        .danger_accept_invalid_certs(true)
        .build()
        .map_err(|err| err.to_string())?;
    let method = options
        .method
        .parse::<reqwest::Method>()
        .map_err(|err| err.to_string())?;
    let mut request = client.request(method, &url);

    for (key, value) in options.headers {
        if let Some(value) = value.as_str() {
            request = request.header(key, value);
        }
    }

    let secret = controller_secret(app);
    if !secret.is_empty() {
        request = request.bearer_auth(secret);
    }

    if let Some(body) = options.body {
        request = match body {
            Value::String(text) => request.body(text),
            other => request.json(&other),
        };
    }

    let response = request.send().await.map_err(|err| err.to_string())?;
    let status = response.status();
    let status_text = status.canonical_reason().unwrap_or("").to_string();
    let headers = response
        .headers()
        .iter()
        .map(|(key, value)| {
            (
                key.to_string(),
                Value::String(value.to_str().unwrap_or_default().to_string()),
            )
        })
        .collect::<Map<String, Value>>();
    let text = response.text().await.map_err(|err| err.to_string())?;
    let data = serde_json::from_str::<Value>(&text).unwrap_or_else(|_| Value::String(text.clone()));

    Ok(json!({
        "ok": status.is_success(),
        "status": status.as_u16(),
        "statusText": status_text,
        "headers": headers,
        "data": data,
        "text": text
    }))
}

async fn wait_for_mihomo(app: &AppHandle) -> bool {
    for _ in 0..30 {
        if request_http(app, Some("/version".to_string()), None)
            .await
            .map(|value| value.get("ok").and_then(Value::as_bool).unwrap_or(false))
            .unwrap_or(false)
        {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    false
}

fn stop_mihomo_process(state: &State<'_, AppState>) {
    let mut runtime = state.runtime.lock().expect("runtime mutex poisoned");
    if let Some(mut child) = runtime.mihomo.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

async fn start_mihomo(
    app: &AppHandle,
    state: &State<'_, AppState>,
    config_path: &str,
) -> CompatResult {
    let _ = config_content(app, config_path)
        .map_err(|err| format!("配置文件不存在或无法解密: {err}"))?;

    stop_mihomo_process(state);
    let mihomo = find_mihomo_executable(app)?;
    let runtime_config = prepare_runtime_config(app, config_path)?;
    let work_dir = mihomo_dir(app)?;
    let log_path = work_dir.join("mihomo.log");
    let log_file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)
        .map_err(|err| err.to_string())?;

    let child = Command::new(mihomo)
        .arg("-d")
        .arg(&work_dir)
        .arg("-f")
        .arg(&runtime_config)
        .stdout(Stdio::from(
            log_file.try_clone().map_err(|err| err.to_string())?,
        ))
        .stderr(Stdio::from(log_file))
        .spawn()
        .map_err(|err| err.to_string())?;

    {
        let mut runtime = state.runtime.lock().expect("runtime mutex poisoned");
        runtime.mihomo = Some(child);
        runtime.active_config = Some(config_path.to_string());
    }

    save_last_config(app, config_path)?;

    if wait_for_mihomo(app).await {
        Ok(json!({ "success": true }))
    } else {
        Ok(json!({
            "success": false,
            "error": "Mihomo 已启动但 controller 未在超时时间内就绪"
        }))
    }
}

fn is_mihomo_running(state: &State<'_, AppState>) -> bool {
    let mut runtime = state.runtime.lock().expect("runtime mutex poisoned");
    if let Some(child) = runtime.mihomo.as_mut() {
        match child.try_wait() {
            Ok(Some(_)) => {
                runtime.mihomo = None;
                false
            }
            Ok(None) => true,
            Err(_) => false,
        }
    } else {
        false
    }
}

fn parse_config_order(app: &AppHandle, config_path: Option<String>) -> Value {
    let Some(path) = config_path else {
        return success(json!({ "data": { "proxyGroups": [] } }));
    };
    let content = config_content(app, &path).unwrap_or_default();
    let yaml =
        serde_yaml::from_str::<serde_yaml::Value>(&content).unwrap_or(serde_yaml::Value::Null);
    let groups = yaml
        .get("proxy-groups")
        .and_then(|value| value.as_sequence())
        .map(|groups| {
            groups
                .iter()
                .filter_map(|group| {
                    let name = group.get("name").and_then(|value| value.as_str())?;
                    let hidden = group
                        .get("hidden")
                        .and_then(|value| value.as_bool())
                        .unwrap_or(false);
                    Some(json!({ "name": name, "hidden": hidden }))
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    success(json!({ "data": { "proxyGroups": groups } }))
}

async fn fetch_connections_info(app: &AppHandle) -> Value {
    let response = request_http(app, Some("/connections".to_string()), None).await;
    let data = response
        .ok()
        .and_then(|value| value.get("data").cloned())
        .unwrap_or_else(|| json!({}));
    let connections = data
        .get("connections")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    json!({
        "activeConnections": connections.len(),
        "connections": connections,
        "downloadTotal": data.get("downloadTotal").and_then(Value::as_u64).unwrap_or(0),
        "uploadTotal": data.get("uploadTotal").and_then(Value::as_u64).unwrap_or(0)
    })
}

async fn get_traffic_stats(app: &AppHandle, state: &State<'_, AppState>) -> Value {
    let snapshot = fetch_connections_info(app).await;
    let up = snapshot
        .get("uploadTotal")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    let down = snapshot
        .get("downloadTotal")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    let timestamp = now_millis();
    let mut runtime = state.runtime.lock().expect("runtime mutex poisoned");
    let (up_speed, down_speed) = runtime
        .last_traffic
        .as_ref()
        .map(|last| {
            let elapsed = (timestamp.saturating_sub(last.timestamp) as f64 / 1000.0).max(0.001);
            (
                ((up.saturating_sub(last.up)) as f64 / elapsed) as u64,
                ((down.saturating_sub(last.down)) as f64 / elapsed) as u64,
            )
        })
        .unwrap_or((0, 0));
    let previous = runtime.last_traffic.clone();
    runtime.last_traffic = Some(TrafficSnapshot {
        up,
        down,
        timestamp,
    });
    drop(runtime);

    if let Some(last) = previous {
        let delta_up = up.saturating_sub(last.up);
        let delta_down = down.saturating_sub(last.down);
        if delta_up > 0 || delta_down > 0 {
            let _ = add_traffic_history(app, delta_up, delta_down);
        }
    }

    json!({
        "up": up,
        "down": down,
        "upSpeed": up_speed,
        "downSpeed": down_speed,
        "timestamp": timestamp
    })
}

fn today_key() -> String {
    let output = Command::new("powershell.exe")
        .args(["-NoProfile", "-Command", "Get-Date -Format yyyy-MM-dd"])
        .creation_flags(0x08000000)
        .output();
    output
        .ok()
        .and_then(|out| String::from_utf8(out.stdout).ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| (now_millis() / 86_400_000).to_string())
}

fn add_traffic_history(app: &AppHandle, upload: u64, download: u64) -> Result<(), String> {
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

fn proxy_icon_default_config() -> Value {
    json!({ "enabled": true, "rules": [] })
}

fn proxy_icon_config(app: &AppHandle) -> Result<Value, String> {
    Ok(setting(
        app,
        "proxyIconConfig",
        proxy_icon_default_config(),
    )?)
}

fn save_proxy_icon_config(app: &AppHandle, config: Value) -> CompatResult {
    set_setting(app, "proxyIconConfig", config)?;
    Ok(success(json!({})))
}

fn proxy_icon_rule_update(
    app: &AppHandle,
    rule_id: Option<String>,
    rule_or_updates: Value,
    mode: &str,
) -> CompatResult {
    let mut config = proxy_icon_config(app)?;
    let rules = config
        .as_object_mut()
        .and_then(|object| object.get_mut("rules"))
        .and_then(Value::as_array_mut)
        .ok_or_else(|| "proxy icon config is invalid".to_string())?;

    match mode {
        "add" => {
            let mut rule = rule_or_updates.as_object().cloned().unwrap_or_default();
            rule.entry("id")
                .or_insert_with(|| Value::String(now_millis().to_string()));
            rule.entry("enabled").or_insert(Value::Bool(true));
            rule.entry("priority").or_insert(json!(0));
            rules.push(Value::Object(rule));
        }
        "update" => {
            let id = rule_id.ok_or_else(|| "missing rule id".to_string())?;
            let index = rules
                .iter()
                .position(|rule| rule.get("id").and_then(Value::as_str) == Some(id.as_str()))
                .ok_or_else(|| "规则不存在".to_string())?;
            if let (Some(base), Some(updates)) =
                (rules[index].as_object_mut(), rule_or_updates.as_object())
            {
                for (key, value) in updates {
                    base.insert(key.clone(), value.clone());
                }
            }
        }
        "delete" => {
            let id = rule_id.ok_or_else(|| "missing rule id".to_string())?;
            rules.retain(|rule| rule.get("id").and_then(Value::as_str) != Some(id.as_str()));
        }
        "toggle" => {
            let id = rule_id.ok_or_else(|| "missing rule id".to_string())?;
            let enabled = rule_or_updates.as_bool().unwrap_or(false);
            let rule = rules
                .iter_mut()
                .find(|rule| rule.get("id").and_then(Value::as_str) == Some(id.as_str()))
                .ok_or_else(|| "规则不存在".to_string())?;
            if let Some(object) = rule.as_object_mut() {
                object.insert("enabled".to_string(), Value::Bool(enabled));
            }
        }
        _ => {}
    }

    save_proxy_icon_config(app, config)
}

fn proxy_group_icon(
    app: &AppHandle,
    group_name: &str,
    config_icon: Option<String>,
) -> CompatResult {
    if let Some(icon) = config_icon.filter(|value| !value.is_empty()) {
        return Ok(success(json!({ "iconPath": icon })));
    }

    let config = proxy_icon_config(app)?;
    if !config
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(true)
    {
        return Ok(success(json!({ "iconPath": Value::Null })));
    }

    let mut rules = config
        .get("rules")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    rules.sort_by_key(|rule| {
        -(rule
            .get("priority")
            .and_then(Value::as_i64)
            .unwrap_or_default())
    });
    for rule in rules {
        if !rule.get("enabled").and_then(Value::as_bool).unwrap_or(true) {
            continue;
        }
        let Some(pattern) = rule.get("regex").and_then(Value::as_str) else {
            continue;
        };
        if Regex::new(pattern)
            .map(|regex| regex.is_match(group_name))
            .unwrap_or(false)
        {
            let icon_type = rule
                .get("iconType")
                .and_then(Value::as_str)
                .unwrap_or("URL");
            let icon_data = rule.get("iconData").and_then(Value::as_str).unwrap_or("");
            let icon_path = if icon_type == "BASE64" && !icon_data.starts_with("data:") {
                format!("data:image/png;base64,{icon_data}")
            } else {
                icon_data.to_string()
            };
            return Ok(success(json!({ "iconPath": icon_path })));
        }
    }
    Ok(success(json!({ "iconPath": Value::Null })))
}

fn all_overrides(app: &AppHandle) -> Result<Vec<Value>, String> {
    let conn = db(app)?;
    let mut stmt = conn
        .prepare("SELECT item_json FROM overrides ORDER BY sort_order ASC, created_at ASC")
        .map_err(|err| err.to_string())?;
    let items = stmt
        .query_map([], |row| {
            let raw: String = row.get(0)?;
            Ok(serde_json::from_str::<Value>(&raw).unwrap_or(Value::Null))
        })
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;
    Ok(items)
}

fn save_override_item(app: &AppHandle, item: &Value, content: Option<&str>) -> Result<(), String> {
    let id = item
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| "missing override id".to_string())?;
    let order = db(app)?
        .query_row("SELECT COUNT(*) FROM overrides", [], |row| {
            row.get::<_, i64>(0)
        })
        .unwrap_or(0);
    let encrypted = content.map(|value| encrypt_text(app, value)).transpose()?;
    db(app)?
        .execute(
            r#"
            INSERT INTO overrides (id, item_json, content_cipher, sort_order, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?5)
            ON CONFLICT(id) DO UPDATE SET
              item_json = excluded.item_json,
              content_cipher = COALESCE(excluded.content_cipher, overrides.content_cipher),
              updated_at = excluded.updated_at
            "#,
            params![id, item.to_string(), encrypted, order, now_millis() as i64],
        )
        .map_err(|err| err.to_string())?;
    Ok(())
}

fn override_add(app: &AppHandle, item: Value) -> CompatResult {
    let mut object = item.as_object().cloned().unwrap_or_default();
    let id = object
        .get("id")
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .unwrap_or_else(|| format!("{:x}", now_millis()));
    let now = today_key();
    object.insert("id".to_string(), Value::String(id.clone()));
    object
        .entry("name".to_string())
        .or_insert_with(|| Value::String("Untitled".to_string()));
    object
        .entry("type".to_string())
        .or_insert_with(|| Value::String("local".to_string()));
    object
        .entry("ext".to_string())
        .or_insert_with(|| Value::String("yaml".to_string()));
    object
        .entry("enabled".to_string())
        .or_insert(Value::Bool(false));
    object
        .entry("global".to_string())
        .or_insert(Value::Bool(false));
    object
        .entry("createdAt".to_string())
        .or_insert_with(|| Value::String(now.clone()));
    object.insert("updatedAt".to_string(), Value::String(now));
    let content = object
        .get("file")
        .and_then(Value::as_str)
        .map(ToString::to_string);
    object.remove("file");
    let value = Value::Object(object);
    save_override_item(app, &value, content.as_deref())?;
    Ok(value)
}

fn override_update(app: &AppHandle, id: &str, updates: Value) -> CompatResult {
    let mut items = all_overrides(app)?;
    let item = items
        .iter_mut()
        .find(|item| item.get("id").and_then(Value::as_str) == Some(id))
        .ok_or_else(|| "覆写项不存在".to_string())?;
    if let (Some(object), Some(update_map)) = (item.as_object_mut(), updates.as_object()) {
        for (key, value) in update_map {
            object.insert(key.clone(), value.clone());
        }
        object.insert("updatedAt".to_string(), Value::String(today_key()));
    }
    save_override_item(app, item, None)?;
    Ok(item.clone())
}

fn override_content(app: &AppHandle, id: &str) -> Result<String, String> {
    let row = db(app)?
        .query_row(
            "SELECT item_json, content_cipher FROM overrides WHERE id = ?1",
            params![id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
        )
        .optional()
        .map_err(|err| err.to_string())?
        .ok_or_else(|| "覆写项不存在".to_string())?;
    if let Some(cipher) = row.1 {
        return decrypt_text(app, &cipher);
    }
    let item = serde_json::from_str::<Value>(&row.0).unwrap_or(Value::Null);
    if item.get("type").and_then(Value::as_str) == Some("remote") {
        return Ok(String::new());
    }
    Ok(String::new())
}

async fn override_update_remote(app: &AppHandle, id: &str) -> CompatResult {
    let item = all_overrides(app)?
        .into_iter()
        .find(|item| item.get("id").and_then(Value::as_str) == Some(id))
        .ok_or_else(|| "覆写项不存在".to_string())?;
    let url = item
        .get("url")
        .and_then(Value::as_str)
        .ok_or_else(|| "远程覆写缺少 URL".to_string())?;
    let content = reqwest::get(url)
        .await
        .map_err(|err| err.to_string())?
        .text()
        .await
        .map_err(|err| err.to_string())?;
    save_override_item(app, &item, Some(&content))?;
    Ok(item)
}

fn backup_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app_data_dir(app)?.join("backups");
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    Ok(dir)
}

fn create_backup_zip(app: &AppHandle, backup_type: &str) -> CompatResult {
    let path = backup_dir(app)?.join(format!("flyclash_backup_{}.zip", now_millis()));
    let file = fs::File::create(&path).map_err(|err| err.to_string())?;
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    for (name, source) in [
        ("flyclash.db", database_path(app)?),
        (".runtime-key", encryption_key_path(app)?),
    ] {
        if source.exists() {
            zip.start_file(name, options)
                .map_err(|err| err.to_string())?;
            let bytes = fs::read(source).map_err(|err| err.to_string())?;
            zip.write_all(&bytes).map_err(|err| err.to_string())?;
        }
    }
    zip.start_file("manifest.json", options)
        .map_err(|err| err.to_string())?;
    zip.write_all(
        json!({
            "app": "FlyClash",
            "runtime": "tauri",
            "backupType": backup_type,
            "createdAt": now_millis()
        })
        .to_string()
        .as_bytes(),
    )
    .map_err(|err| err.to_string())?;
    zip.finish().map_err(|err| err.to_string())?;
    Ok(success(json!({ "filePath": path.to_string_lossy() })))
}

fn latest_backup(app: &AppHandle) -> Result<Option<PathBuf>, String> {
    let mut files = fs::read_dir(backup_dir(app)?)
        .map_err(|err| err.to_string())?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("zip"))
        .collect::<Vec<_>>();
    files.sort_by_key(|path| fs::metadata(path).and_then(|m| m.modified()).ok());
    Ok(files.pop())
}

fn restore_backup_zip(app: &AppHandle, path: &Path) -> CompatResult {
    let file = fs::File::open(path).map_err(|err| err.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|err| err.to_string())?;
    let mut restored = 0;
    for (name, target) in [
        ("flyclash.db", database_path(app)?),
        (".runtime-key", encryption_key_path(app)?),
    ] {
        if let Ok(mut source) = archive.by_name(name) {
            let mut bytes = Vec::new();
            source
                .read_to_end(&mut bytes)
                .map_err(|err| err.to_string())?;
            fs::write(target, bytes).map_err(|err| err.to_string())?;
            restored += 1;
        }
    }
    Ok(success(
        json!({ "stats": { "restored": restored, "failed": 0, "errors": [] } }),
    ))
}

fn webdav_config(app: &AppHandle) -> Result<Value, String> {
    Ok(json!({
        "uri": setting(app, "webdav_uri", json!(""))?,
        "username": setting(app, "webdav_username", json!(""))?,
        "password": setting(app, "webdav_password", json!(""))?,
        "backupDirectory": setting(app, "webdav_backup_dir", json!("FlyClash"))?,
        "fileName": setting(app, "webdav_backup_filename", json!("flyclash_backup.zip"))?
    }))
}

fn webdav_url(config: &Value, file_name: Option<&str>) -> Result<String, String> {
    let base = config
        .get("uri")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim_end_matches('/');
    if base.is_empty() {
        return Err("WebDAV配置不完整".to_string());
    }
    let dir = config
        .get("backupDirectory")
        .and_then(Value::as_str)
        .unwrap_or("FlyClash")
        .trim_matches('/');
    let mut url = format!("{base}/{dir}");
    if let Some(file) = file_name {
        url.push('/');
        url.push_str(file);
    }
    Ok(url)
}

async fn webdav_request(
    app: &AppHandle,
    method: &str,
    url: String,
    body: Option<Vec<u8>>,
) -> CompatResult {
    let config = webdav_config(app)?;
    let username = config.get("username").and_then(Value::as_str).unwrap_or("");
    let password = config.get("password").and_then(Value::as_str).unwrap_or("");
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .build()
        .map_err(|err| err.to_string())?;
    let method = reqwest::Method::from_bytes(method.as_bytes()).map_err(|err| err.to_string())?;
    let mut request = client
        .request(method, url)
        .basic_auth(username, Some(password));
    if let Some(body) = body {
        request = request.body(body);
    }
    let response = request.send().await.map_err(|err| err.to_string())?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    Ok(json!({ "success": status.is_success(), "status": status.as_u16(), "text": text }))
}

fn loopback_apps(app: &AppHandle) -> CompatResult {
    if !cfg!(target_os = "windows") {
        return Ok(success(json!({ "apps": [], "isAdmin": false })));
    }
    let configured = setting(app, "loopbackExemptSids", json!([]))?;
    let sids = configured.as_array().cloned().unwrap_or_default();
    let apps = sids
        .into_iter()
        .filter_map(|sid| sid.as_str().map(ToString::to_string))
        .map(|sid| {
            json!({
                "appContainerName": sid,
                "displayName": sid,
                "packageFamilyName": sid,
                "sid": sid,
                "workingDir": "",
                "isExempt": true
            })
        })
        .collect::<Vec<_>>();
    Ok(success(json!({ "apps": apps, "isAdmin": true })))
}

fn loopback_set(app: &AppHandle, sids: Vec<String>) -> CompatResult {
    set_setting(app, "loopbackExemptSids", json!(sids))?;
    Ok(success(json!({ "added": 0, "failed": 0 })))
}

fn command_output(program: &str, args: &[&str]) -> Result<String, String> {
    let mut command = Command::new(program);
    command.args(args);
    #[cfg(target_os = "windows")]
    command.creation_flags(0x08000000);
    let output = command.output().map_err(|err| err.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn set_autostart(app: &AppHandle, enabled: bool) -> Result<(), String> {
    set_setting(app, "autoStart", json!(enabled))?;
    if cfg!(target_os = "windows") {
        let exe = std::env::current_exe().map_err(|err| err.to_string())?;
        if enabled {
            let value = format!("\"{}\"", exe.to_string_lossy());
            let _ = command_output(
                "reg",
                &[
                    "add",
                    r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
                    "/v",
                    "FlyClash",
                    "/t",
                    "REG_SZ",
                    "/d",
                    &value,
                    "/f",
                ],
            )?;
        } else {
            let _ = command_output(
                "reg",
                &[
                    "delete",
                    r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
                    "/v",
                    "FlyClash",
                    "/f",
                ],
            );
        }
    }
    Ok(())
}

fn service_status() -> Value {
    if !cfg!(target_os = "windows") {
        return success(json!({ "installed": false, "running": false, "mode": "unsupported" }));
    }
    let output = command_output("sc", &["query", "FlyClashTun"]);
    match output {
        Ok(text) => success(json!({
            "installed": true,
            "running": text.contains("RUNNING"),
            "mode": "service"
        })),
        Err(error) => success(json!({
            "installed": false,
            "running": false,
            "mode": "service",
            "error": error
        })),
    }
}

fn default_sniffer_config() -> Value {
    json!({
        "enable": false,
        "sniff": {
            "TLS": { "ports": [443, 8443] },
            "HTTP": { "ports": [80, "8080-8880"] }
        },
        "force-domain": [],
        "skip-domain": []
    })
}

async fn simple_speedtest(app: &AppHandle, proxied: bool) -> CompatResult {
    let url = "https://speed.cloudflare.com/__down?bytes=1000000";
    let started = now_millis();
    let response = if proxied {
        request_http(
            app,
            None,
            Some(json!({ "url": url, "method": "GET", "timeout": 30000 })),
        )
        .await?
    } else {
        let text = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .danger_accept_invalid_certs(true)
            .build()
            .map_err(|err| err.to_string())?
            .get(url)
            .send()
            .await
            .map_err(|err| err.to_string())?
            .bytes()
            .await
            .map_err(|err| err.to_string())?;
        json!({ "ok": true, "bytes": text.len() })
    };
    let duration = ((now_millis().saturating_sub(started)) as f64 / 1000.0).max(0.001);
    let bytes = response
        .get("bytes")
        .and_then(Value::as_u64)
        .or_else(|| {
            response
                .get("text")
                .and_then(Value::as_str)
                .map(|text| text.len() as u64)
        })
        .unwrap_or(1_000_000);
    Ok(success(json!({
        "data": {
            "download": (bytes as f64 * 8.0 / duration / 1_000_000.0),
            "upload": 0,
            "ping": 0,
            "server": { "host": "speed.cloudflare.com", "name": "Cloudflare", "country": "" }
        }
    })))
}

fn parse_proxy_names(input: &str) -> Value {
    let decoded = general_purpose::STANDARD
        .decode(input.trim())
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .unwrap_or_else(|| input.to_string());
    let yaml = serde_yaml::from_str::<serde_yaml::Value>(&decoded).ok();
    let proxies = yaml
        .as_ref()
        .and_then(|value| value.get("proxies"))
        .and_then(|value| value.as_sequence())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    Some(json!({
                        "name": item.get("name").and_then(|value| value.as_str())?,
                        "type": item.get("type").and_then(|value| value.as_str()).unwrap_or("unknown")
                    }))
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_else(|| {
            decoded
                .lines()
                .filter(|line| {
                    line.starts_with("ss://")
                        || line.starts_with("ssr://")
                        || line.starts_with("vmess://")
                        || line.starts_with("vless://")
                        || line.starts_with("trojan://")
                        || line.starts_with("hysteria://")
                        || line.starts_with("hysteria2://")
                })
                .enumerate()
                .map(|(index, line)| {
                    let name = line
                        .split('#')
                        .nth(1)
                        .map(|value| value.replace("%20", " "))
                        .unwrap_or_else(|| format!("Proxy {}", index + 1));
                    json!({ "name": name, "type": line.split("://").next().unwrap_or("unknown") })
                })
                .collect::<Vec<_>>()
        });
    let count = proxies.len();
    success(json!({
        "proxies": proxies,
        "count": count,
        "content": decoded
    }))
}

fn converter_templates() -> Value {
    json!([
        {
            "id": "mihomo-default",
            "name": "Mihomo 默认模板",
            "description": "保留订阅原始结构并补充 FlyClash 运行参数",
            "target": "mihomo"
        }
    ])
}

#[tauri::command]
async fn tauri_compat_call(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    request: CompatRequest,
) -> CompatResult {
    let method = request.method.as_str();
    let args = request.args;

    match method {
        "getAppVersion" => Ok(Value::String(app.package_info().version.to_string())),
        "getPlatform" => Ok(Value::String(std::env::consts::OS.to_string())),
        "debugLog" => Ok(Value::Null),
        "loadPage" | "navigateTo" => Ok(success(json!({}))),

        "coreGetCurrentConfig" | "core:get-current-config" => core_current_config(&app),
        "coreGetInstalledCores" | "core:get-installed-cores" => core_installed(&app),
        "coreSwitchCore" | "core:switch-core" => {
            let core_type = arg_string(&args, 0).unwrap_or_else(|| "mihomo".to_string());
            let specific = arg_string(&args, 1);
            set_setting(&app, "core_type", json!(core_type))?;
            set_setting(
                &app,
                "core_specific_version",
                specific.map(Value::String).unwrap_or(Value::Null),
            )?;
            Ok(success(json!({})))
        }
        "coreSetCustomPath" | "core:set-custom-path" => {
            let path = arg_string(&args, 0).unwrap_or_default();
            set_setting(&app, "core_custom_path", json!(path))?;
            Ok(success(json!({})))
        }
        "coreDeleteCore" | "core:delete-core" => {
            let path = arg_string(&args, 0).unwrap_or_default();
            if Path::new(&path).exists() {
                fs::remove_file(path).map_err(|err| err.to_string())?;
            }
            Ok(success(json!({})))
        }
        "coreClearVersionCache" | "core:clear-version-cache" => Ok(success(json!({}))),
        "coreCheckUpdate" | "core:check-update" => {
            let core_type = arg_string(&args, 0).unwrap_or_else(|| "mihomo".to_string());
            let release = latest_release(&core_type).await?;
            Ok(success(json!({
                "hasUpdate": true,
                "latestVersion": release.get("tag_name").cloned().unwrap_or(Value::Null),
                "releaseInfo": release
            })))
        }
        "coreGetAvailableVersions" | "core:get-available-versions" => {
            let core_type = arg_string(&args, 0).unwrap_or_else(|| "mihomo".to_string());
            let limit = args.get(1).and_then(Value::as_u64).unwrap_or(20) as usize;
            Ok(success(
                json!({ "versions": release_versions(&core_type, limit).await? }),
            ))
        }
        "coreDownloadCore" | "core:download-core" => {
            let core_type = arg_string(&args, 0).unwrap_or_else(|| "mihomo".to_string());
            download_core(&app, &core_type, None).await
        }
        "coreDownloadSpecificVersion" | "core:download-specific-version" => {
            let core_type = arg_string(&args, 0).unwrap_or_else(|| "mihomo-specific".to_string());
            let version = arg_string(&args, 1);
            download_core(&app, &core_type, version).await
        }

        "getTheme" => Ok(success(
            json!({ "theme": setting(&app, "theme", json!("system"))? }),
        )),
        "setTheme" => {
            let theme = arg_string(&args, 0).unwrap_or_else(|| "system".to_string());
            set_setting(&app, "theme", json!(theme))?;
            Ok(success(json!({ "theme": theme })))
        }
        "getThemeColor" => Ok(success(
            json!({ "color": setting(&app, "themeColor", json!("#2563eb"))? }),
        )),
        "setThemeColor" => {
            let color = arg_string(&args, 0).unwrap_or_else(|| "#2563eb".to_string());
            set_setting(&app, "themeColor", json!(color))?;
            Ok(success(json!({})))
        }
        "getSetting" => {
            let key = arg_string(&args, 0).unwrap_or_default();
            let fallback = args.get(1).cloned().unwrap_or(Value::Null);
            Ok(success(json!({ "value": setting(&app, &key, fallback)? })))
        }
        "setSetting" => {
            let key = arg_string(&args, 0).unwrap_or_default();
            let value = args.get(1).cloned().unwrap_or(Value::Null);
            set_setting(&app, &key, value)?;
            Ok(success(json!({})))
        }
        "getFavoriteNodes" | "get-favorite-nodes" => Ok(success(json!({
            "nodes": setting(&app, "favoriteNodes", json!([]))?
        }))),
        "saveFavoriteNodes" | "save-favorite-nodes" => {
            set_setting(
                &app,
                "favoriteNodes",
                args.first().cloned().unwrap_or_else(|| json!([])),
            )?;
            Ok(success(json!({})))
        }
        "getCollapsedGroups" | "get-collapsed-groups" => Ok(success(json!({
            "groups": setting(&app, "collapsedGroups", json!([]))?
        }))),
        "saveCollapsedGroups" | "save-collapsed-groups" => {
            set_setting(
                &app,
                "collapsedGroups",
                args.first().cloned().unwrap_or_else(|| json!([])),
            )?;
            Ok(success(json!({})))
        }
        "getLogs" => Ok(setting(&app, "logs", json!([]))?),
        "saveLogs" => {
            set_setting(
                &app,
                "logs",
                args.first().cloned().unwrap_or_else(|| json!([])),
            )?;
            Ok(success(json!({ "filePath": "flyclash-db://logs" })))
        }

        "fetchSubscription" => {
            let url = arg_string(&args, 0).unwrap_or_default();
            fetch_subscription(&app, &url).await
        }
        "saveSubscription" => save_subscription(
            &app,
            arg_string(&args, 0),
            arg_string(&args, 1).unwrap_or_default(),
            arg_string(&args, 2),
            args.get(3).cloned(),
        ),
        "getSubscriptions" => {
            Ok(serde_json::to_value(read_subscriptions(&app)?).unwrap_or(json!([])))
        }
        "deleteSubscription" => {
            delete_subscription(&app, &arg_string(&args, 0).unwrap_or_default())
        }
        "refreshSubscription" => {
            let file_path = arg_string(&args, 0).unwrap_or_default();
            let url = read_subscriptions(&app)?
                .into_iter()
                .find(|item| item.path == file_path)
                .and_then(|item| item.url);
            if let Some(url) = url {
                let fetched = fetch_subscription(&app, &url).await?;
                if fetched
                    .get("success")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                {
                    if let Some(content) = fetched.get("content").and_then(Value::as_str) {
                        let encrypted = encrypt_text(&app, content)?;
                        db(&app)?
                            .execute(
                                "UPDATE subscriptions SET config_cipher = ?1, updated_at = ?2 WHERE file_path = ?3",
                                params![encrypted, now_millis() as i64, file_path],
                            )
                            .map_err(|err| err.to_string())?;
                    }
                }
                Ok(fetched)
            } else {
                Ok(json!({ "success": true, "message": "本地配置无需刷新" }))
            }
        }
        "getSubscriptionUrl" => {
            let file_path = arg_string(&args, 0).unwrap_or_default();
            Ok(read_subscriptions(&app)?
                .into_iter()
                .find(|item| item.path == file_path)
                .and_then(|item| item.url)
                .map(Value::String)
                .unwrap_or(Value::Null))
        }
        "editSubscription" => edit_subscription(&app, args.first().cloned().unwrap_or(Value::Null)),
        "saveSubscriptionOrder" => {
            let order_list = args
                .first()
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let mut items = read_subscriptions(&app)?;
            for entry in order_list {
                let Some(path) = entry.get("path").and_then(Value::as_str) else {
                    continue;
                };
                let order = entry.get("order").and_then(Value::as_u64).unwrap_or(0) as usize;
                if let Some(item) = items.iter_mut().find(|item| item.path == path) {
                    item.order = order;
                }
            }
            write_subscriptions(&app, &items)?;
            Ok(success(json!({})))
        }
        "getSubscriptionOverrides" => {
            let file_path = arg_string(&args, 0).unwrap_or_default();
            let raw = db(&app)?
                .query_row(
                    "SELECT overrides FROM subscriptions WHERE file_path = ?1",
                    params![file_path],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(|err| err.to_string())?
                .unwrap_or_else(|| "[]".to_string());
            Ok(serde_json::from_str::<Value>(&raw).unwrap_or_else(|_| json!([])))
        }
        "setSubscriptionOverrides" => {
            let file_path = arg_string(&args, 0).unwrap_or_default();
            let overrides = args.get(1).cloned().unwrap_or_else(|| json!([]));
            db(&app)?
                .execute(
                    "UPDATE subscriptions SET overrides = ?1 WHERE file_path = ?2",
                    params![overrides.to_string(), file_path],
                )
                .map_err(|err| err.to_string())?;
            Ok(success(json!({})))
        }
        "getSubscriptionUpdateInterval" => {
            let file_path = arg_string(&args, 0).unwrap_or_default();
            let interval = db(&app)?
                .query_row(
                    "SELECT update_interval FROM subscriptions WHERE file_path = ?1",
                    params![file_path],
                    |row| row.get::<_, i64>(0),
                )
                .optional()
                .map_err(|err| err.to_string())?
                .unwrap_or(0);
            Ok(success(json!({ "interval": interval })))
        }
        "setSubscriptionUpdateInterval" => {
            let file_path = arg_string(&args, 0).unwrap_or_default();
            let interval = args.get(1).and_then(Value::as_i64).unwrap_or(0);
            db(&app)?
                .execute(
                    "UPDATE subscriptions SET update_interval = ?1 WHERE file_path = ?2",
                    params![interval, file_path],
                )
                .map_err(|err| err.to_string())?;
            Ok(success(json!({})))
        }

        "readConfigFile" => {
            let active = state
                .runtime
                .lock()
                .expect("runtime mutex poisoned")
                .active_config
                .clone()
                .or(read_last_config(&app)?)
                .ok_or_else(|| "没有当前配置".to_string())?;
            Ok(success(json!({
                "path": active,
                "content": config_content(&app, &active)?
            })))
        }
        "validateConfig" => {
            let content = arg_string(&args, 0).unwrap_or_default();
            match serde_yaml::from_str::<serde_yaml::Value>(&content) {
                Ok(_) => Ok(json!({ "valid": true })),
                Err(err) => Ok(json!({ "valid": false, "error": err.to_string() })),
            }
        }
        "writeConfigFile" => {
            let content = arg_string(&args, 0).unwrap_or_default();
            let active = read_last_config(&app)?.ok_or_else(|| "没有当前配置".to_string())?;
            save_config_content(&app, &active, &content)?;
            Ok(success(json!({ "path": active })))
        }
        "editConfigAtomic" => {
            let old = arg_string(&args, 0).unwrap_or_default();
            let new = arg_string(&args, 1).unwrap_or_default();
            let active = read_last_config(&app)?.ok_or_else(|| "没有当前配置".to_string())?;
            let content = config_content(&app, &active)?;
            let match_count = content.matches(&old).count();
            if match_count == 0 {
                return Ok(json!({ "success": false, "matchCount": 0, "error": "未找到匹配内容" }));
            }
            let next = content.replacen(&old, &new, 1);
            if let Err(err) = serde_yaml::from_str::<serde_yaml::Value>(&next) {
                return Ok(
                    json!({ "success": false, "matchCount": match_count, "yamlError": err.to_string() }),
                );
            }
            save_config_content(&app, &active, &next)?;
            Ok(json!({ "success": true, "matchCount": match_count, "content": next }))
        }
        "getKernelConfig" => yaml_root_pick(
            &app,
            arg_string(&args, 0),
            &[
                "mode",
                "ipv6",
                "log-level",
                "mixed-port",
                "socks-port",
                "port",
                "redir-port",
                "tproxy-port",
                "allow-lan",
                "lan-allowed-ips",
                "lan-disallowed-ips",
                "external-controller",
                "secret",
                "authentication",
                "skip-auth-prefixes",
                "unified-delay",
                "tcp-concurrent",
                "disable-keep-alive",
                "keep-alive-idle",
                "keep-alive-interval",
                "global-client-fingerprint",
                "find-process-mode",
                "interface-name",
                "profile",
            ],
        ),
        "saveKernelConfig" => yaml_root_merge(
            &app,
            arg_string(&args, 1),
            args.first().cloned().unwrap_or_else(|| json!({})),
        ),
        "getDnsConfig" => yaml_section(&app, arg_string(&args, 0), "dns"),
        "saveDnsConfig" => yaml_save_section(
            &app,
            arg_string(&args, 1),
            "dns",
            args.first().cloned().unwrap_or_else(|| json!({})),
        ),
        "saveHostsConfig" => {
            let active = read_last_config(&app)?.ok_or_else(|| "没有当前配置".to_string())?;
            let hosts = args.first().cloned().unwrap_or_else(|| json!([]));
            yaml_save_section(&app, Some(active), "hosts", hosts)
        }
        "getSnifferConfig" => yaml_section(
            &app,
            arg_string(&args, 0).or(read_last_config(&app)?),
            "sniffer",
        )
        .or_else(|_| Ok(success(json!({ "config": default_sniffer_config() })))),
        "saveSnifferConfig" => yaml_save_section(
            &app,
            arg_string(&args, 1).or(read_last_config(&app)?),
            "sniffer",
            args.first().cloned().unwrap_or_else(default_sniffer_config),
        ),
        "getProxyGroupsConfig" => {
            let path = arg_string(&args, 0).ok_or_else(|| "missing config path".to_string())?;
            let yaml = config_yaml(&app, &path)?;
            Ok(success(json!({
                "groups": serde_json::to_value(yaml.get("proxy-groups").cloned().unwrap_or(serde_yaml::Value::Sequence(vec![]))).unwrap_or(json!([]))
            })))
        }
        "saveProxyGroupsConfig" => yaml_save_section(
            &app,
            arg_string(&args, 1),
            "proxy-groups",
            args.first().cloned().unwrap_or_else(|| json!([])),
        ),
        "getRulesConfig" => {
            let path = arg_string(&args, 0).ok_or_else(|| "missing config path".to_string())?;
            let yaml = config_yaml(&app, &path)?;
            Ok(success(json!({
                "rules": serde_json::to_value(yaml.get("rules").cloned().unwrap_or(serde_yaml::Value::Sequence(vec![]))).unwrap_or(json!([]))
            })))
        }
        "saveRulesConfig" => yaml_save_section(
            &app,
            arg_string(&args, 1),
            "rules",
            args.first().cloned().unwrap_or_else(|| json!([])),
        ),
        "getProvidersConfig" => {
            let path = arg_string(&args, 0).ok_or_else(|| "missing config path".to_string())?;
            let yaml = config_yaml(&app, &path)?;
            Ok(success(json!({
                "proxyProviders": serde_json::to_value(yaml.get("proxy-providers").cloned().unwrap_or(serde_yaml::Value::Mapping(Default::default()))).unwrap_or(json!({})),
                "ruleProviders": serde_json::to_value(yaml.get("rule-providers").cloned().unwrap_or(serde_yaml::Value::Mapping(Default::default()))).unwrap_or(json!({}))
            })))
        }
        "saveProvidersConfig" => {
            let path = arg_string(&args, 2).ok_or_else(|| "missing config path".to_string())?;
            let mut yaml = config_yaml(&app, &path)?;
            if !matches!(yaml, serde_yaml::Value::Mapping(_)) {
                yaml = serde_yaml::Value::Mapping(Default::default());
            }
            if let serde_yaml::Value::Mapping(map) = &mut yaml {
                map.insert(
                    yaml_key("proxy-providers"),
                    serde_yaml::to_value(args.first().cloned().unwrap_or_else(|| json!({})))
                        .map_err(|err| err.to_string())?,
                );
                map.insert(
                    yaml_key("rule-providers"),
                    serde_yaml::to_value(args.get(1).cloned().unwrap_or_else(|| json!({})))
                        .map_err(|err| err.to_string())?,
                );
            }
            save_config_yaml(&app, &path, &yaml)?;
            Ok(success(json!({})))
        }
        "getProxiesConfig" => {
            let path = arg_string(&args, 0).ok_or_else(|| "missing config path".to_string())?;
            let yaml = config_yaml(&app, &path)?;
            Ok(success(json!({
                "proxies": serde_json::to_value(yaml.get("proxies").cloned().unwrap_or(serde_yaml::Value::Sequence(vec![]))).unwrap_or(json!([]))
            })))
        }
        "saveProxiesConfig" => yaml_save_section(
            &app,
            arg_string(&args, 1),
            "proxies",
            args.first().cloned().unwrap_or_else(|| json!([])),
        ),

        "getActiveConfig" => {
            let active = state
                .runtime
                .lock()
                .expect("runtime mutex poisoned")
                .active_config
                .clone()
                .or(read_last_config(&app)?);
            Ok(active.map(Value::String).unwrap_or(Value::Null))
        }
        "setPreferredConfig" | "saveLastConfig" => {
            let config_path = arg_string(&args, 0).unwrap_or_default();
            save_last_config(&app, &config_path)?;
            state
                .runtime
                .lock()
                .expect("runtime mutex poisoned")
                .active_config = Some(config_path);
            Ok(success(json!({})))
        }
        "startMihomo" => {
            let config_path = arg_string(&args, 0).unwrap_or_default();
            start_mihomo(&app, &state, &config_path).await
        }
        "stopMihomo" => {
            stop_mihomo_process(&state);
            Ok(json!({ "success": true }))
        }
        "restartService" | "reloadMihomoConfig" => {
            let config_path = arg_string(&args, 0)
                .or_else(|| read_last_config(&app).ok().flatten())
                .unwrap_or_default();
            start_mihomo(&app, &state, &config_path).await
        }
        "isMihomoRunning" => Ok(Value::Bool(is_mihomo_running(&state))),
        "getTrafficStats" => Ok(get_traffic_stats(&app, &state).await),
        "fetchConnectionsInfo" => Ok(fetch_connections_info(&app).await),
        "getConfigOrder" => {
            let active = state
                .runtime
                .lock()
                .expect("runtime mutex poisoned")
                .active_config
                .clone()
                .or(read_last_config(&app)?);
            Ok(parse_config_order(&app, active))
        }
        "getProxyNodes" | "getProxies" => {
            let response = request_http(&app, Some("/proxies".to_string()), None).await?;
            Ok(response.get("data").cloned().unwrap_or(response))
        }
        "selectNode" | "selectGroupNode" | "switchNode" => {
            let node = arg_string(&args, 0).unwrap_or_default();
            let group = arg_string(&args, 1).unwrap_or_else(|| "GLOBAL".to_string());
            let endpoint = format!("/proxies/{}", urlencoding::encode(&group));
            let body = json!({ "name": node });
            let response = request_http(
                &app,
                Some(endpoint),
                Some(json!({ "method": "PUT", "body": body })),
            )
            .await?;
            if response.get("ok").and_then(Value::as_bool).unwrap_or(false) {
                Ok(success(json!({ "nodeName": node, "groupName": group })))
            } else {
                Ok(
                    json!({ "success": false, "error": response.get("text").cloned().unwrap_or(Value::String("切换节点失败".to_string())) }),
                )
            }
        }
        "notifyNodeChanged" => Ok(success(json!({}))),
        "testNodeDelay" => {
            let node = arg_string(&args, 0).unwrap_or_default();
            let endpoint = format!(
                "/proxies/{}/delay?timeout=5000&url={}",
                urlencoding::encode(&node),
                urlencoding::encode("https://www.gstatic.com/generate_204")
            );
            let response = request_http(&app, Some(endpoint), None).await?;
            Ok(response
                .get("data")
                .and_then(|data| data.get("delay"))
                .cloned()
                .unwrap_or(json!(-1)))
        }
        "getProxyProviders" | "get-proxy-providers" => {
            let response = request_http(&app, Some("/providers/proxies".to_string()), None).await?;
            Ok(success(
                json!({ "data": response.get("data").cloned().unwrap_or(response) }),
            ))
        }
        "updateProxyProvider" | "update-proxy-provider" => {
            let name = arg_string(&args, 0).unwrap_or_default();
            let endpoint = format!("/providers/proxies/{}", urlencoding::encode(&name));
            let _ = request_http(&app, Some(endpoint), Some(json!({ "method": "PUT" }))).await?;
            Ok(success(json!({})))
        }
        "getRuleProviders" | "get-rule-providers" => {
            let response = request_http(&app, Some("/providers/rules".to_string()), None).await?;
            Ok(success(
                json!({ "data": response.get("data").cloned().unwrap_or(response) }),
            ))
        }
        "updateRuleProvider" | "update-rule-provider" => {
            let name = arg_string(&args, 0).unwrap_or_default();
            let endpoint = format!("/providers/rules/{}", urlencoding::encode(&name));
            let _ = request_http(&app, Some(endpoint), Some(json!({ "method": "PUT" }))).await?;
            Ok(success(json!({})))
        }
        "getRuntimeConfig" => request_http(&app, Some("/configs".to_string()), None).await,
        "getCurrentConfigName" => {
            let active = read_last_config(&app)?;
            let name = active
                .as_deref()
                .and_then(|path| Path::new(path).file_name())
                .and_then(|name| name.to_str())
                .map(ToString::to_string);
            Ok(success(json!({ "configName": name })))
        }

        "getApiConfig" => Ok(success(json!({
            "controllerHost": controller_host(&app),
            "controllerPort": controller_port(&app).to_string(),
            "secret": controller_secret(&app)
        }))),
        "requestMihomoAPI" => request_http(&app, arg_string(&args, 0), args.get(1).cloned()).await,
        "proxyFetch" => request_http(&app, arg_string(&args, 0), args.get(1).cloned()).await,
        "fetchWithProxy" => request_http(&app, None, args.first().cloned()).await,

        "openExternal" | "openFile" => {
            if let Some(target) = arg_string(&args, 0) {
                open::that(target).map_err(|err| err.to_string())?;
            }
            Ok(success(json!({})))
        }
        "openFileLocation" => {
            if let Some(target) = arg_string(&args, 0) {
                let path = PathBuf::from(target);
                if let Some(parent) = path.parent() {
                    open::that(parent).map_err(|err| err.to_string())?;
                }
            }
            Ok(success(json!({})))
        }

        "window-minimize" | "minimizeWindow" => {
            window.minimize().map_err(|err| err.to_string())?;
            Ok(success(json!({})))
        }
        "window-toggle-maximize" | "maximizeWindow" => {
            if window.is_maximized().map_err(|err| err.to_string())? {
                window.unmaximize().map_err(|err| err.to_string())?;
                Ok(success(json!({ "maximized": false })))
            } else {
                window.maximize().map_err(|err| err.to_string())?;
                Ok(success(json!({ "maximized": true })))
            }
        }
        "window-close" | "closeWindow" => {
            window.close().map_err(|err| err.to_string())?;
            Ok(success(json!({})))
        }
        "getWindowState" => Ok(success(json!({
            "isMaximized": window.is_maximized().unwrap_or(false),
            "isFullscreen": window.is_fullscreen().unwrap_or(false)
        }))),

        "getProxyStatus" => Ok(Value::Bool(
            setting(&app, "systemProxyEnabled", json!(false))?
                .as_bool()
                .unwrap_or(false),
        )),
        "toggleSystemProxy" => {
            let enabled = arg_bool(&args, 0).unwrap_or(false);
            let port = setting(&app, "mixed-port", json!(7890))?
                .as_u64()
                .unwrap_or(7890) as u16;
            set_windows_proxy(enabled, "127.0.0.1", port)?;
            set_setting(&app, "systemProxyEnabled", json!(enabled))?;
            Ok(Value::Bool(enabled))
        }
        "getTunStatus" => Ok(Value::Bool(
            setting(&app, "tunModeEnabled", json!(false))?
                .as_bool()
                .unwrap_or(false),
        )),
        "toggleTunMode" => {
            let enabled = arg_bool(&args, 0).unwrap_or(false);
            set_setting(&app, "tunModeEnabled", json!(enabled))?;
            Ok(Value::Bool(enabled))
        }
        "getTunConfig" => Ok(success(json!({
            "config": setting(&app, "tunConfig", json!({
                "enable": false,
                "device": if cfg!(target_os = "macos") { "utun" } else { "mihomo" },
                "stack": "system",
                "autoRoute": true,
                "autoRedirect": false,
                "autoDetectInterface": true,
                "dnsHijack": ["any:53"],
                "strictRoute": false,
                "routeExcludeAddress": [],
                "mtu": 1500
            }))?
        }))),
        "saveTunConfig" => {
            set_setting(
                &app,
                "tunConfig",
                args.first().cloned().unwrap_or_else(|| json!({})),
            )?;
            Ok(success(json!({})))
        }
        "getProxySettings" => Ok(success(json!({
            "settings": setting(&app, "proxySettings", json!({}))?
        }))),
        "saveProxySettings" => {
            set_setting(
                &app,
                "proxySettings",
                args.first().cloned().unwrap_or_else(|| json!({})),
            )?;
            Ok(success(json!({ "message": "saved" })))
        }
        "saveUASettings" => {
            let ua = arg_string(&args, 0).unwrap_or_else(|| "FlyClash".to_string());
            set_setting(&app, "subscription-ua", json!(ua))?;
            Ok(success(json!({ "message": "saved" })))
        }
        "getTrafficToday" | "traffic-history:get-today" => Ok(success(
            json!({ "data": traffic_by_date(&app, &today_key())? }),
        )),
        "getTrafficByDate" | "traffic-history:get-by-date" => {
            let date = arg_string(&args, 0).unwrap_or_else(today_key);
            Ok(success(json!({ "data": traffic_by_date(&app, &date)? })))
        }
        "getTrafficMonth" | "traffic-history:get-month" => {
            let prefix =
                arg_string(&args, 0).unwrap_or_else(|| today_key().chars().take(7).collect());
            Ok(success(
                json!({ "data": traffic_rows(&app, Some(prefix))? }),
            ))
        }
        "getTrafficYear" | "traffic-history:get-year" => {
            let prefix =
                arg_string(&args, 0).unwrap_or_else(|| today_key().chars().take(4).collect());
            Ok(success(
                json!({ "data": traffic_rows(&app, Some(prefix))? }),
            ))
        }
        "proxyIcon.getConfig" | "proxy-icon:get-config" => {
            Ok(success(json!({ "config": proxy_icon_config(&app)? })))
        }
        "proxyIcon.saveConfig" | "proxy-icon:save-config" => save_proxy_icon_config(
            &app,
            args.first()
                .cloned()
                .unwrap_or_else(proxy_icon_default_config),
        ),
        "proxyIcon.addRule" | "proxy-icon:add-rule" => proxy_icon_rule_update(
            &app,
            None,
            args.first().cloned().unwrap_or_else(|| json!({})),
            "add",
        ),
        "proxyIcon.updateRule" | "proxy-icon:update-rule" => {
            let (rule_id, updates) = if args.first().and_then(Value::as_str).is_some() {
                (
                    arg_string(&args, 0),
                    args.get(1).cloned().unwrap_or_else(|| json!({})),
                )
            } else {
                let rule = args.first().cloned().unwrap_or_else(|| json!({}));
                (
                    rule.get("id")
                        .and_then(Value::as_str)
                        .map(ToString::to_string),
                    rule,
                )
            };
            proxy_icon_rule_update(&app, rule_id, updates, "update")
        }
        "proxyIcon.deleteRule" | "proxy-icon:delete-rule" => {
            proxy_icon_rule_update(&app, arg_string(&args, 0), Value::Null, "delete")
        }
        "proxyIcon.toggleRule" | "proxy-icon:toggle-rule" => proxy_icon_rule_update(
            &app,
            arg_string(&args, 0),
            Value::Bool(arg_bool(&args, 1).unwrap_or(false)),
            "toggle",
        ),
        "proxyIcon.clearCache"
        | "proxy-icon:clear-cache"
        | "configIcon.clearCache"
        | "config-icon:clear-cache" => Ok(success(json!({}))),
        "proxyIcon.getGroupIcon" | "proxy-icon:get-group-icon" => proxy_group_icon(
            &app,
            &arg_string(&args, 0).unwrap_or_default(),
            arg_string(&args, 1),
        ),
        "configIcon.getIcon" | "config-icon:get-icon" => {
            Ok(success(json!({ "iconPath": arg_string(&args, 0) })))
        }
        "configIcon.getCacheSize" | "config-icon:get-cache-size" => {
            Ok(success(json!({ "size": 0 })))
        }
        "getOverrides" | "override:getItems" => Ok(json!(all_overrides(&app)?)),
        "addOverride" | "override:addItem" => {
            override_add(&app, args.first().cloned().unwrap_or_else(|| json!({})))
        }
        "updateOverride" | "override:updateItem" => override_update(
            &app,
            &arg_string(&args, 0).unwrap_or_default(),
            args.get(1).cloned().unwrap_or_else(|| json!({})),
        ),
        "deleteOverride" | "override:deleteItem" => {
            let id = arg_string(&args, 0).unwrap_or_default();
            db(&app)?
                .execute("DELETE FROM overrides WHERE id = ?1", params![id])
                .map_err(|err| err.to_string())?;
            Ok(Value::Null)
        }
        "getOverrideFileContent" | "override:getFileContent" => Ok(Value::String(
            override_content(&app, &arg_string(&args, 0).unwrap_or_default())?,
        )),
        "updateOverrideFileContent" | "override:updateFileContent" => {
            let id = arg_string(&args, 0).unwrap_or_default();
            let content = arg_string(&args, 1).unwrap_or_default();
            let item = all_overrides(&app)?
                .into_iter()
                .find(|item| item.get("id").and_then(Value::as_str) == Some(id.as_str()))
                .ok_or_else(|| "覆写项不存在".to_string())?;
            save_override_item(&app, &item, Some(&content))?;
            Ok(Value::Null)
        }
        "updateRemoteOverride" | "override:updateRemoteItem" => {
            override_update_remote(&app, &arg_string(&args, 0).unwrap_or_default()).await
        }
        "reorderOverrides" | "override:reorderItems" => {
            let ids = args
                .first()
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let conn = db(&app)?;
            for (index, id) in ids.iter().filter_map(Value::as_str).enumerate() {
                conn.execute(
                    "UPDATE overrides SET sort_order = ?1 WHERE id = ?2",
                    params![index as i64, id],
                )
                .map_err(|err| err.to_string())?;
            }
            Ok(Value::Null)
        }
        "backupCreateLocal" | "backup-create-local" => create_backup_zip(
            &app,
            &arg_string(&args, 0).unwrap_or_else(|| "CONFIG_ONLY".to_string()),
        ),
        "backupRestoreLocal" | "backup-restore-local" => {
            let backup = latest_backup(&app)?.ok_or_else(|| "没有可还原的本地备份".to_string())?;
            restore_backup_zip(&app, &backup)
        }
        "backupWebDAVSaveConfig" | "backup-webdav-save-config" => {
            let config = args.first().cloned().unwrap_or_else(|| json!({}));
            set_setting(
                &app,
                "webdav_uri",
                config.get("uri").cloned().unwrap_or(json!("")),
            )?;
            set_setting(
                &app,
                "webdav_username",
                config.get("username").cloned().unwrap_or(json!("")),
            )?;
            set_setting(
                &app,
                "webdav_password",
                config.get("password").cloned().unwrap_or(json!("")),
            )?;
            set_setting(
                &app,
                "webdav_backup_dir",
                config
                    .get("backupDirectory")
                    .cloned()
                    .unwrap_or(json!("FlyClash")),
            )?;
            set_setting(
                &app,
                "webdav_backup_filename",
                config
                    .get("fileName")
                    .cloned()
                    .unwrap_or(json!("flyclash_backup.zip")),
            )?;
            Ok(success(json!({})))
        }
        "backupWebDAVGetConfig" | "backup-webdav-get-config" => {
            Ok(success(json!({ "config": webdav_config(&app)? })))
        }
        "backupWebDAVTest" | "backup-webdav-test" => {
            let config = args
                .first()
                .cloned()
                .unwrap_or_else(|| webdav_config(&app).unwrap_or_else(|_| json!({})));
            let url = webdav_url(&config, None)?;
            let result = webdav_request(&app, "PROPFIND", url, None).await?;
            Ok(success(
                json!({ "success": result.get("success").and_then(Value::as_bool).unwrap_or(false) }),
            ))
        }
        "backupWebDAVUpload" | "backup-webdav-upload" => {
            let local = create_backup_zip(
                &app,
                &arg_string(&args, 0).unwrap_or_else(|| "CONFIG_ONLY".to_string()),
            )?;
            let file_path = local
                .get("filePath")
                .and_then(Value::as_str)
                .ok_or_else(|| "备份创建失败".to_string())?;
            let config = webdav_config(&app)?;
            let file_name = config
                .get("fileName")
                .and_then(Value::as_str)
                .unwrap_or("flyclash_backup.zip");
            let _ = webdav_request(&app, "MKCOL", webdav_url(&config, None)?, None).await;
            let bytes = fs::read(file_path).map_err(|err| err.to_string())?;
            let result = webdav_request(
                &app,
                "PUT",
                webdav_url(&config, Some(file_name))?,
                Some(bytes),
            )
            .await?;
            Ok(success(
                json!({ "fileName": file_name, "uploaded": result.get("success").cloned().unwrap_or(Value::Bool(false)) }),
            ))
        }
        "backupWebDAVDownload" | "backup-webdav-download" => {
            let config = webdav_config(&app)?;
            let file_name = arg_string(&args, 0)
                .or_else(|| {
                    config
                        .get("fileName")
                        .and_then(Value::as_str)
                        .map(ToString::to_string)
                })
                .unwrap_or_else(|| "flyclash_backup.zip".to_string());
            let url = webdav_url(&config, Some(&file_name))?;
            let client = reqwest::Client::new();
            let bytes = client
                .get(url)
                .send()
                .await
                .map_err(|err| err.to_string())?
                .bytes()
                .await
                .map_err(|err| err.to_string())?;
            let path = backup_dir(&app)?.join(&file_name);
            fs::write(&path, bytes).map_err(|err| err.to_string())?;
            restore_backup_zip(&app, &path)
        }
        "backupWebDAVList" | "backup-webdav-list" => {
            let config = webdav_config(&app)?;
            let result = webdav_request(&app, "PROPFIND", webdav_url(&config, None)?, None).await?;
            let text = result.get("text").and_then(Value::as_str).unwrap_or("");
            let href_re = Regex::new(r"(?i)<[^:>]*:?href>([^<]+)</[^:>]*:?href>")
                .map_err(|err| err.to_string())?;
            let size_re =
                Regex::new(r"(?i)<[^:>]*:?getcontentlength>(\d+)</[^:>]*:?getcontentlength>")
                    .map_err(|err| err.to_string())?;
            let modified_re =
                Regex::new(r"(?i)<[^:>]*:?getlastmodified>([^<]+)</[^:>]*:?getlastmodified>")
                    .map_err(|err| err.to_string())?;
            let sizes = size_re
                .captures_iter(text)
                .filter_map(|capture| capture.get(1).and_then(|m| m.as_str().parse::<u64>().ok()))
                .collect::<Vec<_>>();
            let modified = modified_re
                .captures_iter(text)
                .filter_map(|capture| capture.get(1).map(|m| m.as_str().to_string()))
                .collect::<Vec<_>>();
            let backups = href_re
                .captures_iter(text)
                .filter_map(|capture| capture.get(1).map(|m| m.as_str().to_string()))
                .filter_map(|href| {
                    let decoded = href.replace("%20", " ");
                    let name = decoded.rsplit('/').next()?.to_string();
                    name.ends_with(".zip").then_some(name)
                })
                .enumerate()
                .map(|(index, name)| {
                    json!({
                        "name": name,
                        "size": sizes.get(index).copied().unwrap_or(0),
                        "lastModified": modified.get(index).cloned().unwrap_or_default()
                    })
                })
                .collect::<Vec<_>>();
            Ok(success(json!({ "backups": backups })))
        }
        "backupWebDAVDelete" | "backup-webdav-delete" => {
            let config = webdav_config(&app)?;
            let file_name = arg_string(&args, 0).unwrap_or_default();
            let result =
                webdav_request(&app, "DELETE", webdav_url(&config, Some(&file_name))?, None)
                    .await?;
            Ok(success(
                json!({ "deleted": result.get("success").cloned().unwrap_or(Value::Bool(false)) }),
            ))
        }
        "converter.fetchUrl" | "converter:fetch-url" => {
            let url = arg_string(&args, 0).unwrap_or_default();
            let text = reqwest::Client::builder()
                .danger_accept_invalid_certs(true)
                .timeout(Duration::from_secs(30))
                .build()
                .map_err(|err| err.to_string())?
                .get(url)
                .send()
                .await
                .map_err(|err| err.to_string())?
                .text()
                .await
                .map_err(|err| err.to_string())?;
            Ok(success(json!({ "content": text })))
        }
        "converter.parseProxies" | "converter:parse-proxies" => {
            Ok(parse_proxy_names(&arg_string(&args, 0).unwrap_or_default()))
        }
        "converter.getTemplates" | "converter:get-templates" => {
            Ok(success(json!({ "templates": converter_templates() })))
        }
        "converter.getTemplate" | "converter:get-template" => {
            let id = arg_string(&args, 0).unwrap_or_else(|| "mihomo-default".to_string());
            let template = converter_templates()
                .as_array()
                .and_then(|items| {
                    items
                        .iter()
                        .find(|item| item.get("id").and_then(Value::as_str) == Some(id.as_str()))
                })
                .cloned()
                .unwrap_or_else(|| json!({ "id": id, "name": id }));
            Ok(success(json!({ "template": template })))
        }
        "converter.getSettings" | "converter:get-settings" => Ok(success(json!({
            "settings": setting(&app, "converterSettings", json!({}))?
        }))),
        "converter.saveSettings" | "converter:save-settings" => {
            set_setting(
                &app,
                "converterSettings",
                args.first().cloned().unwrap_or_else(|| json!({})),
            )?;
            Ok(success(json!({})))
        }
        "converter.serverStatus" | "converter:server-status" => Ok(success(json!({
            "running": false,
            "mode": "embedded"
        }))),
        "converter.startServer"
        | "converter:start-server"
        | "converter.stopServer"
        | "converter:stop-server" => Ok(success(json!({ "running": false, "mode": "embedded" }))),
        "converter.convert"
        | "converter.convertWithTemplate"
        | "converter:convert"
        | "converter:convert-with-template" => {
            let params = args.first().cloned().unwrap_or_else(|| json!({}));
            let content = params
                .get("content")
                .or_else(|| params.get("input"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            Ok(success(json!({
                "content": content,
                "result": content,
                "proxies": parse_proxy_names(&content).get("proxies").cloned().unwrap_or(json!([]))
            })))
        }
        "converter.createSubscription"
        | "converter:create-subscription"
        | "converter.addToConfig"
        | "converter:add-to-config" => {
            let params = args.first().cloned().unwrap_or_else(|| json!({}));
            let name = params
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("Converted");
            let url = params
                .get("url")
                .and_then(Value::as_str)
                .map(ToString::to_string);
            let content = if let Some(content) = params.get("content").and_then(Value::as_str) {
                content.to_string()
            } else if let Some(url) = url.as_deref() {
                reqwest::get(url)
                    .await
                    .map_err(|err| err.to_string())?
                    .text()
                    .await
                    .map_err(|err| err.to_string())?
            } else {
                String::new()
            };
            save_subscription(&app, url, content, Some(name.to_string()), None)
        }
        "converter.listSubscriptions" | "converter:list-subscriptions" => Ok(success(json!({
            "subscriptions": read_subscriptions(&app)?
        }))),
        "converter.deleteSubscription" | "converter:delete-subscription" => {
            delete_subscription(&app, &arg_string(&args, 0).unwrap_or_default())
        }
        "loopback.getApps" | "loopback:get-apps" => loopback_apps(&app),
        "loopback.saveConfig" | "loopback:save-config" => {
            let sids = args
                .first()
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .filter_map(|value| value.as_str().map(ToString::to_string))
                .collect();
            loopback_set(&app, sids)
        }
        "loopback.addExemption" | "loopback:add-exemption" => {
            let mut sids = setting(&app, "loopbackExemptSids", json!([]))?
                .as_array()
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .filter_map(|value| value.as_str().map(ToString::to_string))
                .collect::<Vec<_>>();
            if let Some(sid) = arg_string(&args, 0) {
                if !sids.contains(&sid) {
                    sids.push(sid);
                }
            }
            loopback_set(&app, sids)
        }
        "loopback.removeExemption" | "loopback:remove-exemption" => {
            let sid = arg_string(&args, 0).unwrap_or_default();
            let sids = setting(&app, "loopbackExemptSids", json!([]))?
                .as_array()
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .filter_map(|value| value.as_str().map(ToString::to_string))
                .filter(|value| value != &sid)
                .collect();
            loopback_set(&app, sids)
        }
        "checkElevateTask" => Ok(Value::Bool(
            setting(&app, "tunElevateTask", json!(false))?
                .as_bool()
                .unwrap_or(false),
        )),
        "deleteElevateTask" => {
            set_setting(&app, "tunElevateTask", json!(false))?;
            Ok(success(json!({})))
        }
        "grantTunPermissions" => {
            set_setting(&app, "tunElevateTask", json!(true))?;
            Ok(success(json!({
                "message": "TUN 权限状态已保存；Windows 服务模式可在服务设置中安装",
                "needRestart": false
            })))
        }
        "checkCorePermission" => Ok(success(json!({
            "hasPermission": find_mihomo_executable(&app).map(|path| path.exists()).unwrap_or(false)
        }))),
        "revokeCorePermission" => Ok(success(json!({}))),
        "getTunElevationMode" => Ok(success(json!({
            "mode": setting(&app, "tunElevationMode", json!("service"))?
        }))),
        "setTunElevationMode" => {
            let mode = arg_string(&args, 0).unwrap_or_else(|| "service".to_string());
            set_setting(&app, "tunElevationMode", json!(mode))?;
            Ok(success(json!({})))
        }
        "getTunServiceStatus" | "serviceIsRunning" => Ok(service_status()),
        "installTunService" | "serviceInstall" => {
            if !cfg!(target_os = "windows") {
                Ok(json!({ "success": false, "error": "当前平台不支持 Windows 服务" }))
            } else {
                let exe = std::env::current_exe().map_err(|err| err.to_string())?;
                let bin_path = format!("\"{}\" --service", exe.to_string_lossy());
                match command_output(
                    "sc",
                    &[
                        "create",
                        "FlyClashTun",
                        "binPath=",
                        &bin_path,
                        "start=",
                        "demand",
                        "DisplayName=",
                        "FlyClash TUN Service",
                    ],
                ) {
                    Ok(_) => Ok(success(json!({ "message": "service installed" }))),
                    Err(error) => Ok(json!({ "success": false, "error": error })),
                }
            }
        }
        "uninstallTunService" | "serviceUninstall" => {
            if !cfg!(target_os = "windows") {
                Ok(json!({ "success": false, "error": "当前平台不支持 Windows 服务" }))
            } else {
                let _ = command_output("sc", &["stop", "FlyClashTun"]);
                match command_output("sc", &["delete", "FlyClashTun"]) {
                    Ok(_) => Ok(success(json!({ "message": "service uninstalled" }))),
                    Err(error) => Ok(json!({ "success": false, "error": error })),
                }
            }
        }
        "startTunService" => {
            if !cfg!(target_os = "windows") {
                Ok(json!({ "success": false, "error": "当前平台不支持 Windows 服务" }))
            } else {
                match command_output("sc", &["start", "FlyClashTun"]) {
                    Ok(_) => Ok(success(json!({ "message": "service started" }))),
                    Err(error) => Ok(json!({ "success": false, "error": error })),
                }
            }
        }
        "stopTunService" => {
            if !cfg!(target_os = "windows") {
                Ok(json!({ "success": false, "error": "当前平台不支持 Windows 服务" }))
            } else {
                match command_output("sc", &["stop", "FlyClashTun"]) {
                    Ok(_) => Ok(success(json!({ "message": "service stopped" }))),
                    Err(error) => Ok(json!({ "success": false, "error": error })),
                }
            }
        }
        "getProxyConfig" => Ok(success(
            json!({ "data": { "host": "127.0.0.1", "port": 7890 } }),
        )),
        "getKernelPath" => {
            let path = find_mihomo_executable(&app)?;
            Ok(success(json!({
                "path": path.to_string_lossy(),
                "isDefault": true,
                "exists": path.exists()
            })))
        }
        "selectKernelExecutable" => {
            let path = find_mihomo_executable(&app)?;
            set_setting(&app, "core_custom_path", json!(path.to_string_lossy()))?;
            Ok(success(json!({
                "path": path.to_string_lossy(),
                "needsRestart": true,
                "canceled": false
            })))
        }
        "resetKernelPath" => {
            set_setting(&app, "core_custom_path", Value::Null)?;
            let path = find_mihomo_executable(&app)?;
            Ok(success(json!({
                "path": path.to_string_lossy(),
                "needsRestart": true
            })))
        }
        "setAutoStart" | "setAutoLaunch" => {
            let enabled = arg_bool(&args, 0).unwrap_or(false);
            set_autostart(&app, enabled)?;
            Ok(Value::Bool(enabled))
        }
        "getAutoStart" | "getAutoLaunchState" => Ok(Value::Bool(
            setting(&app, "autoStart", json!(false))?
                .as_bool()
                .unwrap_or(false),
        )),
        "setSilentStart" => {
            set_setting(
                &app,
                "silentStart",
                json!(arg_bool(&args, 0).unwrap_or(false)),
            )?;
            Ok(success(json!({})))
        }
        "getSilentStart" => Ok(success(json!({
            "silentStart": setting(&app, "silentStart", json!(false))?
        }))),
        "aiProxyFetch" => {
            let config = args.first().cloned().unwrap_or_else(|| json!({}));
            let response = request_http(&app, None, Some(config)).await?;
            Ok(json!({
                "ok": response.get("ok").and_then(Value::as_bool).unwrap_or(false),
                "status": response.get("status").and_then(Value::as_u64).unwrap_or(0),
                "body": response.get("text").and_then(Value::as_str).unwrap_or("").to_string()
            }))
        }
        "aiProxyStreamStart" => {
            let config = args.first().cloned().unwrap_or_else(|| json!({}));
            let request_id = config
                .get("requestId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let response = request_http(&app, None, Some(config)).await?;
            let ok = response.get("ok").and_then(Value::as_bool).unwrap_or(false);
            let status = response.get("status").and_then(Value::as_u64).unwrap_or(0);
            let body = response
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or("")
                .as_bytes()
                .to_vec();
            if ok {
                let _ = window.emit(
                    "ai-proxy-stream-chunk",
                    json!({ "requestId": request_id, "chunk": body }),
                );
                let _ = window.emit("ai-proxy-stream-end", json!({ "requestId": request_id }));
                Ok(json!({ "ok": true, "status": status }))
            } else {
                let error_body = response
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let _ = window.emit(
                    "ai-proxy-stream-error",
                    json!({ "requestId": request_id, "error": error_body }),
                );
                Ok(json!({ "ok": false, "status": status, "errorBody": error_body }))
            }
        }
        "aiProxyStreamAbort" => Ok(Value::Null),
        "runSpeedtest" | "runSpeedtestDirect" => simple_speedtest(&app, false).await,
        "runProxySpeedtest" => {
            let url = args
                .first()
                .and_then(|value| value.get("url"))
                .and_then(Value::as_str)
                .unwrap_or("https://speed.cloudflare.com/__down?bytes=1000000");
            let started = now_millis();
            let response = request_http(
                &app,
                None,
                Some(json!({ "url": url, "method": "GET", "timeout": 30000 })),
            )
            .await?;
            let duration = ((now_millis().saturating_sub(started)) as f64 / 1000.0).max(0.001);
            let bytes = response
                .get("text")
                .and_then(Value::as_str)
                .map(|text| text.len() as u64)
                .unwrap_or(0);
            Ok(success(json!({ "data": {
                "downloadSpeed": bytes as f64 / duration,
                "bytesReceived": bytes,
                "duration": duration,
                "url": url
            }})))
        }
        "testUdpConnectivity" => Ok(success(json!({
            "udpType": "unknown",
            "successCount": 0,
            "details": [],
            "error": "UDP connectivity probing requires raw socket privileges; Tauri runtime kept the request non-destructive"
        }))),

        _ => Ok(unsupported(method)),
    }
}

fn main() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![tauri_compat_call])
        .run(tauri::generate_context!())
        .expect("error while running FlyClash Tauri application");
}
