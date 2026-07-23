#[cfg(target_os = "windows")]
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
#[cfg(any(target_os = "windows", test))]
use serde_json::value::RawValue;
use serde_json::{json, Value};
#[cfg(any(target_os = "windows", test))]
use sha2::{Digest, Sha256};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::time::{SystemTime, UNIX_EPOCH};
use std::{env, fs};
use std::{path::Path, process::Command, thread, time::Duration};

#[cfg(any(target_os = "windows", test))]
const SECRET_SEED: &str = "flyclash-helper-service-secret-key-v1";
const HELPER_SERVICE_NAME: &str = "FlyClashHelperService";
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct HelperCoreStatus {
    pub running: bool,
    pub pid: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct HelperIpcSnapshot {
    pub status: Option<HelperCoreStatus>,
    pub version: Option<Value>,
    pub status_error: Option<String>,
    pub version_error: Option<String>,
}

impl HelperIpcSnapshot {
    pub fn ipc_available(&self) -> bool {
        self.status.is_some() || self.version.is_some()
    }

    pub fn core_running(&self) -> bool {
        self.status
            .as_ref()
            .map(|status| status.running)
            .unwrap_or(false)
    }

    pub fn core_pid(&self) -> Option<u32> {
        self.status.as_ref().and_then(|status| status.pid)
    }
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct HelperServiceFlags {
    pub installed: bool,
    pub running: bool,
    pub error: Option<String>,
}

impl HelperServiceFlags {
    pub fn new(installed: bool, running: bool, error: Option<String>) -> Self {
        Self {
            installed,
            running,
            error,
        }
    }
}

/// Decode Windows console bytes. sc.exe / helper often emit GBK (code page 936)
/// on Chinese systems; treating that as UTF-8 produces mojibake and breaks
/// access-denied detection.
#[cfg(target_os = "windows")]
fn decode_windows_bytes(bytes: &[u8]) -> String {
    if bytes.is_empty() {
        return String::new();
    }
    if std::str::from_utf8(bytes).is_ok() {
        return String::from_utf8_lossy(bytes).trim().to_string();
    }
    decode_windows_bytes_winapi(bytes)
}

#[cfg(target_os = "windows")]
fn decode_windows_bytes_winapi(bytes: &[u8]) -> String {
    type DWORD = u32;
    // CP_ACP = 0 uses the system ANSI code page (GBK on zh-CN).
    const CP_ACP: DWORD = 0;

    #[link(name = "kernel32")]
    extern "system" {
        fn MultiByteToWideChar(
            code_page: DWORD,
            dw_flags: DWORD,
            lp_multi_byte_str: *const u8,
            cb_multi_byte: i32,
            lp_wide_char_str: *mut u16,
            cch_wide_char: i32,
        ) -> i32;
    }

    unsafe {
        let needed = MultiByteToWideChar(
            CP_ACP,
            0,
            bytes.as_ptr(),
            bytes.len() as i32,
            std::ptr::null_mut(),
            0,
        );
        if needed <= 0 {
            return String::from_utf8_lossy(bytes).trim().to_string();
        }
        let mut wide = vec![0u16; needed as usize];
        let written = MultiByteToWideChar(
            CP_ACP,
            0,
            bytes.as_ptr(),
            bytes.len() as i32,
            wide.as_mut_ptr(),
            needed,
        );
        if written <= 0 {
            return String::from_utf8_lossy(bytes).trim().to_string();
        }
        String::from_utf16_lossy(&wide[..written as usize])
            .trim()
            .to_string()
    }
}

#[cfg(not(target_os = "windows"))]
fn decode_windows_bytes(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).trim().to_string()
}

fn command_output(program: &str, args: &[&str]) -> Result<String, String> {
    let mut command = Command::new(program);
    command.args(args);
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);
    let output = command.output().map_err(|err| err.to_string())?;
    if !output.status.success() {
        let stderr = decode_windows_bytes(&output.stderr);
        let stdout = decode_windows_bytes(&output.stdout);
        // sc.exe often prints "Access is denied." / Chinese 拒绝访问 on stdout.
        return Err(if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            format!("{program} exited with status {}", output.status)
        });
    }
    Ok(decode_windows_bytes(&output.stdout))
}

fn powershell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn helper_elevated_command(helper_path: &Path, arg: &str) -> String {
    format!(
        "$p = Start-Process -FilePath {} -ArgumentList {} -Verb RunAs -Wait -PassThru -WindowStyle Hidden; if ($null -eq $p) {{ exit 1223 }}; exit $p.ExitCode",
        powershell_quote(&helper_path.to_string_lossy()),
        powershell_quote(arg)
    )
}

fn run_powershell(command: &str) -> Result<String, String> {
    command_output(
        "powershell.exe",
        &[
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            command,
        ],
    )
}

