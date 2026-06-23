use serde_json::{json, Value};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

use crate::core::{lifecycle as core_lifecycle, manager::RunningMode, service as core_service};
use crate::core_commands::{
    emit_core_error, emit_core_progress, find_mihomo_executable, service_compatible_core_path,
};
use crate::profiles::{
    config_content, emit_active_config_changed, ensure_minimal_mihomo_config,
    normalize_config_reference, read_last_config, read_subscriptions, save_last_config,
};
use crate::resources::mihomo_dir;
use crate::runtime::{
    is_mihomo_running, set_runtime_running_mode, sync_core_running_state,
    sync_mihomo_plugin_endpoint,
};
use crate::runtime_config::{prepare_runtime_config, runtime_config_error_response};
use crate::state::AppState;
use crate::storage::set_setting;

type CompatResult = Result<Value, String>;

fn success(value: Value) -> Value {
    match value {
        Value::Object(mut map) => {
            map.entry("success").or_insert(Value::Bool(true));
            Value::Object(map)
        }
        other => json!({ "success": true, "data": other }),
    }
}

async fn wait_for_mihomo(app: &AppHandle) -> bool {
    for _ in 0..30 {
        if crate::mihomo_transport::request(app, Some("/version".to_string()), None)
            .await
            .map(|value| value.get("ok").and_then(Value::as_bool).unwrap_or(false))
            .unwrap_or(false)
        {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    false
}

pub(crate) async fn stop_mihomo_process(
    app: &AppHandle,
    state: &State<'_, AppState>,
) -> Result<(), String> {
    let _ = sync_core_running_state(app);
    let running_mode = {
        let runtime = state.runtime.lock().expect("runtime mutex poisoned");
        core_lifecycle::stop_mode(&runtime.core)
    };

    if running_mode == RunningMode::Service {
        match core_lifecycle::stop_service_core_checked() {
            Ok(core_lifecycle::ServiceCoreStopResult::Stopped) => {}
            Ok(core_lifecycle::ServiceCoreStopResult::AlreadyStoppedAfterError { error }) => {
                eprintln!(
                    "[core-service] stop helper returned an error after service stopped: {error}"
                );
            }
            Err(error) => {
                eprintln!("[core-service] failed to stop core through helper: {error}");
                let _ = app.emit("mihomo-stop-failed", json!({ "error": error }));
                return Err(error);
            }
        }
    }

    {
        let mut runtime = state.runtime.lock().expect("runtime mutex poisoned");
        core_lifecycle::complete_core_stop(&mut runtime.core);
    }
    set_runtime_running_mode(app, RunningMode::NotRunning);
    Ok(())
}

pub(crate) async fn start_mihomo(
    app: &AppHandle,
    state: &State<'_, AppState>,
    config_path: &str,
) -> CompatResult {
    let config_path = if config_path.trim().is_empty() {
        startup_mihomo_config(app)?
            .ok_or_else(|| "没有可用的配置文件，且最小配置创建失败".to_string())?
    } else {
        normalize_config_reference(app, config_path)?
    };
    let _ = config_content(app, &config_path)
        .map_err(|err| format!("配置文件不存在或无法解密: {err}"))?;

    let mihomo = find_mihomo_executable(app)?;
    let runtime_config = match prepare_runtime_config(app, &config_path, &mihomo) {
        Ok(path) => path,
        Err(error) => {
            return Ok(runtime_config_error_response(&error, None));
        }
    };
    let work_dir = mihomo_dir(app)?;
    let log_path = work_dir.join("mihomo.log");

    if let Err(error) = stop_mihomo_process(app, state).await {
        return Ok(
            core_lifecycle::start_failure_completion(format!("停止现有内核失败: {error}")).response,
        );
    }

    if crate::tun_service::should_start_core_by_service(app) {
        let service_mihomo = service_compatible_core_path(app, &mihomo)?;
        if let Err(error) = core_service::ensure_helper_service_ready() {
            return Ok(core_lifecycle::start_failure_completion(format!(
                "TUN 服务模式已启用，但 Helper 服务不可用: {error}"
            ))
            .response);
        }

        set_runtime_running_mode(app, RunningMode::Service);
        match core_lifecycle::start_service_core(
            &service_mihomo,
            &work_dir,
            &runtime_config,
            &log_path,
        ) {
            Ok(launch) => {
                let controller_endpoint = launch.controller_endpoint;
                if let Err(error) = sync_mihomo_plugin_endpoint(app, &controller_endpoint).await {
                    let start_failure = core_lifecycle::start_failure_completion(format!(
                        "同步 Mihomo IPC 控制通道失败: {error}"
                    ));
                    set_runtime_running_mode(app, RunningMode::NotRunning);
                    {
                        let mut runtime = state.runtime.lock().expect("runtime mutex poisoned");
                        core_lifecycle::abort_service_launch(&mut runtime.core);
                    }
                    let _ = app.emit(
                        "mihomo-start-failed",
                        json!({ "error": start_failure.error.clone().unwrap_or_default() }),
                    );
                    return Ok(start_failure.response);
                }
                {
                    let mut runtime = state.runtime.lock().expect("runtime mutex poisoned");
                    core_lifecycle::begin_service_launch(
                        &mut runtime.core,
                        controller_endpoint.clone(),
                    );
                }
                let service_start = {
                    let controller_ready = wait_for_mihomo(app).await;
                    let mut runtime = state.runtime.lock().expect("runtime mutex poisoned");
                    core_lifecycle::complete_service_launch_with_response(
                        &mut runtime.core,
                        controller_endpoint.clone(),
                        config_path.clone(),
                        controller_ready,
                    )
                };

                if service_start.started {
                    save_last_config(app, &config_path)?;
                    emit_active_config_changed(app, Some(&config_path));
                    return Ok(service_start.response);
                }

                let error = service_start
                    .error
                    .clone()
                    .unwrap_or_else(|| "Helper 服务启动内核失败".to_string());
                let _ = core_lifecycle::stop_service_core();
                set_runtime_running_mode(app, RunningMode::NotRunning);
                {
                    let mut runtime = state.runtime.lock().expect("runtime mutex poisoned");
                    core_lifecycle::abort_service_launch(&mut runtime.core);
                }
                let _ = app.emit("mihomo-start-failed", json!({ "error": error }));
                return Ok(service_start.response);
            }
            Err(error) => {
                let start_failure = core_lifecycle::start_failure_completion(format!(
                    "通过 Helper 服务启动内核失败: {error}"
                ));
                set_runtime_running_mode(app, RunningMode::NotRunning);
                {
                    let mut runtime = state.runtime.lock().expect("runtime mutex poisoned");
                    core_lifecycle::abort_service_launch(&mut runtime.core);
                }
                let _ = app.emit(
                    "mihomo-start-failed",
                    json!({ "error": start_failure.error.clone().unwrap_or_default() }),
                );
                return Ok(start_failure.response);
            }
        }
    }

    let sidecar =
        match core_lifecycle::start_sidecar_core(&mihomo, &work_dir, &runtime_config, &log_path) {
            Ok(sidecar) => sidecar,
            Err(error) => {
                let start_failure =
                    core_lifecycle::start_failure_completion(format!("启动内核失败: {error}"));
                let _ = app.emit(
                    "mihomo-start-failed",
                    json!({ "error": start_failure.error.clone().unwrap_or_default() }),
                );
                return Ok(start_failure.response);
            }
        };

    let sidecar_controller_endpoint = sidecar.controller_endpoint.clone();
    if let Err(error) = sync_mihomo_plugin_endpoint(app, &sidecar_controller_endpoint).await {
        let start_failure = core_lifecycle::start_failure_completion(format!(
            "同步 Mihomo IPC 控制通道失败: {error}"
        ));
        set_runtime_running_mode(app, RunningMode::NotRunning);
        let _ = app.emit(
            "mihomo-start-failed",
            json!({ "error": start_failure.error.clone().unwrap_or_default() }),
        );
        return Ok(start_failure.response);
    }

    {
        let mut runtime = state.runtime.lock().expect("runtime mutex poisoned");
        core_lifecycle::begin_sidecar_launch(&mut runtime.core, sidecar);
    }
    set_runtime_running_mode(app, RunningMode::Sidecar);

    let sidecar_start = {
        let controller_ready = wait_for_mihomo(app).await;
        let mut runtime = state.runtime.lock().expect("runtime mutex poisoned");
        core_lifecycle::complete_sidecar_launch_with_response(
            &mut runtime.core,
            config_path.clone(),
            controller_ready,
        )
    };

    if sidecar_start.started {
        save_last_config(app, &config_path)?;
        emit_active_config_changed(app, Some(&config_path));
        Ok(sidecar_start.response)
    } else {
        let error = sidecar_start
            .error
            .clone()
            .unwrap_or_else(|| "内核启动失败".to_string());
        {
            let mut runtime = state.runtime.lock().expect("runtime mutex poisoned");
            core_lifecycle::abort_sidecar_launch(&mut runtime.core);
        }
        set_runtime_running_mode(app, RunningMode::NotRunning);
        let _ = app.emit("mihomo-start-failed", json!({ "error": error }));
        Ok(sidecar_start.response)
    }
}

pub(crate) fn startup_mihomo_config(app: &AppHandle) -> Result<Option<String>, String> {
    if let Some(config_path) = read_last_config(app)? {
        if config_content(app, &config_path).is_ok() {
            return Ok(Some(config_path));
        }
        eprintln!("[mihomo-autostart] saved active config is not readable, falling back");
    }

    for subscription in read_subscriptions(app)? {
        if config_content(app, &subscription.path).is_ok() {
            return Ok(Some(subscription.path));
        }
    }

    Ok(Some(ensure_minimal_mihomo_config(app)?))
}

pub(crate) fn schedule_mihomo_autostart(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(1000)).await;

        let state = app.state::<AppState>();
        if is_mihomo_running(&app) {
            let config_path = state
                .runtime
                .lock()
                .expect("runtime mutex poisoned")
                .core
                .active_config_owned()
                .or_else(|| read_last_config(&app).ok().flatten());
            let _ = app.emit(
                "mihomo-autostart",
                json!({ "success": true, "existing": true, "configPath": config_path }),
            );
            return;
        }

        let config_path = match startup_mihomo_config(&app) {
            Ok(Some(config_path)) => config_path,
            Ok(None) => {
                eprintln!("[mihomo-autostart] no available config, skip startup");
                return;
            }
            Err(error) => {
                eprintln!("[mihomo-autostart] failed to resolve startup config: {error}");
                let _ = app.emit(
                    "mihomo-autostart",
                    json!({ "success": false, "error": error }),
                );
                return;
            }
        };

        match start_mihomo(&app, &state, &config_path).await {
            Ok(result) => {
                let success = result
                    .get("success")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let payload = if success {
                    json!({ "success": true, "configPath": config_path })
                } else {
                    let error = result
                        .get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("Mihomo 自动启动失败");
                    eprintln!("[mihomo-autostart] start failed: {error}");
                    json!({
                        "success": false,
                        "configPath": config_path,
                        "error": error
                    })
                };
                let _ = app.emit("mihomo-autostart", payload);
            }
            Err(error) => {
                eprintln!("[mihomo-autostart] start failed: {error}");
                let _ = app.emit("mihomo-start-failed", json!({ "error": error.clone() }));
                let _ = app.emit(
                    "mihomo-autostart",
                    json!({ "success": false, "configPath": config_path, "error": error }),
                );
            }
        }
    });
}

