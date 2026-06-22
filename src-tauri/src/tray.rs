use serde_json::{json, Value};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager,
};

use crate::app::{
    apply_tun_runtime_change, ensure_tun_dns_defaults, mihomo_mixed_port, reload_mihomo_config,
    request_http, start_mihomo, stop_mihomo_process,
};
use crate::core::manager::RunningMode;
use crate::mihomo_controller::fetch_connections_info;
use crate::platform::{hide_main_window, set_system_proxy, show_main_window, system_proxy_status};
use crate::profiles::{
    config_content, config_display_name, emit_active_config_changed, normalize_config_reference,
    read_last_config, read_subscriptions, save_last_config, SubscriptionMeta,
};
use crate::runtime::{is_mihomo_running, sync_core_running_state};
use crate::state::AppState;
use crate::storage::{set_setting, setting};

const TRAY_ID: &str = "main";
const TRAY_SWITCH_CONFIG_PREFIX: &str = "switch-config:";
const TRAY_MAX_CONFIG_ITEMS: usize = 24;

type CompatResult = Result<Value, String>;

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

pub(crate) fn refresh_tray_menu_after(app: &AppHandle, reason: &str) {
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

pub(crate) fn setup_tray(app: &AppHandle) -> Result<(), String> {
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
