use std::{
    collections::HashSet,
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::{json, Map, Value};
use tauri::{AppHandle, Emitter, State, WebviewWindow};

use crate::{
    app::{
        controller_secret, geodata_config_patch_body, patch_active_geodata_config, request_http,
        request_http_via_proxy,
    },
    runtime::active_runtime_controller_endpoint,
    state::{AppState, TrafficSnapshot},
};

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

pub(crate) async fn controller_probe_payload(app: &AppHandle) -> Value {
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
                "controllerMode": "ipc",
                "socketPath": controller_endpoint.path,
                "socketArg": controller_endpoint.arg_name,
                "httpFallback": false,
                "coreVersion": Value::Null,
                "coreMeta": Value::Null,
                "corePremium": Value::Null
            })
        }
    }
}

fn proxy_is_group(value: &Value) -> bool {
    value
        .get("all")
        .and_then(Value::as_array)
        .map(|items| !items.is_empty())
        .unwrap_or(false)
        || matches!(
            value.get("type").and_then(Value::as_str),
            Some("Selector")
                | Some("URLTest")
                | Some("Fallback")
                | Some("LoadBalance")
                | Some("Relay")
                | Some("select")
                | Some("url-test")
                | Some("fallback")
                | Some("load-balance")
                | Some("relay")
        )
}

fn resolve_proxy_now(proxies: &Map<String, Value>, name: &str, depth: usize) -> Option<String> {
    if depth > 8 {
        return None;
    }
    let proxy = proxies.get(name)?;
    let now = proxy.get("now").and_then(Value::as_str)?;
    if now.is_empty() {
        return None;
    }
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

pub(crate) async fn fetch_connections_info(app: &AppHandle, state: &State<'_, AppState>) -> Value {
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
            let _ = crate::telemetry::add_traffic_history(app, delta_up, delta_down);
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

async fn dispatch_compat_call(
    app: &AppHandle,
    window: &WebviewWindow,
    state: &State<'_, AppState>,
    method: &str,
    args: &[Value],
) -> CompatResult {
    match method {
        "getTrafficStats" => {
            let stats = get_traffic_stats(app, state).await;
            let _ = window.emit("traffic-update", stats.clone());
            Ok(stats)
        }
        "fetchConnectionsInfo" => {
            let snapshot = fetch_connections_info(app, state).await;
            let _ = window.emit("connections-update", snapshot.clone());
            Ok(snapshot)
        }
        "getProxies" => {
            let response = request_http(app, Some("/proxies".to_string()), None).await?;
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
            let id = arg_string(args, 0).unwrap_or_default();
            if id.is_empty() {
                return Ok(json!({ "success": false, "error": "missing connection id" }));
            }
            let endpoint = format!("/connections/{}", urlencoding::encode(&id));
            let response =
                request_http(app, Some(endpoint), Some(json!({ "method": "DELETE" }))).await?;
            if response.get("ok").and_then(Value::as_bool).unwrap_or(false) {
                let snapshot = fetch_connections_info(app, state).await;
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
                app,
                Some("/connections".to_string()),
                Some(json!({ "method": "DELETE" })),
            )
            .await?;
            if response.get("ok").and_then(Value::as_bool).unwrap_or(false) {
                let _ = window.emit("connections-closed", json!({}));
                let snapshot = fetch_connections_info(app, state).await;
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
            let node = arg_string(args, 0).unwrap_or_default();
            let group = arg_string(args, 1).unwrap_or_else(|| "GLOBAL".to_string());
            let update_global = arg_bool(args, 2).unwrap_or(false);
            let endpoint = format!("/proxies/{}", urlencoding::encode(&group));
            let body = json!({ "name": node });
            let response = request_http(
                app,
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
            let node = arg_string(args, 0).unwrap_or_default();
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
            let node = arg_string(args, 0).unwrap_or_default();
            let endpoint = format!(
                "/proxies/{}/delay?timeout=5000&url={}",
                urlencoding::encode(&node),
                urlencoding::encode("https://www.gstatic.com/generate_204")
            );
            let response = request_http(app, Some(endpoint), None).await?;
            Ok(response
                .get("data")
                .and_then(|data| data.get("delay"))
                .cloned()
                .unwrap_or(json!(-1)))
        }
        "getProxyProviders" | "get-proxy-providers" => {
            let response = request_http(app, Some("/providers/proxies".to_string()), None).await?;
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
            let name = arg_string(args, 0).unwrap_or_default();
            let endpoint = format!("/providers/proxies/{}", urlencoding::encode(&name));
            let response =
                request_http(app, Some(endpoint), Some(json!({ "method": "PUT" }))).await?;
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
            let response = request_http(app, Some("/providers/rules".to_string()), None).await?;
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
            let name = arg_string(args, 0).unwrap_or_default();
            let endpoint = format!("/providers/rules/{}", urlencoding::encode(&name));
            let response =
                request_http(app, Some(endpoint), Some(json!({ "method": "PUT" }))).await?;
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
            let response = request_http(app, Some("/configs".to_string()), None).await?;
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
        "getApiConfig" => {
            let controller_endpoint = active_runtime_controller_endpoint(app);
            Ok(success(json!({
                "controllerHost": Value::Null,
                "controllerPort": Value::Null,
                "secret": controller_secret(app),
                "controllerMode": "ipc",
                "socketPath": controller_endpoint.path,
                "socketArg": controller_endpoint.arg_name,
                "httpFallback": false
            })))
        }
        "requestMihomoAPI" => {
            let target = arg_string(args, 0);
            if let Some(patch) = geodata_config_patch_body(target.as_deref(), args.get(1)) {
                patch_active_geodata_config(app, state, patch).await
            } else {
                request_http(app, target, args.get(1).cloned()).await
            }
        }
        "proxyFetch" => {
            request_http_via_proxy(app, arg_string(args, 0), args.get(1).cloned()).await
        }
        "fetchWithProxy" => request_http_via_proxy(app, None, args.first().cloned()).await,
        _ => Err(format!("Unsupported Mihomo controller method: {method}")),
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
        "getTrafficStats"
            | "fetchConnectionsInfo"
            | "getProxies"
            | "closeConnection"
            | "closeAllConnections"
            | "testAllNodes"
            | "selectNode"
            | "selectGroupNode"
            | "switchNode"
            | "notifyNodeChanged"
            | "testNodeDelay"
            | "getProxyProviders"
            | "get-proxy-providers"
            | "updateProxyProvider"
            | "update-proxy-provider"
            | "getRuleProviders"
            | "get-rule-providers"
            | "updateRuleProvider"
            | "update-rule-provider"
            | "getRuntimeConfig"
            | "getApiConfig"
            | "requestMihomoAPI"
            | "proxyFetch"
            | "fetchWithProxy"
    ) {
        return None;
    }

    Some(dispatch_compat_call(app, window, state, method, args).await)
}
