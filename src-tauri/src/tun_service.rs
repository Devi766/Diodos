use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    thread,
    time::Duration,
};

use serde_json::{json, Value};
#[cfg(unix)]
use std::os::unix::fs::{MetadataExt, PermissionsExt};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

use crate::{
    core::{lifecycle as core_lifecycle, manager::RunningMode, service as core_service},
    core_commands::{default_mihomo_executable, find_mihomo_executable},
    core_lifecycle_commands::{apply_saved_config, apply_tun_runtime_change},
    platform::{set_system_proxy, system_proxy_status},
    resources::existing_resource_file,
    runtime::is_mihomo_running,
    runtime_config::{
        default_tun_config, ensure_tun_dns_defaults, mihomo_mixed_port, save_proxy_settings,
        user_settings_view,
    },
    state::AppState,
    storage::{app_data_dir, set_setting, setting},
    tray::refresh_tray_menu_after,
};

type CompatResult = Result<Value, String>;

const WINDOWS_ELEVATED_TASK_NAME: &str = "FlyClash-Elevated";
const REQUIRED_HELPER_VERSION: &str = "1.0.2";
/// Keep the system kernel path compatible with the Electron main branch.
const MACOS_SYSTEM_KERNEL_DIR: &str = "/Library/Application Support/Flycast";
const MACOS_SYSTEM_KERNEL_NAME: &str = "mihomo";
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

fn success(value: Value) -> Value {
    match value {
        Value::Object(mut object) => {
            object.entry("success").or_insert(Value::Bool(true));
            Value::Object(object)
        }
        other => json!({ "success": true, "value": other }),
    }
}

fn arg_string(args: &[Value], index: usize) -> Option<String> {
    args.get(index)
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

pub(crate) fn command_output(program: &str, args: &[&str]) -> Result<String, String> {
    let mut command = Command::new(program);
    command.args(args);
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);
    let output = command.output().map_err(|err| err.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn shell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn friendly_auth_error(error: impl AsRef<str>) -> String {
    let err = error.as_ref();
    if err.is_empty() {
        return "授权失败，请重试".to_string();
    }
    if err.contains("-128")
        || err.to_ascii_lowercase().contains("user canceled")
        || err.to_ascii_lowercase().contains("user cancelled")
        || err.contains("用户已取消")
        || err.contains("用户取消")
    {
        return "授权已取消".to_string();
    }
    if err.to_ascii_lowercase().contains("permission denied")
        || err.to_ascii_lowercase().contains("not permitted")
        || err.to_ascii_lowercase().contains("authentication failed")
    {
        return "授权失败，请确保输入了正确的管理员密码".to_string();
    }
    "授权失败，请重试".to_string()
}

#[derive(Clone, Debug, Default)]
struct KernelStat {
    exists: bool,
    uid: u32,
    gid: u32,
    mode: u32,
    is_setuid: bool,
}

fn kernel_stat(path: &Path) -> KernelStat {
    match fs::metadata(path) {
        Ok(meta) => {
            #[cfg(unix)]
            {
                let mode = meta.permissions().mode();
                return KernelStat {
                    exists: true,
                    uid: meta.uid(),
                    gid: meta.gid(),
                    mode: mode & 0o7777,
                    is_setuid: mode & 0o4000 != 0,
                };
            }
            #[cfg(not(unix))]
            {
                let _ = meta;
                KernelStat {
                    exists: true,
                    ..KernelStat::default()
                }
            }
        }
        Err(_) => KernelStat::default(),
    }
}

fn same_kernel_binary(left: &Path, right: &Path) -> bool {
    if left == right {
        return true;
    }
    match (fs::metadata(left), fs::metadata(right)) {
        (Ok(left_meta), Ok(right_meta)) if left_meta.len() == right_meta.len() => {
            match (fs::read(left), fs::read(right)) {
                (Ok(left_bytes), Ok(right_bytes)) => left_bytes == right_bytes,
                _ => false,
            }
        }
        _ => false,
    }
}

fn has_quarantine_attr(path: &Path) -> bool {
    if !cfg!(target_os = "macos") {
        return false;
    }
    command_output(
        "xattr",
        &["-p", "com.apple.quarantine", &path.to_string_lossy()],
    )
    .is_ok()
}

pub(crate) fn macos_system_kernel_path() -> PathBuf {
    PathBuf::from(MACOS_SYSTEM_KERNEL_DIR).join(MACOS_SYSTEM_KERNEL_NAME)
}

/// Return the authorized system kernel when root + setuid are already present.
pub(crate) fn macos_authorized_kernel_path() -> Option<PathBuf> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let path = macos_system_kernel_path();
    let stat = kernel_stat(&path);
    if stat.exists && stat.uid == 0 && stat.is_setuid {
        Some(path)
    } else {
        None
    }
}

fn macos_source_kernel_path(app: &AppHandle) -> Result<PathBuf, String> {
    // Prefer managed / resource kernel, not the already-authorized system binary.
    if let Ok(path) = default_mihomo_executable(app) {
        if path.is_file() {
            return Ok(path);
        }
    }
    if let Ok(path) = find_mihomo_executable(app) {
        let system = macos_system_kernel_path();
        if path.is_file() && path != system {
            return Ok(path);
        }
    }
    Err("未找到内核文件".to_string())
}

fn apple_script_string_literal(value: &str) -> String {
    // AppleScript double-quoted string: escape \ and "
    let escaped = value.replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{escaped}\"")
}

