use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WebviewWindow, WindowEvent};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_mihomo::RejectPolicy;

use crate::core::controller as core_controller;
use crate::core_lifecycle_commands::{
    refresh_active_config_after_override, schedule_mihomo_autostart, stop_mihomo_process,
};
use crate::platform::{
    apply_appearance_mode_for_app, emit_window_state,
    handle_compat_call as handle_platform_compat_call, schedule_auto_lightweight_timer,
    set_system_proxy, show_main_window,
};
use crate::runtime_config::mihomo_mixed_port;
use crate::state::AppState;
use crate::storage::setting;
use crate::tray::setup_tray;
use crate::tun_service::schedule_pending_tun_enable;

type CompatResult = Result<Value, String>;

fn unsupported(method: &str) -> Value {
    json!({
        "success": false,
        "error": format!("{method} is not implemented in the Tauri runtime yet")
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

fn exit_cleanup_started() -> &'static AtomicBool {
    static STARTED: AtomicBool = AtomicBool::new(false);
    &STARTED
}

pub(crate) fn request_app_quit(app: &AppHandle) {
    app.exit(0);
}

fn cleanup_on_exit(app: &AppHandle) {
    if exit_cleanup_started().swap(true, Ordering::SeqCst) {
        return;
    }

    if let Err(error) = set_system_proxy(app, false, "127.0.0.1", mihomo_mixed_port(app)) {
        eprintln!("[exit] disable system proxy failed: {error}");
    }

    let state = app.state::<AppState>();
    let app = app.clone();
    let result = tauri::async_runtime::block_on(async move { stop_mihomo_process(&app, &state).await });
    if let Err(error) = result {
        eprintln!("[exit] stop core failed: {error}");
    }
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

            schedule_pending_tun_enable(app.handle());

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
                let _ = apply_appearance_mode_for_app(app.handle(), &window, &mode);

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

                            let delay = setting(&close_app, "lightweightModeDelay", json!(60))
                                .ok()
                                .and_then(|value| value.as_u64())
                                .unwrap_or(60)
                                .clamp(10, 600);
                            schedule_auto_lightweight_timer(&close_app, delay);
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
        .build(tauri::generate_context!())
        .expect("error while building FlyClash Tauri application")
        .run(|app_handle, event| match event {
            RunEvent::ExitRequested { api, .. } => {
                if !exit_cleanup_started().load(Ordering::SeqCst) {
                    api.prevent_exit();
                    cleanup_on_exit(app_handle);
                    app_handle.exit(0);
                }
            }
            RunEvent::Exit => {
                cleanup_on_exit(app_handle);
            }
            _ => {}
        });
}
