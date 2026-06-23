use serde_json::{json, Map, Value};
use std::time::Duration;
use tauri::AppHandle;

use crate::app::mihomo_mixed_port;
use crate::fetch::FetchOptions;
use crate::runtime::active_runtime_controller_endpoint;

type CompatResult = Result<Value, String>;

pub(crate) async fn request(
    app: &AppHandle,
    target: Option<String>,
    options: Option<Value>,
) -> CompatResult {
    request_inner(app, target, options, false).await
}

pub(crate) async fn request_via_proxy(
    app: &AppHandle,
    target: Option<String>,
    options: Option<Value>,
) -> CompatResult {
    request_inner(app, target, options, true).await
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

async fn request_inner(
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

    let timeout = Duration::from_millis(options.timeout.unwrap_or(30_000));
    let mut client_builder = reqwest::Client::builder()
        .timeout(timeout)
        .danger_accept_invalid_certs(true);
    if use_proxy {
        let proxy_url = fetch_proxy_url(app, options.proxy.as_ref())?;
        client_builder =
            client_builder.proxy(reqwest::Proxy::all(&proxy_url).map_err(|err| err.to_string())?);
    }
    let client = client_builder.build().map_err(|err| err.to_string())?;
    let method = options
        .method
        .parse::<reqwest::Method>()
        .map_err(|err| err.to_string())?;
    let mut request = client.request(method, &endpoint);

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

    Ok(json!({
        "ok": status.is_success(),
        "status": status.as_u16(),
        "statusText": status_text,
        "headers": headers,
        "data": data,
        "text": text
    }))
}
