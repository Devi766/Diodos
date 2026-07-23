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
            Self::Sidecar => "内核已启动但 controller 未在超时时间内就绪",
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
    // Service mode treats helper start success as authoritative.
    // Controller readiness may still be warming up with heavy providers.
    let _ = controller_ready;
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

#[allow(dead_code)]
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
        Err(error) => {
            abort_sidecar_launch(manager);
            start_failure_completion(error)
        }
    }
}

/// Finish a failed service launch: stop helper-managed core, clear manager state.
pub fn fail_service_launch(
    manager: &mut CoreManager,
    error: impl Into<String>,
    stop_helper_core: bool,
) -> CoreStartCompletion {
    if stop_helper_core {
        let _ = stop_service_core();
    }
    abort_service_launch(manager);
    start_failure_completion(error)
}

/// Finish a failed sidecar launch: kill child and clear manager state.
#[allow(dead_code)]
pub fn fail_sidecar_launch(
    manager: &mut CoreManager,
    error: impl Into<String>,
) -> CoreStartCompletion {
    abort_sidecar_launch(manager);
    start_failure_completion(error)
}

/// Own the post-spawn service start sequence after helper IPC is ready:
/// begin -> wait outcome -> complete or stop helper core + abort.
pub fn finish_service_start(
    manager: &mut CoreManager,
    controller_endpoint: ControllerEndpoint,
    config_path: String,
    controller_ready: bool,
) -> CoreStartCompletion {
    begin_service_launch(manager, controller_endpoint.clone());
    match complete_service_launch(
        manager,
        controller_endpoint,
        config_path.clone(),
        controller_ready,
    ) {
        Ok(()) => start_success_completion(config_path, CoreStartMode::Service),
        Err(error) => {
            let _ = stop_service_core();
            abort_service_launch(manager);
            start_failure_completion(error)
        }
    }
}

/// Own the post-spawn sidecar start sequence after the child is created and
/// the plugin endpoint is synced: begin -> wait outcome -> complete/abort.
pub fn finish_sidecar_start(
    manager: &mut CoreManager,
    launch: sidecar::SidecarProcess,
    config_path: String,
    controller_ready: bool,
) -> CoreStartCompletion {
    begin_sidecar_launch(manager, launch);
    complete_sidecar_launch_with_response(manager, config_path, controller_ready)
}

/// Kill a sidecar process that was spawned but never adopted by CoreManager
/// (for example plugin endpoint sync failed before begin_sidecar_launch).
pub fn discard_sidecar_process(launch: sidecar::SidecarProcess) {
    let mut manager = CoreManager::default();
    begin_sidecar_launch(&mut manager, launch);
    abort_sidecar_launch(&mut manager);
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
    manager.finish_stop();
}

/// Pure decision for which start path to take after stop/prepare.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CoreStartPath {
    Service,
    Sidecar,
}

impl CoreStartPath {
    pub fn from_service_mode(use_service: bool) -> Self {
        if use_service {
            Self::Service
        } else {
            Self::Sidecar
        }
    }
}

/// Own the service-mode start handoff after helper is ready and core is spawned:
/// sync endpoint failure / controller wait / finish_service_start outcome.
pub fn service_start_after_spawn(
    manager: &mut CoreManager,
    controller_endpoint: ControllerEndpoint,
    config_path: String,
    plugin_sync_ok: bool,
    controller_ready: bool,
    plugin_sync_error: Option<String>,
) -> CoreStartCompletion {
    if !plugin_sync_ok {
        return fail_service_launch(
            manager,
            format!(
                "同步内核 IPC 控制通道失败: {}",
                plugin_sync_error.unwrap_or_else(|| "unknown".to_string())
            ),
            true,
        );
    }

    finish_service_start(manager, controller_endpoint, config_path, controller_ready)
}

/// Own the sidecar-mode start handoff after child spawn:
/// if plugin sync fails, discard the orphan; otherwise finish_sidecar_start.
pub fn sidecar_start_after_spawn(
    manager: &mut CoreManager,
    launch: sidecar::SidecarProcess,
    config_path: String,
    plugin_sync_ok: bool,
    controller_ready: bool,
    plugin_sync_error: Option<String>,
) -> CoreStartCompletion {
    if !plugin_sync_ok {
        // launch is moved into discard path; manager must not own it yet.
        discard_sidecar_process(launch);
        return start_failure_completion(format!(
            "同步内核 IPC 控制通道失败: {}",
            plugin_sync_error.unwrap_or_else(|| "unknown".to_string())
        ));
    }

    finish_sidecar_start(manager, launch, config_path, controller_ready)
}

