use super::controller::ControllerEndpoint;
use serde::{Deserialize, Serialize};
use std::process::Child;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RunningMode {
    Service,
    Sidecar,
    NotRunning,
}

impl Default for RunningMode {
    fn default() -> Self {
        Self::NotRunning
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreState {
    pub running_mode: RunningMode,
    pub active_config: Option<String>,
    pub pid: Option<u32>,
    pub socket_path: Option<String>,
    pub socket_arg: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ActiveConfigSource {
    Runtime,
    Preferred,
    None,
}

impl ActiveConfigSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Runtime => "runtime",
            Self::Preferred => "preferred",
            Self::None => "none",
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeActiveConfig {
    pub config: Option<String>,
    pub source: ActiveConfigSource,
}

#[derive(Default)]
pub struct CoreManager {
    running_mode: RunningMode,
    sidecar_child: Option<Child>,
    active_config: Option<String>,
    controller_endpoint: Option<ControllerEndpoint>,
}

impl CoreManager {
    pub fn active_config_owned(&self) -> Option<String> {
        self.active_config.clone()
    }

    pub fn runtime_active_config(
        &self,
        controller_running: bool,
        preferred_config: Option<String>,
    ) -> RuntimeActiveConfig {
        if !controller_running {
            return RuntimeActiveConfig {
                config: None,
                source: ActiveConfigSource::None,
            };
        }

        if let Some(config) = self
            .active_config
            .clone()
            .filter(|value| !value.trim().is_empty())
        {
            return RuntimeActiveConfig {
                config: Some(config),
                source: ActiveConfigSource::Runtime,
            };
        }

        if let Some(config) = preferred_config.filter(|value| !value.trim().is_empty()) {
            return RuntimeActiveConfig {
                config: Some(config),
                source: ActiveConfigSource::Preferred,
            };
        }

        RuntimeActiveConfig {
            config: None,
            source: ActiveConfigSource::None,
        }
    }

    pub fn set_active_config(&mut self, config_path: Option<String>) {
        self.active_config = config_path
            .map(|path| path.trim().to_string())
            .filter(|path| !path.is_empty());
    }

    pub fn clear_active_config(&mut self) {
        self.active_config = None;
    }

    pub fn activate_config(&mut self, config_path: String) {
        self.set_active_config(Some(config_path));
    }

    pub fn begin_service_start(&mut self, controller_endpoint: ControllerEndpoint) {
        self.set_service_running(controller_endpoint);
    }

    pub fn complete_service_start(
        &mut self,
        controller_endpoint: ControllerEndpoint,
        config_path: String,
    ) {
        self.begin_service_start(controller_endpoint);
        self.activate_config(config_path);
    }

    pub fn begin_sidecar_start(&mut self, child: Child, controller_endpoint: ControllerEndpoint) {
        self.set_sidecar_child(child, controller_endpoint);
    }

    pub fn complete_sidecar_start(&mut self, config_path: String) {
        if matches!(self.running_mode, RunningMode::Sidecar) {
            self.activate_config(config_path);
        }
    }

    pub fn complete_config_reload(&mut self, config_path: String) {
        self.activate_config(config_path);
    }

    pub fn mark_start_failed(&mut self) {
        self.mark_not_running();
    }

    pub fn mark_stopped(&mut self) {
        self.mark_not_running();
    }

    pub fn sync_service_running(
        &mut self,
        controller_endpoint: ControllerEndpoint,
        active_config: Option<String>,
    ) {
        self.begin_service_start(controller_endpoint);
        if self.active_config.is_none() {
            self.set_active_config(active_config);
        }
    }

    pub fn sync_service_stopped(&mut self) {
        self.mark_not_running();
    }

    pub fn set_sidecar_child(&mut self, child: Child, controller_endpoint: ControllerEndpoint) {
        self.sidecar_child = Some(child);
        self.controller_endpoint = Some(controller_endpoint);
        self.running_mode = RunningMode::Sidecar;
    }

    pub fn set_service_running(&mut self, controller_endpoint: ControllerEndpoint) {
        self.sidecar_child = None;
        self.controller_endpoint = Some(controller_endpoint);
        self.running_mode = RunningMode::Service;
    }

    pub fn controller_endpoint_owned(&self) -> Option<ControllerEndpoint> {
        self.controller_endpoint.clone()
    }

    pub fn running_mode(&self) -> RunningMode {
        self.running_mode
    }

    pub fn mark_not_running(&mut self) {
        self.running_mode = RunningMode::NotRunning;
        self.sidecar_child = None;
        self.controller_endpoint = None;
    }

    pub fn stop_sidecar(&mut self) {
        if let Some(mut child) = self.sidecar_child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        self.running_mode = RunningMode::NotRunning;
        self.controller_endpoint = None;
    }

    pub fn is_running(&mut self) -> bool {
        if matches!(self.running_mode, RunningMode::Service) {
            return true;
        }

        let Some(child) = self.sidecar_child.as_mut() else {
            self.running_mode = RunningMode::NotRunning;
            return false;
        };

        match child.try_wait() {
            Ok(Some(_)) => {
                self.sidecar_child = None;
                self.running_mode = RunningMode::NotRunning;
                self.controller_endpoint = None;
                false
            }
            Ok(None) => {
                self.running_mode = RunningMode::Sidecar;
                true
            }
            Err(_) => {
                self.running_mode = RunningMode::NotRunning;
                self.controller_endpoint = None;
                false
            }
        }
    }

    pub fn state(&mut self) -> CoreState {
        let running = self.is_running();
        CoreState {
            running_mode: if running {
                self.running_mode
            } else {
                RunningMode::NotRunning
            },
            active_config: self.active_config.clone(),
            pid: self.sidecar_child.as_ref().map(|child| child.id()),
            socket_path: if running {
                self.controller_endpoint
                    .as_ref()
                    .map(|endpoint| endpoint.path.clone())
            } else {
                None
            },
            socket_arg: if running {
                self.controller_endpoint
                    .as_ref()
                    .map(|endpoint| endpoint.arg_name.to_string())
            } else {
                None
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn endpoint() -> ControllerEndpoint {
        ControllerEndpoint {
            arg_name: "-ext-ctl-pipe",
            path: "test-pipe".to_string(),
        }
    }

    #[test]
    fn service_lifecycle_sets_mode_endpoint_and_config() {
        let mut manager = CoreManager::default();

        manager.complete_service_start(endpoint(), " profile.yaml ".to_string());

        assert_eq!(manager.running_mode(), RunningMode::Service);
        assert_eq!(
            manager.active_config_owned().as_deref(),
            Some("profile.yaml")
        );
        assert_eq!(
            manager.controller_endpoint_owned().map(|value| value.path),
            Some("test-pipe".to_string())
        );
    }

    #[test]
    fn sync_service_running_preserves_existing_active_config() {
        let mut manager = CoreManager::default();
        manager.activate_config("current.yaml".to_string());

        manager.sync_service_running(endpoint(), Some("fallback.yaml".to_string()));

        assert_eq!(manager.running_mode(), RunningMode::Service);
        assert_eq!(
            manager.active_config_owned().as_deref(),
            Some("current.yaml")
        );
    }

    #[test]
    fn stopped_state_clears_controller_but_keeps_active_config() {
        let mut manager = CoreManager::default();
        manager.complete_service_start(endpoint(), "profile.yaml".to_string());

        manager.mark_stopped();

        assert_eq!(manager.running_mode(), RunningMode::NotRunning);
        assert!(manager.controller_endpoint_owned().is_none());
        assert_eq!(
            manager.active_config_owned().as_deref(),
            Some("profile.yaml")
        );
    }

    #[test]
    fn runtime_active_config_distinguishes_runtime_and_preferred_sources() {
        let mut manager = CoreManager::default();

        let stopped = manager.runtime_active_config(true, Some("preferred.yaml".to_string()));
        assert_eq!(stopped.config.as_deref(), Some("preferred.yaml"));
        assert_eq!(stopped.source, ActiveConfigSource::Preferred);

        manager.activate_config("runtime.yaml".to_string());
        let runtime = manager.runtime_active_config(true, Some("preferred.yaml".to_string()));
        assert_eq!(runtime.config.as_deref(), Some("runtime.yaml"));
        assert_eq!(runtime.source, ActiveConfigSource::Runtime);

        let not_running = manager.runtime_active_config(false, Some("preferred.yaml".to_string()));
        assert_eq!(not_running.config, None);
        assert_eq!(not_running.source, ActiveConfigSource::None);
    }
}
