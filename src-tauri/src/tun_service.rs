use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    thread,
    time::Duration,
};

use serde_json::{json, Value};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use tauri::{AppHandle, Emitter, State, WebviewWindow};

use crate::{
    app::{
        default_tun_config, ensure_tun_dns_defaults, mihomo_mixed_port, save_proxy_settings,
        user_settings_view,
    },
    core::{lifecycle as core_lifecycle, manager::RunningMode, service as core_service},
    core_commands::find_mihomo_executable,
    core_lifecycle_commands::{apply_saved_config, apply_tun_runtime_change},
    platform::{set_system_proxy, system_proxy_status},
    resources::existing_resource_file,
    runtime::is_mihomo_running,
    state::AppState,
    storage::{app_data_dir, set_setting, setting},
    tray::refresh_tray_menu_after,
};

type CompatResult = Result<Value, String>;

const WINDOWS_ELEVATED_TASK_NAME: &str = "FlyClash-Elevated";

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
    command.creation_flags(0x08000000);
    let output = command.output().map_err(|err| err.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
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
    command.creation_flags(0x08000000);
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
    if !cfg!(target_os = "windows") {
        return false;
    }

    let mode = setting(app, "tunElevationMode", json!("service"))
        .ok()
        .and_then(|value| value.as_str().map(ToString::to_string))
        .unwrap_or_else(|| "service".to_string());
    let tun_enabled = setting(app, "tunModeEnabled", json!(false))
        .ok()
        .and_then(|value| value.as_bool())
        .unwrap_or(false);

    mode == "service" && tun_enabled
}

fn windows_core_permission_status(app: &AppHandle) -> Value {
    let mode = setting(app, "tunElevationMode", json!("service"))
        .ok()
        .and_then(|value| value.as_str().map(ToString::to_string))
        .unwrap_or_else(|| "service".to_string());
    let is_admin = windows_is_admin();
    let has_task = windows_elevated_task_exists();
    let flags = core_service::query_helper_service_flags();
    let helper = core_service::helper_ipc_snapshot(flags.running);

    success(core_service::windows_permission_status_payload(
        mode, is_admin, has_task, flags, helper,
    ))
}

fn install_or_start_windows_tun_service(app: &AppHandle) -> CompatResult {
    let flags = core_service::query_helper_service_flags();
    if flags.running {
        let helper = core_service::helper_ipc_snapshot(true);
        let ipc_available = helper.ipc_available();
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
            } else {
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
                    "error": "Mihomo 服务未运行，无法启用系统代理"
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
