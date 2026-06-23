use serde::{Deserialize, Serialize};
#[cfg(any(target_os = "windows", test))]
use serde_json::value::RawValue;
use serde_json::{json, Value};
#[cfg(any(target_os = "windows", test))]
use sha2::{Digest, Sha256};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
#[cfg(target_os = "windows")]
use std::time::{SystemTime, UNIX_EPOCH};
#[cfg(any(target_os = "windows", test))]
use std::{env, fs, path::PathBuf};
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

fn command_output(program: &str, args: &[&str]) -> Result<String, String> {
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

fn powershell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn helper_install_elevated_command(helper_path: &Path) -> String {
    format!(
        "Start-Process -FilePath {} -ArgumentList '-install' -Verb RunAs -Wait",
        powershell_quote(&helper_path.to_string_lossy())
    )
}

pub fn install_helper_service(helper_path: &Path, elevated: bool) -> Result<(), String> {
    if !cfg!(target_os = "windows") {
        return Err("当前平台不支持 Windows Helper 服务".to_string());
    }

    if elevated {
        let command = helper_install_elevated_command(helper_path);
        command_output(
            "powershell.exe",
            &[
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                &command,
            ],
        )?;
    } else {
        command_output(&helper_path.to_string_lossy(), &["-install"])?;
    }

    Ok(())
}

pub fn uninstall_helper_service(helper_path: &Path) -> Result<(), String> {
    if !cfg!(target_os = "windows") {
        return Err("当前平台不支持 Windows Helper 服务".to_string());
    }

    command_output(&helper_path.to_string_lossy(), &["-uninstall"])?;
    Ok(())
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
        command_output("sc", &["start", HELPER_SERVICE_NAME])?;
    }

    for _ in 0..30 {
        if get_version().is_ok() {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(200));
    }

    Err("FlyClash Helper 服务已启动，但 IPC 未就绪".to_string())
}

pub fn stop_helper_service() -> Result<String, String> {
    if !cfg!(target_os = "windows") {
        return Err("当前平台不支持 Windows Helper 服务".to_string());
    }

    command_output("sc", &["stop", HELPER_SERVICE_NAME])
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HelperServiceStatus {
    pub installed: bool,
    pub running: bool,
    pub mode: String,
    pub ipc_available: bool,
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
            core_running: false,
            core_pid: None,
            version: None,
            error: None,
            helper_status_error: None,
            helper_version_error: None,
        }
    }

    pub fn from_flags(flags: HelperServiceFlags, helper: HelperIpcSnapshot) -> Self {
        Self {
            installed: flags.installed,
            running: flags.running,
            mode: "service".to_string(),
            ipc_available: helper.ipc_available(),
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
    json!({
        "message": message.into(),
        "mode": "service",
        "ipcAvailable": ipc_available,
        "coreRunning": helper.core_running(),
        "corePid": helper.core_pid(),
        "helperStatusError": helper.status_error,
        "helperVersionError": helper.version_error,
        "version": helper.version,
        "needRestart": false
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
    let has_permission = if mode == "service" {
        flags.installed || is_admin
    } else {
        has_elevate_task || is_admin
    };
    let service_ready = flags.running && helper.ipc_available();

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
    let key_path = env::var_os("ProgramData")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\ProgramData"))
        .join("FlyClash")
        .join("service-key");

    if let Ok(key) = fs::read(key_path) {
        if key.len() == 32 {
            return key;
        }
    }

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
        assert_eq!(payload["coreRunning"], json!(false));
        assert_eq!(payload["corePid"], Value::Null);
        assert_eq!(payload["error"], json!("service missing"));
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
        let command = helper_install_elevated_command(Path::new(
            r"C:\Program Files\FlyClash\flyclash-helper.exe",
        ));

        assert!(command.contains(
            "Start-Process -FilePath 'C:\\Program Files\\FlyClash\\flyclash-helper.exe'"
        ));
        assert!(command.contains("-ArgumentList '-install'"));
        assert!(command.contains("-Verb RunAs"));
        assert!(command.contains("-Wait"));
    }
}
