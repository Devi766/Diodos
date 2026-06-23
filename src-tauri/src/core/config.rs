use serde::Serialize;
use serde_json::Value;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::{
    fmt, fs,
    path::{Path, PathBuf},
    process::{Command, ExitStatus, Stdio},
    thread,
    time::{Duration, Instant},
};

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

const MUST_OVERRIDE_FIELDS: &[&str] = &[
    "mixed-port",
    "allow-lan",
    "ipv6",
    "log-level",
    "find-process-mode",
];

const PRESERVE_ARRAY_FIELDS: &[&str] = &["proxies", "proxy-groups", "rules"];

const VALIDATION_TIMEOUT: Duration = Duration::from_secs(15);
const VALIDATION_ERROR_KEYWORDS: &[&str] = &["FATA", "fatal", "Parse config error", "level=fatal"];
pub const RUNTIME_CONFIG_FILE_NAME: &str = "work-config.yaml";
pub const RUNTIME_CONFIG_CHECK_FILE_NAME: &str = "work-config.check.yaml";

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ConfigValidationFailureKind {
    InvalidConfig,
    Timeout,
    ProcessFailed,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConfigValidationError {
    pub kind: ConfigValidationFailureKind,
    pub message: String,
}

impl ConfigValidationError {
    fn invalid_config(message: impl Into<String>) -> Self {
        Self {
            kind: ConfigValidationFailureKind::InvalidConfig,
            message: format!("配置验证失败: {}", message.into()),
        }
    }

    fn timeout(seconds: u64) -> Self {
        Self {
            kind: ConfigValidationFailureKind::Timeout,
            message: format!("配置验证超时，超过 {seconds} 秒未完成"),
        }
    }

    fn process_failed(message: impl Into<String>) -> Self {
        Self {
            kind: ConfigValidationFailureKind::ProcessFailed,
            message: message.into(),
        }
    }
}

impl fmt::Display for ConfigValidationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RuntimeConfigPrepareError {
    PrepareFailed(String),
    ValidationFailed(ConfigValidationError),
}

impl RuntimeConfigPrepareError {
    pub fn prepare_failed(error: impl Into<String>) -> Self {
        Self::PrepareFailed(error.into())
    }

    pub fn validation_failed(error: ConfigValidationError) -> Self {
        Self::ValidationFailed(error)
    }

    pub fn message(&self) -> &str {
        match self {
            Self::PrepareFailed(message) => message,
            Self::ValidationFailed(error) => &error.message,
        }
    }

    pub fn error_kind(&self) -> &'static str {
        match self {
            Self::PrepareFailed(_) => "prepare-failed",
            Self::ValidationFailed(error) => match error.kind {
                ConfigValidationFailureKind::InvalidConfig => "invalid-config",
                ConfigValidationFailureKind::Timeout => "timeout",
                ConfigValidationFailureKind::ProcessFailed => "process-failed",
            },
        }
    }

    pub fn validation_payload(&self) -> Option<Value> {
        match self {
            Self::ValidationFailed(error) => serde_json::to_value(error).ok(),
            Self::PrepareFailed(_) => None,
        }
    }
}

impl fmt::Display for RuntimeConfigPrepareError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.message())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeConfigPaths {
    pub check_path: PathBuf,
    pub runtime_path: PathBuf,
}

pub fn runtime_config_paths(work_dir: &Path) -> RuntimeConfigPaths {
    RuntimeConfigPaths {
        check_path: work_dir.join(RUNTIME_CONFIG_CHECK_FILE_NAME),
        runtime_path: work_dir.join(RUNTIME_CONFIG_FILE_NAME),
    }
}

pub fn parse_user_config(content: &str) -> Result<Value, String> {
    let yaml = serde_yaml::from_str::<serde_yaml::Value>(content)
        .map_err(|err| format!("配置 YAML 解析失败: {err}"))?;
    let config = serde_json::to_value(yaml).map_err(|err| err.to_string())?;
    if config.is_object() {
        Ok(config)
    } else {
        Err("配置文件根节点必须是 YAML 对象".to_string())
    }
}

pub fn merge_runtime_settings(config: &mut Value, runtime_settings: &Value) {
    let (Some(config_object), Some(settings_object)) =
        (config.as_object_mut(), runtime_settings.as_object())
    else {
        *config = runtime_settings.clone();
        return;
    };

    for (key, setting_value) in settings_object {
        if key == "external-controller" || key == "secret" {
            if setting_value
                .as_str()
                .map(|value| !value.is_empty())
                .unwrap_or(false)
            {
                config_object.insert(key.clone(), setting_value.clone());
            } else {
                config_object.remove(key);
            }
            continue;
        }

        if MUST_OVERRIDE_FIELDS.contains(&key.as_str()) {
            config_object.insert(key.clone(), setting_value.clone());
            continue;
        }

        if setting_value.is_object() {
            if let Some(config_value) = config_object.get_mut(key) {
                merge_runtime_settings(config_value, setting_value);
            } else {
                config_object.insert(key.clone(), setting_value.clone());
            }
            continue;
        }

        if setting_value.is_array() {
            let preserve_existing = PRESERVE_ARRAY_FIELDS.contains(&key.as_str())
                && config_object.get(key).map(Value::is_array).unwrap_or(false);
            if !preserve_existing {
                config_object.insert(key.clone(), setting_value.clone());
            }
            continue;
        }

        config_object.insert(key.clone(), setting_value.clone());
    }
}

