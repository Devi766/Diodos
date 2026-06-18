#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose, Engine as _};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::{
    fs, io,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager, State, WebviewWindow};

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

        CREATE INDEX IF NOT EXISTS idx_subscriptions_file_path ON subscriptions(file_path);
        CREATE INDEX IF NOT EXISTS idx_subscription_info_subscription_id ON subscription_info(subscription_id);
        CREATE INDEX IF NOT EXISTS idx_traffic_history_date ON traffic_history(date);
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
    runtime.last_traffic = Some(TrafficSnapshot {
        up,
        down,
        timestamp,
    });
    json!({
        "up": up,
        "down": down,
        "upSpeed": up_speed,
        "downSpeed": down_speed,
        "timestamp": timestamp
    })
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
        "checkElevateTask"
        | "deleteElevateTask"
        | "grantTunPermissions"
        | "checkCorePermission"
        | "revokeCorePermission"
        | "serviceIsRunning"
        | "serviceInstall"
        | "serviceUninstall"
        | "getTunElevationMode"
        | "setTunElevationMode"
        | "getTunServiceStatus"
        | "installTunService"
        | "uninstallTunService"
        | "startTunService"
        | "stopTunService" => Ok(success(json!({
            "supported": false,
            "hasPermission": false,
            "mode": "task",
            "error": "Tauri service/TUN elevation is not implemented yet"
        }))),
        "getProxyConfig" => Ok(success(
            json!({ "data": { "host": "127.0.0.1", "port": 7890 } }),
        )),

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