fn run_osascript_admin(shell_command: &str) -> Result<(), String> {
    let script = format!(
        "do shell script {} with administrator privileges",
        apple_script_string_literal(shell_command)
    );
    let output = Command::new("osascript")
        .args(["-e", &script])
        .output()
        .map_err(|err| err.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Err(if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            "osascript failed".to_string()
        })
    }
}

fn grant_macos_tun_permissions(app: &AppHandle) -> CompatResult {
    if !cfg!(target_os = "macos") {
        return Ok(json!({
            "success": false,
            "error": "当前平台不支持 macOS 内核授权"
        }));
    }

    let source = match macos_source_kernel_path(app) {
        Ok(path) => path,
        Err(error) => return Ok(json!({ "success": false, "error": error })),
    };
    let system_dir = PathBuf::from(MACOS_SYSTEM_KERNEL_DIR);
    let system_path = macos_system_kernel_path();
    let existing = kernel_stat(&system_path);
    let needs_copy = !existing.exists || !same_kernel_binary(&source, &system_path);

    if existing.exists && existing.uid == 0 && existing.is_setuid && !needs_copy {
        set_setting(app, "tunElevateTask", json!(true))?;
        return Ok(success(json!({
            "message": "Kernel already authorized",
            "path": system_path,
            "needRestart": false
        })));
    }

    let tmp_name = format!(
        "flycast-mihomo-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|value| value.as_millis())
            .unwrap_or(0)
    );
    let tmp_path = std::env::temp_dir().join(tmp_name);
    if let Err(error) = fs::copy(&source, &tmp_path) {
        return Ok(json!({
            "success": false,
            "error": format!("复制内核到临时目录失败: {error}")
        }));
    }
    #[cfg(unix)]
    {
        let mut perms = fs::metadata(&tmp_path)
            .map_err(|err| err.to_string())?
            .permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&tmp_path, perms).map_err(|err| err.to_string())?;
    }

    let shell = format!(
        "mkdir -p {dir} && mv -f {tmp} {target} && xattr -d com.apple.quarantine {target} 2>/dev/null || true && chown root:wheel {target} && chmod u+s {target}",
        dir = shell_single_quote(&system_dir.to_string_lossy()),
        tmp = shell_single_quote(&tmp_path.to_string_lossy()),
        target = shell_single_quote(&system_path.to_string_lossy()),
    );

    if let Err(error) = run_osascript_admin(&shell) {
        let _ = fs::remove_file(&tmp_path);
        return Ok(json!({
            "success": false,
            "error": friendly_auth_error(error)
        }));
    }
    let _ = fs::remove_file(&tmp_path);

    let stat = kernel_stat(&system_path);
    let quarantine = has_quarantine_attr(&system_path);
    if !(stat.exists && stat.uid == 0 && stat.is_setuid) {
        return Ok(json!({
            "success": false,
            "error": "授权验证失败，请重试",
            "details": {
                "path": system_path,
                "uid": stat.uid,
                "gid": stat.gid,
                "mode": format!("{:o}", stat.mode),
                "isSetuid": stat.is_setuid,
                "hasQuarantine": quarantine
            }
        }));
    }

    set_setting(app, "tunElevateTask", json!(true))?;
    Ok(success(json!({
        "message": "Kernel authorized",
        "path": system_path,
        "needRestart": false,
        "details": {
            "uid": stat.uid,
            "gid": stat.gid,
            "mode": format!("{:o}", stat.mode),
            "isSetuid": stat.is_setuid,
            "hasQuarantine": quarantine
        }
    })))
}

fn check_macos_core_permission(app: &AppHandle) -> CompatResult {
    if !cfg!(target_os = "macos") {
        return Ok(success(json!({ "hasPermission": false })));
    }

    let system_path = macos_system_kernel_path();
    let system_stat = kernel_stat(&system_path);
    if system_stat.exists && system_stat.uid == 0 && system_stat.is_setuid {
        // Detect stale authorized binary when a newer managed kernel is available.
        if let Ok(source) = macos_source_kernel_path(app) {
            if source != system_path && !same_kernel_binary(&source, &system_path) {
                return Ok(success(json!({
                    "hasPermission": false,
                    "details": {
                        "path": system_path,
                        "type": "system",
                        "reason": "kernel_updated",
                        "uid": system_stat.uid,
                        "isSetuid": system_stat.is_setuid
                    }
                })));
            }
        }

        return Ok(success(json!({
            "hasPermission": true,
            "details": {
                "path": system_path,
                "type": "system",
                "uid": system_stat.uid,
                "isSetuid": system_stat.is_setuid
            }
        })));
    }

    // Fall back to whatever kernel path discovery currently returns.
    let current = find_mihomo_executable(app).ok();
    let current_stat = current
        .as_ref()
        .map(|path| kernel_stat(path))
        .unwrap_or_default();
    let has_permission = current_stat.exists && current_stat.uid == 0 && current_stat.is_setuid;
    Ok(success(json!({
        "hasPermission": has_permission,
        "details": {
            "path": current,
            "type": "current",
            "uid": current_stat.uid,
            "isSetuid": current_stat.is_setuid
        }
    })))
}

