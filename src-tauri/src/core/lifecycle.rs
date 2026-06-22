use std::path::Path;

use super::{
    controller::{self, ControllerEndpoint},
    manager::{CoreManager, RunningMode},
    service, sidecar,
};
use serde_json::{json, Value};

pub struct ServiceCoreLaunch {
    pub controller_endpoint: ControllerEndpoint,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CoreStartMode {
    Service,
    Sidecar,
}

impl CoreStartMode {
    pub fn controller_timeout_error(self) -> &'static str {
        match self {
            Self::Service => "Helper 已启动内核，但 controller 未在超时时间内就绪",
            Self::Sidecar => "Mihomo 已启动但 controller 未在超时时间内就绪",
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Service => "service",
            Self::Sidecar => "sidecar",
        }
    }
}

pub fn controller_ready_outcome(mode: CoreStartMode, controller_ready: bool) -> Result<(), String> {
    if controller_ready {
        Ok(())
    } else {
        Err(mode.controller_timeout_error().to_string())
    }
}

pub fn begin_service_launch(manager: &mut CoreManager, controller_endpoint: ControllerEndpoint) {
    manager.begin_service_start(controller_endpoint);
}

pub fn complete_service_launch(
    manager: &mut CoreManager,
    controller_endpoint: ControllerEndpoint,
    config_path: String,
    controller_ready: bool,
) -> Result<(), String> {
    controller_ready_outcome(CoreStartMode::Service, controller_ready)?;
    manager.complete_service_start(controller_endpoint, config_path);
    Ok(())
}

pub fn begin_sidecar_launch(manager: &mut CoreManager, launch: sidecar::SidecarProcess) {
    manager.begin_sidecar_start(launch.child, launch.controller_endpoint);
}

pub fn complete_sidecar_launch(
    manager: &mut CoreManager,
    config_path: String,
    controller_ready: bool,
) -> Result<(), String> {
    controller_ready_outcome(CoreStartMode::Sidecar, controller_ready)?;
    manager.complete_sidecar_start(config_path);
    Ok(())
}

#[derive(Debug, Clone, PartialEq)]
pub struct CoreStartCompletion {
    pub started: bool,
    pub error: Option<String>,
    pub response: Value,
}

pub fn start_success_completion(config_path: String, mode: CoreStartMode) -> CoreStartCompletion {
    CoreStartCompletion {
        started: true,
        error: None,
        response: json!({
            "success": true,
            "path": config_path,
            "filePath": config_path,
            "runningMode": mode.as_str()
        }),
    }
}

pub fn start_failure_completion(error: impl Into<String>) -> CoreStartCompletion {
    let error = error.into();
    CoreStartCompletion {
        started: false,
        error: Some(error.clone()),
        response: json!({
            "success": false,
            "error": error
        }),
    }
}

pub fn complete_service_launch_with_response(
    manager: &mut CoreManager,
    controller_endpoint: ControllerEndpoint,
    config_path: String,
    controller_ready: bool,
) -> CoreStartCompletion {
    match complete_service_launch(
        manager,
        controller_endpoint,
        config_path.clone(),
        controller_ready,
    ) {
        Ok(()) => start_success_completion(config_path, CoreStartMode::Service),
        Err(error) => start_failure_completion(error),
    }
}

pub fn complete_sidecar_launch_with_response(
    manager: &mut CoreManager,
    config_path: String,
    controller_ready: bool,
) -> CoreStartCompletion {
    match complete_sidecar_launch(manager, config_path.clone(), controller_ready) {
        Ok(()) => start_success_completion(config_path, CoreStartMode::Sidecar),
        Err(error) => start_failure_completion(error),
    }
}

pub fn abort_service_launch(manager: &mut CoreManager) {
    manager.mark_start_failed();
}

pub fn abort_sidecar_launch(manager: &mut CoreManager) {
    manager.stop_sidecar();
}

pub fn start_service_core(
    executable: &Path,
    work_dir: &Path,
    runtime_config: &Path,
    log_path: &Path,
) -> Result<ServiceCoreLaunch, String> {
    let controller_endpoint = controller::service_endpoint();
    let _ = service::start_core(
        executable,
        work_dir,
        runtime_config,
        Some(log_path),
        Some(&controller_endpoint.path),
    )?;

    Ok(ServiceCoreLaunch {
        controller_endpoint,
    })
}