/// Persist-facing success payload after a successful start.
#[allow(dead_code)]
pub fn start_success_app_payload(config_path: &str, mode: CoreStartMode) -> Value {
    json!({
        "success": true,
        "path": config_path,
        "filePath": config_path,
        "runningMode": mode.as_str()
    })
}

/// Pure decision for the start path after stop/prepare.
pub fn choose_start_path(use_service_mode: bool) -> CoreStartPath {
    CoreStartPath::from_service_mode(use_service_mode)
}

/// Paths used by a prepared core start.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedCoreStartPaths {
    pub runtime_config: std::path::PathBuf,
    pub work_dir: std::path::PathBuf,
    pub log_path: std::path::PathBuf,
}

impl PreparedCoreStartPaths {
    pub fn new(runtime_config: std::path::PathBuf, work_dir: std::path::PathBuf) -> Self {
        let log_path = work_dir.join(crate::core::identity::product_core_log_file_name());
        Self {
            runtime_config,
            work_dir,
            log_path,
        }
    }
}

/// App-facing start context after all prep succeeds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoreStartContext {
    pub config_path: String,
    pub executable: std::path::PathBuf,
    pub service_executable: Option<std::path::PathBuf>,
    pub paths: PreparedCoreStartPaths,
    pub start_path: CoreStartPath,
}

impl CoreStartContext {
    pub fn launch_executable(&self) -> &std::path::Path {
        match self.start_path {
            CoreStartPath::Service => self
                .service_executable
                .as_ref()
                .unwrap_or(&self.executable)
                .as_path(),
            CoreStartPath::Sidecar => self.executable.as_path(),
        }
    }
}

/// Map a successful start completion into the common app side-effects payload.
#[allow(dead_code)]
pub fn start_success_side_effects(config_path: &str) -> Value {
    json!({
        "configPath": config_path,
        "shouldPersistActiveConfig": true,
        "shouldEmitActiveConfig": true
    })
}

/// Normalize an incoming config path decision for start.
/// Empty means "resolve preferred/startup config"; non-empty means use provided path.
pub fn start_config_path_decision(raw: &str) -> Option<&str> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

/// AppHandle-bound capabilities needed to prepare a core start.
///
/// Lifecycle owns the orchestration; callers inject IO/discovery so the pure
/// pipeline can be tested without Tauri AppHandle.
pub trait CoreStartPrepDeps {
    fn resolve_config_path(&self, raw: &str) -> Result<String, CoreStartPrepError>;
    fn ensure_config_readable(&self, config_path: &str) -> Result<(), CoreStartPrepError>;
    fn find_core_executable(&self) -> Result<std::path::PathBuf, CoreStartPrepError>;
    fn prepare_runtime_config(
        &self,
        config_path: &str,
        executable: &Path,
    ) -> Result<std::path::PathBuf, CoreStartPrepError>;
    fn work_dir(&self) -> Result<std::path::PathBuf, CoreStartPrepError>;
    fn should_use_service_mode(&self) -> bool;
    fn service_compatible_executable(
        &self,
        executable: &Path,
    ) -> Result<std::path::PathBuf, CoreStartPrepError>;
}

#[derive(Debug, Clone, PartialEq)]
pub enum CoreStartPrepError {
    Message(String),
    RuntimeConfig(Value),
}

impl CoreStartPrepError {
    pub fn message(value: impl Into<String>) -> Self {
        Self::Message(value.into())
    }

    pub fn runtime_config(value: Value) -> Self {
        Self::RuntimeConfig(value)
    }
}

