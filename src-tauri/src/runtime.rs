use serde_json::json;
use tauri::{AppHandle, Manager};
use tauri_plugin_mihomo::MihomoExt as _;

use crate::core::{controller as core_controller, manager::RunningMode, service as core_service};
use crate::profiles::read_last_config;
use crate::state::AppState;
use crate::storage::{set_setting, setting};

fn runtime_running_mode(app: &AppHandle) -> RunningMode {
    match setting(app, "coreRunningMode", json!("notRunning"))
        .ok()
        .and_then(|value| value.as_str().map(ToString::to_string))
        .unwrap_or_else(|| "notRunning".to_string())
        .as_str()
    {
        "service" => RunningMode::Service,
        "sidecar" => RunningMode::Sidecar,
        _ => RunningMode::NotRunning,
    }
}

pub(crate) fn set_runtime_running_mode(app: &AppHandle, mode: RunningMode) {
    let value = match mode {
        RunningMode::Service => "service",
        RunningMode::Sidecar => "sidecar",
        RunningMode::NotRunning => "notRunning",
    };
    let _ = set_setting(app, "coreRunningMode", json!(value));
}

fn runtime_controller_endpoint(app: &AppHandle) -> core_controller::ControllerEndpoint {
    core_controller::endpoint_for_mode(runtime_running_mode(app))
        .unwrap_or_else(core_controller::sidecar_endpoint)
}

pub(crate) fn sync_core_running_state(app: &AppHandle) -> bool {
    let state = app.state::<AppState>();
    let persisted_mode = runtime_running_mode(app);
    let memory_mode = {
        let runtime = state.runtime.lock().expect("runtime mutex poisoned");
        runtime.core.running_mode()
    };
    let mode = if memory_mode == RunningMode::NotRunning {
        persisted_mode
    } else {
        memory_mode
    };

    match mode {
        RunningMode::Service => match core_service::get_status() {
            Ok(status) if status.running => {
                let active_config = read_last_config(app).ok().flatten();
                {
                    let mut runtime = state.runtime.lock().expect("runtime mutex poisoned");
                    runtime
                        .core
                        .sync_service_running(core_controller::service_endpoint(), active_config);
                }
                set_runtime_running_mode(app, RunningMode::Service);
                true
            }
            _ => {
                {
                    let mut runtime = state.runtime.lock().expect("runtime mutex poisoned");
                    runtime.core.sync_service_stopped();
                }
                set_runtime_running_mode(app, RunningMode::NotRunning);
                false
            }
        },
        RunningMode::Sidecar => {
            let running = {
                let mut runtime = state.runtime.lock().expect("runtime mutex poisoned");
                runtime.core.is_running()
            };
            set_runtime_running_mode(
                app,
                if running {
                    RunningMode::Sidecar
                } else {
                    RunningMode::NotRunning
                },
            );
            running
        }
        RunningMode::NotRunning => false,
    }
}

pub(crate) fn active_runtime_controller_endpoint(
    app: &AppHandle,
) -> core_controller::ControllerEndpoint {
    let _ = sync_core_running_state(app);
    let state = app.state::<AppState>();
    let runtime = state.runtime.lock().expect("runtime mutex poisoned");
    runtime
        .core
        .controller_endpoint_owned()
        .unwrap_or_else(|| runtime_controller_endpoint(app))
}

pub(crate) async fn sync_mihomo_plugin_endpoint(
    app: &AppHandle,
    endpoint: &core_controller::ControllerEndpoint,
) -> Result<(), String> {
    app.mihomo()
        .write()
        .await
        .update_socket_path(endpoint.path.clone())
        .map_err(|err| err.to_string())
}

pub(crate) fn is_mihomo_running(app: &AppHandle) -> bool {
    sync_core_running_state(app)
}