fn revoke_macos_core_permission(app: &AppHandle) -> CompatResult {
    if !cfg!(target_os = "macos") {
        return Ok(success(json!({})));
    }

    let system_path = macos_system_kernel_path();
    if !system_path.exists() {
        set_setting(app, "tunElevateTask", json!(false))?;
        return Ok(success(json!({ "deleted": false, "message": "未找到已授权内核" })));
    }

    let shell = format!(
        "if [ -f {target} ]; then chown root:wheel {target} 2>/dev/null || true; chmod u-s {target} 2>/dev/null || true; rm -f {target}; fi",
        target = shell_single_quote(&system_path.to_string_lossy()),
    );
    if let Err(error) = run_osascript_admin(&shell) {
        return Ok(json!({
            "success": false,
            "error": friendly_auth_error(error)
        }));
    }

    set_setting(app, "tunElevateTask", json!(false))?;
    Ok(success(json!({
        "deleted": true,
        "message": "已撤销 macOS TUN 内核授权"
    })))
}

fn grant_linux_tun_permissions(app: &AppHandle) -> CompatResult {
    if !cfg!(target_os = "linux") {
        return Ok(json!({
            "success": false,
            "error": "当前平台不支持 Linux 内核授权"
        }));
    }

    let kernel = match find_mihomo_executable(app) {
        Ok(path) if path.is_file() => path,
        _ => {
            return Ok(json!({
                "success": false,
                "error": "未找到内核文件"
            }))
        }
    };

    let path = kernel.to_string_lossy().to_string();
    // Prefer capabilities; fall back to setuid root.
    let setcap = Command::new("pkexec")
        .args([
            "setcap",
            "cap_net_admin,cap_net_bind_service=+eip",
            &path,
        ])
        .output();
    let ok = match setcap {
        Ok(output) if output.status.success() => true,
        _ => {
            let chown = Command::new("pkexec")
                .args(["chown", "root:root", &path])
                .status()
                .map(|status| status.success())
                .unwrap_or(false);
            let chmod = Command::new("pkexec")
                .args(["chmod", "u+s", &path])
                .status()
                .map(|status| status.success())
                .unwrap_or(false);
            chown && chmod
        }
    };

    if !ok {
        return Ok(json!({
            "success": false,
            "error": "授权失败，请重试"
        }));
    }

    set_setting(app, "tunElevateTask", json!(true))?;
    Ok(success(json!({
        "message": "Kernel authorized",
        "path": kernel,
        "needRestart": false
    })))
}

fn check_linux_core_permission(app: &AppHandle) -> CompatResult {
    if !cfg!(target_os = "linux") {
        return Ok(success(json!({ "hasPermission": false })));
    }

    let kernel = match find_mihomo_executable(app) {
        Ok(path) => path,
        Err(_) => {
            return Ok(success(json!({
                "hasPermission": false,
                "details": { "reason": "kernel_missing" }
            })))
        }
    };

    let mut has_cap = false;
    if let Ok(output) = command_output("getcap", &[&kernel.to_string_lossy()]) {
        has_cap = output.to_ascii_lowercase().contains("cap_net_admin");
    }
    let stat = kernel_stat(&kernel);
    let has_permission = has_cap || (stat.exists && stat.uid == 0 && stat.is_setuid);
    Ok(success(json!({
        "hasPermission": has_permission,
        "details": {
            "path": kernel,
            "hasCap": has_cap,
            "uid": stat.uid,
            "isSetuid": stat.is_setuid
        }
    })))
}

fn powershell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn windows_batch_quote(path: &Path) -> String {
    format!("\"{}\"", path.to_string_lossy().replace('"', "\"\""))
}

fn windows_task_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app_data_dir(app)?.join("task");
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    Ok(dir)
}

fn windows_current_user_id() -> String {
    command_output("whoami.exe", &[])
        .map(|value| value.trim().to_string())
        .ok()
        .filter(|value| !value.is_empty())
        .or_else(|| std::env::var("USERNAME").ok())
        .unwrap_or_default()
}

fn elevated_task_xml(exe_path: &Path, user_id: &str) -> String {
    let user_block = if user_id.is_empty() {
        String::new()
    } else {
        format!("      <UserId>{}</UserId>\n", xml_escape(user_id))
    };

    format!(
        r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>FlyClash Elevated Task</Description>
  </RegistrationInfo>
  <Triggers />
  <Principals>
    <Principal id="Author">
{user_block}      <LogonType>InteractiveToken</LogonType>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>4</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>{}</Command>
    </Exec>
  </Actions>
</Task>"#,
        xml_escape(&exe_path.to_string_lossy())
    )
}