fn looks_like_access_denied(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    if lower.contains("access is denied")
        || lower.contains("access denied")
        || lower.contains("service manager")
        || lower.contains("error 5")
        || lower.contains("error: 5")
        || lower.contains("failed 5")
        || lower.contains("failed: 5")
        || lower.contains("(5)")
        || lower.contains("1223")
    {
        return true;
    }
    if error.contains("拒绝访问") {
        return true;
    }
    // sc.exe: "[SC] OpenService FAILED 5:" / "[SC] OpenService 失败 5:"
    // Match any OpenService/OpenSCManager failure mentioning code 5.
    if (error.contains("OpenService")
        || error.contains("OpenSCManager")
        || lower.contains("openservice")
        || lower.contains("openscmanager")
        || lower.contains("[sc]"))
        && (error.contains('5'))
    {
        return true;
    }
    // Mojibake fallback for GBK mis-decoded as UTF-8 (拒绝/失败).
    if error.contains('\u{fffd}') && error.contains('5') {
        return true;
    }
    false
}

fn elevate_helper_arg(helper_path: &Path, arg: &str) -> Result<(), String> {
    let command = helper_elevated_command(helper_path, arg);
    match run_powershell(&command) {
        Ok(_) => Ok(()),
        Err(error) if error.contains("1223") || error.trim().is_empty() => {
            Err("已取消管理员授权，无法修改 Helper 服务".to_string())
        }
        Err(error) => Err(error),
    }
}

fn elevate_sc_args(args: &[&str]) -> Result<String, String> {
    // sc.exe needs admin for stop/start/delete against SCM.
    // IMPORTANT: Do NOT use -RedirectStandardOutput with -Verb RunAs.
    // Elevated Start-Process cannot redirect handles across the UAC boundary
    // and fails silently / without a prompt on many systems.
    //
    // Write a tiny .cmd that runs sc and captures exit code; elevate the cmd.
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis())
        .unwrap_or(0);
    let dir = env::temp_dir();
    let bat_path = dir.join(format!("flyclash-sc-{stamp}.cmd"));
    let out_path = dir.join(format!("flyclash-sc-{stamp}.out"));
    let code_path = dir.join(format!("flyclash-sc-{stamp}.code"));

    let sc_args = args
        .iter()
        .map(|arg| {
            if arg.chars().any(|ch| ch.is_whitespace()) {
                format!("\"{arg}\"")
            } else {
                (*arg).to_string()
            }
        })
        .collect::<Vec<_>>()
        .join(" ");
    let bat = format!(
        "@echo off\r\n\
         sc.exe {sc_args} > \"{out}\" 2>&1\r\n\
         echo %ERRORLEVEL% > \"{code}\"\r\n",
        out = out_path.to_string_lossy(),
        code = code_path.to_string_lossy(),
    );
    fs::write(&bat_path, bat).map_err(|err| format!("写入提权脚本失败: {err}"))?;
    let _ = fs::remove_file(&out_path);
    let _ = fs::remove_file(&code_path);

    let bat_quoted = powershell_quote(&bat_path.to_string_lossy());
    let command = format!(
        "$p = Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', {bat_quoted}) -Verb RunAs -Wait -PassThru -WindowStyle Hidden; \
         if ($null -eq $p) {{ exit 1223 }}; \
         exit $p.ExitCode"
    );

    let launch = run_powershell(&command);
    let output_text = fs::read(&out_path)
        .map(|bytes| decode_windows_bytes(&bytes))
        .unwrap_or_default();
    let exit_code = fs::read_to_string(&code_path)
        .ok()
        .and_then(|text| text.trim().parse::<i32>().ok());
    let _ = fs::remove_file(&bat_path);
    let _ = fs::remove_file(&out_path);
    let _ = fs::remove_file(&code_path);

    match launch {
        Ok(_) => {
            if let Some(code) = exit_code {
                if code == 0 {
                    return Ok(output_text);
                }
                if !output_text.is_empty() {
                    return Err(output_text);
                }
                return Err(format!("sc.exe exit {code}"));
            }
            Ok(output_text)
        }
        Err(error) if error.contains("1223") || error.trim().is_empty() => {
            Err("已取消管理员授权，无法控制系统服务".to_string())
        }
        Err(error) => {
            if !output_text.is_empty() {
                Err(output_text)
            } else {
                Err(error)
            }
        }
    }
}

pub fn install_helper_service(helper_path: &Path, elevated: bool) -> Result<(), String> {
    if !cfg!(target_os = "windows") {
        return Err("当前平台不支持 Windows Helper 服务".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        let sid = windows_current_user_sid()?;
        let elevated_arg = format!("-install --client-sid {sid}");
        if elevated {
            return elevate_helper_arg(helper_path, &elevated_arg);
        }

        match command_output(
            &helper_path.to_string_lossy(),
            &["-install", "--client-sid", &sid],
        ) {
            Ok(_) => Ok(()),
            Err(error) if looks_like_access_denied(&error) => {
                elevate_helper_arg(helper_path, &elevated_arg)
            }
            Err(error) => Err(error),
        }
    }

    #[cfg(not(target_os = "windows"))]
    unreachable!("platform check above must return on non-Windows builds")
}

#[cfg(target_os = "windows")]
fn is_windows_sid(value: &str) -> bool {
    let mut parts = value.trim().split('-');
    if !matches!(parts.next(), Some("S" | "s")) || parts.next() != Some("1") {
        return false;
    }
    let values = parts.collect::<Vec<_>>();
    values.len() >= 2
        && values
            .iter()
            .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
}

#[cfg(target_os = "windows")]
fn windows_current_user_sid() -> Result<String, String> {
    let output = command_output("whoami", &["/user", "/fo", "csv", "/nh"])?;
    output
        .split(|ch: char| !ch.is_ascii_alphanumeric() && ch != '-')
        .find(|token| is_windows_sid(token))
        .map(ToString::to_string)
        .ok_or_else(|| "无法确定当前 Windows 用户 SID".to_string())
}

#[cfg(target_os = "windows")]
fn encode_existing_service_core_path(path: &Path) -> Result<String, String> {
    let path = path
        .canonicalize()
        .map_err(|err| format!("无法解析服务内核路径: {err}"))?;
    Ok(URL_SAFE_NO_PAD.encode(path.to_string_lossy().as_bytes()))
}

#[cfg(target_os = "windows")]
fn encode_service_core_destination(path: &Path) -> Result<String, String> {
    let path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|err| format!("无法解析服务内核目标路径: {err}"))?
            .join(path)
    };
    Ok(URL_SAFE_NO_PAD.encode(path.to_string_lossy().as_bytes()))
}

