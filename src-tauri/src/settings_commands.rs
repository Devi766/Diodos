use serde_json::{json, Value};
use tauri::AppHandle;

use crate::{
    profiles::allowed_subscription_ua_key,
    storage::{set_setting, setting},
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
        "getSetting" => {
            let key = arg_string(args, 0).unwrap_or_default();
            if key.trim().is_empty() {
                return Ok(json!({
                    "success": false,
                    "value": args.get(1).cloned().unwrap_or(Value::Null),
                    "error": "设置项名称不能为空"
                }));
            }
            let fallback = args.get(1).cloned().unwrap_or(Value::Null);
            Ok(success(json!({ "value": setting(app, &key, fallback)? })))
        }
        "setSetting" => {
            let key = arg_string(args, 0).unwrap_or_default();
            if key.trim().is_empty() {
                return Ok(json!({ "success": false, "error": "设置项名称不能为空" }));
            }
            let value = args.get(1).cloned().unwrap_or(Value::Null);
            set_setting(app, &key, value)?;
            Ok(success(json!({})))
        }
        "getFavoriteNodes" | "get-favorite-nodes" => Ok(success(json!({
            "nodes": setting(app, "favoriteNodes", json!([]))?
        }))),
        "saveFavoriteNodes" | "save-favorite-nodes" => {
            set_setting(
                app,
                "favoriteNodes",
                args.first().cloned().unwrap_or_else(|| json!([])),
            )?;
            Ok(success(json!({})))
        }
        "getCollapsedGroups" | "get-collapsed-groups" => Ok(success(json!({
            "groups": setting(app, "collapsedGroups", json!([]))?
        }))),
        "saveCollapsedGroups" | "save-collapsed-groups" => {
            set_setting(
                app,
                "collapsedGroups",
                args.first().cloned().unwrap_or_else(|| json!([])),
            )?;
            Ok(success(json!({})))
        }
        "saveUASettings" => {
            let ua = arg_string(args, 0).unwrap_or_default();
            let ua = ua.trim();
            if ua.is_empty() {
                return Ok(json!({ "success": false, "error": "Invalid User-Agent option" }));
            }
            if !allowed_subscription_ua_key(ua) {
                return Ok(json!({ "success": false, "error": "Unsupported User-Agent option" }));
            }
            set_setting(app, "subscription-ua", json!(ua))?;
            Ok(success(json!({ "message": "User-Agent updated" })))
        }
        _ => Err(format!("Unsupported settings method: {method}")),
    }
}

pub(crate) async fn handle_compat_call(
    app: &AppHandle,
    method: &str,
    args: &[Value],
) -> Option<CompatResult> {
    if !matches!(
        method,
        "getSetting"
            | "setSetting"
            | "getFavoriteNodes"
            | "get-favorite-nodes"
            | "saveFavoriteNodes"
            | "save-favorite-nodes"
            | "getCollapsedGroups"
            | "get-collapsed-groups"
            | "saveCollapsedGroups"
            | "save-collapsed-groups"
            | "saveUASettings"
    ) {
        return None;
    }

    Some(dispatch_compat_call(app, method, args))
}
