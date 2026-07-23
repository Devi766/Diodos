use std::fs;

use super::manager::RunningMode;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ControllerEndpoint {
    pub arg_name: &'static str,
    pub path: String,
}

/// Stable controller endpoint shared by service and sidecar launches.
///
/// Custom-core considerations:
/// - Keep one app-owned endpoint so switching custom binaries does not
///   leave the UI probing a previous process path.
/// - Prefer ASCII-only, space-free path for third-party core compatibility.
/// - Avoid session/pid suffixes; service and sidecar must advertise the
///   same controller path.
pub fn shared_endpoint() -> ControllerEndpoint {
    if cfg!(target_os = "windows") {
        ControllerEndpoint {
            arg_name: "-ext-ctl-pipe",
            path: r"\\.\pipe\flycast-mihomo".to_string(),
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
            path: socket_dir.join("mihomo.sock").to_string_lossy().to_string(),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_endpoint_is_stable_and_product_scoped() {
        let a = shared_endpoint();
        let b = shared_endpoint();
        assert_eq!(a, b);

        if cfg!(target_os = "windows") {
            assert_eq!(a.arg_name, "-ext-ctl-pipe");
            assert_eq!(a.path, r"\\.\pipe\flycast-mihomo");
            assert!(!a.path.contains(' '));
        } else {
            assert_eq!(a.arg_name, "-ext-ctl-unix");
            assert!(a.path.ends_with("mihomo.sock"));
            assert!(!a.path.contains(' '));
        }
    }

    #[test]
    fn service_and_sidecar_share_same_endpoint() {
        assert_eq!(service_endpoint(), sidecar_endpoint());
        assert_eq!(
            endpoint_for_mode(RunningMode::Service),
            endpoint_for_mode(RunningMode::Sidecar)
        );
    }
}
