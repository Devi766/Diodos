use boa_engine::{Context as JsContext, Source};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use tauri::AppHandle;

use crate::storage::{db, decrypt_text, encrypt_text};

type CompatResult = Result<CompatOutcome, String>;

#[derive(Clone, Copy, PartialEq, Eq)]
enum RuntimeReload {
    None,
    Attach,
    SuccessPayload,
}

pub(crate) struct CompatOutcome {
    value: Value,
    runtime_reload: RuntimeReload,
}

impl CompatOutcome {
    fn ready(value: Value) -> Self {
        Self {
            value,
            runtime_reload: RuntimeReload::None,
        }
    }

    fn attach_reload(value: Value) -> Self {
        Self {
            value,
            runtime_reload: RuntimeReload::Attach,
        }
    }

    fn success_reload_payload() -> Self {
        Self {
            value: Value::Null,
            runtime_reload: RuntimeReload::SuccessPayload,
        }
    }

    pub(crate) fn requires_runtime_reload(&self) -> bool {
        self.runtime_reload != RuntimeReload::None
    }

    pub(crate) fn into_response(self, runtime_reload: Option<Value>) -> Value {
        match self.runtime_reload {
            RuntimeReload::None => self.value,
            RuntimeReload::Attach => attach_runtime_reload(
                self.value,
                runtime_reload.unwrap_or_else(default_skipped_reload),
            ),
            RuntimeReload::SuccessPayload => success(json!({
                "runtimeReload": runtime_reload.unwrap_or_else(default_skipped_reload)
            })),
        }
    }
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

fn success(value: Value) -> Value {
    match value {
        Value::Object(mut object) => {
            object.entry("success").or_insert(Value::Bool(true));
            Value::Object(object)
        }
        other => json!({ "success": true, "value": other }),
    }
}

fn default_skipped_reload() -> Value {
    json!({
        "reloaded": false,
        "skipped": true,
        "reason": "not-requested"
    })
}

fn arg_string(args: &[Value], index: usize) -> Option<String> {
    args.get(index)
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

fn attach_runtime_reload(mut result: Value, runtime_reload: Value) -> Value {
    if let Some(object) = result.as_object_mut() {
        object.insert("runtimeReload".to_string(), runtime_reload);
        result
    } else {
        success(json!({ "runtimeReload": runtime_reload }))
    }
}

pub(crate) fn all_overrides(app: &AppHandle) -> Result<Vec<Value>, String> {
    let conn = db(app)?;
    let mut stmt = conn
        .prepare("SELECT item_json FROM overrides ORDER BY sort_order ASC, created_at ASC")
        .map_err(|err| err.to_string())?;
    let items = stmt
        .query_map([], |row| {
            let raw: String = row.get(0)?;
            Ok(serde_json::from_str::<Value>(&raw).unwrap_or(Value::Null))
        })
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;
    Ok(items)
}

fn save_override_item(app: &AppHandle, item: &Value, content: Option<&str>) -> Result<(), String> {
    let id = item
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| "missing override id".to_string())?;
    let order = db(app)?
        .query_row("SELECT COUNT(*) FROM overrides", [], |row| {
            row.get::<_, i64>(0)
        })
        .unwrap_or(0);
    let encrypted = content.map(|value| encrypt_text(app, value)).transpose()?;
    db(app)?
        .execute(
            r#"
            INSERT INTO overrides (id, item_json, content_cipher, sort_order, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?5)
            ON CONFLICT(id) DO UPDATE SET
              item_json = excluded.item_json,
              content_cipher = COALESCE(excluded.content_cipher, overrides.content_cipher),
              updated_at = excluded.updated_at
            "#,
            params![id, item.to_string(), encrypted, order, now_millis() as i64],
        )
        .map_err(|err| err.to_string())?;
    Ok(())
}

async fn fetch_override_remote_content(url: &str) -> Result<String, String> {
    let url = url.trim();
    if url.is_empty() {
        return Err("远程覆写缺少 URL".to_string());
    }
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("远程覆写 URL 必须以 http:// 或 https:// 开头".to_string());
    }