fn write_utf16le_with_bom(path: &Path, content: &str) -> Result<(), String> {
    let mut bytes = vec![0xFF, 0xFE];
    for unit in content.encode_utf16() {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    fs::write(path, bytes).map_err(|err| err.to_string())
}

fn create_windows_elevated_task(app: &AppHandle) -> Result<bool, String> {
    if !cfg!(target_os = "windows") {
        return Ok(false);
    }

    let task_dir = windows_task_dir(app)?;
    let exe_path = std::env::current_exe().map_err(|err| err.to_string())?;
    let xml_path = task_dir.join(format!("{WINDOWS_ELEVATED_TASK_NAME}.xml"));
    let xml = elevated_task_xml(&exe_path, &windows_current_user_id());
    write_utf16le_with_bom(&xml_path, &xml)?;

    if windows_is_admin() {
        command_output(
            "schtasks.exe",
            &[
                "/create",
                "/tn",
                WINDOWS_ELEVATED_TASK_NAME,
                "/xml",
                &xml_path.to_string_lossy(),
                "/f",
            ],
        )?;
    } else {
        let batch_path = task_dir.join("create-elevated-task.bat");
        let marker_path = task_dir.join("grant-success.marker");
        let _ = fs::remove_file(&marker_path);
        let script = format!(
            r#"@echo off
chcp 65001 >nul
schtasks.exe /create /tn "{task_name}" /xml {xml_path} /f
if %errorlevel% neq 0 exit /b %errorlevel%
echo success > {marker_path}
exit /b 0
"#,
            task_name = WINDOWS_ELEVATED_TASK_NAME,
            xml_path = windows_batch_quote(&xml_path),
            marker_path = windows_batch_quote(&marker_path),
        );
        fs::write(&batch_path, script).map_err(|err| err.to_string())?;

        let ps_command = format!(
            "$p = Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', {}) -Verb RunAs -Wait -PassThru; if ($null -eq $p) {{ exit 1 }}; exit $p.ExitCode",
            powershell_quote(&batch_path.to_string_lossy())
        );
        command_output(
            "powershell.exe",
            &[
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                &ps_command,
            ],
        )?;
    }

    if windows_elevated_task_exists() {
        Ok(true)
    } else {
        Err("计划任务创建后未能查询到，请检查系统任务计划程序权限".to_string())
    }
}

fn schedule_windows_elevated_restart(app: &AppHandle) -> Result<(), String> {
    if !cfg!(target_os = "windows") {
        return Ok(());
    }

    let ps_command = format!(
        "Start-Sleep -Milliseconds 1200; schtasks.exe /run /tn {} | Out-Null",
        powershell_quote(WINDOWS_ELEVATED_TASK_NAME)
    );
    let mut command = Command::new("powershell.exe");
    command.args([
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        &ps_command,
    ]);
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);
    command.spawn().map_err(|err| err.to_string())?;

    let app_handle = app.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(500));
        app_handle.exit(0);
    });

    Ok(())
}

fn windows_is_admin() -> bool {
    if !cfg!(target_os = "windows") {
        return false;
    }

    let script = "[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)";
    if let Ok(output) = command_output(
        "powershell.exe",
        &["-NoProfile", "-NonInteractive", "-Command", script],
    ) {
        if output.trim().eq_ignore_ascii_case("true") {
            return true;
        }
    }

    command_output("net", &["session"]).is_ok()
}

fn windows_elevated_task_exists() -> bool {
    if !cfg!(target_os = "windows") {
        return false;
    }

    command_output(
        "schtasks.exe",
        &["/query", "/tn", WINDOWS_ELEVATED_TASK_NAME],
    )
    .is_ok()
}

fn delete_windows_elevated_task() -> Result<bool, String> {
    if !cfg!(target_os = "windows") {
        return Ok(false);
    }

    if !windows_elevated_task_exists() {
        return Ok(false);
    }

    command_output(
        "schtasks.exe",
        &["/delete", "/tn", WINDOWS_ELEVATED_TASK_NAME, "/f"],
    )?;
    Ok(true)
}

pub(crate) fn should_start_core_by_service(app: &AppHandle) -> bool {
    let tun_enabled = setting(app, "tunModeEnabled", json!(false))
        .ok()
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    crate::core::paths::should_start_by_service(
        cfg!(target_os = "windows"),
        &windows_tun_elevation_mode(app),
        tun_enabled,
    )
}

fn windows_tun_elevation_mode(app: &AppHandle) -> String {
    let mode = setting(app, "tunElevationMode", json!("service"))
        .ok()
        .and_then(|value| value.as_str().map(ToString::to_string))
        .unwrap_or_else(|| "service".to_string());

    mode
}

fn windows_core_permission_status(app: &AppHandle) -> Value {
    let mode = windows_tun_elevation_mode(app);
    let is_admin = windows_is_admin();
    let has_task = windows_elevated_task_exists();
    let flags = core_service::query_helper_service_flags();
    let helper = core_service::helper_ipc_snapshot(flags.running);

    success(core_service::windows_permission_status_payload(
        mode, is_admin, has_task, flags, helper,
    ))
}

fn helper_version_current(helper: &core_service::HelperIpcSnapshot) -> bool {
    helper
        .version
        .as_ref()
        .and_then(|value| value.get("version"))
        .and_then(Value::as_str)
        .map(|version| version == REQUIRED_HELPER_VERSION)
        .unwrap_or(false)
}

