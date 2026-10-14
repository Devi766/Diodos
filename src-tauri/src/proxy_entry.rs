use std::{collections::{HashMap, HashSet}, net::IpAddr, path::Path, time::Duration};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::{dns_lookup, mihomo_local_socket, tcp_table};

#[derive(Default, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProxyEntry {
    node: Option<String>,
    entry_node: Option<String>,
    host: Option<String>,
    ip: Option<String>,
    private_dns: bool,
    source: Option<&'static str>,
    error: Option<&'static str>,
}

async fn controller(socket: &str, path: &str) -> Result<Value, String> {
    let (status, body) = mihomo_local_socket::request_json(socket, "GET", path, &Value::Null).await?;
    if !(200..300).contains(&status) {
        return Err(format!("控制接口返回 {status}"));
    }
    serde_json::from_str(&body).map_err(|err| err.to_string())
}

fn strings(value: &Value) -> Vec<String> {
    match value {
        Value::String(text) => vec![text.clone()],
        Value::Array(items) => items.iter().filter_map(Value::as_str).map(str::to_string).collect(),
        _ => Vec::new(),
    }
}

fn add_nodes(nodes: &mut HashMap<String, Value>, value: &Value) {
    if let Some(proxies) = value.get("proxies").and_then(Value::as_array) {
        for proxy in proxies {
            if let Some(name) = proxy.get("name").and_then(Value::as_str) {
                nodes.entry(name.to_string()).or_insert_with(|| proxy.clone());
            }
        }
    }
}

// 读取已下载的 provider 文件，不在解析入口时更新订阅
fn configured_nodes(config: &Value, work_dir: &Path) -> HashMap<String, Value> {
    let mut nodes = HashMap::new();
    add_nodes(&mut nodes, config);
    if let Some(providers) = config.get("proxy-providers").and_then(Value::as_object) {
        for provider in providers.values() {
            if let Some(payload) = provider.get("payload") {
                add_nodes(&mut nodes, &json!({ "proxies": payload }));
            }
            let Some(path) = provider.get("path").and_then(Value::as_str) else { continue };
            let path = work_dir.join(path);
            if !std::fs::metadata(&path).is_ok_and(|meta| meta.len() <= 8 * 1024 * 1024) {
                continue;
            }
            if let Ok(text) = std::fs::read_to_string(path) {
                if let Ok(value) = serde_yaml::from_str::<Value>(&text) {
                    add_nodes(&mut nodes, &value);
                }
            }
        }
    }
    nodes
}

fn primary_group(config: &Value, proxies: &Value, mode: &str) -> Option<String> {
    if mode.eq_ignore_ascii_case("direct") { return Some("DIRECT".into()); }
    if mode.eq_ignore_ascii_case("global") { return Some("GLOBAL".into()); }
    let groups: Vec<&str> = config.get("proxy-groups").and_then(Value::as_array)
        .into_iter().flatten()
        .filter(|group| group.get("hidden").and_then(Value::as_bool) != Some(true))
        .filter_map(|group| group.get("name").and_then(Value::as_str))
        .filter(|name| proxies.get(*name).is_some())
        .collect();
    groups.iter().find(|name| **name == "PROXY")
        .or_else(|| groups.iter().find(|name| **name != "GLOBAL"))
        .or_else(|| groups.first()).map(|name| name.to_string())
        .or_else(|| proxies.get("PROXY").map(|_| "PROXY".into()))
}

// 沿 now 解开策略组，检测循环和无选择状态，避免把组名当成节点
fn resolve_node(start: &str, proxies: &Value) -> Result<String, &'static str> {
    let mut name = start.to_string();
    let mut visited = HashSet::new();
    for _ in 0..32 {
        if !visited.insert(name.clone()) { return Err("selection_cycle"); }
        if matches!(name.as_str(), "DIRECT" | "REJECT" | "REJECT-DROP" | "PASS") {
            return Ok(name);
        }
        let proxy = proxies.get(&name).ok_or("node_not_found")?;
        if let Some(now) = proxy.get("now").and_then(Value::as_str).filter(|s| !s.is_empty()) {
            name = now.to_string();
        } else if proxy.get("all").is_some() {
            return Err("no_selection");
        } else {
            return Ok(name);
        }
    }
    Err("selection_cycle")
}