pub(crate) async fn reload_mihomo_config(
    app: &AppHandle,
    state: &State<'_, AppState>,
    config_path: &str,
) -> CompatResult {
    let config_path = normalize_config_reference(app, config_path)?;
    if config_path.trim().is_empty() {
        return Ok(json!({
            "success": false,
            "error": "配置文件路径为空，无法热重载"
        }));
    }

    let _ = config_content(app, &config_path)
        .map_err(|err| format!("配置文件不存在或无法解密: {err}"))?;

    if !is_mihomo_running(app) {
        return Ok(json!({
            "success": false,
            "error": "Mihomo 服务未运行，无法热重载配置"
        }));
    }

    let mihomo = find_mihomo_executable(app)?;
    let runtime_config = match prepare_runtime_config(app, &config_path, &mihomo) {
        Ok(path) => path,
        Err(error) => {
            return Ok(runtime_config_error_response(&error, Some(false)));
        }
    };
    let reload_request = core_lifecycle::reload_config_request(&runtime_config);
    let response = crate::mihomo_transport::request(
        app,
        Some(reload_request.endpoint.to_string()),
        Some(reload_request.options),
    )
    .await?;

    let reload_completion = {
        let mut runtime = state.runtime.lock().expect("runtime mutex poisoned");
        core_lifecycle::complete_reload_from_response(
            &mut runtime.core,
            config_path.clone(),
            &response,
        )
    };

    if reload_completion.applied {
        save_last_config(app, &config_path)?;
        emit_active_config_changed(app, Some(&config_path));
    }

    Ok(reload_completion.response)
}

