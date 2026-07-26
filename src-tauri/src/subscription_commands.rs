use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::{
    core_lifecycle_commands::refresh_active_config_after_override,
    profiles::{
        config_content, current_active_config, delete_subscription, edit_subscription,
        emit_active_config_changed, read_subscriptions, resolve_subscription_path,
        save_config_content, save_last_config, save_subscription, save_subscription_info,
        subscription_info_from_headers, update_subscription, SubscriptionMeta,
    },
    state::AppState,
    storage::{db, set_setting, setting},
    tray::refresh_tray_menu_after,
};

type CompatResult = Result<Value, String>;

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

fn arg_string(args: &[Value], index: usize) -> Option<String> {
    args.get(index)
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

fn safe_subscription_user_agent(app: &AppHandle) -> Result<String, String> {
    let ua_key = setting(app, "subscription-ua", json!("MihomoParty"))?
        .as_str()
        .unwrap_or("MihomoParty")
        .trim()
        .to_string();

    Ok(match ua_key.as_str() {
        "Clash" => "Clash/2.0.0".to_string(),
        "Mihomo" => "Mihomo/1.14.0".to_string(),
        "Chrome" => "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36".to_string(),
        "FlyClash" => format!("FlyClash/{}", app.package_info().version),
        _ => "clash.meta".to_string(),
    })
}

async fn fetch_subscription(app: &AppHandle, url: &str) -> CompatResult {
    let mut valid_url = url.trim().to_string();
    if !valid_url.starts_with("http://") && !valid_url.starts_with("https://") {
        valid_url = format!("https://{valid_url}");
    }

    let ua = safe_subscription_user_agent(app)?;
    let response = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|err| err.to_string())?
        .get(valid_url)
        .header("User-Agent", ua)
        .send()
        .await
        .map_err(|err| err.to_string())?;

    if !response.status().is_success() {
        return Ok(json!({
            "success": false,
            "error": format!("获取订阅失败: {}", response.status())
        }));
    }

    let (used, remaining, expire) = subscription_info_from_headers(response.headers());
    let content = response.text().await.map_err(|err| err.to_string())?;
    if content.trim().is_empty() {
        return Ok(json!({
            "success": false,
            "error": "订阅内容为空"
        }));
    }

    Ok(success(json!({
        "content": content,
        "subscriptionInfo": {
            "usedTraffic": used,
            "remainingTraffic": remaining,
            "expiryDate": expire
        }
    })))
}

async fn refresh_subscription_by_path(
    app: &AppHandle,
    state: Option<&State<'_, AppState>>,
    file_path: &str,
) -> CompatResult {
    let file_path = match resolve_subscription_path(app, file_path)? {
        Some(path) => path,
        None => {
            return Ok(json!({
                "success": false,
                "error": "未找到订阅信息"
            }));
        }
    };
    let subscription = read_subscriptions(app)?
        .into_iter()
        .find(|item| item.path == file_path);
    let Some(subscription) = subscription else {
        return Ok(json!({
            "success": false,
            "error": "未找到订阅信息"
        }));
    };

    let Some(url) = subscription.url.clone() else {
        return Ok(json!({
            "success": true,
            "filePath": file_path,
            "message": "本地配置无需刷新"
        }));
    };

    if url.trim().is_empty() || url.trim_start().starts_with("local:") {
        return Ok(json!({
            "success": true,
            "filePath": file_path,
            "message": "本地配置无需刷新"
        }));
    }

    let mut fetched = fetch_subscription(app, &url).await?;
    if !fetched
        .get("success")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Ok(fetched);
    }

    // 旧内容仅用于失败回滚；读不出（密文损坏等）不应中止刷新，
    // 让新下载的内容直接覆盖成为自愈路径
    let previous_content = config_content(app, &file_path).ok();
    let mut content_updated = false;

    let update_result: Result<(), String> = (|| {
        if let Some(content) = fetched.get("content").and_then(Value::as_str) {
            save_config_content(app, &file_path, content)?;
            content_updated = true;
        }

        if let Some(info) = fetched.get("subscriptionInfo") {
            save_subscription_info(app, &file_path, info)?;
        }

        Ok(())
    })();

    if let Err(error) = update_result {
        if content_updated {
            if let Some(previous_content) = previous_content.as_deref() {
                let _ = save_config_content(app, &file_path, previous_content);
            }
        }
        return Ok(json!({
            "success": false,
            "error": format!("订阅已下载，但保存失败: {error}")
        }));
    }

    if let Some(state) = state {
        let active = current_active_config(app, state);
        let runtime_reload = if active.as_deref() == Some(file_path.as_str()) {
            refresh_active_config_after_override(app, state).await
        } else {
            json!({
                "reloaded": false,
                "skipped": true,
                "reason": "not-active-config"
            })
        };
        if let Some(object) = fetched.as_object_mut() {
            object.insert("runtimeReload".to_string(), runtime_reload);
            object.insert("filePath".to_string(), Value::String(file_path.clone()));
        }
    }

    Ok(fetched)
}