fn entry_node(node: &str, proxies: &Value, nodes: &HashMap<String, Value>) -> Result<String, &'static str> {
    let mut name = node.to_string();
    let mut visited = HashSet::new();
    for _ in 0..32 {
        if !visited.insert(name.clone()) { return Err("selection_cycle"); }
        let Some(next) = nodes.get(&name).and_then(|node| node.get("dialer-proxy"))
            .and_then(Value::as_str).filter(|s| !s.is_empty() && *s != "DIRECT") else {
            return Ok(name);
        };
        name = resolve_node(next, proxies)?;
        if matches!(name.as_str(), "REJECT" | "REJECT-DROP" | "PASS") { return Err("no_entry"); }
    }
    Err("selection_cycle")
}

fn nameservers(config: &Value, host: &str) -> (Vec<String>, bool) {
    let dns = &config["dns"];
    let base = strings(&dns["proxy-server-nameserver"]);
    let mut private = !base.is_empty();
    if let Some(policy) = dns.get("proxy-server-nameserver-policy").and_then(Value::as_object) {
        for (pattern, value) in policy {
            if dns_lookup::policy_matches(pattern, host) {
                let servers = strings(value);
                if !servers.is_empty() { return (servers, true); }
            }
        }
    }
    let servers = if !base.is_empty() { base } else {
        private = false;
        strings(&dns["nameserver"])
    };
    (servers, private)
}

// 仅接受可唯一确认的远端地址，端口和已知 IP 用来剔除同期业务连接
fn select_candidate(
    candidates: &HashSet<tcp_table::RemoteEndpoint>,
    port: Option<u16>,
    known_ip: Option<std::net::Ipv4Addr>,
) -> Option<std::net::Ipv4Addr> {
    let ips: HashSet<_> = candidates.iter()
        .filter(|endpoint| tcp_table::is_public_ipv4(endpoint.ip))
        .filter(|endpoint| port.is_none_or(|port| endpoint.port == port))
        .map(|endpoint| endpoint.ip).collect();
    if let Some(ip) = known_ip.filter(|ip| ips.contains(ip)) { return Some(ip); }
    if ips.len() == 1 { ips.into_iter().next() } else { None }
}

async fn observe_entry(socket: &str, node: &str, pid: Option<u32>, port: Option<u16>, known_ip: Option<std::net::Ipv4Addr>) -> Option<String> {
    let baseline = tcp_table::snapshot(pid).ok()?;
    if !baseline.owned_by_pid { return None; }
    let before: HashSet<_> = baseline.endpoints.into_iter().collect();
    let path = format!("/proxies/{}/delay?url={}&timeout=4000", urlencoding::encode(node),
        urlencoding::encode("https://www.gstatic.com/generate_204"));
    let request = mihomo_local_socket::request_json_with_timeout(socket, "GET", &path, &Value::Null, Some(Duration::from_secs(5)));
    tokio::pin!(request);
    let mut candidates = HashSet::new();
    let mut interval = tokio::time::interval(Duration::from_millis(40));
    let mut complete = false;
    let deadline = tokio::time::sleep(Duration::from_millis(5200));
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            _ = &mut deadline => break,
            _ = &mut request, if !complete => { complete = true; }
            _ = interval.tick() => {
                if let Ok(snapshot) = tcp_table::snapshot(pid) {
                    if snapshot.owned_by_pid {
                        candidates.extend(snapshot.endpoints.into_iter().filter(|e| !before.contains(e)));
                    }
                }
                // 请求完成后再收一次快照，以纳入短时连接
                if complete { break; }
            }
        }
    }
    // 没有端口线索的 provider 不猜测同期新增连接，交给配置解析兜底
    if port.is_none() && known_ip.is_none() { return None; }
    select_candidate(&candidates, port, known_ip).map(|ip| ip.to_string())
}