    let response = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .danger_accept_invalid_certs(true)
        .build()
        .map_err(|err| err.to_string())?
        .get(url)
        .send()
        .await
        .map_err(|err| err.to_string())?;
    let status = response.status();
    let text = response.text().await.map_err(|err| err.to_string())?;
    if !status.is_success() {
        return Err(format!(
            "获取远程覆写失败: HTTP {} {}",
            status.as_u16(),
            text.trim()
        ));
    }
    if text.trim().is_empty() {
        return Err("远程覆写内容为空".to_string());
    }
    Ok(text)
}

async fn override_add(app: &AppHandle, item: Value) -> Result<Value, String> {
    let mut object = item.as_object().cloned().unwrap_or_default();
    let id = object
        .get("id")
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .unwrap_or_else(|| format!("{:x}", now_millis()));
    let now = crate::telemetry::today_key();
    object.insert("id".to_string(), Value::String(id));
    object
        .entry("name".to_string())
        .or_insert_with(|| Value::String("Untitled".to_string()));
    object
        .entry("type".to_string())
        .or_insert_with(|| Value::String("local".to_string()));
    object
        .entry("ext".to_string())
        .or_insert_with(|| Value::String("yaml".to_string()));
    object
        .entry("enabled".to_string())
        .or_insert(Value::Bool(false));
    object
        .entry("global".to_string())
        .or_insert(Value::Bool(false));
    object
        .entry("createdAt".to_string())
        .or_insert_with(|| Value::String(now.clone()));
    object.insert("updatedAt".to_string(), Value::String(now));
    let mut content = object
        .get("file")
        .and_then(Value::as_str)
        .map(ToString::to_string);
    if object.get("type").and_then(Value::as_str) == Some("remote") && content.is_none() {
        let url = object
            .get("url")
            .and_then(Value::as_str)
            .ok_or_else(|| "远程覆写缺少 URL".to_string())?;
        content = Some(fetch_override_remote_content(url).await?);
    }
    object.remove("file");
    let value = Value::Object(object);
    save_override_item(app, &value, content.as_deref())?;
    Ok(value)
}

fn override_update(app: &AppHandle, id: &str, updates: Value) -> Result<Value, String> {
    let mut items = all_overrides(app)?;
    let item = items
        .iter_mut()
        .find(|item| item.get("id").and_then(Value::as_str) == Some(id))
        .ok_or_else(|| "覆写项不存在".to_string())?;
    if let (Some(object), Some(update_map)) = (item.as_object_mut(), updates.as_object()) {
        for (key, value) in update_map {
            object.insert(key.clone(), value.clone());
        }
        object.insert(
            "updatedAt".to_string(),
            Value::String(crate::telemetry::today_key()),
        );
    }
    save_override_item(app, item, None)?;
    Ok(item.clone())
}

