use serde_json::{json, Map, Value};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow, WindowEvent};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_mihomo::RejectPolicy;

use crate::core::{config as core_config, controller as core_controller};
use crate::core_lifecycle_commands::{
    refresh_active_config_after_override, schedule_mihomo_autostart,
};
use crate::fetch::FetchOptions;
use crate::platform::{
    apply_appearance_mode, emit_window_state, handle_compat_call as handle_platform_compat_call,
    show_main_window,
};
use crate::profiles::{
    allowed_subscription_ua_key, config_content, read_last_config, save_config_content,
};
use crate::resources::{mihomo_dir, sync_bundled_mihomo_data};
use crate::runtime::active_runtime_controller_endpoint;
use crate::state::AppState;
use crate::storage::{read_settings, set_setting, setting, write_settings};
use crate::tray::setup_tray;

type CompatResult = Result<Value, String>;

pub(crate) const KERNEL_FIELDS: &[&str] = &[
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

pub(crate) fn config_yaml(app: &AppHandle, file_path: &str) -> Result<serde_yaml::Value, String> {
    let content = config_content(app, file_path)?;
    serde_yaml::from_str::<serde_yaml::Value>(&content).map_err(|err| err.to_string())
}

pub(crate) fn save_config_yaml(
    app: &AppHandle,
    file_path: &str,
    yaml: &serde_yaml::Value,
) -> Result<(), String> {
    let content = serde_yaml::to_string(yaml).map_err(|err| err.to_string())?;
    save_config_content(app, file_path, &content)
}

pub(crate) fn yaml_key(key: &str) -> serde_yaml::Value {
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

pub(crate) fn default_dns_config() -> Value {
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

pub(crate) fn default_tun_config() -> Value {
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

pub(crate) fn non_empty_object(value: &Value) -> bool {
    value
        .as_object()
        .map(|object| !object.is_empty())
        .unwrap_or(false)
}

pub(crate) fn merge_object_setting(app: &AppHandle, key: &str, value: Value) -> Result<(), String> {
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

pub(crate) fn user_settings_view(app: &AppHandle) -> Result<Value, String> {
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

pub(crate) fn save_proxy_settings(app: &AppHandle, settings: Value) -> Result<bool, String> {
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

pub(crate) fn hosts_to_map(hosts: Value) -> Value {
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

pub(crate) fn save_yaml_section_value(
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

pub(crate) fn save_kernel_yaml(
    app: &AppHandle,
    file_path: &str,
    value: Value,
) -> Result<(), String> {
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

pub(crate) fn geodata_config_patch_body(
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

pub(crate) async fn patch_active_geodata_config(
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

pub(crate) fn ensure_tun_dns_defaults(app: &AppHandle) -> Result<(), String> {
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

pub(crate) fn yaml_section(app: &AppHandle, file_path: Option<String>, key: &str) -> CompatResult {
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

pub(crate) fn yaml_save_section(
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

pub(crate) fn yaml_root_pick(
    app: &AppHandle,
    file_path: Option<String>,
    keys: &[&str],
) -> CompatResult {
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

pub(crate) fn mihomo_mixed_port(app: &AppHandle) -> u16 {
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

fn kernel_setting_string(app: &AppHandle, key: &str) -> Option<String> {
    setting(app, "kernel", json!({})).ok().and_then(|value| {
        value
            .get(key)
            .and_then(Value::as_str)
            .map(ToString::to_string)
    })
}

pub(crate) fn controller_secret(app: &AppHandle) -> String {
    if let Some(secret) = setting(app, "secret", json!(""))
        .ok()
        .and_then(|value| value.as_str().map(ToString::to_string))
        .filter(|value| !value.is_empty())
    {
        return secret;
    }

    kernel_setting_string(app, "secret").unwrap_or_default()
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

pub(crate) fn runtime_config_error_response(
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

pub(crate) fn prepare_runtime_config(
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
        |config| crate::overrides::apply_overrides(app, config_path, config),
    )
}

pub(crate) async fn request_http(
    app: &AppHandle,
    target: Option<String>,
    options: Option<Value>,
) -> CompatResult {
    request_http_inner(app, target, options, false).await
}

pub(crate) async fn request_http_via_proxy(
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
            ..FetchOptions::default()
        },
    };

    let endpoint = target.or(options.url.clone()).unwrap_or_default();
    if endpoint.is_empty() {
        return Err("missing request url".to_string());
    }

    let is_absolute_url = endpoint.starts_with("http://") || endpoint.starts_with("https://");
    if !is_absolute_url && !use_proxy {
        return crate::mihomo_ipc::request(
            app,
            active_runtime_controller_endpoint(app),
            endpoint,
            options,
        )
        .await;
    }

    if !is_absolute_url {
        return Ok(crate::mihomo_ipc::failure(
            &active_runtime_controller_endpoint(app),
            400,
            "Mihomo controller HTTP fallback has been disabled; use IPC endpoints only",
        ));
    }

    let url = endpoint;

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

    let payload = json!({
        "ok": status.is_success(),
        "status": status.as_u16(),
        "statusText": status_text,
        "headers": headers,
        "data": data,
        "text": text
    });

    Ok(payload)
}

pub(crate) fn parse_config_order(app: &AppHandle, config_path: Option<String>) -> Value {
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
                    let group_type = group
                        .get("type")
                        .and_then(|value| value.as_str())
                        .unwrap_or("select");
                    let hidden = group
                        .get("hidden")
                        .and_then(|value| value.as_bool())
                        .unwrap_or(false);
                    let proxies = yaml_string_array(group.get("proxies"));
                    let icon = group
                        .get("icon")
                        .and_then(|value| value.as_str())
                        .map(ToString::to_string);
                    Some(json!({
                        "name": name,
                        "type": group_type,
                        "proxies": proxies,
                        "hidden": hidden,
                        "icon": icon
                    }))
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

pub(crate) fn parse_proxy_nodes_config(app: &AppHandle, config_path: &str) -> Value {
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

    json!({
        "proxyGroups": proxy_groups,
        "proxies": proxies,
        "apiConfig": {
            "controllerMode": "ipc",
            "socketPath": controller_endpoint.path,
            "socketArg": controller_endpoint.arg_name,
            "httpFallback": false,
            "external-controller": Value::Null,
            "secret": controller_secret(app),
            "controllerHost": Value::Null,
            "controllerPort": Value::Null
        }
    })
}

pub(crate) fn default_sniffer_config() -> Value {
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

pub(crate) async fn handle_compat_call(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    method: String,
    args: Vec<Value>,
) -> CompatResult {
    let method = method.as_str();

    if let Some(result) = crate::converter::handle_compat_call(&app, &state, method, &args).await {
        return result;
    }
    if let Some(result) = handle_platform_compat_call(&app, &window, method, &args).await {
        return result;
    }
    if let Some(result) = crate::network_tools::handle_compat_call(
        &app,
        &window,
        mihomo_mixed_port(&app),
        method,
        &args,
    )
    .await
    {
        return result;
    }
    if let Some(result) = crate::proxy_icons::handle_compat_call(&app, method, &args).await {
        return result;
    }
    if let Some(result) = crate::telemetry::handle_compat_call(&app, method, &args).await {
        return result;
    }
    if let Some(result) = crate::overrides::handle_compat_call(&app, method, &args).await {
        let outcome = result?;
        let runtime_reload = if outcome.requires_runtime_reload() {
            Some(refresh_active_config_after_override(&app, &state).await)
        } else {
            None
        };
        return Ok(outcome.into_response(runtime_reload));
    }
    if let Some(result) = crate::ai_proxy::handle_compat_call(&app, &window, method, &args).await {
        return result;
    }
    if let Some(result) =
        crate::mihomo_controller::handle_compat_call(&app, &window, &state, method, &args).await
    {
        return result;
    }
    if let Some(result) =
        crate::backup::handle_compat_call(&app, &window, &state, method, &args).await
    {
        return result;
    }

    if let Some(result) =
        crate::tun_service::handle_compat_call(&app, &window, &state, method, &args).await
    {
        return result;
    }

    if let Some(result) =
        crate::subscription_commands::handle_compat_call(&app, &state, method, &args).await
    {
        return result;
    }
    if let Some(result) =
        crate::core_commands::handle_compat_call(&app, &window, &state, method, &args).await
    {
        return result;
    }
    if let Some(result) = crate::settings_commands::handle_compat_call(&app, method, &args).await {
        return result;
    }
    if let Some(result) = crate::open_commands::handle_compat_call(&app, method, &args).await {
        return result;
    }
    if let Some(result) =
        crate::config_commands::handle_compat_call(&app, &window, &state, method, &args).await
    {
        return result;
    }

    if let Some(result) =
        crate::runtime_commands::handle_compat_call(&app, &window, &state, method, &args).await
    {
        return result;
    }

    Ok(unsupported(method))
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

pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(
            tauri_plugin_mihomo::Builder::new()
                .protocol(tauri_plugin_mihomo::models::Protocol::LocalSocket)
                .socket_path(core_controller::sidecar_endpoint().path)
                .pool_config(
                    tauri_plugin_mihomo::IpcPoolConfigBuilder::new()
                        .min_connections(3)
                        .max_connections(32)
                        .idle_timeout(Duration::from_secs(60))
                        .health_check_interval(Duration::from_secs(60))
                        .reject_policy(RejectPolicy::Wait)
                        .build(),
                )
                .build(),
        )
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            handle_protocol_args(app, &args);
        }))
        .setup(|app| {
            setup_tray(app.handle())?;
            crate::subscription_commands::start_subscription_scheduler(app.handle());
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
        .invoke_handler(tauri::generate_handler![crate::compat::tauri_compat_call])
        .run(tauri::generate_context!())
        .expect("error while running FlyClash Tauri application");
}
