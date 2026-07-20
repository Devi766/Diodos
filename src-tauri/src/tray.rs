use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager,
};

use crate::app::request_app_quit;
use crate::core::manager::RunningMode;
use crate::core_lifecycle_commands::{
    apply_tun_runtime_change, reload_mihomo_config, start_mihomo, stop_mihomo_process,
};
use crate::mihomo_controller::fetch_connections_info;
use crate::mihomo_transport::request as request_http;
use crate::platform::{
    enter_lightweight_mode, hide_main_window, set_system_proxy, show_main_window,
    system_proxy_status,
};
use crate::profiles::{
    config_content, config_display_name, emit_active_config_changed, normalize_config_reference,
    read_last_config, read_subscriptions, save_last_config, SubscriptionMeta,
};
use crate::runtime::{is_mihomo_running, sync_core_running_state};
use crate::runtime_config::{ensure_tun_dns_defaults, mihomo_mixed_port};
use crate::state::AppState;
use crate::storage::{set_setting, setting};

const TRAY_ID: &str = "main";
const TRAY_SWITCH_CONFIG_PREFIX: &str = "switch-config:";
const TRAY_SWITCH_NODE_PREFIX: &str = "switch-node:";
const TRAY_MAX_CONFIG_ITEMS: usize = 24;
const TRAY_MAX_PROXY_GROUPS: usize = 12;
const TRAY_MAX_NODES_PER_GROUP: usize = 40;

type CompatResult = Result<Value, String>;

#[derive(Clone, Debug, Default)]
struct TrayProxyNode {
    name: String,
    delay_ms: Option<i64>,
    is_group: bool,
}

#[derive(Clone, Debug, Default)]
struct TrayProxyGroup {
    name: String,
    now: Option<String>,
    nodes: Vec<TrayProxyNode>,
}

#[derive(Clone, Debug, Default)]
struct TrayProxySnapshot {
    mode: String,
    groups: Vec<TrayProxyGroup>,
    current_node: Option<String>,
}

fn tray_proxy_snapshot() -> &'static Mutex<Option<TrayProxySnapshot>> {
    static SNAPSHOT: OnceLock<Mutex<Option<TrayProxySnapshot>>> = OnceLock::new();
    SNAPSHOT.get_or_init(|| Mutex::new(None))
}

fn read_tray_proxy_snapshot() -> Option<TrayProxySnapshot> {
    tray_proxy_snapshot()
        .lock()
        .ok()
        .and_then(|guard| guard.clone())
}

fn write_tray_proxy_snapshot(snapshot: Option<TrayProxySnapshot>) {
    if let Ok(mut guard) = tray_proxy_snapshot().lock() {
        *guard = snapshot;
    }
}

fn clear_tray_proxy_snapshot() {
    write_tray_proxy_snapshot(None);
}

fn tray_menu_hold() -> &'static Mutex<Option<Instant>> {
    static HOLD: OnceLock<Mutex<Option<Instant>>> = OnceLock::new();
    HOLD.get_or_init(|| Mutex::new(None))
}

fn mark_tray_menu_hold() {
    if let Ok(mut guard) = tray_menu_hold().lock() {
        *guard = Some(Instant::now() + Duration::from_millis(1800));
    }
}

fn tray_menu_is_held() -> bool {
    tray_menu_hold()
        .lock()
        .ok()
        .and_then(|guard| *guard)
        .map(|until| Instant::now() < until)
        .unwrap_or(false)
}

fn tray_snapshot_refresh_token() -> &'static AtomicU64 {
    static TOKEN: AtomicU64 = AtomicU64::new(0);
    &TOKEN
}

fn tray_snapshot_refresh_inflight() -> &'static AtomicBool {
    static FLAG: AtomicBool = AtomicBool::new(false);
    &FLAG
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

fn response_data(response: &Value) -> Option<&Value> {
    response.get("data").or(Some(response))
}

