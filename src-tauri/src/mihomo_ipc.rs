use serde_json::{json, Value};
use tauri::AppHandle;

use crate::{core::controller::ControllerEndpoint, fetch::FetchOptions};

pub(crate) async fn request(
    _app: &AppHandle,
    controller_endpoint: ControllerEndpoint,
    endpoint: String,
    options: FetchOptions,
) -> Result<Value, String> {
    let method = options.method.to_ascii_uppercase();
    let path = endpoint_path(&endpoint);
    let segments = endpoint_segments(&path);
    let segment_refs = segments.iter().map(String::as_str).collect::<Vec<_>>();
    let body = fetch_body_json(options.body.as_ref())?;

    if !is_supported_route(method.as_str(), segment_refs.as_slice()) {
        return Ok(failure(
            &controller_endpoint,
            400,
            format!("Unsupported Mihomo IPC endpoint: {} {}", method, endpoint),
        ));
    }

    if matches!(
        (method.as_str(), segment_refs.as_slice()),
        ("PUT", ["proxies", _])
    ) && body_string_field(&body, "name").is_none()
    {
        return Ok(failure(&controller_endpoint, 400, "缺少代理节点名称"));
    }

    if matches!(
        (method.as_str(), segment_refs.as_slice()),
        ("PUT", ["configs"])
    ) && body_string_field(&body, "path").is_none()
    {
        return Ok(failure(&controller_endpoint, 400, "缺少配置文件路径"));
    }

    local_socket_response(
        &controller_endpoint,
        &method,
        &endpoint_target(&endpoint),
        &body,
        options.timeout,
    )
    .await
}

pub(crate) fn failure(
    controller_endpoint: &ControllerEndpoint,
    status: u16,
    error: impl Into<String>,
) -> Value {
    let error = error.into();
    response(
        controller_endpoint,
        false,
        status,
        json!({ "message": error.clone() }),
        error,
    )
}

fn response(
    controller_endpoint: &ControllerEndpoint,
    ok: bool,
    status: u16,
    data: Value,
    text: String,
) -> Value {
    json!({
        "ok": ok,
        "status": status,
        "statusText": if ok { "" } else { "Mihomo IPC request failed" },
        "headers": {},
        "data": data,
        "text": text,
        "controllerMode": "ipc",
        "httpFallback": false,
        "socketPath": controller_endpoint.path,
        "socketArg": controller_endpoint.arg_name
    })
}

async fn local_socket_response(
    controller_endpoint: &ControllerEndpoint,
    method: &str,
    target: &str,
    body: &Value,
    timeout_ms: Option<u64>,
) -> Result<Value, String> {
    let (status, text) = crate::mihomo_local_socket::request_json_with_timeout(
        &controller_endpoint.path,
        method,
        target,
        body,
        timeout_ms.map(std::time::Duration::from_millis),
    )
    .await?;

    if (200..300).contains(&status) {
        let data = if text.trim().is_empty() {
            Value::Null
        } else {
            serde_json::from_str::<Value>(&text).unwrap_or_else(|_| Value::String(text.clone()))
        };
        Ok(response(controller_endpoint, true, status, data, text))
    } else {
        Ok(failure(
            controller_endpoint,
            status,
            if text.trim().is_empty() {
                "Mihomo IPC request failed".to_string()
            } else {
                text
            },
        ))
    }
}

fn endpoint_path(endpoint: &str) -> String {
    endpoint
        .split_once('?')
        .unwrap_or((endpoint, ""))
        .0
        .to_string()
}

fn endpoint_target(endpoint: &str) -> String {
    if endpoint.starts_with('/') {
        endpoint.to_string()
    } else {
        format!("/{endpoint}")
    }
}

fn endpoint_segments(path: &str) -> Vec<String> {
    path.trim_start_matches('/')
        .trim_end_matches('/')
        .split('/')
        .filter(|segment| !segment.is_empty())
        .map(|segment| {
            urlencoding::decode(segment)
                .map(|value| value.to_string())
                .unwrap_or_else(|_| segment.to_string())
        })
        .collect()
}

fn fetch_body_json(body: Option<&Value>) -> Result<Value, String> {
    match body {
        Some(Value::String(text)) if !text.trim().is_empty() => {
            serde_json::from_str(text).map_err(|err| err.to_string())
        }
        Some(value) => Ok(value.clone()),
        None => Ok(Value::Null),
    }
}

fn body_string_field(body: &Value, key: &str) -> Option<String> {
    body.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn is_supported_route(method: &str, segments: &[&str]) -> bool {
    matches!(
        (method, segments),
        ("GET", ["version"])
            | ("POST", ["cache", "fakeip", "flush"])
            | ("POST", ["cache", "dns", "flush"])
            | ("GET", ["connections"])
            | ("DELETE", ["connections"])
            | ("DELETE", ["connections", _])
            | ("GET", ["group"])
            | ("GET", ["group", _])
            | ("GET", ["group", _, "delay"])
            | ("GET", ["providers", "proxies"])
            | ("GET", ["providers", "proxies", _])
            | ("PUT", ["providers", "proxies", _])
            | ("GET", ["providers", "proxies", _, "healthcheck"])
            | ("GET", ["proxies"])
            | ("GET", ["proxies", _])
            | ("PUT", ["proxies", _])
            | ("DELETE", ["proxies", _])
            | ("GET", ["proxies", _, "delay"])
            | ("GET", ["rules"])
            | ("PATCH", ["rules", "disable"])
            | ("GET", ["providers", "rules"])
            | ("PUT", ["providers", "rules", _])
            | ("GET", ["configs"])
            | ("PATCH", ["configs"])
            | ("PUT", ["configs"])
            | ("POST", ["configs", "geo"])
            | ("POST", ["restart"])
    )
}

#[cfg(test)]
mod tests {
    use super::{endpoint_segments, is_supported_route};

    fn supported(method: &str, endpoint: &str) -> bool {
        let segments = endpoint_segments(endpoint);
        let segment_refs = segments.iter().map(String::as_str).collect::<Vec<_>>();
        is_supported_route(method, segment_refs.as_slice())
    }

    #[test]
    fn whitelist_accepts_runtime_routes_used_by_compat_bridge() {
        assert!(supported("GET", "/version"));
        assert!(supported("GET", "/proxies"));
        assert!(supported("PUT", "/proxies/GLOBAL"));
        assert!(supported("DELETE", "/connections"));
        assert!(supported("GET", "/providers/proxies"));
        assert!(supported("PATCH", "/rules/disable"));
        assert!(supported("PATCH", "/configs"));
        assert!(supported("PUT", "/configs"));
    }

    #[test]
    fn whitelist_rejects_unknown_or_external_routes() {
        assert!(!supported("GET", "/debug/pprof"));
        assert!(!supported("POST", "/proxies/GLOBAL"));
        assert!(!supported("GET", "http://127.0.0.1:9090/proxies"));
    }
}
