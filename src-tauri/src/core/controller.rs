use std::{env, fs};

use super::manager::RunningMode;

#[derive(Debug, Clone)]
pub struct ControllerEndpoint {
    pub arg_name: &'static str,
    pub path: String,
}

pub fn service_endpoint() -> ControllerEndpoint {
    if cfg!(target_os = "windows") {
        ControllerEndpoint {
            arg_name: "-ext-ctl-pipe",
            path: r"\\.\pipe\flycast-mihomo-service".to_string(),
        }
    } else {
        ControllerEndpoint {
            arg_name: "-ext-ctl-unix",
            path: "/tmp/flyclash-mihomo-service.sock".to_string(),
        }
    }
}

pub fn sidecar_endpoint() -> ControllerEndpoint {
    if cfg!(target_os = "windows") {
        let session = env::var("SESSIONNAME")
            .or_else(|_| env::var("USERNAME"))
            .unwrap_or_else(|_| "default".to_string());
        ControllerEndpoint {
            arg_name: "-ext-ctl-pipe",
            path: format!(
                r"\\.\pipe\FlyClash\mihomo-{}-{}",
                session,
                std::process::id()
            ),
        }
    } else {
        let uid = env::var("UID").unwrap_or_else(|_| "unknown".to_string());
        let socket_dir = env::temp_dir().join(format!("flyclash-{uid}"));
        let _ = fs::create_dir_all(&socket_dir);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&socket_dir, fs::Permissions::from_mode(0o700));
        }
        ControllerEndpoint {
            arg_name: "-ext-ctl-unix",
            path: socket_dir
                .join(format!("mihomo-{}.sock", std::process::id()))
                .to_string_lossy()
                .to_string(),
        }
    }
}

pub fn endpoint_for_mode(mode: RunningMode) -> Option<ControllerEndpoint> {
    match mode {
        RunningMode::Service => Some(service_endpoint()),
        RunningMode::Sidecar => Some(sidecar_endpoint()),
        RunningMode::NotRunning => None,
    }
}

pub fn cleanup_socket_file(endpoint: &ControllerEndpoint) {
    if cfg!(target_os = "windows") {
        return;
    }
    let _ = fs::remove_file(&endpoint.path);
}