/// Prepare everything required to launch the core without starting it.
///
/// Pure orchestration over [`CoreStartPrepDeps`]. Binary discovery, service-path
/// compatibility, and start-mode decisions are implemented by injectable deps /
/// `core::paths` pure helpers so unit tests can fully mock prep.
pub fn prepare_core_start_context_with_deps<D: CoreStartPrepDeps>(
    deps: &D,
    raw_config_path: &str,
) -> Result<CoreStartContext, CoreStartPrepError> {
    let config_path = deps.resolve_config_path(raw_config_path)?;
    deps.ensure_config_readable(&config_path)?;
    let executable = deps.find_core_executable()?;
    let runtime_config = deps.prepare_runtime_config(&config_path, &executable)?;
    let work_dir = deps.work_dir()?;
    let paths = PreparedCoreStartPaths::new(runtime_config, work_dir);
    let start_path = choose_start_path(deps.should_use_service_mode());
    let service_executable = if matches!(start_path, CoreStartPath::Service) {
        Some(deps.service_compatible_executable(&executable)?)
    } else {
        None
    };

    Ok(CoreStartContext {
        config_path,
        executable,
        service_executable,
        paths,
        start_path,
    })
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
        .unwrap_or("内核热重载失败")
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
                error: "内核热重载失败".to_string()
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
            Err("内核已启动但 controller 未在超时时间内就绪".to_string())
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

        // Service ownership is authoritative; controller warm-up is best-effort.
        assert_eq!(result, Ok(()));
        assert_eq!(manager.running_mode(), RunningMode::Service);
        assert_eq!(
            manager.active_config_owned().as_deref(),
            Some("profile.yaml")
        );
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
            json!("内核已启动但 controller 未在超时时间内就绪")
        );
        assert_eq!(manager.active_config_owned(), None);
        assert_eq!(manager.running_mode(), RunningMode::NotRunning);
    }

    #[test]
    fn fail_service_launch_clears_manager_state() {
        let mut manager = CoreManager::default();
        begin_service_launch(&mut manager, controller::service_endpoint());

        let failure = fail_service_launch(&mut manager, "sync failed".to_string(), false);

        assert!(!failure.started);
        assert_eq!(failure.response["success"], json!(false));
        assert_eq!(failure.response["error"], json!("sync failed"));
        assert_eq!(manager.running_mode(), RunningMode::NotRunning);
        assert!(manager.controller_endpoint_owned().is_none());
    }

    #[test]
    fn fail_sidecar_launch_marks_not_running() {
        let mut manager = CoreManager::default();
        // Seed a non-running manager, then ensure fail_sidecar_launch still
        // returns a uniform failure payload and leaves NotRunning.
        let failure = fail_sidecar_launch(&mut manager, "timeout".to_string());

        assert!(!failure.started);
        assert_eq!(failure.response["error"], json!("timeout"));
        assert_eq!(manager.running_mode(), RunningMode::NotRunning);
    }

    #[test]
    fn finish_service_start_aborts_and_reports_timeout() {
        let mut manager = CoreManager::default();
        let endpoint = controller::service_endpoint();
        let success =
            finish_service_start(&mut manager, endpoint, "profile.yaml".to_string(), false);
        assert!(success.started);
        assert_eq!(success.response["success"], json!(true));
        assert_eq!(manager.running_mode(), RunningMode::Service);
    }

    #[test]
    fn finish_service_start_succeeds_when_controller_ready() {
        let mut manager = CoreManager::default();
        let endpoint = controller::service_endpoint();

        let success =
            finish_service_start(&mut manager, endpoint, "profile.yaml".to_string(), true);

        assert!(success.started);
        assert_eq!(success.response["runningMode"], json!("service"));
        assert_eq!(manager.running_mode(), RunningMode::Service);
        assert_eq!(
            manager.active_config_owned().as_deref(),
            Some("profile.yaml")
        );
    }

    #[test]
    fn service_start_after_spawn_fails_on_plugin_sync_error() {
        let mut manager = CoreManager::default();
        let endpoint = controller::service_endpoint();
        let failure = service_start_after_spawn(
            &mut manager,
            endpoint,
            "profile.yaml".to_string(),
            false,
            true,
            Some("pipe closed".to_string()),
        );
        assert!(!failure.started);
        assert!(failure.response["error"]
            .as_str()
            .unwrap_or_default()
            .contains("pipe closed"));
        assert_eq!(manager.running_mode(), RunningMode::NotRunning);
    }

    #[test]
    fn service_start_after_spawn_finishes_when_ready() {
        let mut manager = CoreManager::default();
        let endpoint = controller::service_endpoint();
        let success = service_start_after_spawn(
            &mut manager,
            endpoint,
            "profile.yaml".to_string(),
            true,
            true,
            None,
        );
        assert!(success.started);
        assert_eq!(manager.running_mode(), RunningMode::Service);
        assert_eq!(
            manager.active_config_owned().as_deref(),
            Some("profile.yaml")
        );
    }

    #[test]
    fn choose_start_path_and_prepared_paths() {
        assert_eq!(choose_start_path(true), CoreStartPath::Service);
        assert_eq!(choose_start_path(false), CoreStartPath::Sidecar);
        assert_eq!(start_config_path_decision(""), None);
        assert_eq!(start_config_path_decision("  a.yaml  "), Some("a.yaml"));

        let prepared = PreparedCoreStartPaths::new(
            std::path::PathBuf::from("runtime.yaml"),
            std::path::PathBuf::from("work"),
        );
        assert_eq!(
            prepared.log_path,
            std::path::PathBuf::from("work/flyclash-mihomo.log")
        );
    }

    struct FakePrepDeps {
        use_service: bool,
        config_path: String,
        executable: std::path::PathBuf,
        service_executable: std::path::PathBuf,
        runtime_config: std::path::PathBuf,
        work_dir: std::path::PathBuf,
    }

    impl CoreStartPrepDeps for FakePrepDeps {
        fn resolve_config_path(&self, raw: &str) -> Result<String, CoreStartPrepError> {
            Ok(start_config_path_decision(raw)
                .unwrap_or(self.config_path.as_str())
                .to_string())
        }

        fn ensure_config_readable(&self, _config_path: &str) -> Result<(), CoreStartPrepError> {
            Ok(())
        }

        fn find_core_executable(&self) -> Result<std::path::PathBuf, CoreStartPrepError> {
            Ok(self.executable.clone())
        }

        fn prepare_runtime_config(
            &self,
            _config_path: &str,
            _executable: &Path,
        ) -> Result<std::path::PathBuf, CoreStartPrepError> {
            Ok(self.runtime_config.clone())
        }

        fn work_dir(&self) -> Result<std::path::PathBuf, CoreStartPrepError> {
            Ok(self.work_dir.clone())
        }

        fn should_use_service_mode(&self) -> bool {
            self.use_service
        }

        fn service_compatible_executable(
            &self,
            _executable: &Path,
        ) -> Result<std::path::PathBuf, CoreStartPrepError> {
            Ok(self.service_executable.clone())
        }
    }

    #[test]
    fn prepare_core_start_context_with_deps_builds_service_context() {
        let deps = FakePrepDeps {
            use_service: true,
            config_path: "profile.yaml".to_string(),
            executable: std::path::PathBuf::from("mihomo.exe"),
            service_executable: std::path::PathBuf::from("service-mihomo.exe"),
            runtime_config: std::path::PathBuf::from("runtime.yaml"),
            work_dir: std::path::PathBuf::from("work"),
        };
        let context = prepare_core_start_context_with_deps(&deps, "").expect("context");
        assert_eq!(context.config_path, "profile.yaml");
        assert_eq!(context.start_path, CoreStartPath::Service);
        assert_eq!(
            context.launch_executable(),
            std::path::Path::new("service-mihomo.exe")
        );
        assert_eq!(
            context.paths.log_path,
            std::path::PathBuf::from("work/flyclash-mihomo.log")
        );
    }

    #[test]
    fn prepare_core_start_context_with_deps_builds_sidecar_context() {
        let deps = FakePrepDeps {
            use_service: false,
            config_path: "profile.yaml".to_string(),
            executable: std::path::PathBuf::from("mihomo.exe"),
            service_executable: std::path::PathBuf::from("service-mihomo.exe"),
            runtime_config: std::path::PathBuf::from("runtime.yaml"),
            work_dir: std::path::PathBuf::from("work"),
        };
        let context =
            prepare_core_start_context_with_deps(&deps, "explicit.yaml").expect("context");
        assert_eq!(context.config_path, "explicit.yaml");
        assert_eq!(context.start_path, CoreStartPath::Sidecar);
        assert!(context.service_executable.is_none());
        assert_eq!(
            context.launch_executable(),
            std::path::Path::new("mihomo.exe")
        );
    }

    #[test]
    fn prepare_core_start_context_with_deps_surfaces_runtime_config_error() {
        struct FailingRuntimeDeps;
        impl CoreStartPrepDeps for FailingRuntimeDeps {
            fn resolve_config_path(&self, _raw: &str) -> Result<String, CoreStartPrepError> {
                Ok("profile.yaml".to_string())
            }
            fn ensure_config_readable(&self, _config_path: &str) -> Result<(), CoreStartPrepError> {
                Ok(())
            }
            fn find_core_executable(&self) -> Result<std::path::PathBuf, CoreStartPrepError> {
                Ok(std::path::PathBuf::from("mihomo.exe"))
            }
            fn prepare_runtime_config(
                &self,
                _config_path: &str,
                _executable: &Path,
            ) -> Result<std::path::PathBuf, CoreStartPrepError> {
                Err(CoreStartPrepError::runtime_config(json!({
                    "success": false,
                    "configError": true,
                    "error": "invalid"
                })))
            }
            fn work_dir(&self) -> Result<std::path::PathBuf, CoreStartPrepError> {
                Ok(std::path::PathBuf::from("work"))
            }
            fn should_use_service_mode(&self) -> bool {
                false
            }
            fn service_compatible_executable(
                &self,
                _executable: &Path,
            ) -> Result<std::path::PathBuf, CoreStartPrepError> {
                unreachable!("service path not used")
            }
        }

        let err = prepare_core_start_context_with_deps(&FailingRuntimeDeps, "")
            .expect_err("runtime config must fail");
        match err {
            CoreStartPrepError::RuntimeConfig(value) => {
                assert_eq!(value["error"], "invalid");
            }
            other => panic!("unexpected error: {other:?}"),
        }
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
