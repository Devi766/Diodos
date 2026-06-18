#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::{fs, path::PathBuf};
use tauri::{AppHandle, Manager, WebviewWindow};

type CompatResult = Result<Value, String>;

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

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|err| err.to_string())?;
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    Ok(dir.join("settings.json"))
}

fn read_settings(app: &AppHandle) -> Result<Map<String, Value>, String> {
    let path = settings_path(app)?;
    if !path.exists() {
        return Ok(Map::new());
    }

    let content = fs::read_to_string(path).map_err(|err| err.to_string())?;
    let value = serde_json::from_str::<Value>(&content).unwrap_or_else(|_| json!({}));
    Ok(value.as_object().cloned().unwrap_or_default())
}

fn write_settings(app: &AppHandle, settings: &Map<String, Value>) -> Result<(), String> {
    let path = settings_path(app)?;
    let content = serde_json::to_string_pretty(settings).map_err(|err| err.to_string())?;
    fs::write(path, content).map_err(|err| err.to_string())
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
        let host = setting(app, "controllerHost", json!("127.0.0.1"))?
            .as_str()
            .unwrap_or("127.0.0.1")
            .to_string();
        let port = setting(app, "controllerPort", json!("9090"))?
            .as_str()
            .map(ToString::to_string)
            .or_else(|| {
                setting(app, "controllerPort", json!(9090))
                    .ok()?
                    .as_i64()
                    .map(|p| p.to_string())
            })
            .unwrap_or_else(|| "9090".to_string());
        format!("http://{host}:{port}{endpoint}")
    };

    let timeout = std::time::Duration::from_millis(options.timeout.unwrap_or(30_000));
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

    if let Some(secret) = setting(app, "secret", json!(""))?.as_str() {
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

    Ok(json!({
        "ok": status.is_success(),
        "status": status.as_u16(),
        "statusText": status_text,
        "headers": headers,
        "data": data,
        "text": text
    }))
}

#[tauri::command]
async fn tauri_compat_call(
    app: AppHandle,
    window: WebviewWindow,
    request: CompatRequest,
) -> CompatResult {
    let method = request.method.as_str();
    let args = request.args;

    match method {
        "getAppVersion" => Ok(Value::String(app.package_info().version.to_string())),
        "getPlatform" => Ok(Value::String(std::env::consts::OS.to_string())),
        "debugLog" => Ok(Value::Null),
        "loadPage" => Ok(success(json!({}))),

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

        "getApiConfig" => Ok(success(json!({
            "controllerHost": setting(&app, "controllerHost", json!("127.0.0.1"))?,
            "controllerPort": setting(&app, "controllerPort", json!("9090"))?,
            "secret": setting(&app, "secret", json!(""))?
        }))),
        "requestMihomoAPI" => request_http(&app, arg_string(&args, 0), args.get(1).cloned()).await,
        "proxyFetch" => request_http(&app, arg_string(&args, 0), args.get(1).cloned()).await,
        "fetchWithProxy" => request_http(&app, None, args.first().cloned()).await,

        "openExternal" => {
            if let Some(target) = arg_string(&args, 0) {
                open::that(target).map_err(|err| err.to_string())?;
            }
            Ok(success(json!({})))
        }
        "openFile" => {
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

        "getProxyStatus" | "getTunStatus" | "checkElevateTask" | "isMihomoRunning" => {
            Ok(Value::Bool(false))
        }
        "toggleSystemProxy" | "toggleTunMode" | "startMihomo" | "stopMihomo"
        | "reloadMihomoConfig" => Ok(arg_bool(&args, 0)
            .map(Value::Bool)
            .unwrap_or(Value::Bool(false))),
        "getTrafficStats" => Ok(json!({
            "up": 0,
            "down": 0,
            "upSpeed": 0,
            "downSpeed": 0,
            "timestamp": chrono_millis()
        })),
        "fetchConnectionsInfo" => {
            Ok(json!({ "connections": [], "downloadTotal": 0, "uploadTotal": 0 }))
        }
        "getSubscriptions" => Ok(json!([])),
        "getConfigOrder" => Ok(success(json!({ "data": [] }))),
        "getActiveConfig" => Ok(Value::Null),
        "getProxies" | "getProxyNodes" => Ok(json!({ "proxies": {}, "providers": {} })),
        "getProxyConfig" => Ok(success(
            json!({ "data": { "host": "127.0.0.1", "port": 7890 } }),
        )),

        _ => Ok(unsupported(method)),
    }
}

fn chrono_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![tauri_compat_call])
        .run(tauri::generate_context!())
        .expect("error while running FlyClash Tauri application");
}