pub fn stop_service_core() -> Result<serde_json::Value, String> {
    service::stop_core()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServiceCoreStopResult {
    Stopped,
    AlreadyStoppedAfterError { error: String },
}

pub fn service_stop_outcome(
    stop_error: Option<String>,
    service_running_after_error: bool,
) -> Result<ServiceCoreStopResult, String> {
    match (stop_error, service_running_after_error) {
        (Some(error), true) => Err(error),
        (Some(error), false) => Ok(ServiceCoreStopResult::AlreadyStoppedAfterError { error }),
        (None, _) => Ok(ServiceCoreStopResult::Stopped),
    }
}

pub fn stop_service_core_checked() -> Result<ServiceCoreStopResult, String> {
    match stop_service_core() {
        Ok(_) => service_stop_outcome(None, false),
        Err(error) => {
            let still_running = service::get_status()
                .map(|status| status.running)
                .unwrap_or(false);
            service_stop_outcome(Some(error), still_running)
        }
    }
}

pub fn stop_mode(manager: &CoreManager) -> RunningMode {
    manager.running_mode()
}

pub fn complete_core_stop(manager: &mut CoreManager) {
    if manager.running_mode() == RunningMode::Sidecar {
        manager.stop_sidecar();
    } else {
        manager.mark_stopped();
    }
}

pub fn start_sidecar_core(
    executable: &Path,
    work_dir: &Path,
    runtime_config: &Path,
    log_path: &Path,
) -> Result<sidecar::SidecarProcess, String> {
    sidecar::start(executable, work_dir, runtime_config, log_path)
}

pub struct CoreConfigReloadRequest {
    pub endpoint: &'static str,
    pub options: Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CoreConfigReloadOutcome {
    Applied,
    Failed { error: String },
}

#[derive(Debug, Clone, PartialEq)]
pub struct CoreConfigReloadCompletion {
    pub applied: bool,
    pub response: Value,
}

pub fn reload_config_request(runtime_config: &Path) -> CoreConfigReloadRequest {
    CoreConfigReloadRequest {
        endpoint: "/configs?force=true",
        options: json!({
            "method": "PUT",
            "headers": { "Content-Type": "application/json" },
            "body": { "path": runtime_config.to_string_lossy().to_string() }
        }),
    }
}

pub fn reload_config_outcome(response: &Value) -> CoreConfigReloadOutcome {
    if response.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        return CoreConfigReloadOutcome::Applied;
    }

    let error = response
        .get("text")
        .and_then(Value::as_str)
        .filter(|text| !text.trim().is_empty())
        .unwrap_or("Mihomo 热重载失败")
        .to_string();

    CoreConfigReloadOutcome::Failed { error }
}

pub fn complete_config_reload(manager: &mut CoreManager, config_path: String) {
    manager.complete_config_reload(config_path);
}

pub fn complete_reload_from_response(
    manager: &mut CoreManager,
    config_path: String,
    response: &Value,
) -> CoreConfigReloadCompletion {
    match reload_config_outcome(response) {
        CoreConfigReloadOutcome::Applied => {
            complete_config_reload(manager, config_path.clone());
            CoreConfigReloadCompletion {
                applied: true,
                response: json!({
                    "success": true,
                    "reloaded": true,
                    "path": config_path,
                    "filePath": config_path,
                    "message": "配置已热重载"
                }),
            }
        }
        CoreConfigReloadOutcome::Failed { error } => CoreConfigReloadCompletion {
            applied: false,
            response: json!({
                "success": false,
                "reloaded": false,
                "error": error
            }),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reload_config_request_uses_force_put_and_runtime_path() {
        let request = reload_config_request(Path::new("runtime.yaml"));

        assert_eq!(request.endpoint, "/configs?force=true");
        assert_eq!(request.options["method"], "PUT");
        assert_eq!(
            request.options["headers"]["Content-Type"],
            "application/json"
        );
        assert_eq!(request.options["body"]["path"], "runtime.yaml");
    }

    #[test]
    fn reload_config_outcome_maps_success_and_failure() {
        assert_eq!(
            reload_config_outcome(&json!({ "ok": true })),
            CoreConfigReloadOutcome::Applied
        );
        assert_eq!(
            reload_config_outcome(&json!({ "ok": false, "text": "bad config" })),
            CoreConfigReloadOutcome::Failed {
                error: "bad config".to_string()
            }
        );
        assert_eq!(
            reload_config_outcome(&json!({ "ok": false, "text": "" })),
            CoreConfigReloadOutcome::Failed {
                error: "Mihomo 热重载失败".to_string()
            }
        );
    }

    #[test]
    fn complete_reload_from_response_updates_state_and_payload_only_when_applied() {
        let mut manager = CoreManager::default();

        let applied = complete_reload_from_response(
            &mut manager,
            "profile.yaml".to_string(),
            &json!({ "ok": true }),
        );

        assert!(applied.applied);
        assert_eq!(applied.response["success"], json!(true));
        assert_eq!(applied.response["reloaded"], json!(true));
        assert_eq!(applied.response["path"], json!("profile.yaml"));
        assert_eq!(
            manager.active_config_owned().as_deref(),
            Some("profile.yaml")
        );

        let failed = complete_reload_from_response(
            &mut manager,
            "next.yaml".to_string(),
            &json!({ "ok": false, "text": "bad config" }),
        );

        assert!(!failed.applied);
        assert_eq!(failed.response["success"], json!(false));
        assert_eq!(failed.response["reloaded"], json!(false));
        assert_eq!(failed.response["error"], json!("bad config"));
        assert_eq!(
            manager.active_config_owned().as_deref(),
            Some("profile.yaml")
        );
    }

    #[test]
    fn service_stop_outcome_only_fails_when_service_still_runs() {
        assert_eq!(
            service_stop_outcome(None, false),
            Ok(ServiceCoreStopResult::Stopped)
        );
        assert_eq!(
            service_stop_outcome(Some("ipc failed".to_string()), false),
            Ok(ServiceCoreStopResult::AlreadyStoppedAfterError {
                error: "ipc failed".to_string()
            })
        );
        assert_eq!(
            service_stop_outcome(Some("ipc failed".to_string()), true),
            Err("ipc failed".to_string())
        );
    }

    #[test]
    fn controller_ready_outcome_returns_mode_specific_timeout() {
        assert_eq!(
            controller_ready_outcome(CoreStartMode::Service, true),
            Ok(())
        );
        assert_eq!(
            controller_ready_outcome(CoreStartMode::Service, false),
            Err("Helper 已启动内核，但 controller 未在超时时间内就绪".to_string())
        );
        assert_eq!(
            controller_ready_outcome(CoreStartMode::Sidecar, false),
            Err("Mihomo 已启动但 controller 未在超时时间内就绪".to_string())
        );
    }

    #[test]
    fn service_launch_completion_sets_config_only_when_ready() {
        let mut manager = CoreManager::default();
        let endpoint = controller::service_endpoint();

        begin_service_launch(&mut manager, endpoint.clone());
        let result =
            complete_service_launch(&mut manager, endpoint, "profile.yaml".to_string(), true);

        assert_eq!(result, Ok(()));
        assert_eq!(manager.running_mode(), RunningMode::Service);
        assert_eq!(
            manager.active_config_owned().as_deref(),
            Some("profile.yaml")
        );

        let mut manager = CoreManager::default();
        let endpoint = controller::service_endpoint();
        begin_service_launch(&mut manager, endpoint.clone());
        let result =
            complete_service_launch(&mut manager, endpoint, "profile.yaml".to_string(), false);

        assert!(result.is_err());
        assert_eq!(manager.running_mode(), RunningMode::Service);
        assert_eq!(manager.active_config_owned(), None);
    }

    #[test]
    fn start_completion_payloads_are_mode_specific_and_preserve_state_on_failure() {
        let mut manager = CoreManager::default();
        let endpoint = controller::service_endpoint();
        begin_service_launch(&mut manager, endpoint.clone());

        let service = complete_service_launch_with_response(
            &mut manager,
            endpoint,
            "service.yaml".to_string(),
            true,
        );

        assert!(service.started);
        assert_eq!(service.response["success"], json!(true));
        assert_eq!(service.response["path"], json!("service.yaml"));
        assert_eq!(service.response["runningMode"], json!("service"));
        assert_eq!(
            manager.active_config_owned().as_deref(),
            Some("service.yaml")
        );

        let mut manager = CoreManager::default();
        let sidecar =
            complete_sidecar_launch_with_response(&mut manager, "sidecar.yaml".to_string(), false);

        assert!(!sidecar.started);
        assert_eq!(sidecar.response["success"], json!(false));
        assert_eq!(
            sidecar.response["error"],
            json!("Mihomo 已启动但 controller 未在超时时间内就绪")
        );
        assert_eq!(manager.active_config_owned(), None);
    }

    #[test]
    fn complete_core_stop_marks_non_sidecar_modes_stopped() {
        let mut manager = CoreManager::default();
        manager.set_service_running(controller::service_endpoint());

        complete_core_stop(&mut manager);

        assert_eq!(manager.running_mode(), RunningMode::NotRunning);
        assert!(manager.controller_endpoint_owned().is_none());
    }
}
