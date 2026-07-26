use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose, Engine as _};
use rusqlite::{params, Connection};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::{fs, path::PathBuf};
use tauri::{AppHandle, Manager};

pub(crate) fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|err| err.to_string())?;
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    Ok(dir)
}

pub(crate) fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app_data_dir(app)?.join("config");
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    Ok(dir)
}

pub(crate) fn database_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(config_dir(app)?.join("flyclash.db"))
}

pub(crate) fn encryption_key_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join(".runtime-key"))
}

fn load_or_create_key_material(app: &AppHandle) -> Result<Vec<u8>, String> {
    let key_path = encryption_key_path(app)?;
    if key_path.exists() {
        return fs::read(key_path).map_err(|err| err.to_string());
    }

    let mut seed = [0u8; 32];
    getrandom::getrandom(&mut seed).map_err(|err| err.to_string())?;
    fs::write(key_path, seed).map_err(|err| err.to_string())?;
    Ok(seed.to_vec())
}

fn key_from_material(material: &[u8]) -> [u8; 32] {
    if material.len() == 32 {
        let mut key = [0u8; 32];
        key.copy_from_slice(material);
        return key;
    }

    let digest = Sha256::digest(material);
    let mut key = [0u8; 32];
    key.copy_from_slice(&digest);
    key
}

fn legacy_hashed_key_from_material(material: &[u8]) -> [u8; 32] {
    let digest = Sha256::digest(material);
    let mut key = [0u8; 32];
    key.copy_from_slice(&digest);
    key
}

fn load_or_create_key(app: &AppHandle) -> Result<[u8; 32], String> {
    let material = load_or_create_key_material(app)?;
    Ok(key_from_material(&material))
}

fn decrypt_payload_with_key(key: &[u8; 32], payload: &[u8]) -> Result<String, String> {
    if payload.len() < 13 {
        return Err("encrypted payload is too short".to_string());
    }

    let (nonce, cipher_text) = payload.split_at(12);
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|err| err.to_string())?;
    let plain = cipher
        .decrypt(Nonce::from_slice(nonce), cipher_text)
        .map_err(|err| err.to_string())?;
    String::from_utf8(plain).map_err(|err| err.to_string())
}

pub(crate) fn encrypt_text(app: &AppHandle, plain: &str) -> Result<String, String> {
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

pub(crate) fn decrypt_text_with_status(
    app: &AppHandle,
    encoded: &str,
) -> Result<(String, bool), String> {
    let payload = general_purpose::STANDARD
        .decode(encoded)
        .map_err(|err| err.to_string())?;
    let material = load_or_create_key_material(app)?;
    let primary_key = key_from_material(&material);

    match decrypt_payload_with_key(&primary_key, &payload) {
        Ok(plain) => Ok((plain, false)),
        Err(primary_error) => {
            let legacy_key = legacy_hashed_key_from_material(&material);
            if legacy_key != primary_key {
                if let Ok(plain) = decrypt_payload_with_key(&legacy_key, &payload) {
                    return Ok((plain, true));
                }
            }
            Err(primary_error)
        }
    }
}

pub(crate) fn decrypt_text(app: &AppHandle, encoded: &str) -> Result<String, String> {
    decrypt_text_with_status(app, encoded).map(|(plain, _)| plain)
}

pub(crate) fn db(app: &AppHandle) -> Result<Connection, String> {
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

pub(crate) fn read_settings(app: &AppHandle) -> Result<Map<String, Value>, String> {
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
            // 整数优先按 i64/u64 还原：f64 变体的 Number 会让
            // as_u64()/as_i64() 返回 None，整型设置将静默回退默认值
            "number" => raw
                .parse::<i64>()
                .ok()
                .map(|value| Value::Number(value.into()))
                .or_else(|| {
                    raw.parse::<f64>()
                        .ok()
                        .and_then(serde_json::Number::from_f64)
                        .map(Value::Number)
                })
                .unwrap_or(Value::Null),
            "boolean" => Value::Bool(raw == "true"),
            "json" => serde_json::from_str::<Value>(&raw).unwrap_or(Value::Null),
            _ => Value::String(raw),
        };
        settings.insert(key, value);
    }
    Ok(settings)
}

pub(crate) fn write_settings(app: &AppHandle, settings: &Map<String, Value>) -> Result<(), String> {
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

pub(crate) fn setting(app: &AppHandle, key: &str, fallback: Value) -> Result<Value, String> {
    let settings = read_settings(app)?;
    Ok(settings.get(key).cloned().unwrap_or(fallback))
}

pub(crate) fn set_setting(app: &AppHandle, key: &str, value: Value) -> Result<(), String> {
    // 单键直写。此前的「全量读出→改一键→整表回写」在并发保存两个不同
    // 设置时会互相覆盖，还会把解析失败读成 Null 的旧值固化回库
    let (raw, kind) = serialize_setting_value(&value);
    db(app)?
        .execute(
            "INSERT OR REPLACE INTO settings (key, value, type) VALUES (?1, ?2, ?3)",
            params![key, raw, kind],
        )
        .map_err(|err| err.to_string())?;
    Ok(())
}
