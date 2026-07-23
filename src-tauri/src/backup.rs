use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use regex::Regex;
use rusqlite::params;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

use crate::{
    core_lifecycle_commands::refresh_active_config_after_override,
    profiles::{
        config_content, parse_traffic_string, read_last_config, read_subscriptions,
        save_last_config, save_subscription, sync_runtime_active_config_from_settings,
    },
    state::AppState,
    storage::{app_data_dir, database_path, db, encryption_key_path, set_setting, setting},
    tray::refresh_tray_menu_after,
};

type CompatResult = Result<Value, String>;

const MAX_WEBDAV_BACKUP_BYTES: u64 = 512 * 1024 * 1024;

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

pub(crate) fn backup_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app_data_dir(app)?.join("backups");
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    Ok(dir)
}

pub(crate) fn backup_file_name() -> String {
    format!("flyclash_backup_{}.zip", now_millis())
}

pub(crate) fn ensure_zip_extension(path: PathBuf) -> PathBuf {
    if path.extension().and_then(|value| value.to_str()) == Some("zip") {
        path
    } else {
        path.with_extension("zip")
    }
}

fn validate_backup_file_name(file_name: &str) -> Result<String, String> {
    let file_name = file_name.trim();
    if file_name.is_empty() {
        return Err("缺少备份文件名".to_string());
    }
    if file_name.len() > 255
        || file_name == "."
        || file_name == ".."
        || file_name.contains(['/', '\\', ':', '\0'])
    {
        return Err("备份文件名无效".to_string());
    }
    if !file_name.to_ascii_lowercase().ends_with(".zip") {
        return Err("备份文件必须使用 .zip 扩展名".to_string());
    }
    Ok(file_name.to_string())
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

pub(crate) fn create_backup_zip_at(
    app: &AppHandle,
    backup_type: &str,
    path: &Path,
) -> CompatResult {
    let file = fs::File::create(path).map_err(|err| err.to_string())?;
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
        "proxyIconConfig": crate::proxy_icons::proxy_icon_config(app)
            .unwrap_or_else(|_| crate::proxy_icons::proxy_icon_default_config()),
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

pub(crate) fn create_backup_zip(app: &AppHandle, backup_type: &str) -> CompatResult {
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

pub(crate) fn restore_backup_zip(app: &AppHandle, path: &Path) -> CompatResult {
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

pub(crate) async fn finalize_backup_restore(
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

pub(crate) fn webdav_config(app: &AppHandle) -> Result<Value, String> {
    Ok(json!({
        "uri": setting(app, "webdav_uri", json!(""))?,
        "username": setting(app, "webdav_username", json!(""))?,
        "password": setting(app, "webdav_password", json!(""))?,
        "backupDirectory": setting(app, "webdav_backup_dir", json!("FlyClash"))?,
        "fileName": setting(app, "webdav_backup_filename", json!("flyclash_backup.zip"))?
    }))
}

pub(crate) fn webdav_config_text(config: &Value, key: &str, fallback: &str) -> String {
    config
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or(fallback)
        .trim()
        .to_string()
}

pub(crate) fn webdav_validate_config(config: &Value) -> Result<(), String> {
    let uri = webdav_config_text(config, "uri", "");
    let username = webdav_config_text(config, "username", "");
    let password = webdav_config_text(config, "password", "");
    if uri.is_empty() || username.is_empty() || password.is_empty() {
        return Err("WebDAV配置不完整".to_string());
    }

    let url = reqwest::Url::parse(&uri).map_err(|_| "WebDAV地址无效".to_string())?;
    if url.scheme() != "https" || url.host_str().is_none() {
        return Err("WebDAV地址必须是有效的 HTTPS 地址".to_string());
    }
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("WebDAV地址不能包含凭据、查询参数或片段".to_string());
    }
    Ok(())
}

fn webdav_base_url(config: &Value) -> Result<String, String> {
    webdav_validate_config(config)?;
    Ok(webdav_config_text(config, "uri", "")
        .trim_end_matches('/')
        .to_string())
}

pub(crate) fn webdav_root_url(config: &Value) -> Result<String, String> {
    webdav_base_url(config)
}

fn webdav_dir_segments(config: &Value) -> Result<Vec<String>, String> {
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
            (!part.is_empty()).then_some(part)
        })
        .map(|part| {
            if matches!(part, "." | "..") || part.contains(['\\', ':', '\0']) {
                Err("WebDAV备份目录包含无效路径段".to_string())
            } else {
                Ok(urlencoding::encode(part).into_owned())
            }
        })
        .collect()
}

fn webdav_directory_url(config: &Value, segment_count: Option<usize>) -> Result<String, String> {
    let base = webdav_base_url(config)?;
    let segments = webdav_dir_segments(config)?;
    let take = segment_count.unwrap_or(segments.len()).min(segments.len());
    if take == 0 {
        Ok(base)
    } else {
        Ok(format!("{base}/{}", segments[..take].join("/")))
    }
}

pub(crate) fn webdav_url(config: &Value, file_name: Option<&str>) -> Result<String, String> {
    let mut url = webdav_directory_url(config, None)?;
    if let Some(file) = file_name {
        let file = validate_backup_file_name(file)?;
        url.push('/');
        url.push_str(&urlencoding::encode(&file));
    }
    Ok(url)
}

pub(crate) async fn webdav_request(
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
        .timeout(std::time::Duration::from_secs(60))
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

pub(crate) fn webdav_error_message(result: &Value, fallback: &str) -> String {
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

pub(crate) async fn webdav_ensure_directory(config: &Value) -> Result<(), String> {
    let segments = webdav_dir_segments(config)?;
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

pub(crate) fn emit_backup_progress(
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

async fn dispatch_compat_call(
    app: &AppHandle,
    window: &WebviewWindow,
    state: &State<'_, AppState>,
    method: &str,
    args: &[Value],
) -> CompatResult {
    match method {
        "backupCreateLocal" | "backup-create-local" => {
            let backup_type = arg_string(args, 0).unwrap_or_else(|| "CONFIG_ONLY".to_string());
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
                create_backup_zip_at(app, &backup_type, &ensure_zip_extension(path))
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
                let result = restore_backup_zip(app, &path)?;
                finalize_backup_restore(app, state, result).await
            } else {
                Ok(json!({ "success": false, "canceled": true, "error": "用户取消" }))
            }
        }
        "backupWebDAVSaveConfig" | "backup-webdav-save-config" => {
            let config = args.first().cloned().unwrap_or_else(|| json!({}));
            webdav_validate_config(&config)?;
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
            webdav_dir_segments(&config)?;
            let backup_file_name = validate_backup_file_name(backup_file_name)?;
            set_setting(
                app,
                "webdav_uri",
                config.get("uri").cloned().unwrap_or_else(|| json!("")),
            )?;
            set_setting(
                app,
                "webdav_username",
                config.get("username").cloned().unwrap_or_else(|| json!("")),
            )?;
            set_setting(
                app,
                "webdav_password",
                config.get("password").cloned().unwrap_or_else(|| json!("")),
            )?;
            set_setting(app, "webdav_backup_dir", json!(backup_directory))?;
            set_setting(app, "webdav_backup_filename", json!(backup_file_name))?;
            Ok(success(json!({})))
        }
        "backupWebDAVGetConfig" | "backup-webdav-get-config" => {
            Ok(success(json!({ "config": webdav_config(app)? })))
        }
        "backupWebDAVTest" | "backup-webdav-test" => {
            let config = args
                .first()
                .cloned()
                .unwrap_or_else(|| webdav_config(app).unwrap_or_else(|_| json!({})));
            let url = match webdav_root_url(&config) {
                Ok(url) => url,
                Err(error) => return Ok(json!({ "success": false, "error": error })),
            };
            let result = match webdav_request(&config, "PROPFIND", url, None, Some("0")).await {
                Ok(result) => result,
                Err(error) => return Ok(json!({ "success": false, "error": error })),
            };
            if result
                .get("success")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                Ok(success(json!({})))
            } else {
                Ok(json!({
                    "success": false,
                    "error": webdav_error_message(&result, "WebDAV连接测试失败")
                }))
            }
        }
        "backupWebDAVUpload" | "backup-webdav-upload" => {
            let config = webdav_config(app)?;
            if let Err(error) = webdav_validate_config(&config) {
                return Ok(json!({ "success": false, "uploaded": false, "error": error }));
            }
            let local = create_backup_zip(
                app,
                &arg_string(args, 0).unwrap_or_else(|| "CONFIG_ONLY".to_string()),
            )?;
            let file_path = local
                .get("filePath")
                .and_then(Value::as_str)
                .ok_or_else(|| "备份创建失败".to_string())?;
            let mut file_name = webdav_config_text(&config, "fileName", "flyclash_backup.zip");
            if file_name.is_empty() {
                file_name = "flyclash_backup.zip".to_string();
            }
            let file_name = match validate_backup_file_name(&file_name) {
                Ok(file_name) => file_name,
                Err(error) => {
                    return Ok(json!({ "success": false, "uploaded": false, "error": error }));
                }
            };
            if let Err(error) = webdav_ensure_directory(&config).await {
                return Ok(json!({ "success": false, "uploaded": false, "error": error }));
            }
            let bytes = fs::read(file_path).map_err(|err| err.to_string())?;
            let total = bytes.len() as u64;
            emit_backup_progress(window, "backup-upload-progress", "uploaded", 0, total);
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
                emit_backup_progress(window, "backup-upload-progress", "uploaded", total, total);
            }
            Ok(success(
                json!({ "fileName": file_name, "uploaded": uploaded }),
            ))
        }
        "backupWebDAVDownload" | "backup-webdav-download" => {
            let config = webdav_config(app)?;
            if let Err(error) = webdav_validate_config(&config) {
                return Ok(json!({ "success": false, "error": error }));
            }
            let file_name = arg_string(args, 0)
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| webdav_config_text(&config, "fileName", "flyclash_backup.zip"));
            let file_name = match validate_backup_file_name(&file_name) {
                Ok(file_name) => file_name,
                Err(error) => {
                    return Ok(json!({ "success": false, "error": error, "restored": false }));
                }
            };
            let url = webdav_url(&config, Some(&file_name))?;
            let client = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(60))
                .build()
                .map_err(|err| err.to_string())?;
            let response = client
                .get(url)
                .basic_auth(
                    webdav_config_text(&config, "username", ""),
                    Some(webdav_config_text(&config, "password", "")),
                )
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
            if total > MAX_WEBDAV_BACKUP_BYTES {
                return Ok(json!({
                    "success": false,
                    "restored": false,
                    "error": "备份文件超过 512 MiB 限制"
                }));
            }
            emit_backup_progress(window, "backup-download-progress", "downloaded", 0, total);
            let mut downloaded = 0u64;
            let mut bytes = Vec::new();
            let mut response = response;
            while let Some(chunk) = response.chunk().await.map_err(|err| err.to_string())? {
                downloaded = downloaded.saturating_add(chunk.len() as u64);
                if downloaded > MAX_WEBDAV_BACKUP_BYTES {
                    return Ok(json!({
                        "success": false,
                        "restored": false,
                        "error": "备份文件超过 512 MiB 限制"
                    }));
                }
                bytes.extend_from_slice(&chunk);
                emit_backup_progress(
                    window,
                    "backup-download-progress",
                    "downloaded",
                    downloaded,
                    total,
                );
            }
            let path = backup_dir(app)?.join(&file_name);
            fs::write(&path, &bytes).map_err(|err| err.to_string())?;
            emit_backup_progress(
                window,
                "backup-download-progress",
                "downloaded",
                if total > 0 { total } else { downloaded },
                if total > 0 { total } else { downloaded },
            );
            let result = restore_backup_zip(app, &path)?;
            finalize_backup_restore(app, state, result).await
        }
        "backupWebDAVList" | "backup-webdav-list" => {
            let config = webdav_config(app)?;
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
                    let name = validate_backup_file_name(&name).ok()?;
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
            let config = webdav_config(app)?;
            let file_name = arg_string(args, 0).unwrap_or_default();
            let file_name = match validate_backup_file_name(&file_name) {
                Ok(file_name) => file_name,
                Err(error) => {
                    return Ok(json!({ "success": false, "deleted": false, "error": error }));
                }
            };
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
        _ => Err(format!("Unsupported backup method: {method}")),
    }
}

pub(crate) async fn handle_compat_call(
    app: &AppHandle,
    window: &WebviewWindow,
    state: &State<'_, AppState>,
    method: &str,
    args: &[Value],
) -> Option<CompatResult> {
    if !matches!(
        method,
        "backupCreateLocal"
            | "backup-create-local"
            | "backupRestoreLocal"
            | "backup-restore-local"
            | "backupWebDAVSaveConfig"
            | "backup-webdav-save-config"
            | "backupWebDAVGetConfig"
            | "backup-webdav-get-config"
            | "backupWebDAVTest"
            | "backup-webdav-test"
            | "backupWebDAVUpload"
            | "backup-webdav-upload"
            | "backupWebDAVDownload"
            | "backup-webdav-download"
            | "backupWebDAVList"
            | "backup-webdav-list"
            | "backupWebDAVDelete"
            | "backup-webdav-delete"
    ) {
        return None;
    }

    Some(dispatch_compat_call(app, window, state, method, args).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backup_file_name_must_be_a_flat_zip_file() {
        assert_eq!(
            validate_backup_file_name(" archive.ZIP ").unwrap(),
            "archive.ZIP"
        );
        for value in [
            "",
            "../backup.zip",
            "nested/backup.zip",
            "C:\\backup.zip",
            "backup.tar",
        ] {
            assert!(
                validate_backup_file_name(value).is_err(),
                "{value} must be rejected"
            );
        }
    }

    #[test]
    fn webdav_url_rejects_path_traversal_segments() {
        let config = json!({
            "uri": "https://dav.example.test/root",
            "username": "user",
            "password": "password",
            "backupDirectory": "FlyClash/../other"
        });
        assert!(webdav_url(&config, Some("backup.zip")).is_err());
    }
}