#[cfg(target_os = "windows")]
pub fn service_core_is_trusted(helper_path: &Path, target: &Path) -> Result<bool, String> {
    let target = encode_existing_service_core_path(target)?;
    let output = command_output(
        &helper_path.to_string_lossy(),
        &["-service-core-status", &target],
    )?;
    Ok(output.trim().eq_ignore_ascii_case("trusted"))
}

#[cfg(not(target_os = "windows"))]
pub fn service_core_is_trusted(_helper_path: &Path, _target: &Path) -> Result<bool, String> {
    Err("当前平台不支持 Windows Helper 服务".to_string())
}

#[cfg(target_os = "windows")]
pub fn install_service_core(
    helper_path: &Path,
    source: &Path,
    target: &Path,
) -> Result<(), String> {
    let source = encode_existing_service_core_path(source)?;
    let target = encode_service_core_destination(target)?;
    let elevated_arg = format!("-install-service-core {source} -service-core-target {target}");
    match command_output(
        &helper_path.to_string_lossy(),
        &[
            "-install-service-core",
            &source,
            "-service-core-target",
            &target,
        ],
    ) {
        Ok(_) => Ok(()),
        Err(error) if looks_like_access_denied(&error) => {
            elevate_helper_arg(helper_path, &elevated_arg)
        }
        Err(error) => Err(error),
    }
}

#[cfg(not(target_os = "windows"))]
pub fn install_service_core(
    _helper_path: &Path,
    _source: &Path,
    _target: &Path,
) -> Result<(), String> {
    Err("当前平台不支持 Windows Helper 服务".to_string())
}

pub fn uninstall_helper_service(helper_path: &Path) -> Result<(), String> {
    if !cfg!(target_os = "windows") {
        return Err("当前平台不支持 Windows Helper 服务".to_string());
    }

    // Prefer elevated uninstall first: SCM delete always needs admin, and a
    // non-elevated attempt just produces a confusing Access Denied toast.
    match elevate_helper_arg(helper_path, "-uninstall") {
        Ok(()) => Ok(()),
        Err(error) => {
            // Fall back to direct call in case the helper is already elevated /
            // UAC auto-elevates the binary via manifest.
            match command_output(&helper_path.to_string_lossy(), &["-uninstall"]) {
                Ok(_) => Ok(()),
                Err(direct_error) => {
                    if looks_like_access_denied(&direct_error) {
                        Err(error)
                    } else {
                        Err(direct_error)
                    }
                }
            }
        }
    }
}

fn helper_service_running_from_query(text: &str) -> bool {
    text.contains("RUNNING")
}

fn helper_service_flags_from_query_result(result: Result<String, String>) -> HelperServiceFlags {
    match result {
        Ok(text) => HelperServiceFlags::new(true, helper_service_running_from_query(&text), None),
        Err(error) => HelperServiceFlags::new(false, false, Some(error)),
    }
}

pub fn query_helper_service_flags() -> HelperServiceFlags {
    if !cfg!(target_os = "windows") {
        return HelperServiceFlags::default();
    }

    helper_service_flags_from_query_result(command_output("sc", &["query", HELPER_SERVICE_NAME]))
}

pub fn ensure_helper_service_ready() -> Result<(), String> {
    if !cfg!(target_os = "windows") {
        return Err("当前平台不支持 Windows Helper 服务".to_string());
    }

    let flags = query_helper_service_flags();
    if !flags.installed {
        return Err(flags
            .error
            .unwrap_or_else(|| "FlyClash Helper 服务未安装".to_string()));
    }

    if !flags.running {
        match command_output("sc", &["start", HELPER_SERVICE_NAME]) {
            Ok(_) => {}
            Err(error) if looks_like_access_denied(&error) => {
                elevate_sc_args(&["start", HELPER_SERVICE_NAME])?;
            }
            Err(error) => return Err(error),
        }
    }

    for _ in 0..30 {
        if get_version().is_ok() {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(200));
    }

    Err("FlyClash Helper 服务已启动，但 IPC 未就绪".to_string())
}