pub fn runtime_config_content(config: &Value) -> Result<String, String> {
    let yaml = serde_yaml::to_value(config).map_err(|err| err.to_string())?;
    serde_yaml::to_string(&yaml).map_err(|err| err.to_string())
}

pub fn write_runtime_config(runtime_path: &Path, config: &Value) -> Result<PathBuf, String> {
    if let Some(parent) = runtime_path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let content = runtime_config_content(config)?;
    fs::write(runtime_path, content).map_err(|err| err.to_string())?;
    Ok(runtime_path.to_path_buf())
}

pub fn build_runtime_config<F>(
    content: &str,
    runtime_settings: &Value,
    apply_overrides: F,
) -> Result<Value, RuntimeConfigPrepareError>
where
    F: FnOnce(Value) -> Result<Value, String>,
{
    let mut config =
        parse_user_config(content).map_err(RuntimeConfigPrepareError::prepare_failed)?;
    config = apply_overrides(config).map_err(RuntimeConfigPrepareError::prepare_failed)?;
    merge_runtime_settings(&mut config, runtime_settings);
    Ok(config)
}

pub fn prepare_validated_runtime_config<F>(
    content: &str,
    runtime_settings: &Value,
    executable: &Path,
    work_dir: &Path,
    apply_overrides: F,
) -> Result<PathBuf, RuntimeConfigPrepareError>
where
    F: FnOnce(Value) -> Result<Value, String>,
{
    let config = build_runtime_config(content, runtime_settings, apply_overrides)?;
    write_validated_runtime_config(executable, work_dir, &config)
}

pub fn write_validated_runtime_config(
    executable: &Path,
    work_dir: &Path,
    config: &Value,
) -> Result<PathBuf, RuntimeConfigPrepareError> {
    let paths = runtime_config_paths(work_dir);
    write_runtime_config(&paths.check_path, config)
        .map_err(RuntimeConfigPrepareError::prepare_failed)?;

    if let Err(error) = validate_runtime_config(executable, work_dir, &paths.check_path) {
        let _ = fs::remove_file(&paths.check_path);
        return Err(RuntimeConfigPrepareError::validation_failed(error));
    }

    let _ = fs::remove_file(&paths.check_path);
    write_runtime_config(&paths.runtime_path, config)
        .map_err(RuntimeConfigPrepareError::prepare_failed)
}

fn contains_any_keyword(buffer: &[u8], keywords: &[&str]) -> bool {
    keywords.iter().any(|keyword| {
        !keyword.is_empty()
            && buffer
                .windows(keyword.len())
                .any(|item| item == keyword.as_bytes())
    })
}

fn output_text(stdout: &[u8], stderr: &[u8]) -> String {
    let stdout = String::from_utf8_lossy(stdout).trim().to_string();
    if !stdout.is_empty() {
        return stdout;
    }

    let stderr = String::from_utf8_lossy(stderr).trim().to_string();
    if !stderr.is_empty() {
        return stderr;
    }

    "配置验证失败，但内核没有返回错误详情".to_string()
}

pub fn validation_output_result(
    status: ExitStatus,
    stdout: &[u8],
    stderr: &[u8],
) -> Result<(), ConfigValidationError> {
    let has_error = !status.success() || contains_any_keyword(stderr, VALIDATION_ERROR_KEYWORDS);
    if has_error {
        return Err(ConfigValidationError::invalid_config(output_text(
            stdout, stderr,
        )));
    }
    Ok(())
}