fn proxy_map(response: &Value) -> HashMap<String, Value> {
    let Some(data) = response_data(response) else {
        return HashMap::new();
    };
    let proxies = data
        .get("proxies")
        .and_then(Value::as_object)
        .or_else(|| data.as_object());
    proxies
        .map(|object| {
            object
                .iter()
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect()
        })
        .unwrap_or_default()
}

fn node_delay_ms(node: &Value) -> Option<i64> {
    node.get("history")
        .and_then(Value::as_array)
        .and_then(|history| history.first())
        .and_then(|entry| entry.get("delay"))
        .and_then(Value::as_i64)
}

fn is_selector_like(proxy_type: &str) -> bool {
    matches!(
        proxy_type,
        "Selector" | "URLTest" | "Fallback" | "LoadBalance"
    )
}

fn ordered_names(preferred: &[String], available: &[String]) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut ordered = Vec::new();
    for name in preferred {
        if available.iter().any(|item| item == name) && seen.insert(name.clone()) {
            ordered.push(name.clone());
        }
    }
    for name in available {
        if seen.insert(name.clone()) {
            ordered.push(name.clone());
        }
    }
    ordered
}

fn load_config_group_order(app: &AppHandle, active_config: Option<&str>) -> Vec<(String, Vec<String>)> {
    let Some(path) = active_config
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .or_else(|| read_last_config(app).ok().flatten())
    else {
        return Vec::new();
    };

    let Ok(content) = config_content(app, &path) else {
        return Vec::new();
    };
    let base = match serde_yaml::from_str::<serde_yaml::Value>(&content) {
        Ok(yaml) => serde_json::to_value(yaml).unwrap_or(Value::Null),
        Err(_) => return Vec::new(),
    };
    let config = if base.is_object() {
        crate::overrides::apply_overrides(app, &path, base.clone()).unwrap_or(base)
    } else {
        base
    };
    let Ok(yaml) = serde_json::from_value::<serde_yaml::Value>(config) else {
        return Vec::new();
    };

    yaml.get("proxy-groups")
        .and_then(|value| value.as_sequence())
        .map(|groups| {
            groups
                .iter()
                .filter_map(|group| {
                    let name = group.get("name")?.as_str()?.trim();
                    if name.is_empty() {
                        return None;
                    }
                    let nodes = group
                        .get("proxies")
                        .and_then(|value| value.as_sequence())
                        .map(|items| {
                            items
                                .iter()
                                .filter_map(|item| item.as_str().map(str::trim))
                                .filter(|item| !item.is_empty())
                                .map(ToString::to_string)
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();
                    Some((name.to_string(), nodes))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn build_tray_proxy_snapshot(
    mode: &str,
    proxies: &HashMap<String, Value>,
    config_groups: &[(String, Vec<String>)],
) -> TrayProxySnapshot {
    let mut selector_groups: HashMap<String, Value> = HashMap::new();
    for (name, proxy) in proxies {
        let proxy_type = proxy
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !is_selector_like(proxy_type) {
            continue;
        }
        if mode.eq_ignore_ascii_case("global") && name != "GLOBAL" {
            continue;
        }
        if mode.eq_ignore_ascii_case("rule") && name == "GLOBAL" {
            continue;
        }
        let all = proxy
            .get("all")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        if all.is_empty() {
            continue;
        }
        selector_groups.insert(name.clone(), proxy.clone());
    }

    let mut group_order: Vec<String> = config_groups
        .iter()
        .map(|(name, _)| name.clone())
        .filter(|name| selector_groups.contains_key(name))
        .collect();
    for name in selector_groups.keys() {
        if !group_order.iter().any(|item| item == name) {
            group_order.push(name.clone());
        }
    }

    let mut groups = Vec::new();
    for group_name in group_order.into_iter().take(TRAY_MAX_PROXY_GROUPS) {
        let Some(proxy) = selector_groups.get(&group_name) else {
            continue;
        };
        let api_nodes = proxy
            .get("all")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let preferred_nodes = config_groups
            .iter()
            .find(|(name, _)| name == &group_name)
            .map(|(_, nodes)| nodes.clone())
            .unwrap_or_default();
        let node_names = ordered_names(&preferred_nodes, &api_nodes)
            .into_iter()
            .take(TRAY_MAX_NODES_PER_GROUP)
            .collect::<Vec<_>>();

        let mut nodes = Vec::new();
        for node_name in node_names {
            let Some(node) = proxies.get(&node_name) else {
                continue;
            };
            let node_type = node
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default();
            nodes.push(TrayProxyNode {
                name: node_name,
                delay_ms: node_delay_ms(node),
                is_group: is_selector_like(node_type),
            });
        }
        if nodes.is_empty() {
            continue;
        }
        groups.push(TrayProxyGroup {
            name: group_name,
            now: proxy
                .get("now")
                .and_then(Value::as_str)
                .map(str::to_string),
            nodes,
        });
    }

    let current_node = groups
        .iter()
        .find(|group| group.name == "PROXY" || group.name == "GLOBAL")
        .and_then(|group| group.now.clone())
        .or_else(|| groups.first().and_then(|group| group.now.clone()));

    TrayProxySnapshot {
        mode: mode.to_string(),
        groups,
        current_node,
    }
}

async fn fetch_tray_proxy_snapshot(app: &AppHandle) -> Option<TrayProxySnapshot> {
    if !is_mihomo_running(app) {
        return None;
    }

    let mode_response = request_http(app, Some("/configs".to_string()), None)
        .await
        .ok()?;
    if !mode_response
        .get("ok")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return None;
    }
    let mode = response_data(&mode_response)
        .and_then(|data| data.get("mode"))
        .and_then(Value::as_str)
        .unwrap_or("rule")
        .to_ascii_lowercase();
    if mode == "direct" {
        return Some(TrayProxySnapshot {
            mode,
            groups: Vec::new(),
            current_node: None,
        });
    }

    let proxies_response = request_http(app, Some("/proxies".to_string()), None)
        .await
        .ok()?;
    if !proxies_response
        .get("ok")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return None;
    }

    let proxies = proxy_map(&proxies_response);
    if proxies.is_empty() {
        return None;
    }

    let active_config = tray_core_snapshot(app).2;
    let config_groups = load_config_group_order(app, active_config.as_deref());
    Some(build_tray_proxy_snapshot(&mode, &proxies, &config_groups))
}

fn schedule_tray_proxy_snapshot_refresh(app: &AppHandle) {
    if tray_menu_is_held() {
        return;
    }
    if tray_snapshot_refresh_inflight().swap(true, Ordering::SeqCst) {
        return;
    }

    let token = tray_snapshot_refresh_token().fetch_add(1, Ordering::SeqCst) + 1;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _reset = scopeguard_reset_inflight();
        match fetch_tray_proxy_snapshot(&app).await {
            Some(snapshot) => {
                if tray_snapshot_refresh_token().load(Ordering::SeqCst) != token {
                    return;
                }
                let previous = read_tray_proxy_snapshot();
                let changed = previous
                    .as_ref()
                    .map(|old| {
                        old.mode != snapshot.mode
                            || old.current_node != snapshot.current_node
                            || old.groups.len() != snapshot.groups.len()
                            || old
                                .groups
                                .iter()
                                .zip(snapshot.groups.iter())
                                .any(|(left, right)| {
                                    left.name != right.name
                                        || left.now != right.now
                                        || left.nodes.len() != right.nodes.len()
                                })
                    })
                    .unwrap_or(true);
                write_tray_proxy_snapshot(Some(snapshot));
                if changed && !tray_menu_is_held() {
                    refresh_tray_menu_after(&app, "proxy-snapshot");
                }
            }
            None => {
                if tray_snapshot_refresh_token().load(Ordering::SeqCst) != token {
                    return;
                }
                if read_tray_proxy_snapshot().is_some() {
                    clear_tray_proxy_snapshot();
                    if !tray_menu_is_held() {
                        refresh_tray_menu_after(&app, "proxy-snapshot-clear");
                    }
                }
            }
        }
    });
}

struct InFlightGuard;
fn scopeguard_reset_inflight() -> InFlightGuard {
    InFlightGuard
}
impl Drop for InFlightGuard {
    fn drop(&mut self) {
        tray_snapshot_refresh_inflight().store(false, Ordering::SeqCst);
    }
}

fn encode_tray_pair(left: &str, right: &str) -> String {
    format!(
        "{}::{}",
        urlencoding::encode(left),
        urlencoding::encode(right)
    )
}

fn decode_tray_pair(value: &str) -> Option<(String, String)> {
    let (left, right) = value.split_once("::")?;
    let left = urlencoding::decode(left).ok()?.into_owned();
    let right = urlencoding::decode(right).ok()?.into_owned();
    if left.trim().is_empty() || right.trim().is_empty() {
        return None;
    }
    Some((left, right))
}

fn tray_node_label(node: &TrayProxyNode, selected: bool) -> String {
    let mut label = node.name.clone();
    if let Some(delay) = node.delay_ms {
        if delay > 0 {
            label = format!("{label} ({delay}ms)");
        } else if delay == 0 {
            label = format!("{label} (超时)");
        }
    }
    if node.is_group {
        label = format!("{label} [组]");
    }
    if selected {
        label = format!("✓ {label}");
    }
    tray_clean_label(&label, "节点", 48)
}

fn build_tray_proxy_menu(
    app: &AppHandle,
    core_running: bool,
) -> Result<Option<Submenu<tauri::Wry>>, String> {
    if !core_running {
        return Ok(None);
    }

    let Some(snapshot) = read_tray_proxy_snapshot() else {
        // Kick off an async fill so the next refresh has selector groups.
        schedule_tray_proxy_snapshot_refresh(app);
        return Ok(None);
    };

    if snapshot.mode.eq_ignore_ascii_case("direct") || snapshot.groups.is_empty() {
        return Ok(None);
    }

    let root =
        Submenu::with_id(app, "proxy-groups", "代理组", true).map_err(|err| err.to_string())?;

    for group in &snapshot.groups {
        let group_label = if group.name == "PROXY" || group.name == "GLOBAL" {
            format!("{} ★", group.name)
        } else {
            group.name.clone()
        };
        let group_menu = Submenu::with_id(
            app,
            format!("proxy-group:{}", urlencoding::encode(&group.name)),
            tray_clean_label(&group_label, "代理组", 40),
            true,
        )
        .map_err(|err| err.to_string())?;

        for node in &group.nodes {
            let selected = group.now.as_deref() == Some(node.name.as_str());
            let id = format!(
                "{TRAY_SWITCH_NODE_PREFIX}{}",
                encode_tray_pair(&group.name, &node.name)
            );
            // Prefer check items when available so current node is visible.
            let item = CheckMenuItem::with_id(
                app,
                id,
                tray_node_label(node, selected),
                true,
                selected,
                None::<&str>,
            )
            .map_err(|err| err.to_string())?;
            group_menu.append(&item).map_err(|err| err.to_string())?;
        }

        root.append(&group_menu).map_err(|err| err.to_string())?;
    }

    Ok(Some(root))
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
    let proxy_snapshot = read_tray_proxy_snapshot();
    let current_node = proxy_snapshot
        .as_ref()
        .and_then(|snapshot| snapshot.current_node.clone())
        .or_else(|| {
            app.state::<AppState>()
                .runtime
                .lock()
                .ok()
                .and_then(|runtime| runtime.current_node.clone())
        });

    if !core_running && proxy_snapshot.is_some() {
        clear_tray_proxy_snapshot();
    }

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
    let node_status = MenuItem::with_id(
        app,
        "status-node",
        tray_clean_label(
            &format!(
                "节点：{}",
                current_node.as_deref().unwrap_or("未选择")
            ),
            "节点：未选择",
            48,
        ),
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
    let lightweight = MenuItem::with_id(
        app,
        "enter-lightweight",
        "进入轻量模式",
        true,
        None::<&str>,
    )
    .map_err(|err| err.to_string())?;
    let configs = build_tray_config_menu(
        app,
        &subscriptions,
        subscriptions_error.as_deref(),
        active_config.as_deref(),
    )?;
    let proxy_groups = build_tray_proxy_menu(app, core_running)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)
        .map_err(|err| err.to_string())?;
    let sep_status = PredefinedMenuItem::separator(app).map_err(|err| err.to_string())?;
    let sep_window = PredefinedMenuItem::separator(app).map_err(|err| err.to_string())?;
    let sep_actions = PredefinedMenuItem::separator(app).map_err(|err| err.to_string())?;
    let sep_quit = PredefinedMenuItem::separator(app).map_err(|err| err.to_string())?;

    let mut items: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = vec![
        &core_status,
        &config_status,
        &node_status,
        &proxy_status_item,
        &tun_status_item,
        &sep_status,
        &show,
        &hide,
        &lightweight,
        &sep_window,
        &restart_core,
        &stop_core,
        &toggle_proxy,
        &toggle_tun,
        &close_connections,
        &sep_actions,
        &configs,
    ];
    if let Some(proxy_groups) = proxy_groups.as_ref() {
        items.push(proxy_groups);
    }
    items.push(&sep_quit);
    items.push(&quit);

    let menu = Menu::with_items(app, &items).map_err(|err| err.to_string())?;

    let tooltip = if let Some(node) = current_node.as_deref().filter(|value| !value.is_empty()) {
        format!(
            "FlyClash · {} · 核心 {} · 代理 {} · TUN {}",
            tray_clean_label(node, "节点", 28),
            tray_running_mode_label(running_mode),
            if proxy_enabled { "开" } else { "关" },
            if tun_enabled { "开" } else { "关" }
        )
    } else {
        format!(
            "FlyClash · 核心 {} · 代理 {} · TUN {}",
            tray_running_mode_label(running_mode),
            if proxy_enabled { "开" } else { "关" },
            if tun_enabled { "开" } else { "关" }
        )
    };

    Ok((menu, tooltip))
}

fn refresh_tray_menu(app: &AppHandle) -> Result<(), String> {
    if tray_menu_is_held() {
        return Ok(());
    }
    let (menu, tooltip) = build_tray_menu(app)?;
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        tray.set_menu(Some(menu)).map_err(|err| err.to_string())?;
        tray.set_tooltip(Some(tooltip))
            .map_err(|err| err.to_string())?;
    }
    Ok(())
}

pub(crate) fn refresh_tray_menu_after(app: &AppHandle, reason: &str) {
    if tray_menu_is_held() {
        return;
    }
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
                "error": "内核服务未运行，无法启用系统代理"
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
        if !enabled {
            set_setting(&app, "pendingTunEnable", json!(false))?;
        }
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

fn tray_switch_node(app: &AppHandle, encoded_pair: &str) {
    let Some((group_name, node_name)) = decode_tray_pair(encoded_pair) else {
        emit_tray_action(
            app,
            "switch-node",
            json!({ "success": false, "error": "节点参数解析失败" }),
        );
        return;
    };

    spawn_tray_async_action(app, "switch-node", move |app| async move {
        if !is_mihomo_running(&app) {
            return Ok(json!({
                "success": false,
                "error": "内核服务未运行，无法切换节点"
            }));
        }

        let endpoint = format!("/proxies/{}", urlencoding::encode(&group_name));
        let response = request_http(
            &app,
            Some(endpoint),
            Some(json!({
                "method": "PUT",
                "headers": { "Content-Type": "application/json" },
                "body": { "name": node_name }
            })),
        )
        .await?;

        if !response
            .get("ok")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            let error = response
                .get("statusText")
                .or_else(|| response.get("error"))
                .or_else(|| response.get("text"))
                .cloned()
                .unwrap_or_else(|| Value::String("切换节点失败".to_string()));
            return Ok(json!({
                "success": false,
                "group": group_name,
                "node": node_name,
                "error": error
            }));
        }

        // Keep runtime/tooltip state in sync for primary selector groups.
        if group_name == "PROXY" || group_name == "GLOBAL" {
            if let Ok(mut runtime) = app.state::<AppState>().runtime.lock() {
                runtime.current_node = Some(node_name.clone());
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.emit(
                    "node-changed",
                    json!({
                        "nodeName": node_name,
                        "groupName": group_name
                    }),
                );
            }
            let _ = app.emit(
                "node-changed",
                json!({
                    "nodeName": node_name,
                    "groupName": group_name
                }),
            );
        }

        // Optimistically update local snapshot so the next menu open is current.
        if let Some(mut snapshot) = read_tray_proxy_snapshot() {
            for group in &mut snapshot.groups {
                if group.name == group_name {
                    group.now = Some(node_name.clone());
                }
            }
            if group_name == "PROXY" || group_name == "GLOBAL" {
                snapshot.current_node = Some(node_name.clone());
            }
            write_tray_proxy_snapshot(Some(snapshot));
        }

        // Refresh from API shortly after so delay/order stay accurate.
        let refresh_app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(800)).await;
            schedule_tray_proxy_snapshot_refresh(&refresh_app);
        });

        Ok(success(json!({
            "group": group_name,
            "node": node_name,
            "message": format!("已切换 {group_name} → {node_name}")
        })))
    });
}

