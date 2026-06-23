use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State, WebviewWindow};

use crate::core_lifecycle_commands::{
    reload_mihomo_config as reload_core_config, start_mihomo as start_core, startup_mihomo_config,
    stop_mihomo_process,
};
use crate::profiles::{
    config_content, current_active_config, emit_active_config_changed, normalize_config_reference,
    read_last_config, save_last_config,
};
use crate::runtime::is_mihomo_running;
use crate::state::AppState;
use crate::tray::refresh_tray_menu_after;

type CompatResult = Result<Value, String>;

fn arg_string(args: &[Value], index: usize) -> Option<String> {
    args.get(index)
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

fn success(value: Value) -> Value {
    match value {
        Value::Object(mut map) => {
            map.entry("success").or_insert(Value::Bool(true));
            Value::Object(map)
        }
        other => json!({ "success": true, "data": other }),
    }
}

pub(crate) async fn handle_compat_call(
    app: &AppHandle,
    window: &WebviewWindow,
    state: &State<'_, AppState>,
    method: &str,
    args: &[Value],
) -> Option<CompatResult> {
    match method {
        "getAppVersion" => Some(Ok(Value::String(app.package_info().version.to_string()))),
        "debugLog" => Some(Ok(Value::Null)),

        "getActiveConfig" => Some({
            let active = current_active_config(app, state)
                .or_else(|| startup_mihomo_config(app).ok().flatten());
            Ok(active.map(Value::String).unwrap_or(Value::Null))
        }),
        "setPreferredConfig" | "saveLastConfig" => Some(set_preferred_config(app, state, args)),
        "startMihomo" => Some(start_mihomo(app, state, args).await),
        "stopMihomo" => Some(stop_mihomo(app, window, state).await),
        "reloadMihomoConfig" | "reload-mihomo-config" => {
            Some(reload_mihomo_config(app, state, args).await)
        }
        "restartService" | "restart-service" => {
            Some(restart_service(app, window, state, args).await)
        }
        "isMihomoRunning" => Some(Ok(Value::Bool(is_mihomo_running(app)))),
        _ => None,
    }
}

fn set_preferred_config(
    app: &AppHandle,
    state: &State<'_, AppState>,
    args: &[Value],
) -> CompatResult {
    let config_path = arg_string(args, 0)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_default();
    let config_path = normalize_config_reference(app, &config_path)?;
    if config_path.is_empty() {
        return Ok(json!({ "success": false, "error": "配置文件路径不能为空" }));
    }
    if let Err(error) = config_content(app, &config_path) {
        return Ok(json!({
            "success": false,
            "error": format!("配置文件不存在或无法读取: {error}")
        }));
    }
    save_last_config(app, &config_path)?;
    {
        let mut runtime = state.runtime.lock().expect("runtime mutex poisoned");
        runtime.core.set_active_config(Some(config_path.clone()));
    }
    emit_active_config_changed(app, Some(&config_path));
    refresh_tray_menu_after(app, "setPreferredConfig");
    Ok(success(
        json!({ "path": config_path, "filePath": config_path }),
    ))
}

async fn start_mihomo(
    app: &AppHandle,
    state: &State<'_, AppState>,
    args: &[Value],
) -> CompatResult {
    let config_path = arg_string(args, 0).unwrap_or_default();
    let result = start_core(app, state, &config_path).await?;
    refresh_tray_menu_after(app, "startMihomo");
    Ok(result)
}

async fn stop_mihomo(
    app: &AppHandle,
    window: &WebviewWindow,
    state: &State<'_, AppState>,
) -> CompatResult {
    let result = match stop_mihomo_process(app, state).await {
        Ok(()) => {
            let _ = window.emit("mihomo-stopped", 0);
            json!({ "success": true })
        }
        Err(error) => json!({ "success": false, "error": error }),
    };
    refresh_tray_menu_after(app, "stopMihomo");
    Ok(result)
}

async fn reload_mihomo_config(
    app: &AppHandle,
    state: &State<'_, AppState>,
    args: &[Value],
) -> CompatResult {
    let config_path = arg_string(args, 0)
        .or_else(|| read_last_config(app).ok().flatten())
        .unwrap_or_default();
    let result = reload_core_config(app, state, &config_path).await?;
    refresh_tray_menu_after(app, "reloadMihomoConfig");
    Ok(result)
}

async fn restart_service(
    app: &AppHandle,
    window: &WebviewWindow,
    state: &State<'_, AppState>,
    args: &[Value],
) -> CompatResult {
    let config_path = arg_string(args, 0)
        .or_else(|| read_last_config(app).ok().flatten())
        .unwrap_or_default();
    let result = start_core(app, state, &config_path).await?;
    let event_payload = if result
        .get("success")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        json!({ "success": true })
    } else {
        json!({
            "success": false,
            "error": result
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("Failed to restart service")
        })
    };
    let _ = window.emit("service-restarted", event_payload);
    refresh_tray_menu_after(app, "restartService");
    Ok(result)
}