pub fn validate_runtime_config(
    executable: &Path,
    work_dir: &Path,
    runtime_config: &Path,
) -> Result<(), ConfigValidationError> {
    let mut command = Command::new(executable);
    command
        .arg("-t")
        .arg("-d")
        .arg(work_dir)
        .arg("-f")
        .arg(runtime_config)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);

    let mut child = command.spawn().map_err(|err| {
        ConfigValidationError::process_failed(format!("启动内核配置验证失败: {err}"))
    })?;

    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() < VALIDATION_TIMEOUT => {
                thread::sleep(Duration::from_millis(50));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(ConfigValidationError::timeout(VALIDATION_TIMEOUT.as_secs()));
            }
            Err(err) => {
                return Err(ConfigValidationError::process_failed(format!(
                    "等待内核配置验证失败: {err}"
                )));
            }
        }
    }

    let output = child.wait_with_output().map_err(|err| {
        ConfigValidationError::process_failed(format!("读取内核配置验证结果失败: {err}"))
    })?;
    validation_output_result(output.status, &output.stdout, &output.stderr)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::{
        process::Command,
        time::{SystemTime, UNIX_EPOCH},
    };

    fn unique_temp_work_dir(name: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("flyclash-{name}-{}-{stamp}", std::process::id()))
    }

    #[test]
    fn parse_user_config_rejects_invalid_or_non_object_yaml() {
        assert!(parse_user_config("proxies: [").is_err());
        assert!(parse_user_config("- item").is_err());
        assert!(parse_user_config("proxies: []").is_ok());
    }

    #[test]
    fn merge_runtime_settings_preserves_rule_arrays_but_overrides_kernel_fields() {
        let mut config = json!({
            "mixed-port": 7890,
            "rules": ["MATCH,DIRECT"],
            "proxy-groups": [{ "name": "Proxy" }],
            "dns": { "enable": false, "nameserver": ["1.1.1.1"] }
        });
        let settings = json!({
            "mixed-port": 7897,
            "rules": ["MATCH,Proxy"],
            "proxy-groups": [],
            "dns": { "enable": true },
            "allow-lan": true
        });

        merge_runtime_settings(&mut config, &settings);

        assert_eq!(config["mixed-port"], json!(7897));
        assert_eq!(config["allow-lan"], json!(true));
        assert_eq!(config["rules"], json!(["MATCH,DIRECT"]));
        assert_eq!(config["proxy-groups"], json!([{ "name": "Proxy" }]));
        assert_eq!(config["dns"]["enable"], json!(true));
        assert_eq!(config["dns"]["nameserver"], json!(["1.1.1.1"]));
    }

    #[test]
    fn merge_runtime_settings_removes_empty_controller_and_secret() {
        let mut config = json!({
            "external-controller": "127.0.0.1:9090",
            "secret": "token"
        });
        let settings = json!({
            "external-controller": "",
            "secret": ""
        });

        merge_runtime_settings(&mut config, &settings);

        assert!(config.get("external-controller").is_none());
        assert!(config.get("secret").is_none());
    }

    #[test]
    fn build_runtime_config_applies_overrides_before_runtime_settings() {
        let runtime_settings = json!({
            "mixed-port": 7897,
            "allow-lan": true,
            "rules": ["MATCH,DIRECT"]
        });

        let config = build_runtime_config(
            "mixed-port: 7890\nrules:\n  - DOMAIN,example.com,Proxy\n",
            &runtime_settings,
            |mut config| {
                config["rules"] = json!(["DOMAIN,override.test,Proxy"]);
                config["proxy-groups"] = json!([{ "name": "Proxy" }]);
                Ok(config)
            },
        )
        .unwrap();

        assert_eq!(config["mixed-port"], json!(7897));
        assert_eq!(config["allow-lan"], json!(true));
        assert_eq!(config["rules"], json!(["DOMAIN,override.test,Proxy"]));
        assert_eq!(config["proxy-groups"], json!([{ "name": "Proxy" }]));
    }

    #[test]
    fn build_runtime_config_wraps_override_failure() {
        let error = build_runtime_config("proxies: []", &json!({}), |_| {
            Err("override failed".to_string())
        })
        .unwrap_err();

        assert!(matches!(error, RuntimeConfigPrepareError::PrepareFailed(_)));
        assert_eq!(error.message(), "override failed");
    }

    #[test]
    fn validation_output_result_uses_exit_status_and_fatal_stderr() {
        let success = Command::new(std::env::current_exe().unwrap())
            .arg("--help")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap();
        assert!(validation_output_result(success, b"", b"").is_ok());
        let error = validation_output_result(success, b"", b"level=fatal bad config").unwrap_err();
        assert_eq!(error.kind, ConfigValidationFailureKind::InvalidConfig);
        assert!(error.message.contains("level=fatal bad config"));
    }

    #[test]
    fn runtime_config_paths_use_candidate_then_final_names() {
        let paths = runtime_config_paths(Path::new("work"));

        assert_eq!(
            paths
                .check_path
                .file_name()
                .and_then(|value| value.to_str()),
            Some(RUNTIME_CONFIG_CHECK_FILE_NAME)
        );
        assert_eq!(
            paths
                .runtime_path
                .file_name()
                .and_then(|value| value.to_str()),
            Some(RUNTIME_CONFIG_FILE_NAME)
        );
    }

    #[test]
    fn write_validated_runtime_config_removes_candidate_on_validation_failure() {
        let work_dir = unique_temp_work_dir("runtime-config-validation");
        let executable = std::env::current_exe().unwrap();
        let config = json!({ "mixed-port": 7897 });

        let result = write_validated_runtime_config(&executable, &work_dir, &config);
        let paths = runtime_config_paths(&work_dir);

        assert!(matches!(
            result,
            Err(RuntimeConfigPrepareError::ValidationFailed(_))
        ));
        assert!(!paths.check_path.exists());
        assert!(!paths.runtime_path.exists());

        let _ = std::fs::remove_dir_all(work_dir);
    }
}