pub(crate) fn ensure_helper_service_current(app: &AppHandle) -> Result<(), String> {
    if !cfg!(target_os = "windows") {
        return Err("当前平台不支持 Windows 服务".to_string());
    }

    let flags = core_service::query_helper_service_flags();
    if flags.installed {
        // Start / repair IPC without reinstalling when the service binary is already present.
        if core_service::ensure_helper_service_ipc_ready().is_ok() {
            let helper = core_service::helper_ipc_snapshot(true);
            if helper.ipc_available() && helper_version_current(&helper) {
                return Ok(());
            }
        }

        let flags = core_service::query_helper_service_flags();
        let helper = core_service::helper_ipc_snapshot(flags.running);
        if helper.ipc_available() && helper_version_current(&helper) {
            return Ok(());
        }
    }

    let helper_path = find_helper_executable(app)?;
    if flags.running {
        let _ = core_service::stop_helper_service();
    }
    core_service::install_helper_service(&helper_path, !windows_is_admin())?;
    core_service::ensure_helper_service_ready()
}

/// Resume a pending TUN enable request after elevated helper install / restart.
/// Unlike main Electron (which only logs), this actually re-applies TUN once helper IPC is ready.
pub(crate) fn schedule_pending_tun_enable(app: &AppHandle) {
    let pending = setting(app, "pendingTunEnable", json!(false))
        .ok()
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    if !pending {
        return;
    }

    // Consume the flag up-front so a crash mid-resume does not loop forever.
    let _ = set_setting(app, "pendingTunEnable", json!(false));
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // Wait for autostart / window setup so core and tray are ready.
        tokio::time::sleep(Duration::from_millis(1800)).await;

        let Some(window) = app.get_webview_window("main") else {
            eprintln!("[TUN] pendingTunEnable: main window unavailable, aborting resume");
            return;
        };
        let state = app.state::<AppState>();

        if cfg!(target_os = "windows") {
            match ensure_helper_service_current(&app) {
                Ok(()) => {
                    eprintln!("[TUN] pendingTunEnable: helper service is ready");
                }
                Err(error) => {
                    eprintln!("[TUN] pendingTunEnable: helper not ready: {error}");
                    let _ = set_setting(&app, "tunModeEnabled", json!(false));
                    let _ = window.emit("tun-status", false);
                    let _ = window.emit(
                        "service-restarted",
                        json!({
                            "success": false,
                            "error": format!("TUN 恢复失败: Helper 不可用 ({error})")
                        }),
                    );
                    refresh_tray_menu_after(&app, "pendingTunEnable");
                    return;
                }
            }
        }

        if let Err(error) = ensure_tun_dns_defaults(&app) {
            eprintln!("[TUN] pendingTunEnable: ensure_tun_dns_defaults failed: {error}");
        }
        if let Err(error) = set_setting(&app, "tunModeEnabled", json!(true)) {
            eprintln!("[TUN] pendingTunEnable: failed to persist tunModeEnabled: {error}");
            return;
        }

        match apply_tun_runtime_change(&app, &window, &state, true, false, true).await {
            Ok(value) => {
                let ok = value
                    .get("success")
                    .and_then(Value::as_bool)
                    .unwrap_or(true);
                if ok {
                    eprintln!("[TUN] pendingTunEnable: TUN re-enabled after elevation");
                    let _ = window.emit("tun-status", true);
                } else {
                    let error = value
                        .get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown error");
                    eprintln!("[TUN] pendingTunEnable: apply failed: {error}");
                    let _ = window.emit("tun-status", false);
                }
            }
            Err(error) => {
                eprintln!("[TUN] pendingTunEnable: apply error: {error}");
                let _ = set_setting(&app, "tunModeEnabled", json!(false));
                let _ = window.emit("tun-status", false);
                let _ = window.emit(
                    "service-restarted",
                    json!({
                        "success": false,
                        "error": format!("TUN 恢复失败: {error}")
                    }),
                );
            }
        }

        refresh_tray_menu_after(&app, "pendingTunEnable");
    });
}