fn tray_icon_image() -> Option<tauri::image::Image<'static>> {
    // Prefer a dedicated tight 32/64 tray asset. Falling back to the window icon
    // often looks soft because the master is Apple-padded for large sizes.
    // Requires the `image-png` feature on the tauri crate.
    const TRAY_32: &[u8] = include_bytes!("../icons/tray-icon-32.png");
    const TRAY_64: &[u8] = include_bytes!("../icons/tray-icon.png");

    tauri::image::Image::from_bytes(TRAY_64)
        .or_else(|_| tauri::image::Image::from_bytes(TRAY_32))
        .ok()
        .map(|image| image.to_owned())
}

pub(crate) fn setup_tray(app: &AppHandle) -> Result<(), String> {
    let (menu, tooltip) = build_tray_menu(app)?;
    let icon = tray_icon_image().or_else(|| app.default_window_icon().cloned());

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
            if let Some(encoded_pair) = id.strip_prefix(TRAY_SWITCH_NODE_PREFIX) {
                tray_switch_node(app, encoded_pair);
                return;
            }

            match id {
                "show" => show_main_window(app),
                "hide" => hide_main_window(app),
                "enter-lightweight" => {
                    if let Err(error) = enter_lightweight_mode(app) {
                        emit_tray_action(
                            app,
                            "enter-lightweight",
                            json!({ "success": false, "error": error }),
                        );
                    } else {
                        emit_tray_action(
                            app,
                            "enter-lightweight",
                            json!({ "success": true }),
                        );
                    }
                }
                "restart-core" => tray_restart_core(app),
                "stop-core" => tray_stop_core(app),
                "toggle-system-proxy" => tray_toggle_system_proxy(app),
                "toggle-tun" => tray_toggle_tun(app),
                "close-all-connections" => tray_close_all_connections(app),
                "quit" => request_app_quit(app),
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            match event {
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } => {
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
                TrayIconEvent::Click {
                    button: MouseButton::Right,
                    button_state: MouseButtonState::Down,
                    ..
                }
                | TrayIconEvent::Click {
                    button: MouseButton::Right,
                    button_state: MouseButtonState::Up,
                    ..
                } => {
                    mark_tray_menu_hold();
                    let app = tray.app_handle().clone();
                    if is_mihomo_running(&app) && read_tray_proxy_snapshot().is_none() {
                        schedule_tray_proxy_snapshot_refresh(&app);
                    }
                }
                _ => {}
            }
        });

    if let Some(icon) = icon {
        builder = builder.icon(icon);
    }

    builder.build(app).map_err(|err| err.to_string())?;
    schedule_tray_proxy_snapshot_refresh(app);
    Ok(())
}
