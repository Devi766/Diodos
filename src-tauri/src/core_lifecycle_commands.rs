use serde_json::{json, Value};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

use crate::core::{lifecycle as core_lifecycle, manager::RunningMode};
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
    // Provider-heavy configs can take longer before /version answers.
    // Also re-sync the controller endpoint each attempt so service/sidecar
    // switches never keep probing a stale pipe path.
    for attempt in 0..100 {
        let endpoint = crate::runtime::active_runtime_controller_endpoint(app);
        if let Err(error) =
            crate::runtime::sync_mihomo_plugin_endpoint(app, &endpoint).await
        {
            if attempt == 0 || attempt % 10 == 0 {
                eprintln!(
                    "[core-start] controller endpoint sync failed (attempt {}): {error}",
                    attempt + 1
                );
            }
        }

        if crate::mihomo_transport::request(app, Some("/version".to_string()), None)
            .await
            .map(|value| value.get("ok").and_then(Value::as_bool).unwrap_or(false))
            .unwrap_or(false)
        {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    false
}

#[cfg(target_os = "windows")]
fn kill_leftover_core_processes_windows() {
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let script = r#"
$ErrorActionPreference='SilentlyContinue'
$names = @('mihomo.exe','mihomo-smart.exe','mihomo-alpha.exe','mihomo-meta.exe','FlyClash-Core.exe','flyclash-core.exe')
Get-CimInstance Win32_Process |
  Where-Object {
    $_.Name -and (
      ($names -contains $_.Name) -or
      ($_.CommandLine -and (
        $_.CommandLine -match 'work-config\.yaml' -or
        $_.CommandLine -match 'pipe\\flycast-mihomo' -or
        $_.CommandLine -match 'pipe\\flycast-mihomo-service' -or
        $_.CommandLine -match 'pipe\\FlyClash\\mihomo' -or
        $_.CommandLine -match 'com\.flyclash\.desktop\\mihomo' -or
        $_.CommandLine -match 'AppData\\Roaming\\com\.flyclash\.desktop\\cores'
      ))
    )
  } |
  ForEach-Object {
    try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {}
  }
"#;
    let _ = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script,
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .status();
}

fn free_local_mixed_port(port: u16) {
    if port == 0 {
        return;
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        use std::process::Command;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let script = format!(
            r#"
$ErrorActionPreference='SilentlyContinue'
Get-NetTCPConnection -LocalPort {port} -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object {{
    $proc = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue
    if ($proc -and ($proc.ProcessName -match 'mihomo|flyclash-core|FlyClash-Core')) {{
      Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    }}
  }}
"#
        );
        let _ = Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                &script,
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .status();
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = port;
    }
}

/// Resolve and validate everything needed to start the core, without launching it.
///
/// AppHandle-bound IO is injected via `CoreStartPrepDeps`; pure path decisions live
/// in `core::lifecycle` / `core::paths`. Concrete binary discovery and service-path
/// copy logic are pure helpers; this adapter only supplies AppHandle-backed inputs.
struct AppCoreStartPrepDeps<'a> {
    app: &'a AppHandle,
}

impl core_lifecycle::CoreStartPrepDeps for AppCoreStartPrepDeps<'_> {
    fn resolve_config_path(
        &self,
        raw: &str,
    ) -> Result<String, core_lifecycle::CoreStartPrepError> {
        match core_lifecycle::start_config_path_decision(raw) {
            Some(path) => normalize_config_reference(self.app, path)
                .map_err(core_lifecycle::CoreStartPrepError::message),
            None => match startup_mihomo_config(self.app) {
                Ok(Some(path)) => Ok(path),
                Ok(None) => Err(core_lifecycle::CoreStartPrepError::message(
                    "没有可用的配置文件，且最小配置创建失败",
                )),
                Err(err) => Err(core_lifecycle::CoreStartPrepError::message(err)),
            },
        }
    }

    fn ensure_config_readable(
        &self,
        config_path: &str,
    ) -> Result<(), core_lifecycle::CoreStartPrepError> {
        config_content(self.app, config_path)
            .map(|_| ())
            .map_err(|err| {
                core_lifecycle::CoreStartPrepError::message(format!(
                    "配置文件不存在或无法解密: {err}"
                ))
            })
    }

    fn find_core_executable(
        &self,
    ) -> Result<std::path::PathBuf, core_lifecycle::CoreStartPrepError> {
        find_mihomo_executable(self.app).map_err(core_lifecycle::CoreStartPrepError::message)
    }

    fn prepare_runtime_config(
        &self,
        config_path: &str,
        executable: &std::path::Path,
    ) -> Result<std::path::PathBuf, core_lifecycle::CoreStartPrepError> {
        match prepare_runtime_config(self.app, config_path, executable) {
            Ok(path) => Ok(path),
            Err(error) => Err(core_lifecycle::CoreStartPrepError::runtime_config(
                runtime_config_error_response(&error, None),
            )),
        }
    }

    fn work_dir(&self) -> Result<std::path::PathBuf, core_lifecycle::CoreStartPrepError> {
        mihomo_dir(self.app).map_err(core_lifecycle::CoreStartPrepError::message)
    }

    fn should_use_service_mode(&self) -> bool {
        crate::tun_service::should_start_core_by_service(self.app)
    }

    fn service_compatible_executable(
        &self,
        executable: &std::path::Path,
    ) -> Result<std::path::PathBuf, core_lifecycle::CoreStartPrepError> {
        service_compatible_core_path(self.app, executable)
            .map_err(core_lifecycle::CoreStartPrepError::message)
    }
}

