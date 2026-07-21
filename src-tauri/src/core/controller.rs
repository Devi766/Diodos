use std::fs;

use super::manager::RunningMode;

#[derive(Debug, Clone)]
pub struct ControllerEndpoint {
    pub arg_name: &'static str,
    pub path: String,
}

/// Stable controller endpoint shared by service and sidecar launches.
/// Using one fixed path avoids probing a stale pipe after mode switches.
pub fn shared_endpoint() -> ControllerEndpoint {
    if cfg!(target_os = "windows") {
        ControllerEndpoint {
            arg_name: "-ext-ctl-pipe",
            path: r"\.\pipelycast-mihomo".to_string(),
        }
    } else {
        let socket_dir = std::env::temp_dir().join("flyclash");
        let _ = fs::create_dir_all(&socket_dir);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&socket_dir, fs::Permissions::from_mode(0o700));
        }
        ControllerEndpoint {
            arg_name: "-ext-ctl-unix",
            path: socket_dir
                .join("mihomo.sock")
                .to_string_lossy()
                .to_string(),
        }
    }
}

pub fn service_endpoint() -> ControllerEndpoint {
    shared_endpoint()
}

pub fn sidecar_endpoint() -> ControllerEndpoint {
    shared_endpoint()
}

pub fn endpoint_for_mode(mode: RunningMode) -> Option<ControllerEndpoint> {
    match mode {
        RunningMode::Service | RunningMode::Sidecar => Some(shared_endpoint()),
        RunningMode::NotRunning => None,
    }
}

pub fn cleanup_socket_file(endpoint: &ControllerEndpoint) {
    if cfg!(target_os = "windows") {
        return;
    }
    let _ = fs::remove_file(&endpoint.path);
}