fn install_or_start_windows_tun_service(app: &AppHandle) -> CompatResult {
    let flags = core_service::query_helper_service_flags();
    if flags.running {
        let helper = core_service::helper_ipc_snapshot(true);
        let ipc_available = helper.ipc_available();
        if ipc_available && !helper_version_current(&helper) {
            let helper_path = find_helper_executable(app)?;
            let _ = core_service::stop_helper_service();
            core_service::install_helper_service(&helper_path, !windows_is_admin())?;
            let ready = core_service::ensure_helper_service_ready().is_ok();
            let flags = core_service::query_helper_service_flags();
            let helper = core_service::helper_ipc_snapshot(flags.running);
            return Ok(success(core_service::helper_service_action_payload(
                "TUN Helper 服务已更新并启动",
                helper,
                ready,
            )));
        }

        // Service process is alive but IPC is dead: restart the Windows service
        // instead of reporting a false "already running" success.
        if !ipc_available {
            match core_service::repair_helper_service_ipc() {
                Ok(()) => {
                    let flags = core_service::query_helper_service_flags();
                    let helper = core_service::helper_ipc_snapshot(flags.running);
                    let ready = helper.ipc_available();
                    return Ok(success(
                        core_service::helper_service_action_payload_with_repaired(
                            if ready {
                                "TUN Helper 服务 IPC 已修复并就绪"
                            } else {
                                "TUN Helper 服务已重启，IPC 仍未就绪"
                            },
                            helper,
                            ready,
                            true,
                        ),
                    ));
                }
                Err(error) => {
                    return Ok(json!({
                        "success": false,
                        "error": format!("Helper 服务运行中但 IPC 不可用，修复失败: {error}"),
                        "readiness": "running-no-ipc"
                    }));
                }
            }
        }

        return Ok(success(core_service::helper_service_action_payload(
            "TUN Helper 服务已运行",
            helper,
            ipc_available,
        )));
    }

    if flags.installed {
        return match core_service::ensure_helper_service_ready() {
            Ok(_) => {
                let helper = core_service::helper_ipc_snapshot(true);
                let ipc_available = helper.ipc_available();
                if ipc_available && !helper_version_current(&helper) {
                    let helper_path = find_helper_executable(app)?;
                    let _ = core_service::stop_helper_service();
                    core_service::install_helper_service(&helper_path, !windows_is_admin())?;
                    let ready = core_service::ensure_helper_service_ready().is_ok();
                    let flags = core_service::query_helper_service_flags();
                    let helper = core_service::helper_ipc_snapshot(flags.running);
                    return Ok(success(core_service::helper_service_action_payload(
                        "TUN Helper 服务已更新并启动",
                        helper,
                        ready,
                    )));
                }
                Ok(success(core_service::helper_service_action_payload(
                    "TUN Helper 服务已启动",
                    helper,
                    ipc_available,
                )))
            }
            Err(error) => Ok(json!({ "success": false, "error": error })),
        };
    }

    let helper = find_helper_executable(app)?;
    core_service::install_helper_service(&helper, !windows_is_admin())?;

    let ready = core_service::ensure_helper_service_ready().is_ok();
    let flags = core_service::query_helper_service_flags();
    let helper = core_service::helper_ipc_snapshot(flags.running);
    let message = if ready {
        "TUN Helper 服务已安装并就绪"
    } else if flags.running {
        "TUN Helper 服务已安装并启动，IPC 暂未就绪"
    } else {
        "TUN Helper 服务已安装"
    };
    Ok(success(core_service::helper_service_action_payload(
        message, helper, ready,
    )))
}

fn service_status() -> Value {
    if !cfg!(target_os = "windows") {
        return success(core_service::unsupported_service_status_payload());
    }

    let flags = core_service::query_helper_service_flags();
    let helper = core_service::helper_ipc_snapshot(flags.running);
    success(core_service::helper_service_status_payload(flags, helper))
}

pub(crate) fn find_helper_executable(app: &AppHandle) -> Result<PathBuf, String> {
    existing_resource_file(
        app,
        &[
            PathBuf::from("native")
                .join("helper")
                .join("flyclash-helper.exe"),
            PathBuf::from("tools").join("flyclash-helper.exe"),
            PathBuf::from("flyclash-helper.exe"),
        ],
    )
    .ok_or_else(|| "未找到 flyclash-helper.exe，请确认 tools 目录已被打包".to_string())
}