pub(crate) async fn refresh_active_config_after_override(
    app: &AppHandle,
    state: &State<'_, AppState>,
) -> Value {
    if !is_mihomo_running(app) {
        return json!({
            "reloaded": false,
            "skipped": true,
            "reason": "mihomo-not-running"
        });
    }

    let active = state
        .runtime
        .lock()
        .expect("runtime mutex poisoned")
        .core
        .active_config_owned()
        .or_else(|| read_last_config(app).ok().flatten());

    let Some(config_path) = active else {
        return json!({
            "reloaded": false,
            "skipped": true,
            "reason": "no-active-config"
        });
    };

    match reload_mihomo_config(app, state, &config_path).await {
        Ok(result) => {
            let reloaded = result
                .get("success")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            json!({
                "reloaded": reloaded,
                "configPath": config_path,
                "result": result
            })
        }
        Err(error) => json!({
            "reloaded": false,
            "configPath": config_path,
            "error": error
        }),
    }
}

pub(crate) async fn restart_active_config_after_core_switch(
    app: &AppHandle,
    window: &WebviewWindow,
    state: &State<'_, AppState>,
    core_type: &str,
    version: Option<&str>,
) -> Value {
    if !is_mihomo_running(app) {
        return json!({
            "restarted": false,
            "skipped": true,
            "reason": "mihomo-not-running"
        });
    }

    let active = state
        .runtime
        .lock()
        .expect("runtime mutex poisoned")
        .core
        .active_config_owned()
        .or_else(|| read_last_config(app).ok().flatten());

    let Some(config_path) = active else {
        return json!({
            "restarted": false,
            "skipped": true,
            "reason": "no-active-config"
        });
    };

    emit_core_progress(window, core_type, version, "restarting", 100.0, 0, 0);
    match start_mihomo(app, state, &config_path).await {
        Ok(result) => {
            let restarted = result
                .get("success")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let event_payload = if restarted {
                emit_core_progress(window, core_type, version, "done", 100.0, 0, 0);
                json!({ "success": true })
            } else {
                let error = result
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("Failed to restart service");
                emit_core_error(window, core_type, version, error);
                json!({
                    "success": false,
                    "error": error
                })
            };
            let _ = window.emit("service-restarted", event_payload);
            json!({
                "restarted": restarted,
                "configPath": config_path,
                "result": result
            })
        }
        Err(error) => {
            emit_core_error(window, core_type, version, &error);
            let _ = window.emit(
                "service-restarted",
                json!({
                    "success": false,
                    "error": error
                }),
            );
            json!({
                "restarted": false,
                "configPath": config_path,
                "error": error
            })
        }
    }
}

