use serde_json::{json, Value};
use tauri::AppHandle;

use crate::{
    platform::open_file_location, profiles::materialize_config_for_open, resources::find_tool_path,
};

type CompatResult = Result<Value, String>;

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

/// 校验交给系统默认浏览器打开的链接。
///
/// `open::that` 在 Windows 上等价于 ShellExecute，若不加限制，任意本地可执行文件
/// 路径、UNC 路径（\\host\share\payload.exe）或自定义协议都会被直接启动。此处只
/// 放行 http/https，其余一律拒绝。
fn validate_external_url(target: &str) -> Result<String, String> {
    let url = reqwest::Url::parse(target).map_err(|_| "链接格式无效".to_string())?;
    match url.scheme() {
        "http" | "https" => {}
        _ => return Err("仅支持打开 http/https 链接".to_string()),
    }
    if url.host_str().unwrap_or_default().is_empty() {
        return Err("链接缺少主机名".to_string());
    }
    Ok(url.to_string())
}

fn is_yaml_path(path: &std::path::Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| {
            let lower = ext.to_ascii_lowercase();
            lower == "yaml" || lower == "yml"
        })
        .unwrap_or(false)
}

fn read_local_text_file(path: &str) -> CompatResult {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Ok(json!({ "success": false, "error": "缺少文件路径" }));
    }
    let file_path = std::path::PathBuf::from(trimmed);
    if !file_path.is_absolute() {
        return Ok(json!({ "success": false, "error": "仅支持绝对路径文件" }));
    }
    if !file_path.exists() {
        return Ok(json!({ "success": false, "error": "文件不存在" }));
    }
    if !file_path.is_file() {
        return Ok(json!({ "success": false, "error": "路径不是文件" }));
    }
    if !is_yaml_path(&file_path) {
        return Ok(json!({ "success": false, "error": "仅支持 YAML 配置文件" }));
    }

    let content = std::fs::read_to_string(&file_path).map_err(|err| err.to_string())?;
    if content.trim().is_empty() {
        return Ok(json!({ "success": false, "error": "文件内容为空" }));
    }

    let file_name = file_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("config.yaml")
        .to_string();
    let stem = file_path
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or("config")
        .to_string();

    Ok(success(json!({
        "path": file_path.to_string_lossy(),
        "fileName": file_name,
        "name": stem,
        "content": content
    })))
}

fn dispatch_compat_call(app: &AppHandle, method: &str, args: &[Value]) -> CompatResult {
    match method {
        "readLocalTextFile" => {
            let Some(path) = arg_string(args, 0) else {
                return Ok(json!({ "success": false, "error": "缺少文件路径" }));
            };
            read_local_text_file(&path)
        }
        "openExternal" | "openFile" | "openFileInDefaultApp" => {
            let Some(target) = arg_string(args, 0)
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
            else {
                return Ok(json!({
                    "success": false,
                    "error": if method == "openExternal" { "缺少要打开的链接" } else { "缺少要打开的文件路径" }
                }));
            };
            if method == "openExternal" {
                let url = match validate_external_url(&target) {
                    Ok(url) => url,
                    Err(error) => return Ok(json!({ "success": false, "error": error })),
                };
                open::that(url).map_err(|err| err.to_string())?;
            } else {
                let path = materialize_config_for_open(app, &target)?;
                open::that(path).map_err(|err| err.to_string())?;
            }
            Ok(success(json!({})))
        }
        "openFileLocation" => {
            let Some(target) = arg_string(args, 0)
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
            else {
                return Ok(json!({ "success": false, "error": "缺少要定位的文件路径" }));
            };
            let path = materialize_config_for_open(app, &target)?;
            open_file_location(&path)?;
            Ok(success(json!({})))
        }
        "openToolsApp" | "open-tools-app" => {
            let tool_name = arg_string(args, 0).unwrap_or_default();
            let Some(tool_path) = find_tool_path(app, &tool_name)? else {
                return Ok(json!({
                    "success": false,
                    "error": "Tool file does not exist"
                }));
            };
            open::that(tool_path).map_err(|err| err.to_string())?;
            Ok(success(json!({})))
        }
        _ => Err(format!("Unsupported open method: {method}")),
    }
}

pub(crate) async fn handle_compat_call(
    app: &AppHandle,
    method: &str,
    args: &[Value],
) -> Option<CompatResult> {
    if !matches!(
        method,
        "openExternal"
            | "openFile"
            | "openFileInDefaultApp"
            | "openFileLocation"
            | "openToolsApp"
            | "open-tools-app"
            | "readLocalTextFile"
    ) {
        return None;
    }

    Some(dispatch_compat_call(app, method, args))
}

#[cfg(test)]
mod tests {
    use super::validate_external_url;

    #[test]
    fn external_url_allows_http_and_https() {
        assert!(validate_external_url("https://example.test/a").is_ok());
        assert!(validate_external_url("http://example.test").is_ok());
    }

    #[test]
    fn external_url_rejects_executables_and_custom_schemes() {
        for target in [
            r"C:\Windows\System32\calc.exe",
            r"\\attacker.test\share\payload.exe",
            "file:///C:/Windows/System32/calc.exe",
            "ms-msdt:/id",
            "javascript:alert(1)",
            "smb://attacker.test/share",
        ] {
            assert!(
                validate_external_url(target).is_err(),
                "{target} must be rejected"
            );
        }
    }
}