async fn dispatch_compat_call(
    app: &AppHandle,
    window: &WebviewWindow,
    state: &State<'_, AppState>,
    method: &str,
    args: &[Value],
) -> CompatResult {
    match method {
        "checkElevateTask" => Ok(Value::Bool(if cfg!(target_os = "windows") {
            windows_elevated_task_exists()
        } else {
            setting(app, "tunElevateTask", json!(false))?
                .as_bool()
                .unwrap_or(false)
        })),
        "deleteElevateTask" => {
            let deleted = if cfg!(target_os = "windows") {
                delete_windows_elevated_task()?
            } else {
                false
            };
            set_setting(app, "tunElevateTask", json!(false))?;
            Ok(success(json!({ "deleted": deleted })))
        }
        "grantTunPermissions" => {
            if cfg!(target_os = "windows") {
                let mode = setting(app, "tunElevationMode", json!("service"))?
                    .as_str()
                    .unwrap_or("service")
                    .to_string();
                if mode == "service" {
                    install_or_start_windows_tun_service(app)
                } else if windows_elevated_task_exists() || windows_is_admin() {
                    set_setting(app, "tunElevateTask", json!(true))?;
                    Ok(success(json!({
                        "message": if windows_elevated_task_exists() {
                            "计划任务已存在"
                        } else {
                            "当前进程已具备管理员权限"
                        },
                        "mode": "task",
                        "needRestart": false
                    })))
                } else {
                    create_windows_elevated_task(app)?;
                    set_setting(app, "tunElevateTask", json!(true))?;
                    set_setting(app, "pendingTunEnable", json!(true))?;
                    schedule_windows_elevated_restart(app)?;
                    Ok(success(json!({
                        "message": "正在请求管理员权限创建任务并重启应用...",
                        "mode": "task",
                        "needRestart": true
                    })))
                }
            } else if cfg!(target_os = "macos") {
                grant_macos_tun_permissions(app)
            } else if cfg!(target_os = "linux") {
                grant_linux_tun_permissions(app)
            } else {
                set_setting(app, "tunElevateTask", json!(true))?;
                Ok(success(json!({
                    "message": "TUN 权限状态已保存",
                    "needRestart": false
                })))
            }
        }
        "checkCorePermission" => {
            if cfg!(target_os = "windows") {
                Ok(windows_core_permission_status(app))
            } else if cfg!(target_os = "macos") {
                check_macos_core_permission(app)
            } else if cfg!(target_os = "linux") {
                check_linux_core_permission(app)
            } else {
                Ok(success(json!({
                    "hasPermission": find_mihomo_executable(app).map(|path| path.exists()).unwrap_or(false)
                })))
            }
        }
        "revokeCorePermission" => {
            if cfg!(target_os = "windows") {
                let deleted = delete_windows_elevated_task()?;
                set_setting(app, "tunElevateTask", json!(false))?;
                Ok(success(json!({ "deleted": deleted })))
            } else if cfg!(target_os = "macos") {
                revoke_macos_core_permission(app)
            } else {
                set_setting(app, "tunElevateTask", json!(false))?;
                Ok(success(json!({})))
            }
        }
        "getTunElevationMode" => Ok(success(json!({
            "mode": setting(app, "tunElevationMode", json!("service"))?
        }))),
        "setTunElevationMode" => {
            let mode = arg_string(args, 0).unwrap_or_else(|| "service".to_string());
            set_setting(app, "tunElevationMode", json!(mode))?;
            Ok(success(json!({})))
        }
        "getTunServiceStatus" | "serviceIsRunning" => Ok(service_status()),
        "installTunService" | "serviceInstall" => {
            if !cfg!(target_os = "windows") {
                Ok(json!({ "success": false, "error": "当前平台不支持 Windows 服务" }))
            } else {
                let helper = find_helper_executable(app)?;
                match core_service::install_helper_service(&helper, false) {
                    Ok(_) => Ok(success(json!({ "message": "service installed" }))),
                    Err(error) => Ok(json!({ "success": false, "error": error })),
                }
            }
        }
        "uninstallTunService" | "serviceUninstall" => {
            if !cfg!(target_os = "windows") {
                Ok(json!({ "success": false, "error": "当前平台不支持 Windows 服务" }))
            } else {
                let helper = find_helper_executable(app)?;
                match core_service::uninstall_helper_service(&helper) {
                    Ok(_) => Ok(success(json!({ "message": "service uninstalled" }))),
                    Err(error) => Ok(json!({ "success": false, "error": error })),
                }
            }
        }
        "startTunService" => {
            if !cfg!(target_os = "windows") {
                Ok(json!({ "success": false, "error": "当前平台不支持 Windows 服务" }))
            } else {
                match core_service::ensure_helper_service_ready() {
                    Ok(_) => Ok(success(json!({
                        "message": "service started",
                        "status": service_status()
                    }))),
                    Err(error) => Ok(json!({ "success": false, "error": error })),
                }
            }
        }
        "stopTunService" => {
            if !cfg!(target_os = "windows") {
                Ok(json!({ "success": false, "error": "当前平台不支持 Windows 服务" }))
            } else {
                let _ = core_lifecycle::stop_service_core();
                match core_service::stop_helper_service() {
                    Ok(_) => {
                        let mut runtime = state.runtime.lock().expect("runtime mutex poisoned");
                        if runtime.core.running_mode() == RunningMode::Service {
                            runtime.core.mark_stopped();
                        }
                        Ok(success(json!({ "message": "service stopped" })))
                    }
                    Err(error) => Ok(json!({ "success": false, "error": error })),
                }
            }
        }
        "toggleSystemProxy" => {
            let enabled = args.first().and_then(Value::as_bool).unwrap_or(false);
            if enabled && !is_mihomo_running(app) {
                return Ok(json!({
                    "success": false,
                    "enabled": false,
                    "error": "内核服务未运行，无法启用系统代理"
                }));
            }
            let port = mihomo_mixed_port(app);
            set_system_proxy(app, enabled, "127.0.0.1", port)?;
            let mut status = system_proxy_status(app);
            let actual_enabled = status
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if let Some(object) = status.as_object_mut() {
                object.insert("requested".to_string(), Value::Bool(enabled));
                if actual_enabled != enabled || object.contains_key("error") {
                    object.insert("success".to_string(), Value::Bool(false));
                    object
                        .entry("error".to_string())
                        .or_insert_with(|| Value::String("系统代理状态未切换到目标值".to_string()));
                    set_setting(app, "systemProxyEnabled", json!(actual_enabled))?;
                    let _ = window.emit("proxy-status", actual_enabled);
                    refresh_tray_menu_after(app, "toggleSystemProxy");
                    return Ok(status);
                }
            }
            let _ = window.emit("proxy-status", enabled);
            refresh_tray_menu_after(app, "toggleSystemProxy");
            Ok(status)
        }
        "getTunStatus" => Ok(Value::Bool(
            setting(app, "tunModeEnabled", json!(false))?
                .as_bool()
                .unwrap_or(false),
        )),
        "toggleTunMode" => {
            let enabled = args.first().and_then(Value::as_bool).unwrap_or(false);
            let previous_enabled = setting(app, "tunModeEnabled", json!(false))?
                .as_bool()
                .unwrap_or(false);
            if !enabled {
                set_setting(app, "pendingTunEnable", json!(false))?;
            }
            if enabled
                && cfg!(target_os = "windows")
                && windows_tun_elevation_mode(app) == "service"
            {
                if let Err(error) = ensure_helper_service_current(app) {
                    set_setting(app, "tunModeEnabled", json!(previous_enabled))?;
                    let _ = window.emit("tun-status", previous_enabled);
                    refresh_tray_menu_after(app, "toggleTunMode");
                    return Ok(json!({
                        "success": false,
                        "enabled": previous_enabled,
                        "pending": false,
                        "restarted": false,
                        "error": format!("TUN Helper 服务不可用: {error}")
                    }));
                }
            }
            if enabled && cfg!(target_os = "macos") {
                match check_macos_core_permission(app)? {
                    Value::Object(object)
                        if object
                            .get("hasPermission")
                            .and_then(Value::as_bool)
                            .unwrap_or(false) => {}
                    other => {
                        let reason = other
                            .get("details")
                            .and_then(|value| value.get("reason"))
                            .and_then(Value::as_str)
                            .unwrap_or("");
                        let error = if reason == "kernel_updated" {
                            "缺少必要权限或内核已更新，请先进行授权"
                        } else {
                            "缺少必要权限，请先进行授权"
                        };
                        set_setting(app, "tunModeEnabled", json!(previous_enabled))?;
                        let _ = window.emit("tun-status", previous_enabled);
                        refresh_tray_menu_after(app, "toggleTunMode");
                        return Ok(json!({
                            "success": false,
                            "enabled": previous_enabled,
                            "pending": false,
                            "restarted": false,
                            "needsAuth": true,
                            "error": error
                        }));
                    }
                }
            }
            if enabled && cfg!(target_os = "linux") {
                match check_linux_core_permission(app)? {
                    Value::Object(object)
                        if object
                            .get("hasPermission")
                            .and_then(Value::as_bool)
                            .unwrap_or(false) => {}
                    _ => {
                        set_setting(app, "tunModeEnabled", json!(previous_enabled))?;
                        let _ = window.emit("tun-status", previous_enabled);
                        refresh_tray_menu_after(app, "toggleTunMode");
                        return Ok(json!({
                            "success": false,
                            "enabled": previous_enabled,
                            "pending": false,
                            "restarted": false,
                            "needsAuth": true,
                            "error": "缺少必要权限，请先进行授权"
                        }));
                    }
                }
            }
            if enabled {
                ensure_tun_dns_defaults(app)?;
            }
            set_setting(app, "tunModeEnabled", json!(enabled))?;
            let result =
                apply_tun_runtime_change(app, window, state, enabled, previous_enabled, true).await;
            refresh_tray_menu_after(app, "toggleTunMode");
            result
        }
        "getTunConfig" => Ok(success(json!({
            "config": setting(app, "tunConfig", default_tun_config())?
        }))),
        "saveTunConfig" => {
            set_setting(
                app,
                "tunConfig",
                args.first().cloned().unwrap_or_else(default_tun_config),
            )?;
            let enabled = setting(app, "tunModeEnabled", json!(false))?
                .as_bool()
                .unwrap_or(false);
            if enabled {
                ensure_tun_dns_defaults(app)?;
                let result =
                    apply_tun_runtime_change(app, window, state, enabled, enabled, false).await;
                refresh_tray_menu_after(app, "saveTunConfig");
                result
            } else {
                refresh_tray_menu_after(app, "saveTunConfig");
                Ok(success(json!({
                    "enabled": false,
                    "pending": false,
                    "restarted": false,
                    "message": "TUN 配置已保存"
                })))
            }
        }
        "getProxySettings" => Ok(success(json!({
            "settings": user_settings_view(app)?
        }))),
        "saveProxySettings" => {
            let kernel_changed =
                save_proxy_settings(app, args.first().cloned().unwrap_or_else(|| json!({})))?;
            if kernel_changed {
                apply_saved_config(app, window, state, "proxy").await
            } else {
                Ok(success(json!({ "message": "Settings saved" })))
            }
        }
        "getProxyConfig" => {
            let host = "127.0.0.1";
            let port = mihomo_mixed_port(app);
            Ok(success(json!({
                "host": host,
                "port": port,
                "data": {
                    "host": host,
                    "port": port
                }
            })))
        }
        _ => Err(format!("Unsupported TUN service method: {method}")),
    }
}

pub(crate) async fn handle_compat_call(
    app: &AppHandle,
    window: &WebviewWindow,
    state: &State<'_, AppState>,
    method: &str,
    args: &[Value],
) -> Option<CompatResult> {
    if !matches!(
        method,
        "checkElevateTask"
            | "deleteElevateTask"
            | "grantTunPermissions"
            | "checkCorePermission"
            | "revokeCorePermission"
            | "getTunElevationMode"
            | "setTunElevationMode"
            | "getTunServiceStatus"
            | "serviceIsRunning"
            | "installTunService"
            | "serviceInstall"
            | "uninstallTunService"
            | "serviceUninstall"
            | "startTunService"
            | "stopTunService"
            | "toggleSystemProxy"
            | "getTunStatus"
            | "toggleTunMode"
            | "getTunConfig"
            | "saveTunConfig"
            | "getProxySettings"
            | "saveProxySettings"
            | "getProxyConfig"
    ) {
        return None;
    }

    Some(dispatch_compat_call(app, window, state, method, args).await)
}
