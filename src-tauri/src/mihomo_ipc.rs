use std::collections::HashMap;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::AppHandle;
use tauri_plugin_mihomo::MihomoExt as _;

use crate::{core::controller::ControllerEndpoint, fetch::FetchOptions};

pub(crate) async fn request(
    app: &AppHandle,
    controller_endpoint: ControllerEndpoint,
    endpoint: String,
    options: FetchOptions,
) -> Result<Value, String> {
    let method = options.method.to_ascii_uppercase();
    let (path, query) = split_endpoint(&endpoint);
    let segments = endpoint_segments(&path);
    let segment_refs = segments.iter().map(String::as_str).collect::<Vec<_>>();
    let body = fetch_body_json(options.body.as_ref())?;
    let mihomo = app.mihomo().read().await;

    if !is_supported_route(method.as_str(), segment_refs.as_slice()) {
        return Ok(failure(
            &controller_endpoint,
            400,
            format!("Unsupported Mihomo IPC endpoint: {} {}", method, endpoint),
        ));
    }

    let result = match (method.as_str(), segment_refs.as_slice()) {
        ("GET", ["version"]) => success(
            &controller_endpoint,
            mihomo.get_version().await.map_err(|err| err.to_string())?,
        ),
        ("POST", ["cache", "fakeip", "flush"]) => {
            mihomo.flush_fakeip().await.map_err(|err| err.to_string())?;
            Ok(empty_success(&controller_endpoint))
        }
        ("POST", ["cache", "dns", "flush"]) => {
            mihomo.flush_dns().await.map_err(|err| err.to_string())?;
            Ok(empty_success(&controller_endpoint))
        }
        ("GET", ["connections"]) => success(
            &controller_endpoint,
            mihomo
                .get_connections()
                .await
                .map_err(|err| err.to_string())?,
        ),
        ("DELETE", ["connections"]) => {
            mihomo
                .close_all_connections()
                .await
                .map_err(|err| err.to_string())?;
            Ok(empty_success(&controller_endpoint))
        }
        ("DELETE", ["connections", connection_id]) => {
            mihomo
                .close_connection(connection_id)
                .await
                .map_err(|err| err.to_string())?;
            Ok(empty_success(&controller_endpoint))
        }
        ("GET", ["group"]) => success(
            &controller_endpoint,
            mihomo.get_groups().await.map_err(|err| err.to_string())?,
        ),
        ("GET", ["group", group_name]) => success(
            &controller_endpoint,
            mihomo
                .get_group_by_name(group_name)
                .await
                .map_err(|err| err.to_string())?,
        ),
        ("GET", ["group", group_name, "delay"]) => {
            let test_url = query
                .get("url")
                .cloned()
                .unwrap_or_else(|| "https://www.gstatic.com/generate_204".to_string());
            let timeout = query_u32(&query, "timeout", 10_000);
            success(
                &controller_endpoint,
                mihomo
                    .delay_group(group_name, &test_url, timeout)
                    .await
                    .map_err(|err| err.to_string())?,
            )
        }
        ("GET", ["providers", "proxies"]) => success(
            &controller_endpoint,
            mihomo
                .get_proxy_providers()
                .await
                .map_err(|err| err.to_string())?,
        ),
        ("GET", ["providers", "proxies", provider_name]) => success(
            &controller_endpoint,
            mihomo
                .get_proxy_provider_by_name(provider_name)
                .await
                .map_err(|err| err.to_string())?,
        ),
        ("PUT", ["providers", "proxies", provider_name]) => {
            mihomo
                .update_proxy_provider(provider_name)
                .await
                .map_err(|err| err.to_string())?;
            Ok(empty_success(&controller_endpoint))
        }
        ("GET", ["providers", "proxies", provider_name, "healthcheck"]) => {
            mihomo
                .healthcheck_proxy_provider(provider_name)
                .await
                .map_err(|err| err.to_string())?;
            Ok(empty_success(&controller_endpoint))
        }
        ("GET", ["proxies"]) => success(
            &controller_endpoint,
            mihomo.get_proxies().await.map_err(|err| err.to_string())?,
        ),
        ("GET", ["proxies", proxy_name]) => success(
            &controller_endpoint,
            mihomo
                .get_proxy_by_name(proxy_name)
                .await
                .map_err(|err| err.to_string())?,
        ),
        ("PUT", ["proxies", group_name]) => {
            let node =
                body_string_field(&body, "name").ok_or_else(|| "缺少代理节点名称".to_string())?;
            mihomo
                .select_node_for_group(group_name, &node)
                .await
                .map_err(|err| err.to_string())?;
            Ok(empty_success(&controller_endpoint))
        }
        ("DELETE", ["proxies", group_name]) => {
            mihomo
                .unfixed_proxy(group_name)
                .await
                .map_err(|err| err.to_string())?;
            Ok(empty_success(&controller_endpoint))
        }
        ("GET", ["proxies", proxy_name, "delay"]) => {
            let test_url = query
                .get("url")
                .cloned()
                .unwrap_or_else(|| "https://www.gstatic.com/generate_204".to_string());
            let timeout = query_u32(&query, "timeout", 10_000);
            success(
                &controller_endpoint,
                mihomo
                    .delay_proxy_by_name(proxy_name, &test_url, timeout)
                    .await
                    .map_err(|err| err.to_string())?,
            )
        }
        ("GET", ["rules"]) => success(
            &controller_endpoint,
            mihomo.get_rules().await.map_err(|err| err.to_string())?,
        ),
        ("PATCH", ["rules", "disable"]) => {
            let (status, text) = crate::mihomo_local_socket::request_json(
                &controller_endpoint.path,
                "PATCH",
                "/rules/disable",
                &body,
            )
            .await?;
            if (200..300).contains(&status) {
                Ok(empty_success(&controller_endpoint))
            } else {
                Ok(failure(
                    &controller_endpoint,
                    status,
                    if text.is_empty() {
                        "切换规则状态失败".to_string()
                    } else {
                        text
                    },
                ))
            }
        }
        ("GET", ["providers", "rules"]) => success(
            &controller_endpoint,
            mihomo
                .get_rule_providers()
                .await
                .map_err(|err| err.to_string())?,
        ),
        ("PUT", ["providers", "rules", provider_name]) => {
            mihomo
                .update_rule_provider(provider_name)
                .await
                .map_err(|err| err.to_string())?;
            Ok(empty_success(&controller_endpoint))
        }
        ("GET", ["configs"]) => success(
            &controller_endpoint,
            mihomo
                .get_base_config()
                .await
                .map_err(|err| err.to_string())?,
        ),
        ("PATCH", ["configs"]) => {
            mihomo
                .patch_base_config(&body)
                .await
                .map_err(|err| err.to_string())?;
            Ok(empty_success(&controller_endpoint))
        }
        ("PUT", ["configs"]) => {
            let path =
                body_string_field(&body, "path").ok_or_else(|| "缺少配置文件路径".to_string())?;
            mihomo
                .reload_config(query_bool(&query, "force", false), &path)
                .await
                .map_err(|err| err.to_string())?;
            Ok(empty_success(&controller_endpoint))
        }
        ("POST", ["configs", "geo"]) => {
            mihomo.update_geo().await.map_err(|err| err.to_string())?;
            Ok(empty_success(&controller_endpoint))
        }
        ("POST", ["restart"]) => {
            mihomo.restart().await.map_err(|err| err.to_string())?;
            Ok(empty_success(&controller_endpoint))
        }
        _ => Ok(failure(
            &controller_endpoint,
            400,
            "Unsupported Mihomo IPC endpoint",
        )),
    };

    result.or_else(|error| Ok(failure(&controller_endpoint, 0, error)))
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

fn success<T: Serialize>(
    controller_endpoint: &ControllerEndpoint,
    value: T,
) -> Result<Value, String> {
    let data = serde_json::to_value(value).map_err(|err| err.to_string())?;
    let text = if data.is_null() {
        String::new()
    } else {
        data.to_string()
    };
    Ok(response(controller_endpoint, true, 200, data, text))
}

fn empty_success(controller_endpoint: &ControllerEndpoint) -> Value {
    response(controller_endpoint, true, 204, Value::Null, String::new())
}

fn split_endpoint(endpoint: &str) -> (String, HashMap<String, String>) {
    let (path, query) = endpoint.split_once('?').unwrap_or((endpoint, ""));
    let query = query
        .split('&')
        .filter_map(|pair| {
            let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
            if key.is_empty() {
                return None;
            }
            let key = urlencoding::decode(key).ok()?.to_string();
            let value = urlencoding::decode(value).ok()?.to_string();
            Some((key, value))
        })
        .collect::<HashMap<_, _>>();
    (path.to_string(), query)
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

fn query_bool(query: &HashMap<String, String>, key: &str, fallback: bool) -> bool {
    query
        .get(key)
        .map(|value| matches!(value.as_str(), "1" | "true" | "TRUE" | "True"))
        .unwrap_or(fallback)
}

fn query_u32(query: &HashMap<String, String>, key: &str, fallback: u32) -> u32 {
    query
        .get(key)
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(fallback)
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
