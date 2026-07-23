use serde_json::{json, Value};
use tauri::{AppHandle, State, WebviewWindow};

use crate::{
    core_lifecycle_commands::apply_saved_config,
    profiles::{
        config_content, config_display_name, current_active_config, read_last_config,
        save_config_content,
    },
    runtime_config::{
        config_yaml, default_dns_config, default_sniffer_config, hosts_to_map,
        merge_object_setting, non_empty_object, parse_config_order, parse_proxy_nodes_config,
        save_config_yaml, save_kernel_yaml, save_yaml_section_value, yaml_key, yaml_root_pick,
        yaml_save_section, yaml_section, KERNEL_FIELDS,
    },
    state::AppState,
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

async fn dispatch_compat_call(
    app: &AppHandle,
    window: &WebviewWindow,
    state: &State<'_, AppState>,
    method: &str,
    args: &[Value],
) -> CompatResult {
    match method {
        "readConfigFile" => {
            let active =
                current_active_config(app, state).ok_or_else(|| "没有当前配置".to_string())?;
            Ok(success(json!({
                "path": active,
                "content": config_content(app, &active)?
            })))
        }
        "validateConfig" => {
            let content = arg_string(args, 0).unwrap_or_default();
            match serde_yaml::from_str::<serde_yaml::Value>(&content) {
                Ok(_) => Ok(json!({ "valid": true })),
                Err(err) => Ok(json!({ "valid": false, "error": err.to_string() })),
            }
        }
        "writeConfigFile" => {
            let content = arg_string(args, 0).unwrap_or_default();
            let active =
                current_active_config(app, state).ok_or_else(|| "没有当前配置".to_string())?;
            save_config_content(app, &active, &content)?;
            Ok(success(json!({ "path": active })))
        }
        "editConfigAtomic" => {
            let old = arg_string(args, 0).unwrap_or_default();
            let new = arg_string(args, 1).unwrap_or_default();
            let active =
                current_active_config(app, state).ok_or_else(|| "没有当前配置".to_string())?;
            let content = config_content(app, &active)?;
            let match_count = content.matches(&old).count();
            if match_count == 0 {
                return Ok(json!({ "success": false, "matchCount": 0, "error": "未找到匹配内容" }));
            }
            let next = content.replacen(&old, &new, 1);
            if let Err(err) = serde_yaml::from_str::<serde_yaml::Value>(&next) {
                return Ok(
                    json!({ "success": false, "matchCount": match_count, "yamlError": err.to_string() }),
                );
            }
            save_config_content(app, &active, &next)?;
            Ok(json!({ "success": true, "matchCount": match_count, "content": next }))
        }
        "getKernelConfig" => yaml_root_pick(app, arg_string(args, 0), KERNEL_FIELDS),
        "saveKernelConfig" => {
            let config = args.first().cloned().unwrap_or_else(|| json!({}));
            if let Some(config_path) = arg_string(args, 1) {
                save_kernel_yaml(app, &config_path, config)?;
                Ok(success(json!({
                    "restarted": false,
                    "message": "kernel config saved to YAML"
                })))
            } else {
                merge_object_setting(app, "kernel", config)?;
                apply_saved_config(app, window, state, "kernel").await
            }
        }
        "getDnsConfig" => {
            if let Some(config_path) = arg_string(args, 0) {
                let yaml = config_yaml(app, &config_path)?;
                let dns = yaml.get("dns").cloned().unwrap_or_else(|| {
                    serde_yaml::to_value(default_dns_config()).unwrap_or(serde_yaml::Value::Null)
                });
                let hosts = yaml
                    .get("hosts")
                    .cloned()
                    .unwrap_or(serde_yaml::Value::Mapping(Default::default()));
                Ok(success(json!({
                    "config": serde_json::to_value(dns).unwrap_or_else(|_| default_dns_config()),
                    "hosts": serde_json::to_value(hosts).unwrap_or_else(|_| json!({})),
                    // 订阅 YAML 路径没有独立覆写开关，始终视为该文件自身 DNS 生效
                    "overrideEnabled": true
                })))
            } else {
                let dns = setting(app, "dns", default_dns_config())?;
                let dns = if non_empty_object(&dns) {
                    dns
                } else {
                    default_dns_config()
                };
                Ok(success(json!({
                    "config": dns,
                    "hosts": setting(app, "hosts", json!({}))?,
                    "overrideEnabled": crate::runtime_config::dns_override_enabled(app)
                })))
            }
        }
        "saveDnsConfig" => {
            let config = args.first().cloned().unwrap_or_else(|| json!({}));
            if let Some(config_path) = arg_string(args, 1) {
                save_yaml_section_value(app, &config_path, "dns", config)?;
                Ok(success(json!({
                    "restarted": false,
                    "message": "dns config saved to YAML"
                })))
            } else {
                // 可选第二参数（无 configPath 时）：{ overrideEnabled?: bool }
                // 兼容旧调用：仅传 dns config 时不改覆写开关
                if let Some(options) = args.get(1).and_then(Value::as_object) {
                    if let Some(enabled) = options.get("overrideEnabled").and_then(Value::as_bool) {
                        set_setting(app, "dnsOverrideEnabled", Value::Bool(enabled))?;
                    }
                }
                set_setting(app, "dns", config)?;
                apply_saved_config(app, window, state, "dns").await
            }
        }
        "saveHostsConfig" => {
            let hosts = args.first().cloned().unwrap_or_else(|| json!([]));
            let hosts = hosts_to_map(hosts);
            if let Some(config_path) = arg_string(args, 1) {
                save_yaml_section_value(app, &config_path, "hosts", hosts)?;
                Ok(success(json!({
                    "restarted": false,
                    "message": "hosts config saved to YAML"
                })))
            } else {
                set_setting(app, "hosts", hosts)?;
                apply_saved_config(app, window, state, "hosts").await
            }
        }
        "getSnifferConfig" => {
            if let Some(config_path) = arg_string(args, 0) {
                yaml_section(app, Some(config_path), "sniffer")
                    .or_else(|_| Ok(success(json!({ "config": default_sniffer_config() }))))
            } else {
                let config = setting(app, "sniffer", default_sniffer_config())?;
                Ok(success(json!({ "config": config })))
            }
        }
        "saveSnifferConfig" => {
            let config = args.first().cloned().unwrap_or_else(default_sniffer_config);
            if let Some(config_path) = arg_string(args, 1) {
                save_yaml_section_value(app, &config_path, "sniffer", config)?;
                Ok(success(json!({
                    "restarted": false,
                    "message": "sniffer config saved to YAML"
                })))
            } else {
                set_setting(app, "sniffer", config)?;
                apply_saved_config(app, window, state, "sniffer").await
            }
        }
        "getProxyGroupsConfig" => {
            let path = arg_string(args, 0).ok_or_else(|| "missing config path".to_string())?;
            let yaml = config_yaml(app, &path)?;
            Ok(success(json!({
                "groups": serde_json::to_value(yaml.get("proxy-groups").cloned().unwrap_or(serde_yaml::Value::Sequence(vec![]))).unwrap_or(json!([]))
            })))
        }
        "saveProxyGroupsConfig" => yaml_save_section(
            app,
            arg_string(args, 1),
            "proxy-groups",
            args.first().cloned().unwrap_or_else(|| json!([])),
        ),
        "getRulesConfig" => {
            let path = arg_string(args, 0).ok_or_else(|| "missing config path".to_string())?;
            let yaml = config_yaml(app, &path)?;
            Ok(success(json!({
                "rules": serde_json::to_value(yaml.get("rules").cloned().unwrap_or(serde_yaml::Value::Sequence(vec![]))).unwrap_or(json!([]))
            })))
        }
        "saveRulesConfig" => yaml_save_section(
            app,
            arg_string(args, 1),
            "rules",
            args.first().cloned().unwrap_or_else(|| json!([])),
        ),
        "getProvidersConfig" => {
            let path = arg_string(args, 0).ok_or_else(|| "missing config path".to_string())?;
            let yaml = config_yaml(app, &path)?;
            Ok(success(json!({
                "proxyProviders": serde_json::to_value(yaml.get("proxy-providers").cloned().unwrap_or(serde_yaml::Value::Mapping(Default::default()))).unwrap_or(json!({})),
                "ruleProviders": serde_json::to_value(yaml.get("rule-providers").cloned().unwrap_or(serde_yaml::Value::Mapping(Default::default()))).unwrap_or(json!({}))
            })))
        }
        "saveProvidersConfig" => {
            let path = arg_string(args, 2).ok_or_else(|| "missing config path".to_string())?;
            let mut yaml = config_yaml(app, &path)?;
            if !matches!(yaml, serde_yaml::Value::Mapping(_)) {
                yaml = serde_yaml::Value::Mapping(Default::default());
            }
            if let serde_yaml::Value::Mapping(map) = &mut yaml {
                map.insert(
                    yaml_key("proxy-providers"),
                    serde_yaml::to_value(args.first().cloned().unwrap_or_else(|| json!({})))
                        .map_err(|err| err.to_string())?,
                );
                map.insert(
                    yaml_key("rule-providers"),
                    serde_yaml::to_value(args.get(1).cloned().unwrap_or_else(|| json!({})))
                        .map_err(|err| err.to_string())?,
                );
            }
            save_config_yaml(app, &path, &yaml)?;
            Ok(success(json!({})))
        }
        "getProxiesConfig" => {
            let path = arg_string(args, 0).ok_or_else(|| "missing config path".to_string())?;
            let yaml = config_yaml(app, &path)?;
            Ok(success(json!({
                "proxies": serde_json::to_value(yaml.get("proxies").cloned().unwrap_or(serde_yaml::Value::Sequence(vec![]))).unwrap_or(json!([]))
            })))
        }
        "saveProxiesConfig" => yaml_save_section(
            app,
            arg_string(args, 1),
            "proxies",
            args.first().cloned().unwrap_or_else(|| json!([])),
        ),
        "getConfigOrder" => {
            let active = state
                .runtime
                .lock()
                .expect("runtime mutex poisoned")
                .core
                .active_config_owned()
                .or(read_last_config(app)?);
            Ok(parse_config_order(app, active))
        }
        "getProxyNodes" => {
            let config_path = arg_string(args, 0)
                .filter(|path| !path.trim().is_empty())
                .or_else(|| {
                    state
                        .runtime
                        .lock()
                        .expect("runtime mutex poisoned")
                        .core
                        .active_config_owned()
                })
                .or(read_last_config(app)?);
            Ok(config_path
                .as_deref()
                .map(|path| parse_proxy_nodes_config(app, path))
                .unwrap_or(Value::Null))
        }
        "getCurrentConfigName" => {
            let active = read_last_config(app)?;
            let name = active.as_deref().and_then(config_display_name);
            Ok(success(json!({ "configName": name })))
        }
        _ => Err(format!("Unsupported config method: {method}")),
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
        "readConfigFile"
            | "validateConfig"
            | "writeConfigFile"
            | "editConfigAtomic"
            | "getKernelConfig"
            | "saveKernelConfig"
            | "getDnsConfig"
            | "saveDnsConfig"
            | "saveHostsConfig"
            | "getSnifferConfig"
            | "saveSnifferConfig"
            | "getProxyGroupsConfig"
            | "saveProxyGroupsConfig"
            | "getRulesConfig"
            | "saveRulesConfig"
            | "getProvidersConfig"
            | "saveProvidersConfig"
            | "getProxiesConfig"
            | "saveProxiesConfig"
            | "getConfigOrder"
            | "getProxyNodes"
            | "getCurrentConfigName"
    ) {
        return None;
    }

    Some(dispatch_compat_call(app, window, state, method, args).await)
}