async fn resolve(app: &AppHandle) -> ProxyEntry {
    let mut result = ProxyEntry::default();
    let endpoint = crate::runtime::active_runtime_controller_endpoint(app);
    let (configs, all) = tokio::join!(controller(&endpoint.path, "/configs"), controller(&endpoint.path, "/proxies"));
    let (Ok(configs), Ok(all)) = (configs, all) else {
        result.error = Some("core_unavailable"); return result;
    };
    let work_dir = match crate::resources::mihomo_dir(app) {
        Ok(dir) => dir,
        Err(_) => { result.error = Some("config_unavailable"); return result; }
    };
    let path = crate::core::config::runtime_config_paths(&work_dir).runtime_path;
    let config = std::fs::read_to_string(path).ok().and_then(|text| serde_yaml::from_str::<Value>(&text).ok()).unwrap_or(Value::Null);
    let mut proxies = all.get("proxies").cloned().unwrap_or(json!({}));
    // provider 节点在独立列表中时也并入策略组解析表
    if let Ok(providers) = controller(&endpoint.path, "/providers/proxies").await {
        if let Some(providers) = providers.get("providers").and_then(Value::as_object) {
            for provider in providers.values() {
                if let Some(items) = provider.get("proxies").and_then(Value::as_array) {
                    for proxy in items {
                        if let (Some(name), Some(map)) = (proxy.get("name").and_then(Value::as_str), proxies.as_object_mut()) {
                            map.entry(name.to_string()).or_insert_with(|| proxy.clone());
                        }
                    }
                }
            }
        }
    }
    let Some(group) = primary_group(&config, &proxies, configs.get("mode").and_then(Value::as_str).unwrap_or("rule")) else {
        result.error = Some("no_selection"); return result;
    };
    let node = match resolve_node(&group, &proxies) {
        Ok(node) => node,
        Err(error) => { result.error = Some(error); return result; }
    };
    result.node = Some(node.clone());
    if node == "DIRECT" || proxies.get(&node).and_then(|p| p.get("type")).and_then(Value::as_str) == Some("Direct") {
        result.entry_node = Some(node); result.source = Some("direct"); return result;
    }
    if matches!(node.as_str(), "REJECT" | "REJECT-DROP" | "PASS") {
        result.error = Some("no_entry"); return result;
    }
    let nodes = configured_nodes(&config, &work_dir);
    let entry = match entry_node(&node, &proxies, &nodes) {
        Ok(name) => name,
        Err(error) => { result.error = Some(error); return result; }
    };
    result.entry_node = Some(entry.clone());
    let entry_config = nodes.get(&entry).or_else(|| proxies.get(&entry));
    let host = entry_config.and_then(|p| p.get("server")).and_then(Value::as_str)
        .map(|s| s.trim().trim_start_matches('[').trim_end_matches(']').to_string());
    let port = entry_config.and_then(|p| p.get("port")).and_then(|p| p.as_u64().or_else(|| p.as_str()?.parse().ok()))
        .and_then(|port| u16::try_from(port).ok()).filter(|port| *port != 0);
    let host_ip = host.as_deref().and_then(|host| host.parse::<IpAddr>().ok());
    let (servers, private_dns) = nameservers(&config, host.as_deref().unwrap_or(""));
    result.private_dns = host.is_some() && host_ip.is_none() && private_dns;
    result.host = host.clone();
    let state = app.state::<crate::state::AppState>();
    let core = { state.runtime.lock().expect("runtime mutex poisoned").core.state() };
    let mut pid = core.pid;
    if core.running_mode == crate::core::manager::RunningMode::Service {
        pid = crate::core::service::get_status().ok().and_then(|s| s.pid);
    }
    let known_ip = match host_ip { Some(IpAddr::V4(ip)) => Some(ip), _ => None };
    if let Some(ip) = observe_entry(&endpoint.path, &node, pid, port, known_ip).await {
        result.ip = Some(ip); result.source = Some("tcp"); return result;
    }
    match host_ip {
        Some(IpAddr::V4(ip)) if tcp_table::is_public_ipv4(ip) => {
            result.ip = Some(ip.to_string()); result.source = Some("config");
        }
        Some(IpAddr::V4(_)) => result.error = Some("unroutable_address"),
        Some(IpAddr::V6(_)) => result.error = Some("ipv6_only"),
        None => {
            let Some(host) = host else { result.error = Some("node_config_unavailable"); return result; };
            match tokio::time::timeout(Duration::from_secs(10), dns_lookup::lookup(&host, &servers)).await {
                Ok(Ok(lookup)) => {
                    if let Some(ip) = lookup.ipv4.iter().find(|ip| tcp_table::is_public_ipv4(**ip)) {
                        result.ip = Some(ip.to_string()); result.source = Some("dns");
                    } else if !lookup.ipv4.is_empty() { result.error = Some("unroutable_address"); }
                    else if !lookup.ipv6.is_empty() { result.error = Some("ipv6_only"); }
                    else { result.error = Some("dns_failed"); }
                }
                _ => result.error = Some("dns_failed"),
            }
        }
    }
    result
}