pub(crate) fn override_content(app: &AppHandle, id: &str) -> Result<String, String> {
    let row = db(app)?
        .query_row(
            "SELECT item_json, content_cipher FROM overrides WHERE id = ?1",
            params![id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
        )
        .optional()
        .map_err(|err| err.to_string())?
        .ok_or_else(|| "覆写项不存在".to_string())?;
    if let Some(cipher) = row.1 {
        return decrypt_text(app, &cipher);
    }
    let item = serde_json::from_str::<Value>(&row.0).unwrap_or(Value::Null);
    if item.get("type").and_then(Value::as_str) == Some("remote") {
        return Ok(String::new());
    }
    Ok(String::new())
}

fn unwrap_override_key(key: &str) -> String {
    if key.starts_with('<') && key.ends_with('>') && key.len() >= 2 {
        key[1..key.len() - 1].to_string()
    } else {
        key.to_string()
    }
}

fn merge_yaml_override(target: &Value, patch: &Value) -> Value {
    let mut result = target.as_object().cloned().unwrap_or_default();
    let Some(patch_object) = patch.as_object() else {
        return Value::Object(result);
    };

    for (raw_key, value) in patch_object {
        if value.is_object() {
            if let Some(key) = raw_key.strip_suffix('!') {
                result.insert(unwrap_override_key(key), value.clone());
                continue;
            }

            let key = unwrap_override_key(raw_key);
            let base = result
                .get(&key)
                .filter(|value| value.is_object())
                .cloned()
                .unwrap_or_else(|| json!({}));
            result.insert(key, merge_yaml_override(&base, value));
            continue;
        }

        if let Some(values) = value.as_array() {
            if let Some(key) = raw_key.strip_prefix('+') {
                let key = unwrap_override_key(key);
                let mut merged = values.clone();
                if let Some(current) = result.get(&key).and_then(Value::as_array) {
                    merged.extend(current.clone());
                }
                result.insert(key, Value::Array(merged));
                continue;
            }

            if let Some(key) = raw_key.strip_suffix('+') {
                let key = unwrap_override_key(key);
                let mut merged = result
                    .get(&key)
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                merged.extend(values.clone());
                result.insert(key, Value::Array(merged));
                continue;
            }

            result.insert(unwrap_override_key(raw_key), value.clone());
            continue;
        }

        result.insert(raw_key.clone(), value.clone());
    }

    Value::Object(result)
}

fn push_unique_id(ids: &mut Vec<String>, id: String) {
    if !ids.iter().any(|existing| existing == &id) {
        ids.push(id);
    }
}

fn subscription_override_ids(app: &AppHandle, config_path: &str) -> Result<Vec<String>, String> {
    let raw = db(app)?
        .query_row(
            "SELECT overrides FROM subscriptions WHERE file_path = ?1",
            params![config_path],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|err| err.to_string())?
        .unwrap_or_else(|| "[]".to_string());

    let parsed = serde_json::from_str::<Value>(&raw).unwrap_or(Value::Null);
    Ok(parsed
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default())
}

fn run_js_override(config: &Value, script_content: &str, item_name: &str) -> Result<Value, String> {
    let config_json = serde_json::to_string(config).map_err(|err| err.to_string())?;
    let code = format!(
        r#"
globalThis.console = globalThis.console || {{
  log() {{}},
  warn() {{}},
  error() {{}}
}};
{script_content}
const __flyclash_result = main({config_json});
JSON.stringify(__flyclash_result || {config_json});
"#
    );

    let mut context = JsContext::default();
    context
        .runtime_limits_mut()
        .set_loop_iteration_limit(5_000_000);
    context.runtime_limits_mut().set_recursion_limit(1024);

    let result = context
        .eval(Source::from_bytes(code.as_bytes()))
        .map_err(|err| format!("JS覆写执行失败 [{}]: {:?}", item_name, err))?;
    let Some(result_json) = result.as_string() else {
        return Err(format!("JS覆写未返回可序列化配置 [{}]", item_name));
    };
    let result_json = result_json.to_std_string_escaped();
    let parsed = serde_json::from_str::<Value>(&result_json)
        .map_err(|err| format!("JS覆写返回值不是有效JSON [{}]: {}", item_name, err))?;
    if !parsed.is_object() {
        return Err(format!("JS覆写必须返回配置对象 [{}]", item_name));
    }

    Ok(parsed)
}

pub(crate) fn apply_overrides(
    app: &AppHandle,
    config_path: &str,
    config: Value,
) -> Result<Value, String> {
    let enabled_items = all_overrides(app)?
        .into_iter()
        .filter(|item| {
            item.get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        })
        .collect::<Vec<_>>();

    if enabled_items.is_empty() {
        return Ok(config);
    }

    let mut ordered_ids = Vec::new();
    for item in &enabled_items {
        let is_global = item.get("global").and_then(Value::as_bool).unwrap_or(false);
        if !is_global {
            continue;
        }
        if let Some(id) = item.get("id").and_then(Value::as_str) {
            push_unique_id(&mut ordered_ids, id.to_string());
        }
    }

    for id in subscription_override_ids(app, config_path).unwrap_or_default() {
        if enabled_items
            .iter()
            .any(|item| item.get("id").and_then(Value::as_str) == Some(id.as_str()))
        {
            push_unique_id(&mut ordered_ids, id);
        }
    }

    let mut result = config;
    for id in ordered_ids {
        let Some(item) = enabled_items
            .iter()
            .find(|item| item.get("id").and_then(Value::as_str) == Some(id.as_str()))
        else {
            continue;
        };

        let content = match override_content(app, &id) {
            Ok(content) => content,
            Err(_) => continue,
        };
        if content.trim().is_empty() {
            continue;
        }

        match item.get("ext").and_then(Value::as_str) {
            Some("js") => {
                let name = item.get("name").and_then(Value::as_str).unwrap_or(&id);
                match run_js_override(&result, &content, name) {
                    Ok(next) => result = next,
                    Err(error) => eprintln!("{}", error),
                }
            }
            Some("yaml") => {
                let patch_yaml = match serde_yaml::from_str::<serde_yaml::Value>(&content) {
                    Ok(value) => value,
                    Err(_) => continue,
                };
                let patch = serde_json::to_value(patch_yaml).unwrap_or(Value::Null);
                if patch.is_object() {
                    result = merge_yaml_override(&result, &patch);
                }
            }
            _ => continue,
        }
    }

    Ok(result)
}

async fn override_update_remote(app: &AppHandle, id: &str) -> Result<Value, String> {
    let item = all_overrides(app)?
        .into_iter()
        .find(|item| item.get("id").and_then(Value::as_str) == Some(id))
        .ok_or_else(|| "覆写项不存在".to_string())?;
    let url = item
        .get("url")
        .and_then(Value::as_str)
        .ok_or_else(|| "远程覆写缺少 URL".to_string())?;
    let content = fetch_override_remote_content(url).await?;
    save_override_item(app, &item, Some(&content))?;
    Ok(item)
}

async fn dispatch_compat_call(app: &AppHandle, method: &str, args: &[Value]) -> CompatResult {
    match method {
        "getOverrides" | "override:getItems" => {
            Ok(CompatOutcome::ready(json!(all_overrides(app)?)))
        }
        "addOverride" | "override:addItem" => {
            let result =
                override_add(app, args.first().cloned().unwrap_or_else(|| json!({}))).await?;
            Ok(CompatOutcome::attach_reload(result))
        }
        "updateOverride" | "override:updateItem" => {
            let mut result = override_update(
                app,
                &arg_string(args, 0).unwrap_or_default(),
                args.get(1).cloned().unwrap_or_else(|| json!({})),
            )?;
            let should_fetch_remote = result.get("type").and_then(Value::as_str) == Some("remote")
                && result
                    .get("enabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                && override_content(app, result.get("id").and_then(Value::as_str).unwrap_or(""))
                    .map(|content| content.trim().is_empty())
                    .unwrap_or(true);
            if should_fetch_remote {
                result = override_update_remote(
                    app,
                    result.get("id").and_then(Value::as_str).unwrap_or(""),
                )
                .await?;
            }
            Ok(CompatOutcome::attach_reload(result))
        }
        "deleteOverride" | "override:deleteItem" => {
            let id = arg_string(args, 0).unwrap_or_default();
            let changed = db(app)?
                .execute("DELETE FROM overrides WHERE id = ?1", params![id])
                .map_err(|err| err.to_string())?;
            if changed == 0 {
                return Ok(CompatOutcome::ready(json!({
                    "success": false,
                    "error": "覆写项不存在"
                })));
            }
            Ok(CompatOutcome::success_reload_payload())
        }
        "getOverrideFileContent" | "override:getFileContent" => {
            let id = arg_string(args, 0).unwrap_or_default();
            let mut content = override_content(app, &id)?;
            if content.trim().is_empty() {
                if let Some(item) = all_overrides(app)?.into_iter().find(|item| {
                    item.get("id").and_then(Value::as_str) == Some(id.as_str())
                        && item.get("type").and_then(Value::as_str) == Some("remote")
                }) {
                    let url = item
                        .get("url")
                        .and_then(Value::as_str)
                        .ok_or_else(|| "远程覆写缺少 URL".to_string())?;
                    content = fetch_override_remote_content(url).await?;
                    save_override_item(app, &item, Some(&content))?;
                }
            }
            Ok(CompatOutcome::ready(Value::String(content)))
        }
        "updateOverrideFileContent" | "override:updateFileContent" => {
            let id = arg_string(args, 0).unwrap_or_default();
            let content = arg_string(args, 1).unwrap_or_default();
            let item = all_overrides(app)?
                .into_iter()
                .find(|item| item.get("id").and_then(Value::as_str) == Some(id.as_str()))
                .ok_or_else(|| "覆写项不存在".to_string())?;
            save_override_item(app, &item, Some(&content))?;
            Ok(CompatOutcome::success_reload_payload())
        }
        "updateRemoteOverride" | "override:updateRemoteItem" => {
            let result =
                override_update_remote(app, &arg_string(args, 0).unwrap_or_default()).await?;
            Ok(CompatOutcome::attach_reload(result))
        }
        "reorderOverrides" | "override:reorderItems" => {
            let ids = args
                .first()
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let conn = db(app)?;
            let mut missing = Vec::<String>::new();
            for (index, id) in ids.iter().filter_map(Value::as_str).enumerate() {
                let changed = conn
                    .execute(
                        "UPDATE overrides SET sort_order = ?1 WHERE id = ?2",
                        params![index as i64, id],
                    )
                    .map_err(|err| err.to_string())?;
                if changed == 0 {
                    missing.push(id.to_string());
                }
            }
            if !missing.is_empty() {
                return Ok(CompatOutcome::ready(json!({
                    "success": false,
                    "missing": missing,
                    "error": "部分覆写项不存在，排序未完全保存"
                })));
            }
            Ok(CompatOutcome::success_reload_payload())
        }
        _ => Err(format!("Unsupported override method: {method}")),
    }
}

pub(crate) async fn handle_compat_call(
    app: &AppHandle,
    method: &str,
    args: &[Value],
) -> Option<CompatResult> {
    if !matches!(
        method,
        "getOverrides"
            | "override:getItems"
            | "addOverride"
            | "override:addItem"
            | "updateOverride"
            | "override:updateItem"
            | "deleteOverride"
            | "override:deleteItem"
            | "getOverrideFileContent"
            | "override:getFileContent"
            | "updateOverrideFileContent"
            | "override:updateFileContent"
            | "updateRemoteOverride"
            | "override:updateRemoteItem"
            | "reorderOverrides"
            | "override:reorderItems"
    ) {
        return None;
    }

    Some(dispatch_compat_call(app, method, args).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn js_override_returns_modified_config() {
        let config = json!({
            "proxies": [{ "name": "node-a" }],
            "proxy-groups": []
        });
        let script = r#"
function main(config) {
  config.proxies.push({ name: 'node-b' });
  return config;
}
"#;

        let result = run_js_override(&config, script, "test-js").unwrap();

        assert_eq!(
            result
                .get("proxies")
                .and_then(Value::as_array)
                .map(Vec::len),
            Some(2)
        );
    }

    #[test]
    fn js_override_rejects_non_object_result() {
        let config = json!({ "proxies": [] });
        let result = run_js_override(&config, "function main() { return 'bad'; }", "test-js");

        assert!(result.is_err());
    }
}