/// Restart a running helper service and wait until IPC answers.
///
/// Used for the "running but pipe dead" failure mode, where `sc query`
/// still reports RUNNING while named-pipe IPC is broken.
pub fn repair_helper_service_ipc() -> Result<(), String> {
    if !cfg!(target_os = "windows") {
        return Err("当前平台不支持 Windows Helper 服务".to_string());
    }

    let flags = query_helper_service_flags();
    if !flags.installed {
        return Err(flags
            .error
            .unwrap_or_else(|| "FlyClash Helper 服务未安装".to_string()));
    }

    if flags.running {
        // Best-effort stop; even if sc stop fails, ensure_helper_service_ready
        // will still try to start / wait for IPC.
        let _ = stop_helper_service();
        for _ in 0..20 {
            let current = query_helper_service_flags();
            if !current.running {
                break;
            }
            thread::sleep(Duration::from_millis(150));
        }
    }

    ensure_helper_service_ready()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HelperEnsureOutcome {
    AlreadyReady,
    Started,
    RepairedIpc,
}

/// Pure decision helper for ensure/repair paths. Separated so unit tests do not
/// need Windows service control.
pub fn helper_ensure_plan(
    installed: bool,
    running: bool,
    ipc_available: bool,
) -> Result<HelperEnsureOutcome, &'static str> {
    if !installed {
        return Err("not-installed");
    }
    if running {
        if ipc_available {
            return Ok(HelperEnsureOutcome::AlreadyReady);
        }
        return Ok(HelperEnsureOutcome::RepairedIpc);
    }
    Ok(HelperEnsureOutcome::Started)
}

/// Ensure helper service is installed, running, and IPC-ready.
///
/// Unlike `ensure_helper_service_ready`, this repairs the
/// `running + no IPC` state by restarting the Windows service.
pub fn ensure_helper_service_ipc_ready() -> Result<HelperEnsureOutcome, String> {
    if !cfg!(target_os = "windows") {
        return Err("当前平台不支持 Windows Helper 服务".to_string());
    }

    let flags = query_helper_service_flags();
    if !flags.installed {
        return Err(flags
            .error
            .unwrap_or_else(|| "FlyClash Helper 服务未安装".to_string()));
    }

    let running = flags.running;
    let ipc_available = if running {
        helper_ipc_snapshot(true).ipc_available()
    } else {
        false
    };

    match helper_ensure_plan(flags.installed, running, ipc_available) {
        Ok(HelperEnsureOutcome::AlreadyReady) => Ok(HelperEnsureOutcome::AlreadyReady),
        Ok(HelperEnsureOutcome::RepairedIpc) => {
            repair_helper_service_ipc()?;
            Ok(HelperEnsureOutcome::RepairedIpc)
        }
        Ok(HelperEnsureOutcome::Started) => {
            ensure_helper_service_ready()?;
            Ok(HelperEnsureOutcome::Started)
        }
        Err(_) => Err(flags
            .error
            .unwrap_or_else(|| "FlyClash Helper 服务未安装".to_string())),
    }
}