fn due_auto_update_subscriptions(app: &AppHandle) -> Result<Vec<SubscriptionMeta>, String> {
    let now = now_millis();
    Ok(read_subscriptions(app)?
        .into_iter()
        .filter(|sub| {
            sub.update_interval > 0
                && sub
                    .url
                    .as_deref()
                    .map(|url| {
                        let trimmed = url.trim();
                        !trimmed.is_empty() && !trimmed.starts_with("local:")
                    })
                    .unwrap_or(false)
        })
        .filter(|sub| {
            let updated_at = sub
                .last_updated
                .as_deref()
                .and_then(|value| value.parse::<u128>().ok())
                .unwrap_or(0);
            let interval_ms = (sub.update_interval as u128).saturating_mul(60_000);
            interval_ms > 0 && now.saturating_sub(updated_at) >= interval_ms
        })
        .collect())
}

async fn run_subscription_scheduler_once(app: &AppHandle) -> Result<(), String> {
    let due = due_auto_update_subscriptions(app)?;
    if due.is_empty() {
        return Ok(());
    }

    for sub in due {
        let interval_ms = (sub.update_interval as u128).saturating_mul(60_000);
        let now = now_millis();
        {
            let state = app.state::<AppState>();
            let mut runtime = state.runtime.lock().expect("runtime mutex poisoned");
            let last_attempt = runtime
                .subscription_update_attempts
                .get(&sub.path)
                .copied()
                .unwrap_or(0);
            if interval_ms > 0 && now.saturating_sub(last_attempt) < interval_ms {
                continue;
            }
            runtime
                .subscription_update_attempts
                .insert(sub.path.clone(), now);
        }

        let state = app.state::<AppState>();
        match refresh_subscription_by_path(app, Some(&state), &sub.path).await {
            Ok(mut result) => {
                if result
                    .get("success")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                {
                    if let Some(object) = result.as_object_mut() {
                        object.remove("content");
                    }
                    let _ = app.emit(
                        "subscription-auto-updated",
                        json!({
                            "name": sub.name,
                            "filePath": sub.path,
                            "result": result
                        }),
                    );
                } else {
                    let error = result
                        .get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("订阅自动更新失败");
                    let _ = app.emit(
                        "subscription-auto-update-failed",
                        json!({
                            "name": sub.name,
                            "filePath": sub.path,
                            "error": error
                        }),
                    );
                }
            }
            Err(error) => {
                let _ = app.emit(
                    "subscription-auto-update-failed",
                    json!({
                        "name": sub.name,
                        "filePath": sub.path,
                        "error": error
                    }),
                );
            }
        }
    }

    Ok(())
}

pub(crate) fn start_subscription_scheduler(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(3)).await;
        loop {
            if let Err(error) = run_subscription_scheduler_once(&app).await {
                eprintln!("[subscription-scheduler] {error}");
            }
            tokio::time::sleep(Duration::from_secs(60)).await;
        }
    });
}