pub(crate) async fn apply_saved_config(
    app: &AppHandle,
    window: &WebviewWindow,
    state: &State<'_, AppState>,
    section: &str,
) -> CompatResult {
    let active = state
        .runtime
        .lock()
        .expect("runtime mutex poisoned")
        .core
        .active_config_owned()
        .or(read_last_config(app)?);
    let Some(config_path) = active else {
        return Ok(success(json!({
            "restarted": false,
            "message": format!("{section} config saved, but no active config is selected")
        })));
    };

    if !is_mihomo_running(app) {
        return Ok(success(json!({
            "restarted": false,
            "message": format!("{section} config saved, start Mihomo to apply it")
        })));
    }

    match start_mihomo(app, state, &config_path).await {
        Ok(result) => {
            let restarted = result
                .get("success")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let event_payload = if restarted {
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
            Ok(success(json!({
                "restarted": restarted,
                "message": if restarted {
                    format!("{section} config saved and applied")
                } else {
                    format!("{section} config saved, but restart failed")
                }
            })))
        }
        Err(error) => Ok(success(json!({
            "restarted": false,
            "message": format!("{section} config saved, but restart failed: {error}")
        }))),
    }
}

pub(crate) async fn apply_tun_runtime_change(
    app: &AppHandle,
    window: &WebviewWindow,
    state: &State<'_, AppState>,
    enabled: bool,
    previous_enabled: bool,
    rollback_on_failure: bool,
) -> CompatResult {
    let active = state
        .runtime
        .lock()
        .expect("runtime mutex poisoned")
        .core
        .active_config_owned()
        .or(read_last_config(app)?);

    if active.is_none() || !is_mihomo_running(app) {
        let _ = window.emit("tun-status", enabled);
        return Ok(success(json!({
            "enabled": enabled,
            "pending": true,
            "restarted": false,
            "message": if enabled {
                "TUN 配置已保存，将在下次启动 Mihomo 时生效"
            } else {
                "TUN 已关闭，将在下次启动 Mihomo 时生效"
            }
        })));
    }

    let config_path = active.unwrap_or_default();
    let result = start_mihomo(app, state, &config_path).await;
    match result {
        Ok(value)
            if value
                .get("success")
                .and_then(Value::as_bool)
                .unwrap_or(false) =>
        {
            let _ = window.emit("service-restarted", json!({ "success": true }));
            let _ = window.emit("tun-status", enabled);
            Ok(success(json!({
                "enabled": enabled,
                "pending": false,
                "restarted": true,
                "message": if enabled {
                    "TUN 模式已启用，Mihomo 已重启"
                } else {
                    "TUN 模式已关闭，Mihomo 已重启"
                }
            })))
        }
        Ok(value) => {
            let error = value
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("内核重启失败，请检查配置")
                .to_string();
            if rollback_on_failure {
                set_setting(app, "tunModeEnabled", json!(previous_enabled))?;
                let _ = window.emit("tun-status", previous_enabled);
            }
            let _ = window.emit(
                "service-restarted",
                json!({ "success": false, "error": error }),
            );
            Ok(json!({
                "success": false,
                "enabled": if rollback_on_failure { previous_enabled } else { enabled },
                "pending": false,
                "restarted": false,
                "error": error
            }))
        }
        Err(error) => {
            if rollback_on_failure {
                set_setting(app, "tunModeEnabled", json!(previous_enabled))?;
                let _ = window.emit("tun-status", previous_enabled);
            }
            let _ = window.emit(
                "service-restarted",
                json!({ "success": false, "error": error }),
            );
            Ok(json!({
                "success": false,
                "enabled": if rollback_on_failure { previous_enabled } else { enabled },
                "pending": false,
                "restarted": false,
                "error": error
            }))
        }
    }
}