pub fn stop_helper_service() -> Result<String, String> {
    if !cfg!(target_os = "windows") {
        return Err("当前平台不支持 Windows Helper 服务".to_string());
    }

    // Stopping a Windows service always needs SCM admin rights for non-elevated
    // UI processes. Prefer UAC elevation first so users always get a prompt
    // instead of a garbled "[SC] OpenService FAILED 5" toast.
    match elevate_sc_args(&["stop", HELPER_SERVICE_NAME]) {
        Ok(output) => Ok(output),
        Err(elev_error) => {
            // Fall back to direct sc for already-elevated hosts / auto-elevate.
            match command_output("sc", &["stop", HELPER_SERVICE_NAME]) {
                Ok(output) => Ok(output),
                Err(direct_error) => {
                    if looks_like_access_denied(&direct_error) {
                        Err(elev_error)
                    } else {
                        Err(format!("{direct_error}；提权: {elev_error}"))
                    }
                }
            }
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum HelperServiceReadiness {
    Unsupported,
    NotInstalled,
    InstalledStopped,
    RunningNoIpc,
    Ready,
}

impl HelperServiceReadiness {
    pub fn from_state(
        installed: bool,
        running: bool,
        ipc_available: bool,
        unsupported: bool,
    ) -> Self {
        if unsupported {
            return Self::Unsupported;
        }
        if !installed {
            return Self::NotInstalled;
        }
        if !running {
            return Self::InstalledStopped;
        }
        if !ipc_available {
            return Self::RunningNoIpc;
        }
        Self::Ready
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HelperServiceStatus {
    pub installed: bool,
    pub running: bool,
    pub mode: String,
    pub ipc_available: bool,
    /// Service process is running AND helper IPC answers. Prefer this over `running`.
    pub service_ready: bool,
    pub readiness: HelperServiceReadiness,
    pub core_running: bool,
    pub core_pid: Option<u32>,
    pub version: Option<Value>,
    pub error: Option<String>,
    pub helper_status_error: Option<String>,
    pub helper_version_error: Option<String>,
}

impl HelperServiceStatus {
    pub fn unsupported() -> Self {
        Self {
            installed: false,
            running: false,
            mode: "unsupported".to_string(),
            ipc_available: false,
            service_ready: false,
            readiness: HelperServiceReadiness::Unsupported,
            core_running: false,
            core_pid: None,
            version: None,
            error: None,
            helper_status_error: None,
            helper_version_error: None,
        }
    }

    pub fn from_flags(flags: HelperServiceFlags, helper: HelperIpcSnapshot) -> Self {
        let ipc_available = helper.ipc_available();
        let service_ready = flags.running && ipc_available;
        Self {
            installed: flags.installed,
            running: flags.running,
            mode: "service".to_string(),
            ipc_available,
            service_ready,
            readiness: HelperServiceReadiness::from_state(
                flags.installed,
                flags.running,
                ipc_available,
                false,
            ),
            core_running: helper.core_running(),
            core_pid: helper.core_pid(),
            version: helper.version,
            error: flags.error,
            helper_status_error: helper.status_error,
            helper_version_error: helper.version_error,
        }
    }
}

fn status_value(status: HelperServiceStatus) -> Value {
    serde_json::to_value(status).unwrap_or_else(|_| json!({}))
}

pub fn unsupported_service_status_payload() -> Value {
    status_value(HelperServiceStatus::unsupported())
}

pub fn helper_service_status_payload(
    flags: HelperServiceFlags,
    helper: HelperIpcSnapshot,
) -> Value {
    status_value(HelperServiceStatus::from_flags(flags, helper))
}

pub fn helper_service_action_payload(
    message: impl Into<String>,
    helper: HelperIpcSnapshot,
    ipc_available: bool,
) -> Value {
    helper_service_action_payload_with_repaired(message, helper, ipc_available, false)
}

pub fn helper_service_action_payload_with_repaired(
    message: impl Into<String>,
    helper: HelperIpcSnapshot,
    ipc_available: bool,
    repaired: bool,
) -> Value {
    json!({
        "message": message.into(),
        "mode": "service",
        "ipcAvailable": ipc_available,
        "serviceReady": ipc_available,
        "coreRunning": helper.core_running(),
        "corePid": helper.core_pid(),
        "helperStatusError": helper.status_error,
        "helperVersionError": helper.version_error,
        "version": helper.version,
        "needRestart": false,
        "repaired": repaired
    })
}

pub fn windows_permission_status_payload(
    mode: impl Into<String>,
    is_admin: bool,
    has_elevate_task: bool,
    flags: HelperServiceFlags,
    helper: HelperIpcSnapshot,
) -> Value {
    let mode = mode.into();
    let service_ready = flags.running && helper.ipc_available();
    let has_permission = if mode == "service" {
        service_ready || is_admin
    } else {
        has_elevate_task || is_admin
    };

    json!({
        "hasPermission": has_permission,
        "serviceReady": service_ready,
        "ipcAvailable": helper.ipc_available(),
        "coreRunning": helper.core_running(),
        "corePid": helper.core_pid(),
        "details": {
            "mode": mode,
            "isAdmin": is_admin,
            "hasElevateTask": has_elevate_task,
            "serviceInstalled": flags.installed,
            "serviceRunning": flags.running,
            "serviceError": flags.error,
            "helperStatusError": helper.status_error,
            "helperVersionError": helper.version_error,
            "helperVersion": helper.version
        }
    })
}

#[cfg(any(target_os = "windows", test))]
#[derive(Debug, Deserialize)]
struct HelperWireResponse {
    id: String,
    success: bool,
    #[serde(default)]
    data: Option<Box<RawValue>>,
    #[serde(default)]
    error: Option<String>,
    signature: String,
}

#[derive(Debug)]
struct HelperResponse {
    success: bool,
    data: Option<Value>,
    error: Option<String>,
}

#[cfg(any(target_os = "windows", test))]
fn sha256_bytes(data: &[u8]) -> Vec<u8> {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hasher.finalize().to_vec()
}

#[cfg(any(target_os = "windows", test))]
fn hex_lower(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push_str(&format!("{byte:02x}"));
    }
    output
}

#[cfg(any(target_os = "windows", test))]
fn hmac_sha256_hex(key: &[u8], data: &str) -> String {
    let mut key_block = [0u8; 64];
    if key.len() > 64 {
        let digest = sha256_bytes(key);
        key_block[..digest.len()].copy_from_slice(&digest);
    } else {
        key_block[..key.len()].copy_from_slice(key);
    }

    let mut inner_pad = [0x36u8; 64];
    let mut outer_pad = [0x5cu8; 64];
    for index in 0..64 {
        inner_pad[index] ^= key_block[index];
        outer_pad[index] ^= key_block[index];
    }

    let mut inner = Sha256::new();
    inner.update(inner_pad);
    inner.update(data.as_bytes());
    let inner_hash = inner.finalize();

    let mut outer = Sha256::new();
    outer.update(outer_pad);
    outer.update(inner_hash);
    hex_lower(&outer.finalize())
}

#[cfg(any(target_os = "windows", test))]
fn constant_time_eq(left: &str, right: &str) -> bool {
    let left = left.as_bytes();
    let right = right.as_bytes();
    if left.len() != right.len() {
        return false;
    }

    let mut diff = 0u8;
    for (left, right) in left.iter().zip(right.iter()) {
        diff |= left ^ right;
    }
    diff == 0
}

#[cfg(any(target_os = "windows", test))]
fn verify_response_signature(response: &HelperWireResponse) -> Result<(), String> {
    let mut sign_data = format!("{}:{}", response.id, response.success);
    if let Some(data) = response.data.as_deref() {
        sign_data.push(':');
        sign_data.push_str(data.get());
    }
    if let Some(error) = response.error.as_deref().filter(|value| !value.is_empty()) {
        sign_data.push(':');
        sign_data.push_str(error);
    }

    let expected = hmac_sha256_hex(&secret_key(), &sign_data);
    if constant_time_eq(&expected, &response.signature) {
        Ok(())
    } else {
        Err("FlyClash Helper IPC 响应签名校验失败".to_string())
    }
}

#[cfg(any(target_os = "windows", test))]
fn parse_response(raw: &str, expected_id: &str) -> Result<HelperResponse, String> {
    let response: HelperWireResponse = serde_json::from_str(raw).map_err(|err| err.to_string())?;
    if response.id != expected_id {
        return Err("FlyClash Helper IPC 响应 ID 不匹配".to_string());
    }
    verify_response_signature(&response)?;

    let data = response
        .data
        .as_deref()
        .map(|raw| serde_json::from_str::<Value>(raw.get()).map_err(|err| err.to_string()))
        .transpose()?;

    Ok(HelperResponse {
        success: response.success,
        data,
        error: response.error,
    })
}

#[cfg(any(target_os = "windows", test))]
fn secret_key() -> Vec<u8> {
    sha256_bytes(SECRET_SEED.as_bytes())
}

#[cfg(target_os = "windows")]
fn request_id() -> String {
    let mut bytes = [0u8; 8];
    if getrandom::getrandom(&mut bytes).is_err() {
        let fallback = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        bytes.copy_from_slice(&fallback.to_le_bytes()[..8]);
    }
    hex_lower(&bytes)
}

#[cfg(target_os = "windows")]
fn timestamp_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or_default()
}

#[cfg(target_os = "windows")]
fn send_request(command: &str, payload: Option<Value>) -> Result<HelperResponse, String> {
    use std::{
        fs::OpenOptions,
        io::{BufRead, BufReader, Write},
    };

    const PIPE_NAME: &str = r"\\.\pipe\flyclash-helper-service";

    let id = request_id();
    let timestamp = timestamp_secs();
    let payload_json = payload
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(|err| err.to_string())?;

    let mut sign_data = format!("{id}:{timestamp}:{command}");
    if let Some(payload_json) = payload_json.as_deref() {
        sign_data.push(':');
        sign_data.push_str(payload_json);
    }

    let request = json!({
        "id": id,
        "timestamp": timestamp,
        "command": command,
        "signature": hmac_sha256_hex(&secret_key(), &sign_data)
    });
    let mut request = request
        .as_object()
        .cloned()
        .ok_or_else(|| "failed to build helper request".to_string())?;
    if let Some(payload) = payload {
        request.insert("payload".to_string(), payload);
    }

    let mut pipe = OpenOptions::new()
        .read(true)
        .write(true)
        .open(PIPE_NAME)
        .map_err(|err| format!("无法连接到 FlyClash Helper IPC: {err}"))?;

    let message = serde_json::to_string(&Value::Object(request)).map_err(|err| err.to_string())?;
    pipe.write_all(message.as_bytes())
        .and_then(|_| pipe.write_all(b"\n"))
        .and_then(|_| pipe.flush())
        .map_err(|err| err.to_string())?;

    let mut line = String::new();
    BufReader::new(pipe)
        .read_line(&mut line)
        .map_err(|err| err.to_string())?;
    if line.trim().is_empty() {
        return Err("FlyClash Helper IPC 返回空响应".to_string());
    }

    parse_response(line.trim(), &id)
}

#[cfg(not(target_os = "windows"))]
fn send_request(_command: &str, _payload: Option<Value>) -> Result<HelperResponse, String> {
    Err("当前平台不支持 FlyClash Helper 服务".to_string())
}

fn response_data(response: HelperResponse) -> Result<Value, String> {
    if response.success {
        Ok(response.data.unwrap_or_else(|| json!({})))
    } else {
        Err(response
            .error
            .unwrap_or_else(|| "FlyClash Helper IPC 请求失败".to_string()))
    }
}

pub fn get_status() -> Result<HelperCoreStatus, String> {
    let data = response_data(send_request("get_status", None)?)?;
    Ok(HelperCoreStatus {
        running: data
            .get("running")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        pid: data
            .get("pid")
            .and_then(Value::as_u64)
            .and_then(|pid| u32::try_from(pid).ok())
            .filter(|pid| *pid > 0),
    })
}

pub fn get_version() -> Result<Value, String> {
    response_data(send_request("get_version", None)?)
}

pub fn helper_ipc_snapshot(service_running: bool) -> HelperIpcSnapshot {
    if !service_running {
        return HelperIpcSnapshot::default();
    }

    let mut snapshot = HelperIpcSnapshot::default();
    match get_status() {
        Ok(status) => snapshot.status = Some(status),
        Err(error) => snapshot.status_error = Some(error),
    }
    match get_version() {
        Ok(version) => snapshot.version = Some(version),
        Err(error) => snapshot.version_error = Some(error),
    }
    snapshot
}

pub fn start_core(
    bin_path: &Path,
    config_dir: &Path,
    config_file: &Path,
    log_file: Option<&Path>,
    ext_ctl_pipe: Option<&str>,
) -> Result<Value, String> {
    let mut payload = json!({
        "bin_path": bin_path.to_string_lossy(),
        "config_dir": config_dir.to_string_lossy(),
        "config_file": config_file.to_string_lossy()
    });

    if let Some(log_file) = log_file {
        payload["log_file"] = Value::String(log_file.to_string_lossy().to_string());
    }
    if let Some(ext_ctl_pipe) = ext_ctl_pipe.filter(|value| !value.trim().is_empty()) {
        payload["ext_ctl_pipe"] = Value::String(ext_ctl_pipe.to_string());
    }

    response_data(send_request("start_core", Some(payload))?)
}

pub fn stop_core() -> Result<Value, String> {
    response_data(send_request("stop_core", None)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn signed_response(id: &str, success: bool, data: Option<&str>, error: Option<&str>) -> String {
        let mut sign_data = format!("{id}:{success}");
        if let Some(data) = data {
            sign_data.push(':');
            sign_data.push_str(data);
        }
        if let Some(error) = error.filter(|value| !value.is_empty()) {
            sign_data.push(':');
            sign_data.push_str(error);
        }
        let signature = hmac_sha256_hex(&secret_key(), &sign_data);
        let mut response = json!({
            "id": id,
            "success": success,
            "signature": signature
        });
        if let Some(data) = data {
            response["data"] = serde_json::from_str::<Value>(data).unwrap();
        }
        if let Some(error) = error {
            response["error"] = Value::String(error.to_string());
        }
        response.to_string()
    }

    #[test]
    fn parses_helper_error_response_signed_with_error_text() {
        let raw = signed_response("abc123", false, None, Some("core path rejected"));
        let response = parse_response(&raw, "abc123").expect("signed error response should parse");

        assert!(!response.success);
        assert_eq!(response.error.as_deref(), Some("core path rejected"));
    }

    #[test]
    fn rejects_helper_response_with_wrong_id() {
        let raw = signed_response("abc123", true, Some(r#"{"running":true,"pid":42}"#), None);
        let error = parse_response(&raw, "def456").expect_err("wrong response id must fail");

        assert!(error.contains("响应 ID 不匹配"));
    }

    #[test]
    fn helper_ipc_snapshot_skips_ipc_when_service_is_stopped() {
        let snapshot = helper_ipc_snapshot(false);

        assert!(!snapshot.ipc_available());
        assert!(!snapshot.core_running());
        assert_eq!(snapshot.core_pid(), None);
        assert!(snapshot.status_error.is_none());
        assert!(snapshot.version_error.is_none());
    }

    #[test]
    fn helper_service_status_uses_snapshot_fields() {
        let helper = HelperIpcSnapshot {
            status: Some(HelperCoreStatus {
                running: true,
                pid: Some(4242),
            }),
            version: Some(json!({ "version": "1.2.3" })),
            ..Default::default()
        };

        let payload =
            helper_service_status_payload(HelperServiceFlags::new(true, true, None), helper);

        assert_eq!(payload["installed"], json!(true));
        assert_eq!(payload["running"], json!(true));
        assert_eq!(payload["mode"], json!("service"));
        assert_eq!(payload["ipcAvailable"], json!(true));
        assert_eq!(payload["serviceReady"], json!(true));
        assert_eq!(payload["readiness"], json!("ready"));
        assert_eq!(payload["coreRunning"], json!(true));
        assert_eq!(payload["corePid"], json!(4242));
        assert_eq!(payload["version"]["version"], json!("1.2.3"));
    }

    #[test]
    fn helper_service_status_reports_service_query_error_without_ipc() {
        let payload = helper_service_status_payload(
            HelperServiceFlags::new(false, false, Some("service missing".to_string())),
            HelperIpcSnapshot::default(),
        );

        assert_eq!(payload["installed"], json!(false));
        assert_eq!(payload["running"], json!(false));
        assert_eq!(payload["mode"], json!("service"));
        assert_eq!(payload["ipcAvailable"], json!(false));
        assert_eq!(payload["serviceReady"], json!(false));
        assert_eq!(payload["readiness"], json!("not-installed"));
        assert_eq!(payload["coreRunning"], json!(false));
        assert_eq!(payload["corePid"], Value::Null);
        assert_eq!(payload["error"], json!("service missing"));
    }

    #[test]
    fn helper_service_readiness_marks_running_without_ipc() {
        let payload = helper_service_status_payload(
            HelperServiceFlags::new(true, true, None),
            HelperIpcSnapshot {
                status_error: Some("pipe missing".to_string()),
                ..Default::default()
            },
        );

        assert_eq!(payload["running"], json!(true));
        assert_eq!(payload["ipcAvailable"], json!(false));
        assert_eq!(payload["serviceReady"], json!(false));
        assert_eq!(payload["readiness"], json!("running-no-ipc"));
    }

    #[test]
    fn helper_ensure_plan_repairs_running_without_ipc() {
        assert_eq!(
            helper_ensure_plan(true, true, false),
            Ok(HelperEnsureOutcome::RepairedIpc)
        );
        assert_eq!(
            helper_ensure_plan(true, true, true),
            Ok(HelperEnsureOutcome::AlreadyReady)
        );
        assert_eq!(
            helper_ensure_plan(true, false, false),
            Ok(HelperEnsureOutcome::Started)
        );
        assert_eq!(
            helper_ensure_plan(false, false, false),
            Err("not-installed")
        );
    }

    #[test]
    fn helper_service_action_payload_reports_service_ready_and_repair() {
        let helper = HelperIpcSnapshot {
            status: Some(HelperCoreStatus {
                running: true,
                pid: Some(7),
            }),
            version: Some(json!({ "version": "1.0.2" })),
            ..Default::default()
        };
        let payload = helper_service_action_payload_with_repaired("fixed", helper, true, true);

        assert_eq!(payload["message"], json!("fixed"));
        assert_eq!(payload["ipcAvailable"], json!(true));
        assert_eq!(payload["serviceReady"], json!(true));
        assert_eq!(payload["repaired"], json!(true));
        assert_eq!(payload["corePid"], json!(7));
    }

    #[test]
    fn windows_permission_status_distinguishes_service_ready_from_permission() {
        let helper = HelperIpcSnapshot {
            version: Some(json!({ "version": "ready" })),
            ..Default::default()
        };
        let payload = windows_permission_status_payload(
            "service",
            false,
            false,
            HelperServiceFlags::new(true, true, None),
            helper,
        );

        assert_eq!(payload["hasPermission"], json!(true));
        assert_eq!(payload["serviceReady"], json!(true));
        assert_eq!(payload["ipcAvailable"], json!(true));
        assert_eq!(payload["details"]["serviceInstalled"], json!(true));
        assert_eq!(payload["details"]["serviceRunning"], json!(true));
        assert_eq!(
            payload["details"]["helperVersion"]["version"],
            json!("ready")
        );
    }

    #[test]
    fn windows_permission_status_requires_ready_service_in_service_mode() {
        let payload = windows_permission_status_payload(
            "service",
            false,
            false,
            HelperServiceFlags::new(true, false, None),
            HelperIpcSnapshot::default(),
        );

        assert_eq!(payload["hasPermission"], json!(false));
        assert_eq!(payload["serviceReady"], json!(false));
        assert_eq!(payload["details"]["serviceInstalled"], json!(true));
        assert_eq!(payload["details"]["serviceRunning"], json!(false));
    }

    #[test]
    fn helper_service_action_payload_keeps_install_response_shape() {
        let helper = HelperIpcSnapshot {
            status_error: Some("status unavailable".to_string()),
            ..Default::default()
        };
        let payload = helper_service_action_payload("started", helper, false);

        assert_eq!(payload["message"], json!("started"));
        assert_eq!(payload["mode"], json!("service"));
        assert_eq!(payload["ipcAvailable"], json!(false));
        assert_eq!(payload["needRestart"], json!(false));
        assert_eq!(payload["coreRunning"], json!(false));
        assert_eq!(payload["helperStatusError"], json!("status unavailable"));
    }

    #[test]
    fn helper_service_flags_parse_running_query_output() {
        let flags = helper_service_flags_from_query_result(Ok(
            "STATE              : 4  RUNNING".to_string()
        ));

        assert!(flags.installed);
        assert!(flags.running);
        assert!(flags.error.is_none());
    }

    #[test]
    fn helper_service_flags_parse_stopped_query_output() {
        let flags = helper_service_flags_from_query_result(Ok(
            "STATE              : 1  STOPPED".to_string()
        ));

        assert!(flags.installed);
        assert!(!flags.running);
        assert!(flags.error.is_none());
    }

    #[test]
    fn helper_service_flags_preserve_query_error() {
        let flags = helper_service_flags_from_query_result(Err(
            "The specified service does not exist".to_string(),
        ));

        assert!(!flags.installed);
        assert!(!flags.running);
        assert_eq!(
            flags.error.as_deref(),
            Some("The specified service does not exist")
        );
    }

    #[test]
    fn powershell_quote_escapes_single_quotes() {
        assert_eq!(
            powershell_quote(r"C:\Fly'Clash\helper.exe"),
            r"'C:\Fly''Clash\helper.exe'"
        );
    }

    #[test]
    fn helper_install_elevated_command_uses_runas_install() {
        let command = helper_elevated_command(
            Path::new(r"C:\Program Files\FlyClash\flyclash-helper.exe"),
            "-install",
        );

        assert!(command.contains(
            "Start-Process -FilePath 'C:\\Program Files\\FlyClash\\flyclash-helper.exe'"
        ));
        assert!(command.contains("-ArgumentList '-install'"));
        assert!(command.contains("-Verb RunAs"));
        assert!(command.contains("-Wait"));
    }

    #[test]
    fn looks_like_access_denied_matches_sc_openservice_code_5() {
        assert!(looks_like_access_denied(
            "[SC] OpenService FAILED 5:\nAccess is denied."
        ));
        assert!(looks_like_access_denied(
            "[SC] OpenService 失败 5:\n拒绝访问。"
        ));
        assert!(looks_like_access_denied("Access is denied."));
        assert!(!looks_like_access_denied(
            "The specified service does not exist"
        ));
    }
}