async fn dispatch_compat_call(
    app: &AppHandle,
    state: &State<'_, AppState>,
    method: &str,
    args: &[Value],
) -> CompatResult {
    match method {
        "fetchSubscription" => {
            let url = arg_string(args, 0).unwrap_or_default();
            fetch_subscription(app, &url).await
        }
        "saveSubscription" => {
            let result = save_subscription(
                app,
                arg_string(args, 0),
                arg_string(args, 1).unwrap_or_default(),
                arg_string(args, 2),
                args.get(3).cloned(),
            )?;
            if result
                .get("success")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                refresh_tray_menu_after(app, "saveSubscription");
            }
            Ok(result)
        }
        "updateSubscription" | "update-subscription" => {
            let file_path = arg_string(args, 0).unwrap_or_default();
            let resolved_path = resolve_subscription_path(app, &file_path)?;
            let result = update_subscription(
                app,
                &file_path,
                &arg_string(args, 1).unwrap_or_default(),
                arg_string(args, 2),
                args.get(3).cloned(),
            )?;
            let updated = result.as_bool().unwrap_or(false);
            let active = current_active_config(app, state);
            if updated && active.as_deref() == resolved_path.as_deref() {
                let _ = refresh_active_config_after_override(app, state).await;
            }
            if updated {
                refresh_tray_menu_after(app, "updateSubscription");
            }
            Ok(result)
        }
        "getSubscriptions" => {
            Ok(serde_json::to_value(read_subscriptions(app)?).unwrap_or(json!([])))
        }
        "deleteSubscription" => {
            let file_path = arg_string(args, 0).unwrap_or_default();
            let resolved_path = resolve_subscription_path(app, &file_path)?;
            let active = current_active_config(app, state);
            let result = delete_subscription(app, &file_path)?;
            let deleted = result.as_bool().unwrap_or_else(|| {
                result
                    .get("success")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
            });
            if !deleted {
                return Ok(result);
            }
            let mut runtime = state.runtime.lock().expect("runtime mutex poisoned");
            if let Some(path) = resolved_path.as_deref() {
                runtime.subscription_update_attempts.remove(path);
            }
            let was_active = active.as_deref() == resolved_path.as_deref();
            if was_active {
                runtime.core.clear_active_config();
            }
            drop(runtime);
            if was_active {
                set_setting(app, "active_config", Value::Null)?;
                emit_active_config_changed(app, None);
            }
            refresh_tray_menu_after(app, "deleteSubscription");
            Ok(result)
        }
        "refreshSubscription" => {
            let file_path = arg_string(args, 0).unwrap_or_default();
            refresh_subscription_by_path(app, Some(state), &file_path).await
        }
        "getSubscriptionUrl" => {
            let file_path = arg_string(args, 0).unwrap_or_default();
            let resolved_path = resolve_subscription_path(app, &file_path)?;
            Ok(read_subscriptions(app)?
                .into_iter()
                .find(|item| Some(item.path.as_str()) == resolved_path.as_deref())
                .and_then(|item| item.url)
                .map(Value::String)
                .unwrap_or(Value::Null))
        }
        "editSubscription" => {
            let params = args.first().cloned().unwrap_or(Value::Null);
            let old_path = params
                .get("oldPath")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let result = edit_subscription(app, params)?;
            let old_path = resolve_subscription_path(app, &old_path)
                .ok()
                .flatten()
                .unwrap_or(old_path);
            let success = result
                .get("success")
                .and_then(Value::as_bool)
                .unwrap_or(false);

            if success && !old_path.is_empty() {
                if let Some(new_path) = result.get("newPath").and_then(Value::as_str) {
                    if old_path != new_path {
                        let active = current_active_config(app, state);
                        let was_active = active.as_deref() == Some(old_path.as_str());

                        {
                            let mut runtime = state.runtime.lock().expect("runtime mutex poisoned");
                            runtime.subscription_update_attempts.remove(&old_path);
                            if was_active {
                                runtime.core.set_active_config(Some(new_path.to_string()));
                            }
                        }

                        if was_active {
                            save_last_config(app, new_path)?;
                            emit_active_config_changed(app, Some(new_path));
                        }
                    }
                }
            }

            if success {
                refresh_tray_menu_after(app, "editSubscription");
            }
            Ok(result)
        }
        "saveSubscriptionOrder" => {
            let order_list = args
                .first()
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let conn = db(app)?;
            let mut updated = 0usize;
            let mut missing = Vec::<String>::new();

            for entry in order_list {
                let Some(path) = entry.get("path").and_then(Value::as_str) else {
                    continue;
                };
                let resolved_path = resolve_subscription_path(app, path)?;
                let order = entry.get("order").and_then(Value::as_u64).unwrap_or(0) as usize;
                let Some(resolved_path) = resolved_path else {
                    missing.push(path.to_string());
                    continue;
                };
                let changed = conn
                    .execute(
                        "UPDATE subscriptions SET sort_order = ?1 WHERE file_path = ?2",
                        params![order as i64, &resolved_path],
                    )
                    .map_err(|err| err.to_string())?;
                if changed == 0 {
                    missing.push(path.to_string());
                } else {
                    updated += changed;
                }
            }

            if !missing.is_empty() {
                return Ok(json!({
                    "success": false,
                    "updated": updated,
                    "missing": missing,
                    "error": "部分订阅不存在，排序未完全保存"
                }));
            }

            refresh_tray_menu_after(app, "saveSubscriptionOrder");
            Ok(success(json!({ "updated": updated })))
        }
        "getSubscriptionOverrides" => {
            let file_path = arg_string(args, 0).unwrap_or_default();
            let Some(file_path) = resolve_subscription_path(app, &file_path)? else {
                return Ok(json!({ "success": false, "error": "订阅不存在" }));
            };
            let raw = db(app)?
                .query_row(
                    "SELECT overrides FROM subscriptions WHERE file_path = ?1",
                    params![&file_path],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(|err| err.to_string())?;
            let Some(raw) = raw else {
                return Ok(json!({ "success": false, "error": "订阅不存在" }));
            };
            Ok(serde_json::from_str::<Value>(&raw).unwrap_or_else(|_| json!([])))
        }
        "setSubscriptionOverrides" => {
            let file_path = arg_string(args, 0).unwrap_or_default();
            let Some(file_path) = resolve_subscription_path(app, &file_path)? else {
                return Ok(json!({ "success": false, "error": "订阅不存在" }));
            };
            let overrides = args.get(1).cloned().unwrap_or_else(|| json!([]));
            let skip_reload = args
                .get(2)
                .and_then(|value| {
                    value
                        .as_bool()
                        .or_else(|| value.get("skipReload").and_then(Value::as_bool))
                })
                .unwrap_or(false);
            let changed = db(app)?
                .execute(
                    "UPDATE subscriptions SET overrides = ?1 WHERE file_path = ?2",
                    params![overrides.to_string(), &file_path],
                )
                .map_err(|err| err.to_string())?;
            if changed == 0 {
                return Ok(json!({ "success": false, "error": "订阅不存在" }));
            }

            crate::runtime_config::invalidate_runtime_work_config_cache();

            if skip_reload {
                return Ok(success(json!({
                    "runtimeReload": {
                        "reloaded": false,
                        "skipped": true,
                        "reason": "skip-reload-requested"
                    }
                })));
            }

            let active = current_active_config(app, state);
            let runtime_reload = if active.as_deref() == Some(file_path.as_str()) {
                refresh_active_config_after_override(app, state).await
            } else {
                json!({
                    "reloaded": false,
                    "skipped": true,
                    "reason": "not-active-config"
                })
            };
            Ok(success(json!({ "runtimeReload": runtime_reload })))
        }
        "getSubscriptionUpdateInterval" => {
            let file_path = arg_string(args, 0).unwrap_or_default();
            let Some(file_path) = resolve_subscription_path(app, &file_path)? else {
                return Ok(json!({ "success": false, "interval": 0, "error": "订阅不存在" }));
            };
            let interval = db(app)?
                .query_row(
                    "SELECT update_interval FROM subscriptions WHERE file_path = ?1",
                    params![&file_path],
                    |row| row.get::<_, i64>(0),
                )
                .optional()
                .map_err(|err| err.to_string())?;
            let Some(interval) = interval else {
                return Ok(json!({ "success": false, "interval": 0, "error": "订阅不存在" }));
            };
            Ok(success(json!({ "interval": interval })))
        }
        "setSubscriptionUpdateInterval" => {
            let file_path = arg_string(args, 0).unwrap_or_default();
            let Some(file_path) = resolve_subscription_path(app, &file_path)? else {
                return Ok(json!({ "success": false, "error": "订阅不存在" }));
            };
            let interval = args.get(1).and_then(Value::as_i64).unwrap_or(0).max(0);
            let changed = db(app)?
                .execute(
                    "UPDATE subscriptions SET update_interval = ?1 WHERE file_path = ?2",
                    params![interval, &file_path],
                )
                .map_err(|err| err.to_string())?;
            if changed == 0 {
                return Ok(json!({ "success": false, "error": "订阅不存在" }));
            }

            state
                .runtime
                .lock()
                .expect("runtime mutex poisoned")
                .subscription_update_attempts
                .remove(&file_path);
            Ok(success(json!({ "schedulerActive": true })))
        }

        _ => Err(format!("Unsupported subscription method: {method}")),
    }
}

pub(crate) async fn handle_compat_call(
    app: &AppHandle,
    state: &State<'_, AppState>,
    method: &str,
    args: &[Value],
) -> Option<CompatResult> {
    if !matches!(
        method,
        "fetchSubscription"
            | "saveSubscription"
            | "updateSubscription"
            | "update-subscription"
            | "getSubscriptions"
            | "deleteSubscription"
            | "refreshSubscription"
            | "getSubscriptionUrl"
            | "editSubscription"
            | "saveSubscriptionOrder"
            | "getSubscriptionOverrides"
            | "setSubscriptionOverrides"
            | "getSubscriptionUpdateInterval"
            | "setSubscriptionUpdateInterval"
    ) {
        return None;
    }

    Some(dispatch_compat_call(app, state, method, args).await)
}
