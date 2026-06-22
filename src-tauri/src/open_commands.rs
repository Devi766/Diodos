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

fn dispatch_compat_call(app: &AppHandle, method: &str, args: &[Value]) -> CompatResult {
    match method {
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
                open::that(target).map_err(|err| err.to_string())?;
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
    ) {
        return None;
    }

    Some(dispatch_compat_call(app, method, args))
}
