#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose, Engine as _};
use boa_engine::{Context as JsContext, Source};
use flate2::read::GzDecoder;
use regex::Regex;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::{
    collections::{HashMap, HashSet},
    fs, io,
    io::{Read, Write},
    net::{IpAddr, SocketAddr, TcpListener, TcpStream, ToSocketAddrs, UdpSocket},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{mpsc, Mutex},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    window::{Color, Effect, EffectsBuilder},
    AppHandle, Emitter, Manager, State, WebviewWindow, WindowEvent,
};
use tauri_plugin_deep_link::DeepLinkExt;

mod core;

use crate::core::{
    config as core_config, controller as core_controller, identity as core_identity,
    lifecycle as core_lifecycle,
    manager::{CoreManager, RunningMode},
    service as core_service,
};

type CompatResult = Result<Value, String>;

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

const KERNEL_FIELDS: &[&str] = &[
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
];

const GEODATA_CONFIG_FIELDS: &[&str] = &[
    "geox-url",
    "geodata-mode",
    "geo-auto-update",
    "geo-update-interval",
];

const VERSION_CACHE_EXPIRE_MS: u128 = 5 * 60 * 1000;
const WINDOWS_ELEVATED_TASK_NAME: &str = "FlyClash-Elevated";
const DEFAULT_PROXY_BYPASS: &str = "localhost;127.*;192.168.*;10.*;172.16.*;172.17.*;172.18.*;172.19.*;172.20.*;172.21.*;172.22.*;172.23.*;172.24.*;172.25.*;172.26.*;172.27.*;172.28.*;172.29.*;172.30.*;172.31.*;<local>";
const TRAY_ID: &str = "main";
const TRAY_SWITCH_CONFIG_PREFIX: &str = "switch-config:";
const TRAY_MAX_CONFIG_ITEMS: usize = 24;
const MIHOMO_DATA_FILES: &[&str] = &[
    "geoip.metadb",
    "geosite.dat",
    "country.mmdb",
    "geoip.dat",
    "ASN.mmdb",
];

#[derive(Default)]
struct RuntimeState {
    core: CoreManager,
    current_node: Option<String>,
    last_traffic: Option<TrafficSnapshot>,
    converter_server: Option<ConverterServerHandle>,
    version_cache: HashMap<String, VersionCacheEntry>,
    ai_streams: HashMap<String, tokio::sync::oneshot::Sender<()>>,
    subscription_update_attempts: HashMap<String, u128>,
}

#[derive(Default)]
struct AppState {
    runtime: Mutex<RuntimeState>,
}

#[derive(Clone)]
struct VersionCacheEntry {
    versions: Vec<Value>,
    timestamp: u128,
}

struct ConverterServerHandle {
    port: u16,
    stop: mpsc::Sender<()>,
    thread: Option<thread::JoinHandle<()>>,
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
    #[serde(default)]
    proxy: Option<Value>,
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

fn electron_platform() -> &'static str {
    if cfg!(target_os = "windows") {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else if cfg!(target_os = "freebsd") {
        "freebsd"
    } else if cfg!(target_os = "openbsd") {
        "openbsd"
    } else {
        std::env::consts::OS
    }
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

fn push_unique_path(paths: &mut Vec<PathBuf>, path: PathBuf) {
    if !paths.iter().any(|item| item == &path) {
        paths.push(path);
    }
}

fn resource_roots(app: &AppHandle) -> Vec<PathBuf> {
    let mut roots = Vec::new();

    if let Ok(current) = std::env::current_dir() {
        push_unique_path(&mut roots, current.clone());
        push_unique_path(&mut roots, current.join(".."));
        push_unique_path(&mut roots, current.join("flycast-ui"));
    }

    push_unique_path(&mut roots, PathBuf::from("."));

    if let Ok(resource_dir) = app.path().resource_dir() {
        push_unique_path(&mut roots, resource_dir.clone());
        push_unique_path(&mut roots, resource_dir.join("_up_"));
        push_unique_path(&mut roots, resource_dir.join(".."));
    }

    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(exe_dir) = current_exe.parent() {
            push_unique_path(&mut roots, exe_dir.to_path_buf());
            push_unique_path(&mut roots, exe_dir.join("_up_"));
            push_unique_path(&mut roots, exe_dir.join(".."));
            push_unique_path(&mut roots, exe_dir.join("..").join("Resources"));
        }
    }
    roots
}

fn add_resource_candidates(paths: &mut Vec<PathBuf>, app: &AppHandle, relative: impl AsRef<Path>) {
    let relative = relative.as_ref();
    for root in resource_roots(app) {
        push_unique_path(paths, root.join(relative));
    }
    push_unique_path(paths, relative.to_path_buf());
}

fn existing_resource_dir(app: &AppHandle, relatives: &[&str]) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    for relative in relatives {
        add_resource_candidates(&mut candidates, app, relative);
    }
    candidates.into_iter().find(|path| path.is_dir())
}

fn existing_resource_file(app: &AppHandle, relatives: &[PathBuf]) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    for relative in relatives {
        add_resource_candidates(&mut candidates, app, relative);
    }
    candidates.into_iter().find(|path| path.is_file())
}

fn tool_dirs(app: &AppHandle) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    add_resource_candidates(&mut dirs, app, "tools");
    dirs
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

fn should_copy_bundled_file(source: &Path, target: &Path) -> bool {
    if !source.is_file() {
        return false;
    }
    match target.metadata() {
        Ok(metadata) => metadata.len() == 0,
        Err(_) => true,
    }
}

fn sync_bundled_mihomo_data(app: &AppHandle) -> Result<(), String> {
    let Some(source_dir) = existing_resource_dir(app, &["tools/data", "data"]) else {
        eprintln!("[mihomo-data] bundled tools/data directory not found; startup will continue");
        return Ok(());
    };

    let target_dir = mihomo_dir(app)?;
    for file_name in MIHOMO_DATA_FILES {
        let mut source = source_dir.join(file_name);
        if !source.is_file() && file_name.eq_ignore_ascii_case("country.mmdb") {
            let alias = source_dir.join("Country.mmdb");
            if alias.is_file() {
                source = alias;
            }
        }

        if !source.is_file() {
            eprintln!(
                "[mihomo-data] bundled data file missing: {}",
                source.display()
            );
            continue;
        }

        let target = target_dir.join(file_name);
        if should_copy_bundled_file(&source, &target) {
            fs::copy(&source, &target).map_err(|err| {
                format!(
                    "复制 Mihomo 数据文件 {} 到 {} 失败: {err}",
                    source.display(),
                    target.display()
                )
            })?;
        }

        if file_name.eq_ignore_ascii_case("country.mmdb") {
            let alias_target = target_dir.join("Country.mmdb");
            if should_copy_bundled_file(&source, &alias_target) {
                fs::copy(&source, &alias_target).map_err(|err| {
                    format!(
                        "复制 Mihomo 数据文件 {} 到 {} 失败: {err}",
                        source.display(),
                        alias_target.display()
                    )
                })?;
            }
        }
    }

    Ok(())
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

fn core_resource_status(app: &AppHandle) -> Value {
    let core = match find_mihomo_executable(app) {
        Ok(path) => json!({
            "available": true,
            "path": path_string(&path)
        }),
        Err(error) => json!({
            "available": false,
            "path": Value::Null,
            "error": error
        }),
    };

    let helper_required = cfg!(target_os = "windows");
    let helper = if helper_required {
        match find_helper_executable(app) {
            Ok(path) => json!({
                "required": true,
                "available": true,
                "path": path_string(&path)
            }),
            Err(error) => json!({
                "required": true,
                "available": false,
                "path": Value::Null,
                "error": error
            }),
        }
    } else {
        json!({
            "required": false,
            "available": true,
            "path": Value::Null
        })
    };

    let source_dir = existing_resource_dir(app, &["tools/data", "data"]);
    let target_dir = mihomo_dir(app).ok();
    let mut missing_files = Vec::<String>::new();
    let mut synced_files = Vec::<String>::new();

    if let Some(target_dir) = target_dir.as_ref() {
        for file_name in MIHOMO_DATA_FILES {
            let target = target_dir.join(file_name);
            if target.is_file()
                || (file_name.eq_ignore_ascii_case("country.mmdb")
                    && target_dir.join("Country.mmdb").is_file())
            {
                synced_files.push((*file_name).to_string());
            } else {
                missing_files.push((*file_name).to_string());
            }
        }
    } else {
        missing_files.extend(MIHOMO_DATA_FILES.iter().map(|name| (*name).to_string()));
    }

    let data_available = source_dir.is_some() || missing_files.is_empty();
    let data = json!({
        "available": data_available,
        "synced": missing_files.is_empty(),
        "sourceDir": source_dir.as_ref().map(|path| path_string(path)),
        "targetDir": target_dir.as_ref().map(|path| path_string(path)),
        "syncedFiles": synced_files,
        "missingFiles": missing_files
    });

    json!({
        "core": core,
        "helper": helper,
        "data": data
    })
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

fn resolve_subscription_path(app: &AppHandle, file_path: &str) -> Result<Option<String>, String> {
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

fn normalize_config_reference(app: &AppHandle, file_path: &str) -> Result<String, String> {
    let requested = file_path.trim();
    if requested.is_empty() {
        return Ok(String::new());
    }
    Ok(resolve_subscription_path(app, requested)?.unwrap_or_else(|| requested.to_string()))
}

fn save_last_config(app: &AppHandle, config_path: &str) -> Result<(), String> {
    let config_path = normalize_config_reference(app, config_path)?;
    set_setting(app, "active_config", Value::String(config_path))
}

fn emit_active_config_changed(app: &AppHandle, config_path: Option<&str>) {
    let payload = config_path
        .map(|path| Value::String(path.to_string()))
        .unwrap_or(Value::Null);
    let _ = app.emit("active-config-changed", payload);
}

fn sync_runtime_active_config_from_settings(
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

fn read_last_config(app: &AppHandle) -> Result<Option<String>, String> {
    let active = setting(app, "active_config", Value::Null)?
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);
    active
        .map(|path| normalize_config_reference(app, &path).map(Some))
        .unwrap_or(Ok(None))
}

fn current_active_config(app: &AppHandle, state: &State<'_, AppState>) -> Option<String> {
    let active = state
        .runtime
        .lock()
        .expect("runtime mutex poisoned")
        .core
        .active_config_owned()
        .or_else(|| read_last_config(app).ok().flatten());
    active.and_then(|path| normalize_config_reference(app, &path).ok())
}

fn open_file_location(path: &Path) -> Result<(), String> {
    if cfg!(target_os = "windows") {
        Command::new("explorer.exe")
            .arg(format!("/select,{}", path.display()))
            .spawn()
            .map_err(|err| err.to_string())?;
        return Ok(());
    }

    if cfg!(target_os = "macos") {
        Command::new("open")
            .arg("-R")
            .arg(path)
            .spawn()
            .map_err(|err| err.to_string())?;
        return Ok(());
    }

    if let Some(parent) = path.parent() {
        open::that(parent).map_err(|err| err.to_string())?;
    }
    Ok(())
}

fn find_tool_path(app: &AppHandle, tool_name: &str) -> Result<Option<PathBuf>, String> {
    let requested = Path::new(tool_name);
    if tool_name.trim().is_empty()
        || requested.is_absolute()
        || requested
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return Err("Invalid tool name".to_string());
    }

    for dir in tool_dirs(app) {
        let candidate = dir.join(requested);
        if candidate.is_file() {
            return Ok(Some(candidate));
        }
    }

    Ok(None)
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

fn custom_background_config(app: &AppHandle) -> Result<Option<Value>, String> {
    let value = setting(app, "customBackground", Value::Null)?;
    if value.is_null() {
        return Ok(None);
    }

    if let Some(raw) = value.as_str() {
        if raw.trim().is_empty() {
            return Ok(None);
        }
        return serde_json::from_str::<Value>(raw)
            .map(Some)
            .map_err(|err| err.to_string());
    }

    Ok(Some(value))
}

fn clamp_u64(value: Option<u64>, min: u64, max: u64, fallback: u64) -> u64 {
    value.unwrap_or(fallback).clamp(min, max)
}

fn background_image_data(path: &str) -> Option<String> {
    let bytes = fs::read(path).ok()?;
    let ext = Path::new(path)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mime = match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "webp" => "image/webp",
        _ => "application/octet-stream",
    };
    Some(format!(
        "data:{};base64,{}",
        mime,
        general_purpose::STANDARD.encode(bytes)
    ))
}

fn emit_custom_background(app: &AppHandle, window: &WebviewWindow) -> Result<(), String> {
    let Some(config) = custom_background_config(app)? else {
        return Ok(());
    };

    let image_path = config
        .get("imagePath")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    if image_path.is_empty() {
        return Ok(());
    }

    let opacity = clamp_u64(config.get("opacity").and_then(Value::as_u64), 0, 100, 80);
    let blur = clamp_u64(config.get("blur").and_then(Value::as_u64), 0, 100, 10);
    let image_data = background_image_data(&image_path);

    window
        .emit(
            "apply-custom-background",
            json!({
                "imagePath": image_path,
                "imageData": image_data,
                "opacity": opacity,
                "blur": blur
            }),
        )
        .map_err(|err| err.to_string())
}

fn show_main_window(app: &AppHandle) {
    let _ = set_setting(app, "lightweightModeActive", json!(false));
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn hide_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
}

fn tray_clean_label(value: &str, fallback: &str, max_chars: usize) -> String {
    let cleaned = value
        .replace('&', "&&")
        .replace('\r', " ")
        .replace('\n', " ");
    let trimmed = cleaned.trim();
    let label = if trimmed.is_empty() {
        fallback
    } else {
        trimmed
    };
    let char_count = label.chars().count();
    if char_count <= max_chars {
        return label.to_string();
    }

    let mut output: String = label.chars().take(max_chars).collect();
    output.push_str("...");
    output
}

fn tray_running_mode_label(mode: RunningMode) -> &'static str {
    match mode {
        RunningMode::Service => "Service",
        RunningMode::Sidecar => "Sidecar",
        RunningMode::NotRunning => "未运行",
    }
}

fn tray_core_snapshot(app: &AppHandle) -> (bool, RunningMode, Option<String>) {
    let _ = sync_core_running_state(app);
    let state = app.state::<AppState>();
    let (running, mode, active_config) = {
        let mut runtime = state.runtime.lock().expect("runtime mutex poisoned");
        let running = runtime.core.is_running();
        let mode = if running {
            runtime.core.running_mode()
        } else {
            RunningMode::NotRunning
        };
        (running, mode, runtime.core.active_config_owned())
    };
    let active_config = active_config
        .or_else(|| read_last_config(app).ok().flatten())
        .and_then(|path| normalize_config_reference(app, &path).ok())
        .filter(|path| !path.trim().is_empty());

    (running, mode, active_config)
}

fn tray_config_name(path: &str, subscriptions: &[SubscriptionMeta]) -> String {
    let path = path.trim();
    subscriptions
        .iter()
        .find(|subscription| subscription.path.trim() == path)
        .map(|subscription| subscription.name.trim().to_string())
        .filter(|name| !name.is_empty())
        .or_else(|| config_display_name(path))
        .unwrap_or_else(|| "未命名配置".to_string())
}

fn build_tray_config_menu(
    app: &AppHandle,
    subscriptions: &[SubscriptionMeta],
    subscriptions_error: Option<&str>,
    active_config: Option<&str>,
) -> Result<Submenu<tauri::Wry>, String> {
    let config_menu =
        Submenu::with_id(app, "configs", "配置切换", true).map_err(|err| err.to_string())?;
    let active_config = active_config
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .and_then(|path| normalize_config_reference(app, path).ok())
        .map(|path| path.trim().to_string())
        .filter(|path| !path.is_empty());

    if let Some(error) = subscriptions_error {
        let error_item = MenuItem::with_id(
            app,
            "configs-error",
            tray_clean_label(&format!("配置读取失败：{error}"), "配置读取失败", 42),
            false,
            None::<&str>,
        )
        .map_err(|err| err.to_string())?;
        config_menu
            .append(&error_item)
            .map_err(|err| err.to_string())?;
        return Ok(config_menu);
    }

    let mut appended = 0usize;
    if let Some(active) = active_config.as_deref() {
        let active_in_list = subscriptions
            .iter()
            .any(|subscription| subscription.path.trim() == active);
        if !active_in_list {
            let label = format!("✓ {}", tray_config_name(active, subscriptions));
            let encoded = urlencoding::encode(active);
            let item = MenuItem::with_id(
                app,
                format!("{TRAY_SWITCH_CONFIG_PREFIX}{encoded}"),
                tray_clean_label(&label, "当前配置", 44),
                true,
                None::<&str>,
            )
            .map_err(|err| err.to_string())?;
            config_menu.append(&item).map_err(|err| err.to_string())?;
            appended += 1;

            if !subscriptions.is_empty() {
                let separator =
                    PredefinedMenuItem::separator(app).map_err(|err| err.to_string())?;
                config_menu
                    .append(&separator)
                    .map_err(|err| err.to_string())?;
            }
        }
    }

    for subscription in subscriptions.iter().take(TRAY_MAX_CONFIG_ITEMS) {
        let path = subscription.path.trim();
        if path.is_empty() {
            continue;
        }
        let is_active = active_config
            .as_deref()
            .map(|active| active == path)
            .unwrap_or(false);
        let prefix = if is_active { "✓ " } else { "" };
        let label = format!("{prefix}{}", subscription.name);
        let encoded = urlencoding::encode(path);
        let item = MenuItem::with_id(
            app,
            format!("{TRAY_SWITCH_CONFIG_PREFIX}{encoded}"),
            tray_clean_label(&label, "未命名配置", 44),
            true,
            None::<&str>,
        )
        .map_err(|err| err.to_string())?;
        config_menu.append(&item).map_err(|err| err.to_string())?;
        appended += 1;
    }

    if subscriptions.len() > TRAY_MAX_CONFIG_ITEMS {
        let remaining = subscriptions.len() - TRAY_MAX_CONFIG_ITEMS;
        let more_item = MenuItem::with_id(
            app,
            "configs-more",
            format!("还有 {remaining} 个配置，请在配置管理中查看"),
            false,
            None::<&str>,
        )
        .map_err(|err| err.to_string())?;
        config_menu
            .append(&more_item)
            .map_err(|err| err.to_string())?;
    }

    if appended == 0 {
        let empty_item = MenuItem::with_id(app, "configs-empty", "暂无配置", false, None::<&str>)
            .map_err(|err| err.to_string())?;
        config_menu
            .append(&empty_item)
            .map_err(|err| err.to_string())?;
    }

    Ok(config_menu)
}

fn build_tray_menu(app: &AppHandle) -> Result<(Menu<tauri::Wry>, String), String> {
    let (core_running, running_mode, active_config) = tray_core_snapshot(app);
    let proxy_status = system_proxy_status(app);
    let proxy_enabled = proxy_status
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let tun_enabled = setting(app, "tunModeEnabled", json!(false))?
        .as_bool()
        .unwrap_or(false);
    let (subscriptions, subscriptions_error) = match read_subscriptions(app) {
        Ok(subscriptions) => (subscriptions, None),
        Err(error) => (Vec::new(), Some(error)),
    };
    let active_name = active_config
        .as_deref()
        .map(|path| tray_config_name(path, &subscriptions))
        .unwrap_or_else(|| "未选择".to_string());

    let core_status = MenuItem::with_id(
        app,
        "status-core",
        format!("核心：{}", tray_running_mode_label(running_mode)),
        false,
        None::<&str>,
    )
    .map_err(|err| err.to_string())?;
    let config_status = MenuItem::with_id(
        app,
        "status-config",
        tray_clean_label(&format!("配置：{active_name}"), "配置：未选择", 48),
        false,
        None::<&str>,
    )
    .map_err(|err| err.to_string())?;
    let proxy_status_item = MenuItem::with_id(
        app,
        "status-proxy",
        format!(
            "系统代理：{}",
            if proxy_enabled {
                "已启用"
            } else {
                "已关闭"
            }
        ),
        false,
        None::<&str>,
    )
    .map_err(|err| err.to_string())?;
    let tun_status_item = MenuItem::with_id(
        app,
        "status-tun",
        format!(
            "TUN：{}",
            if tun_enabled {
                "已启用"
            } else {
                "已关闭"
            }
        ),
        false,
        None::<&str>,
    )
    .map_err(|err| err.to_string())?;

    let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)
        .map_err(|err| err.to_string())?;
    let hide = MenuItem::with_id(app, "hide", "隐藏到托盘", true, None::<&str>)
        .map_err(|err| err.to_string())?;
    let restart_core = MenuItem::with_id(
        app,
        "restart-core",
        if core_running {
            "重启核心"
        } else {
            "启动核心"
        },
        true,
        None::<&str>,
    )
    .map_err(|err| err.to_string())?;
    let stop_core = MenuItem::with_id(app, "stop-core", "停止核心", core_running, None::<&str>)
        .map_err(|err| err.to_string())?;
    let toggle_proxy = MenuItem::with_id(
        app,
        "toggle-system-proxy",
        if proxy_enabled {
            "关闭系统代理"
        } else {
            "启用系统代理"
        },
        core_running || proxy_enabled,
        None::<&str>,
    )
    .map_err(|err| err.to_string())?;
    let toggle_tun = MenuItem::with_id(
        app,
        "toggle-tun",
        if tun_enabled {
            "关闭 TUN 模式"
        } else {
            "启用 TUN 模式"
        },
        true,
        None::<&str>,
    )
    .map_err(|err| err.to_string())?;
    let close_connections = MenuItem::with_id(
        app,
        "close-all-connections",
        "断开所有连接",
        core_running,
        None::<&str>,
    )
    .map_err(|err| err.to_string())?;
    let configs = build_tray_config_menu(
        app,
        &subscriptions,
        subscriptions_error.as_deref(),
        active_config.as_deref(),
    )?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)
        .map_err(|err| err.to_string())?;
    let sep_status = PredefinedMenuItem::separator(app).map_err(|err| err.to_string())?;
    let sep_window = PredefinedMenuItem::separator(app).map_err(|err| err.to_string())?;
    let sep_actions = PredefinedMenuItem::separator(app).map_err(|err| err.to_string())?;
    let sep_quit = PredefinedMenuItem::separator(app).map_err(|err| err.to_string())?;

    let menu = Menu::with_items(
        app,
        &[
            &core_status,
            &config_status,
            &proxy_status_item,
            &tun_status_item,
            &sep_status,
            &show,
            &hide,
            &sep_window,
            &restart_core,
            &stop_core,
            &toggle_proxy,
            &toggle_tun,
            &close_connections,
            &sep_actions,
            &configs,
            &sep_quit,
            &quit,
        ],
    )
    .map_err(|err| err.to_string())?;

    let tooltip = format!(
        "FlyClash · 核心 {} · 代理 {} · TUN {}",
        tray_running_mode_label(running_mode),
        if proxy_enabled { "开" } else { "关" },
        if tun_enabled { "开" } else { "关" }
    );

    Ok((menu, tooltip))
}

fn refresh_tray_menu(app: &AppHandle) -> Result<(), String> {
    let (menu, tooltip) = build_tray_menu(app)?;
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        tray.set_menu(Some(menu)).map_err(|err| err.to_string())?;
        tray.set_tooltip(Some(tooltip))
            .map_err(|err| err.to_string())?;
    }
    Ok(())
}

fn refresh_tray_menu_after(app: &AppHandle, reason: &str) {
    if let Err(error) = refresh_tray_menu(app) {
        eprintln!("[tray] failed to refresh menu after {reason}: {error}");
    }
}

fn emit_tray_action(app: &AppHandle, action: &str, result: Value) {
    let _ = app.emit(
        "tray-action",
        json!({
            "action": action,
            "result": result
        }),
    );
}

fn spawn_tray_async_action<F, Fut>(app: &AppHandle, action: &'static str, task: F)
where
    F: FnOnce(AppHandle) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = CompatResult> + Send + 'static,
{
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = match task(app.clone()).await {
            Ok(value) => value,
            Err(error) => json!({ "success": false, "error": error }),
        };
        emit_tray_action(&app, action, result);
        refresh_tray_menu_after(&app, action);
    });
}

fn tray_toggle_system_proxy(app: &AppHandle) {
    spawn_tray_async_action(app, "toggle-system-proxy", |app| async move {
        let enabled = system_proxy_status(&app)
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let target = !enabled;
        if target && !is_mihomo_running(&app) {
            return Ok(json!({
                "success": false,
                "enabled": false,
                "error": "Mihomo 服务未运行，无法启用系统代理"
            }));
        }
        let port = mihomo_mixed_port(&app);
        set_system_proxy(&app, target, "127.0.0.1", port)?;
        let status = system_proxy_status(&app);
        let actual_enabled = status
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let _ = app.emit("proxy-status", actual_enabled);
        Ok(status)
    });
}

fn tray_toggle_tun(app: &AppHandle) {
    spawn_tray_async_action(app, "toggle-tun", |app| async move {
        let state = app.state::<AppState>();
        let window = app
            .get_webview_window("main")
            .ok_or_else(|| "主窗口不可用".to_string())?;
        let previous_enabled = setting(&app, "tunModeEnabled", json!(false))?
            .as_bool()
            .unwrap_or(false);
        let enabled = !previous_enabled;
        if enabled {
            ensure_tun_dns_defaults(&app)?;
        }
        set_setting(&app, "tunModeEnabled", json!(enabled))?;
        apply_tun_runtime_change(&app, &window, &state, enabled, previous_enabled, true).await
    });
}

fn tray_restart_core(app: &AppHandle) {
    spawn_tray_async_action(app, "restart-core", |app| async move {
        let state = app.state::<AppState>();
        let config_path = read_last_config(&app)?.unwrap_or_default();
        if config_path.trim().is_empty() {
            return Ok(json!({ "success": false, "error": "没有可启动的当前配置" }));
        }
        let result = start_mihomo(&app, &state, &config_path).await?;
        let event_payload = if result
            .get("success")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            json!({ "success": true, "source": "tray" })
        } else {
            json!({
                "success": false,
                "source": "tray",
                "error": result
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("启动 / 重启核心失败")
            })
        };
        let _ = app.emit("service-restarted", event_payload);
        Ok(result)
    });
}

fn tray_stop_core(app: &AppHandle) {
    spawn_tray_async_action(app, "stop-core", |app| async move {
        let state = app.state::<AppState>();
        match stop_mihomo_process(&app, &state).await {
            Ok(()) => {
                let _ = app.emit("mihomo-stopped", 0);
                Ok(json!({ "success": true }))
            }
            Err(error) => Ok(json!({ "success": false, "error": error })),
        }
    });
}

fn tray_close_all_connections(app: &AppHandle) {
    spawn_tray_async_action(app, "close-all-connections", |app| async move {
        let response = request_http(
            &app,
            Some("/connections".to_string()),
            Some(json!({ "method": "DELETE" })),
        )
        .await?;

        if response.get("ok").and_then(Value::as_bool).unwrap_or(false) {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.emit("connections-closed", json!({}));
                let state = app.state::<AppState>();
                let snapshot = fetch_connections_info(&app, &state).await;
                let _ = window.emit("connections-update", snapshot);
            }
            Ok(success(json!({})))
        } else {
            Ok(json!({
                "success": false,
                "error": response
                    .get("statusText")
                    .or_else(|| response.get("text"))
                    .cloned()
                    .unwrap_or(Value::String("断开所有连接失败".to_string()))
            }))
        }
    });
}

fn tray_switch_config(app: &AppHandle, encoded_path: &str) {
    let config_path = match urlencoding::decode(encoded_path) {
        Ok(path) => path.trim().to_string(),
        Err(error) => {
            emit_tray_action(
                app,
                "switch-config",
                json!({
                    "success": false,
                    "error": format!("配置路径解析失败: {error}")
                }),
            );
            return;
        }
    };

    if config_path.is_empty() {
        emit_tray_action(
            app,
            "switch-config",
            json!({ "success": false, "error": "配置文件路径为空" }),
        );
        return;
    }

    spawn_tray_async_action(app, "switch-config", move |app| async move {
        let state = app.state::<AppState>();
        let config_path = normalize_config_reference(&app, &config_path)?;
        if let Err(error) = config_content(&app, &config_path) {
            return Ok(json!({
                "success": false,
                "activeConfig": config_path.clone(),
                "configPath": config_path.clone(),
                "filePath": config_path.clone(),
                "path": config_path,
                "error": format!("配置文件不存在或无法读取: {error}")
            }));
        }

        let config_name = read_subscriptions(&app)
            .ok()
            .map(|subscriptions| tray_config_name(&config_path, &subscriptions))
            .or_else(|| config_display_name(&config_path))
            .unwrap_or_else(|| "未命名配置".to_string());

        if is_mihomo_running(&app) {
            let result = reload_mihomo_config(&app, &state, &config_path).await?;
            if result
                .get("success")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                return Ok(success(json!({
                    "activeConfig": config_path.clone(),
                    "configPath": config_path.clone(),
                    "filePath": config_path.clone(),
                    "path": config_path.clone(),
                    "configName": config_name,
                    "reloaded": true,
                    "message": format!("已切换到 {config_name}")
                })));
            }
            return Ok(result);
        }

        save_last_config(&app, &config_path)?;
        {
            let mut runtime = state.runtime.lock().expect("runtime mutex poisoned");
            runtime.core.set_active_config(Some(config_path.clone()));
        }
        emit_active_config_changed(&app, Some(&config_path));
        Ok(success(json!({
            "activeConfig": config_path.clone(),
            "configPath": config_path.clone(),
            "filePath": config_path.clone(),
            "path": config_path.clone(),
            "configName": config_name,
            "reloaded": false,
            "message": format!("已设为首选配置：{config_name}")
        })))
    });
}

fn setup_tray(app: &AppHandle) -> Result<(), String> {
    let (menu, tooltip) = build_tray_menu(app)?;
    let icon = app.default_window_icon().cloned();

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip(tooltip)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            if let Some(encoded_path) = id.strip_prefix(TRAY_SWITCH_CONFIG_PREFIX) {
                tray_switch_config(app, encoded_path);
                return;
            }

            match id {
                "show" => show_main_window(app),
                "hide" => hide_main_window(app),
                "restart-core" => tray_restart_core(app),
                "stop-core" => tray_stop_core(app),
                "toggle-system-proxy" => tray_toggle_system_proxy(app),
                "toggle-tun" => tray_toggle_tun(app),
                "close-all-connections" => tray_close_all_connections(app),
                "quit" => app.exit(0),
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(window) = app.get_webview_window("main") {
                    let visible = window.is_visible().unwrap_or(false);
                    if visible {
                        let _ = window.hide();
                    } else {
                        show_main_window(app);
                    }
                }
            }
        });

    if let Some(icon) = icon {
        builder = builder.icon(icon);
    }

    builder.build(app).map_err(|err| err.to_string())?;
    Ok(())
}

fn apply_appearance_mode(window: &WebviewWindow, mode: &str) -> Result<(), String> {
    match mode {
        "solid" => {
            window.set_effects(None).map_err(|err| err.to_string())?;
            window
                .set_background_color(Some(Color(245, 248, 252, 255)))
                .map_err(|err| err.to_string())?;
        }
        "acrylic" => {
            window
                .set_background_color(Some(Color(0, 0, 0, 0)))
                .map_err(|err| err.to_string())?;
            window
                .set_effects(
                    EffectsBuilder::new()
                        .effect(Effect::Acrylic)
                        .color(Color(245, 248, 252, 86))
                        .build(),
                )
                .map_err(|err| err.to_string())?;
        }
        "custom" => {
            window.set_effects(None).map_err(|err| err.to_string())?;
            window
                .set_background_color(Some(Color(0, 0, 0, 0)))
                .map_err(|err| err.to_string())?;
        }
        _ => {
            window
                .set_background_color(Some(Color(0, 0, 0, 0)))
                .map_err(|err| err.to_string())?;
            window
                .set_effects(
                    EffectsBuilder::new()
                        .effects([Effect::Tabbed, Effect::Mica, Effect::Blur])
                        .color(Color(245, 248, 252, 58))
                        .build(),
                )
                .map_err(|err| err.to_string())?;
        }
    }

    Ok(())
}

fn resolved_theme(window: &WebviewWindow, theme: &str) -> String {
    if theme != "system" {
        return theme.to_string();
    }

    window
        .theme()
        .ok()
        .map(|theme| {
            let name = if matches!(theme, tauri::Theme::Dark) {
                "dark"
            } else {
                "light"
            };
            name.to_string()
        })
        .unwrap_or_else(|| "light".to_string())
}

fn window_state_payload(window: &WebviewWindow) -> Value {
    let maximized = window.is_maximized().unwrap_or(false);
    let full_screen = window.is_fullscreen().unwrap_or(false);
    json!({
        "success": true,
        "maximized": maximized,
        "isMaximized": maximized,
        "fullScreen": full_screen,
        "isFullscreen": full_screen
    })
}

fn emit_window_state(window: &WebviewWindow) {
    let _ = window.emit("window-state-changed", window_state_payload(window));
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

fn header_u64(headers: &reqwest::header::HeaderMap, name: &str) -> Option<u64> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<u64>().ok())
}

fn subscription_info_from_headers(
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

fn parse_expiry_timestamp(value: &str) -> Option<u64> {
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

fn allowed_subscription_ua_key(value: &str) -> bool {
    matches!(
        value,
        "Clash" | "Mihomo" | "MihomoParty" | "Chrome" | "FlyClash"
    )
}

fn safe_subscription_user_agent(app: &AppHandle) -> Result<String, String> {
    let ua_key = setting(app, "subscription-ua", json!("MihomoParty"))?
        .as_str()
        .unwrap_or("MihomoParty")
        .trim()
        .to_string();

    Ok(match ua_key.as_str() {
        "Clash" => "Clash/2.0.0".to_string(),
        "Mihomo" => "Mihomo/1.14.0".to_string(),
        "Chrome" => "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36".to_string(),
        "FlyClash" => format!("FlyClash/{}", app.package_info().version),
        _ => "clash.meta".to_string(),
    })
}

async fn fetch_subscription(app: &AppHandle, url: &str) -> CompatResult {
    let mut valid_url = url.trim().to_string();
    if !valid_url.starts_with("http://") && !valid_url.starts_with("https://") {
        valid_url = format!("https://{valid_url}");
    }

    let ua = safe_subscription_user_agent(app)?;
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

    let (used, remaining, expire) = subscription_info_from_headers(response.headers());
    let content = response.text().await.map_err(|err| err.to_string())?;
    if content.trim().is_empty() {
        return Ok(json!({
            "success": false,
            "error": "订阅内容为空"
        }));
    }

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

    Ok(json!({ "success": true, "filePath": logical_path }))
}

fn save_subscription_info(app: &AppHandle, file_path: &str, info: &Value) -> Result<(), String> {
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

async fn refresh_subscription_by_path(
    app: &AppHandle,
    state: Option<&State<'_, AppState>>,
    file_path: &str,
) -> CompatResult {
    let file_path = match resolve_subscription_path(app, file_path)? {
        Some(path) => path,
        None => {
            return Ok(json!({
                "success": false,
                "error": "未找到订阅信息"
            }));
        }
    };
    let subscription = read_subscriptions(app)?
        .into_iter()
        .find(|item| item.path == file_path);
    let Some(subscription) = subscription else {
        return Ok(json!({
            "success": false,
            "error": "未找到订阅信息"
        }));
    };

    let Some(url) = subscription.url.clone() else {
        return Ok(json!({
            "success": true,
            "filePath": file_path,
            "message": "本地配置无需刷新"
        }));
    };

    if url.trim().is_empty() || url.trim_start().starts_with("local:") {
        return Ok(json!({
            "success": true,
            "filePath": file_path,
            "message": "本地配置无需刷新"
        }));
    }

    let mut fetched = fetch_subscription(app, &url).await?;
    if !fetched
        .get("success")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Ok(fetched);
    }

    let previous_content = config_content(app, &file_path)?;
    let mut content_updated = false;

    let update_result: Result<(), String> = (|| {
        if let Some(content) = fetched.get("content").and_then(Value::as_str) {
            save_config_content(app, &file_path, content)?;
            content_updated = true;
        }

        if let Some(info) = fetched.get("subscriptionInfo") {
            save_subscription_info(app, &file_path, info)?;
        }

        Ok(())
    })();

    if let Err(error) = update_result {
        if content_updated {
            let _ = save_config_content(app, &file_path, &previous_content);
        }
        return Ok(json!({
            "success": false,
            "error": format!("订阅已下载，但保存失败: {error}")
        }));
    }

    if let Some(state) = state {
        let active = current_active_config(app, state);
        let runtime_reload = if active.as_deref() == Some(file_path.as_str()) {
            refresh_active_config_after_override(app, state).await
        } else {
            json!({
                "reloaded": false,
                "skipped": true,
                "reason": "not-active-config"
            })
        };
        if let Some(object) = fetched.as_object_mut() {
            object.insert("runtimeReload".to_string(), runtime_reload);
            object.insert("filePath".to_string(), Value::String(file_path.clone()));
        }
    }

    Ok(fetched)
}

fn due_auto_update_subscriptions(app: &AppHandle) -> Result<Vec<SubscriptionMeta>, String> {
    let now = now_millis();
    Ok(read_subscriptions(app)?
        .into_iter()
        .filter(|sub| {
            sub.update_interval > 0
                && sub
                    .url
                    .as_deref()
                    .map(|url| {
                        let trimmed = url.trim();
                        !trimmed.is_empty() && !trimmed.starts_with("local:")
                    })
                    .unwrap_or(false)
        })
        .filter(|sub| {
            let updated_at = sub
                .last_updated
                .as_deref()
                .and_then(|value| value.parse::<u128>().ok())
                .unwrap_or(0);
            let interval_ms = (sub.update_interval as u128).saturating_mul(60_000);
            interval_ms > 0 && now.saturating_sub(updated_at) >= interval_ms
        })
        .collect())
}

async fn run_subscription_scheduler_once(app: &AppHandle) -> Result<(), String> {
    let due = due_auto_update_subscriptions(app)?;
    if due.is_empty() {
        return Ok(());
    }

    for sub in due {
        let interval_ms = (sub.update_interval as u128).saturating_mul(60_000);
        let now = now_millis();
        {
            let state = app.state::<AppState>();
            let mut runtime = state.runtime.lock().expect("runtime mutex poisoned");
            let last_attempt = runtime
                .subscription_update_attempts
                .get(&sub.path)
                .copied()
                .unwrap_or(0);
            if interval_ms > 0 && now.saturating_sub(last_attempt) < interval_ms {
                continue;
            }
            runtime
                .subscription_update_attempts
                .insert(sub.path.clone(), now);
        }

        let state = app.state::<AppState>();
        match refresh_subscription_by_path(app, Some(&state), &sub.path).await {
            Ok(mut result) => {
                if result
                    .get("success")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                {
                    if let Some(object) = result.as_object_mut() {
                        object.remove("content");
                    }
                    let _ = app.emit(
                        "subscription-auto-updated",
                        json!({
                            "name": sub.name,
                            "filePath": sub.path,
                            "result": result
                        }),
                    );
                } else {
                    let error = result
                        .get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("订阅自动更新失败");
                    let _ = app.emit(
                        "subscription-auto-update-failed",
                        json!({
                            "name": sub.name,
                            "filePath": sub.path,
                            "error": error
                        }),
                    );
                }
            }
            Err(error) => {
                let _ = app.emit(
                    "subscription-auto-update-failed",
                    json!({
                        "name": sub.name,
                        "filePath": sub.path,
                        "error": error
                    }),
                );
            }
        }
    }

    Ok(())
}

fn start_subscription_scheduler(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(3)).await;
        loop {
            if let Err(error) = run_subscription_scheduler_once(&app).await {
                eprintln!("[subscription-scheduler] {error}");
            }
            tokio::time::sleep(Duration::from_secs(60)).await;
        }
    });
}

fn delete_subscription(app: &AppHandle, file_path: &str) -> CompatResult {
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

fn edit_subscription(app: &AppHandle, params: Value) -> CompatResult {
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
    Ok(success(json!({ "oldPath": old_path, "newPath": new_path })))
}

fn update_subscription(
    app: &AppHandle,
    file_path: &str,
    config_data: &str,
    sub_url: Option<String>,
    info: Option<Value>,
) -> CompatResult {
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
        return decrypt_text(app, &encrypted);
    }

    fs::read_to_string(&file_path).map_err(|err| err.to_string())
}

fn save_config_content(app: &AppHandle, file_path: &str, content: &str) -> Result<(), String> {
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
        return Ok(());
    }

    fs::write(&file_path, content).map_err(|err| err.to_string())
}

fn ensure_minimal_mihomo_config(app: &AppHandle) -> Result<String, String> {
    let path = config_dir(app)?.join(FALLBACK_MINIMAL_CONFIG_FILE_NAME);
    fs::write(&path, FALLBACK_MINIMAL_CONFIG_CONTENT).map_err(|err| err.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

fn exported_config_path(app: &AppHandle, file_path: &str) -> Result<PathBuf, String> {
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

fn materialize_config_for_open(app: &AppHandle, target: &str) -> Result<PathBuf, String> {
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

fn config_display_name(file_path: &str) -> Option<String> {
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

fn default_kernel_config() -> Value {
    json!({
        "mixed-port": 7890,
        "allow-lan": false,
        "ipv6": false,
        "find-process-mode": "always",
        "external-controller": "",
        "secret": ""
    })
}

fn default_dns_config() -> Value {
    json!({
        "enable": true,
        "ipv6": false,
        "enhanced-mode": "fake-ip",
        "fake-ip-range": "198.18.0.1/16",
        "fake-ip-filter": [
            "*.lan",
            "*.local",
            "localhost.ptlogin2.qq.com",
            "+.srv.nintendo.net",
            "+.stun.playstation.net",
            "xbox.*.microsoft.com",
            "+.xboxlive.com"
        ],
        "use-hosts": false,
        "use-system-hosts": true,
        "respect-rules": false,
        "default-nameserver": ["114.114.114.114", "223.5.5.5", "8.8.8.8"],
        "nameserver": ["https://doh.pub/dns-query", "https://dns.alidns.com/dns-query"],
        "proxy-server-nameserver": ["https://doh.pub/dns-query"],
        "direct-nameserver": ["https://doh.pub/dns-query", "https://dns.alidns.com/dns-query"]
    })
}

fn default_tun_config() -> Value {
    json!({
        "device": if cfg!(target_os = "macos") { "utun" } else { "mihomo" },
        "stack": "system",
        "autoRoute": true,
        "autoRedirect": false,
        "autoDetectInterface": true,
        "dnsHijack": ["any:53"],
        "strictRoute": false,
        "routeExcludeAddress": [],
        "mtu": 1500,
        "autoSetDNS": cfg!(target_os = "macos")
    })
}

fn non_empty_object(value: &Value) -> bool {
    value
        .as_object()
        .map(|object| !object.is_empty())
        .unwrap_or(false)
}

fn merge_object_setting(app: &AppHandle, key: &str, value: Value) -> Result<(), String> {
    if !value.is_object() {
        set_setting(app, key, value)?;
        return Ok(());
    }

    let mut current = setting(app, key, json!({}))?
        .as_object()
        .cloned()
        .unwrap_or_default();
    if let Some(object) = value.as_object() {
        for (item_key, item_value) in object {
            current.insert(item_key.clone(), item_value.clone());
        }
    }
    set_setting(app, key, Value::Object(current))
}

fn user_settings_view(app: &AppHandle) -> Result<Value, String> {
    let settings = read_settings(app)?;
    let mut output = default_kernel_config()
        .as_object()
        .cloned()
        .unwrap_or_default();

    if let Some(legacy) = settings.get("proxySettings").and_then(Value::as_object) {
        for (key, value) in legacy {
            output.insert(key.clone(), value.clone());
        }
    }

    if let Some(kernel) = kernel_config_from_settings(app)?.as_object() {
        for key in KERNEL_FIELDS {
            if let Some(value) = kernel.get(*key) {
                output.insert((*key).to_string(), value.clone());
            }
        }
    }

    for (key, value) in settings {
        if matches!(
            key.as_str(),
            "active_config"
                | "kernel"
                | "proxySettings"
                | "systemProxyEnabled"
                | "tunConfig"
                | "tunModeEnabled"
        ) || value.is_null()
        {
            continue;
        }
        output.insert(key, value);
    }

    output
        .entry("subscription-ua".to_string())
        .or_insert_with(|| Value::String("MihomoParty".to_string()));
    output
        .entry("find-process-mode".to_string())
        .or_insert_with(|| Value::String("always".to_string()));
    output
        .entry("external-controller".to_string())
        .or_insert_with(|| Value::String(String::new()));
    output
        .entry("secret".to_string())
        .or_insert_with(|| Value::String(String::new()));

    Ok(Value::Object(output))
}

fn normalize_bool_setting(value: &Value) -> bool {
    if let Some(value) = value.as_bool() {
        return value;
    }
    if let Some(value) = value.as_str() {
        let trimmed = value.trim();
        return trimmed.eq_ignore_ascii_case("true") || trimmed == "1";
    }
    value.as_i64().map(|value| value != 0).unwrap_or(false)
}

fn normalize_mixed_port(value: &Value) -> Result<Value, String> {
    let port = value
        .as_u64()
        .and_then(|value| u16::try_from(value).ok())
        .or_else(|| value.as_str()?.trim().parse::<u16>().ok())
        .ok_or_else(|| "Port must be a number".to_string())?;

    if port == 0 {
        return Err("Port must be between 1 and 65535".to_string());
    }

    Ok(Value::Number(serde_json::Number::from(u64::from(port))))
}

fn normalize_user_setting(key: &str, value: &Value) -> Result<Option<Value>, String> {
    if value.is_null() {
        return Ok(None);
    }

    match key {
        "mixed-port" => normalize_mixed_port(value).map(Some),
        "allow-lan" | "ipv6" => Ok(Some(Value::Bool(normalize_bool_setting(value)))),
        "subscription-ua" => {
            let ua = value
                .as_str()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "Invalid User-Agent option".to_string())?;
            if !allowed_subscription_ua_key(ua) {
                return Err("Unsupported User-Agent option".to_string());
            }
            Ok(Some(Value::String(ua.to_string())))
        }
        _ => Ok(Some(value.clone())),
    }
}

fn save_proxy_settings(app: &AppHandle, settings: Value) -> Result<bool, String> {
    let object = settings
        .as_object()
        .ok_or_else(|| "Invalid settings object".to_string())?;
    let mut stored = read_settings(app)?;
    let mut kernel = stored
        .get("kernel")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut kernel_changed = false;

    for (key, value) in object {
        let Some(value) = normalize_user_setting(key, value)? else {
            continue;
        };

        if KERNEL_FIELDS.contains(&key.as_str()) {
            kernel.insert(key.clone(), value.clone());
            kernel_changed = true;
        }
        stored.insert(key.clone(), value);
    }

    if kernel_changed {
        stored.insert("kernel".to_string(), Value::Object(kernel));
    }

    write_settings(app, &stored)?;
    Ok(kernel_changed)
}

fn kernel_config_from_settings(app: &AppHandle) -> Result<Value, String> {
    let settings = read_settings(app)?;
    let mut config = default_kernel_config()
        .as_object()
        .cloned()
        .unwrap_or_default();
    let nested = settings
        .get("kernel")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    for key in KERNEL_FIELDS {
        if let Some(value) = nested.get(*key).or_else(|| settings.get(*key)) {
            config.insert((*key).to_string(), value.clone());
        }
    }

    Ok(Value::Object(config))
}

fn hosts_to_map(hosts: Value) -> Value {
    match hosts {
        Value::Array(items) => {
            let mut map = Map::new();
            for item in items {
                let Some(object) = item.as_object() else {
                    continue;
                };
                let Some(domain) = object.get("domain").and_then(Value::as_str) else {
                    continue;
                };
                if domain.trim().is_empty() {
                    continue;
                }
                let value = object
                    .get("value")
                    .cloned()
                    .unwrap_or_else(|| Value::String(String::new()));
                map.insert(domain.trim().to_string(), value);
            }
            Value::Object(map)
        }
        Value::Object(_) => hosts,
        _ => json!({}),
    }
}

fn save_yaml_section_value(
    app: &AppHandle,
    file_path: &str,
    key: &str,
    value: Value,
) -> Result<(), String> {
    let mut yaml = config_yaml(app, file_path)?;
    if !matches!(yaml, serde_yaml::Value::Mapping(_)) {
        yaml = serde_yaml::Value::Mapping(Default::default());
    }
    if let serde_yaml::Value::Mapping(map) = &mut yaml {
        let section = serde_yaml::to_value(value).map_err(|err| err.to_string())?;
        map.insert(yaml_key(key), section);
    }
    save_config_yaml(app, file_path, &yaml)
}

fn save_kernel_yaml(app: &AppHandle, file_path: &str, value: Value) -> Result<(), String> {
    let mut yaml = config_yaml(app, file_path)?;
    if !matches!(yaml, serde_yaml::Value::Mapping(_)) {
        yaml = serde_yaml::Value::Mapping(Default::default());
    }

    if let serde_yaml::Value::Mapping(map) = &mut yaml {
        let object = value.as_object().cloned().unwrap_or_default();
        for key in KERNEL_FIELDS {
            let yaml_key = yaml_key(key);
            match object.get(*key) {
                Some(item) if item.is_null() || item.as_str() == Some("") => {
                    map.remove(&yaml_key);
                }
                Some(item) => {
                    map.insert(
                        yaml_key,
                        serde_yaml::to_value(item).map_err(|err| err.to_string())?,
                    );
                }
                None => {
                    map.remove(&yaml_key);
                }
            }
        }
    }

    save_config_yaml(app, file_path, &yaml)
}

fn endpoint_path(endpoint: &str) -> String {
    let without_query = endpoint.split('?').next().unwrap_or(endpoint);
    if let Some(scheme_index) = without_query.find("://") {
        let after_scheme = &without_query[(scheme_index + 3)..];
        if let Some(path_index) = after_scheme.find('/') {
            return after_scheme[path_index..].to_string();
        }
        return "/".to_string();
    }
    without_query.to_string()
}

fn geodata_config_patch_body(
    target: Option<&str>,
    options: Option<&Value>,
) -> Option<Map<String, Value>> {
    let options = serde_json::from_value::<FetchOptions>(options?.clone()).ok()?;
    if !options.method.eq_ignore_ascii_case("PATCH") {
        return None;
    }

    let endpoint = target
        .filter(|value| !value.trim().is_empty())
        .map(ToString::to_string)
        .or(options.url.clone())
        .unwrap_or_default();
    if endpoint_path(&endpoint) != "/configs" {
        return None;
    }

    let body = match options.body? {
        Value::String(text) => serde_json::from_str::<Value>(&text).ok()?,
        value => value,
    };
    let object = body.as_object()?.clone();
    if object.is_empty()
        || !object
            .keys()
            .all(|key| GEODATA_CONFIG_FIELDS.contains(&key.as_str()))
    {
        return None;
    }
    Some(object)
}

fn normalize_geox_url_patch(value: &Value) -> Value {
    let Some(object) = value.as_object() else {
        return value.clone();
    };

    let mut normalized = Map::new();
    for (key, item) in object {
        let normalized_key = match key.as_str() {
            "geoip" | "geo-ip" => "geo-ip",
            "geosite" | "geo-site" => "geo-site",
            other => other,
        };
        normalized.insert(normalized_key.to_string(), item.clone());
    }
    Value::Object(normalized)
}

async fn patch_active_geodata_config(
    app: &AppHandle,
    state: &State<'_, AppState>,
    patch: Map<String, Value>,
) -> CompatResult {
    let active = state
        .runtime
        .lock()
        .expect("runtime mutex poisoned")
        .core
        .active_config_owned()
        .or_else(|| read_last_config(app).ok().flatten());

    let Some(config_path) = active else {
        return Ok(json!({
            "ok": false,
            "status": 404,
            "statusText": "No active config",
            "data": { "message": "没有当前配置，无法保存 GeoData 设置" },
            "text": "没有当前配置，无法保存 GeoData 设置"
        }));
    };

    let mut yaml = config_yaml(app, &config_path)?;
    if !matches!(yaml, serde_yaml::Value::Mapping(_)) {
        yaml = serde_yaml::Value::Mapping(Default::default());
    }

    if let serde_yaml::Value::Mapping(map) = &mut yaml {
        for (key, value) in patch {
            let value = if key == "geox-url" {
                normalize_geox_url_patch(&value)
            } else {
                value
            };
            let yaml_key = yaml_key(&key);
            if value.is_null() {
                map.remove(&yaml_key);
            } else {
                map.insert(
                    yaml_key,
                    serde_yaml::to_value(value).map_err(|err| err.to_string())?,
                );
            }
        }
    }

    save_config_yaml(app, &config_path, &yaml)?;
    let reload = refresh_active_config_after_override(app, state).await;
    let reloaded = reload
        .get("reloaded")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let skipped = reload
        .get("skipped")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    if reloaded || skipped {
        Ok(json!({
            "ok": true,
            "status": 204,
            "statusText": "No Content",
            "data": Value::Null,
            "text": ""
        }))
    } else {
        let error = reload
            .get("error")
            .and_then(Value::as_str)
            .or_else(|| {
                reload
                    .get("result")
                    .and_then(|result| result.get("error"))
                    .and_then(Value::as_str)
            })
            .unwrap_or("GeoData 设置已写入，但热重载失败");
        Ok(json!({
            "ok": false,
            "status": 500,
            "statusText": error,
            "data": { "message": error, "reload": reload },
            "text": error
        }))
    }
}

fn ensure_tun_dns_defaults(app: &AppHandle) -> Result<(), String> {
    let current = setting(app, "dns", json!({}))?;
    let current_mode = current.get("enhanced-mode").and_then(Value::as_str);
    if current_mode.is_some_and(|mode| mode != "fake-ip") {
        return Ok(());
    }

    let mut dns = default_dns_config()
        .as_object()
        .cloned()
        .unwrap_or_default();
    if let Some(ipv6) = kernel_config_from_settings(app)?
        .get("ipv6")
        .and_then(Value::as_bool)
    {
        dns.insert("ipv6".to_string(), Value::Bool(ipv6));
    }
    if let Some(current) = current.as_object() {
        for (key, value) in current {
            dns.insert(key.clone(), value.clone());
        }
    }

    set_setting(app, "dns", Value::Object(dns))
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
        save_yaml_section_value(app, &file_path, key, value)?;
        return Ok(success(json!({})));
    }

    set_setting(app, key, value)?;
    Ok(success(json!({})))
}

fn yaml_root_pick(app: &AppHandle, file_path: Option<String>, keys: &[&str]) -> CompatResult {
    let Some(file_path) = file_path else {
        let source = kernel_config_from_settings(app)?;
        let mut output = Map::new();
        for key in keys {
            if let Some(value) = source.get(*key) {
                output.insert((*key).to_string(), value.clone());
            }
        }
        return Ok(success(json!({ "config": output })));
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

fn custom_kernel_path(app: &AppHandle) -> Result<Option<String>, String> {
    for key in ["kernelPath", "core_custom_path"] {
        if let Some(path) = setting(app, key, Value::Null)?
            .as_str()
            .map(str::trim)
            .filter(|path| !path.is_empty())
        {
            return Ok(Some(path.to_string()));
        }
    }
    Ok(None)
}

fn set_custom_kernel_path(app: &AppHandle, path: Option<&str>) -> Result<(), String> {
    let value = path
        .map(|path| Value::String(path.to_string()))
        .unwrap_or(Value::Null);
    set_setting(app, "kernelPath", value.clone())?;
    set_setting(app, "core_custom_path", value)
}

fn default_mihomo_executable(app: &AppHandle) -> Result<PathBuf, String> {
    let exe_name = if cfg!(windows) {
        "mihomo.exe"
    } else {
        "mihomo"
    };
    let managed_core = app_data_dir(app)?.join("cores").join(exe_name);
    if managed_core.is_file() {
        return Ok(managed_core);
    }

    existing_resource_file(
        app,
        &[
            PathBuf::from("cores").join(exe_name),
            PathBuf::from("extra").join("sidecar").join(exe_name),
            PathBuf::from("sidecar").join(exe_name),
            PathBuf::from(exe_name),
        ],
    )
    .ok_or_else(|| {
        format!(
            "未找到 Mihomo 内核，已检查应用资源、extra/sidecar 与应用数据 cores 目录中的 {exe_name}"
        )
    })
}

fn find_mihomo_executable(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(custom) = custom_kernel_path(app)?.filter(|path| Path::new(path).exists()) {
        return Ok(PathBuf::from(custom));
    }
    let selected = core_path(app, None, None)?;
    if selected.is_file() {
        return Ok(selected);
    }
    default_mihomo_executable(app)
}

fn cores_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app_data_dir(app)?.join("cores");
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    Ok(dir)
}

fn short_path_digest(path: &Path) -> String {
    let digest = Sha256::digest(path.to_string_lossy().as_bytes());
    digest
        .iter()
        .take(6)
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()
}

fn service_compatible_core_path(app: &AppHandle, source: &Path) -> Result<PathBuf, String> {
    if !cfg!(target_os = "windows") {
        return Ok(source.to_path_buf());
    }

    let managed_dir = cores_dir(app)?;
    if let (Ok(source_real), Ok(managed_real)) =
        (fs::canonicalize(source), fs::canonicalize(&managed_dir))
    {
        if source_real.starts_with(&managed_real) {
            return Ok(source.to_path_buf());
        }
    }

    let source_name = source
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or("mihomo.exe");
    let ext = Path::new(source_name)
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| format!(".{value}"))
        .unwrap_or_else(|| ".exe".to_string());
    let stem = Path::new(source_name)
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("mihomo");
    let digest = short_path_digest(source);
    let target = managed_dir.join(format!(".service-runtime-{stem}-{digest}{ext}"));

    let should_copy = match (source.metadata(), target.metadata()) {
        (Ok(source_meta), Ok(target_meta)) => {
            source_meta.len() != target_meta.len()
                || source_meta
                    .modified()
                    .ok()
                    .zip(target_meta.modified().ok())
                    .map(|(source_modified, target_modified)| source_modified > target_modified)
                    .unwrap_or(false)
        }
        (Ok(_), Err(_)) => true,
        _ => false,
    };

    if should_copy {
        fs::copy(source, &target).map_err(|err| {
            format!(
                "复制 service 模式内核 {} 到 {} 失败: {err}",
                source.display(),
                target.display()
            )
        })?;
    }

    Ok(target)
}

fn same_existing_path(left: &Path, right: &Path) -> bool {
    match (fs::canonicalize(left), fs::canonicalize(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

fn core_file_name(core_type: &str, specific_version: Option<&str>) -> String {
    core_identity::managed_core_file_name(core_type, specific_version)
}

fn normalize_core_version(value: &str) -> String {
    core_identity::normalize_core_version(value)
}

fn core_version_from_output(output: &str) -> Option<String> {
    Regex::new(r"(?i)Mihomo.*?\sv([0-9A-Za-z.\-]+)")
        .ok()
        .and_then(|regex| {
            regex
                .captures(output)
                .and_then(|captures| captures.get(1).map(|value| value.as_str().to_string()))
        })
}

fn core_binary_version(path: &Path) -> Option<String> {
    if !path.exists() {
        return None;
    }

    command_output(&path.to_string_lossy(), &["-v"])
        .ok()
        .and_then(|output| core_version_from_output(&output))
}

fn installed_core_identity(name: &str) -> Option<(&'static str, Option<String>)> {
    core_identity::installed_core_identity(name)
}

fn system_time_millis(time: SystemTime) -> Option<u64> {
    let millis = time.duration_since(UNIX_EPOCH).ok()?.as_millis();
    Some(millis.min(u64::MAX as u128) as u64)
}

fn core_path(
    app: &AppHandle,
    core_type: Option<&str>,
    specific_version: Option<&str>,
) -> Result<PathBuf, String> {
    if core_type.is_none() {
        if let Some(custom) = custom_kernel_path(app)?.filter(|path| Path::new(path).exists()) {
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
    let stored_specific_version = if core_type == "mihomo-specific" && specific_version.is_none() {
        setting(app, "core_specific_version", Value::Null)
            .ok()
            .and_then(|value| value.as_str().map(normalize_core_version))
            .filter(|value| !value.is_empty())
    } else {
        None
    };
    Ok(cores_dir(app)?.join(core_file_name(
        &core_type,
        specific_version.or(stored_specific_version.as_deref()),
    )))
}

fn core_current_config(app: &AppHandle) -> CompatResult {
    let core_type = setting(app, "core_type", json!("mihomo"))?;
    let core_type_str = core_type
        .as_str()
        .map(ToString::to_string)
        .unwrap_or_else(|| "mihomo".to_string());
    let specific_version = setting(app, "core_specific_version", Value::Null)?;
    let custom_path = custom_kernel_path(app)?
        .map(Value::String)
        .unwrap_or(Value::Null);
    let path = core_path(app, None, None)?;
    let version = core_binary_version(&path)
        .map(Value::String)
        .unwrap_or(Value::Null);
    Ok(success(json!({
        "config": {
            "coreType": core_type,
            "specificVersion": specific_version,
            "customPath": custom_path
        },
        "corePath": path.to_string_lossy(),
        "version": version,
        "stableReleaseSeries": core_identity::is_stable_release_series(&core_type_str),
        "exists": path.exists()
    })))
}

fn core_installed(app: &AppHandle) -> CompatResult {
    let mut cores = Vec::new();
    let managed_dir = cores_dir(app)?;
    let mut sources = vec![(managed_dir.clone(), true, "managed")];
    if let Some(bundled_dir) = existing_resource_dir(app, &["extra/sidecar", "sidecar", "cores"]) {
        if !same_existing_path(&bundled_dir, &managed_dir) {
            sources.push((bundled_dir, false, "bundled"));
        }
    }

    for (dir, managed, source) in sources {
        if !dir.exists() {
            continue;
        }
        for entry in fs::read_dir(dir).map_err(|err| err.to_string())? {
            let entry = entry.map_err(|err| err.to_string())?;
            let path = entry.path();
            let metadata = entry.metadata().map_err(|err| err.to_string())?;
            if !metadata.is_file() {
                continue;
            }

            let name = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("");
            if let Some((core_type, file_version)) = installed_core_identity(name) {
                let version = file_version.or_else(|| core_binary_version(&path));
                let modified_at = metadata
                    .modified()
                    .ok()
                    .and_then(system_time_millis)
                    .unwrap_or(0);

                cores.push(json!({
                    "type": core_type,
                    "coreType": core_type,
                    "version": version,
                    "path": path.to_string_lossy(),
                    "size": metadata.len(),
                    "modifiedAt": modified_at,
                    "managed": managed,
                    "source": source
                }));
            }
        }
    }
    cores.sort_by(|a, b| {
        let a_time = a.get("modifiedAt").and_then(Value::as_u64).unwrap_or(0);
        let b_time = b.get("modifiedAt").and_then(Value::as_u64).unwrap_or(0);
        b_time.cmp(&a_time)
    });
    Ok(success(json!({ "cores": cores })))
}

fn core_repo(core_type: &str) -> (&'static str, &'static str, Option<&'static str>) {
    let repo = core_identity::core_repo(core_type);
    (repo.owner, repo.repo, repo.release_tag)
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

fn version_cache_key(core_type: &str, limit: usize) -> String {
    format!("{core_type}:{limit}")
}

fn clear_version_cache(state: &State<'_, AppState>, core_type: Option<&str>) -> usize {
    let mut runtime = state.runtime.lock().expect("runtime mutex poisoned");
    let before = runtime.version_cache.len();

    if let Some(core_type) = core_type.filter(|value| !value.trim().is_empty()) {
        let prefix = format!("{core_type}:");
        runtime
            .version_cache
            .retain(|key, _| !key.starts_with(&prefix));
    } else {
        runtime.version_cache.clear();
    }

    before.saturating_sub(runtime.version_cache.len())
}

fn release_to_version(release: Value) -> Value {
    let tag_name = release
        .get("tag_name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let version = tag_name.strip_prefix('v').unwrap_or(&tag_name).to_string();

    json!({
        "version": version,
        "tagName": tag_name,
        "name": release
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        "publishedAt": release
            .get("published_at")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        "prerelease": release
            .get("prerelease")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        "body": release
            .get("body")
            .and_then(Value::as_str)
            .unwrap_or_default()
    })
}

async fn release_versions(core_type: &str, limit: usize) -> Result<Vec<Value>, String> {
    let (owner, repo, _) = core_repo(core_type);
    let url = format!("https://api.github.com/repos/{owner}/{repo}/releases?per_page=100");
    let releases = github_json(&url).await?;
    let limit = limit.clamp(1, 100);
    let mut releases = releases.as_array().cloned().unwrap_or_default();

    if matches!(core_type, "mihomo" | "mihomo-specific") {
        releases.retain(|release| {
            !release
                .get("prerelease")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        });
    }

    Ok(releases
        .into_iter()
        .take(limit)
        .map(release_to_version)
        .collect())
}

async fn cached_release_versions(
    state: &State<'_, AppState>,
    core_type: &str,
    limit: usize,
    force_refresh: bool,
) -> Result<Vec<Value>, String> {
    let key = version_cache_key(core_type, limit);
    let now = now_millis();

    if !force_refresh {
        let cached = {
            let runtime = state.runtime.lock().expect("runtime mutex poisoned");
            runtime.version_cache.get(&key).cloned()
        };

        if let Some(entry) = cached {
            if now.saturating_sub(entry.timestamp) < VERSION_CACHE_EXPIRE_MS {
                return Ok(entry.versions);
            }
        }
    }

    let versions = release_versions(core_type, limit).await?;
    {
        let mut runtime = state.runtime.lock().expect("runtime mutex poisoned");
        runtime.version_cache.insert(
            key,
            VersionCacheEntry {
                versions: versions.clone(),
                timestamp: now_millis(),
            },
        );
    }
    Ok(versions)
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

fn emit_core_progress(
    window: &WebviewWindow,
    core_type: &str,
    version: Option<&str>,
    phase: &str,
    progress: f64,
    downloaded: u64,
    total: u64,
) {
    let _ = window.emit(
        "core:download-progress",
        json!({
            "coreType": core_type,
            "version": version,
            "phase": phase,
            "progress": progress.clamp(0.0, 100.0),
            "downloaded": downloaded,
            "total": total
        }),
    );
}

fn emit_core_error(window: &WebviewWindow, core_type: &str, version: Option<&str>, error: &str) {
    let _ = window.emit(
        "core:download-progress",
        json!({
            "coreType": core_type,
            "version": version,
            "phase": "error",
            "progress": 0,
            "downloaded": 0,
            "total": 0,
            "error": error
        }),
    );
}

async fn download_to(
    window: &WebviewWindow,
    core_type: &str,
    version: Option<&str>,
    url: &str,
    path: &Path,
) -> Result<(), String> {
    let mut response = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|err| err.to_string())?
        .get(url)
        .header("User-Agent", "FlyClash-Tauri")
        .send()
        .await
        .map_err(|err| err.to_string())?
        .error_for_status()
        .map_err(|err| err.to_string())?;
    let total = response.content_length().unwrap_or(0);
    let mut downloaded = 0u64;
    let mut file = fs::File::create(path).map_err(|err| err.to_string())?;

    emit_core_progress(window, core_type, version, "downloading", 0.0, 0, total);

    while let Some(chunk) = response.chunk().await.map_err(|err| err.to_string())? {
        file.write_all(&chunk).map_err(|err| err.to_string())?;
        downloaded = downloaded.saturating_add(chunk.len() as u64);
        let progress = if total > 0 {
            downloaded as f64 * 100.0 / total as f64
        } else {
            0.0
        };
        emit_core_progress(
            window,
            core_type,
            version,
            "downloading",
            progress,
            downloaded,
            total,
        );
    }

    file.flush().map_err(|err| err.to_string())
}

fn ensure_core_executable(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        let mut permissions = fs::metadata(path)
            .map_err(|err| err.to_string())?
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(path, permissions).map_err(|err| err.to_string())?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn extract_zip_core_archive(archive: &Path, dest: &Path) -> Result<(), String> {
    let file = fs::File::open(archive).map_err(|err| err.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|err| err.to_string())?;
    for index in 0..zip.len() {
        let mut entry = zip.by_index(index).map_err(|err| err.to_string())?;
        let name = entry.name().to_lowercase();
        if name.contains("mihomo") && !name.ends_with('/') {
            let mut out = fs::File::create(dest).map_err(|err| err.to_string())?;
            io::copy(&mut entry, &mut out).map_err(|err| err.to_string())?;
            ensure_core_executable(dest)?;
            return Ok(());
        }
    }
    Err("下载包中未找到 mihomo 可执行文件".to_string())
}

fn extract_gz_core_archive(archive: &Path, dest: &Path) -> Result<(), String> {
    let file = fs::File::open(archive).map_err(|err| err.to_string())?;
    let mut decoder = GzDecoder::new(file);
    let mut out = fs::File::create(dest).map_err(|err| err.to_string())?;
    io::copy(&mut decoder, &mut out).map_err(|err| err.to_string())?;
    ensure_core_executable(dest)
}

fn extract_core_archive(archive: &Path, dest: &Path, archive_name: &str) -> Result<(), String> {
    let normalized = archive_name.to_lowercase();
    if normalized.ends_with(".zip") {
        return extract_zip_core_archive(archive, dest);
    }
    if normalized.ends_with(".gz") {
        return extract_gz_core_archive(archive, dest);
    }
    Err("不支持的内核压缩包格式".to_string())
}

async fn download_core(
    app: &AppHandle,
    window: &WebviewWindow,
    core_type: &str,
    version: Option<String>,
) -> CompatResult {
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
    let tmp = cores_dir(app)?.join(format!("{archive_name}.tmp"));
    download_to(window, core_type, Some(&tag), download_url, &tmp).await?;
    emit_core_progress(window, core_type, Some(&tag), "verifying", 100.0, 0, 0);
    let dest = core_path(app, Some(core_type), version.as_deref().or(Some(&tag)))?;
    emit_core_progress(window, core_type, Some(&tag), "extracting", 100.0, 0, 0);
    let extract_result = extract_core_archive(&tmp, &dest, archive_name);
    let _ = fs::remove_file(tmp);
    extract_result?;
    emit_core_progress(window, core_type, Some(&tag), "done", 100.0, 0, 0);
    Ok(success(json!({
        "version": tag,
        "path": dest.to_string_lossy()
    })))
}

fn mihomo_mixed_port(app: &AppHandle) -> u16 {
    kernel_config_from_settings(app)
        .ok()
        .and_then(|config| config.get("mixed-port").cloned())
        .and_then(|value| {
            value
                .as_u64()
                .map(|port| port as u16)
                .or_else(|| value.as_str().and_then(|port| port.parse::<u16>().ok()))
        })
        .or_else(|| {
            setting(app, "mixed-port", Value::Null)
                .ok()
                .and_then(|value| {
                    value
                        .as_u64()
                        .map(|port| port as u16)
                        .or_else(|| value.as_str().and_then(|port| port.parse::<u16>().ok()))
                })
        })
        .unwrap_or(7890)
}

fn parse_host_port(value: &str) -> (Option<String>, Option<u16>) {
    let mut candidate = value.trim();
    if let Some((_, server)) = candidate.split_once('=') {
        candidate = server;
    }
    candidate = candidate.split(';').next().unwrap_or(candidate).trim();
    let Some((host, port)) = candidate.rsplit_once(':') else {
        return (
            if candidate.is_empty() {
                None
            } else {
                Some(candidate.to_string())
            },
            None,
        );
    };
    (
        if host.is_empty() {
            None
        } else {
            Some(host.to_string())
        },
        port.parse::<u16>().ok(),
    )
}

fn set_windows_proxy(
    enabled: bool,
    host: &str,
    port: u16,
    bypass: Option<&str>,
) -> Result<(), String> {
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
        let bypass = bypass.unwrap_or(DEFAULT_PROXY_BYPASS);
        let status = Command::new("reg")
            .args([
                "add",
                key,
                "/v",
                "ProxyOverride",
                "/t",
                "REG_SZ",
                "/d",
                bypass,
                "/f",
            ])
            .status()
            .map_err(|err| err.to_string())?;
        if !status.success() {
            return Err("写入 ProxyOverride 失败".to_string());
        }
    }
    let _ = Command::new("RUNDLL32.EXE")
        .args(["inetcpl.cpl,ClearMyTracksByProcess", "8"])
        .status();
    Ok(())
}

fn windows_proxy_status() -> Result<Value, String> {
    let key = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings";
    let enable_output = command_output("reg", &["query", key, "/v", "ProxyEnable"])?;
    let enabled = enable_output
        .split_whitespace()
        .last()
        .map(|value| value.eq_ignore_ascii_case("0x1") || value == "1")
        .unwrap_or(false);
    let server_output =
        command_output("reg", &["query", key, "/v", "ProxyServer"]).unwrap_or_default();
    let server = server_output
        .lines()
        .find(|line| line.contains("ProxyServer"))
        .and_then(|line| line.split_whitespace().last())
        .unwrap_or_default();
    let (host, port) = parse_host_port(server);
    let bypass_output =
        command_output("reg", &["query", key, "/v", "ProxyOverride"]).unwrap_or_default();
    let bypass = bypass_output
        .lines()
        .find(|line| line.contains("ProxyOverride"))
        .and_then(|line| line.split_once("REG_SZ"))
        .map(|(_, value)| value.trim().to_string())
        .filter(|value| !value.is_empty());
    Ok(success(json!({
        "enabled": enabled,
        "host": host,
        "port": port,
        "bypass": bypass,
        "source": "windows"
    })))
}

fn macos_network_services() -> Result<Vec<String>, String> {
    let output = command_output("networksetup", &["-listallnetworkservices"])?;
    Ok(output
        .lines()
        .skip(1)
        .map(str::trim)
        .filter(|service| !service.is_empty() && !service.starts_with('*'))
        .map(ToString::to_string)
        .collect())
}

fn set_macos_proxy(enabled: bool, host: &str, port: u16) -> Result<(), String> {
    let services = macos_network_services()?;
    let port = port.to_string();
    for service in services {
        if enabled {
            command_output("networksetup", &["-setwebproxy", &service, host, &port])?;
            command_output(
                "networksetup",
                &["-setsecurewebproxy", &service, host, &port],
            )?;
            command_output(
                "networksetup",
                &["-setsocksfirewallproxy", &service, host, &port],
            )?;
        } else {
            command_output("networksetup", &["-setwebproxystate", &service, "off"])?;
            command_output(
                "networksetup",
                &["-setsecurewebproxystate", &service, "off"],
            )?;
            command_output(
                "networksetup",
                &["-setsocksfirewallproxystate", &service, "off"],
            )?;
        }
    }
    Ok(())
}

fn macos_proxy_status() -> Result<Value, String> {
    let Some(service) = macos_network_services()?.into_iter().next() else {
        return Ok(success(json!({
            "enabled": false,
            "host": Value::Null,
            "port": Value::Null,
            "source": "macos"
        })));
    };
    let output = command_output("networksetup", &["-getwebproxy", &service])?;
    let mut enabled = false;
    let mut host = None;
    let mut port = None;
    for line in output.lines() {
        if let Some(value) = line.strip_prefix("Enabled:") {
            enabled = value.trim().eq_ignore_ascii_case("yes");
        } else if let Some(value) = line.strip_prefix("Server:") {
            let value = value.trim();
            if !value.is_empty() {
                host = Some(value.to_string());
            }
        } else if let Some(value) = line.strip_prefix("Port:") {
            port = value.trim().parse::<u16>().ok();
        }
    }
    Ok(success(json!({
        "enabled": enabled,
        "host": host,
        "port": port,
        "source": "macos",
        "service": service
    })))
}

fn system_proxy_status(app: &AppHandle) -> Value {
    let result = if cfg!(target_os = "windows") {
        windows_proxy_status()
    } else if cfg!(target_os = "macos") {
        macos_proxy_status()
    } else {
        Ok(success(json!({
            "enabled": setting(app, "systemProxyEnabled", json!(false))
                .ok()
                .and_then(|value| value.as_bool())
                .unwrap_or(false),
            "host": Value::Null,
            "port": Value::Null,
            "source": "stored"
        })))
    };

    match result {
        Ok(status) => status,
        Err(error) => success(json!({
            "enabled": setting(app, "systemProxyEnabled", json!(false))
                .ok()
                .and_then(|value| value.as_bool())
                .unwrap_or(false),
            "host": Value::Null,
            "port": Value::Null,
            "source": "stored",
            "error": error
        })),
    }
}

fn set_system_proxy(app: &AppHandle, enabled: bool, host: &str, port: u16) -> Result<(), String> {
    let bypass = setting(app, "system_proxy_bypass", json!(DEFAULT_PROXY_BYPASS))
        .ok()
        .and_then(|value| value.as_str().map(ToString::to_string));
    if cfg!(target_os = "windows") {
        set_windows_proxy(enabled, host, port, bypass.as_deref())?;
    } else if cfg!(target_os = "macos") {
        set_macos_proxy(enabled, host, port)?;
    } else if enabled {
        return Err("当前平台暂不支持自动设置系统代理".to_string());
    }

    if enabled {
        std::env::set_var("HTTP_PROXY", format!("http://{host}:{port}"));
        std::env::set_var("HTTPS_PROXY", format!("http://{host}:{port}"));
    } else {
        std::env::remove_var("HTTP_PROXY");
        std::env::remove_var("HTTPS_PROXY");
    }
    set_setting(app, "systemProxyEnabled", json!(enabled))?;
    Ok(())
}

fn kernel_setting_string(app: &AppHandle, key: &str) -> Option<String> {
    setting(app, "kernel", json!({})).ok().and_then(|value| {
        value
            .get(key)
            .and_then(Value::as_str)
            .map(ToString::to_string)
    })
}

fn split_controller(value: &str) -> (Option<String>, Option<u16>) {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return (None, None);
    }
    let without_scheme = trimmed
        .strip_prefix("http://")
        .or_else(|| trimmed.strip_prefix("https://"))
        .unwrap_or(trimmed);
    let endpoint = without_scheme.split('/').next().unwrap_or(without_scheme);
    let Some((host, port)) = endpoint.rsplit_once(':') else {
        return (Some(endpoint.to_string()), None);
    };
    let host = if host.is_empty() {
        None
    } else {
        Some(host.to_string())
    };
    let port = port.parse::<u16>().ok();
    (host, port)
}

fn controller_host(app: &AppHandle) -> String {
    if let Some(host) = setting(app, "controllerHost", Value::Null)
        .ok()
        .and_then(|value| value.as_str().map(ToString::to_string))
        .filter(|value| !value.trim().is_empty())
    {
        return host;
    }

    kernel_setting_string(app, "external-controller")
        .and_then(|value| split_controller(&value).0)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "127.0.0.1".to_string())
}

fn controller_port(app: &AppHandle) -> u16 {
    if let Some(port) = setting(app, "controllerPort", Value::Null)
        .ok()
        .and_then(|value| {
            value
                .as_u64()
                .map(|port| port as u16)
                .or_else(|| value.as_str().and_then(|port| port.parse::<u16>().ok()))
        })
    {
        return port;
    }

    kernel_setting_string(app, "external-controller")
        .and_then(|value| split_controller(&value).1)
        .unwrap_or(9090)
}

fn controller_secret(app: &AppHandle) -> String {
    if let Some(secret) = setting(app, "secret", json!(""))
        .ok()
        .and_then(|value| value.as_str().map(ToString::to_string))
        .filter(|value| !value.is_empty())
    {
        return secret;
    }

    kernel_setting_string(app, "secret").unwrap_or_default()
}

fn configured_http_controller(app: &AppHandle) -> bool {
    setting(app, "controllerHost", Value::Null)
        .ok()
        .and_then(|value| value.as_str().map(str::trim).map(|value| !value.is_empty()))
        .unwrap_or(false)
        || setting(app, "controllerPort", Value::Null)
            .ok()
            .map(|value| {
                value.as_u64().filter(|port| *port > 0).is_some()
                    || value
                        .as_str()
                        .and_then(|port| port.parse::<u16>().ok())
                        .filter(|port| *port > 0)
                        .is_some()
            })
            .unwrap_or(false)
        || kernel_setting_string(app, "external-controller")
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false)
}

fn runtime_running_mode(app: &AppHandle) -> RunningMode {
    match setting(app, "coreRunningMode", json!("notRunning"))
        .ok()
        .and_then(|value| value.as_str().map(ToString::to_string))
        .unwrap_or_else(|| "notRunning".to_string())
        .as_str()
    {
        "service" => RunningMode::Service,
        "sidecar" => RunningMode::Sidecar,
        _ => RunningMode::NotRunning,
    }
}

fn set_runtime_running_mode(app: &AppHandle, mode: RunningMode) {
    let value = match mode {
        RunningMode::Service => "service",
        RunningMode::Sidecar => "sidecar",
        RunningMode::NotRunning => "notRunning",
    };
    let _ = set_setting(app, "coreRunningMode", json!(value));
}

fn runtime_controller_endpoint(app: &AppHandle) -> core_controller::ControllerEndpoint {
    core_controller::endpoint_for_mode(runtime_running_mode(app))
        .unwrap_or_else(core_controller::sidecar_endpoint)
}

fn sync_core_running_state(app: &AppHandle) -> bool {
    let state = app.state::<AppState>();
    let persisted_mode = runtime_running_mode(app);
    let memory_mode = {
        let runtime = state.runtime.lock().expect("runtime mutex poisoned");
        runtime.core.running_mode()
    };
    let mode = if memory_mode == RunningMode::NotRunning {
        persisted_mode
    } else {
        memory_mode
    };

    match mode {
        RunningMode::Service => match core_service::get_status() {
            Ok(status) if status.running => {
                let active_config = read_last_config(app).ok().flatten();
                {
                    let mut runtime = state.runtime.lock().expect("runtime mutex poisoned");
                    runtime
                        .core
                        .sync_service_running(core_controller::service_endpoint(), active_config);
                }
                set_runtime_running_mode(app, RunningMode::Service);
                true
            }
            _ => {
                {
                    let mut runtime = state.runtime.lock().expect("runtime mutex poisoned");
                    runtime.core.sync_service_stopped();
                }
                set_runtime_running_mode(app, RunningMode::NotRunning);
                false
            }
        },
        RunningMode::Sidecar => {
            let running = {
                let mut runtime = state.runtime.lock().expect("runtime mutex poisoned");
                runtime.core.is_running()
            };
            set_runtime_running_mode(
                app,
                if running {
                    RunningMode::Sidecar
                } else {
                    RunningMode::NotRunning
                },
            );
            running
        }
        RunningMode::NotRunning => false,
    }
}

fn active_runtime_controller_endpoint(app: &AppHandle) -> core_controller::ControllerEndpoint {
    let _ = sync_core_running_state(app);
    let state = app.state::<AppState>();
    let runtime = state.runtime.lock().expect("runtime mutex poisoned");
    runtime
        .core
        .controller_endpoint_owned()
        .unwrap_or_else(|| runtime_controller_endpoint(app))
}

fn setting_bool(object: &Map<String, Value>, key: &str, fallback: bool) -> bool {
    object.get(key).and_then(Value::as_bool).unwrap_or(fallback)
}

fn setting_u64(object: &Map<String, Value>, key: &str, fallback: u64) -> u64 {
    object.get(key).and_then(Value::as_u64).unwrap_or(fallback)
}

fn setting_string(object: &Map<String, Value>, key: &str, fallback: &str) -> String {
    object
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or(fallback)
        .to_string()
}

fn build_tun_config(settings: &Map<String, Value>) -> Value {
    let enabled = settings
        .get("tunModeEnabled")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if !enabled {
        return json!({ "enable": false });
    }

    let saved = settings
        .get("tunConfig")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut tun = Map::new();
    tun.insert("enable".to_string(), Value::Bool(true));
    tun.insert(
        "device".to_string(),
        Value::String(setting_string(
            &saved,
            "device",
            if cfg!(target_os = "macos") {
                "utun"
            } else {
                "mihomo"
            },
        )),
    );
    tun.insert(
        "stack".to_string(),
        Value::String(setting_string(&saved, "stack", "system")),
    );
    tun.insert(
        "auto-route".to_string(),
        Value::Bool(setting_bool(&saved, "autoRoute", true)),
    );
    tun.insert(
        "auto-redirect".to_string(),
        Value::Bool(setting_bool(&saved, "autoRedirect", false)),
    );
    tun.insert(
        "auto-detect-interface".to_string(),
        Value::Bool(setting_bool(&saved, "autoDetectInterface", true)),
    );
    tun.insert(
        "dns-hijack".to_string(),
        saved
            .get("dnsHijack")
            .cloned()
            .unwrap_or_else(|| json!(["any:53"])),
    );
    tun.insert(
        "strict-route".to_string(),
        Value::Bool(setting_bool(&saved, "strictRoute", false)),
    );
    tun.insert(
        "route-exclude-address".to_string(),
        saved
            .get("routeExcludeAddress")
            .cloned()
            .unwrap_or_else(|| json!([])),
    );
    tun.insert(
        "mtu".to_string(),
        Value::Number(setting_u64(&saved, "mtu", 1500).into()),
    );
    if cfg!(target_os = "macos") {
        tun.insert(
            "auto-set-dns".to_string(),
            Value::Bool(setting_bool(&saved, "autoSetDNS", true)),
        );
    }
    Value::Object(tun)
}

fn runtime_user_settings(app: &AppHandle) -> Result<Value, String> {
    let settings = read_settings(app)?;
    let mut output = Map::new();
    let kernel = kernel_config_from_settings(app)?;
    if let Some(kernel) = kernel.as_object() {
        for key in KERNEL_FIELDS {
            if let Some(value) = kernel.get(*key) {
                output.insert((*key).to_string(), value.clone());
            }
        }
    }

    let dns = setting(app, "dns", Value::Null)?;
    if non_empty_object(&dns) {
        output.insert("dns".to_string(), dns);
    }

    let hosts = setting(app, "hosts", Value::Null)?;
    if non_empty_object(&hosts) {
        output.insert("hosts".to_string(), hosts);
    }

    let sniffer = setting(app, "sniffer", Value::Null)?;
    if non_empty_object(&sniffer) {
        output.insert("sniffer".to_string(), sniffer);
    }

    if settings.contains_key("tunModeEnabled") {
        output.insert("tun".to_string(), build_tun_config(&settings));
    }

    Ok(Value::Object(output))
}

fn unwrap_override_key(key: &str) -> String {
    if key.starts_with('<') && key.ends_with('>') && key.len() >= 2 {
        key[1..key.len() - 1].to_string()
    } else {
        key.to_string()
    }
}

fn merge_yaml_override(target: &Value, patch: &Value) -> Value {
    let mut result = target.as_object().cloned().unwrap_or_default();
    let Some(patch_object) = patch.as_object() else {
        return Value::Object(result);
    };

    for (raw_key, value) in patch_object {
        if value.is_object() {
            if let Some(key) = raw_key.strip_suffix('!') {
                result.insert(unwrap_override_key(key), value.clone());
                continue;
            }

            let key = unwrap_override_key(raw_key);
            let base = result
                .get(&key)
                .filter(|value| value.is_object())
                .cloned()
                .unwrap_or_else(|| json!({}));
            result.insert(key, merge_yaml_override(&base, value));
            continue;
        }

        if let Some(values) = value.as_array() {
            if let Some(key) = raw_key.strip_prefix('+') {
                let key = unwrap_override_key(key);
                let mut merged = values.clone();
                if let Some(current) = result.get(&key).and_then(Value::as_array) {
                    merged.extend(current.clone());
                }
                result.insert(key, Value::Array(merged));
                continue;
            }

            if let Some(key) = raw_key.strip_suffix('+') {
                let key = unwrap_override_key(key);
                let mut merged = result
                    .get(&key)
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                merged.extend(values.clone());
                result.insert(key, Value::Array(merged));
                continue;
            }

            result.insert(unwrap_override_key(raw_key), value.clone());
            continue;
        }

        result.insert(raw_key.clone(), value.clone());
    }

    Value::Object(result)
}

fn push_unique_id(ids: &mut Vec<String>, id: String) {
    if !ids.iter().any(|existing| existing == &id) {
        ids.push(id);
    }
}

fn subscription_override_ids(app: &AppHandle, config_path: &str) -> Result<Vec<String>, String> {
    let raw = db(app)?
        .query_row(
            "SELECT overrides FROM subscriptions WHERE file_path = ?1",
            params![config_path],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|err| err.to_string())?
        .unwrap_or_else(|| "[]".to_string());

    let parsed = serde_json::from_str::<Value>(&raw).unwrap_or(Value::Null);
    Ok(parsed
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default())
}

fn run_js_override(config: &Value, script_content: &str, item_name: &str) -> Result<Value, String> {
    let config_json = serde_json::to_string(config).map_err(|err| err.to_string())?;
    let code = format!(
        r#"
globalThis.console = globalThis.console || {{
  log() {{}},
  warn() {{}},
  error() {{}}
}};
{script_content}
const __flyclash_result = main({config_json});
JSON.stringify(__flyclash_result || {config_json});
"#
    );

    let mut context = JsContext::default();
    context
        .runtime_limits_mut()
        .set_loop_iteration_limit(5_000_000);
    context.runtime_limits_mut().set_recursion_limit(1024);

    let result = context
        .eval(Source::from_bytes(code.as_bytes()))
        .map_err(|err| format!("JS覆写执行失败 [{}]: {:?}", item_name, err))?;
    let Some(result_json) = result.as_string() else {
        return Err(format!("JS覆写未返回可序列化配置 [{}]", item_name));
    };
    let result_json = result_json.to_std_string_escaped();
    let parsed = serde_json::from_str::<Value>(&result_json)
        .map_err(|err| format!("JS覆写返回值不是有效JSON [{}]: {}", item_name, err))?;
    if !parsed.is_object() {
        return Err(format!("JS覆写必须返回配置对象 [{}]", item_name));
    }

    Ok(parsed)
}

fn apply_overrides(app: &AppHandle, config_path: &str, config: Value) -> Result<Value, String> {
    let enabled_items = all_overrides(app)?
        .into_iter()
        .filter(|item| {
            item.get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        })
        .collect::<Vec<_>>();

    if enabled_items.is_empty() {
        return Ok(config);
    }

    let mut ordered_ids = Vec::new();
    for item in &enabled_items {
        let is_global = item.get("global").and_then(Value::as_bool).unwrap_or(false);
        if !is_global {
            continue;
        }
        if let Some(id) = item.get("id").and_then(Value::as_str) {
            push_unique_id(&mut ordered_ids, id.to_string());
        }
    }

    for id in subscription_override_ids(app, config_path).unwrap_or_default() {
        if enabled_items
            .iter()
            .any(|item| item.get("id").and_then(Value::as_str) == Some(id.as_str()))
        {
            push_unique_id(&mut ordered_ids, id);
        }
    }

    let mut result = config;
    for id in ordered_ids {
        let Some(item) = enabled_items
            .iter()
            .find(|item| item.get("id").and_then(Value::as_str) == Some(id.as_str()))
        else {
            continue;
        };

        let content = match override_content(app, &id) {
            Ok(content) => content,
            Err(_) => continue,
        };
        if content.trim().is_empty() {
            continue;
        }

        match item.get("ext").and_then(Value::as_str) {
            Some("js") => {
                let name = item.get("name").and_then(Value::as_str).unwrap_or(&id);
                match run_js_override(&result, &content, name) {
                    Ok(next) => result = next,
                    Err(error) => eprintln!("{}", error),
                }
            }
            Some("yaml") => {
                let patch_yaml = match serde_yaml::from_str::<serde_yaml::Value>(&content) {
                    Ok(value) => value,
                    Err(_) => continue,
                };
                let patch = serde_json::to_value(patch_yaml).unwrap_or(Value::Null);
                if patch.is_object() {
                    result = merge_yaml_override(&result, &patch);
                }
            }
            _ => continue,
        }
    }

    Ok(result)
}

#[cfg(test)]
mod override_tests {
    use super::*;

    #[test]
    fn js_override_returns_modified_config() {
        let config = json!({
            "proxies": [{ "name": "node-a" }],
            "proxy-groups": []
        });
        let script = r#"
function main(config) {
  config.proxies.push({ name: 'node-b' });
  return config;
}
"#;

        let result = run_js_override(&config, script, "test-js").unwrap();

        assert_eq!(
            result
                .get("proxies")
                .and_then(Value::as_array)
                .map(Vec::len),
            Some(2)
        );
    }

    #[test]
    fn js_override_rejects_non_object_result() {
        let config = json!({ "proxies": [] });
        let result = run_js_override(&config, "function main() { return 'bad'; }", "test-js");

        assert!(result.is_err());
    }

    #[test]
    fn converter_template_conversion_rejects_missing_template() {
        let result = converter_conversion_payload(
            "proxies:\n  - name: node-a\n    type: ss\n    server: example.com\n    port: 443\n    cipher: aes-128-gcm\n    password: pass\n",
            Some("clash-meta"),
            None,
            None,
            Some("missing-template"),
        );

        assert_eq!(result.get("success").and_then(Value::as_bool), Some(false));
        assert!(result
            .get("errorMessage")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .contains("模板不存在"));
    }
}

fn runtime_config_error_response(
    error: &core_config::RuntimeConfigPrepareError,
    reloaded: Option<bool>,
) -> Value {
    let mut payload = serde_json::Map::new();
    payload.insert("success".to_string(), Value::Bool(false));
    payload.insert("configError".to_string(), Value::Bool(true));
    payload.insert(
        "errorKind".to_string(),
        Value::String(error.error_kind().to_string()),
    );
    payload.insert(
        "error".to_string(),
        Value::String(error.message().to_string()),
    );
    if let Some(reloaded) = reloaded {
        payload.insert("reloaded".to_string(), Value::Bool(reloaded));
    }
    if let Some(validation) = error.validation_payload() {
        payload.insert("validation".to_string(), validation);
    }
    Value::Object(payload)
}

fn prepare_runtime_config(
    app: &AppHandle,
    config_path: &str,
    core_executable: &Path,
) -> Result<PathBuf, core_config::RuntimeConfigPrepareError> {
    let content = config_content(app, config_path)
        .map_err(core_config::RuntimeConfigPrepareError::prepare_failed)?;
    let runtime_settings = runtime_user_settings(app)
        .map_err(core_config::RuntimeConfigPrepareError::prepare_failed)?;

    sync_bundled_mihomo_data(app)
        .map_err(core_config::RuntimeConfigPrepareError::prepare_failed)?;
    let work_dir =
        mihomo_dir(app).map_err(core_config::RuntimeConfigPrepareError::prepare_failed)?;
    core_config::prepare_validated_runtime_config(
        &content,
        &runtime_settings,
        core_executable,
        &work_dir,
        |config| apply_overrides(app, config_path, config),
    )
}

async fn request_http(
    app: &AppHandle,
    target: Option<String>,
    options: Option<Value>,
) -> CompatResult {
    request_http_inner(app, target, options, false).await
}

async fn request_http_via_proxy(
    app: &AppHandle,
    target: Option<String>,
    options: Option<Value>,
) -> CompatResult {
    request_http_inner(app, target, options, true).await
}

fn fetch_proxy_url(app: &AppHandle, proxy: Option<&Value>) -> Result<String, String> {
    let proxy = proxy.cloned().unwrap_or_else(|| json!({}));
    let host = proxy
        .get("host")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("127.0.0.1");
    let port = value_u16(proxy.get("port")).unwrap_or_else(|| mihomo_mixed_port(app));
    if port == 0 {
        return Err("代理端口无效".to_string());
    }
    let protocol = proxy
        .get("protocol")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("http")
        .to_ascii_lowercase();
    if protocol != "http" && protocol != "https" {
        return Err(format!(
            "暂不支持 {protocol} 代理协议，请使用 Mihomo mixed-port 的 HTTP 代理"
        ));
    }
    Ok(format!("{protocol}://{host}:{port}"))
}

fn controller_body_bytes(body: Option<&Value>) -> Result<Option<Vec<u8>>, String> {
    match body {
        Some(Value::String(text)) => Ok(Some(text.as_bytes().to_vec())),
        Some(value) => serde_json::to_vec(value)
            .map(Some)
            .map_err(|err| err.to_string()),
        None => Ok(None),
    }
}

async fn request_http_inner(
    app: &AppHandle,
    target: Option<String>,
    options: Option<Value>,
    use_proxy: bool,
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
            proxy: None,
        },
    };

    let endpoint = target.or(options.url.clone()).unwrap_or_default();
    if endpoint.is_empty() {
        return Err("missing request url".to_string());
    }

    let is_absolute_url = endpoint.starts_with("http://") || endpoint.starts_with("https://");
    let mut socket_fallback_error: Option<String> = None;
    if !is_absolute_url && !use_proxy {
        let timeout = Duration::from_millis(options.timeout.unwrap_or(30_000));
        let controller_endpoint = active_runtime_controller_endpoint(app);
        match core_controller::request(
            &controller_endpoint,
            &options.method,
            &endpoint,
            &options.headers,
            controller_body_bytes(options.body.as_ref())?,
            &controller_secret(app),
            timeout,
        )
        .await
        {
            Ok(response) => return Ok(response),
            Err(socket_error) => {
                if !configured_http_controller(app) {
                    return Ok(json!({
                        "ok": false,
                        "status": 0,
                        "statusText": "Mihomo socket controller unavailable",
                        "headers": {},
                        "data": { "message": socket_error.clone() },
                        "text": socket_error,
                        "controllerMode": "socket",
                        "socketPath": controller_endpoint.path,
                        "socketArg": controller_endpoint.arg_name
                    }));
                }
                eprintln!("[mihomo-controller] socket request failed, falling back to HTTP: {socket_error}");
                socket_fallback_error = Some(socket_error);
            }
        }
    }

    let url = if is_absolute_url {
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
    let mut client_builder = reqwest::Client::builder()
        .timeout(timeout)
        .danger_accept_invalid_certs(true);
    if use_proxy && is_absolute_url {
        let proxy_url = fetch_proxy_url(app, options.proxy.as_ref())?;
        client_builder =
            client_builder.proxy(reqwest::Proxy::all(&proxy_url).map_err(|err| err.to_string())?);
    }
    let client = client_builder.build().map_err(|err| err.to_string())?;
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

    if !is_absolute_url {
        let secret = controller_secret(app);
        if !secret.is_empty() {
            request = request.bearer_auth(secret);
        }
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

    let mut payload = json!({
        "ok": status.is_success(),
        "status": status.as_u16(),
        "statusText": status_text,
        "headers": headers,
        "data": data,
        "text": text
    });

    if !is_absolute_url {
        if let Some(object) = payload.as_object_mut() {
            object.insert(
                "controllerMode".to_string(),
                Value::String("http".to_string()),
            );
            object.insert("httpFallback".to_string(), Value::Bool(true));
            object.insert(
                "controllerHost".to_string(),
                Value::String(controller_host(app)),
            );
            object.insert(
                "controllerPort".to_string(),
                Value::String(controller_port(app).to_string()),
            );
            if let Some(socket_error) = socket_fallback_error {
                object.insert("fallbackFromSocket".to_string(), Value::Bool(true));
                object.insert("socketError".to_string(), Value::String(socket_error));
            }
        }
    }

    Ok(payload)
}

fn http_error_message(response: &Value, fallback: &str) -> String {
    let data = response.get("data");
    let text = response
        .get("error")
        .and_then(Value::as_str)
        .or_else(|| response.get("errorBody").and_then(Value::as_str))
        .or_else(|| {
            data.and_then(|value| value.get("error"))
                .and_then(Value::as_str)
        })
        .or_else(|| {
            data.and_then(|value| value.get("message"))
                .and_then(Value::as_str)
        })
        .or_else(|| response.get("statusText").and_then(Value::as_str))
        .or_else(|| response.get("text").and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty());

    if let Some(text) = text {
        return text.to_string();
    }

    response
        .get("status")
        .and_then(Value::as_u64)
        .filter(|status| *status > 0)
        .map(|status| format!("{fallback} (HTTP {status})"))
        .unwrap_or_else(|| fallback.to_string())
}

fn http_failure(response: &Value, fallback: &str) -> Option<String> {
    (!response.get("ok").and_then(Value::as_bool).unwrap_or(false))
        .then(|| http_error_message(response, fallback))
}

async fn controller_probe_payload(app: &AppHandle) -> Value {
    let controller_metadata = |response: &Value| {
        let mut metadata = Map::new();
        for key in [
            "controllerMode",
            "socketPath",
            "socketArg",
            "httpFallback",
            "fallbackFromSocket",
            "socketError",
            "controllerHost",
            "controllerPort",
        ] {
            if let Some(value) = response.get(key) {
                metadata.insert(key.to_string(), value.clone());
            }
        }
        metadata
    };

    match request_http(
        app,
        Some("/version".to_string()),
        Some(json!({ "timeout": 2_000 })),
    )
    .await
    {
        Ok(response) => {
            if let Some(error) = http_failure(&response, "Mihomo controller unavailable") {
                let mut payload = json!({
                    "controllerAvailable": false,
                    "controllerError": error,
                    "controllerStatus": response.get("status").cloned().unwrap_or(Value::Null),
                    "coreVersion": Value::Null,
                    "coreMeta": Value::Null,
                    "corePremium": Value::Null
                });
                if let Some(object) = payload.as_object_mut() {
                    object.extend(controller_metadata(&response));
                }
                return payload;
            }

            let data = response.get("data").unwrap_or(&Value::Null);
            let mut payload = json!({
                "controllerAvailable": true,
                "controllerError": Value::Null,
                "controllerStatus": response.get("status").cloned().unwrap_or(Value::Null),
                "coreVersion": data
                    .get("version")
                    .and_then(Value::as_str)
                    .map(|value| Value::String(value.to_string()))
                    .unwrap_or(Value::Null),
                "coreMeta": data
                    .get("meta")
                    .and_then(Value::as_bool)
                    .map(Value::Bool)
                    .unwrap_or(Value::Null),
                "corePremium": data
                    .get("premium")
                    .and_then(Value::as_bool)
                    .map(Value::Bool)
                    .unwrap_or(Value::Null)
            });
            if let Some(object) = payload.as_object_mut() {
                object.extend(controller_metadata(&response));
            }
            payload
        }
        Err(error) => {
            let controller_endpoint = active_runtime_controller_endpoint(app);
            json!({
                "controllerAvailable": false,
                "controllerError": error,
                "controllerStatus": Value::Null,
                "controllerMode": "socket",
                "socketPath": controller_endpoint.path,
                "socketArg": controller_endpoint.arg_name,
                "coreVersion": Value::Null,
                "coreMeta": Value::Null,
                "corePremium": Value::Null
            })
        }
    }
}

fn send_ai_stream_ready(sender: &mut Option<tokio::sync::oneshot::Sender<Value>>, value: Value) {
    if let Some(sender) = sender.take() {
        let _ = sender.send(value);
    }
}

fn register_ai_stream(
    app: &AppHandle,
    request_id: &str,
    abort_tx: tokio::sync::oneshot::Sender<()>,
) {
    let previous = {
        let state = app.state::<AppState>();
        let mut runtime = state.runtime.lock().expect("runtime mutex poisoned");
        runtime.ai_streams.insert(request_id.to_string(), abort_tx)
    };

    if let Some(previous) = previous {
        let _ = previous.send(());
    }
}

fn unregister_ai_stream(app: &AppHandle, request_id: &str) {
    let state = app.state::<AppState>();
    let mut runtime = state.runtime.lock().expect("runtime mutex poisoned");
    runtime.ai_streams.remove(request_id);
}

fn abort_ai_stream(app: &AppHandle, request_id: &str) -> bool {
    let sender = {
        let state = app.state::<AppState>();
        let mut runtime = state.runtime.lock().expect("runtime mutex poisoned");
        runtime.ai_streams.remove(request_id)
    };

    if let Some(sender) = sender {
        let _ = sender.send(());
        true
    } else {
        false
    }
}

async fn run_ai_proxy_stream(
    app: AppHandle,
    window: WebviewWindow,
    options: FetchOptions,
    request_id: String,
    mut ready_tx: Option<tokio::sync::oneshot::Sender<Value>>,
    mut abort_rx: tokio::sync::oneshot::Receiver<()>,
) {
    let endpoint = options.url.clone().unwrap_or_default();
    if endpoint.is_empty() {
        send_ai_stream_ready(
            &mut ready_tx,
            json!({ "ok": false, "status": 0, "errorBody": "missing request url" }),
        );
        unregister_ai_stream(&app, &request_id);
        return;
    }

    let is_absolute_url = endpoint.starts_with("http://") || endpoint.starts_with("https://");
    let url = if is_absolute_url {
        endpoint
    } else {
        format!(
            "http://{}:{}{}",
            controller_host(&app),
            controller_port(&app),
            endpoint
        )
    };

    let timeout_ms = options.timeout.unwrap_or(60_000).max(1);
    let client = match reqwest::Client::builder()
        .connect_timeout(Duration::from_millis(timeout_ms))
        .danger_accept_invalid_certs(true)
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            send_ai_stream_ready(
                &mut ready_tx,
                json!({ "ok": false, "status": 0, "errorBody": error.to_string() }),
            );
            unregister_ai_stream(&app, &request_id);
            return;
        }
    };

    let method = match options.method.parse::<reqwest::Method>() {
        Ok(method) => method,
        Err(error) => {
            send_ai_stream_ready(
                &mut ready_tx,
                json!({ "ok": false, "status": 0, "errorBody": error.to_string() }),
            );
            unregister_ai_stream(&app, &request_id);
            return;
        }
    };

    let mut request = client.request(method, &url);
    for (key, value) in options.headers {
        if let Some(value) = value.as_str() {
            request = request.header(key, value);
        }
    }

    if !is_absolute_url {
        let secret = controller_secret(&app);
        if !secret.is_empty() {
            request = request.bearer_auth(secret);
        }
    }

    if let Some(body) = options.body {
        request = match body {
            Value::String(text) => request.body(text),
            other => request.json(&other),
        };
    }

    let send_future = request.send();
    let response = tokio::select! {
        _ = &mut abort_rx => {
            send_ai_stream_ready(
                &mut ready_tx,
                json!({ "ok": false, "status": 0, "errorBody": "aborted" }),
            );
            unregister_ai_stream(&app, &request_id);
            return;
        }
        result = tokio::time::timeout(Duration::from_millis(timeout_ms), send_future) => {
            match result {
                Ok(Ok(response)) => response,
                Ok(Err(error)) => {
                    send_ai_stream_ready(
                        &mut ready_tx,
                        json!({ "ok": false, "status": 0, "errorBody": error.to_string() }),
                    );
                    unregister_ai_stream(&app, &request_id);
                    return;
                }
                Err(_) => {
                    send_ai_stream_ready(
                        &mut ready_tx,
                        json!({ "ok": false, "status": 0, "errorBody": "请求超时，请检查网络连接" }),
                    );
                    unregister_ai_stream(&app, &request_id);
                    return;
                }
            }
        }
    };

    let mut response = response;
    let status = response.status();
    if !status.is_success() {
        let error_body = response.text().await.unwrap_or_default();
        send_ai_stream_ready(
            &mut ready_tx,
            json!({
                "ok": false,
                "status": status.as_u16(),
                "errorBody": error_body
            }),
        );
        unregister_ai_stream(&app, &request_id);
        return;
    }

    send_ai_stream_ready(
        &mut ready_tx,
        json!({ "ok": true, "status": status.as_u16() }),
    );

    loop {
        let chunk = tokio::select! {
            _ = &mut abort_rx => {
                let _ = window.emit(
                    "ai-proxy-stream-error",
                    json!({ "requestId": request_id.as_str(), "error": "AbortError" }),
                );
                unregister_ai_stream(&app, &request_id);
                return;
            }
            chunk = response.chunk() => chunk,
        };

        match chunk {
            Ok(Some(chunk)) => {
                let _ = window.emit(
                    "ai-proxy-stream-chunk",
                    json!({ "requestId": request_id.as_str(), "chunk": chunk.to_vec() }),
                );
            }
            Ok(None) => {
                let _ = window.emit(
                    "ai-proxy-stream-end",
                    json!({ "requestId": request_id.as_str() }),
                );
                unregister_ai_stream(&app, &request_id);
                return;
            }
            Err(error) => {
                let _ = window.emit(
                    "ai-proxy-stream-error",
                    json!({ "requestId": request_id.as_str(), "error": error.to_string() }),
                );
                unregister_ai_stream(&app, &request_id);
                return;
            }
        }
    }
}

async fn start_ai_proxy_stream(
    app: &AppHandle,
    window: &WebviewWindow,
    config: Value,
) -> CompatResult {
    let request_id = config
        .get("requestId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .ok_or_else(|| "missing AI stream requestId".to_string())?;
    let options = serde_json::from_value::<FetchOptions>(config).map_err(|err| err.to_string())?;

    let (abort_tx, abort_rx) = tokio::sync::oneshot::channel();
    register_ai_stream(app, &request_id, abort_tx);

    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
    let task_app = app.clone();
    let task_window = window.clone();
    let task_request_id = request_id.clone();

    tokio::spawn(async move {
        run_ai_proxy_stream(
            task_app,
            task_window,
            options,
            task_request_id,
            Some(ready_tx),
            abort_rx,
        )
        .await;
    });

    ready_rx
        .await
        .map_err(|_| "AI stream task stopped before response".to_string())
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

async fn stop_mihomo_process(app: &AppHandle, state: &State<'_, AppState>) -> Result<(), String> {
    let _ = sync_core_running_state(app);
    let running_mode = {
        let runtime = state.runtime.lock().expect("runtime mutex poisoned");
        core_lifecycle::stop_mode(&runtime.core)
    };

    if running_mode == RunningMode::Service {
        match core_lifecycle::stop_service_core_checked() {
            Ok(core_lifecycle::ServiceCoreStopResult::Stopped) => {}
            Ok(core_lifecycle::ServiceCoreStopResult::AlreadyStoppedAfterError { error }) => {
                eprintln!(
                    "[core-service] stop helper returned an error after service stopped: {error}"
                );
            }
            Err(error) => {
                eprintln!("[core-service] failed to stop core through helper: {error}");
                let _ = app.emit("mihomo-stop-failed", json!({ "error": error }));
                return Err(error);
            }
        }
    }

    {
        let mut runtime = state.runtime.lock().expect("runtime mutex poisoned");
        core_lifecycle::complete_core_stop(&mut runtime.core);
    }
    set_runtime_running_mode(app, RunningMode::NotRunning);
    Ok(())
}

async fn start_mihomo(
    app: &AppHandle,
    state: &State<'_, AppState>,
    config_path: &str,
) -> CompatResult {
    let config_path = if config_path.trim().is_empty() {
        startup_mihomo_config(app)?
            .ok_or_else(|| "没有可用的配置文件，且最小配置创建失败".to_string())?
    } else {
        normalize_config_reference(app, config_path)?
    };
    let _ = config_content(app, &config_path)
        .map_err(|err| format!("配置文件不存在或无法解密: {err}"))?;

    let mihomo = find_mihomo_executable(app)?;
    let runtime_config = match prepare_runtime_config(app, &config_path, &mihomo) {
        Ok(path) => path,
        Err(error) => {
            return Ok(runtime_config_error_response(&error, None));
        }
    };
    let work_dir = mihomo_dir(app)?;
    let log_path = work_dir.join("mihomo.log");

    if let Err(error) = stop_mihomo_process(app, state).await {
        return Ok(
            core_lifecycle::start_failure_completion(format!("停止现有内核失败: {error}")).response,
        );
    }

    if should_start_core_by_service(app) {
        let service_mihomo = service_compatible_core_path(app, &mihomo)?;
        if let Err(error) = core_service::ensure_helper_service_ready() {
            return Ok(core_lifecycle::start_failure_completion(format!(
                "TUN 服务模式已启用，但 Helper 服务不可用: {error}"
            ))
            .response);
        }

        set_runtime_running_mode(app, RunningMode::Service);
        match core_lifecycle::start_service_core(
            &service_mihomo,
            &work_dir,
            &runtime_config,
            &log_path,
        ) {
            Ok(launch) => {
                let controller_endpoint = launch.controller_endpoint;
                {
                    let mut runtime = state.runtime.lock().expect("runtime mutex poisoned");
                    core_lifecycle::begin_service_launch(
                        &mut runtime.core,
                        controller_endpoint.clone(),
                    );
                }
                let service_start = {
                    let controller_ready = wait_for_mihomo(app).await;
                    let mut runtime = state.runtime.lock().expect("runtime mutex poisoned");
                    core_lifecycle::complete_service_launch_with_response(
                        &mut runtime.core,
                        controller_endpoint.clone(),
                        config_path.clone(),
                        controller_ready,
                    )
                };

                if service_start.started {
                    save_last_config(app, &config_path)?;
                    emit_active_config_changed(app, Some(&config_path));
                    return Ok(service_start.response);
                }

                let error = service_start
                    .error
                    .clone()
                    .unwrap_or_else(|| "Helper 服务启动内核失败".to_string());
                let _ = core_lifecycle::stop_service_core();
                set_runtime_running_mode(app, RunningMode::NotRunning);
                {
                    let mut runtime = state.runtime.lock().expect("runtime mutex poisoned");
                    core_lifecycle::abort_service_launch(&mut runtime.core);
                }
                let _ = app.emit("mihomo-start-failed", json!({ "error": error }));
                return Ok(service_start.response);
            }
            Err(error) => {
                let start_failure = core_lifecycle::start_failure_completion(format!(
                    "通过 Helper 服务启动内核失败: {error}"
                ));
                set_runtime_running_mode(app, RunningMode::NotRunning);
                {
                    let mut runtime = state.runtime.lock().expect("runtime mutex poisoned");
                    core_lifecycle::abort_service_launch(&mut runtime.core);
                }
                let _ = app.emit(
                    "mihomo-start-failed",
                    json!({ "error": start_failure.error.clone().unwrap_or_default() }),
                );
                return Ok(start_failure.response);
            }
        }
    }

    let sidecar =
        match core_lifecycle::start_sidecar_core(&mihomo, &work_dir, &runtime_config, &log_path) {
            Ok(sidecar) => sidecar,
            Err(error) => {
                let start_failure =
                    core_lifecycle::start_failure_completion(format!("启动内核失败: {error}"));
                let _ = app.emit(
                    "mihomo-start-failed",
                    json!({ "error": start_failure.error.clone().unwrap_or_default() }),
                );
                return Ok(start_failure.response);
            }
        };

    {
        let mut runtime = state.runtime.lock().expect("runtime mutex poisoned");
        core_lifecycle::begin_sidecar_launch(&mut runtime.core, sidecar);
    }
    set_runtime_running_mode(app, RunningMode::Sidecar);

    let sidecar_start = {
        let controller_ready = wait_for_mihomo(app).await;
        let mut runtime = state.runtime.lock().expect("runtime mutex poisoned");
        core_lifecycle::complete_sidecar_launch_with_response(
            &mut runtime.core,
            config_path.clone(),
            controller_ready,
        )
    };

    if sidecar_start.started {
        save_last_config(app, &config_path)?;
        emit_active_config_changed(app, Some(&config_path));
        Ok(sidecar_start.response)
    } else {
        let error = sidecar_start
            .error
            .clone()
            .unwrap_or_else(|| "内核启动失败".to_string());
        {
            let mut runtime = state.runtime.lock().expect("runtime mutex poisoned");
            core_lifecycle::abort_sidecar_launch(&mut runtime.core);
        }
        set_runtime_running_mode(app, RunningMode::NotRunning);
        let _ = app.emit("mihomo-start-failed", json!({ "error": error }));
        Ok(sidecar_start.response)
    }
}

fn startup_mihomo_config(app: &AppHandle) -> Result<Option<String>, String> {
    if let Some(config_path) = read_last_config(app)? {
        if config_content(app, &config_path).is_ok() {
            return Ok(Some(config_path));
        }
        eprintln!("[mihomo-autostart] saved active config is not readable, falling back");
    }

    for subscription in read_subscriptions(app)? {
        if config_content(app, &subscription.path).is_ok() {
            return Ok(Some(subscription.path));
        }
    }

    Ok(Some(ensure_minimal_mihomo_config(app)?))
}

fn schedule_mihomo_autostart(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(1000)).await;

        let state = app.state::<AppState>();
        if is_mihomo_running(&app) {
            let config_path = state
                .runtime
                .lock()
                .expect("runtime mutex poisoned")
                .core
                .active_config_owned()
                .or_else(|| read_last_config(&app).ok().flatten());
            let _ = app.emit(
                "mihomo-autostart",
                json!({ "success": true, "existing": true, "configPath": config_path }),
            );
            return;
        }

        let config_path = match startup_mihomo_config(&app) {
            Ok(Some(config_path)) => config_path,
            Ok(None) => {
                eprintln!("[mihomo-autostart] no available config, skip startup");
                return;
            }
            Err(error) => {
                eprintln!("[mihomo-autostart] failed to resolve startup config: {error}");
                let _ = app.emit(
                    "mihomo-autostart",
                    json!({ "success": false, "error": error }),
                );
                return;
            }
        };

        match start_mihomo(&app, &state, &config_path).await {
            Ok(result) => {
                let success = result
                    .get("success")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let payload = if success {
                    json!({ "success": true, "configPath": config_path })
                } else {
                    let error = result
                        .get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("Mihomo 自动启动失败");
                    eprintln!("[mihomo-autostart] start failed: {error}");
                    json!({
                        "success": false,
                        "configPath": config_path,
                        "error": error
                    })
                };
                let _ = app.emit("mihomo-autostart", payload);
            }
            Err(error) => {
                eprintln!("[mihomo-autostart] start failed: {error}");
                let _ = app.emit("mihomo-start-failed", json!({ "error": error.clone() }));
                let _ = app.emit(
                    "mihomo-autostart",
                    json!({ "success": false, "configPath": config_path, "error": error }),
                );
            }
        }
    });
}

async fn reload_mihomo_config(
    app: &AppHandle,
    state: &State<'_, AppState>,
    config_path: &str,
) -> CompatResult {
    let config_path = normalize_config_reference(app, config_path)?;
    if config_path.trim().is_empty() {
        return Ok(json!({
            "success": false,
            "error": "配置文件路径为空，无法热重载"
        }));
    }

    let _ = config_content(app, &config_path)
        .map_err(|err| format!("配置文件不存在或无法解密: {err}"))?;

    if !is_mihomo_running(app) {
        return Ok(json!({
            "success": false,
            "error": "Mihomo 服务未运行，无法热重载配置"
        }));
    }

    let mihomo = find_mihomo_executable(app)?;
    let runtime_config = match prepare_runtime_config(app, &config_path, &mihomo) {
        Ok(path) => path,
        Err(error) => {
            return Ok(runtime_config_error_response(&error, Some(false)));
        }
    };
    let reload_request = core_lifecycle::reload_config_request(&runtime_config);
    let response = request_http(
        app,
        Some(reload_request.endpoint.to_string()),
        Some(reload_request.options),
    )
    .await?;

    let reload_completion = {
        let mut runtime = state.runtime.lock().expect("runtime mutex poisoned");
        core_lifecycle::complete_reload_from_response(
            &mut runtime.core,
            config_path.clone(),
            &response,
        )
    };

    if reload_completion.applied {
        save_last_config(app, &config_path)?;
        emit_active_config_changed(app, Some(&config_path));
    }

    Ok(reload_completion.response)
}

async fn refresh_active_config_after_override(
    app: &AppHandle,
    state: &State<'_, AppState>,
) -> Value {
    if !is_mihomo_running(app) {
        return json!({
            "reloaded": false,
            "skipped": true,
            "reason": "mihomo-not-running"
        });
    }

    let active = state
        .runtime
        .lock()
        .expect("runtime mutex poisoned")
        .core
        .active_config_owned()
        .or_else(|| read_last_config(app).ok().flatten());

    let Some(config_path) = active else {
        return json!({
            "reloaded": false,
            "skipped": true,
            "reason": "no-active-config"
        });
    };

    match reload_mihomo_config(app, state, &config_path).await {
        Ok(result) => {
            let reloaded = result
                .get("success")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            json!({
                "reloaded": reloaded,
                "configPath": config_path,
                "result": result
            })
        }
        Err(error) => json!({
            "reloaded": false,
            "configPath": config_path,
            "error": error
        }),
    }
}

async fn restart_active_config_after_core_switch(
    app: &AppHandle,
    window: &WebviewWindow,
    state: &State<'_, AppState>,
    core_type: &str,
    version: Option<&str>,
) -> Value {
    if !is_mihomo_running(app) {
        return json!({
            "restarted": false,
            "skipped": true,
            "reason": "mihomo-not-running"
        });
    }

    let active = state
        .runtime
        .lock()
        .expect("runtime mutex poisoned")
        .core
        .active_config_owned()
        .or_else(|| read_last_config(app).ok().flatten());

    let Some(config_path) = active else {
        return json!({
            "restarted": false,
            "skipped": true,
            "reason": "no-active-config"
        });
    };

    emit_core_progress(window, core_type, version, "restarting", 100.0, 0, 0);
    match start_mihomo(app, state, &config_path).await {
        Ok(result) => {
            let restarted = result
                .get("success")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let event_payload = if restarted {
                emit_core_progress(window, core_type, version, "done", 100.0, 0, 0);
                json!({ "success": true })
            } else {
                let error = result
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("Failed to restart service");
                emit_core_error(window, core_type, version, error);
                json!({
                    "success": false,
                    "error": error
                })
            };
            let _ = window.emit("service-restarted", event_payload);
            json!({
                "restarted": restarted,
                "configPath": config_path,
                "result": result
            })
        }
        Err(error) => {
            emit_core_error(window, core_type, version, &error);
            let _ = window.emit(
                "service-restarted",
                json!({
                    "success": false,
                    "error": error
                }),
            );
            json!({
                "restarted": false,
                "configPath": config_path,
                "error": error
            })
        }
    }
}

fn attach_runtime_reload(mut result: Value, runtime_reload: Value) -> Value {
    if let Some(object) = result.as_object_mut() {
        object.insert("runtimeReload".to_string(), runtime_reload);
        result
    } else {
        success(json!({ "runtimeReload": runtime_reload }))
    }
}

fn is_mihomo_running(app: &AppHandle) -> bool {
    sync_core_running_state(app)
}

async fn apply_saved_config(
    app: &AppHandle,
    window: &WebviewWindow,
    state: &State<'_, AppState>,
    section: &str,
) -> CompatResult {
    let active = state
        .runtime
        .lock()
        .expect("runtime mutex poisoned")
        .core
        .active_config_owned()
        .or(read_last_config(app)?);
    let Some(config_path) = active else {
        return Ok(success(json!({
            "restarted": false,
            "message": format!("{section} config saved, but no active config is selected")
        })));
    };

    if !is_mihomo_running(app) {
        return Ok(success(json!({
            "restarted": false,
            "message": format!("{section} config saved, start Mihomo to apply it")
        })));
    }

    match start_mihomo(app, state, &config_path).await {
        Ok(result) => {
            let restarted = result
                .get("success")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let event_payload = if restarted {
                json!({ "success": true })
            } else {
                json!({
                    "success": false,
                    "error": result
                        .get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("Failed to restart service")
                })
            };
            let _ = window.emit("service-restarted", event_payload);
            Ok(success(json!({
                "restarted": restarted,
                "message": if restarted {
                    format!("{section} config saved and applied")
                } else {
                    format!("{section} config saved, but restart failed")
                }
            })))
        }
        Err(error) => Ok(success(json!({
            "restarted": false,
            "message": format!("{section} config saved, but restart failed: {error}")
        }))),
    }
}

async fn apply_tun_runtime_change(
    app: &AppHandle,
    window: &WebviewWindow,
    state: &State<'_, AppState>,
    enabled: bool,
    previous_enabled: bool,
    rollback_on_failure: bool,
) -> CompatResult {
    let active = state
        .runtime
        .lock()
        .expect("runtime mutex poisoned")
        .core
        .active_config_owned()
        .or(read_last_config(app)?);

    if active.is_none() || !is_mihomo_running(app) {
        let _ = window.emit("tun-status", enabled);
        return Ok(success(json!({
            "enabled": enabled,
            "pending": true,
            "restarted": false,
            "message": if enabled {
                "TUN 配置已保存，将在下次启动 Mihomo 时生效"
            } else {
                "TUN 已关闭，将在下次启动 Mihomo 时生效"
            }
        })));
    }

    let config_path = active.unwrap_or_default();
    let result = start_mihomo(app, state, &config_path).await;
    match result {
        Ok(value)
            if value
                .get("success")
                .and_then(Value::as_bool)
                .unwrap_or(false) =>
        {
            let _ = window.emit("service-restarted", json!({ "success": true }));
            let _ = window.emit("tun-status", enabled);
            Ok(success(json!({
                "enabled": enabled,
                "pending": false,
                "restarted": true,
                "message": if enabled {
                    "TUN 模式已启用，Mihomo 已重启"
                } else {
                    "TUN 模式已关闭，Mihomo 已重启"
                }
            })))
        }
        Ok(value) => {
            let error = value
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("内核重启失败，请检查配置")
                .to_string();
            if rollback_on_failure {
                set_setting(app, "tunModeEnabled", json!(previous_enabled))?;
                let _ = window.emit("tun-status", previous_enabled);
            }
            let _ = window.emit(
                "service-restarted",
                json!({ "success": false, "error": error }),
            );
            Ok(json!({
                "success": false,
                "enabled": if rollback_on_failure { previous_enabled } else { enabled },
                "pending": false,
                "restarted": false,
                "error": error
            }))
        }
        Err(error) => {
            if rollback_on_failure {
                set_setting(app, "tunModeEnabled", json!(previous_enabled))?;
                let _ = window.emit("tun-status", previous_enabled);
            }
            let _ = window.emit(
                "service-restarted",
                json!({ "success": false, "error": error }),
            );
            Ok(json!({
                "success": false,
                "enabled": if rollback_on_failure { previous_enabled } else { enabled },
                "pending": false,
                "restarted": false,
                "error": error
            }))
        }
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

fn config_group_supported_for_proxy_nodes(group_type: &str) -> bool {
    matches!(
        group_type.to_ascii_lowercase().as_str(),
        "select"
            | "selector"
            | "url-test"
            | "urltest"
            | "fallback"
            | "load-balance"
            | "loadbalance"
            | "relay"
            | "smart"
    )
}

fn yaml_string_array(value: Option<&serde_yaml::Value>) -> Vec<String> {
    value
        .and_then(serde_yaml::Value::as_sequence)
        .map(|items| {
            items
                .iter()
                .filter_map(serde_yaml::Value::as_str)
                .map(ToString::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn parse_proxy_nodes_config(app: &AppHandle, config_path: &str) -> Value {
    let Ok(content) = config_content(app, config_path) else {
        return Value::Null;
    };
    let Ok(config) = serde_yaml::from_str::<serde_yaml::Value>(&content) else {
        return Value::Null;
    };
    if config.is_null() {
        return Value::Null;
    }

    let proxy_groups = config
        .get("proxy-groups")
        .and_then(serde_yaml::Value::as_sequence)
        .map(|groups| {
            groups
                .iter()
                .filter_map(|group| {
                    let name = group.get("name").and_then(serde_yaml::Value::as_str)?;
                    let group_type = group.get("type").and_then(serde_yaml::Value::as_str)?;
                    if !config_group_supported_for_proxy_nodes(group_type) {
                        return None;
                    }

                    let mut item = Map::new();
                    item.insert("name".to_string(), Value::String(name.to_string()));
                    item.insert("type".to_string(), Value::String(group_type.to_string()));
                    item.insert(
                        "proxies".to_string(),
                        Value::Array(
                            yaml_string_array(group.get("proxies"))
                                .into_iter()
                                .map(Value::String)
                                .collect(),
                        ),
                    );
                    item.insert(
                        "hidden".to_string(),
                        Value::Bool(
                            group
                                .get("hidden")
                                .and_then(serde_yaml::Value::as_bool)
                                .unwrap_or(false),
                        ),
                    );
                    item.insert(
                        "icon".to_string(),
                        group
                            .get("icon")
                            .and_then(serde_yaml::Value::as_str)
                            .map(|icon| Value::String(icon.to_string()))
                            .unwrap_or(Value::Null),
                    );
                    Some(Value::Object(item))
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let proxies = config
        .get("proxies")
        .and_then(serde_yaml::Value::as_sequence)
        .map(|items| {
            items
                .iter()
                .filter_map(|proxy| {
                    let name = proxy.get("name").and_then(serde_yaml::Value::as_str)?;
                    let mut item = Map::new();
                    item.insert("name".to_string(), Value::String(name.to_string()));
                    item.insert(
                        "type".to_string(),
                        proxy
                            .get("type")
                            .and_then(serde_yaml::Value::as_str)
                            .map(|value| Value::String(value.to_string()))
                            .unwrap_or(Value::Null),
                    );
                    item.insert(
                        "server".to_string(),
                        proxy
                            .get("server")
                            .and_then(serde_yaml::Value::as_str)
                            .map(|value| Value::String(value.to_string()))
                            .unwrap_or_else(|| Value::String(String::new())),
                    );
                    item.insert(
                        "port".to_string(),
                        proxy
                            .get("port")
                            .cloned()
                            .and_then(|value| serde_json::to_value(value).ok())
                            .unwrap_or_else(|| json!(0)),
                    );
                    Some(Value::Object(item))
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let controller_endpoint = active_runtime_controller_endpoint(app);
    let http_fallback = configured_http_controller(app);

    json!({
        "proxyGroups": proxy_groups,
        "proxies": proxies,
        "apiConfig": {
            "controllerMode": "socket",
            "socketPath": controller_endpoint.path,
            "socketArg": controller_endpoint.arg_name,
            "httpFallback": http_fallback,
            "external-controller": if http_fallback { Value::String(format!("{}:{}", controller_host(app), controller_port(app))) } else { Value::Null },
            "secret": controller_secret(app),
            "controllerHost": if http_fallback { Value::String(controller_host(app)) } else { Value::Null },
            "controllerPort": if http_fallback { Value::String(controller_port(app).to_string()) } else { Value::Null }
        }
    })
}

fn proxy_is_group(value: &Value) -> bool {
    value
        .get("type")
        .and_then(Value::as_str)
        .map(|value| {
            matches!(
                value.to_ascii_lowercase().as_str(),
                "selector"
                    | "urltest"
                    | "url-test"
                    | "fallback"
                    | "loadbalance"
                    | "load-balance"
                    | "relay"
                    | "smart"
            )
        })
        .unwrap_or(false)
}

fn resolve_proxy_now(proxies: &Map<String, Value>, name: &str, depth: usize) -> Option<String> {
    if depth > 8 {
        return Some(name.to_string());
    }

    let proxy = proxies.get(name)?;
    let now = proxy.get("now").and_then(Value::as_str)?;

    if let Some(next) = proxies.get(now) {
        if proxy_is_group(next) {
            return resolve_proxy_now(proxies, now, depth + 1).or_else(|| Some(now.to_string()));
        }
    }

    Some(now.to_string())
}

fn current_node_from_proxies_response(response: &Value) -> Option<String> {
    let data = response.get("data").unwrap_or(response);
    let proxies = data.get("proxies").and_then(Value::as_object)?;

    for group in ["PROXY", "GLOBAL"] {
        if let Some(node) = resolve_proxy_now(proxies, group, 0) {
            return Some(node);
        }
    }

    for (name, proxy) in proxies {
        if proxy_is_group(proxy) {
            if let Some(node) = resolve_proxy_now(proxies, name, 0) {
                return Some(node);
            }
        }
    }

    None
}

fn proxy_group_for_compat(name: &str, group: &Value, proxies: &Map<String, Value>) -> Value {
    let nodes = group
        .get("all")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .filter_map(|node_name| {
                    let node = proxies.get(node_name)?;
                    Some(json!({
                        "name": node_name,
                        "type": node.get("type").cloned().unwrap_or_else(|| json!("")),
                        "server": node.get("server").cloned().unwrap_or_else(|| json!("")),
                        "port": node.get("port").cloned().unwrap_or_else(|| json!(0)),
                        "delay": node.get("delay").cloned().unwrap_or(Value::Null),
                    }))
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    json!({
        "name": name,
        "type": group.get("type").cloned().unwrap_or_else(|| json!("")),
        "now": group.get("now").cloned().unwrap_or(Value::Null),
        "nodes": nodes
    })
}

fn proxies_payload_for_compat(response: Value) -> Value {
    let mut data = response
        .get("data")
        .cloned()
        .unwrap_or_else(|| response.clone());
    let Some(proxies) = data.get("proxies").and_then(Value::as_object).cloned() else {
        return data;
    };

    let mut seen = HashSet::<String>::new();
    let mut groups = Vec::<Value>::new();

    for preferred in ["PROXY", "GLOBAL"] {
        if let Some(group) = proxies.get(preferred).filter(|group| proxy_is_group(group)) {
            seen.insert(preferred.to_string());
            groups.push(proxy_group_for_compat(preferred, group, &proxies));
        }
    }

    for (name, group) in &proxies {
        if seen.contains(name) || !proxy_is_group(group) {
            continue;
        }
        seen.insert(name.clone());
        groups.push(proxy_group_for_compat(name, group, &proxies));
    }

    let selected = current_node_from_proxies_response(&data);

    if let Some(object) = data.as_object_mut() {
        object.insert("groups".to_string(), Value::Array(groups));
        object.insert(
            "selected".to_string(),
            selected.map(Value::String).unwrap_or(Value::Null),
        );
    }

    data
}

async fn fetch_connections_info(app: &AppHandle, state: &State<'_, AppState>) -> Value {
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
    let cached_current_node = {
        state
            .runtime
            .lock()
            .expect("runtime mutex poisoned")
            .current_node
            .clone()
    };
    let current_node = match cached_current_node {
        Some(node) => Some(node),
        None => {
            let resolved = request_http(app, Some("/proxies".to_string()), None)
                .await
                .ok()
                .and_then(|value| current_node_from_proxies_response(&value));
            if let Some(node) = &resolved {
                state
                    .runtime
                    .lock()
                    .expect("runtime mutex poisoned")
                    .current_node = Some(node.clone());
            }
            resolved
        }
    };
    json!({
        "activeConnections": connections.len(),
        "connections": connections,
        "currentNode": current_node,
        "downloadTotal": data.get("downloadTotal").and_then(Value::as_u64).unwrap_or(0),
        "uploadTotal": data.get("uploadTotal").and_then(Value::as_u64).unwrap_or(0)
    })
}

async fn get_traffic_stats(app: &AppHandle, state: &State<'_, AppState>) -> Value {
    let snapshot = fetch_connections_info(app, state).await;
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
    let mut command = Command::new("powershell.exe");
    command.args(["-NoProfile", "-Command", "Get-Date -Format yyyy-MM-dd"]);
    #[cfg(target_os = "windows")]
    command.creation_flags(0x08000000);
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

fn icon_cache_dir(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    let dir = app_data_dir(app)?.join(name);
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    Ok(dir)
}

fn icon_mime_from_extension(ext: &str) -> &'static str {
    match ext.to_ascii_lowercase().as_str() {
        ".jpg" | ".jpeg" => "image/jpeg",
        ".gif" => "image/gif",
        ".webp" => "image/webp",
        ".svg" => "image/svg+xml",
        ".ico" => "image/x-icon",
        ".bmp" => "image/bmp",
        _ => "image/png",
    }
}

fn icon_extension_from_mime(mime: &str) -> &'static str {
    let mime = mime
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    match mime.as_str() {
        "image/jpeg" => ".jpg",
        "image/gif" => ".gif",
        "image/webp" => ".webp",
        "image/svg+xml" => ".svg",
        "image/x-icon" | "image/vnd.microsoft.icon" => ".ico",
        "image/bmp" => ".bmp",
        _ => ".png",
    }
}

fn icon_extension_from_url(url: &str) -> String {
    reqwest::Url::parse(url)
        .ok()
        .and_then(|url| {
            Path::new(url.path())
                .extension()
                .and_then(|value| value.to_str())
                .map(|ext| format!(".{}", ext.to_ascii_lowercase()))
        })
        .filter(|ext| {
            matches!(
                ext.as_str(),
                ".png" | ".jpg" | ".jpeg" | ".gif" | ".webp" | ".svg" | ".ico" | ".bmp"
            )
        })
        .unwrap_or_else(|| ".png".to_string())
}

fn icon_data_url_from_file(path: &Path, ext: &str) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|err| err.to_string())?;
    Ok(format!(
        "data:{};base64,{}",
        icon_mime_from_extension(ext),
        general_purpose::STANDARD.encode(bytes)
    ))
}

fn icon_cache_stem(prefix: &str, icon_url: &str, cache_seed: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(icon_url.as_bytes());
    hasher.update([0]);
    hasher.update(cache_seed.as_bytes());
    let hash = hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("{prefix}_{}", &hash[..24])
}

fn icon_cache_key(prefix: &str, icon_url: &str, cache_seed: &str, ext: &str) -> String {
    format!("{}{}", icon_cache_stem(prefix, icon_url, cache_seed), ext)
}

fn cached_icon_file(
    cache_dir: &Path,
    prefix: &str,
    icon_url: &str,
    cache_seed: &str,
) -> Option<(PathBuf, String)> {
    let stem = icon_cache_stem(prefix, icon_url, cache_seed);
    [
        ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico", ".bmp",
    ]
    .into_iter()
    .find_map(|ext| {
        let path = cache_dir.join(format!("{stem}{ext}"));
        path.exists().then(|| (path, ext.to_string()))
    })
}

fn is_icon_image_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    [
        ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico", ".bmp",
    ]
    .iter()
    .any(|ext| lower.contains(ext))
}

fn favicon_url(icon_url: &str) -> String {
    reqwest::Url::parse(icon_url)
        .map(|url| {
            let host = url.host_str().unwrap_or_default();
            let host = url
                .port()
                .map(|port| format!("{host}:{port}"))
                .unwrap_or_else(|| host.to_string());
            format!("{}://{host}/favicon.ico", url.scheme())
        })
        .unwrap_or_else(|_| icon_url.to_string())
}

async fn cached_icon_data_url(
    app: &AppHandle,
    cache_dir_name: &str,
    cache_prefix: &str,
    icon_url: &str,
    cache_seed: &str,
    use_favicon_for_sites: bool,
) -> Result<Option<String>, String> {
    let icon_url = icon_url.trim().to_string();
    if icon_url.is_empty() {
        return Ok(None);
    }
    if icon_url.starts_with("data:") {
        return Ok(Some(icon_url));
    }

    let direct_path = PathBuf::from(&icon_url);
    if direct_path.exists() && direct_path.is_file() {
        let ext = direct_path
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| format!(".{}", value.to_ascii_lowercase()))
            .unwrap_or_else(|| ".png".to_string());
        return icon_data_url_from_file(&direct_path, &ext).map(Some);
    }

    let target_url = if !use_favicon_for_sites || is_icon_image_url(&icon_url) {
        icon_url.clone()
    } else {
        favicon_url(&icon_url)
    };
    let initial_ext = icon_extension_from_url(&target_url);
    let cache_dir = icon_cache_dir(app, cache_dir_name)?;
    if let Some((path, ext)) = cached_icon_file(&cache_dir, cache_prefix, &icon_url, cache_seed) {
        return icon_data_url_from_file(&path, &ext).map(Some);
    }
    let cache_name = icon_cache_key(cache_prefix, &icon_url, cache_seed, &initial_ext);
    let cache_path = cache_dir.join(&cache_name);
    if cache_path.exists() {
        return icon_data_url_from_file(&cache_path, &initial_ext).map(Some);
    }

    let response = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|err| err.to_string())?
        .get(&target_url)
        .header(
            "User-Agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        )
        .send()
        .await
        .map_err(|err| err.to_string())?;
    if !response.status().is_success() {
        return Err(format!("下载图标失败: HTTP {}", response.status()));
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    let ext = if content_type.starts_with("image/") {
        icon_extension_from_mime(content_type).to_string()
    } else {
        initial_ext
    };
    let bytes = response.bytes().await.map_err(|err| err.to_string())?;
    if bytes.is_empty() {
        return Err("图标内容为空".to_string());
    }
    if bytes.len() > 5 * 1024 * 1024 {
        return Err("图标文件过大".to_string());
    }

    let final_cache_name = icon_cache_key(cache_prefix, &icon_url, cache_seed, &ext);
    let final_cache_path = cache_dir.join(final_cache_name);
    fs::write(&final_cache_path, &bytes).map_err(|err| err.to_string())?;
    Ok(Some(format!(
        "data:{};base64,{}",
        icon_mime_from_extension(&ext),
        general_purpose::STANDARD.encode(bytes)
    )))
}

async fn config_icon_get(app: &AppHandle, icon_url: String, config_path: String) -> CompatResult {
    match cached_icon_data_url(app, "config-icons", "config", &icon_url, &config_path, true).await {
        Ok(Some(icon_path)) => Ok(success(json!({ "iconPath": icon_path }))),
        Ok(None) => Ok(success(json!({ "iconPath": Value::Null }))),
        Err(error) => Ok(json!({ "success": false, "error": error })),
    }
}

fn clear_icon_cache(app: &AppHandle, name: &str) -> CompatResult {
    let dir = icon_cache_dir(app, name)?;
    for entry in fs::read_dir(&dir).map_err(|err| err.to_string())? {
        let path = entry.map_err(|err| err.to_string())?.path();
        if path.is_file() {
            fs::remove_file(path).map_err(|err| err.to_string())?;
        }
    }
    Ok(success(json!({})))
}

fn icon_cache_size(app: &AppHandle, name: &str) -> CompatResult {
    let dir = icon_cache_dir(app, name)?;
    let mut size = 0u64;
    for entry in fs::read_dir(&dir).map_err(|err| err.to_string())? {
        let path = entry.map_err(|err| err.to_string())?.path();
        if path.is_file() {
            size = size.saturating_add(fs::metadata(path).map_err(|err| err.to_string())?.len());
        }
    }
    Ok(success(json!({ "size": size })))
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
            let index = rules
                .iter()
                .position(|rule| rule.get("id").and_then(Value::as_str) == Some(id.as_str()))
                .ok_or_else(|| "规则不存在".to_string())?;
            rules.remove(index);
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

async fn proxy_group_icon(
    app: &AppHandle,
    group_name: &str,
    config_icon: Option<String>,
) -> CompatResult {
    if let Some(icon) = config_icon.filter(|value| !value.is_empty()) {
        let icon_path = cached_icon_data_url(app, "icon-cache", "config", &icon, group_name, false)
            .await
            .ok()
            .flatten();
        return Ok(success(json!({ "iconPath": icon_path })));
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
            let icon_path = if icon_type == "BASE64" {
                if icon_data.starts_with("data:") {
                    Some(icon_data.to_string())
                } else {
                    Some(format!("data:image/png;base64,{icon_data}"))
                }
            } else {
                let rule_id = rule.get("id").and_then(Value::as_str).unwrap_or(group_name);
                cached_icon_data_url(app, "icon-cache", "rule", icon_data, rule_id, false)
                    .await
                    .ok()
                    .flatten()
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

async fn fetch_override_remote_content(url: &str) -> Result<String, String> {
    let url = url.trim();
    if url.is_empty() {
        return Err("远程覆写缺少 URL".to_string());
    }
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("远程覆写 URL 必须以 http:// 或 https:// 开头".to_string());
    }

    let response = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .danger_accept_invalid_certs(true)
        .build()
        .map_err(|err| err.to_string())?
        .get(url)
        .send()
        .await
        .map_err(|err| err.to_string())?;
    let status = response.status();
    let text = response.text().await.map_err(|err| err.to_string())?;
    if !status.is_success() {
        return Err(format!(
            "获取远程覆写失败: HTTP {} {}",
            status.as_u16(),
            text.trim()
        ));
    }
    if text.trim().is_empty() {
        return Err("远程覆写内容为空".to_string());
    }
    Ok(text)
}

async fn override_add(app: &AppHandle, item: Value) -> CompatResult {
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
    let mut content = object
        .get("file")
        .and_then(Value::as_str)
        .map(ToString::to_string);
    if object.get("type").and_then(Value::as_str) == Some("remote") && content.is_none() {
        let url = object
            .get("url")
            .and_then(Value::as_str)
            .ok_or_else(|| "远程覆写缺少 URL".to_string())?;
        content = Some(fetch_override_remote_content(url).await?);
    }
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
    let content = fetch_override_remote_content(url).await?;
    save_override_item(app, &item, Some(&content))?;
    Ok(item)
}

fn backup_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app_data_dir(app)?.join("backups");
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    Ok(dir)
}

fn backup_file_name() -> String {
    format!("flyclash_backup_{}.zip", now_millis())
}

fn ensure_zip_extension(path: PathBuf) -> PathBuf {
    if path.extension().and_then(|value| value.to_str()) == Some("zip") {
        path
    } else {
        path.with_extension("zip")
    }
}

fn backup_profile_uuid(source: &str) -> String {
    let digest = Sha256::digest(source.as_bytes());
    let hex = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

fn backup_ui_settings(app: &AppHandle) -> Result<Value, String> {
    let theme = setting(app, "theme", json!("system"))?;
    let dark_mode = match theme.as_str().unwrap_or("system") {
        "dark" => "Dark",
        "light" => "Light",
        _ => "Auto",
    };
    Ok(json!({
        "enableVpn": true,
        "darkMode": dark_mode,
        "hideAppIcon": false,
        "proxyExcludeNotSelectable": false,
        "proxyLine": 2,
        "proxySort": "Default",
        "appLockEnabled": false,
        "appLockPassword": "",
        "appLockBiometricEnabled": false,
        "appLockTimeout": 300000,
        "userAgent": format!("FlyClash/Desktop/{}", app.package_info().version)
    }))
}

fn backup_dashboard_config(app: &AppHandle) -> Result<Value, String> {
    setting(
        app,
        "dashboard_config",
        json!({ "cardOrder": [], "enabledCards": [], "cardSettings": {} }),
    )
}

fn backup_override_settings(app: &AppHandle) -> Result<Value, String> {
    Ok(json!({
        "jsOverrideEnabled": setting(app, "js_override_enabled", json!(false))?,
        "jsOverrideContent": setting(app, "js_override_content", json!(""))?,
        "yamlOverrideEnabled": setting(app, "yaml_override_enabled", json!(false))?,
        "yamlOverrideContent": setting(app, "yaml_override_content", json!(""))?
    }))
}

fn create_backup_zip_at(app: &AppHandle, backup_type: &str, path: &Path) -> CompatResult {
    let file = fs::File::create(&path).map_err(|err| err.to_string())?;
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    let subscriptions = read_subscriptions(app)?;
    let active_config = read_last_config(app)?;
    let mut active_profile = Value::Null;
    let mut imported_profiles = Vec::new();
    let timestamp = now_millis();

    for sub in subscriptions {
        let content = match config_content(app, &sub.path) {
            Ok(content) => content,
            Err(_) => continue,
        };
        let uuid = backup_profile_uuid(&sub.path);
        if active_config.as_deref() == Some(sub.path.as_str()) {
            active_profile = json!(uuid.clone());
        }

        let upload = sub
            .used_traffic
            .as_deref()
            .and_then(parse_traffic_string)
            .unwrap_or(0);
        let remaining = sub
            .remaining_traffic
            .as_deref()
            .and_then(parse_traffic_string)
            .unwrap_or(0);
        let total = upload.saturating_add(remaining);
        let expire = sub
            .expiry_date
            .as_deref()
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0);
        let source = sub.url.clone().unwrap_or_else(|| sub.path.clone());
        let profile_type = if sub
            .url
            .as_deref()
            .is_some_and(|url| url.starts_with("http://") || url.starts_with("https://"))
        {
            "Url"
        } else {
            "File"
        };

        zip.start_file(format!("profiles/{uuid}.yaml"), options)
            .map_err(|err| err.to_string())?;
        zip.write_all(content.as_bytes())
            .map_err(|err| err.to_string())?;

        imported_profiles.push(json!({
            "uuid": uuid,
            "name": sub.name,
            "type": profile_type,
            "source": source,
            "interval": sub.update_interval.saturating_mul(60_000),
            "upload": upload,
            "download": 0,
            "total": total,
            "expire": expire,
            "iconUrl": sub.icon_url.unwrap_or_default(),
            "createdAt": timestamp,
            "configContent": content,
            "providersContent": {}
        }));
    }

    let metadata = json!({
        "version": "2.1",
        "timestamp": timestamp,
        "backupType": backup_type,
        "activeProfile": active_profile,
        "importedProfiles": imported_profiles,
        "pendingProfiles": [],
        "selections": [],
        "proxyIconConfig": proxy_icon_config(app).unwrap_or_else(|_| proxy_icon_default_config()),
        "serviceSettings": Value::Null,
        "uiSettings": if backup_type == "FULL_BACKUP" { backup_ui_settings(app)? } else { Value::Null },
        "webDAVSettings": if backup_type == "FULL_BACKUP" { webdav_config(app)? } else { Value::Null },
        "appLockSettings": Value::Null,
        "dashboardConfig": if backup_type == "FULL_BACKUP" { backup_dashboard_config(app)? } else { Value::Null },
        "trafficData": Value::Null,
        "overrideSettings": if backup_type == "FULL_BACKUP" { backup_override_settings(app)? } else { Value::Null }
    });

    zip.start_file("enhanced_backup_metadata.json", options)
        .map_err(|err| err.to_string())?;
    zip.write_all(
        serde_json::to_string_pretty(&metadata)
            .map_err(|err| err.to_string())?
            .as_bytes(),
    )
    .map_err(|err| err.to_string())?;

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

fn create_backup_zip(app: &AppHandle, backup_type: &str) -> CompatResult {
    let path = backup_dir(app)?.join(backup_file_name());
    create_backup_zip_at(app, backup_type, &path)
}

fn zip_entry_string(
    archive: &mut zip::ZipArchive<fs::File>,
    candidates: &[&str],
) -> Result<Option<String>, String> {
    for name in candidates {
        if let Ok(mut entry) = archive.by_name(name) {
            let mut content = String::new();
            entry
                .read_to_string(&mut content)
                .map_err(|err| err.to_string())?;
            return Ok(Some(content));
        }
    }
    Ok(None)
}

fn restore_backup_settings(app: &AppHandle, backup_data: &Value) -> Result<(), String> {
    if let Some(config) = backup_data
        .get("proxyIconConfig")
        .filter(|value| !value.is_null())
    {
        set_setting(app, "proxyIconConfig", config.clone())?;
    }

    let full_backup = backup_data
        .get("backupType")
        .and_then(Value::as_str)
        .map(|value| value == "FULL_BACKUP")
        .unwrap_or(false);
    if !full_backup {
        return Ok(());
    }

    if let Some(settings) = backup_data
        .get("uiSettings")
        .filter(|value| !value.is_null())
    {
        let theme = match settings.get("darkMode").and_then(Value::as_str) {
            Some("Dark") => "dark",
            Some("Light") => "light",
            _ => "system",
        };
        set_setting(app, "theme", json!(theme))?;
    }

    if let Some(settings) = backup_data
        .get("webDAVSettings")
        .filter(|value| !value.is_null())
    {
        set_setting(
            app,
            "webdav_uri",
            settings.get("uri").cloned().unwrap_or(json!("")),
        )?;
        set_setting(
            app,
            "webdav_username",
            settings.get("username").cloned().unwrap_or(json!("")),
        )?;
        set_setting(
            app,
            "webdav_password",
            settings.get("password").cloned().unwrap_or(json!("")),
        )?;
        set_setting(
            app,
            "webdav_backup_dir",
            settings
                .get("backupDirectory")
                .cloned()
                .unwrap_or(json!("FlyClash")),
        )?;
        set_setting(
            app,
            "webdav_backup_filename",
            settings
                .get("fileName")
                .cloned()
                .unwrap_or(json!("flyclash_backup.zip")),
        )?;
    }

    if let Some(config) = backup_data
        .get("dashboardConfig")
        .filter(|value| !value.is_null())
    {
        set_setting(app, "dashboard_config", config.clone())?;
    }

    if let Some(settings) = backup_data
        .get("overrideSettings")
        .filter(|value| !value.is_null())
    {
        set_setting(
            app,
            "js_override_enabled",
            settings
                .get("jsOverrideEnabled")
                .cloned()
                .unwrap_or(json!(false)),
        )?;
        set_setting(
            app,
            "js_override_content",
            settings
                .get("jsOverrideContent")
                .cloned()
                .unwrap_or(json!("")),
        )?;
        set_setting(
            app,
            "yaml_override_enabled",
            settings
                .get("yamlOverrideEnabled")
                .cloned()
                .unwrap_or(json!(false)),
        )?;
        set_setting(
            app,
            "yaml_override_content",
            settings
                .get("yamlOverrideContent")
                .cloned()
                .unwrap_or(json!("")),
        )?;
    }

    Ok(())
}

fn restore_enhanced_backup_zip(
    app: &AppHandle,
    archive: &mut zip::ZipArchive<fs::File>,
    backup_data: Value,
) -> CompatResult {
    restore_backup_settings(app, &backup_data)?;

    let active_profile = backup_data
        .get("activeProfile")
        .and_then(Value::as_str)
        .map(ToString::to_string);
    let profiles = backup_data
        .get("importedProfiles")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut restored = 0;
    let mut failed = 0;
    let mut errors = Vec::new();

    for profile in profiles {
        let uuid = profile
            .get("uuid")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let name = profile
            .get("name")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("Imported")
            .to_string();

        let content = profile
            .get("configContent")
            .and_then(Value::as_str)
            .map(ToString::to_string)
            .or_else(|| {
                if uuid.is_empty() {
                    return None;
                }
                zip_entry_string(archive, &[&format!("profiles/{uuid}.yaml")])
                    .ok()
                    .flatten()
            });

        let Some(content) = content.filter(|value| !value.trim().is_empty()) else {
            failed += 1;
            errors.push(json!({ "name": name, "message": "configContent 为空，配置文件无法落地" }));
            continue;
        };

        let source = profile
            .get("source")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let profile_type = profile
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_ascii_lowercase();
        let url = if profile_type == "url"
            || source.starts_with("http://")
            || source.starts_with("https://")
        {
            Some(source)
        } else {
            None
        };

        match save_subscription(app, url, content, Some(name.clone()), None) {
            Ok(result) => {
                let file_path = result
                    .get("filePath")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                if !file_path.is_empty() {
                    let interval = profile
                        .get("interval")
                        .and_then(Value::as_u64)
                        .map(|value| value / 60_000)
                        .unwrap_or(0);
                    let icon_url = profile
                        .get("iconUrl")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    let conn = db(app)?;
                    conn.execute(
                        "UPDATE subscriptions SET icon_url = ?1, update_interval = ?2 WHERE file_path = ?3",
                        params![icon_url, interval as i64, file_path],
                    )
                    .map_err(|err| err.to_string())?;

                    let sub_id = conn
                        .query_row(
                            "SELECT id FROM subscriptions WHERE file_path = ?1",
                            params![file_path],
                            |row| row.get::<_, i64>(0),
                        )
                        .map_err(|err| err.to_string())?;
                    conn.execute(
                        "DELETE FROM subscription_info WHERE subscription_id = ?1",
                        params![sub_id],
                    )
                    .map_err(|err| err.to_string())?;

                    let upload = profile.get("upload").and_then(Value::as_u64).unwrap_or(0);
                    let download = profile.get("download").and_then(Value::as_u64).unwrap_or(0);
                    let used = upload.saturating_add(download);
                    let total = profile.get("total").and_then(Value::as_u64).unwrap_or(0);
                    let expire = profile.get("expire").and_then(Value::as_u64).unwrap_or(0);
                    if used > 0 || total > 0 || expire > 0 {
                        conn.execute(
                            "INSERT INTO subscription_info (subscription_id, used_traffic, total_traffic, expiry_timestamp) VALUES (?1, ?2, ?3, ?4)",
                            params![
                                sub_id,
                                (used > 0).then_some(used as i64),
                                (total > 0).then_some(total as i64),
                                (expire > 0).then_some(expire as i64)
                            ],
                        )
                        .map_err(|err| err.to_string())?;
                    }

                    if active_profile.as_deref() == Some(uuid.as_str()) {
                        save_last_config(app, &file_path)?;
                    }
                }
                restored += 1;
            }
            Err(error) => {
                failed += 1;
                errors.push(json!({ "name": name, "message": error }));
            }
        }
    }

    if !errors.is_empty() && restored == 0 {
        let first_error = errors
            .first()
            .and_then(|value| value.get("message"))
            .and_then(Value::as_str)
            .unwrap_or("未知错误");
        return Ok(json!({
            "success": false,
            "error": format!("所有 {} 个配置都未能还原（首条错误：{}）", failed, first_error),
            "stats": { "restored": restored, "failed": failed, "errors": errors }
        }));
    }

    Ok(success(json!({
        "stats": { "restored": restored, "failed": failed, "errors": errors }
    })))
}

fn restore_backup_zip(app: &AppHandle, path: &Path) -> CompatResult {
    let file = fs::File::open(path).map_err(|err| err.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|err| err.to_string())?;

    if let Some(metadata) = zip_entry_string(
        &mut archive,
        &[
            "enhanced_backup_metadata.json",
            "backup_metadata.json",
            "backup.json",
        ],
    )? {
        let mut backup_data =
            serde_json::from_str::<Value>(&metadata).map_err(|err| err.to_string())?;
        if backup_data.get("version").is_none() && backup_data.get("importedProfiles").is_some() {
            if let Some(object) = backup_data.as_object_mut() {
                object.insert("version".to_string(), json!("2.0"));
                object.insert("backupType".to_string(), json!("CONFIG_ONLY"));
            }
        }
        return restore_enhanced_backup_zip(app, &mut archive, backup_data);
    }

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

async fn finalize_backup_restore(
    app: &AppHandle,
    state: &State<'_, AppState>,
    mut result: Value,
) -> CompatResult {
    if !result
        .get("success")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Ok(result);
    }

    let active_config = sync_runtime_active_config_from_settings(app, state)?;
    refresh_tray_menu_after(app, "backupRestore");
    let runtime_reload = if active_config.is_some() {
        refresh_active_config_after_override(app, state).await
    } else {
        json!({
            "reloaded": false,
            "skipped": true,
            "reason": "no-active-config"
        })
    };

    if let Some(object) = result.as_object_mut() {
        object.insert(
            "activeConfig".to_string(),
            active_config.map(Value::String).unwrap_or(Value::Null),
        );
        object.insert("runtimeReload".to_string(), runtime_reload);
    }

    Ok(result)
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

fn webdav_config_text(config: &Value, key: &str, fallback: &str) -> String {
    config
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or(fallback)
        .trim()
        .to_string()
}

fn webdav_validate_config(config: &Value) -> Result<(), String> {
    let uri = webdav_config_text(config, "uri", "");
    let username = webdav_config_text(config, "username", "");
    let password = webdav_config_text(config, "password", "");
    if uri.is_empty() || username.is_empty() || password.is_empty() {
        Err("WebDAV配置不完整".to_string())
    } else {
        Ok(())
    }
}

fn webdav_base_url(config: &Value) -> Result<String, String> {
    let base = config
        .get("uri")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .trim_end_matches('/');
    if base.is_empty() {
        return Err("WebDAV配置不完整".to_string());
    }
    Ok(base.to_string())
}

fn webdav_root_url(config: &Value) -> Result<String, String> {
    webdav_base_url(config)
}

fn webdav_dir_segments(config: &Value) -> Vec<String> {
    let dir = config
        .get("backupDirectory")
        .and_then(Value::as_str)
        .unwrap_or("FlyClash")
        .trim_matches('/');
    let normalized = if dir.trim().is_empty() {
        "FlyClash"
    } else {
        dir
    };
    normalized
        .split('/')
        .filter_map(|part| {
            let part = part.trim();
            (!part.is_empty()).then(|| urlencoding::encode(part).into_owned())
        })
        .collect()
}

fn webdav_directory_url(config: &Value, segment_count: Option<usize>) -> Result<String, String> {
    let base = webdav_base_url(config)?;
    let segments = webdav_dir_segments(config);
    let take = segment_count.unwrap_or(segments.len()).min(segments.len());
    if take == 0 {
        Ok(base)
    } else {
        Ok(format!("{base}/{}", segments[..take].join("/")))
    }
}

fn webdav_url(config: &Value, file_name: Option<&str>) -> Result<String, String> {
    let mut url = webdav_directory_url(config, None)?;
    if let Some(file) = file_name {
        url.push('/');
        url.push_str(&urlencoding::encode(file));
    }
    Ok(url)
}

async fn webdav_request(
    config: &Value,
    method: &str,
    url: String,
    body: Option<Vec<u8>>,
    depth: Option<&str>,
) -> CompatResult {
    webdav_validate_config(config)?;
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
    if let Some(depth) = depth {
        request = request.header("Depth", depth);
    }
    if let Some(body) = body {
        request = request.body(body);
    }
    let response = request.send().await.map_err(|err| err.to_string())?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    Ok(json!({ "success": status.is_success(), "status": status.as_u16(), "text": text }))
}

fn webdav_error_message(result: &Value, fallback: &str) -> String {
    result
        .get("text")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(|| {
            result
                .get("status")
                .and_then(Value::as_u64)
                .filter(|status| *status > 0)
                .map(|status| format!("{fallback}: HTTP {status}"))
                .unwrap_or_else(|| fallback.to_string())
        })
}

async fn webdav_ensure_directory(config: &Value) -> Result<(), String> {
    let segments = webdav_dir_segments(config);
    for index in 1..=segments.len() {
        let url = webdav_directory_url(config, Some(index))?;
        let result = webdav_request(config, "MKCOL", url, None, None).await?;
        let success = result
            .get("success")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let status = result.get("status").and_then(Value::as_u64).unwrap_or(0);
        if success || status == 405 {
            continue;
        }
        return Err(webdav_error_message(&result, "创建WebDAV目录失败"));
    }
    Ok(())
}

fn emit_backup_progress(
    window: &WebviewWindow,
    event_name: &str,
    transferred_key: &str,
    transferred: u64,
    total: u64,
) {
    let percentage = if total > 0 {
        ((transferred as f64 / total as f64) * 100.0)
            .round()
            .clamp(0.0, 100.0) as u64
    } else if transferred > 0 {
        100
    } else {
        0
    };
    let mut payload = Map::new();
    payload.insert(transferred_key.to_string(), json!(transferred));
    payload.insert("total".to_string(), json!(total));
    payload.insert("percentage".to_string(), json!(percentage));
    let _ = window.emit(event_name, Value::Object(payload));
}

fn run_powershell_script(script: &str) -> Result<String, String> {
    if !cfg!(target_os = "windows") {
        return Err("Loopback 仅支持 Windows".to_string());
    }

    let path = std::env::temp_dir().join(format!(
        "flyclash-loopback-{}-{}.ps1",
        std::process::id(),
        now_millis()
    ));
    let mut bytes = vec![0xEF, 0xBB, 0xBF];
    bytes.extend_from_slice(
        format!(
            "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n{}",
            script
        )
        .as_bytes(),
    );
    fs::write(&path, bytes).map_err(|err| err.to_string())?;

    let mut command = Command::new("powershell.exe");
    command
        .arg("-NoProfile")
        .arg("-NonInteractive")
        .arg("-ExecutionPolicy")
        .arg("Bypass")
        .arg("-File")
        .arg(&path);
    #[cfg(target_os = "windows")]
    command.creation_flags(0x08000000);

    let output = command.output().map_err(|err| err.to_string());
    let _ = fs::remove_file(&path);
    let output = output?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return Err(if stderr.is_empty() { stdout } else { stderr });
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn loopback_api_call(method_call: &str) -> Result<String, String> {
    let csharp = include_str!("../../electron/loopback-helper.cs");
    let script = format!(
        "$ErrorActionPreference = 'Stop'\nAdd-Type -TypeDefinition @'\n{}\n'@\n{}",
        csharp, method_call
    );
    run_powershell_script(&script)
}

fn loopback_display_names() -> HashMap<String, String> {
    let script = r#"
$ErrorActionPreference = 'SilentlyContinue'
$results = @{}
try {
  Get-StartApps | ForEach-Object {
    if ($_.AppID -and $_.Name -and $_.AppID -like '*!*') {
      $pfn = ($_.AppID -split '!')[0]
      if ($pfn) { $results[$pfn] = $_.Name }
    }
  }
} catch {}
try {
  Get-AppxPackage | ForEach-Object {
    $pkgName = $_.Name
    $pfn = $_.PackageFamilyName
    if ($pfn -and $results.ContainsKey($pfn)) {
      $results[$pkgName] = $results[$pfn]
    }
  }
} catch {}
$results | ConvertTo-Json -Compress -Depth 1
"#;

    let Ok(output) = run_powershell_script(script) else {
        return HashMap::new();
    };
    let Ok(value) = serde_json::from_str::<Value>(&output) else {
        return HashMap::new();
    };
    value
        .as_object()
        .map(|object| {
            object
                .iter()
                .filter_map(|(key, value)| {
                    value
                        .as_str()
                        .map(|display| (key.to_ascii_lowercase(), display.to_string()))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn loopback_resolve_display_name(app: &mut Value, names: &HashMap<String, String>) {
    let container_name = app
        .get("appContainerName")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    let package_family_name = app
        .get("packageFamilyName")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();

    let mut resolved = names
        .get(&package_family_name)
        .or_else(|| names.get(&container_name))
        .cloned();

    if resolved.is_none() {
        if let Some((prefix, _)) = package_family_name.rsplit_once('_') {
            resolved = names.get(prefix).cloned();
        }
    }

    if resolved.is_none() && !container_name.is_empty() {
        resolved = names.iter().find_map(|(key, value)| {
            (key.starts_with(&container_name) || container_name.starts_with(key))
                .then(|| value.clone())
        });
    }

    if let Some(resolved) = resolved {
        if let Some(object) = app.as_object_mut() {
            object.insert("displayName".to_string(), Value::String(resolved));
        }
    }
}

fn loopback_sid_valid(sid: &str) -> bool {
    sid.to_ascii_uppercase().starts_with("S-1-15-2-")
        && sid
            .chars()
            .all(|ch| ch.is_ascii_digit() || ch == 'S' || ch == 's' || ch == '-')
}

fn loopback_apps(app: &AppHandle) -> CompatResult {
    if !cfg!(target_os = "windows") {
        return Ok(success(json!({ "apps": [], "isAdmin": false })));
    }

    let output = match loopback_api_call("[NetworkIsolationHelper]::EnumAppContainers()") {
        Ok(output) => output,
        Err(error) => {
            return Ok(json!({ "success": false, "error": error, "apps": [], "isAdmin": true }))
        }
    };
    if output.is_empty() || output == "null" {
        return Ok(success(json!({ "apps": [], "isAdmin": true })));
    }

    let parsed = match serde_json::from_str::<Value>(&output) {
        Ok(parsed) => parsed,
        Err(error) => {
            return Ok(json!({
                "success": false,
                "error": format!("解析 Loopback 应用列表失败: {error}"),
                "apps": [],
                "isAdmin": true
            }))
        }
    };
    if let Some(error) = parsed.get("error").and_then(Value::as_str) {
        return Ok(json!({ "success": false, "error": error, "apps": [], "isAdmin": true }));
    }

    let mut apps = match parsed {
        Value::Array(items) => items,
        other => vec![other],
    };
    let display_names = loopback_display_names();
    for app in &mut apps {
        loopback_resolve_display_name(app, &display_names);
    }
    apps.sort_by(|left, right| {
        let left_exempt = left
            .get("isExempt")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let right_exempt = right
            .get("isExempt")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        right_exempt.cmp(&left_exempt).then_with(|| {
            let left_name = left
                .get("displayName")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let right_name = right
                .get("displayName")
                .and_then(Value::as_str)
                .unwrap_or_default();
            left_name
                .to_ascii_lowercase()
                .cmp(&right_name.to_ascii_lowercase())
        })
    });

    let exempt_sids = apps
        .iter()
        .filter(|item| {
            item.get("isExempt")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        })
        .filter_map(|item| item.get("sid").and_then(Value::as_str))
        .collect::<Vec<_>>();
    set_setting(app, "loopbackExemptSids", json!(exempt_sids))?;

    Ok(success(json!({ "apps": apps, "isAdmin": true })))
}

fn loopback_set(app: &AppHandle, sids: Vec<String>) -> CompatResult {
    if !cfg!(target_os = "windows") {
        set_setting(app, "loopbackExemptSids", json!(sids))?;
        return Ok(success(json!({ "count": 0 })));
    }

    for sid in &sids {
        if !loopback_sid_valid(sid) {
            return Ok(json!({
                "success": false,
                "error": format!("Invalid SID format: {sid}")
            }));
        }
    }

    let sid_list = sids
        .iter()
        .map(|sid| format!("\"{}\"", sid.replace('"', "")))
        .collect::<Vec<_>>()
        .join(",");
    let method_call = format!("$sids = @({sid_list})\n[NetworkIsolationHelper]::SetConfig($sids)");
    let output = match loopback_api_call(&method_call) {
        Ok(output) => output,
        Err(error) => return Ok(json!({ "success": false, "error": error })),
    };
    let result = match serde_json::from_str::<Value>(&output) {
        Ok(result) => result,
        Err(error) => {
            return Ok(json!({
                "success": false,
                "error": format!("解析 Loopback 保存结果失败: {error}")
            }))
        }
    };

    if result
        .get("success")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        set_setting(app, "loopbackExemptSids", json!(sids))?;
    }

    Ok(result)
}

fn loopback_current_exempt_sids(app: &AppHandle) -> Result<Vec<String>, String> {
    let result = loopback_apps(app)?;
    if !result
        .get("success")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Err(result
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("读取 Loopback 状态失败")
            .to_string());
    }
    Ok(result
        .get("apps")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|value| {
            value
                .get("isExempt")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        })
        .filter_map(|value| {
            value
                .get("sid")
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
        .collect())
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

fn powershell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn windows_batch_quote(path: &Path) -> String {
    format!("\"{}\"", path.to_string_lossy().replace('"', "\"\""))
}

fn windows_task_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app_data_dir(app)?.join("task");
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    Ok(dir)
}

fn windows_current_user_id() -> String {
    command_output("whoami.exe", &[])
        .map(|value| value.trim().to_string())
        .ok()
        .filter(|value| !value.is_empty())
        .or_else(|| std::env::var("USERNAME").ok())
        .unwrap_or_default()
}

fn elevated_task_xml(exe_path: &Path, user_id: &str) -> String {
    let user_block = if user_id.is_empty() {
        String::new()
    } else {
        format!("      <UserId>{}</UserId>\n", xml_escape(user_id))
    };

    format!(
        r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>FlyClash Elevated Task</Description>
  </RegistrationInfo>
  <Triggers />
  <Principals>
    <Principal id="Author">
{user_block}      <LogonType>InteractiveToken</LogonType>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>4</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>{}</Command>
    </Exec>
  </Actions>
</Task>"#,
        xml_escape(&exe_path.to_string_lossy())
    )
}

fn write_utf16le_with_bom(path: &Path, content: &str) -> Result<(), String> {
    let mut bytes = vec![0xFF, 0xFE];
    for unit in content.encode_utf16() {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    fs::write(path, bytes).map_err(|err| err.to_string())
}

fn create_windows_elevated_task(app: &AppHandle) -> Result<bool, String> {
    if !cfg!(target_os = "windows") {
        return Ok(false);
    }

    let task_dir = windows_task_dir(app)?;
    let exe_path = std::env::current_exe().map_err(|err| err.to_string())?;
    let xml_path = task_dir.join(format!("{WINDOWS_ELEVATED_TASK_NAME}.xml"));
    let xml = elevated_task_xml(&exe_path, &windows_current_user_id());
    write_utf16le_with_bom(&xml_path, &xml)?;

    if windows_is_admin() {
        command_output(
            "schtasks.exe",
            &[
                "/create",
                "/tn",
                WINDOWS_ELEVATED_TASK_NAME,
                "/xml",
                &xml_path.to_string_lossy(),
                "/f",
            ],
        )?;
    } else {
        let batch_path = task_dir.join("create-elevated-task.bat");
        let marker_path = task_dir.join("grant-success.marker");
        let _ = fs::remove_file(&marker_path);
        let script = format!(
            r#"@echo off
chcp 65001 >nul
schtasks.exe /create /tn "{task_name}" /xml {xml_path} /f
if %errorlevel% neq 0 exit /b %errorlevel%
echo success > {marker_path}
exit /b 0
"#,
            task_name = WINDOWS_ELEVATED_TASK_NAME,
            xml_path = windows_batch_quote(&xml_path),
            marker_path = windows_batch_quote(&marker_path),
        );
        fs::write(&batch_path, script).map_err(|err| err.to_string())?;

        let ps_command = format!(
            "$p = Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', {}) -Verb RunAs -Wait -PassThru; if ($null -eq $p) {{ exit 1 }}; exit $p.ExitCode",
            powershell_quote(&batch_path.to_string_lossy())
        );
        command_output(
            "powershell.exe",
            &[
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                &ps_command,
            ],
        )?;
    }

    if windows_elevated_task_exists() {
        Ok(true)
    } else {
        Err("计划任务创建后未能查询到，请检查系统任务计划程序权限".to_string())
    }
}

fn schedule_windows_elevated_restart(app: &AppHandle) -> Result<(), String> {
    if !cfg!(target_os = "windows") {
        return Ok(());
    }

    let ps_command = format!(
        "Start-Sleep -Milliseconds 1200; schtasks.exe /run /tn {} | Out-Null",
        powershell_quote(WINDOWS_ELEVATED_TASK_NAME)
    );
    let mut command = Command::new("powershell.exe");
    command.args([
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        &ps_command,
    ]);
    #[cfg(target_os = "windows")]
    command.creation_flags(0x08000000);
    command.spawn().map_err(|err| err.to_string())?;

    let app_handle = app.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(500));
        app_handle.exit(0);
    });

    Ok(())
}

fn windows_is_admin() -> bool {
    if !cfg!(target_os = "windows") {
        return false;
    }

    let script = "[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)";
    if let Ok(output) = command_output(
        "powershell.exe",
        &["-NoProfile", "-NonInteractive", "-Command", script],
    ) {
        if output.trim().eq_ignore_ascii_case("true") {
            return true;
        }
    }

    command_output("net", &["session"]).is_ok()
}

fn windows_elevated_task_exists() -> bool {
    if !cfg!(target_os = "windows") {
        return false;
    }

    command_output(
        "schtasks.exe",
        &["/query", "/tn", WINDOWS_ELEVATED_TASK_NAME],
    )
    .is_ok()
}

fn delete_windows_elevated_task() -> Result<bool, String> {
    if !cfg!(target_os = "windows") {
        return Ok(false);
    }

    if !windows_elevated_task_exists() {
        return Ok(false);
    }

    command_output(
        "schtasks.exe",
        &["/delete", "/tn", WINDOWS_ELEVATED_TASK_NAME, "/f"],
    )?;
    Ok(true)
}

fn should_start_core_by_service(app: &AppHandle) -> bool {
    if !cfg!(target_os = "windows") {
        return false;
    }

    let mode = setting(app, "tunElevationMode", json!("service"))
        .ok()
        .and_then(|value| value.as_str().map(ToString::to_string))
        .unwrap_or_else(|| "service".to_string());
    let tun_enabled = setting(app, "tunModeEnabled", json!(false))
        .ok()
        .and_then(|value| value.as_bool())
        .unwrap_or(false);

    mode == "service" && tun_enabled
}

fn windows_core_permission_status(app: &AppHandle) -> Value {
    let mode = setting(app, "tunElevationMode", json!("service"))
        .ok()
        .and_then(|value| value.as_str().map(ToString::to_string))
        .unwrap_or_else(|| "service".to_string());
    let is_admin = windows_is_admin();
    let has_task = windows_elevated_task_exists();
    let flags = core_service::query_helper_service_flags();
    let helper = core_service::helper_ipc_snapshot(flags.running);

    success(core_service::windows_permission_status_payload(
        mode, is_admin, has_task, flags, helper,
    ))
}

fn install_or_start_windows_tun_service(app: &AppHandle) -> CompatResult {
    let flags = core_service::query_helper_service_flags();
    if flags.running {
        let helper = core_service::helper_ipc_snapshot(true);
        let ipc_available = helper.ipc_available();
        return Ok(success(core_service::helper_service_action_payload(
            "TUN Helper 服务已运行",
            helper,
            ipc_available,
        )));
    }

    if flags.installed {
        return match core_service::ensure_helper_service_ready() {
            Ok(_) => {
                let helper = core_service::helper_ipc_snapshot(true);
                let ipc_available = helper.ipc_available();
                Ok(success(core_service::helper_service_action_payload(
                    "TUN Helper 服务已启动",
                    helper,
                    ipc_available,
                )))
            }
            Err(error) => Ok(json!({ "success": false, "error": error })),
        };
    }

    let helper = find_helper_executable(app)?;
    core_service::install_helper_service(&helper, !windows_is_admin())?;

    let ready = core_service::ensure_helper_service_ready().is_ok();
    let flags = core_service::query_helper_service_flags();
    let helper = core_service::helper_ipc_snapshot(flags.running);
    let message = if ready {
        "TUN Helper 服务已安装并就绪"
    } else if flags.running {
        "TUN Helper 服务已安装并启动，IPC 暂未就绪"
    } else {
        "TUN Helper 服务已安装"
    };
    Ok(success(core_service::helper_service_action_payload(
        message, helper, ready,
    )))
}

fn process_icon_data_url(process_path: &str) -> Result<Option<String>, String> {
    if !cfg!(target_os = "windows") {
        return Ok(None);
    }

    let path = if process_path == "mihomo" {
        std::env::current_exe().map_err(|err| err.to_string())?
    } else {
        PathBuf::from(process_path)
    };

    if !path.exists() || !path.is_file() {
        return Ok(None);
    }

    let script = r#"
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$path = $env:FLYCLASH_ICON_PATH
$icon = [System.Drawing.Icon]::ExtractAssociatedIcon($path)
if ($null -eq $icon) { exit 2 }
$bitmap = $icon.ToBitmap()
$stream = New-Object System.IO.MemoryStream
$bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
[Console]::Out.Write([Convert]::ToBase64String($stream.ToArray()))
$stream.Dispose()
$bitmap.Dispose()
$icon.Dispose()
"#;

    let mut command = Command::new("powershell.exe");
    command
        .args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script,
        ])
        .env("FLYCLASH_ICON_PATH", &path);
    #[cfg(target_os = "windows")]
    command.creation_flags(0x08000000);

    let output = command.output().map_err(|err| err.to_string())?;
    if !output.status.success() {
        return Ok(None);
    }

    let encoded = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if encoded.is_empty() {
        Ok(None)
    } else {
        Ok(Some(format!("data:image/png;base64,{encoded}")))
    }
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

fn autostart_enabled(app: &AppHandle) -> bool {
    if cfg!(target_os = "windows") {
        let output = command_output(
            "reg",
            &[
                "query",
                r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
                "/v",
                "FlyClash",
            ],
        );
        match output {
            Ok(text) => {
                let enabled = text
                    .lines()
                    .any(|line| line.contains("FlyClash") && line.contains(".exe"));
                let _ = set_setting(app, "autoStart", json!(enabled));
                return enabled;
            }
            Err(_) => {
                let _ = set_setting(app, "autoStart", json!(false));
                return false;
            }
        }
    }

    setting(app, "autoStart", json!(false))
        .ok()
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
}

fn service_status() -> Value {
    if !cfg!(target_os = "windows") {
        return success(core_service::unsupported_service_status_payload());
    }

    let flags = core_service::query_helper_service_flags();
    let helper = core_service::helper_ipc_snapshot(flags.running);
    success(core_service::helper_service_status_payload(flags, helper))
}

fn find_helper_executable(app: &AppHandle) -> Result<PathBuf, String> {
    existing_resource_file(
        app,
        &[
            PathBuf::from("tools").join("flyclash-helper.exe"),
            PathBuf::from("flyclash-helper.exe"),
        ],
    )
    .ok_or_else(|| "未找到 flyclash-helper.exe，请确认 tools 目录已被打包".to_string())
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
            "downloadSpeed": (bytes as f64 * 8.0 / duration / 1_000_000.0),
            "upload": 0,
            "uploadSpeed": 0,
            "ping": 0,
            "jitter": 0,
            "server": { "host": "speed.cloudflare.com", "name": "Cloudflare", "country": "" }
        }
    })))
}

fn speedtest_proxy_endpoint(app: &AppHandle, options: &Value) -> Result<(String, u16), String> {
    let proxy = options.get("proxy").cloned().unwrap_or_else(|| json!({}));
    let host = proxy
        .get("host")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("127.0.0.1")
        .to_string();
    let port = value_u16(proxy.get("port")).unwrap_or_else(|| mihomo_mixed_port(app));
    if port == 0 {
        return Err("代理端口无效".to_string());
    }
    Ok((host, port))
}

async fn proxy_speedtest_download(app: &AppHandle, options: &Value, url: &str) -> CompatResult {
    let (proxy_host, proxy_port) = speedtest_proxy_endpoint(app, options)?;
    let proxy_url = format!("http://{proxy_host}:{proxy_port}");
    let response = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .danger_accept_invalid_certs(true)
        .proxy(reqwest::Proxy::all(&proxy_url).map_err(|err| err.to_string())?)
        .build()
        .map_err(|err| err.to_string())?
        .get(url)
        .send()
        .await
        .map_err(|err| err.to_string())?;
    let status = response.status();
    let status_text = status.canonical_reason().unwrap_or("").to_string();
    let bytes = response.bytes().await.map_err(|err| err.to_string())?;

    Ok(json!({
        "ok": status.is_success(),
        "status": status.as_u16(),
        "statusText": status_text,
        "bytes": bytes.len() as u64,
        "proxy": {
            "host": proxy_host,
            "port": proxy_port
        }
    }))
}

fn value_u16(value: Option<&Value>) -> Option<u16> {
    value
        .and_then(Value::as_u64)
        .and_then(|port| u16::try_from(port).ok())
        .or_else(|| {
            value
                .and_then(Value::as_str)
                .and_then(|port| port.parse::<u16>().ok())
        })
}

fn udp_test_servers(options: &Value) -> Vec<Value> {
    let configured = options
        .get("testServers")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|server| {
            let address = server.get("address").and_then(Value::as_str)?.trim();
            let port = value_u16(server.get("port")).unwrap_or(53);
            if address.is_empty() || port == 0 {
                return None;
            }
            Some(json!({
                "name": server
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or(address),
                "address": address,
                "port": port
            }))
        })
        .collect::<Vec<_>>();

    if !configured.is_empty() {
        return configured;
    }

    vec![
        json!({ "name": "Cloudflare DNS", "address": "1.1.1.1", "port": 53 }),
        json!({ "name": "Google DNS", "address": "8.8.8.8", "port": 53 }),
        json!({ "name": "Quad9 DNS", "address": "9.9.9.9", "port": 53 }),
    ]
}

fn resolve_socket_addr(host: &str, port: u16) -> Result<SocketAddr, String> {
    (host, port)
        .to_socket_addrs()
        .map_err(|err| err.to_string())?
        .next()
        .ok_or_else(|| format!("无法解析地址 {host}:{port}"))
}

fn socks5_address_bytes(host: &str, port: u16) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    if let Ok(ip) = host.parse::<IpAddr>() {
        match ip {
            IpAddr::V4(ip) => {
                bytes.push(0x01);
                bytes.extend_from_slice(&ip.octets());
            }
            IpAddr::V6(ip) => {
                bytes.push(0x04);
                bytes.extend_from_slice(&ip.octets());
            }
        }
    } else {
        let host_bytes = host.as_bytes();
        if host_bytes.len() > u8::MAX as usize {
            return Err("目标域名过长".to_string());
        }
        bytes.push(0x03);
        bytes.push(host_bytes.len() as u8);
        bytes.extend_from_slice(host_bytes);
    }
    bytes.extend_from_slice(&port.to_be_bytes());
    Ok(bytes)
}

fn read_socks5_bound_addr(
    stream: &mut TcpStream,
    proxy_addr: SocketAddr,
) -> Result<SocketAddr, String> {
    let mut head = [0u8; 4];
    stream
        .read_exact(&mut head)
        .map_err(|err| err.to_string())?;
    if head[0] != 0x05 {
        return Err("SOCKS5 代理返回了无效版本".to_string());
    }
    if head[1] != 0x00 {
        return Err(format!("SOCKS5 UDP ASSOCIATE 失败，REP={}", head[1]));
    }

    let ip = match head[3] {
        0x01 => {
            let mut raw = [0u8; 4];
            stream.read_exact(&mut raw).map_err(|err| err.to_string())?;
            IpAddr::from(raw)
        }
        0x04 => {
            let mut raw = [0u8; 16];
            stream.read_exact(&mut raw).map_err(|err| err.to_string())?;
            IpAddr::from(raw)
        }
        0x03 => {
            let mut len = [0u8; 1];
            stream.read_exact(&mut len).map_err(|err| err.to_string())?;
            let mut raw = vec![0u8; len[0] as usize];
            stream.read_exact(&mut raw).map_err(|err| err.to_string())?;
            let host = String::from_utf8_lossy(&raw).to_string();
            resolve_socket_addr(&host, proxy_addr.port())?.ip()
        }
        _ => return Err("SOCKS5 代理返回了不支持的地址类型".to_string()),
    };
    let mut port = [0u8; 2];
    stream
        .read_exact(&mut port)
        .map_err(|err| err.to_string())?;
    let port = u16::from_be_bytes(port);
    let ip = if ip.is_unspecified() {
        proxy_addr.ip()
    } else {
        ip
    };
    Ok(SocketAddr::new(ip, port))
}

fn dns_probe_packet() -> Vec<u8> {
    let id = (now_millis() as u16).to_be_bytes();
    let mut packet = Vec::with_capacity(29);
    packet.extend_from_slice(&id);
    packet.extend_from_slice(&[0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    packet.push(7);
    packet.extend_from_slice(b"example");
    packet.push(3);
    packet.extend_from_slice(b"com");
    packet.push(0);
    packet.extend_from_slice(&[0x00, 0x01, 0x00, 0x01]);
    packet
}

fn socks5_udp_probe(
    proxy_host: &str,
    proxy_port: u16,
    server_host: &str,
    server_port: u16,
) -> Result<u128, String> {
    let timeout = Duration::from_secs(5);
    let proxy_addr = resolve_socket_addr(proxy_host, proxy_port)?;
    let mut stream =
        TcpStream::connect_timeout(&proxy_addr, timeout).map_err(|err| err.to_string())?;
    stream
        .set_read_timeout(Some(timeout))
        .map_err(|err| err.to_string())?;
    stream
        .set_write_timeout(Some(timeout))
        .map_err(|err| err.to_string())?;

    stream
        .write_all(&[0x05, 0x01, 0x00])
        .map_err(|err| err.to_string())?;
    let mut greeting = [0u8; 2];
    stream
        .read_exact(&mut greeting)
        .map_err(|err| err.to_string())?;
    if greeting != [0x05, 0x00] {
        return Err("SOCKS5 代理不支持无认证 UDP 探测".to_string());
    }

    let mut request = vec![0x05, 0x03, 0x00, 0x01, 0, 0, 0, 0, 0, 0];
    stream.write_all(&request).map_err(|err| err.to_string())?;
    let relay_addr = read_socks5_bound_addr(&mut stream, proxy_addr)?;

    let udp = UdpSocket::bind(if relay_addr.is_ipv4() {
        "0.0.0.0:0"
    } else {
        "[::]:0"
    })
    .map_err(|err| err.to_string())?;
    udp.set_read_timeout(Some(timeout))
        .map_err(|err| err.to_string())?;
    udp.set_write_timeout(Some(timeout))
        .map_err(|err| err.to_string())?;

    request.clear();
    request.extend_from_slice(&[0x00, 0x00, 0x00]);
    request.extend_from_slice(&socks5_address_bytes(server_host, server_port)?);
    request.extend_from_slice(&dns_probe_packet());

    let started = now_millis();
    udp.send_to(&request, relay_addr)
        .map_err(|err| err.to_string())?;
    let mut response = [0u8; 2048];
    let (size, _) = udp
        .recv_from(&mut response)
        .map_err(|err| err.to_string())?;
    if size <= 10 {
        return Err("UDP 响应过短".to_string());
    }
    Ok(now_millis().saturating_sub(started))
}

async fn test_udp_connectivity(app: &AppHandle, options: Value) -> CompatResult {
    let proxy = options.get("proxy").cloned().unwrap_or_else(|| json!({}));
    let proxy_host = proxy
        .get("host")
        .and_then(Value::as_str)
        .unwrap_or("127.0.0.1")
        .trim()
        .to_string();
    let proxy_port = value_u16(proxy.get("port")).unwrap_or_else(|| mihomo_mixed_port(app));
    if proxy_host.is_empty() || proxy_port == 0 {
        return Ok(json!({
            "success": false,
            "udpType": "unknown",
            "successCount": 0,
            "details": [],
            "error": "缺少 SOCKS5 代理地址或端口"
        }));
    }

    let servers = udp_test_servers(&options);
    let mut details = Vec::new();
    let mut success_count = 0usize;

    for server in servers {
        let name = server
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("UDP Server")
            .to_string();
        let address = server
            .get("address")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let port = value_u16(server.get("port")).unwrap_or(53);
        let result = socks5_udp_probe(&proxy_host, proxy_port, &address, port);
        match result {
            Ok(latency) => {
                success_count += 1;
                details.push(json!({
                    "name": name,
                    "address": address,
                    "port": port,
                    "success": true,
                    "latency": latency
                }));
            }
            Err(error) => details.push(json!({
                "name": name,
                "address": address,
                "port": port,
                "success": false,
                "error": error
            })),
        }
    }

    Ok(json!({
        "success": success_count > 0,
        "udpType": if success_count > 0 { "available" } else { "blocked" },
        "successCount": success_count,
        "details": details,
        "proxy": {
            "host": proxy_host,
            "port": proxy_port,
            "nodeName": proxy.get("nodeName").cloned().unwrap_or(Value::Null)
        },
        "error": if success_count > 0 { Value::Null } else { json!("UDP 连通性探测失败") }
    }))
}

fn emit_speedtest_output(window: &WebviewWindow, payload: Value) {
    let _ = window.emit("speedtest-output", payload);
}

fn find_speedtest_executable(app: &AppHandle) -> Option<PathBuf> {
    if !cfg!(target_os = "windows") {
        return None;
    }

    for dir in tool_dirs(app) {
        for candidate in [
            dir.join("speedtest.exe"),
            dir.join("speedtest-cli").join("speedtest.exe"),
            dir.join("ookla-speedtest-1.2.0-win64")
                .join("speedtest.exe"),
        ] {
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    None
}

fn json_number_at(value: &Value, path: &[&str]) -> f64 {
    let mut current = value;
    for key in path {
        let Some(next) = current.get(*key) else {
            return 0.0;
        };
        current = next;
    }
    current.as_f64().unwrap_or_else(|| {
        current
            .as_str()
            .and_then(|text| text.parse::<f64>().ok())
            .unwrap_or(0.0)
    })
}

fn json_string_at(value: &Value, path: &[&str]) -> String {
    let mut current = value;
    for key in path {
        let Some(next) = current.get(*key) else {
            return String::new();
        };
        current = next;
    }
    current.as_str().unwrap_or_default().to_string()
}

fn ookla_bandwidth_mbps(value: &Value, key: &str) -> f64 {
    let bandwidth = json_number_at(value, &[key, "bandwidth"]);
    if bandwidth > 0.0 {
        bandwidth * 8.0 / 1_000_000.0
    } else {
        json_number_at(value, &[key])
    }
}

fn speedtest_data_from_ookla_json(raw: &str) -> Result<Value, String> {
    let parsed = serde_json::from_str::<Value>(raw).map_err(|err| err.to_string())?;
    let download = ookla_bandwidth_mbps(&parsed, "download");
    let upload = ookla_bandwidth_mbps(&parsed, "upload");
    let ping = json_number_at(&parsed, &["ping", "latency"]);
    let jitter = json_number_at(&parsed, &["ping", "jitter"]);
    let server_name = json_string_at(&parsed, &["server", "name"]);
    let server_country = json_string_at(&parsed, &["server", "country"]);
    let server_host = json_string_at(&parsed, &["server", "host"]);

    Ok(json!({
        "download": download,
        "downloadSpeed": download,
        "upload": upload,
        "uploadSpeed": upload,
        "ping": ping,
        "jitter": jitter,
        "server": {
            "host": server_host,
            "name": server_name,
            "country": server_country
        }
    }))
}

fn emit_speedtest_result_events(window: &WebviewWindow, data: &Value) {
    let ping = data.get("ping").and_then(Value::as_f64).unwrap_or(0.0);
    let jitter = data.get("jitter").and_then(Value::as_f64).unwrap_or(0.0);
    let download = data.get("download").and_then(Value::as_f64).unwrap_or(0.0);
    let upload = data.get("upload").and_then(Value::as_f64).unwrap_or(0.0);

    emit_speedtest_output(
        window,
        json!({
            "type": "progress",
            "phase": "ping",
            "progress": 30,
            "ping": ping,
            "jitter": jitter
        }),
    );
    emit_speedtest_output(
        window,
        json!({
            "type": "progress",
            "phase": "download",
            "progress": 65,
            "downloadSpeed": download
        }),
    );
    emit_speedtest_output(
        window,
        json!({
            "type": "progress",
            "phase": "upload",
            "progress": 90,
            "uploadSpeed": upload
        }),
    );
    emit_speedtest_output(
        window,
        json!({
            "type": "status",
            "phase": "complete",
            "progress": 100,
            "message": "测速完成"
        }),
    );
}

fn run_ookla_speedtest(app: &AppHandle, window: &WebviewWindow) -> Option<CompatResult> {
    let speedtest = find_speedtest_executable(app)?;
    emit_speedtest_output(
        window,
        json!({
            "type": "stdout",
            "message": format!("Using {}", speedtest.to_string_lossy())
        }),
    );

    let mut child = match Command::new(&speedtest)
        .args([
            "--format=json",
            "--accept-license",
            "--accept-gdpr",
            "--unit=Mbps",
            "--precision=2",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            emit_speedtest_output(
                window,
                json!({
                    "type": "status",
                    "phase": "error",
                    "message": format!("启动测速工具失败: {error}"),
                    "error": error.to_string()
                }),
            );
            return Some(Ok(json!({
                "success": false,
                "error": format!("启动测速工具失败: {error}")
            })));
        }
    };

    let started = SystemTime::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if started
                    .elapsed()
                    .map(|elapsed| elapsed > Duration::from_secs(120))
                    .unwrap_or(false)
                {
                    let _ = child.kill();
                    let output = child.wait_with_output().map_err(|err| err.to_string());
                    let stderr = output
                        .ok()
                        .map(|output| String::from_utf8_lossy(&output.stderr).trim().to_string())
                        .unwrap_or_default();
                    let message = if stderr.is_empty() {
                        "测速超时".to_string()
                    } else {
                        format!("测速超时: {stderr}")
                    };
                    emit_speedtest_output(
                        window,
                        json!({ "type": "status", "phase": "error", "message": message }),
                    );
                    return Some(Ok(json!({ "success": false, "error": message })));
                }
                thread::sleep(Duration::from_millis(200));
            }
            Err(error) => {
                let message = format!("等待测速工具失败: {error}");
                emit_speedtest_output(
                    window,
                    json!({ "type": "status", "phase": "error", "message": message }),
                );
                return Some(Ok(json!({ "success": false, "error": message })));
            }
        }
    }

    let output = match child.wait_with_output() {
        Ok(output) => output,
        Err(error) => {
            let message = format!("读取测速结果失败: {error}");
            emit_speedtest_output(
                window,
                json!({ "type": "status", "phase": "error", "message": message }),
            );
            return Some(Ok(json!({ "success": false, "error": message })));
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !stderr.is_empty() {
        emit_speedtest_output(window, json!({ "type": "stderr", "message": stderr }));
    }

    let success_code = output
        .status
        .code()
        .is_some_and(|code| code == 0 || code == 2);
    if !success_code {
        let message = if stderr.is_empty() {
            format!("测速失败，退出码: {}", output.status.code().unwrap_or(-1))
        } else {
            stderr
        };
        emit_speedtest_output(
            window,
            json!({
                "type": "status",
                "phase": "error",
                "progress": 100,
                "message": message,
                "exitCode": output.status.code()
            }),
        );
        return Some(Ok(json!({ "success": false, "error": message })));
    }

    match speedtest_data_from_ookla_json(&stdout) {
        Ok(data) => {
            emit_speedtest_result_events(window, &data);
            Some(Ok(success(json!({ "data": data }))))
        }
        Err(error) => {
            let message = format!("解析测速结果失败: {error}");
            emit_speedtest_output(
                window,
                json!({ "type": "status", "phase": "error", "message": message }),
            );
            Some(Ok(json!({ "success": false, "error": message })))
        }
    }
}

fn media_user_agent() -> &'static str {
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
}

fn media_result(
    available: bool,
    full_support: bool,
    message: impl Into<String>,
    region: Option<String>,
    check_time: u128,
) -> Value {
    json!({
        "available": available,
        "fullSupport": full_support,
        "message": message.into(),
        "region": region,
        "checkTime": check_time,
        "dnsStatus": { "resolved": true }
    })
}

async fn media_fetch_text(
    client: &reqwest::Client,
    url: &str,
    extra_headers: &[(&str, &str)],
) -> Result<(u16, String), String> {
    let mut request = client
        .get(url)
        .header("User-Agent", media_user_agent())
        .header("Accept-Language", "en-US,en;q=0.9")
        .header("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7");
    for (key, value) in extra_headers {
        request = request.header(*key, *value);
    }
    let response = request.send().await.map_err(|err| err.to_string())?;
    let status = response.status().as_u16();
    let text = response.text().await.map_err(|err| err.to_string())?;
    Ok((status, text))
}

fn decode_js_hex_escapes(input: &str) -> String {
    Regex::new(r"\\x([0-9A-Fa-f]{2})")
        .ok()
        .map(|regex| {
            regex
                .replace_all(input, |caps: &regex::Captures| {
                    u8::from_str_radix(&caps[1], 16)
                        .ok()
                        .map(|value| (value as char).to_string())
                        .unwrap_or_else(|| caps[0].to_string())
                })
                .to_string()
        })
        .unwrap_or_else(|| input.to_string())
}

fn first_regex_capture(input: &str, patterns: &[&str]) -> Option<String> {
    patterns.iter().find_map(|pattern| {
        Regex::new(pattern)
            .ok()?
            .captures(input)
            .and_then(|captures| {
                captures
                    .get(1)
                    .map(|matched| matched.as_str().trim().to_string())
            })
    })
}

fn netflix_region(html: &str) -> Option<String> {
    let decoded = decode_js_hex_escapes(html);
    first_regex_capture(
        &decoded,
        &[
            r#"requestCountry"?\s*:\s*\{[^}]*"id"?\s*:\s*"([A-Za-z]{2})""#,
            r#""requestCountry"\s*:\s*\{[^}]*"id"\s*:\s*"([A-Za-z]{2})""#,
            r#"/([a-z]{2})-[A-Za-z]{2}/title/"#,
            r#""countryOfSignup"\s*:\s*"([A-Za-z]{2})""#,
        ],
    )
    .map(|value| value.to_uppercase())
}

fn netflix_playable(html: &str, title_id: &str) -> bool {
    let decoded = decode_js_hex_escapes(html);
    let lower = decoded.to_ascii_lowercase();
    let has_title = decoded.contains(title_id);
    let has_media_tracks = lower.contains("mediatracks");
    let explicit_playable = lower.contains("\"playable\":true")
        || lower.contains("\"isplayable\":true")
        || lower.contains("isplayable&quot;:true");
    has_title && (has_media_tracks || explicit_playable)
}

async fn test_netflix(client: &reqwest::Client, started: u128) -> Value {
    async fn probe(
        client: &reqwest::Client,
        url: &str,
        title_id: &str,
    ) -> (bool, bool, Option<String>) {
        match media_fetch_text(client, url, &[]).await {
            Ok((status, html)) if (200..400).contains(&status) => {
                let region = netflix_region(&html);
                let playable = netflix_playable(&html, title_id);
                (true, playable, region)
            }
            Ok((status, html)) => {
                let region = netflix_region(&html);
                (status == 401 || status == 403, false, region)
            }
            Err(_) => (false, false, None),
        }
    }

    let original = probe(client, "https://www.netflix.com/title/81280792", "81280792").await;
    let non_original = probe(client, "https://www.netflix.com/title/80057281", "80057281").await;
    let check_time = now_millis().saturating_sub(started);
    let region = original.2.or(non_original.2);

    if !original.0 && !non_original.0 {
        return media_result(false, false, "Netflix 检测失败", region, check_time);
    }
    if original.1 && non_original.1 {
        return media_result(true, true, "解锁所有内容", region, check_time);
    }
    if original.1 {
        return media_result(true, false, "仅支持自制剧", region, check_time);
    }
    if non_original.1 {
        return media_result(true, true, "解锁非自制剧", region, check_time);
    }
    if original.0 || non_original.0 {
        return media_result(
            true,
            false,
            "Netflix 页面可访问，未检测到可播放内容",
            region,
            check_time,
        );
    }
    media_result(false, false, "不支持", region, check_time)
}

async fn test_youtube_premium(client: &reqwest::Client, started: u128) -> Value {
    match media_fetch_text(client, "https://www.youtube.com/premium", &[]).await {
        Ok((status, html)) => {
            let check_time = now_millis().saturating_sub(started);
            let lower = html.to_ascii_lowercase();
            let region = first_regex_capture(
                &html,
                &[
                    r#""GL"\s*:\s*"([A-Z]{2})""#,
                    r#""countryCode"\s*:\s*"([A-Z]{2})""#,
                    r#""country"\s*:\s*"([A-Z]{2})""#,
                ],
            );
            if !(200..400).contains(&status) {
                return media_result(
                    false,
                    false,
                    format!("YouTube Premium HTTP {status}"),
                    region,
                    check_time,
                );
            }
            let unavailable = lower.contains("not available in your country")
                || lower.contains("premium is not available")
                || lower.contains("youtube premium isn't available");
            if unavailable {
                media_result(
                    false,
                    false,
                    "YouTube Premium 区域不支持",
                    region,
                    check_time,
                )
            } else if lower.contains("ad-free") || lower.contains("youtube premium") {
                media_result(true, true, "支持 YouTube Premium", region, check_time)
            } else {
                media_result(
                    true,
                    false,
                    "YouTube 可访问，Premium 状态未知",
                    region,
                    check_time,
                )
            }
        }
        Err(error) => media_result(
            false,
            false,
            format!("YouTube Premium 检测失败: {error}"),
            None,
            now_millis().saturating_sub(started),
        ),
    }
}

async fn test_bbc_iplayer(client: &reqwest::Client, started: u128) -> Value {
    let url = "https://open.live.bbc.co.uk/mediaselector/6/select/version/2.0/mediaset/pc/vpid/bbc_one_london/format/json/jsfunc/JS_callbacks0";
    match media_fetch_text(client, url, &[]).await {
        Ok((status, body)) => {
            let check_time = now_millis().saturating_sub(started);
            let lower = body.to_ascii_lowercase();
            if !(200..400).contains(&status) {
                return media_result(
                    false,
                    false,
                    format!("BBC iPlayer HTTP {status}"),
                    Some("UK".to_string()),
                    check_time,
                );
            }
            let blocked = lower.contains("geolocation")
                || lower.contains("notuk")
                || lower.contains("outside")
                || lower.contains("unavailable");
            if blocked {
                media_result(
                    false,
                    false,
                    "BBC iPlayer 区域限制",
                    Some("UK".to_string()),
                    check_time,
                )
            } else {
                media_result(
                    true,
                    true,
                    "BBC iPlayer 可用",
                    Some("UK".to_string()),
                    check_time,
                )
            }
        }
        Err(error) => media_result(
            false,
            false,
            format!("BBC iPlayer 检测失败: {error}"),
            Some("UK".to_string()),
            now_millis().saturating_sub(started),
        ),
    }
}

async fn test_abema(client: &reqwest::Client, started: u128) -> Value {
    match media_fetch_text(
        client,
        "https://api.abema.io/v1/ip/check?device=android",
        &[("Accept", "application/json")],
    )
    .await
    {
        Ok((status, body)) => {
            let check_time = now_millis().saturating_sub(started);
            if !(200..400).contains(&status) {
                return media_result(
                    false,
                    false,
                    format!("AbemaTV HTTP {status}"),
                    None,
                    check_time,
                );
            }
            let parsed = serde_json::from_str::<Value>(&body).unwrap_or(Value::Null);
            let region = parsed
                .get("isoCountryCode")
                .or_else(|| parsed.get("countryCode"))
                .or_else(|| parsed.get("country"))
                .and_then(Value::as_str)
                .map(|value| value.to_uppercase());
            let available = parsed
                .get("isAvailable")
                .or_else(|| parsed.get("available"))
                .and_then(Value::as_bool)
                .unwrap_or_else(|| region.as_deref() == Some("JP"));
            if available {
                media_result(
                    true,
                    true,
                    "AbemaTV 完全支持",
                    region.or(Some("JP".to_string())),
                    check_time,
                )
            } else {
                media_result(false, false, "AbemaTV 仅限日本地区", region, check_time)
            }
        }
        Err(error) => media_result(
            false,
            false,
            format!("AbemaTV 检测失败: {error}"),
            None,
            now_millis().saturating_sub(started),
        ),
    }
}

async fn specialized_media_streaming(
    client: &reqwest::Client,
    service_name: &str,
    started: u128,
) -> Option<Value> {
    match service_name {
        "Netflix" => Some(test_netflix(client, started).await),
        "YouTube Premium" => Some(test_youtube_premium(client, started).await),
        "BBC iPlayer" => Some(test_bbc_iplayer(client, started).await),
        "AbemaTV" | "Abema TV" | "Abema" => Some(test_abema(client, started).await),
        _ => None,
    }
}

async fn test_media_streaming(
    app: &AppHandle,
    service_name: &str,
    check_url: Option<String>,
) -> CompatResult {
    let port = mihomo_mixed_port(app);
    let proxy_url = format!("http://127.0.0.1:{port}");
    let started = now_millis();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .danger_accept_invalid_certs(true)
        .proxy(reqwest::Proxy::all(&proxy_url).map_err(|err| err.to_string())?)
        .build()
        .map_err(|err| err.to_string())?;

    if let Some(result) = specialized_media_streaming(&client, service_name, started).await {
        return Ok(result);
    }

    let Some(url) = check_url.filter(|value| !value.trim().is_empty()) else {
        return Ok(json!({
            "available": false,
            "fullSupport": false,
            "message": "缺少检测地址",
            "checkTime": 0
        }));
    };

    let response = client
        .get(&url)
        .header("User-Agent", media_user_agent())
        .header("Accept-Language", "en-US,en;q=0.9")
        .send()
        .await;
    let check_time = now_millis().saturating_sub(started);

    match response {
        Ok(response) => {
            let status = response.status();
            let available = status.is_success() || status.is_redirection();
            let partial = matches!(status.as_u16(), 401 | 403 | 451);
            let message = if available {
                format!("{service_name} 可访问")
            } else if partial {
                format!("{service_name} 返回限制状态 {}", status.as_u16())
            } else {
                format!("{service_name} 不可用: HTTP {}", status.as_u16())
            };

            Ok(json!({
                "available": available || partial,
                "fullSupport": available,
                "message": message,
                "checkTime": check_time,
                "dnsStatus": { "resolved": true }
            }))
        }
        Err(error) => Ok(json!({
            "available": false,
            "fullSupport": false,
            "message": format!("检测失败: {error}"),
            "checkTime": check_time,
            "dnsStatus": { "resolved": false }
        })),
    }
}

fn parse_proxy_names(input: &str) -> Value {
    let decoded = converter_source_text(input);
    let proxies = converter_parse_proxies(&decoded)
        .into_iter()
        .filter_map(|proxy| {
            Some(json!({
                "name": proxy.get("name").and_then(Value::as_str)?,
                "type": proxy.get("type").and_then(Value::as_str).unwrap_or("unknown"),
                "server": proxy.get("server").cloned().unwrap_or(Value::Null),
                "port": proxy.get("port").cloned().unwrap_or(Value::Null)
            }))
        })
        .collect::<Vec<_>>();
    let count = proxies.len();
    success(json!({
        "proxies": proxies,
        "count": count,
        "content": decoded
    }))
}

fn decode_base64_text(value: &str) -> Option<String> {
    let compact = value
        .trim()
        .chars()
        .filter(|ch| !ch.is_whitespace())
        .collect::<String>();
    if compact.is_empty() {
        return None;
    }

    let mut padded = compact.replace('-', "+").replace('_', "/");
    while padded.len() % 4 != 0 {
        padded.push('=');
    }

    general_purpose::STANDARD
        .decode(padded)
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
}

fn converter_source_text(input: &str) -> String {
    let trimmed = input.trim();
    if trimmed.contains("://") || trimmed.contains("proxies:") {
        return input.to_string();
    }

    decode_base64_text(trimmed)
        .filter(|decoded| decoded.contains("://") || decoded.contains("proxies:"))
        .unwrap_or_else(|| input.to_string())
}

fn decode_url_text(value: &str) -> String {
    urlencoding::decode(value)
        .map(|decoded| decoded.into_owned())
        .unwrap_or_else(|_| value.to_string())
}

fn converter_query_map(query: &str) -> HashMap<String, String> {
    query
        .split('&')
        .filter_map(|part| {
            let (key, value) = part.split_once('=').unwrap_or((part, ""));
            let key = decode_url_text(key);
            (!key.is_empty()).then(|| (key, decode_url_text(value)))
        })
        .collect()
}

fn converter_split_uri(
    raw: &str,
    scheme: &str,
) -> Option<(String, HashMap<String, String>, String)> {
    let mut body = raw.strip_prefix(scheme)?.to_string();
    let mut name = String::new();
    if let Some((left, fragment)) = body.split_once('#') {
        name = decode_url_text(fragment);
        body = left.to_string();
    }

    let mut query = HashMap::new();
    if let Some((left, query_string)) = body.split_once('?') {
        query = converter_query_map(query_string);
        body = left.to_string();
    }

    Some((body, query, name))
}

fn converter_split_host_port(value: &str) -> Option<(String, u16)> {
    let (host, port) = value.rsplit_once(':')?;
    let host = host.trim().trim_start_matches('[').trim_end_matches(']');
    let port = port.parse::<u16>().ok()?;
    (!host.is_empty()).then(|| (host.to_string(), port))
}

fn converter_split_user_host_port(value: &str) -> Option<(String, String, u16)> {
    let (user, host_port) = value.rsplit_once('@')?;
    let (host, port) = converter_split_host_port(host_port)?;
    Some((decode_url_text(user), host, port))
}

fn converter_insert_string(object: &mut Map<String, Value>, key: &str, value: Option<&String>) {
    if let Some(value) = value.filter(|value| !value.trim().is_empty()) {
        object.insert(key.to_string(), json!(value));
    }
}

fn converter_insert_bool_param(
    object: &mut Map<String, Value>,
    key: &str,
    query: &HashMap<String, String>,
    query_key: &str,
) {
    if let Some(value) = query.get(query_key) {
        let enabled = matches!(
            value.to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "allow"
        );
        object.insert(key.to_string(), json!(enabled));
    }
}

fn converter_parse_ss(line: &str) -> Option<Value> {
    let (body, query, name) = converter_split_uri(line, "ss://")?;
    let expanded = if body.contains('@') {
        body
    } else {
        decode_base64_text(&body)?
    };
    let (user_info, host, port) = converter_split_user_host_port(&expanded)?;
    let decoded_user = decode_base64_text(&user_info).unwrap_or(user_info);
    let (cipher, password) = decoded_user.split_once(':')?;
    let mut object = Map::new();
    object.insert(
        "name".to_string(),
        json!(if name.is_empty() {
            format!("{host}:{port}")
        } else {
            name
        }),
    );
    object.insert("type".to_string(), json!("ss"));
    object.insert("server".to_string(), json!(host));
    object.insert("port".to_string(), json!(port));
    object.insert("cipher".to_string(), json!(cipher));
    object.insert("password".to_string(), json!(password));
    converter_insert_string(&mut object, "plugin", query.get("plugin"));
    converter_insert_bool_param(&mut object, "udp-over-tcp", &query, "uot");
    Some(Value::Object(object))
}

fn converter_parse_vmess(line: &str) -> Option<Value> {
    let encoded = line.strip_prefix("vmess://")?;
    let decoded = decode_base64_text(encoded)?;
    let config = serde_json::from_str::<Value>(&decoded).ok()?;
    let server = config.get("add").and_then(Value::as_str)?.to_string();
    let port = config
        .get("port")
        .and_then(|value| {
            value
                .as_u64()
                .or_else(|| value.as_str().and_then(|text| text.parse::<u64>().ok()))
        })
        .unwrap_or(443);
    let name = config
        .get("ps")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(server.as_str());
    let network = config.get("net").and_then(Value::as_str).unwrap_or("tcp");
    let tls = config.get("tls").and_then(Value::as_str) == Some("tls");
    let mut object = Map::new();
    object.insert("name".to_string(), json!(name));
    object.insert("type".to_string(), json!("vmess"));
    object.insert("server".to_string(), json!(server));
    object.insert("port".to_string(), json!(port));
    object.insert(
        "uuid".to_string(),
        config.get("id").cloned().unwrap_or_else(|| json!("")),
    );
    object.insert(
        "alterId".to_string(),
        config.get("aid").cloned().unwrap_or_else(|| json!(0)),
    );
    object.insert(
        "cipher".to_string(),
        config.get("scy").cloned().unwrap_or_else(|| json!("auto")),
    );
    object.insert("network".to_string(), json!(network));
    if tls {
        object.insert("tls".to_string(), json!(true));
        if let Some(sni) = config
            .get("sni")
            .or_else(|| config.get("host"))
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
        {
            object.insert("servername".to_string(), json!(sni));
        }
    }
    if network == "ws" {
        let mut headers = Map::new();
        if let Some(host) = config.get("host").and_then(Value::as_str) {
            headers.insert("Host".to_string(), json!(host));
        }
        object.insert(
            "ws-opts".to_string(),
            json!({
                "path": config.get("path").and_then(Value::as_str).unwrap_or("/"),
                "headers": headers
            }),
        );
    } else if network == "grpc" {
        object.insert(
            "grpc-opts".to_string(),
            json!({ "grpc-service-name": config.get("path").and_then(Value::as_str).unwrap_or("") }),
        );
    }
    Some(Value::Object(object))
}

fn converter_parse_trojan(line: &str) -> Option<Value> {
    let (body, query, name) = converter_split_uri(line, "trojan://")?;
    let (password, server, port) = converter_split_user_host_port(&body)?;
    let mut object = Map::new();
    object.insert(
        "name".to_string(),
        json!(if name.is_empty() {
            format!("{server}:{port}")
        } else {
            name
        }),
    );
    object.insert("type".to_string(), json!("trojan"));
    object.insert("server".to_string(), json!(server));
    object.insert("port".to_string(), json!(port));
    object.insert("password".to_string(), json!(password));
    converter_insert_string(
        &mut object,
        "sni",
        query.get("sni").or_else(|| query.get("peer")),
    );
    converter_insert_string(&mut object, "network", query.get("type"));
    converter_insert_bool_param(&mut object, "skip-cert-verify", &query, "allowInsecure");
    converter_insert_bool_param(&mut object, "skip-cert-verify", &query, "insecure");
    if query.get("type").map(String::as_str) == Some("ws") {
        object.insert(
            "ws-opts".to_string(),
            json!({
                "path": query.get("path").map(String::as_str).unwrap_or("/"),
                "headers": { "Host": query.get("host").map(String::as_str).unwrap_or("") }
            }),
        );
    }
    Some(Value::Object(object))
}

fn converter_parse_vless(line: &str) -> Option<Value> {
    let (body, query, name) = converter_split_uri(line, "vless://")?;
    let (uuid, server, port) = converter_split_user_host_port(&body)?;
    let network = query.get("type").map(String::as_str).unwrap_or("tcp");
    let tls = matches!(
        query.get("security").map(|value| value.as_str()),
        Some("tls") | Some("reality")
    );
    let mut object = Map::new();
    object.insert(
        "name".to_string(),
        json!(if name.is_empty() {
            format!("{server}:{port}")
        } else {
            name
        }),
    );
    object.insert("type".to_string(), json!("vless"));
    object.insert("server".to_string(), json!(server));
    object.insert("port".to_string(), json!(port));
    object.insert("uuid".to_string(), json!(uuid));
    object.insert("network".to_string(), json!(network));
    if tls {
        object.insert("tls".to_string(), json!(true));
    }
    converter_insert_string(&mut object, "servername", query.get("sni"));
    converter_insert_string(&mut object, "flow", query.get("flow"));
    converter_insert_string(&mut object, "client-fingerprint", query.get("fp"));
    if let Some(short_id) = query.get("sid").filter(|value| !value.trim().is_empty()) {
        object.insert("reality-opts".to_string(), json!({ "short-id": short_id }));
    }
    converter_insert_bool_param(&mut object, "skip-cert-verify", &query, "allowInsecure");
    if network == "ws" {
        object.insert(
            "ws-opts".to_string(),
            json!({
                "path": query.get("path").map(String::as_str).unwrap_or("/"),
                "headers": { "Host": query.get("host").map(String::as_str).unwrap_or("") }
            }),
        );
    } else if network == "grpc" {
        object.insert(
            "grpc-opts".to_string(),
            json!({ "grpc-service-name": query.get("serviceName").map(String::as_str).unwrap_or("") }),
        );
    }
    Some(Value::Object(object))
}

fn converter_parse_hysteria2(line: &str) -> Option<Value> {
    let scheme = if line.starts_with("hysteria2://") {
        "hysteria2://"
    } else {
        "hy2://"
    };
    let (body, query, name) = converter_split_uri(line, scheme)?;
    let (password, server, port) = converter_split_user_host_port(&body)?;
    let mut object = Map::new();
    object.insert(
        "name".to_string(),
        json!(if name.is_empty() {
            format!("{server}:{port}")
        } else {
            name
        }),
    );
    object.insert("type".to_string(), json!("hysteria2"));
    object.insert("server".to_string(), json!(server));
    object.insert("port".to_string(), json!(port));
    object.insert("password".to_string(), json!(password));
    converter_insert_string(&mut object, "sni", query.get("sni"));
    converter_insert_bool_param(&mut object, "skip-cert-verify", &query, "insecure");
    Some(Value::Object(object))
}

fn converter_parse_tuic(line: &str) -> Option<Value> {
    let (body, query, name) = converter_split_uri(line, "tuic://")?;
    let (user, server, port) = converter_split_user_host_port(&body)?;
    let (uuid, password) = user.split_once(':')?;
    let mut object = Map::new();
    object.insert(
        "name".to_string(),
        json!(if name.is_empty() {
            format!("{server}:{port}")
        } else {
            name
        }),
    );
    object.insert("type".to_string(), json!("tuic"));
    object.insert("server".to_string(), json!(server));
    object.insert("port".to_string(), json!(port));
    object.insert("uuid".to_string(), json!(uuid));
    object.insert("password".to_string(), json!(password));
    converter_insert_string(&mut object, "sni", query.get("sni"));
    converter_insert_string(
        &mut object,
        "congestion-controller",
        query
            .get("congestion_control")
            .or_else(|| query.get("congestion-controller")),
    );
    converter_insert_bool_param(&mut object, "skip-cert-verify", &query, "allowInsecure");
    Some(Value::Object(object))
}

fn converter_proxy_from_line(line: &str) -> Option<Value> {
    let line = line.trim();
    if line.starts_with("ss://") {
        converter_parse_ss(line)
    } else if line.starts_with("vmess://") {
        converter_parse_vmess(line)
    } else if line.starts_with("trojan://") {
        converter_parse_trojan(line)
    } else if line.starts_with("vless://") {
        converter_parse_vless(line)
    } else if line.starts_with("hysteria2://") || line.starts_with("hy2://") {
        converter_parse_hysteria2(line)
    } else if line.starts_with("tuic://") {
        converter_parse_tuic(line)
    } else {
        None
    }
}

fn converter_yaml_proxies(input: &str) -> Option<Vec<Value>> {
    let yaml = serde_yaml::from_str::<serde_yaml::Value>(input).ok()?;
    let sequence = yaml
        .get("proxies")
        .and_then(serde_yaml::Value::as_sequence)
        .or_else(|| yaml.as_sequence())?;
    Some(
        sequence
            .iter()
            .filter_map(|item| serde_json::to_value(item).ok())
            .collect(),
    )
}

fn converter_parse_proxies(input: &str) -> Vec<Value> {
    let decoded = converter_source_text(input);
    if let Some(proxies) = converter_yaml_proxies(&decoded).filter(|items| !items.is_empty()) {
        return proxies;
    }

    decoded
        .lines()
        .filter_map(converter_proxy_from_line)
        .collect()
}

fn converter_apply_options(proxies: &mut [Value], options: Option<&Value>) {
    let Some(options) = options else {
        return;
    };
    let enable_udp = options
        .get("enableUdp")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let enable_tfo = options
        .get("enableTcpFastOpen")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let skip_cert = options
        .get("skipCertificateVerify")
        .or_else(|| options.get("skipCertVerify"))
        .and_then(Value::as_bool)
        .unwrap_or(false);

    for proxy in proxies {
        let Some(object) = proxy.as_object_mut() else {
            continue;
        };
        object.insert("udp".to_string(), json!(enable_udp));
        if enable_tfo {
            object.insert("tfo".to_string(), json!(true));
        }
        if skip_cert {
            object.insert("skip-cert-verify".to_string(), json!(true));
        }
    }
}

fn converter_filter_proxies(
    proxies: Vec<Value>,
    filter_regex: Option<&str>,
) -> Result<Vec<Value>, String> {
    let Some(filter) = filter_regex
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(proxies);
    };
    let regex = regex::RegexBuilder::new(filter)
        .case_insensitive(true)
        .build()
        .map_err(|err| err.to_string())?;
    Ok(proxies
        .into_iter()
        .filter(|proxy| {
            proxy
                .get("name")
                .and_then(Value::as_str)
                .map(|name| regex.is_match(name))
                .unwrap_or(false)
        })
        .collect())
}

fn converter_unique_names(proxies: &mut [Value]) {
    let mut counts = HashMap::<String, usize>::new();
    for proxy in proxies {
        let Some(object) = proxy.as_object_mut() else {
            continue;
        };
        let name = object
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("Proxy")
            .to_string();
        let count = counts.entry(name.clone()).or_insert(0);
        *count += 1;
        if *count > 1 {
            object.insert("name".to_string(), json!(format!("{name} {}", count)));
        } else if name.trim().is_empty() {
            object.insert("name".to_string(), json!("Proxy"));
        }
    }
}

fn converter_mihomo_yaml(proxies: &[Value]) -> Result<String, String> {
    let names = proxies
        .iter()
        .filter_map(|proxy| proxy.get("name").and_then(Value::as_str))
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    let mut select_names = vec!["Auto".to_string(), "DIRECT".to_string()];
    select_names.extend(names.clone());
    let config = json!({
        "mixed-port": 7890,
        "allow-lan": false,
        "mode": "rule",
        "log-level": "info",
        "external-controller": "127.0.0.1:9090",
        "dns": {
            "enable": true,
            "enhanced-mode": "fake-ip",
            "fake-ip-range": "198.18.0.1/16",
            "nameserver": ["https://doh.pub/dns-query", "https://dns.alidns.com/dns-query"]
        },
        "proxies": proxies,
        "proxy-groups": [
            {
                "name": "Proxy",
                "type": "select",
                "proxies": select_names
            },
            {
                "name": "Auto",
                "type": "url-test",
                "proxies": names,
                "url": "http://www.gstatic.com/generate_204",
                "interval": 300
            }
        ],
        "rules": ["MATCH,Proxy"]
    });
    serde_yaml::to_string(&config).map_err(|err| err.to_string())
}

fn proxy_str<'a>(proxy: &'a Value, key: &str) -> Option<&'a str> {
    proxy.get(key).and_then(Value::as_str)
}

fn proxy_u64(proxy: &Value, key: &str) -> Option<u64> {
    proxy
        .get(key)
        .and_then(|value| value.as_u64().or_else(|| value.as_str()?.parse().ok()))
}

fn proxy_bool(proxy: &Value, key: &str) -> bool {
    proxy.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn sing_box_tls(proxy: &Value, default_enabled: bool) -> Option<Value> {
    let enabled = proxy_bool(proxy, "tls") || default_enabled;
    if !enabled {
        return None;
    }

    let mut tls = Map::new();
    tls.insert("enabled".to_string(), json!(true));
    if let Some(server_name) = proxy_str(proxy, "servername").or_else(|| proxy_str(proxy, "sni")) {
        if !server_name.trim().is_empty() {
            tls.insert("server_name".to_string(), json!(server_name));
        }
    }
    if proxy_bool(proxy, "skip-cert-verify") {
        tls.insert("insecure".to_string(), json!(true));
    }
    if let Some(fingerprint) = proxy_str(proxy, "client-fingerprint") {
        tls.insert(
            "utls".to_string(),
            json!({ "enabled": true, "fingerprint": fingerprint }),
        );
    }
    Some(Value::Object(tls))
}

fn sing_box_transport(proxy: &Value) -> Option<Value> {
    match proxy_str(proxy, "network") {
        Some("ws") => {
            let ws_opts = proxy.get("ws-opts").and_then(Value::as_object);
            let path = ws_opts
                .and_then(|opts| opts.get("path"))
                .and_then(Value::as_str)
                .unwrap_or("/");
            let headers = ws_opts
                .and_then(|opts| opts.get("headers"))
                .cloned()
                .unwrap_or_else(|| json!({}));
            Some(json!({
                "type": "ws",
                "path": path,
                "headers": headers
            }))
        }
        Some("grpc") => {
            let service_name = proxy
                .get("grpc-opts")
                .and_then(Value::as_object)
                .and_then(|opts| opts.get("grpc-service-name"))
                .and_then(Value::as_str)
                .unwrap_or("");
            Some(json!({
                "type": "grpc",
                "service_name": service_name
            }))
        }
        _ => None,
    }
}

fn sing_box_outbound(proxy: &Value) -> Option<Value> {
    let name = proxy_str(proxy, "name")?;
    let server = proxy_str(proxy, "server")?;
    let port = proxy_u64(proxy, "port")?;
    let proxy_type = proxy_str(proxy, "type")?;

    let mut object = Map::new();
    object.insert("tag".to_string(), json!(name));
    object.insert("server".to_string(), json!(server));
    object.insert("server_port".to_string(), json!(port));

    match proxy_type {
        "ss" => {
            object.insert("type".to_string(), json!("shadowsocks"));
            object.insert(
                "method".to_string(),
                json!(proxy_str(proxy, "cipher").unwrap_or("aes-128-gcm")),
            );
            object.insert(
                "password".to_string(),
                json!(proxy_str(proxy, "password").unwrap_or("")),
            );
        }
        "vmess" => {
            object.insert("type".to_string(), json!("vmess"));
            object.insert(
                "uuid".to_string(),
                json!(proxy_str(proxy, "uuid").unwrap_or("")),
            );
            object.insert(
                "security".to_string(),
                json!(proxy_str(proxy, "cipher").unwrap_or("auto")),
            );
            if let Some(alter_id) =
                proxy_u64(proxy, "alterId").or_else(|| proxy_u64(proxy, "alter-id"))
            {
                object.insert("alter_id".to_string(), json!(alter_id));
            }
            if let Some(tls) = sing_box_tls(proxy, false) {
                object.insert("tls".to_string(), tls);
            }
            if let Some(transport) = sing_box_transport(proxy) {
                object.insert("transport".to_string(), transport);
            }
        }
        "trojan" => {
            object.insert("type".to_string(), json!("trojan"));
            object.insert(
                "password".to_string(),
                json!(proxy_str(proxy, "password").unwrap_or("")),
            );
            if let Some(tls) = sing_box_tls(proxy, true) {
                object.insert("tls".to_string(), tls);
            }
            if let Some(transport) = sing_box_transport(proxy) {
                object.insert("transport".to_string(), transport);
            }
        }
        "vless" => {
            object.insert("type".to_string(), json!("vless"));
            object.insert(
                "uuid".to_string(),
                json!(proxy_str(proxy, "uuid").unwrap_or("")),
            );
            if let Some(flow) = proxy_str(proxy, "flow") {
                object.insert("flow".to_string(), json!(flow));
            }
            if let Some(tls) = sing_box_tls(proxy, false) {
                object.insert("tls".to_string(), tls);
            }
            if let Some(transport) = sing_box_transport(proxy) {
                object.insert("transport".to_string(), transport);
            }
        }
        "hysteria2" => {
            object.insert("type".to_string(), json!("hysteria2"));
            object.insert(
                "password".to_string(),
                json!(proxy_str(proxy, "password").unwrap_or("")),
            );
            if let Some(tls) = sing_box_tls(proxy, true) {
                object.insert("tls".to_string(), tls);
            }
        }
        "tuic" => {
            object.insert("type".to_string(), json!("tuic"));
            object.insert(
                "uuid".to_string(),
                json!(proxy_str(proxy, "uuid").unwrap_or("")),
            );
            object.insert(
                "password".to_string(),
                json!(proxy_str(proxy, "password").unwrap_or("")),
            );
            if let Some(congestion) = proxy_str(proxy, "congestion-controller") {
                object.insert("congestion_control".to_string(), json!(congestion));
            }
            if let Some(tls) = sing_box_tls(proxy, true) {
                object.insert("tls".to_string(), tls);
            }
        }
        _ => return None,
    }

    Some(Value::Object(object))
}

fn converter_sing_box_json(proxies: &[Value]) -> Result<String, String> {
    let outbounds = proxies
        .iter()
        .filter_map(sing_box_outbound)
        .collect::<Vec<_>>();
    if outbounds.is_empty() {
        return Err("没有可转换为 sing-box 的代理节点".to_string());
    }

    let names = outbounds
        .iter()
        .filter_map(|outbound| outbound.get("tag").and_then(Value::as_str))
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    let mut selector = vec!["auto".to_string(), "direct".to_string()];
    selector.extend(names.clone());

    let mut all_outbounds = vec![
        json!({
            "type": "selector",
            "tag": "proxy",
            "outbounds": selector,
            "default": "auto"
        }),
        json!({
            "type": "urltest",
            "tag": "auto",
            "outbounds": names,
            "url": "https://www.gstatic.com/generate_204",
            "interval": "5m"
        }),
        json!({ "type": "direct", "tag": "direct" }),
        json!({ "type": "block", "tag": "block" }),
    ];
    all_outbounds.extend(outbounds);

    let config = json!({
        "log": { "level": "info" },
        "dns": {
            "servers": [
                { "tag": "dns_proxy", "address": "https://dns.google/dns-query", "detour": "proxy" },
                { "tag": "dns_direct", "address": "223.5.5.5", "detour": "direct" }
            ],
            "final": "dns_proxy"
        },
        "inbounds": [
            {
                "type": "mixed",
                "tag": "mixed-in",
                "listen": "127.0.0.1",
                "listen_port": 7890
            }
        ],
        "outbounds": all_outbounds,
        "route": {
            "rules": [
                { "protocol": "dns", "outbound": "dns_proxy" }
            ],
            "final": "proxy",
            "auto_detect_interface": true
        }
    });

    serde_json::to_string_pretty(&config).map_err(|err| err.to_string())
}

fn converter_ws_path(proxy: &Value) -> Option<&str> {
    proxy
        .get("ws-opts")
        .and_then(Value::as_object)
        .and_then(|opts| opts.get("path"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
}

fn converter_ws_host(proxy: &Value) -> Option<&str> {
    proxy
        .get("ws-opts")
        .and_then(Value::as_object)
        .and_then(|opts| opts.get("headers"))
        .and_then(Value::as_object)
        .and_then(|headers| headers.get("Host").or_else(|| headers.get("host")))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
}

fn converter_sni(proxy: &Value) -> Option<&str> {
    proxy_str(proxy, "sni")
        .or_else(|| proxy_str(proxy, "servername"))
        .filter(|value| !value.trim().is_empty())
}

fn converter_join_query(pairs: Vec<(&str, String)>) -> String {
    pairs
        .into_iter()
        .filter(|(_, value)| !value.trim().is_empty())
        .map(|(key, value)| {
            format!(
                "{}={}",
                urlencoding::encode(key),
                urlencoding::encode(&value)
            )
        })
        .collect::<Vec<_>>()
        .join("&")
}

fn converter_surge_line(proxy: &Value) -> Option<String> {
    let name = proxy_str(proxy, "name")?;
    let server = proxy_str(proxy, "server")?;
    let port = proxy_u64(proxy, "port")?;
    let proxy_type = proxy_str(proxy, "type")?;
    let mut parts = Vec::<String>::new();

    match proxy_type {
        "ss" => {
            parts.push(format!("{name} = ss"));
            parts.push(server.to_string());
            parts.push(port.to_string());
            parts.push(format!(
                "encrypt-method={}",
                proxy_str(proxy, "cipher").unwrap_or("aes-128-gcm")
            ));
            parts.push(format!(
                "password={}",
                proxy_str(proxy, "password").unwrap_or("")
            ));
        }
        "vmess" => {
            parts.push(format!("{name} = vmess"));
            parts.push(server.to_string());
            parts.push(port.to_string());
            parts.push(format!(
                "username={}",
                proxy_str(proxy, "uuid").unwrap_or("")
            ));
            if proxy_bool(proxy, "tls") {
                parts.push("tls=true".to_string());
            }
            if let Some(sni) = converter_sni(proxy) {
                parts.push(format!("sni={sni}"));
            }
            if proxy_str(proxy, "network") == Some("ws") {
                parts.push("ws=true".to_string());
                if let Some(path) = converter_ws_path(proxy) {
                    parts.push(format!("ws-path={path}"));
                }
                if let Some(host) = converter_ws_host(proxy) {
                    parts.push(format!("ws-headers=Host:{host}"));
                }
            }
        }
        "trojan" => {
            parts.push(format!("{name} = trojan"));
            parts.push(server.to_string());
            parts.push(port.to_string());
            parts.push(format!(
                "password={}",
                proxy_str(proxy, "password").unwrap_or("")
            ));
            if let Some(sni) = converter_sni(proxy) {
                parts.push(format!("sni={sni}"));
            }
            if proxy_str(proxy, "network") == Some("ws") {
                parts.push("ws=true".to_string());
                if let Some(path) = converter_ws_path(proxy) {
                    parts.push(format!("ws-path={path}"));
                }
                if let Some(host) = converter_ws_host(proxy) {
                    parts.push(format!("ws-headers=Host:{host}"));
                }
            }
        }
        "http" | "socks5" => {
            parts.push(format!("{name} = {proxy_type}"));
            parts.push(server.to_string());
            parts.push(port.to_string());
            if let Some(username) = proxy_str(proxy, "username") {
                parts.push(format!("username={username}"));
            }
            if let Some(password) = proxy_str(proxy, "password") {
                parts.push(format!("password={password}"));
            }
        }
        "hysteria2" => {
            parts.push(format!("{name} = hysteria2"));
            parts.push(server.to_string());
            parts.push(port.to_string());
            parts.push(format!(
                "password=\"{}\"",
                proxy_str(proxy, "password").unwrap_or("")
            ));
            if let Some(sni) = converter_sni(proxy) {
                parts.push(format!("sni={sni}"));
            }
        }
        "tuic" => {
            parts.push(format!("{name} = tuic-v5"));
            parts.push(server.to_string());
            parts.push(port.to_string());
            if let Some(uuid) = proxy_str(proxy, "uuid") {
                parts.push(format!("uuid={uuid}"));
            }
            if let Some(password) = proxy_str(proxy, "password") {
                parts.push(format!("password=\"{password}\""));
            }
            if let Some(sni) = converter_sni(proxy) {
                parts.push(format!("sni={sni}"));
            }
        }
        _ => return None,
    }

    if proxy_bool(proxy, "udp") {
        parts.push("udp-relay=true".to_string());
    }
    if proxy_bool(proxy, "skip-cert-verify") {
        parts.push("skip-cert-verify=true".to_string());
    }

    Some(parts.join(", "))
}

fn converter_surge_config(proxies: &[Value]) -> Result<String, String> {
    let converted = proxies
        .iter()
        .filter_map(|proxy| {
            let line = converter_surge_line(proxy)?;
            let name = proxy_str(proxy, "name")?.to_string();
            Some((name, line))
        })
        .collect::<Vec<_>>();
    if converted.is_empty() {
        return Err("没有可转换为 Surge 的代理节点".to_string());
    }

    let names = converted
        .iter()
        .map(|(name, _)| name.clone())
        .collect::<Vec<_>>();
    let proxy_lines = converted
        .iter()
        .map(|(_, line)| line.clone())
        .collect::<Vec<_>>();
    let mut select = vec!["Auto".to_string(), "DIRECT".to_string()];
    select.extend(names.clone());

    Ok(vec![
        "[General]".to_string(),
        "loglevel = notify".to_string(),
        "dns-server = 223.5.5.5, 119.29.29.29, 8.8.8.8".to_string(),
        "skip-proxy = 127.0.0.1, 192.168.0.0/16, 10.0.0.0/8, 172.16.0.0/12, localhost, *.local"
            .to_string(),
        String::new(),
        "[Proxy]".to_string(),
        proxy_lines.join("\n"),
        String::new(),
        "[Proxy Group]".to_string(),
        format!("Proxy = select, {}", select.join(", ")),
        format!(
            "Auto = url-test, {}, url=http://www.gstatic.com/generate_204, interval=300",
            names.join(", ")
        ),
        String::new(),
        "[Rule]".to_string(),
        "FINAL,Proxy".to_string(),
    ]
    .join("\n"))
}

fn converter_quantumult_x_line(proxy: &Value) -> Option<String> {
    let name = proxy_str(proxy, "name")?;
    let server = proxy_str(proxy, "server")?;
    let port = proxy_u64(proxy, "port")?;
    let proxy_type = proxy_str(proxy, "type")?;

    let mut line = match proxy_type {
        "ss" => format!(
            "shadowsocks={server}:{port}, method={}, password={}",
            proxy_str(proxy, "cipher").unwrap_or("aes-128-gcm"),
            proxy_str(proxy, "password").unwrap_or("")
        ),
        "vmess" => {
            let mut line = format!(
                "vmess={server}:{port}, method=chacha20-poly1305, password={}",
                proxy_str(proxy, "uuid").unwrap_or("")
            );
            if proxy_bool(proxy, "tls") {
                line.push_str(", obfs=over-tls");
            }
            if let Some(path) = converter_ws_path(proxy) {
                line.push_str(&format!(", obfs-uri={path}"));
            }
            if let Some(host) = converter_ws_host(proxy) {
                line.push_str(&format!(", obfs-host={host}"));
            }
            line
        }
        "trojan" => {
            let mut line = format!(
                "trojan={server}:{port}, password={}, over-tls=true",
                proxy_str(proxy, "password").unwrap_or("")
            );
            if let Some(sni) = converter_sni(proxy) {
                line.push_str(&format!(", tls-host={sni}"));
            }
            line
        }
        "http" | "socks5" => {
            let mut line = format!("{proxy_type}={server}:{port}");
            if let Some(username) = proxy_str(proxy, "username") {
                line.push_str(&format!(", username={username}"));
            }
            if let Some(password) = proxy_str(proxy, "password") {
                line.push_str(&format!(", password={password}"));
            }
            line
        }
        "hysteria2" => {
            let mut line = format!(
                "hysteria2={server}:{port}, password={}",
                proxy_str(proxy, "password").unwrap_or("")
            );
            if let Some(sni) = converter_sni(proxy) {
                line.push_str(&format!(", sni={sni}"));
            }
            line
        }
        _ => return None,
    };

    if proxy_bool(proxy, "skip-cert-verify") {
        line.push_str(", tls-verification=false");
    }
    line.push_str(&format!(", tag={name}"));
    Some(line)
}

fn converter_quantumult_x_config(proxies: &[Value]) -> Result<String, String> {
    let converted = proxies
        .iter()
        .filter_map(|proxy| {
            let line = converter_quantumult_x_line(proxy)?;
            let name = proxy_str(proxy, "name")?.to_string();
            Some((name, line))
        })
        .collect::<Vec<_>>();
    if converted.is_empty() {
        return Err("没有可转换为 Quantumult X 的代理节点".to_string());
    }

    let names = converted
        .iter()
        .map(|(name, _)| name.clone())
        .collect::<Vec<_>>();
    let proxy_lines = converted
        .iter()
        .map(|(_, line)| line.clone())
        .collect::<Vec<_>>();
    let mut select = vec!["Auto".to_string(), "direct".to_string()];
    select.extend(names.clone());

    Ok(vec![
        "[general]".to_string(),
        "server_check_url=http://www.gstatic.com/generate_204".to_string(),
        "dns_exclusion_list=*.cmpassport.com, *.jegotrip.com.cn, *.icitymobile.mobi, id6.me".to_string(),
        String::new(),
        "[dns]".to_string(),
        "server=223.5.5.5".to_string(),
        "server=119.29.29.29".to_string(),
        "server=8.8.8.8".to_string(),
        String::new(),
        "[policy]".to_string(),
        format!("static=Proxy, {}", select.join(", ")),
        format!(
            "url-latency-benchmark=Auto, {}, check-interval=300, url=http://www.gstatic.com/generate_204",
            names.join(", ")
        ),
        String::new(),
        "[server_local]".to_string(),
        proxy_lines.join("\n"),
        String::new(),
        "[filter_local]".to_string(),
        "FINAL,Proxy".to_string(),
    ]
    .join("\n"))
}

fn converter_uri_query(proxy: &Value, include_network: bool) -> String {
    let mut pairs = Vec::<(&str, String)>::new();
    if let Some(sni) = converter_sni(proxy) {
        pairs.push(("sni", sni.to_string()));
    }
    if proxy_bool(proxy, "skip-cert-verify") {
        pairs.push(("allowInsecure", "1".to_string()));
    }
    if include_network {
        if let Some(network) = proxy_str(proxy, "network") {
            pairs.push(("type", network.to_string()));
            if network == "ws" {
                if let Some(path) = converter_ws_path(proxy) {
                    pairs.push(("path", path.to_string()));
                }
                if let Some(host) = converter_ws_host(proxy) {
                    pairs.push(("host", host.to_string()));
                }
            }
        }
    }
    converter_join_query(pairs)
}

fn converter_shadowrocket_uri(proxy: &Value) -> Option<String> {
    let name = urlencoding::encode(proxy_str(proxy, "name")?).into_owned();
    let server = proxy_str(proxy, "server")?;
    let port = proxy_u64(proxy, "port")?;
    let proxy_type = proxy_str(proxy, "type")?;

    match proxy_type {
        "ss" => {
            let user = format!(
                "{}:{}",
                proxy_str(proxy, "cipher").unwrap_or("aes-128-gcm"),
                proxy_str(proxy, "password").unwrap_or("")
            );
            let encoded = general_purpose::STANDARD.encode(user);
            Some(format!("ss://{encoded}@{server}:{port}#{name}"))
        }
        "vmess" => {
            let config = json!({
                "v": "2",
                "ps": proxy_str(proxy, "name").unwrap_or("Proxy"),
                "add": server,
                "port": port.to_string(),
                "id": proxy_str(proxy, "uuid").unwrap_or(""),
                "aid": proxy_u64(proxy, "alterId").or_else(|| proxy_u64(proxy, "alter-id")).unwrap_or(0).to_string(),
                "scy": proxy_str(proxy, "cipher").unwrap_or("auto"),
                "net": proxy_str(proxy, "network").unwrap_or("tcp"),
                "type": "none",
                "tls": if proxy_bool(proxy, "tls") { "tls" } else { "" },
                "sni": converter_sni(proxy).unwrap_or("")
            });
            let encoded = general_purpose::STANDARD.encode(config.to_string());
            Some(format!("vmess://{encoded}"))
        }
        "trojan" => {
            let query = converter_uri_query(proxy, true);
            let password = urlencoding::encode(proxy_str(proxy, "password").unwrap_or(""));
            Some(if query.is_empty() {
                format!("trojan://{password}@{server}:{port}#{name}")
            } else {
                format!("trojan://{password}@{server}:{port}?{query}#{name}")
            })
        }
        "vless" => {
            let mut pairs = Vec::<(&str, String)>::new();
            pairs.push((
                "security",
                if proxy_bool(proxy, "tls") {
                    "tls"
                } else {
                    "none"
                }
                .to_string(),
            ));
            if let Some(flow) = proxy_str(proxy, "flow") {
                pairs.push(("flow", flow.to_string()));
            }
            let extra = converter_uri_query(proxy, true);
            let mut query = converter_join_query(pairs);
            if !extra.is_empty() {
                if !query.is_empty() {
                    query.push('&');
                }
                query.push_str(&extra);
            }
            Some(format!(
                "vless://{}@{server}:{port}?{query}#{name}",
                urlencoding::encode(proxy_str(proxy, "uuid").unwrap_or(""))
            ))
        }
        "hysteria2" => {
            let mut pairs = Vec::<(&str, String)>::new();
            if let Some(sni) = converter_sni(proxy) {
                pairs.push(("sni", sni.to_string()));
            }
            if proxy_bool(proxy, "skip-cert-verify") {
                pairs.push(("insecure", "1".to_string()));
            }
            let query = converter_join_query(pairs);
            let password = urlencoding::encode(proxy_str(proxy, "password").unwrap_or(""));
            Some(if query.is_empty() {
                format!("hysteria2://{password}@{server}:{port}#{name}")
            } else {
                format!("hysteria2://{password}@{server}:{port}?{query}#{name}")
            })
        }
        "tuic" => {
            let mut pairs = Vec::<(&str, String)>::new();
            if let Some(sni) = converter_sni(proxy) {
                pairs.push(("sni", sni.to_string()));
            }
            if let Some(congestion) = proxy_str(proxy, "congestion-controller") {
                pairs.push(("congestion_control", congestion.to_string()));
            }
            if proxy_bool(proxy, "skip-cert-verify") {
                pairs.push(("insecure", "1".to_string()));
            }
            let query = converter_join_query(pairs);
            let uuid = urlencoding::encode(proxy_str(proxy, "uuid").unwrap_or(""));
            let password = urlencoding::encode(proxy_str(proxy, "password").unwrap_or(""));
            Some(if query.is_empty() {
                format!("tuic://{uuid}:{password}@{server}:{port}#{name}")
            } else {
                format!("tuic://{uuid}:{password}@{server}:{port}?{query}#{name}")
            })
        }
        "socks5" | "http" => {
            let scheme = if proxy_type == "socks5" {
                "socks5"
            } else if proxy_bool(proxy, "tls") {
                "https"
            } else {
                "http"
            };
            let auth = match (proxy_str(proxy, "username"), proxy_str(proxy, "password")) {
                (Some(username), Some(password)) => format!(
                    "{}:{}@",
                    urlencoding::encode(username),
                    urlencoding::encode(password)
                ),
                _ => String::new(),
            };
            Some(format!("{scheme}://{auth}{server}:{port}#{name}"))
        }
        _ => None,
    }
}

fn converter_shadowrocket_config(proxies: &[Value]) -> Result<String, String> {
    let converted = proxies
        .iter()
        .filter_map(|proxy| {
            let line = converter_shadowrocket_uri(proxy)?;
            let name = proxy_str(proxy, "name")?.to_string();
            Some((name, line))
        })
        .collect::<Vec<_>>();
    if converted.is_empty() {
        return Err("没有可转换为 Shadowrocket 的代理节点".to_string());
    }

    let names = converted
        .iter()
        .map(|(name, _)| name.clone())
        .collect::<Vec<_>>();
    let proxy_lines = converted
        .iter()
        .map(|(_, line)| line.clone())
        .collect::<Vec<_>>();
    let mut select = vec!["Auto".to_string(), "DIRECT".to_string()];
    select.extend(names.clone());

    Ok(vec![
        "[General]".to_string(),
        "bypass-system = true".to_string(),
        "skip-proxy = 192.168.0.0/16, 10.0.0.0/8, 172.16.0.0/12, localhost, *.local, captive.apple.com".to_string(),
        "dns-server = 223.5.5.5, 119.29.29.29, 8.8.8.8".to_string(),
        String::new(),
        "[Proxy]".to_string(),
        proxy_lines.join("\n"),
        String::new(),
        "[Proxy Group]".to_string(),
        format!("Proxy = select, {}", select.join(", ")),
        format!(
            "Auto = url-test, {}, url=http://www.gstatic.com/generate_204, interval=300",
            names.join(", ")
        ),
        String::new(),
        "[Rule]".to_string(),
        "FINAL,Proxy".to_string(),
    ]
    .join("\n"))
}

fn converter_conversion_payload(
    input: &str,
    target_format: Option<&str>,
    filter_regex: Option<&str>,
    options: Option<&Value>,
    template_id: Option<&str>,
) -> Value {
    let target = target_format.unwrap_or("clash-meta");
    if !matches!(
        target,
        "clash" | "clash-meta" | "sing-box" | "surge" | "quantumult-x" | "shadowrocket"
    ) {
        return json!({
            "success": false,
            "output": "",
            "inputProxyCount": 0,
            "outputProxyCount": 0,
            "errorMessage": format!("Tauri 暂不支持转换为 {target}")
        });
    }

    let template = template_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|id| {
            converter_templates()
                .as_array()
                .and_then(|templates| {
                    templates
                        .iter()
                        .find(|template| template.get("id").and_then(Value::as_str) == Some(id))
                })
                .cloned()
                .ok_or_else(|| format!("模板不存在: {id}"))
        })
        .transpose();
    let template = match template {
        Ok(template) => template,
        Err(error) => {
            return json!({
                "success": false,
                "output": "",
                "inputProxyCount": 0,
                "outputProxyCount": 0,
                "errorMessage": error
            })
        }
    };

    let input_proxies = converter_parse_proxies(input);
    let input_count = input_proxies.len();
    let mut proxies = match converter_filter_proxies(input_proxies, filter_regex) {
        Ok(proxies) => proxies,
        Err(error) => {
            return json!({
                "success": false,
                "output": "",
                "inputProxyCount": input_count,
                "outputProxyCount": 0,
                "errorMessage": error
            })
        }
    };
    converter_unique_names(&mut proxies);
    converter_apply_options(&mut proxies, options);

    if proxies.is_empty() {
        return json!({
            "success": false,
            "output": "",
            "inputProxyCount": input_count,
            "outputProxyCount": 0,
            "errorMessage": "未检测到有效的代理节点"
        });
    }

    let generated = match target {
        "sing-box" => converter_sing_box_json(&proxies),
        "surge" => converter_surge_config(&proxies),
        "quantumult-x" => converter_quantumult_x_config(&proxies),
        "shadowrocket" => converter_shadowrocket_config(&proxies),
        _ => converter_mihomo_yaml(&proxies),
    };

    match generated {
        Ok(output) => success(json!({
            "output": output,
            "content": output,
            "result": output,
            "inputProxyCount": input_count,
            "outputProxyCount": proxies.len(),
            "errorMessage": Value::Null,
            "templateId": template
                .as_ref()
                .and_then(|template| template.get("id"))
                .cloned()
                .unwrap_or(Value::Null),
            "templateName": template
                .as_ref()
                .and_then(|template| template.get("name"))
                .cloned()
                .unwrap_or(Value::Null),
            "proxies": proxies
        })),
        Err(error) => json!({
            "success": false,
            "output": "",
            "inputProxyCount": input_count,
            "outputProxyCount": 0,
            "errorMessage": error
        }),
    }
}

fn converter_settings(app: &AppHandle) -> Result<Value, String> {
    Ok(setting(
        app,
        "converterSettings",
        json!({
            "port": 59999,
            "autoStart": false,
            "userAgent": "FlyClash-Converter/1.0"
        }),
    )?)
}

fn converter_port(app: &AppHandle) -> Result<u16, String> {
    Ok(converter_settings(app)?
        .get("port")
        .and_then(Value::as_u64)
        .filter(|port| (1..=65535).contains(port))
        .unwrap_or(59999) as u16)
}

fn converter_subscription_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app_data_dir(app)?.join("converter-subscriptions");
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    Ok(dir)
}

fn converter_subscription_file(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    Ok(converter_subscription_dir(app)?.join(format!("{}.json", sanitize_file_name(id))))
}

fn converter_public_url(port: u16, id: &str) -> String {
    format!("http://127.0.0.1:{port}/sub/{id}")
}

fn converter_content_type(target_format: &str) -> &'static str {
    match target_format {
        "sing-box" => "application/json; charset=utf-8",
        "clash" | "clash-meta" | "mihomo" => "application/yaml; charset=utf-8",
        _ => "text/plain; charset=utf-8",
    }
}

fn converter_file_extension(target_format: &str) -> &'static str {
    match target_format {
        "sing-box" => "json",
        "clash" | "clash-meta" | "mihomo" => "yaml",
        _ => "txt",
    }
}

fn converter_read_subscription(path: &Path) -> Option<Value> {
    fs::read_to_string(path)
        .ok()
        .and_then(|content| serde_json::from_str::<Value>(&content).ok())
}

fn converter_subscription_count(app: &AppHandle) -> usize {
    converter_subscription_dir(app)
        .ok()
        .and_then(|dir| fs::read_dir(dir).ok())
        .map(|entries| {
            entries
                .filter_map(|entry| entry.ok())
                .filter(|entry| {
                    entry.path().extension().and_then(|value| value.to_str()) == Some("json")
                })
                .count()
        })
        .unwrap_or(0)
}

fn converter_list_from_dir(dir: &Path, port: u16) -> Vec<Value> {
    fs::read_dir(dir)
        .ok()
        .into_iter()
        .flat_map(|entries| entries.filter_map(|entry| entry.ok()))
        .filter_map(|entry| converter_read_subscription(&entry.path()))
        .filter_map(|record| {
            let id = record.get("id").and_then(Value::as_str)?.to_string();
            Some(json!({
                "id": id,
                "name": record.get("name").and_then(Value::as_str).unwrap_or("Converted"),
                "targetFormat": record.get("targetFormat").and_then(Value::as_str).unwrap_or("clash-meta"),
                "lastUpdate": record.get("lastUpdate").and_then(Value::as_u64).unwrap_or(0),
                "url": converter_public_url(port, &id)
            }))
        })
        .collect()
}

fn converter_http_response(
    stream: &mut TcpStream,
    status: &str,
    content_type: &str,
    body: &[u8],
    extra_headers: &[String],
) -> io::Result<()> {
    let mut headers = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-cache\r\nConnection: close\r\n",
        body.len()
    );
    for header in extra_headers {
        headers.push_str(header);
        headers.push_str("\r\n");
    }
    headers.push_str("\r\n");
    stream.write_all(headers.as_bytes())?;
    stream.write_all(body)
}

fn converter_handle_stream(mut stream: TcpStream, dir: &Path, port: u16) {
    let mut buffer = [0u8; 8192];
    let Ok(size) = stream.read(&mut buffer) else {
        return;
    };
    if size == 0 {
        return;
    }

    let request = String::from_utf8_lossy(&buffer[..size]);
    let path = request
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .unwrap_or("/");

    if path == "/list" {
        let body = serde_json::to_vec_pretty(&converter_list_from_dir(dir, port))
            .unwrap_or_else(|_| b"[]".to_vec());
        let _ = converter_http_response(
            &mut stream,
            "200 OK",
            "application/json; charset=utf-8",
            &body,
            &[],
        );
        return;
    }

    if let Some(id) = path.strip_prefix("/sub/").filter(|id| !id.is_empty()) {
        let file = dir.join(format!("{}.json", sanitize_file_name(id)));
        if let Some(record) = converter_read_subscription(&file) {
            let content = record
                .get("content")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .as_bytes()
                .to_vec();
            let target_format = record
                .get("targetFormat")
                .and_then(Value::as_str)
                .unwrap_or("clash-meta");
            let name = sanitize_file_name(
                record
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("subscription"),
            );
            let disposition = format!(
                "Content-Disposition: attachment; filename=\"{}.{}\"",
                name,
                converter_file_extension(target_format)
            );
            let _ = converter_http_response(
                &mut stream,
                "200 OK",
                converter_content_type(target_format),
                &content,
                &[disposition],
            );
            return;
        }

        let _ = converter_http_response(
            &mut stream,
            "404 Not Found",
            "text/plain; charset=utf-8",
            b"Subscription not found",
            &[],
        );
        return;
    }

    let _ = converter_http_response(
        &mut stream,
        "404 Not Found",
        "text/plain; charset=utf-8",
        b"Not Found",
        &[],
    );
}

fn converter_server_loop(listener: TcpListener, dir: PathBuf, port: u16, stop: mpsc::Receiver<()>) {
    loop {
        if stop.try_recv().is_ok() {
            break;
        }
        match listener.accept() {
            Ok((stream, _)) => converter_handle_stream(stream, &dir, port),
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(100));
            }
            Err(_) => break,
        }
    }
}

fn converter_stop_locked(runtime: &mut RuntimeState) {
    if let Some(mut handle) = runtime.converter_server.take() {
        let _ = handle.stop.send(());
        if let Some(thread) = handle.thread.take() {
            let _ = thread.join();
        }
    }
}

fn converter_start_server(app: &AppHandle, state: &State<'_, AppState>) -> CompatResult {
    let port = converter_port(app)?;
    let dir = converter_subscription_dir(app)?;
    let mut runtime = state.runtime.lock().map_err(|err| err.to_string())?;

    if runtime
        .converter_server
        .as_ref()
        .is_some_and(|handle| handle.port == port)
    {
        return Ok(success(json!({
            "isRunning": true,
            "running": true,
            "port": port,
            "subscriptionCount": converter_subscription_count(app)
        })));
    }

    converter_stop_locked(&mut runtime);

    let listener = TcpListener::bind(("0.0.0.0", port)).map_err(|err| err.to_string())?;
    listener
        .set_nonblocking(true)
        .map_err(|err| err.to_string())?;
    let (tx, rx) = mpsc::channel();
    let thread_dir = dir.clone();
    let thread = thread::spawn(move || converter_server_loop(listener, thread_dir, port, rx));

    runtime.converter_server = Some(ConverterServerHandle {
        port,
        stop: tx,
        thread: Some(thread),
    });

    Ok(success(json!({
        "isRunning": true,
        "running": true,
        "port": port,
        "subscriptionCount": converter_subscription_count(app)
    })))
}

fn converter_stop_server(app: &AppHandle, state: &State<'_, AppState>) -> CompatResult {
    let mut runtime = state.runtime.lock().map_err(|err| err.to_string())?;
    converter_stop_locked(&mut runtime);
    Ok(success(json!({
        "isRunning": false,
        "running": false,
        "port": converter_port(app)?,
        "subscriptionCount": converter_subscription_count(app)
    })))
}

fn converter_server_status(app: &AppHandle, state: &State<'_, AppState>) -> CompatResult {
    let runtime = state.runtime.lock().map_err(|err| err.to_string())?;
    let running = runtime.converter_server.is_some();
    let port = runtime
        .converter_server
        .as_ref()
        .map(|handle| handle.port)
        .unwrap_or(converter_port(app)?);
    Ok(success(json!({
        "isRunning": running,
        "running": running,
        "mode": "local",
        "port": port,
        "subscriptionCount": converter_subscription_count(app)
    })))
}

async fn converter_source_content(params: &Value) -> Result<String, String> {
    if let Some(content) = params
        .get("sourceContent")
        .or_else(|| params.get("content"))
        .or_else(|| params.get("input"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
    {
        return Ok(content.to_string());
    }

    if let Some(url) = params
        .get("sourceUrl")
        .or_else(|| params.get("url"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
    {
        return reqwest::Client::builder()
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
            .map_err(|err| err.to_string());
    }

    Ok(String::new())
}

async fn converter_create_subscription(
    app: &AppHandle,
    state: &State<'_, AppState>,
    params: Value,
) -> CompatResult {
    let _ = converter_start_server(app, state)?;
    let port = converter_port(app)?;
    let id = params
        .get("id")
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .unwrap_or_else(|| format!("sub_{}", now_millis()));
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("Converted")
        .to_string();
    let target_format = params
        .get("targetFormat")
        .and_then(Value::as_str)
        .unwrap_or("clash-meta")
        .to_string();
    let source = converter_source_content(&params).await?;
    let converted = converter_conversion_payload(
        &source,
        Some(&target_format),
        params.get("filterRegex").and_then(Value::as_str),
        params.get("options"),
        params.get("templateId").and_then(Value::as_str),
    );
    if !converted
        .get("success")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Ok(converted);
    }
    let output = converted
        .get("output")
        .and_then(Value::as_str)
        .unwrap_or(source.as_str())
        .to_string();
    let proxy_count = converted
        .get("outputProxyCount")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let record = json!({
        "id": id,
        "name": name,
        "sourceUrl": params.get("sourceUrl").cloned().unwrap_or(Value::Null),
        "targetFormat": target_format,
        "filterRegex": params.get("filterRegex").cloned().unwrap_or(Value::Null),
        "templateId": params.get("templateId").cloned().unwrap_or(Value::Null),
        "options": params.get("options").cloned().unwrap_or_else(|| json!({})),
        "lastUpdate": now_millis(),
        "proxyCount": proxy_count,
        "content": output
    });
    fs::write(
        converter_subscription_file(app, &id)?,
        serde_json::to_string_pretty(&record).map_err(|err| err.to_string())?,
    )
    .map_err(|err| err.to_string())?;

    Ok(success(json!({
        "id": id,
        "url": converter_public_url(port, &id),
        "port": port,
        "outputProxyCount": proxy_count
    })))
}

fn converter_local_id_from_url(url: &str) -> Option<String> {
    let marker = "/sub/";
    let index = url.find(marker)?;
    let id = &url[index + marker.len()..];
    let id = id.split(['?', '#']).next().unwrap_or_default().trim();
    (!id.is_empty()).then(|| id.to_string())
}

async fn converter_add_to_config(app: &AppHandle, params: Value) -> CompatResult {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("Converted")
        .to_string();
    let url = params
        .get("url")
        .and_then(Value::as_str)
        .map(ToString::to_string);

    let content = if let Some(content) = params.get("content").and_then(Value::as_str) {
        content.to_string()
    } else if let Some(id) = url.as_deref().and_then(converter_local_id_from_url) {
        let record = converter_read_subscription(&converter_subscription_file(app, &id)?)
            .ok_or_else(|| "订阅转换结果不存在".to_string())?;
        record
            .get("content")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    } else if let Some(url) = url.as_deref() {
        let settings = converter_settings(app)?;
        let user_agent = settings
            .get("userAgent")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("FlyClash-Converter/1.0");
        let response = reqwest::Client::builder()
            .danger_accept_invalid_certs(true)
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|err| err.to_string())?
            .get(url)
            .header(reqwest::header::USER_AGENT, user_agent)
            .send()
            .await
            .map_err(|err| err.to_string())?;
        let status = response.status();
        if !status.is_success() {
            return Ok(json!({
                "success": false,
                "error": format!("HTTP {}", status.as_u16()),
                "status": status.as_u16()
            }));
        }
        response.text().await.map_err(|err| err.to_string())?
    } else {
        String::new()
    };

    if content.trim().is_empty() {
        return Ok(json!({ "success": false, "error": "转换结果为空，无法添加到配置" }));
    }

    save_subscription(app, url, content, Some(name), None)
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
        "getPlatform" => Ok(Value::String(electron_platform().to_string())),
        "debugLog" => Ok(Value::Null),
        "loadPage" | "navigateTo" => {
            let target = arg_string(&args, 0).unwrap_or_default();
            window
                .emit("navigate-to", target.clone())
                .map_err(|err| err.to_string())?;
            Ok(success(json!({ "target": target })))
        }

        "coreGetCurrentConfig" | "core:get-current-config" => core_current_config(&app),
        "coreGetRuntimeState" | "core:get-runtime-state" => {
            let running = is_mihomo_running(&app);
            let preferred_config = read_last_config(&app).ok().flatten();
            let (core_state, runtime_active_config) = {
                let mut runtime = state.runtime.lock().expect("runtime mutex poisoned");
                let core_state = runtime.core.state();
                let runtime_active_config = runtime
                    .core
                    .runtime_active_config(running, preferred_config.clone());
                (core_state, runtime_active_config)
            };
            let mut payload = serde_json::to_value(&core_state).unwrap_or_else(|_| json!({}));
            if core_state.running_mode == RunningMode::Service {
                if let Ok(helper_status) = core_service::get_status() {
                    if let Some(object) = payload.as_object_mut() {
                        object.insert(
                            "coreRunning".to_string(),
                            Value::Bool(helper_status.running),
                        );
                        let pid_value = helper_status
                            .pid
                            .map(|pid| Value::Number(serde_json::Number::from(pid)))
                            .unwrap_or(Value::Null);
                        object.insert("pid".to_string(), pid_value.clone());
                        object.insert("corePid".to_string(), pid_value);
                    }
                }
            }
            if let Some(object) = payload.as_object_mut() {
                object.insert(
                    "preferredConfig".to_string(),
                    preferred_config
                        .clone()
                        .map(Value::String)
                        .unwrap_or(Value::Null),
                );
                object.insert(
                    "runtimeActiveConfig".to_string(),
                    runtime_active_config
                        .config
                        .clone()
                        .map(Value::String)
                        .unwrap_or(Value::Null),
                );
                object.insert(
                    "activeConfigSource".to_string(),
                    Value::String(runtime_active_config.source.as_str().to_string()),
                );
                object.insert(
                    "identity".to_string(),
                    serde_json::to_value(core_identity::product_identity())
                        .unwrap_or_else(|_| json!({})),
                );
                object.insert("resources".to_string(), core_resource_status(&app));
                if running {
                    if let Some(probe) = controller_probe_payload(&app).await.as_object() {
                        for (key, value) in probe {
                            object.insert(key.clone(), value.clone());
                        }
                    }
                } else {
                    object.insert("controllerAvailable".to_string(), Value::Bool(false));
                    object.insert("controllerError".to_string(), Value::Null);
                    object.insert("controllerStatus".to_string(), Value::Null);
                    object.insert("coreVersion".to_string(), Value::Null);
                    object.insert("coreMeta".to_string(), Value::Null);
                    object.insert("corePremium".to_string(), Value::Null);
                }
            }
            Ok(success(payload))
        }
        "coreGetInstalledCores" | "core:get-installed-cores" => core_installed(&app),
        "coreSwitchCore" | "core:switch-core" => {
            let core_type = arg_string(&args, 0).unwrap_or_else(|| "mihomo".to_string());
            let specific = arg_string(&args, 1)
                .map(|value| normalize_core_version(&value))
                .filter(|value| !value.is_empty());

            if core_type == "mihomo-specific" && specific.is_none() {
                return Ok(json!({
                    "success": false,
                    "error": "请先选择具体版本"
                }));
            }

            let path = core_path(&app, Some(&core_type), specific.as_deref())?;
            if !path.exists() {
                return Ok(json!({
                    "success": false,
                    "error": "内核文件不存在，请先下载"
                }));
            }

            emit_core_progress(
                &window,
                &core_type,
                specific.as_deref(),
                "switching",
                100.0,
                0,
                0,
            );
            set_setting(&app, "core_type", json!(core_type.clone()))?;
            set_setting(
                &app,
                "core_specific_version",
                specific.clone().map(Value::String).unwrap_or(Value::Null),
            )?;
            set_custom_kernel_path(&app, None)?;

            let runtime_restart = restart_active_config_after_core_switch(
                &app,
                &window,
                &state,
                &core_type,
                specific.as_deref(),
            )
            .await;
            let restart_skipped = runtime_restart
                .get("skipped")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let restart_failed = !restart_skipped
                && !runtime_restart
                    .get("restarted")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
            let restart_error = runtime_restart
                .get("error")
                .and_then(Value::as_str)
                .or_else(|| {
                    runtime_restart
                        .get("result")
                        .and_then(|result| result.get("error"))
                        .and_then(Value::as_str)
                });
            if restart_failed || restart_error.is_some() {
                let error = restart_error.unwrap_or("重启 Mihomo 失败");
                return Ok(json!({
                    "success": false,
                    "error": format!("内核已切换，但重启 Mihomo 失败: {error}"),
                    "runtimeRestart": runtime_restart
                }));
            }

            Ok(success(json!({ "runtimeRestart": runtime_restart })))
        }
        "coreSetCustomPath" | "core:set-custom-path" => {
            let path = arg_string(&args, 0)
                .map(|path| path.trim().to_string())
                .filter(|path| !path.is_empty());
            if let Some(path) = path.as_deref() {
                if !Path::new(path).exists() {
                    return Ok(json!({
                        "success": false,
                        "error": "内核文件不存在"
                    }));
                }
            }
            set_custom_kernel_path(&app, path.as_deref())?;
            Ok(success(json!({ "path": path })))
        }
        "coreDeleteCore" | "core:delete-core" => {
            let path = arg_string(&args, 0).unwrap_or_default();
            if path.trim().is_empty() {
                return Ok(json!({ "success": false, "error": "缺少内核路径" }));
            }

            let path = PathBuf::from(path.trim());
            if !path.exists() {
                return Ok(json!({ "success": false, "error": "内核文件不存在" }));
            }

            let managed_dir = fs::canonicalize(cores_dir(&app)?).map_err(|err| err.to_string())?;
            let target = fs::canonicalize(&path).map_err(|err| err.to_string())?;
            if !target.starts_with(&managed_dir) {
                return Ok(json!({
                    "success": false,
                    "error": "仅允许删除应用管理的内核目录内的文件"
                }));
            }

            if let Some(custom) = custom_kernel_path(&app)? {
                if same_existing_path(&path, Path::new(&custom)) {
                    return Ok(json!({
                        "success": false,
                        "error": "当前文件是自定义内核路径，请先取消自定义路径后再删除"
                    }));
                }
            }

            if same_existing_path(&path, &core_path(&app, None, None)?) {
                return Ok(json!({
                    "success": false,
                    "error": "不能删除当前选择的内核，请先切换到其他内核"
                }));
            }

            if is_mihomo_running(&app)
                && find_mihomo_executable(&app)
                    .map(|current| same_existing_path(&path, &current))
                    .unwrap_or(false)
            {
                return Ok(json!({
                    "success": false,
                    "error": "内核正在运行，停止后再删除"
                }));
            }

            fs::remove_file(&target).map_err(|err| err.to_string())?;
            Ok(success(
                json!({ "deleted": true, "path": target.to_string_lossy() }),
            ))
        }
        "coreClearVersionCache" | "core:clear-version-cache" => {
            let core_type = arg_string(&args, 0)
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty());
            let cleared = clear_version_cache(&state, core_type.as_deref());
            Ok(success(json!({ "cleared": cleared })))
        }
        "coreCheckUpdate" | "core:check-update" => {
            let core_type = arg_string(&args, 0).unwrap_or_else(|| "mihomo".to_string());
            let current_path = core_path(&app, Some(&core_type), None)?;
            let current_version = core_binary_version(&current_path);
            let release = latest_release(&core_type).await?;
            let latest_version = release
                .get("tag_name")
                .and_then(Value::as_str)
                .map(normalize_core_version)
                .filter(|value| !value.is_empty());
            let has_update = match (current_version.as_deref(), latest_version.as_deref()) {
                (Some(current), Some(latest)) => normalize_core_version(current) != latest,
                _ => true,
            };
            Ok(success(json!({
                "hasUpdate": has_update,
                "currentVersion": current_version,
                "latestVersion": latest_version,
                "releaseInfo": release
            })))
        }
        "coreGetAvailableVersions" | "core:get-available-versions" => {
            let core_type = arg_string(&args, 0).unwrap_or_else(|| "mihomo".to_string());
            let limit = args.get(1).and_then(Value::as_u64).unwrap_or(20) as usize;
            let force_refresh = args.get(2).and_then(Value::as_bool).unwrap_or(false);
            Ok(success(
                json!({ "versions": cached_release_versions(&state, &core_type, limit, force_refresh).await? }),
            ))
        }
        "coreDownloadCore" | "core:download-core" => {
            let core_type = arg_string(&args, 0).unwrap_or_else(|| "mihomo".to_string());
            let result = download_core(&app, &window, &core_type, None).await;
            if let Err(error) = &result {
                emit_core_error(&window, &core_type, None, error);
            } else {
                clear_version_cache(&state, Some(&core_type));
            }
            result
        }
        "coreDownloadSpecificVersion" | "core:download-specific-version" => {
            let core_type = arg_string(&args, 0).unwrap_or_else(|| "mihomo-specific".to_string());
            let version = arg_string(&args, 1);
            let result = download_core(&app, &window, &core_type, version.clone()).await;
            if let Err(error) = &result {
                emit_core_error(&window, &core_type, version.as_deref(), error);
            } else {
                clear_version_cache(&state, Some(&core_type));
            }
            result
        }

        "getTheme" => Ok(success(
            json!({ "theme": setting(&app, "theme", json!("system"))? }),
        )),
        "setTheme" => {
            let theme = arg_string(&args, 0).unwrap_or_else(|| "system".to_string());
            set_setting(&app, "theme", json!(theme))?;
            let _ = window.emit("theme-changed", resolved_theme(&window, &theme));
            Ok(success(json!({ "theme": theme })))
        }
        "getThemeColor" => Ok(success(
            json!({ "color": setting(&app, "themeColor", json!("#2563eb"))? }),
        )),
        "setThemeColor" => {
            let color = arg_string(&args, 0).unwrap_or_else(|| "#2563eb".to_string());
            set_setting(&app, "themeColor", json!(color))?;
            let _ = window.emit("theme-color-changed", color.clone());
            Ok(success(json!({})))
        }
        "supportsAdvancedBackdrop" => Ok(success(json!({
            "supported": cfg!(any(target_os = "windows", target_os = "macos"))
        }))),
        "getAppearanceMode" => Ok(success(json!({
            "mode": setting(&app, "appearanceMode", json!("dynamic"))?
        }))),
        "setAppearanceMode" => {
            let mode = arg_string(&args, 0).unwrap_or_else(|| "dynamic".to_string());
            if !matches!(mode.as_str(), "acrylic" | "dynamic" | "solid" | "custom") {
                return Ok(json!({
                    "success": false,
                    "error": "Unsupported appearance mode"
                }));
            }

            set_setting(&app, "appearanceMode", json!(mode.clone()))?;
            apply_appearance_mode(&window, &mode)?;

            if mode == "custom" {
                emit_custom_background(&app, &window)?;
            } else {
                window
                    .emit("clear-custom-background", json!({}))
                    .map_err(|err| err.to_string())?;
            }

            window
                .emit("appearance-mode-changed", mode.clone())
                .map_err(|err| err.to_string())?;

            Ok(success(json!({ "mode": mode })))
        }
        "getCustomBackground" => Ok(success(json!({
            "config": custom_background_config(&app)?
        }))),
        "setCustomBackground" => {
            let config = args.first().cloned().unwrap_or(Value::Null);
            let Some(image_path) = config.get("imagePath").and_then(Value::as_str) else {
                return Ok(json!({
                    "success": false,
                    "error": "Image path cannot be empty"
                }));
            };

            let opacity = clamp_u64(config.get("opacity").and_then(Value::as_u64), 0, 100, 80);
            let blur = clamp_u64(config.get("blur").and_then(Value::as_u64), 0, 100, 10);
            set_setting(
                &app,
                "customBackground",
                json!({
                    "imagePath": image_path,
                    "opacity": opacity,
                    "blur": blur
                }),
            )?;

            if setting(&app, "appearanceMode", json!("dynamic"))?
                .as_str()
                .unwrap_or("dynamic")
                == "custom"
            {
                emit_custom_background(&app, &window)?;
            }

            Ok(success(json!({})))
        }
        "clearCustomBackground" => {
            set_setting(&app, "customBackground", Value::Null)?;

            if setting(&app, "appearanceMode", json!("dynamic"))?
                .as_str()
                .unwrap_or("dynamic")
                == "custom"
            {
                set_setting(&app, "appearanceMode", json!("dynamic"))?;
                apply_appearance_mode(&window, "dynamic")?;
                window
                    .emit("appearance-mode-changed", "dynamic")
                    .map_err(|err| err.to_string())?;
            }

            window
                .emit("clear-custom-background", json!({}))
                .map_err(|err| err.to_string())?;
            Ok(success(json!({})))
        }
        "selectBackgroundImage" => {
            let path = tauri::async_runtime::spawn_blocking(|| {
                rfd::FileDialog::new()
                    .set_title("Select background image")
                    .add_filter("Image files", &["jpg", "jpeg", "png", "gif", "bmp", "webp"])
                    .pick_file()
            })
            .await
            .map_err(|err| err.to_string())?;

            if let Some(path) = path {
                Ok(success(json!({ "path": path.to_string_lossy() })))
            } else {
                Ok(success(json!({ "canceled": true })))
            }
        }
        "getSetting" => {
            let key = arg_string(&args, 0).unwrap_or_default();
            if key.trim().is_empty() {
                return Ok(json!({
                    "success": false,
                    "value": args.get(1).cloned().unwrap_or(Value::Null),
                    "error": "设置项名称不能为空"
                }));
            }
            let fallback = args.get(1).cloned().unwrap_or(Value::Null);
            Ok(success(json!({ "value": setting(&app, &key, fallback)? })))
        }
        "setSetting" => {
            let key = arg_string(&args, 0).unwrap_or_default();
            if key.trim().is_empty() {
                return Ok(json!({ "success": false, "error": "设置项名称不能为空" }));
            }
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
        "getLogs" => {
            let file_logs = read_mihomo_logs(&app, 500)?;
            if file_logs.is_empty() {
                Ok(setting(&app, "logs", json!([]))?)
            } else {
                Ok(json!(file_logs))
            }
        }
        "saveLogs" => {
            let file_path =
                save_mihomo_logs(&app, args.first().unwrap_or(&Value::Array(Vec::new())))?;
            Ok(success(json!({
                "filePath": file_path.to_string_lossy()
            })))
        }
        "clearLogs" | "clear-logs" => {
            clear_mihomo_logs(&app)?;
            Ok(success(json!({})))
        }

        "fetchSubscription" => {
            let url = arg_string(&args, 0).unwrap_or_default();
            fetch_subscription(&app, &url).await
        }
        "saveSubscription" => {
            let result = save_subscription(
                &app,
                arg_string(&args, 0),
                arg_string(&args, 1).unwrap_or_default(),
                arg_string(&args, 2),
                args.get(3).cloned(),
            )?;
            if result
                .get("success")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                refresh_tray_menu_after(&app, "saveSubscription");
            }
            Ok(result)
        }
        "updateSubscription" | "update-subscription" => {
            let file_path = arg_string(&args, 0).unwrap_or_default();
            let resolved_path = resolve_subscription_path(&app, &file_path)?;
            let result = update_subscription(
                &app,
                &file_path,
                &arg_string(&args, 1).unwrap_or_default(),
                arg_string(&args, 2),
                args.get(3).cloned(),
            )?;
            let updated = result.as_bool().unwrap_or(false);
            let active = current_active_config(&app, &state);
            if updated && active.as_deref() == resolved_path.as_deref() {
                let _ = refresh_active_config_after_override(&app, &state).await;
            }
            if updated {
                refresh_tray_menu_after(&app, "updateSubscription");
            }
            Ok(result)
        }
        "getSubscriptions" => {
            Ok(serde_json::to_value(read_subscriptions(&app)?).unwrap_or(json!([])))
        }
        "deleteSubscription" => {
            let file_path = arg_string(&args, 0).unwrap_or_default();
            let resolved_path = resolve_subscription_path(&app, &file_path)?;
            let active = current_active_config(&app, &state);
            let result = delete_subscription(&app, &file_path)?;
            let deleted = result.as_bool().unwrap_or_else(|| {
                result
                    .get("success")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
            });
            if !deleted {
                return Ok(result);
            }
            let mut runtime = state.runtime.lock().expect("runtime mutex poisoned");
            if let Some(path) = resolved_path.as_deref() {
                runtime.subscription_update_attempts.remove(path);
            }
            let was_active = active.as_deref() == resolved_path.as_deref();
            if was_active {
                runtime.core.clear_active_config();
            }
            drop(runtime);
            if was_active {
                set_setting(&app, "active_config", Value::Null)?;
                emit_active_config_changed(&app, None);
            }
            refresh_tray_menu_after(&app, "deleteSubscription");
            Ok(result)
        }
        "refreshSubscription" => {
            let file_path = arg_string(&args, 0).unwrap_or_default();
            refresh_subscription_by_path(&app, Some(&state), &file_path).await
        }
        "getSubscriptionUrl" => {
            let file_path = arg_string(&args, 0).unwrap_or_default();
            let resolved_path = resolve_subscription_path(&app, &file_path)?;
            Ok(read_subscriptions(&app)?
                .into_iter()
                .find(|item| Some(item.path.as_str()) == resolved_path.as_deref())
                .and_then(|item| item.url)
                .map(Value::String)
                .unwrap_or(Value::Null))
        }
        "editSubscription" => {
            let params = args.first().cloned().unwrap_or(Value::Null);
            let old_path = params
                .get("oldPath")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let result = edit_subscription(&app, params)?;
            let old_path = resolve_subscription_path(&app, &old_path)
                .ok()
                .flatten()
                .unwrap_or(old_path);
            let success = result
                .get("success")
                .and_then(Value::as_bool)
                .unwrap_or(false);

            if success && !old_path.is_empty() {
                if let Some(new_path) = result.get("newPath").and_then(Value::as_str) {
                    if old_path != new_path {
                        let active = current_active_config(&app, &state);
                        let was_active = active.as_deref() == Some(old_path.as_str());

                        {
                            let mut runtime = state.runtime.lock().expect("runtime mutex poisoned");
                            runtime.subscription_update_attempts.remove(&old_path);
                            if was_active {
                                runtime.core.set_active_config(Some(new_path.to_string()));
                            }
                        }

                        if was_active {
                            save_last_config(&app, new_path)?;
                            emit_active_config_changed(&app, Some(new_path));
                        }
                    }
                }
            }

            if success {
                refresh_tray_menu_after(&app, "editSubscription");
            }
            Ok(result)
        }
        "saveSubscriptionOrder" => {
            let order_list = args
                .first()
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let conn = db(&app)?;
            let mut updated = 0usize;
            let mut missing = Vec::<String>::new();

            for entry in order_list {
                let Some(path) = entry.get("path").and_then(Value::as_str) else {
                    continue;
                };
                let resolved_path = resolve_subscription_path(&app, path)?;
                let order = entry.get("order").and_then(Value::as_u64).unwrap_or(0) as usize;
                let Some(resolved_path) = resolved_path else {
                    missing.push(path.to_string());
                    continue;
                };
                let changed = conn
                    .execute(
                        "UPDATE subscriptions SET sort_order = ?1 WHERE file_path = ?2",
                        params![order as i64, &resolved_path],
                    )
                    .map_err(|err| err.to_string())?;
                if changed == 0 {
                    missing.push(path.to_string());
                } else {
                    updated += changed;
                }
            }

            if !missing.is_empty() {
                return Ok(json!({
                    "success": false,
                    "updated": updated,
                    "missing": missing,
                    "error": "部分订阅不存在，排序未完全保存"
                }));
            }

            refresh_tray_menu_after(&app, "saveSubscriptionOrder");
            Ok(success(json!({ "updated": updated })))
        }
        "getSubscriptionOverrides" => {
            let file_path = arg_string(&args, 0).unwrap_or_default();
            let Some(file_path) = resolve_subscription_path(&app, &file_path)? else {
                return Ok(json!({ "success": false, "error": "订阅不存在" }));
            };
            let raw = db(&app)?
                .query_row(
                    "SELECT overrides FROM subscriptions WHERE file_path = ?1",
                    params![&file_path],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(|err| err.to_string())?;
            let Some(raw) = raw else {
                return Ok(json!({ "success": false, "error": "订阅不存在" }));
            };
            Ok(serde_json::from_str::<Value>(&raw).unwrap_or_else(|_| json!([])))
        }
        "setSubscriptionOverrides" => {
            let file_path = arg_string(&args, 0).unwrap_or_default();
            let Some(file_path) = resolve_subscription_path(&app, &file_path)? else {
                return Ok(json!({ "success": false, "error": "订阅不存在" }));
            };
            let overrides = args.get(1).cloned().unwrap_or_else(|| json!([]));
            let changed = db(&app)?
                .execute(
                    "UPDATE subscriptions SET overrides = ?1 WHERE file_path = ?2",
                    params![overrides.to_string(), &file_path],
                )
                .map_err(|err| err.to_string())?;
            if changed == 0 {
                return Ok(json!({ "success": false, "error": "订阅不存在" }));
            }

            let active = current_active_config(&app, &state);
            let runtime_reload = if active.as_deref() == Some(file_path.as_str()) {
                refresh_active_config_after_override(&app, &state).await
            } else {
                json!({
                    "reloaded": false,
                    "skipped": true,
                    "reason": "not-active-config"
                })
            };
            Ok(success(json!({ "runtimeReload": runtime_reload })))
        }
        "getSubscriptionUpdateInterval" => {
            let file_path = arg_string(&args, 0).unwrap_or_default();
            let Some(file_path) = resolve_subscription_path(&app, &file_path)? else {
                return Ok(json!({ "success": false, "interval": 0, "error": "订阅不存在" }));
            };
            let interval = db(&app)?
                .query_row(
                    "SELECT update_interval FROM subscriptions WHERE file_path = ?1",
                    params![&file_path],
                    |row| row.get::<_, i64>(0),
                )
                .optional()
                .map_err(|err| err.to_string())?;
            let Some(interval) = interval else {
                return Ok(json!({ "success": false, "interval": 0, "error": "订阅不存在" }));
            };
            Ok(success(json!({ "interval": interval })))
        }
        "setSubscriptionUpdateInterval" => {
            let file_path = arg_string(&args, 0).unwrap_or_default();
            let Some(file_path) = resolve_subscription_path(&app, &file_path)? else {
                return Ok(json!({ "success": false, "error": "订阅不存在" }));
            };
            let interval = args.get(1).and_then(Value::as_i64).unwrap_or(0).max(0);
            let changed = db(&app)?
                .execute(
                    "UPDATE subscriptions SET update_interval = ?1 WHERE file_path = ?2",
                    params![interval, &file_path],
                )
                .map_err(|err| err.to_string())?;
            if changed == 0 {
                return Ok(json!({ "success": false, "error": "订阅不存在" }));
            }

            state
                .runtime
                .lock()
                .expect("runtime mutex poisoned")
                .subscription_update_attempts
                .remove(&file_path);
            Ok(success(json!({ "schedulerActive": true })))
        }

        "readConfigFile" => {
            let active =
                current_active_config(&app, &state).ok_or_else(|| "没有当前配置".to_string())?;
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
            let active =
                current_active_config(&app, &state).ok_or_else(|| "没有当前配置".to_string())?;
            save_config_content(&app, &active, &content)?;
            Ok(success(json!({ "path": active })))
        }
        "editConfigAtomic" => {
            let old = arg_string(&args, 0).unwrap_or_default();
            let new = arg_string(&args, 1).unwrap_or_default();
            let active =
                current_active_config(&app, &state).ok_or_else(|| "没有当前配置".to_string())?;
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
        "getKernelConfig" => yaml_root_pick(&app, arg_string(&args, 0), KERNEL_FIELDS),
        "saveKernelConfig" => {
            let config = args.first().cloned().unwrap_or_else(|| json!({}));
            if let Some(config_path) = arg_string(&args, 1) {
                save_kernel_yaml(&app, &config_path, config)?;
                Ok(success(json!({
                    "restarted": false,
                    "message": "kernel config saved to YAML"
                })))
            } else {
                merge_object_setting(&app, "kernel", config)?;
                apply_saved_config(&app, &window, &state, "kernel").await
            }
        }
        "getDnsConfig" => {
            if let Some(config_path) = arg_string(&args, 0) {
                let yaml = config_yaml(&app, &config_path)?;
                let dns = yaml.get("dns").cloned().unwrap_or_else(|| {
                    serde_yaml::to_value(default_dns_config()).unwrap_or(serde_yaml::Value::Null)
                });
                let hosts = yaml
                    .get("hosts")
                    .cloned()
                    .unwrap_or(serde_yaml::Value::Mapping(Default::default()));
                Ok(success(json!({
                    "config": serde_json::to_value(dns).unwrap_or_else(|_| default_dns_config()),
                    "hosts": serde_json::to_value(hosts).unwrap_or_else(|_| json!({}))
                })))
            } else {
                let dns = setting(&app, "dns", default_dns_config())?;
                let dns = if non_empty_object(&dns) {
                    dns
                } else {
                    default_dns_config()
                };
                Ok(success(json!({
                    "config": dns,
                    "hosts": setting(&app, "hosts", json!({}))?
                })))
            }
        }
        "saveDnsConfig" => {
            let config = args.first().cloned().unwrap_or_else(|| json!({}));
            if let Some(config_path) = arg_string(&args, 1) {
                save_yaml_section_value(&app, &config_path, "dns", config)?;
                Ok(success(json!({
                    "restarted": false,
                    "message": "dns config saved to YAML"
                })))
            } else {
                set_setting(&app, "dns", config)?;
                apply_saved_config(&app, &window, &state, "dns").await
            }
        }
        "saveHostsConfig" => {
            let hosts = args.first().cloned().unwrap_or_else(|| json!([]));
            let hosts = hosts_to_map(hosts);
            if let Some(config_path) = arg_string(&args, 1) {
                save_yaml_section_value(&app, &config_path, "hosts", hosts)?;
                Ok(success(json!({
                    "restarted": false,
                    "message": "hosts config saved to YAML"
                })))
            } else {
                set_setting(&app, "hosts", hosts)?;
                apply_saved_config(&app, &window, &state, "hosts").await
            }
        }
        "getSnifferConfig" => {
            if let Some(config_path) = arg_string(&args, 0) {
                yaml_section(&app, Some(config_path), "sniffer")
                    .or_else(|_| Ok(success(json!({ "config": default_sniffer_config() }))))
            } else {
                let config = setting(&app, "sniffer", default_sniffer_config())?;
                Ok(success(json!({ "config": config })))
            }
        }
        "saveSnifferConfig" => {
            let config = args.first().cloned().unwrap_or_else(default_sniffer_config);
            if let Some(config_path) = arg_string(&args, 1) {
                save_yaml_section_value(&app, &config_path, "sniffer", config)?;
                Ok(success(json!({
                    "restarted": false,
                    "message": "sniffer config saved to YAML"
                })))
            } else {
                set_setting(&app, "sniffer", config)?;
                apply_saved_config(&app, &window, &state, "sniffer").await
            }
        }
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
            let active = current_active_config(&app, &state)
                .or_else(|| startup_mihomo_config(&app).ok().flatten());
            Ok(active.map(Value::String).unwrap_or(Value::Null))
        }
        "setPreferredConfig" | "saveLastConfig" => {
            let config_path = arg_string(&args, 0)
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .unwrap_or_default();
            let config_path = normalize_config_reference(&app, &config_path)?;
            if config_path.is_empty() {
                return Ok(json!({ "success": false, "error": "配置文件路径不能为空" }));
            }
            if let Err(error) = config_content(&app, &config_path) {
                return Ok(json!({
                    "success": false,
                    "error": format!("配置文件不存在或无法读取: {error}")
                }));
            }
            save_last_config(&app, &config_path)?;
            {
                let mut runtime = state.runtime.lock().expect("runtime mutex poisoned");
                runtime.core.set_active_config(Some(config_path.clone()));
            }
            emit_active_config_changed(&app, Some(&config_path));
            refresh_tray_menu_after(&app, "setPreferredConfig");
            Ok(success(
                json!({ "path": config_path, "filePath": config_path }),
            ))
        }
        "startMihomo" => {
            let config_path = arg_string(&args, 0).unwrap_or_default();
            let result = start_mihomo(&app, &state, &config_path).await?;
            refresh_tray_menu_after(&app, "startMihomo");
            Ok(result)
        }
        "stopMihomo" => {
            let result = match stop_mihomo_process(&app, &state).await {
                Ok(()) => {
                    let _ = window.emit("mihomo-stopped", 0);
                    json!({ "success": true })
                }
                Err(error) => json!({ "success": false, "error": error }),
            };
            refresh_tray_menu_after(&app, "stopMihomo");
            Ok(result)
        }
        "reloadMihomoConfig" | "reload-mihomo-config" => {
            let config_path = arg_string(&args, 0)
                .or_else(|| read_last_config(&app).ok().flatten())
                .unwrap_or_default();
            let result = reload_mihomo_config(&app, &state, &config_path).await?;
            refresh_tray_menu_after(&app, "reloadMihomoConfig");
            Ok(result)
        }
        "restartService" | "restart-service" => {
            let config_path = arg_string(&args, 0)
                .or_else(|| read_last_config(&app).ok().flatten())
                .unwrap_or_default();
            let result = start_mihomo(&app, &state, &config_path).await?;
            let event_payload = if result
                .get("success")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                json!({ "success": true })
            } else {
                json!({
                    "success": false,
                    "error": result
                        .get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("Failed to restart service")
                })
            };
            let _ = window.emit("service-restarted", event_payload);
            refresh_tray_menu_after(&app, "restartService");
            Ok(result)
        }
        "isMihomoRunning" => Ok(Value::Bool(is_mihomo_running(&app))),
        "getTrafficStats" => {
            let stats = get_traffic_stats(&app, &state).await;
            let _ = window.emit("traffic-update", stats.clone());
            Ok(stats)
        }
        "fetchConnectionsInfo" => {
            let snapshot = fetch_connections_info(&app, &state).await;
            let _ = window.emit("connections-update", snapshot.clone());
            Ok(snapshot)
        }
        "getConfigOrder" => {
            let active = state
                .runtime
                .lock()
                .expect("runtime mutex poisoned")
                .core
                .active_config_owned()
                .or(read_last_config(&app)?);
            Ok(parse_config_order(&app, active))
        }
        "getProxyNodes" => {
            let config_path = arg_string(&args, 0)
                .filter(|path| !path.trim().is_empty())
                .or_else(|| {
                    state
                        .runtime
                        .lock()
                        .expect("runtime mutex poisoned")
                        .core
                        .active_config_owned()
                })
                .or(read_last_config(&app)?);
            Ok(config_path
                .as_deref()
                .map(|path| parse_proxy_nodes_config(&app, path))
                .unwrap_or(Value::Null))
        }
        "getProxies" => {
            let response = request_http(&app, Some("/proxies".to_string()), None).await?;
            if let Some(error) = http_failure(&response, "获取代理列表失败") {
                return Ok(json!({
                    "success": false,
                    "error": error,
                    "status": response.get("status").cloned().unwrap_or(Value::Null)
                }));
            }
            Ok(proxies_payload_for_compat(response))
        }
        "closeConnection" => {
            let id = arg_string(&args, 0).unwrap_or_default();
            if id.is_empty() {
                return Ok(json!({ "success": false, "error": "missing connection id" }));
            }
            let endpoint = format!("/connections/{}", urlencoding::encode(&id));
            let response =
                request_http(&app, Some(endpoint), Some(json!({ "method": "DELETE" }))).await?;
            if response.get("ok").and_then(Value::as_bool).unwrap_or(false) {
                let snapshot = fetch_connections_info(&app, &state).await;
                let _ = window.emit("connections-update", snapshot);
                Ok(success(json!({})))
            } else {
                Ok(json!({
                    "success": false,
                    "error": response
                        .get("statusText")
                        .or_else(|| response.get("text"))
                        .cloned()
                        .unwrap_or(Value::String("断开连接失败".to_string()))
                }))
            }
        }
        "closeAllConnections" => {
            let response = request_http(
                &app,
                Some("/connections".to_string()),
                Some(json!({ "method": "DELETE" })),
            )
            .await?;
            if response.get("ok").and_then(Value::as_bool).unwrap_or(false) {
                let _ = window.emit("connections-closed", json!({}));
                let snapshot = fetch_connections_info(&app, &state).await;
                let _ = window.emit("connections-update", snapshot);
                Ok(success(json!({})))
            } else {
                Ok(json!({
                    "success": false,
                    "error": response
                        .get("statusText")
                        .or_else(|| response.get("text"))
                        .cloned()
                        .unwrap_or(Value::String("断开所有连接失败".to_string()))
                }))
            }
        }
        "testAllNodes" => {
            let _ = window.emit("test-all-nodes", json!({}));
            Ok(success(json!({})))
        }
        "selectNode" | "selectGroupNode" | "switchNode" => {
            let node = arg_string(&args, 0).unwrap_or_default();
            let group = arg_string(&args, 1).unwrap_or_else(|| "GLOBAL".to_string());
            let update_global = arg_bool(&args, 2).unwrap_or(false);
            let endpoint = format!("/proxies/{}", urlencoding::encode(&group));
            let body = json!({ "name": node });
            let response = request_http(
                &app,
                Some(endpoint),
                Some(json!({ "method": "PUT", "body": body })),
            )
            .await?;
            if response.get("ok").and_then(Value::as_bool).unwrap_or(false) {
                let payload = json!({ "nodeName": node.clone(), "groupName": group.clone() });
                if matches!(group.as_str(), "PROXY" | "GLOBAL") || update_global {
                    state
                        .runtime
                        .lock()
                        .expect("runtime mutex poisoned")
                        .current_node = Some(node.clone());
                    let _ = window.emit("node-changed", payload.clone());
                }
                Ok(success(payload))
            } else {
                Ok(
                    json!({ "success": false, "error": response.get("text").cloned().unwrap_or(Value::String("切换节点失败".to_string())) }),
                )
            }
        }
        "notifyNodeChanged" => {
            let node = arg_string(&args, 0).unwrap_or_default();
            state
                .runtime
                .lock()
                .expect("runtime mutex poisoned")
                .current_node = if node.is_empty() {
                None
            } else {
                Some(node.clone())
            };
            let _ = window.emit("node-changed", json!({ "nodeName": node }));
            Ok(success(json!({})))
        }
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
            if let Some(error) = http_failure(&response, "获取 Proxy Providers 失败") {
                return Ok(json!({
                    "success": false,
                    "error": error,
                    "status": response.get("status").cloned().unwrap_or(Value::Null)
                }));
            }
            Ok(success(
                json!({ "data": response.get("data").cloned().unwrap_or(response) }),
            ))
        }
        "updateProxyProvider" | "update-proxy-provider" => {
            let name = arg_string(&args, 0).unwrap_or_default();
            let endpoint = format!("/providers/proxies/{}", urlencoding::encode(&name));
            let response =
                request_http(&app, Some(endpoint), Some(json!({ "method": "PUT" }))).await?;
            if let Some(error) = http_failure(&response, "更新 Proxy Provider 失败") {
                return Ok(json!({
                    "success": false,
                    "error": error,
                    "status": response.get("status").cloned().unwrap_or(Value::Null)
                }));
            }
            Ok(success(json!({})))
        }
        "getRuleProviders" | "get-rule-providers" => {
            let response = request_http(&app, Some("/providers/rules".to_string()), None).await?;
            if let Some(error) = http_failure(&response, "获取 Rule Providers 失败") {
                return Ok(json!({
                    "success": false,
                    "error": error,
                    "status": response.get("status").cloned().unwrap_or(Value::Null)
                }));
            }
            Ok(success(
                json!({ "data": response.get("data").cloned().unwrap_or(response) }),
            ))
        }
        "updateRuleProvider" | "update-rule-provider" => {
            let name = arg_string(&args, 0).unwrap_or_default();
            let endpoint = format!("/providers/rules/{}", urlencoding::encode(&name));
            let response =
                request_http(&app, Some(endpoint), Some(json!({ "method": "PUT" }))).await?;
            if let Some(error) = http_failure(&response, "更新 Rule Provider 失败") {
                return Ok(json!({
                    "success": false,
                    "error": error,
                    "status": response.get("status").cloned().unwrap_or(Value::Null)
                }));
            }
            Ok(success(json!({})))
        }
        "getRuntimeConfig" => {
            let response = request_http(&app, Some("/configs".to_string()), None).await?;
            if let Some(error) = http_failure(&response, "获取运行配置失败") {
                return Ok(json!({
                    "success": false,
                    "error": error,
                    "status": response.get("status").cloned().unwrap_or(Value::Null)
                }));
            }
            let data = response
                .get("data")
                .cloned()
                .unwrap_or_else(|| response.clone());
            Ok(success(json!({
                "data": data,
                "status": response.get("status").cloned().unwrap_or(Value::Null)
            })))
        }
        "getCurrentConfigName" => {
            let active = read_last_config(&app)?;
            let name = active.as_deref().and_then(config_display_name);
            Ok(success(json!({ "configName": name })))
        }

        "getApiConfig" => {
            let controller_endpoint = active_runtime_controller_endpoint(&app);
            Ok(success(json!({
                "controllerHost": if configured_http_controller(&app) { Value::String(controller_host(&app)) } else { Value::Null },
                "controllerPort": if configured_http_controller(&app) { Value::String(controller_port(&app).to_string()) } else { Value::Null },
                "secret": controller_secret(&app),
                "controllerMode": "socket",
                "socketPath": controller_endpoint.path,
                "socketArg": controller_endpoint.arg_name,
                "httpFallback": configured_http_controller(&app)
            })))
        }
        "requestMihomoAPI" => {
            let target = arg_string(&args, 0);
            if let Some(patch) = geodata_config_patch_body(target.as_deref(), args.get(1)) {
                patch_active_geodata_config(&app, &state, patch).await
            } else {
                request_http(&app, target, args.get(1).cloned()).await
            }
        }
        "proxyFetch" => {
            request_http_via_proxy(&app, arg_string(&args, 0), args.get(1).cloned()).await
        }
        "fetchWithProxy" => request_http_via_proxy(&app, None, args.first().cloned()).await,

        "openExternal" | "openFile" | "openFileInDefaultApp" => {
            let Some(target) = arg_string(&args, 0)
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
            else {
                return Ok(json!({
                    "success": false,
                    "error": if method == "openExternal" { "缺少要打开的链接" } else { "缺少要打开的文件路径" }
                }));
            };
            if method == "openExternal" {
                open::that(target).map_err(|err| err.to_string())?;
            } else {
                let path = materialize_config_for_open(&app, &target)?;
                open::that(path).map_err(|err| err.to_string())?;
            }
            Ok(success(json!({})))
        }
        "openFileLocation" => {
            let Some(target) = arg_string(&args, 0)
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
            else {
                return Ok(json!({ "success": false, "error": "缺少要定位的文件路径" }));
            };
            let path = materialize_config_for_open(&app, &target)?;
            open_file_location(&path)?;
            Ok(success(json!({})))
        }
        "openToolsApp" | "open-tools-app" => {
            let tool_name = arg_string(&args, 0).unwrap_or_default();
            let Some(tool_path) = find_tool_path(&app, &tool_name)? else {
                return Ok(json!({
                    "success": false,
                    "error": "Tool file does not exist"
                }));
            };
            open::that(tool_path).map_err(|err| err.to_string())?;
            Ok(success(json!({})))
        }
        "getIconDataURL" => {
            let Some(path) = arg_string(&args, 0) else {
                return Ok(Value::Null);
            };
            Ok(process_icon_data_url(&path)?
                .map(Value::String)
                .unwrap_or(Value::Null))
        }

        "window-minimize" | "minimizeWindow" => {
            window.minimize().map_err(|err| err.to_string())?;
            Ok(success(json!({})))
        }
        "window-show" | "showWindow" => {
            window.show().map_err(|err| err.to_string())?;
            window.set_focus().map_err(|err| err.to_string())?;
            Ok(success(json!({})))
        }
        "window-hide" | "hideWindow" => {
            window.hide().map_err(|err| err.to_string())?;
            Ok(success(json!({})))
        }
        "quitApp" | "appQuit" => {
            app.exit(0);
            Ok(success(json!({})))
        }
        "window-toggle-maximize" | "maximizeWindow" => {
            let result = if window.is_maximized().map_err(|err| err.to_string())? {
                window.unmaximize().map_err(|err| err.to_string())?;
                window_state_payload(&window)
            } else {
                window.maximize().map_err(|err| err.to_string())?;
                window_state_payload(&window)
            };
            emit_window_state(&window);
            Ok(result)
        }
        "window-close" | "closeWindow" => {
            let minimize_to_tray = setting(&app, "minimizeToTray", json!(true))?
                .as_bool()
                .unwrap_or(true);
            if minimize_to_tray {
                window.hide().map_err(|err| err.to_string())?;
            } else {
                window.close().map_err(|err| err.to_string())?;
            }
            Ok(success(json!({})))
        }
        "getWindowState" => Ok(window_state_payload(&window)),

        "getSystemProxyStatus" => Ok(system_proxy_status(&app)),
        "getProxyStatus" => {
            let status = system_proxy_status(&app);
            let enabled = status
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if setting(&app, "systemProxyEnabled", json!(false))?
                .as_bool()
                .unwrap_or(false)
                != enabled
            {
                set_setting(&app, "systemProxyEnabled", json!(enabled))?;
            }
            Ok(Value::Bool(enabled))
        }
        "toggleSystemProxy" => {
            let enabled = arg_bool(&args, 0).unwrap_or(false);
            if enabled && !is_mihomo_running(&app) {
                return Ok(json!({
                    "success": false,
                    "enabled": false,
                    "error": "Mihomo 服务未运行，无法启用系统代理"
                }));
            }
            let port = mihomo_mixed_port(&app);
            set_system_proxy(&app, enabled, "127.0.0.1", port)?;
            let mut status = system_proxy_status(&app);
            let actual_enabled = status
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if let Some(object) = status.as_object_mut() {
                object.insert("requested".to_string(), Value::Bool(enabled));
                if actual_enabled != enabled || object.contains_key("error") {
                    object.insert("success".to_string(), Value::Bool(false));
                    object
                        .entry("error".to_string())
                        .or_insert_with(|| Value::String("系统代理状态未切换到目标值".to_string()));
                    set_setting(&app, "systemProxyEnabled", json!(actual_enabled))?;
                    let _ = window.emit("proxy-status", actual_enabled);
                    refresh_tray_menu_after(&app, "toggleSystemProxy");
                    return Ok(status);
                }
            }
            let _ = window.emit("proxy-status", enabled);
            refresh_tray_menu_after(&app, "toggleSystemProxy");
            Ok(status)
        }
        "getTunStatus" => Ok(Value::Bool(
            setting(&app, "tunModeEnabled", json!(false))?
                .as_bool()
                .unwrap_or(false),
        )),
        "toggleTunMode" => {
            let enabled = arg_bool(&args, 0).unwrap_or(false);
            let previous_enabled = setting(&app, "tunModeEnabled", json!(false))?
                .as_bool()
                .unwrap_or(false);
            if enabled {
                ensure_tun_dns_defaults(&app)?;
            }
            set_setting(&app, "tunModeEnabled", json!(enabled))?;
            let result =
                apply_tun_runtime_change(&app, &window, &state, enabled, previous_enabled, true)
                    .await;
            refresh_tray_menu_after(&app, "toggleTunMode");
            result
        }
        "getTunConfig" => Ok(success(json!({
            "config": setting(&app, "tunConfig", default_tun_config())?
        }))),
        "saveTunConfig" => {
            set_setting(
                &app,
                "tunConfig",
                args.first().cloned().unwrap_or_else(default_tun_config),
            )?;
            let enabled = setting(&app, "tunModeEnabled", json!(false))?
                .as_bool()
                .unwrap_or(false);
            if enabled {
                ensure_tun_dns_defaults(&app)?;
                let result =
                    apply_tun_runtime_change(&app, &window, &state, enabled, enabled, false).await;
                refresh_tray_menu_after(&app, "saveTunConfig");
                result
            } else {
                refresh_tray_menu_after(&app, "saveTunConfig");
                Ok(success(json!({
                    "enabled": false,
                    "pending": false,
                    "restarted": false,
                    "message": "TUN 配置已保存"
                })))
            }
        }
        "getProxySettings" => Ok(success(json!({
            "settings": user_settings_view(&app)?
        }))),
        "saveProxySettings" => {
            let kernel_changed =
                save_proxy_settings(&app, args.first().cloned().unwrap_or_else(|| json!({})))?;
            if kernel_changed {
                apply_saved_config(&app, &window, &state, "proxy").await
            } else {
                Ok(success(json!({ "message": "Settings saved" })))
            }
        }
        "saveUASettings" => {
            let ua = arg_string(&args, 0).unwrap_or_default();
            let ua = ua.trim();
            if ua.is_empty() {
                return Ok(json!({ "success": false, "error": "Invalid User-Agent option" }));
            }
            if !allowed_subscription_ua_key(ua) {
                return Ok(json!({ "success": false, "error": "Unsupported User-Agent option" }));
            }
            set_setting(&app, "subscription-ua", json!(ua))?;
            Ok(success(json!({ "message": "User-Agent updated" })))
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
        "proxyIcon.clearCache" | "proxy-icon:clear-cache" => clear_icon_cache(&app, "icon-cache"),
        "proxyIcon.getGroupIcon" | "proxy-icon:get-group-icon" => {
            proxy_group_icon(
                &app,
                &arg_string(&args, 0).unwrap_or_default(),
                arg_string(&args, 1),
            )
            .await
        }
        "configIcon.getIcon" | "config-icon:get-icon" => {
            config_icon_get(
                &app,
                arg_string(&args, 0).unwrap_or_default(),
                arg_string(&args, 1).unwrap_or_default(),
            )
            .await
        }
        "configIcon.clearCache" | "config-icon:clear-cache" => {
            clear_icon_cache(&app, "config-icons")
        }
        "configIcon.getCacheSize" | "config-icon:get-cache-size" => {
            icon_cache_size(&app, "config-icons")
        }
        "getOverrides" | "override:getItems" => Ok(json!(all_overrides(&app)?)),
        "addOverride" | "override:addItem" => {
            let result =
                override_add(&app, args.first().cloned().unwrap_or_else(|| json!({}))).await?;
            let runtime_reload = refresh_active_config_after_override(&app, &state).await;
            Ok(attach_runtime_reload(result, runtime_reload))
        }
        "updateOverride" | "override:updateItem" => {
            let mut result = override_update(
                &app,
                &arg_string(&args, 0).unwrap_or_default(),
                args.get(1).cloned().unwrap_or_else(|| json!({})),
            )?;
            let should_fetch_remote = result.get("type").and_then(Value::as_str) == Some("remote")
                && result
                    .get("enabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                && override_content(&app, result.get("id").and_then(Value::as_str).unwrap_or(""))
                    .map(|content| content.trim().is_empty())
                    .unwrap_or(true);
            if should_fetch_remote {
                result = override_update_remote(
                    &app,
                    result.get("id").and_then(Value::as_str).unwrap_or(""),
                )
                .await?;
            }
            let runtime_reload = refresh_active_config_after_override(&app, &state).await;
            Ok(attach_runtime_reload(result, runtime_reload))
        }
        "deleteOverride" | "override:deleteItem" => {
            let id = arg_string(&args, 0).unwrap_or_default();
            let changed = db(&app)?
                .execute("DELETE FROM overrides WHERE id = ?1", params![id])
                .map_err(|err| err.to_string())?;
            if changed == 0 {
                return Ok(json!({ "success": false, "error": "覆写项不存在" }));
            }
            let runtime_reload = refresh_active_config_after_override(&app, &state).await;
            Ok(success(json!({ "runtimeReload": runtime_reload })))
        }
        "getOverrideFileContent" | "override:getFileContent" => {
            let id = arg_string(&args, 0).unwrap_or_default();
            let mut content = override_content(&app, &id)?;
            if content.trim().is_empty() {
                if let Some(item) = all_overrides(&app)?.into_iter().find(|item| {
                    item.get("id").and_then(Value::as_str) == Some(id.as_str())
                        && item.get("type").and_then(Value::as_str) == Some("remote")
                }) {
                    let url = item
                        .get("url")
                        .and_then(Value::as_str)
                        .ok_or_else(|| "远程覆写缺少 URL".to_string())?;
                    content = fetch_override_remote_content(url).await?;
                    save_override_item(&app, &item, Some(&content))?;
                }
            }
            Ok(Value::String(content))
        }
        "updateOverrideFileContent" | "override:updateFileContent" => {
            let id = arg_string(&args, 0).unwrap_or_default();
            let content = arg_string(&args, 1).unwrap_or_default();
            let item = all_overrides(&app)?
                .into_iter()
                .find(|item| item.get("id").and_then(Value::as_str) == Some(id.as_str()))
                .ok_or_else(|| "覆写项不存在".to_string())?;
            save_override_item(&app, &item, Some(&content))?;
            let runtime_reload = refresh_active_config_after_override(&app, &state).await;
            Ok(success(json!({ "runtimeReload": runtime_reload })))
        }
        "updateRemoteOverride" | "override:updateRemoteItem" => {
            let result =
                override_update_remote(&app, &arg_string(&args, 0).unwrap_or_default()).await?;
            let runtime_reload = refresh_active_config_after_override(&app, &state).await;
            Ok(attach_runtime_reload(result, runtime_reload))
        }
        "reorderOverrides" | "override:reorderItems" => {
            let ids = args
                .first()
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let conn = db(&app)?;
            let mut missing = Vec::<String>::new();
            for (index, id) in ids.iter().filter_map(Value::as_str).enumerate() {
                let changed = conn
                    .execute(
                        "UPDATE overrides SET sort_order = ?1 WHERE id = ?2",
                        params![index as i64, id],
                    )
                    .map_err(|err| err.to_string())?;
                if changed == 0 {
                    missing.push(id.to_string());
                }
            }
            if !missing.is_empty() {
                return Ok(json!({
                    "success": false,
                    "missing": missing,
                    "error": "部分覆写项不存在，排序未完全保存"
                }));
            }
            let runtime_reload = refresh_active_config_after_override(&app, &state).await;
            Ok(success(json!({ "runtimeReload": runtime_reload })))
        }
        "backupCreateLocal" | "backup-create-local" => {
            let backup_type = arg_string(&args, 0).unwrap_or_else(|| "CONFIG_ONLY".to_string());
            let default_dir = app.path().download_dir().ok();
            let file_name = backup_file_name();
            let picked = tauri::async_runtime::spawn_blocking(move || {
                let mut dialog = rfd::FileDialog::new()
                    .set_title("保存备份")
                    .set_file_name(file_name)
                    .add_filter("ZIP文件", &["zip"])
                    .add_filter("所有文件", &["*"]);
                if let Some(default_dir) = default_dir {
                    dialog = dialog.set_directory(default_dir);
                }
                dialog.save_file()
            })
            .await
            .map_err(|err| err.to_string())?;

            if let Some(path) = picked {
                create_backup_zip_at(&app, &backup_type, &ensure_zip_extension(path))
            } else {
                Ok(json!({ "success": false, "canceled": true, "error": "用户取消" }))
            }
        }
        "backupRestoreLocal" | "backup-restore-local" => {
            let picked = tauri::async_runtime::spawn_blocking(|| {
                rfd::FileDialog::new()
                    .set_title("选择备份文件")
                    .add_filter("ZIP文件", &["zip"])
                    .add_filter("所有文件", &["*"])
                    .pick_file()
            })
            .await
            .map_err(|err| err.to_string())?;

            if let Some(path) = picked {
                let result = restore_backup_zip(&app, &path)?;
                finalize_backup_restore(&app, &state, result).await
            } else {
                Ok(json!({ "success": false, "canceled": true, "error": "用户取消" }))
            }
        }
        "backupWebDAVSaveConfig" | "backup-webdav-save-config" => {
            let config = args.first().cloned().unwrap_or_else(|| json!({}));
            let backup_directory = config
                .get("backupDirectory")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or("FlyClash");
            let backup_file_name = config
                .get("fileName")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or("flyclash_backup.zip");
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
            set_setting(&app, "webdav_backup_dir", json!(backup_directory))?;
            set_setting(&app, "webdav_backup_filename", json!(backup_file_name))?;
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
            let url = match webdav_root_url(&config) {
                Ok(url) => url,
                Err(error) => return Ok(json!({ "success": false, "error": error })),
            };
            let result = match webdav_request(&config, "PROPFIND", url, None, Some("0")).await {
                Ok(result) => result,
                Err(error) => return Ok(json!({ "success": false, "error": error })),
            };
            let connected = result
                .get("success")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if connected {
                Ok(success(json!({})))
            } else {
                Ok(json!({
                    "success": false,
                    "error": webdav_error_message(&result, "WebDAV连接测试失败")
                }))
            }
        }
        "backupWebDAVUpload" | "backup-webdav-upload" => {
            let config = webdav_config(&app)?;
            if let Err(error) = webdav_validate_config(&config) {
                return Ok(json!({ "success": false, "uploaded": false, "error": error }));
            }
            let local = create_backup_zip(
                &app,
                &arg_string(&args, 0).unwrap_or_else(|| "CONFIG_ONLY".to_string()),
            )?;
            let file_path = local
                .get("filePath")
                .and_then(Value::as_str)
                .ok_or_else(|| "备份创建失败".to_string())?;
            let mut file_name = webdav_config_text(&config, "fileName", "flyclash_backup.zip");
            if file_name.is_empty() {
                file_name = "flyclash_backup.zip".to_string();
            }
            if let Err(error) = webdav_ensure_directory(&config).await {
                return Ok(json!({ "success": false, "uploaded": false, "error": error }));
            }
            let bytes = fs::read(file_path).map_err(|err| err.to_string())?;
            let total = bytes.len() as u64;
            emit_backup_progress(&window, "backup-upload-progress", "uploaded", 0, total);
            let result = webdav_request(
                &config,
                "PUT",
                webdav_url(&config, Some(&file_name))?,
                Some(bytes),
                None,
            )
            .await?;
            let _ = fs::remove_file(file_path);
            let uploaded = result
                .get("success")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if !uploaded {
                return Ok(json!({
                    "success": false,
                    "uploaded": false,
                    "error": webdav_error_message(&result, "上传失败")
                }));
            }
            if uploaded {
                emit_backup_progress(&window, "backup-upload-progress", "uploaded", total, total);
            }
            Ok(success(
                json!({ "fileName": file_name, "uploaded": uploaded }),
            ))
        }
        "backupWebDAVDownload" | "backup-webdav-download" => {
            let config = webdav_config(&app)?;
            if let Err(error) = webdav_validate_config(&config) {
                return Ok(json!({ "success": false, "error": error }));
            }
            let username = config.get("username").and_then(Value::as_str).unwrap_or("");
            let password = config.get("password").and_then(Value::as_str).unwrap_or("");
            let file_name = arg_string(&args, 0)
                .or_else(|| {
                    config
                        .get("fileName")
                        .and_then(Value::as_str)
                        .map(ToString::to_string)
                })
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "flyclash_backup.zip".to_string());
            let url = webdav_url(&config, Some(&file_name))?;
            let client = reqwest::Client::builder()
                .danger_accept_invalid_certs(true)
                .build()
                .map_err(|err| err.to_string())?;
            let mut response = client
                .get(url)
                .basic_auth(username, Some(password))
                .send()
                .await
                .map_err(|err| err.to_string())?;
            if !response.status().is_success() {
                return Ok(json!({
                    "success": false,
                    "error": format!("下载失败: HTTP {}", response.status())
                }));
            }
            let total = response.content_length().unwrap_or(0);
            emit_backup_progress(&window, "backup-download-progress", "downloaded", 0, total);
            let mut downloaded = 0u64;
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|err| err.to_string())? {
                downloaded = downloaded.saturating_add(chunk.len() as u64);
                bytes.extend_from_slice(&chunk);
                emit_backup_progress(
                    &window,
                    "backup-download-progress",
                    "downloaded",
                    downloaded,
                    total,
                );
            }
            let path = backup_dir(&app)?.join(&file_name);
            fs::write(&path, &bytes).map_err(|err| err.to_string())?;
            emit_backup_progress(
                &window,
                "backup-download-progress",
                "downloaded",
                if total > 0 { total } else { downloaded },
                if total > 0 { total } else { downloaded },
            );
            let result = restore_backup_zip(&app, &path)?;
            finalize_backup_restore(&app, &state, result).await
        }
        "backupWebDAVList" | "backup-webdav-list" => {
            let config = webdav_config(&app)?;
            if webdav_validate_config(&config).is_err() {
                return Ok(success(json!({ "backups": [] })));
            }
            let result = webdav_request(
                &config,
                "PROPFIND",
                webdav_url(&config, None)?,
                None,
                Some("1"),
            )
            .await?;
            let listed = result
                .get("success")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let status = result.get("status").and_then(Value::as_u64).unwrap_or(0);
            if !listed {
                if status == 404 {
                    return Ok(success(json!({ "backups": [] })));
                }
                return Ok(json!({
                    "success": false,
                    "backups": [],
                    "error": webdav_error_message(&result, "列出WebDAV备份失败")
                }));
            }
            let text = result.get("text").and_then(Value::as_str).unwrap_or("");
            let response_re = Regex::new(r"(?is)<[^:>]*:?response\b[^>]*>(.*?)</[^:>]*:?response>")
                .map_err(|err| err.to_string())?;
            let href_re = Regex::new(r"(?is)<[^:>]*:?href>([^<]+)</[^:>]*:?href>")
                .map_err(|err| err.to_string())?;
            let size_re =
                Regex::new(r"(?is)<[^:>]*:?getcontentlength>(\d+)</[^:>]*:?getcontentlength>")
                    .map_err(|err| err.to_string())?;
            let modified_re =
                Regex::new(r"(?is)<[^:>]*:?getlastmodified>([^<]+)</[^:>]*:?getlastmodified>")
                    .map_err(|err| err.to_string())?;
            let backups = response_re
                .captures_iter(text)
                .filter_map(|response| response.get(1).map(|m| m.as_str().to_string()))
                .filter_map(|response| {
                    let href = href_re
                        .captures(&response)
                        .and_then(|capture| capture.get(1))
                        .map(|m| m.as_str().to_string())?;
                    let raw_name = href.trim_end_matches('/').rsplit('/').next()?.to_string();
                    let name = urlencoding::decode(&raw_name)
                        .map(|value| value.into_owned())
                        .unwrap_or(raw_name);
                    if !name.ends_with(".zip") {
                        return None;
                    }
                    let size = size_re
                        .captures(&response)
                        .and_then(|capture| capture.get(1))
                        .and_then(|m| m.as_str().parse::<u64>().ok())
                        .unwrap_or(0);
                    let last_modified = modified_re
                        .captures(&response)
                        .and_then(|capture| capture.get(1))
                        .map(|m| m.as_str().trim().to_string())
                        .unwrap_or_default();
                    Some(json!({
                        "name": name,
                        "size": size,
                        "lastModified": last_modified
                    }))
                })
                .collect::<Vec<_>>();
            Ok(success(json!({ "backups": backups })))
        }
        "backupWebDAVDelete" | "backup-webdav-delete" => {
            let config = webdav_config(&app)?;
            let file_name = arg_string(&args, 0).unwrap_or_default();
            if file_name.trim().is_empty() {
                return Ok(
                    json!({ "success": false, "deleted": false, "error": "缺少备份文件名" }),
                );
            }
            let result = webdav_request(
                &config,
                "DELETE",
                webdav_url(&config, Some(&file_name))?,
                None,
                None,
            )
            .await?;
            let deleted = result
                .get("success")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if deleted {
                Ok(success(json!({ "deleted": true })))
            } else {
                Ok(json!({
                    "success": false,
                    "deleted": false,
                    "error": webdav_error_message(&result, "删除失败")
                }))
            }
        }
        "converter.fetchUrl" | "converter:fetch-url" => {
            let mut url = arg_string(&args, 0).unwrap_or_default();
            url = url.trim().to_string();
            if url.is_empty() {
                return Ok(json!({ "success": false, "error": "URL 不能为空" }));
            }
            if !url.starts_with("http://") && !url.starts_with("https://") {
                url = format!("https://{url}");
            }

            let settings = converter_settings(&app)?;
            let user_agent = settings
                .get("userAgent")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .unwrap_or("FlyClash-Converter/1.0");
            let response = reqwest::Client::builder()
                .danger_accept_invalid_certs(true)
                .timeout(Duration::from_secs(30))
                .build()
                .map_err(|err| err.to_string())?
                .get(url)
                .header(reqwest::header::USER_AGENT, user_agent)
                .send()
                .await
                .map_err(|err| err.to_string())?;
            let status = response.status();
            if !status.is_success() {
                return Ok(json!({
                    "success": false,
                    "error": format!("HTTP {}", status.as_u16()),
                    "status": status.as_u16()
                }));
            }
            let text = response.text().await.map_err(|err| err.to_string())?;
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
            "settings": converter_settings(&app)?
        }))),
        "converter.saveSettings" | "converter:save-settings" => {
            set_setting(
                &app,
                "converterSettings",
                args.first().cloned().unwrap_or_else(|| json!({})),
            )?;
            Ok(success(json!({})))
        }
        "converter.serverStatus" | "converter:server-status" => {
            converter_server_status(&app, &state)
        }
        "converter.startServer" | "converter:start-server" => converter_start_server(&app, &state),
        "converter.stopServer" | "converter:stop-server" => converter_stop_server(&app, &state),
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
            Ok(converter_conversion_payload(
                &content,
                params.get("targetFormat").and_then(Value::as_str),
                params.get("filterRegex").and_then(Value::as_str),
                params.get("options"),
                if matches!(
                    method,
                    "converter.convertWithTemplate" | "converter:convert-with-template"
                ) {
                    params.get("templateId").and_then(Value::as_str)
                } else {
                    None
                },
            ))
        }
        "converter.createSubscription" | "converter:create-subscription" => {
            converter_create_subscription(
                &app,
                &state,
                args.first().cloned().unwrap_or_else(|| json!({})),
            )
            .await
        }
        "converter.addToConfig" | "converter:add-to-config" => {
            converter_add_to_config(&app, args.first().cloned().unwrap_or_else(|| json!({}))).await
        }
        "converter.listSubscriptions" | "converter:list-subscriptions" => Ok(success(json!({
            "subscriptions": converter_list_from_dir(&converter_subscription_dir(&app)?, converter_port(&app)?)
        }))),
        "converter.deleteSubscription" | "converter:delete-subscription" => {
            let id = arg_string(&args, 0).unwrap_or_default();
            let path = converter_subscription_file(&app, &id)?;
            if path.exists() {
                fs::remove_file(path).map_err(|err| err.to_string())?;
                Ok(success(json!({})))
            } else {
                Ok(json!({ "success": false, "error": "Subscription not found" }))
            }
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
            let mut sids = loopback_current_exempt_sids(&app)?;
            if let Some(sid) = arg_string(&args, 0) {
                if !sids.iter().any(|value| value.eq_ignore_ascii_case(&sid)) {
                    sids.push(sid);
                }
            }
            loopback_set(&app, sids)
        }
        "loopback.removeExemption" | "loopback:remove-exemption" => {
            let sid = arg_string(&args, 0).unwrap_or_default();
            let sids = loopback_current_exempt_sids(&app)?
                .into_iter()
                .filter(|value| !value.eq_ignore_ascii_case(&sid))
                .collect();
            loopback_set(&app, sids)
        }
        "checkElevateTask" => Ok(Value::Bool(if cfg!(target_os = "windows") {
            windows_elevated_task_exists()
        } else {
            setting(&app, "tunElevateTask", json!(false))?
                .as_bool()
                .unwrap_or(false)
        })),
        "deleteElevateTask" => {
            let deleted = if cfg!(target_os = "windows") {
                delete_windows_elevated_task()?
            } else {
                false
            };
            set_setting(&app, "tunElevateTask", json!(false))?;
            Ok(success(json!({ "deleted": deleted })))
        }
        "grantTunPermissions" => {
            if cfg!(target_os = "windows") {
                let mode = setting(&app, "tunElevationMode", json!("service"))?
                    .as_str()
                    .unwrap_or("service")
                    .to_string();
                if mode == "service" {
                    install_or_start_windows_tun_service(&app)
                } else if windows_elevated_task_exists() || windows_is_admin() {
                    set_setting(&app, "tunElevateTask", json!(true))?;
                    Ok(success(json!({
                        "message": if windows_elevated_task_exists() {
                            "计划任务已存在"
                        } else {
                            "当前进程已具备管理员权限"
                        },
                        "mode": "task",
                        "needRestart": false
                    })))
                } else {
                    create_windows_elevated_task(&app)?;
                    set_setting(&app, "tunElevateTask", json!(true))?;
                    set_setting(&app, "pendingTunEnable", json!(true))?;
                    schedule_windows_elevated_restart(&app)?;
                    Ok(success(json!({
                        "message": "正在请求管理员权限创建任务并重启应用...",
                        "mode": "task",
                        "needRestart": true
                    })))
                }
            } else {
                set_setting(&app, "tunElevateTask", json!(true))?;
                Ok(success(json!({
                    "message": "TUN 权限状态已保存",
                    "needRestart": false
                })))
            }
        }
        "checkCorePermission" => {
            if cfg!(target_os = "windows") {
                Ok(windows_core_permission_status(&app))
            } else {
                Ok(success(json!({
                    "hasPermission": find_mihomo_executable(&app).map(|path| path.exists()).unwrap_or(false)
                })))
            }
        }
        "revokeCorePermission" => {
            if cfg!(target_os = "windows") {
                let deleted = delete_windows_elevated_task()?;
                set_setting(&app, "tunElevateTask", json!(false))?;
                Ok(success(json!({ "deleted": deleted })))
            } else {
                Ok(success(json!({})))
            }
        }
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
                let helper = find_helper_executable(&app)?;
                match core_service::install_helper_service(&helper, false) {
                    Ok(_) => Ok(success(json!({ "message": "service installed" }))),
                    Err(error) => Ok(json!({ "success": false, "error": error })),
                }
            }
        }
        "uninstallTunService" | "serviceUninstall" => {
            if !cfg!(target_os = "windows") {
                Ok(json!({ "success": false, "error": "当前平台不支持 Windows 服务" }))
            } else {
                let helper = find_helper_executable(&app)?;
                match core_service::uninstall_helper_service(&helper) {
                    Ok(_) => Ok(success(json!({ "message": "service uninstalled" }))),
                    Err(error) => Ok(json!({ "success": false, "error": error })),
                }
            }
        }
        "startTunService" => {
            if !cfg!(target_os = "windows") {
                Ok(json!({ "success": false, "error": "当前平台不支持 Windows 服务" }))
            } else {
                match core_service::ensure_helper_service_ready() {
                    Ok(_) => Ok(success(json!({
                        "message": "service started",
                        "status": service_status()
                    }))),
                    Err(error) => Ok(json!({ "success": false, "error": error })),
                }
            }
        }
        "stopTunService" => {
            if !cfg!(target_os = "windows") {
                Ok(json!({ "success": false, "error": "当前平台不支持 Windows 服务" }))
            } else {
                let _ = core_lifecycle::stop_service_core();
                match core_service::stop_helper_service() {
                    Ok(_) => {
                        let mut runtime = state.runtime.lock().expect("runtime mutex poisoned");
                        if runtime.core.running_mode() == RunningMode::Service {
                            runtime.core.mark_stopped();
                        }
                        Ok(success(json!({ "message": "service stopped" })))
                    }
                    Err(error) => Ok(json!({ "success": false, "error": error })),
                }
            }
        }
        "setAsDefaultProtocolClient" | "registerProtocol" => {
            let protocol = arg_string(&args, 0)
                .and_then(|value| normalized_protocol_scheme(&value))
                .ok_or_else(|| "missing protocol scheme".to_string())?;
            match app.deep_link().register(&protocol) {
                Ok(_) => Ok(success(json!({ "protocol": protocol, "registered": true }))),
                Err(error) => Ok(json!({
                    "success": false,
                    "protocol": protocol,
                    "registered": false,
                    "error": error.to_string()
                })),
            }
        }
        "isDefaultProtocolClient" | "isProtocolRegistered" => {
            let protocol = arg_string(&args, 0)
                .and_then(|value| normalized_protocol_scheme(&value))
                .ok_or_else(|| "missing protocol scheme".to_string())?;
            match app.deep_link().is_registered(&protocol) {
                Ok(registered) => Ok(success(json!({
                    "protocol": protocol,
                    "registered": registered
                }))),
                Err(error) => Ok(json!({
                    "success": false,
                    "protocol": protocol,
                    "registered": false,
                    "error": error.to_string()
                })),
            }
        }
        "removeAsDefaultProtocolClient" | "unregisterProtocol" => {
            let protocol = arg_string(&args, 0)
                .and_then(|value| normalized_protocol_scheme(&value))
                .ok_or_else(|| "missing protocol scheme".to_string())?;
            match app.deep_link().unregister(&protocol) {
                Ok(_) => Ok(success(
                    json!({ "protocol": protocol, "registered": false }),
                )),
                Err(error) => Ok(json!({
                    "success": false,
                    "protocol": protocol,
                    "error": error.to_string()
                })),
            }
        }
        "getProxyConfig" => {
            let host = "127.0.0.1";
            let port = mihomo_mixed_port(&app);
            Ok(success(json!({
                "host": host,
                "port": port,
                "data": {
                    "host": host,
                    "port": port
                }
            })))
        }
        "getKernelPath" => {
            let custom = custom_kernel_path(&app)?;
            let path = custom
                .as_deref()
                .map(PathBuf::from)
                .or_else(|| default_mihomo_executable(&app).ok())
                .unwrap_or_default();
            Ok(success(json!({
                "path": path.to_string_lossy(),
                "isDefault": custom.is_none(),
                "exists": path.exists()
            })))
        }
        "selectKernelExecutable" => {
            let path = tauri::async_runtime::spawn_blocking(|| {
                let mut dialog = rfd::FileDialog::new().set_title("选择 Mihomo 内核");
                #[cfg(target_os = "windows")]
                {
                    dialog = dialog.add_filter("可执行文件", &["exe"]);
                }
                dialog.pick_file()
            })
            .await
            .map_err(|err| err.to_string())?;

            let Some(path) = path else {
                return Ok(json!({ "success": false, "canceled": true }));
            };
            if !path.exists() {
                return Ok(json!({
                    "success": false,
                    "error": "选择的内核文件不存在"
                }));
            }
            let selected = path.to_string_lossy().to_string();
            set_custom_kernel_path(&app, Some(&selected))?;
            Ok(success(json!({
                "path": selected,
                "isDefault": false,
                "exists": true,
                "needsRestart": is_mihomo_running(&app),
                "canceled": false
            })))
        }
        "resetKernelPath" => {
            set_custom_kernel_path(&app, None)?;
            let path = default_mihomo_executable(&app).ok();
            let exists = path.as_ref().map(|path| path.exists()).unwrap_or(false);
            Ok(success(json!({
                "path": path
                    .as_ref()
                    .map(|path| path.to_string_lossy().to_string())
                    .unwrap_or_default(),
                "isDefault": true,
                "exists": exists,
                "needsRestart": is_mihomo_running(&app)
            })))
        }
        "setAutoStart" | "setAutoLaunch" => {
            let enabled = arg_bool(&args, 0).unwrap_or(false);
            set_autostart(&app, enabled)?;
            Ok(Value::Bool(enabled))
        }
        "getAutoStart" | "getAutoLaunchState" => Ok(Value::Bool(autostart_enabled(&app))),
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
        "getMinimizeToTray" | "get-minimize-to-tray" => Ok(Value::Bool(
            setting(&app, "minimizeToTray", json!(true))?
                .as_bool()
                .unwrap_or(true),
        )),
        "setMinimizeToTray" | "set-minimize-to-tray" => {
            let enabled = arg_bool(&args, 0).unwrap_or(true);
            set_setting(&app, "minimizeToTray", json!(enabled))?;
            Ok(Value::Bool(enabled))
        }
        "getLightweightModeSettings" => Ok(success(json!({
            "settings": {
                "autoEnter": setting(&app, "autoEnterLightweightMode", json!(false))?
                    .as_bool()
                    .unwrap_or(false),
                "delay": setting(&app, "lightweightModeDelay", json!(60))?
                    .as_u64()
                    .unwrap_or(60)
                    .clamp(10, 600),
                "active": setting(&app, "lightweightModeActive", json!(false))?
                    .as_bool()
                    .unwrap_or(false)
            }
        }))),
        "setLightweightModeSettings" => {
            let settings = args.first().cloned().unwrap_or_else(|| json!({}));
            if let Some(auto_enter) = settings.get("autoEnter").and_then(Value::as_bool) {
                set_setting(&app, "autoEnterLightweightMode", json!(auto_enter))?;
            }
            if let Some(delay) = settings.get("delay").and_then(Value::as_u64) {
                set_setting(&app, "lightweightModeDelay", json!(delay.clamp(10, 600)))?;
            }
            Ok(success(json!({})))
        }
        "enterLightweightMode" => {
            set_setting(&app, "lightweightModeActive", json!(true))?;
            window.hide().map_err(|err| err.to_string())?;
            Ok(success(json!({
                "mode": "tray",
                "message": "已进入 Tauri 托盘轻量模式"
            })))
        }
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
            start_ai_proxy_stream(&app, &window, config).await
        }
        "aiProxyStreamAbort" => {
            let request_id = arg_string(&args, 0).unwrap_or_default();
            let aborted = abort_ai_stream(&app, &request_id);
            Ok(json!({ "success": true, "aborted": aborted }))
        }
        "testMediaStreaming" => {
            let service_name = arg_string(&args, 0).unwrap_or_else(|| "Media".to_string());
            let check_url = arg_string(&args, 1);
            test_media_streaming(&app, &service_name, check_url).await
        }
        "runSpeedtest" | "runSpeedtestDirect" => {
            emit_speedtest_output(
                &window,
                json!({
                    "type": "status",
                    "phase": "start",
                    "message": "Speedtest started"
                }),
            );
            emit_speedtest_output(
                &window,
                json!({
                    "type": "progress",
                    "phase": "ping",
                    "progress": 15
                }),
            );
            if let Some(result) = run_ookla_speedtest(&app, &window) {
                return result;
            }
            emit_speedtest_output(
                &window,
                json!({
                    "type": "stdout",
                    "message": "speedtest.exe not found, using lightweight Cloudflare download test"
                }),
            );
            let result = simple_speedtest(&app, false).await;
            match &result {
                Ok(value) => {
                    if let Some(data) = value.get("data") {
                        emit_speedtest_result_events(&window, data);
                    }
                }
                Err(error) => {
                    emit_speedtest_output(
                        &window,
                        json!({
                            "type": "status",
                            "phase": "error",
                            "message": error
                        }),
                    );
                }
            }
            result
        }
        "runProxySpeedtest" => {
            let options = args.first().cloned().unwrap_or_else(|| json!({}));
            let url = args
                .first()
                .and_then(|value| value.get("url"))
                .and_then(Value::as_str)
                .unwrap_or("https://speed.cloudflare.com/__down?bytes=1000000");
            emit_speedtest_output(
                &window,
                json!({
                    "type": "status",
                    "phase": "start",
                    "message": "Proxy speedtest started"
                }),
            );
            let started = now_millis();
            let response = match proxy_speedtest_download(&app, &options, url).await {
                Ok(response) => response,
                Err(error) => {
                    emit_speedtest_output(
                        &window,
                        json!({
                            "type": "status",
                            "phase": "error",
                            "message": error
                        }),
                    );
                    return Ok(json!({ "success": false, "error": error }));
                }
            };
            if let Some(error) = http_failure(&response, "Proxy speedtest failed") {
                emit_speedtest_output(
                    &window,
                    json!({
                        "type": "status",
                        "phase": "error",
                        "message": error
                    }),
                );
                return Ok(json!({
                    "success": false,
                    "error": error,
                    "status": response.get("status").cloned().unwrap_or(Value::Null)
                }));
            }
            let duration = ((now_millis().saturating_sub(started)) as f64 / 1000.0).max(0.001);
            let bytes = response.get("bytes").and_then(Value::as_u64).unwrap_or(0);
            let download_speed = bytes as f64 / duration;
            emit_speedtest_output(
                &window,
                json!({
                    "type": "progress",
                    "phase": "download",
                    "progress": 100,
                    "downloadSpeed": download_speed
                }),
            );
            emit_speedtest_output(
                &window,
                json!({
                    "type": "status",
                    "phase": "complete",
                    "message": "Proxy speedtest completed"
                }),
            );
            Ok(success(json!({ "data": {
                "downloadSpeed": download_speed,
                "bytesReceived": bytes,
                "duration": duration,
                "url": url,
                "proxy": response.get("proxy").cloned().unwrap_or(Value::Null)
            }})))
        }
        "testUdpConnectivity" => {
            test_udp_connectivity(&app, args.first().cloned().unwrap_or_else(|| json!({}))).await
        }

        _ => Ok(unsupported(method)),
    }
}

fn subscription_url_from_protocol_arg(raw: &str) -> Option<String> {
    let candidate = if raw.starts_with("clash://") || raw.starts_with("flyclash://") {
        raw.split_once("?url=")?.1
    } else if raw.contains("?url=") {
        raw.split_once("?url=")?.1
    } else {
        return None;
    };

    let value = candidate.split('&').next().unwrap_or_default();
    let decoded = urlencoding::decode(value).ok()?.to_string();
    let trimmed = decoded.trim();
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        Some(trimmed.to_string())
    } else {
        None
    }
}

fn normalized_protocol_scheme(value: &str) -> Option<String> {
    let scheme = value
        .trim()
        .trim_end_matches("://")
        .trim_end_matches(':')
        .to_ascii_lowercase();
    if scheme.is_empty()
        || !scheme
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '+' || ch == '-' || ch == '.')
    {
        return None;
    }
    Some(scheme)
}

fn import_subscription_from_args<'a, I>(args: I) -> Option<String>
where
    I: IntoIterator<Item = &'a String>,
{
    args.into_iter()
        .find_map(|arg| subscription_url_from_protocol_arg(arg))
}

fn emit_import_subscription(app: &AppHandle, import_url: String) -> bool {
    show_main_window(app);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.emit("import-subscription", import_url);
        true
    } else {
        false
    }
}

fn schedule_import_subscription(app: &AppHandle, import_url: String, delay_ms: u64) {
    let import_app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(delay_ms)).await;
        emit_import_subscription(&import_app, import_url);
    });
}

fn handle_protocol_args(app: &AppHandle, args: &[String]) -> bool {
    if let Some(import_url) = import_subscription_from_args(args.iter()) {
        emit_import_subscription(app, import_url)
    } else {
        show_main_window(app);
        false
    }
}

fn current_deep_link_import(app: &AppHandle) -> Option<String> {
    app.deep_link()
        .get_current()
        .ok()
        .flatten()?
        .into_iter()
        .find_map(|url| subscription_url_from_protocol_arg(url.as_str()))
}

fn main() {
    tauri::Builder::default()
        .manage(AppState::default())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            handle_protocol_args(app, &args);
        }))
        .setup(|app| {
            setup_tray(app.handle())?;
            start_subscription_scheduler(app.handle());
            schedule_mihomo_autostart(app.handle());

            if cfg!(any(windows, target_os = "linux")) {
                if let Err(error) = app.deep_link().register_all() {
                    eprintln!("Failed to register deep link protocols: {error}");
                }
            }

            let pending_tun_enable = setting(app.handle(), "pendingTunEnable", json!(false))
                .ok()
                .and_then(|value| value.as_bool())
                .unwrap_or(false);
            if pending_tun_enable {
                let _ = set_setting(app.handle(), "pendingTunEnable", json!(false));
                let _ = set_setting(app.handle(), "tunModeEnabled", json!(true));
            }

            let deep_link_app = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    if let Some(import_url) = subscription_url_from_protocol_arg(url.as_str()) {
                        emit_import_subscription(&deep_link_app, import_url);
                    }
                }
            });

            if let Some(window) = app.get_webview_window("main") {
                let mode = setting(app.handle(), "appearanceMode", json!("dynamic"))
                    .ok()
                    .and_then(|value| value.as_str().map(ToString::to_string))
                    .unwrap_or_else(|| "dynamic".to_string());
                let _ = apply_appearance_mode(&window, &mode);

                let close_app = app.handle().clone();
                window.on_window_event(move |event| match event {
                    WindowEvent::CloseRequested { api, .. } => {
                        let minimize_to_tray = setting(&close_app, "minimizeToTray", json!(true))
                            .ok()
                            .and_then(|value| value.as_bool())
                            .unwrap_or(true);
                        if minimize_to_tray {
                            api.prevent_close();
                            if let Some(window) = close_app.get_webview_window("main") {
                                let _ = window.hide();
                            }

                            let auto_enter =
                                setting(&close_app, "autoEnterLightweightMode", json!(false))
                                    .ok()
                                    .and_then(|value| value.as_bool())
                                    .unwrap_or(false);
                            if auto_enter {
                                let delay = setting(&close_app, "lightweightModeDelay", json!(60))
                                    .ok()
                                    .and_then(|value| value.as_u64())
                                    .unwrap_or(60)
                                    .clamp(10, 600);
                                let timer_app = close_app.clone();
                                tauri::async_runtime::spawn(async move {
                                    tokio::time::sleep(Duration::from_secs(delay)).await;
                                    let still_hidden = timer_app
                                        .get_webview_window("main")
                                        .map(|window| !window.is_visible().unwrap_or(false))
                                        .unwrap_or(false);
                                    if still_hidden {
                                        let _ = set_setting(
                                            &timer_app,
                                            "lightweightModeActive",
                                            json!(true),
                                        );
                                    }
                                });
                            }
                        }
                    }
                    WindowEvent::Resized(_) => {
                        if let Some(window) = close_app.get_webview_window("main") {
                            emit_window_state(&window);
                        }
                    }
                    _ => {}
                });

                let args = std::env::args().collect::<Vec<_>>();
                if let Some(import_url) = import_subscription_from_args(args.iter())
                    .or_else(|| current_deep_link_import(app.handle()))
                {
                    schedule_import_subscription(app.handle(), import_url, 1200);
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![tauri_compat_call])
        .run(tauri::generate_context!())
        .expect("error while running FlyClash Tauri application");
}
