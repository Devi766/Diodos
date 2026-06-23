#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::{
    fs,
    path::Path,
    process::{Child, Command, Stdio},
};

use super::controller::{self, ControllerEndpoint};

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

pub struct SidecarProcess {
    pub child: Child,
    pub controller_endpoint: ControllerEndpoint,
}

pub fn start(
    executable: &Path,
    work_dir: &Path,
    runtime_config: &Path,
    log_path: &Path,
) -> Result<SidecarProcess, String> {
    let controller_endpoint = controller::sidecar_endpoint();
    controller::cleanup_socket_file(&controller_endpoint);

    let log_file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)
        .map_err(|err| err.to_string())?;

    let mut command = Command::new(executable);
    command
        .arg("-d")
        .arg(work_dir)
        .arg("-f")
        .arg(runtime_config)
        .arg(controller_endpoint.arg_name)
        .arg(&controller_endpoint.path)
        .stdout(Stdio::from(
            log_file.try_clone().map_err(|err| err.to_string())?,
        ))
        .stderr(Stdio::from(log_file));
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);

    let child = command.spawn().map_err(|err| err.to_string())?;

    Ok(SidecarProcess {
        child,
        controller_endpoint,
    })
}