fn prepare_core_start_context(
    app: &AppHandle,
    config_path: &str,
) -> Result<core_lifecycle::CoreStartContext, CompatResult> {
    let deps = AppCoreStartPrepDeps { app };
    match core_lifecycle::prepare_core_start_context_with_deps(&deps, config_path) {
        Ok(context) => Ok(context),
        Err(core_lifecycle::CoreStartPrepError::RuntimeConfig(value)) => Err(Ok(value)),
        Err(core_lifecycle::CoreStartPrepError::Message(message)) => {
            // Prefer structured failure payload for "no config" so UI can treat it
            // like other start failures.
            if message.contains("没有可用的配置文件") {
                Err(Ok(
                    core_lifecycle::start_failure_completion(message).response
                ))
            } else {
                Err(Err(message))
            }
        }
    }
}

fn persist_started_config(app: &AppHandle, config_path: &str) -> Result<(), String> {
    save_last_config(app, config_path)?;
    emit_active_config_changed(app, Some(config_path));
    Ok(())
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

    // Always try helper stop first when a Windows helper service is present.
    // Mode memory can be wrong after crashes / dual-process races (sidecar +
    // service core both alive). Best-effort: ignore helper errors unless we
    // know we are in service mode.
    if cfg!(target_os = "windows") {
        match core_lifecycle::stop_service_core_checked() {
            Ok(core_lifecycle::ServiceCoreStopResult::Stopped) => {}
            Ok(core_lifecycle::ServiceCoreStopResult::AlreadyStoppedAfterError { error }) => {
                eprintln!(
                    "[core-service] stop helper returned an error after service stopped: {error}"
                );
            }
            Err(error) => {
                if running_mode == RunningMode::Service {
                    eprintln!("[core-service] failed to stop core through helper: {error}");
                    let _ = app.emit("mihomo-stop-failed", json!({ "error": error.clone() }));
                    return Err(error);
                }
                eprintln!(
                    "[core-service] best-effort helper stop ignored (mode={running_mode:?}): {error}"
                );
            }
        }
    } else if running_mode == RunningMode::Service {
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
        // finish_stop kills sidecar child when mode is Sidecar; always safe.
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
    let prepared = match prepare_core_start_context(app, config_path) {
        Ok(prepared) => prepared,
        Err(result) => return result,
    };
    let config_path = prepared.config_path.clone();
    let runtime_config = prepared.paths.runtime_config.clone();
    let work_dir = prepared.paths.work_dir.clone();
    let log_path = prepared.paths.log_path.clone();

    if let Err(error) = stop_mihomo_process(app, state).await {
        return Ok(
            core_lifecycle::start_failure_completion(format!("停止现有内核失败: {error}")).response,
        );
    }

    // Extra hard cleanup for dual-process races:
    // helper-managed core + leftover sidecar/user core can both hold 7890 / pipes.
    #[cfg(target_os = "windows")]
    {
        kill_leftover_core_processes_windows();
        free_local_mixed_port(7890);
        // Give SCM / process table a brief moment after forced kills.
        tokio::time::sleep(Duration::from_millis(250)).await;
    }

    if matches!(prepared.start_path, core_lifecycle::CoreStartPath::Service) {
        match crate::tun_service::ensure_helper_service_current(app) {
            Ok(()) => {
                set_runtime_running_mode(app, RunningMode::Service);
                match core_lifecycle::start_service_core(
                    prepared.launch_executable(),
                    &work_dir,
                    &runtime_config,
                    &log_path,
                ) {
                    Ok(launch) => {
                        let controller_endpoint = launch.controller_endpoint;
                        let plugin_sync =
                            sync_mihomo_plugin_endpoint(app, &controller_endpoint).await;
                        // Do not hard-fail service starts on controller warm-up.
                        // Helper ownership already confirmed the core process.
                        let controller_ready = if plugin_sync.is_ok() {
                            wait_for_mihomo(app).await
                        } else {
                            false
                        };
                        if plugin_sync.is_ok() && !controller_ready {
                            eprintln!(
                                "[core-service] helper started core; controller still warming up"
                            );
                        }
                        let service_start = {
                            let mut runtime =
                                state.runtime.lock().expect("runtime mutex poisoned");
                            core_lifecycle::service_start_after_spawn(
                                &mut runtime.core,
                                controller_endpoint,
                                config_path.clone(),
                                // Plugin sync failure still fails the start.
                                plugin_sync.is_ok(),
                                true,
                                plugin_sync.err().map(|err| err.to_string()),
                            )
                        };

                        if service_start.started {
                            persist_started_config(app, &config_path)?;
                            // Continue probing controller in background without
                            // blocking the UI start success path.
                            let probe_app = app.clone();
                            tauri::async_runtime::spawn(async move {
                                let _ = wait_for_mihomo(&probe_app).await;
                            });
                            return Ok(service_start.response);
                        }

                        set_runtime_running_mode(app, RunningMode::NotRunning);
                        let error = service_start
                            .error
                            .clone()
                            .unwrap_or_else(|| "Helper 服务启动内核失败".to_string());
                        let _ = app.emit("mihomo-start-failed", json!({ "error": error }));
                        // Fall through to sidecar if service handoff failed.
                    }
                    Err(error) => {
                        eprintln!(
                            "[core-service] helper start failed, falling back to sidecar: {error}"
                        );
                        set_runtime_running_mode(app, RunningMode::NotRunning);
                    }
                }
            }
            Err(error) => {
                eprintln!(
                    "[core-service] helper unavailable, falling back to sidecar: {error}"
                );
                set_runtime_running_mode(app, RunningMode::NotRunning);
            }
        }
    }

    let sidecar = match core_lifecycle::start_sidecar_core(
        prepared.launch_executable(),
        &work_dir,
        &runtime_config,
        &log_path,
    ) {
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
    let plugin_sync = sync_mihomo_plugin_endpoint(app, &sidecar_controller_endpoint).await;
    let controller_ready = if plugin_sync.is_ok() {
        wait_for_mihomo(app).await
    } else {
        false
    };

    if plugin_sync.is_ok() {
        set_runtime_running_mode(app, RunningMode::Sidecar);
    }

    let sidecar_start = {
        let mut runtime = state.runtime.lock().expect("runtime mutex poisoned");
        core_lifecycle::sidecar_start_after_spawn(
            &mut runtime.core,
            sidecar,
            config_path.clone(),
            plugin_sync.is_ok(),
            controller_ready,
            plugin_sync.err().map(|err| err.to_string()),
        )
    };

    if sidecar_start.started {
        persist_started_config(app, &config_path)?;
        Ok(sidecar_start.response)
    } else {
        set_runtime_running_mode(app, RunningMode::NotRunning);
        let error = sidecar_start
            .error
            .clone()
            .unwrap_or_else(|| "内核启动失败".to_string());
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
            let preferred = read_last_config(&app).ok().flatten();
            let config_path = state
                .runtime
                .lock()
                .expect("runtime mutex poisoned")
                .core
                .prefer_runtime_or_preferred(preferred);
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
                        .unwrap_or("内核自动启动失败");
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
            "error": "内核服务未运行，无法热重载配置"
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

    let preferred = read_last_config(app).ok().flatten();
    let active = state
        .runtime
        .lock()
        .expect("runtime mutex poisoned")
        .core
        .prefer_runtime_or_preferred(preferred);

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

    let preferred = read_last_config(app).ok().flatten();
    let active = state
        .runtime
        .lock()
        .expect("runtime mutex poisoned")
        .core
        .prefer_runtime_or_preferred(preferred);

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
    let preferred = read_last_config(app)?;
    let active = state
        .runtime
        .lock()
        .expect("runtime mutex poisoned")
        .core
        .prefer_runtime_or_preferred(preferred);
    let Some(config_path) = active else {
        return Ok(success(json!({
            "restarted": false,
            "message": format!("{section} config saved, but no active config is selected")
        })));
    };

    if !is_mihomo_running(app) {
        return Ok(success(json!({
            "restarted": false,
            "message": format!("{section} config saved, start core to apply it")
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
    let preferred = read_last_config(app)?;
    let active = state
        .runtime
        .lock()
        .expect("runtime mutex poisoned")
        .core
        .prefer_runtime_or_preferred(preferred);

    if active.is_none() || !is_mihomo_running(app) {
        let _ = window.emit("tun-status", enabled);
        return Ok(success(json!({
            "enabled": enabled,
            "pending": true,
            "restarted": false,
            "message": if enabled {
                "TUN 配置已保存，将在下次启动内核时生效"
            } else {
                "TUN 已关闭，将在下次启动内核时生效"
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
                    "TUN 模式已启用，内核已重启"
                } else {
                    "TUN 模式已关闭，内核已重启"
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