pub(crate) async fn handle_compat_call(app: &AppHandle, method: &str) -> Option<Result<Value, String>> {
    if method != "resolveProxyEntry" { return None; }
    let result = resolve(app).await;
    Some(serde_json::to_value(result).map_err(|err| err.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_groups_provider_nodes_and_dialer_chain() {
        let proxies = json!({"GLOBAL":{"now":"PROXY"},"PROXY":{"now":"exit"},"exit":{"type":"Shadowsocks"},"relay":{"now":"entry"},"entry":{"type":"Vmess"}});
        let nodes = HashMap::from([("exit".to_string(), json!({"dialer-proxy":"relay"}))]);
        assert_eq!(resolve_node("GLOBAL", &proxies), Ok("exit".into()));
        assert_eq!(entry_node("exit", &proxies, &nodes), Ok("entry".into()));
        assert_eq!(resolve_node("DIRECT", &proxies), Ok("DIRECT".into()));
        assert_eq!(resolve_node("cycle", &json!({"cycle":{"now":"cycle"}})), Err("selection_cycle"));
    }

    #[test]
    fn picks_visible_primary_group_like_dashboard() {
        let config = json!({"proxy-groups":[{"name":"hidden","hidden":true},{"name":"first"},{"name":"PROXY"}]});
        let proxies = json!({"hidden":{},"first":{},"PROXY":{}});
        assert_eq!(primary_group(&config, &proxies, "rule"), Some("PROXY".into()));
        assert_eq!(primary_group(&config, &proxies, "global"), Some("GLOBAL".into()));
        assert_eq!(primary_group(&config, &proxies, "direct"), Some("DIRECT".into()));
    }

    #[test]
    fn matches_private_dns_policy() {
        let config = json!({"dns":{"proxy-server-nameserver":["1.1.1.1"],"proxy-server-nameserver-policy":{"+.example.com":"tcp://8.8.8.8"}}});
        assert_eq!(nameservers(&config, "node.example.com"), (vec!["tcp://8.8.8.8".into()], true));
        assert_eq!(nameservers(&config, "other.test"), (vec!["1.1.1.1".into()], true));
    }

    #[test]
    fn ambiguous_connections_are_not_guessed() {
        let a = tcp_table::RemoteEndpoint { ip: "1.1.1.1".parse().unwrap(), port: 443, local_port: 1234 };
        let b = tcp_table::RemoteEndpoint { ip: "8.8.8.8".parse().unwrap(), port: 443, local_port: 5678 };
        let candidates = HashSet::from([a, b]);
        assert_eq!(select_candidate(&candidates, Some(443), None), None);
        assert_eq!(select_candidate(&candidates, Some(443), Some(a.ip)), Some(a.ip));
        assert_eq!(select_candidate(&candidates, Some(80), None), None);
    }
}
