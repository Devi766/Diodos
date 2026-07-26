use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose, Engine as _};
use regex::Regex;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::AppHandle;

use crate::storage::{app_data_dir, set_setting, setting};

type CompatResult = Result<Value, String>;

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

fn arg_bool(args: &[Value], index: usize) -> Option<bool> {
    args.get(index).and_then(Value::as_bool)
}

pub(crate) fn proxy_icon_default_config() -> Value {
    json!({ "enabled": true, "rules": [] })
}

pub(crate) fn proxy_icon_config(app: &AppHandle) -> Result<Value, String> {
    setting(app, "proxyIconConfig", proxy_icon_default_config())
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

/// 校验图标 URL 是否可安全下载。图标来自不可信的订阅/配置，
/// 只允许 http/https，并拒绝指向本机/内网的地址，防止盲 SSRF。
fn icon_remote_url_allowed(url: &str) -> bool {
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return false;
    };
    if !matches!(parsed.scheme(), "http" | "https") {
        return false;
    }
    let Some(host) = parsed.host_str() else {
        return false;
    };
    if host.eq_ignore_ascii_case("localhost") {
        return false;
    }
    let host = host.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        return match ip {
            std::net::IpAddr::V4(v4) => {
                !(v4.is_loopback() || v4.is_private() || v4.is_link_local() || v4.is_unspecified())
            }
            std::net::IpAddr::V6(v6) => !(v6.is_loopback() || v6.is_unspecified()),
        };
    }
    // 普通域名放行（DNS 重定向的残余风险已由禁用本地读取 + 盲响应限制）
    true
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

    // 不把订阅/配置里的 icon 当本地路径读取：否则不可信订阅可让客户端
    // 读取本机任意文件内容。仅接受可安全下载的 http/https 远程地址。
    let target_url = if !use_favicon_for_sites || is_icon_image_url(&icon_url) {
        icon_url.clone()
    } else {
        favicon_url(&icon_url)
    };
    if !icon_remote_url_allowed(&target_url) {
        return Ok(None);
    }
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
        .timeout(std::time::Duration::from_secs(10))
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

pub(crate) async fn handle_compat_call(
    app: &AppHandle,
    method: &str,
    args: &[Value],
) -> Option<CompatResult> {
    if !method.starts_with("proxyIcon.")
        && !method.starts_with("proxy-icon:")
        && !method.starts_with("configIcon.")
        && !method.starts_with("config-icon:")
    {
        return None;
    }

    Some(dispatch_compat_call(app, method, args).await)
}

async fn dispatch_compat_call(app: &AppHandle, method: &str, args: &[Value]) -> CompatResult {
    match method {
        "proxyIcon.getConfig" | "proxy-icon:get-config" => {
            Ok(success(json!({ "config": proxy_icon_config(app)? })))
        }
        "proxyIcon.saveConfig" | "proxy-icon:save-config" => save_proxy_icon_config(
            app,
            args.first()
                .cloned()
                .unwrap_or_else(proxy_icon_default_config),
        ),
        "proxyIcon.addRule" | "proxy-icon:add-rule" => proxy_icon_rule_update(
            app,
            None,
            args.first().cloned().unwrap_or_else(|| json!({})),
            "add",
        ),
        "proxyIcon.updateRule" | "proxy-icon:update-rule" => {
            let (rule_id, updates) = if args.first().and_then(Value::as_str).is_some() {
                (
                    arg_string(args, 0),
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
            proxy_icon_rule_update(app, rule_id, updates, "update")
        }
        "proxyIcon.deleteRule" | "proxy-icon:delete-rule" => {
            proxy_icon_rule_update(app, arg_string(args, 0), Value::Null, "delete")
        }
        "proxyIcon.toggleRule" | "proxy-icon:toggle-rule" => proxy_icon_rule_update(
            app,
            arg_string(args, 0),
            Value::Bool(arg_bool(args, 1).unwrap_or(false)),
            "toggle",
        ),
        "proxyIcon.clearCache" | "proxy-icon:clear-cache" => clear_icon_cache(app, "icon-cache"),
        "proxyIcon.getGroupIcon" | "proxy-icon:get-group-icon" => {
            proxy_group_icon(
                app,
                &arg_string(args, 0).unwrap_or_default(),
                arg_string(args, 1),
            )
            .await
        }
        "configIcon.getIcon" | "config-icon:get-icon" => {
            config_icon_get(
                app,
                arg_string(args, 0).unwrap_or_default(),
                arg_string(args, 1).unwrap_or_default(),
            )
            .await
        }
        "configIcon.clearCache" | "config-icon:clear-cache" => {
            clear_icon_cache(app, "config-icons")
        }
        "configIcon.getCacheSize" | "config-icon:get-cache-size" => {
            icon_cache_size(app, "config-icons")
        }
        _ => Err(format!("Unsupported proxy icon method: {method}")),
    }
}
