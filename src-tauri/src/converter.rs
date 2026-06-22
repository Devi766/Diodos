use std::{
    collections::HashMap,
    fs, io,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::mpsc,
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose, Engine as _};
use serde_json::{json, Map, Value};
use tauri::{AppHandle, State};

use crate::{
    profiles::save_subscription,
    state::{AppState, ConverterServerHandle, RuntimeState},
    storage::{app_data_dir, set_setting, setting},
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

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

fn sanitize_file_name(name: &str) -> String {
    let sanitized = name
        .chars()
        .map(|ch| match ch {
            '/' | '\\' | '?' | '%' | '*' | ':' | '|' | '"' | '<' | '>' => '_',
            _ => ch,
        })
        .collect::<String>();
    let trimmed = sanitized.trim();
    if trimmed.is_empty() {
        format!("subscription_{}", now_millis())
    } else {
        trimmed.to_string()
    }
}

fn arg_string(args: &[Value], index: usize) -> Option<String> {
    args.get(index)
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

pub(crate) fn parse_proxy_names(input: &str) -> Value {
    let decoded = converter_source_text(input);
    let proxies = converter_parse_proxies(&decoded)
        .into_iter()
        .filter_map(|proxy| {
            Some(json!({
                "name": proxy.get("name").and_then(Value::as_str)?,
                "type": proxy.get("type").and_then(Value::as_str).unwrap_or("unknown"),
                "server": proxy.get("server").cloned().unwrap_or(Value::Null),
                "port": proxy.get("port").cloned().unwrap_or(Value::Null)
            }))
        })
        .collect::<Vec<_>>();
    let count = proxies.len();
    success(json!({
        "proxies": proxies,
        "count": count,
        "content": decoded
    }))
}

fn decode_base64_text(value: &str) -> Option<String> {
    let compact = value
        .trim()
        .chars()
        .filter(|ch| !ch.is_whitespace())
        .collect::<String>();
    if compact.is_empty() {
        return None;
    }

    let mut padded = compact.replace('-', "+").replace('_', "/");
    while padded.len() % 4 != 0 {
        padded.push('=');
    }

    general_purpose::STANDARD
        .decode(padded)
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
}

fn converter_source_text(input: &str) -> String {
    let trimmed = input.trim();
    if trimmed.contains("://") || trimmed.contains("proxies:") {
        return input.to_string();
    }

    decode_base64_text(trimmed)
        .filter(|decoded| decoded.contains("://") || decoded.contains("proxies:"))
        .unwrap_or_else(|| input.to_string())
}

fn decode_url_text(value: &str) -> String {
    urlencoding::decode(value)
        .map(|decoded| decoded.into_owned())
        .unwrap_or_else(|_| value.to_string())
}

fn converter_query_map(query: &str) -> HashMap<String, String> {
    query
        .split('&')
        .filter_map(|part| {
            let (key, value) = part.split_once('=').unwrap_or((part, ""));
            let key = decode_url_text(key);
            (!key.is_empty()).then(|| (key, decode_url_text(value)))
        })
        .collect()
}

fn converter_split_uri(
    raw: &str,
    scheme: &str,
) -> Option<(String, HashMap<String, String>, String)> {
    let mut body = raw.strip_prefix(scheme)?.to_string();
    let mut name = String::new();
    if let Some((left, fragment)) = body.split_once('#') {
        name = decode_url_text(fragment);
        body = left.to_string();
    }

    let mut query = HashMap::new();
    if let Some((left, query_string)) = body.split_once('?') {
        query = converter_query_map(query_string);
        body = left.to_string();
    }

    Some((body, query, name))
}

fn converter_split_host_port(value: &str) -> Option<(String, u16)> {
    let (host, port) = value.rsplit_once(':')?;
    let host = host.trim().trim_start_matches('[').trim_end_matches(']');
    let port = port.parse::<u16>().ok()?;
    (!host.is_empty()).then(|| (host.to_string(), port))
}

fn converter_split_user_host_port(value: &str) -> Option<(String, String, u16)> {
    let (user, host_port) = value.rsplit_once('@')?;
    let (host, port) = converter_split_host_port(host_port)?;
    Some((decode_url_text(user), host, port))
}

fn converter_insert_string(object: &mut Map<String, Value>, key: &str, value: Option<&String>) {
    if let Some(value) = value.filter(|value| !value.trim().is_empty()) {
        object.insert(key.to_string(), json!(value));
    }
}

fn converter_insert_bool_param(
    object: &mut Map<String, Value>,
    key: &str,
    query: &HashMap<String, String>,
    query_key: &str,
) {
    if let Some(value) = query.get(query_key) {
        let enabled = matches!(
            value.to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "allow"
        );
        object.insert(key.to_string(), json!(enabled));
    }
}

fn converter_parse_ss(line: &str) -> Option<Value> {
    let (body, query, name) = converter_split_uri(line, "ss://")?;
    let expanded = if body.contains('@') {
        body
    } else {
        decode_base64_text(&body)?
    };
    let (user_info, host, port) = converter_split_user_host_port(&expanded)?;
    let decoded_user = decode_base64_text(&user_info).unwrap_or(user_info);
    let (cipher, password) = decoded_user.split_once(':')?;
    let mut object = Map::new();
    object.insert(
        "name".to_string(),
        json!(if name.is_empty() {
            format!("{host}:{port}")
        } else {
            name
        }),
    );
    object.insert("type".to_string(), json!("ss"));
    object.insert("server".to_string(), json!(host));
    object.insert("port".to_string(), json!(port));
    object.insert("cipher".to_string(), json!(cipher));
    object.insert("password".to_string(), json!(password));
    converter_insert_string(&mut object, "plugin", query.get("plugin"));
    converter_insert_bool_param(&mut object, "udp-over-tcp", &query, "uot");
    Some(Value::Object(object))
}

fn converter_parse_vmess(line: &str) -> Option<Value> {
    let encoded = line.strip_prefix("vmess://")?;
    let decoded = decode_base64_text(encoded)?;
    let config = serde_json::from_str::<Value>(&decoded).ok()?;
    let server = config.get("add").and_then(Value::as_str)?.to_string();
    let port = config
        .get("port")
        .and_then(|value| {
            value
                .as_u64()
                .or_else(|| value.as_str().and_then(|text| text.parse::<u64>().ok()))
        })
        .unwrap_or(443);
    let name = config
        .get("ps")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(server.as_str());
    let network = config.get("net").and_then(Value::as_str).unwrap_or("tcp");
    let tls = config.get("tls").and_then(Value::as_str) == Some("tls");
    let mut object = Map::new();
    object.insert("name".to_string(), json!(name));
    object.insert("type".to_string(), json!("vmess"));
    object.insert("server".to_string(), json!(server));
    object.insert("port".to_string(), json!(port));
    object.insert(
        "uuid".to_string(),
        config.get("id").cloned().unwrap_or_else(|| json!("")),
    );
    object.insert(
        "alterId".to_string(),
        config.get("aid").cloned().unwrap_or_else(|| json!(0)),
    );
    object.insert(
        "cipher".to_string(),
        config.get("scy").cloned().unwrap_or_else(|| json!("auto")),
    );
    object.insert("network".to_string(), json!(network));
    if tls {
        object.insert("tls".to_string(), json!(true));
        if let Some(sni) = config
            .get("sni")
            .or_else(|| config.get("host"))
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
        {
            object.insert("servername".to_string(), json!(sni));
        }
    }
    if network == "ws" {
        let mut headers = Map::new();
        if let Some(host) = config.get("host").and_then(Value::as_str) {
            headers.insert("Host".to_string(), json!(host));
        }
        object.insert(
            "ws-opts".to_string(),
            json!({
                "path": config.get("path").and_then(Value::as_str).unwrap_or("/"),
                "headers": headers
            }),
        );
    } else if network == "grpc" {
        object.insert(
            "grpc-opts".to_string(),
            json!({ "grpc-service-name": config.get("path").and_then(Value::as_str).unwrap_or("") }),
        );
    }
    Some(Value::Object(object))
}

fn converter_parse_trojan(line: &str) -> Option<Value> {
    let (body, query, name) = converter_split_uri(line, "trojan://")?;
    let (password, server, port) = converter_split_user_host_port(&body)?;
    let mut object = Map::new();
    object.insert(
        "name".to_string(),
        json!(if name.is_empty() {
            format!("{server}:{port}")
        } else {
            name
        }),
    );
    object.insert("type".to_string(), json!("trojan"));
    object.insert("server".to_string(), json!(server));
    object.insert("port".to_string(), json!(port));
    object.insert("password".to_string(), json!(password));
    converter_insert_string(
        &mut object,
        "sni",
        query.get("sni").or_else(|| query.get("peer")),
    );
    converter_insert_string(&mut object, "network", query.get("type"));
    converter_insert_bool_param(&mut object, "skip-cert-verify", &query, "allowInsecure");
    converter_insert_bool_param(&mut object, "skip-cert-verify", &query, "insecure");
    if query.get("type").map(String::as_str) == Some("ws") {
        object.insert(
            "ws-opts".to_string(),
            json!({
                "path": query.get("path").map(String::as_str).unwrap_or("/"),
                "headers": { "Host": query.get("host").map(String::as_str).unwrap_or("") }
            }),
        );
    }
    Some(Value::Object(object))
}

fn converter_parse_vless(line: &str) -> Option<Value> {
    let (body, query, name) = converter_split_uri(line, "vless://")?;
    let (uuid, server, port) = converter_split_user_host_port(&body)?;
    let network = query.get("type").map(String::as_str).unwrap_or("tcp");
    let tls = matches!(
        query.get("security").map(|value| value.as_str()),
        Some("tls") | Some("reality")
    );
    let mut object = Map::new();
    object.insert(
        "name".to_string(),
        json!(if name.is_empty() {
            format!("{server}:{port}")
        } else {
            name
        }),
    );
    object.insert("type".to_string(), json!("vless"));
    object.insert("server".to_string(), json!(server));
    object.insert("port".to_string(), json!(port));
    object.insert("uuid".to_string(), json!(uuid));
    object.insert("network".to_string(), json!(network));
    if tls {
        object.insert("tls".to_string(), json!(true));
    }
    converter_insert_string(&mut object, "servername", query.get("sni"));
    converter_insert_string(&mut object, "flow", query.get("flow"));
    converter_insert_string(&mut object, "client-fingerprint", query.get("fp"));
    if let Some(short_id) = query.get("sid").filter(|value| !value.trim().is_empty()) {
        object.insert("reality-opts".to_string(), json!({ "short-id": short_id }));
    }
    converter_insert_bool_param(&mut object, "skip-cert-verify", &query, "allowInsecure");
    if network == "ws" {
        object.insert(
            "ws-opts".to_string(),
            json!({
                "path": query.get("path").map(String::as_str).unwrap_or("/"),
                "headers": { "Host": query.get("host").map(String::as_str).unwrap_or("") }
            }),
        );
    } else if network == "grpc" {
        object.insert(
            "grpc-opts".to_string(),
            json!({ "grpc-service-name": query.get("serviceName").map(String::as_str).unwrap_or("") }),
        );
    }
    Some(Value::Object(object))
}

fn converter_parse_hysteria2(line: &str) -> Option<Value> {
    let scheme = if line.starts_with("hysteria2://") {
        "hysteria2://"
    } else {
        "hy2://"
    };
    let (body, query, name) = converter_split_uri(line, scheme)?;
    let (password, server, port) = converter_split_user_host_port(&body)?;
    let mut object = Map::new();
    object.insert(
        "name".to_string(),
        json!(if name.is_empty() {
            format!("{server}:{port}")
        } else {
            name
        }),
    );
    object.insert("type".to_string(), json!("hysteria2"));
    object.insert("server".to_string(), json!(server));
    object.insert("port".to_string(), json!(port));
    object.insert("password".to_string(), json!(password));
    converter_insert_string(&mut object, "sni", query.get("sni"));
    converter_insert_bool_param(&mut object, "skip-cert-verify", &query, "insecure");
    Some(Value::Object(object))
}

fn converter_parse_tuic(line: &str) -> Option<Value> {
    let (body, query, name) = converter_split_uri(line, "tuic://")?;
    let (user, server, port) = converter_split_user_host_port(&body)?;
    let (uuid, password) = user.split_once(':')?;
    let mut object = Map::new();
    object.insert(
        "name".to_string(),
        json!(if name.is_empty() {
            format!("{server}:{port}")
        } else {
            name
        }),
    );
    object.insert("type".to_string(), json!("tuic"));
    object.insert("server".to_string(), json!(server));
    object.insert("port".to_string(), json!(port));
    object.insert("uuid".to_string(), json!(uuid));
    object.insert("password".to_string(), json!(password));
    converter_insert_string(&mut object, "sni", query.get("sni"));
    converter_insert_string(
        &mut object,
        "congestion-controller",
        query
            .get("congestion_control")
            .or_else(|| query.get("congestion-controller")),
    );
    converter_insert_bool_param(&mut object, "skip-cert-verify", &query, "allowInsecure");
    Some(Value::Object(object))
}

fn converter_proxy_from_line(line: &str) -> Option<Value> {
    let line = line.trim();
    if line.starts_with("ss://") {
        converter_parse_ss(line)
    } else if line.starts_with("vmess://") {
        converter_parse_vmess(line)
    } else if line.starts_with("trojan://") {
        converter_parse_trojan(line)
    } else if line.starts_with("vless://") {
        converter_parse_vless(line)
    } else if line.starts_with("hysteria2://") || line.starts_with("hy2://") {
        converter_parse_hysteria2(line)
    } else if line.starts_with("tuic://") {
        converter_parse_tuic(line)
    } else {
        None
    }
}

fn converter_yaml_proxies(input: &str) -> Option<Vec<Value>> {
    let yaml = serde_yaml::from_str::<serde_yaml::Value>(input).ok()?;
    let sequence = yaml
        .get("proxies")
        .and_then(serde_yaml::Value::as_sequence)
        .or_else(|| yaml.as_sequence())?;
    Some(
        sequence
            .iter()
            .filter_map(|item| serde_json::to_value(item).ok())
            .collect(),
    )
}

fn converter_parse_proxies(input: &str) -> Vec<Value> {
    let decoded = converter_source_text(input);
    if let Some(proxies) = converter_yaml_proxies(&decoded).filter(|items| !items.is_empty()) {
        return proxies;
    }

    decoded
        .lines()
        .filter_map(converter_proxy_from_line)
        .collect()
}

fn converter_apply_options(proxies: &mut [Value], options: Option<&Value>) {
    let Some(options) = options else {
        return;
    };
    let enable_udp = options
        .get("enableUdp")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let enable_tfo = options
        .get("enableTcpFastOpen")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let skip_cert = options
        .get("skipCertificateVerify")
        .or_else(|| options.get("skipCertVerify"))
        .and_then(Value::as_bool)
        .unwrap_or(false);

    for proxy in proxies {
        let Some(object) = proxy.as_object_mut() else {
            continue;
        };
        object.insert("udp".to_string(), json!(enable_udp));
        if enable_tfo {
            object.insert("tfo".to_string(), json!(true));
        }
        if skip_cert {
            object.insert("skip-cert-verify".to_string(), json!(true));
        }
    }
}

fn converter_filter_proxies(
    proxies: Vec<Value>,
    filter_regex: Option<&str>,
) -> Result<Vec<Value>, String> {
    let Some(filter) = filter_regex
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(proxies);
    };
    let regex = regex::RegexBuilder::new(filter)
        .case_insensitive(true)
        .build()
        .map_err(|err| err.to_string())?;
    Ok(proxies
        .into_iter()
        .filter(|proxy| {
            proxy
                .get("name")
                .and_then(Value::as_str)
                .map(|name| regex.is_match(name))
                .unwrap_or(false)
        })
        .collect())
}

fn converter_unique_names(proxies: &mut [Value]) {
    let mut counts = HashMap::<String, usize>::new();
    for proxy in proxies {
        let Some(object) = proxy.as_object_mut() else {
            continue;
        };
        let name = object
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("Proxy")
            .to_string();
        let count = counts.entry(name.clone()).or_insert(0);
        *count += 1;
        if *count > 1 {
            object.insert("name".to_string(), json!(format!("{name} {}", count)));
        } else if name.trim().is_empty() {
            object.insert("name".to_string(), json!("Proxy"));
        }
    }
}

fn converter_mihomo_yaml(proxies: &[Value]) -> Result<String, String> {
    let names = proxies
        .iter()
        .filter_map(|proxy| proxy.get("name").and_then(Value::as_str))
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    let mut select_names = vec!["Auto".to_string(), "DIRECT".to_string()];
    select_names.extend(names.clone());
    let config = json!({
        "mixed-port": 7890,
        "allow-lan": false,
        "mode": "rule",
        "log-level": "info",
        "dns": {
            "enable": true,
            "enhanced-mode": "fake-ip",
            "fake-ip-range": "198.18.0.1/16",
            "nameserver": ["https://doh.pub/dns-query", "https://dns.alidns.com/dns-query"]
        },
        "proxies": proxies,
        "proxy-groups": [
            {
                "name": "Proxy",
                "type": "select",
                "proxies": select_names
            },
            {
                "name": "Auto",
                "type": "url-test",
                "proxies": names,
                "url": "http://www.gstatic.com/generate_204",
                "interval": 300
            }
        ],
        "rules": ["MATCH,Proxy"]
    });
    serde_yaml::to_string(&config).map_err(|err| err.to_string())
}

fn proxy_str<'a>(proxy: &'a Value, key: &str) -> Option<&'a str> {
    proxy.get(key).and_then(Value::as_str)
}

fn proxy_u64(proxy: &Value, key: &str) -> Option<u64> {
    proxy
        .get(key)
        .and_then(|value| value.as_u64().or_else(|| value.as_str()?.parse().ok()))
}

fn proxy_bool(proxy: &Value, key: &str) -> bool {
    proxy.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn sing_box_tls(proxy: &Value, default_enabled: bool) -> Option<Value> {
    let enabled = proxy_bool(proxy, "tls") || default_enabled;
    if !enabled {
        return None;
    }

    let mut tls = Map::new();
    tls.insert("enabled".to_string(), json!(true));
    if let Some(server_name) = proxy_str(proxy, "servername").or_else(|| proxy_str(proxy, "sni")) {
        if !server_name.trim().is_empty() {
            tls.insert("server_name".to_string(), json!(server_name));
        }
    }
    if proxy_bool(proxy, "skip-cert-verify") {
        tls.insert("insecure".to_string(), json!(true));
    }
    if let Some(fingerprint) = proxy_str(proxy, "client-fingerprint") {
        tls.insert(
            "utls".to_string(),
            json!({ "enabled": true, "fingerprint": fingerprint }),
        );
    }
    Some(Value::Object(tls))
}

fn sing_box_transport(proxy: &Value) -> Option<Value> {
    match proxy_str(proxy, "network") {
        Some("ws") => {
            let ws_opts = proxy.get("ws-opts").and_then(Value::as_object);
            let path = ws_opts
                .and_then(|opts| opts.get("path"))
                .and_then(Value::as_str)
                .unwrap_or("/");
            let headers = ws_opts
                .and_then(|opts| opts.get("headers"))
                .cloned()
                .unwrap_or_else(|| json!({}));
            Some(json!({
                "type": "ws",
                "path": path,
                "headers": headers
            }))
        }
        Some("grpc") => {
            let service_name = proxy
                .get("grpc-opts")
                .and_then(Value::as_object)
                .and_then(|opts| opts.get("grpc-service-name"))
                .and_then(Value::as_str)
                .unwrap_or("");
            Some(json!({
                "type": "grpc",
                "service_name": service_name
            }))
        }
        _ => None,
    }
}

fn sing_box_outbound(proxy: &Value) -> Option<Value> {
    let name = proxy_str(proxy, "name")?;
    let server = proxy_str(proxy, "server")?;
    let port = proxy_u64(proxy, "port")?;
    let proxy_type = proxy_str(proxy, "type")?;

    let mut object = Map::new();
    object.insert("tag".to_string(), json!(name));
    object.insert("server".to_string(), json!(server));
    object.insert("server_port".to_string(), json!(port));

    match proxy_type {
        "ss" => {
            object.insert("type".to_string(), json!("shadowsocks"));
            object.insert(
                "method".to_string(),
                json!(proxy_str(proxy, "cipher").unwrap_or("aes-128-gcm")),
            );
            object.insert(
                "password".to_string(),
                json!(proxy_str(proxy, "password").unwrap_or("")),
            );
        }
        "vmess" => {
            object.insert("type".to_string(), json!("vmess"));
            object.insert(
                "uuid".to_string(),
                json!(proxy_str(proxy, "uuid").unwrap_or("")),
            );
            object.insert(
                "security".to_string(),
                json!(proxy_str(proxy, "cipher").unwrap_or("auto")),
            );
            if let Some(alter_id) =
                proxy_u64(proxy, "alterId").or_else(|| proxy_u64(proxy, "alter-id"))
            {
                object.insert("alter_id".to_string(), json!(alter_id));
            }
            if let Some(tls) = sing_box_tls(proxy, false) {
                object.insert("tls".to_string(), tls);
            }
            if let Some(transport) = sing_box_transport(proxy) {
                object.insert("transport".to_string(), transport);
            }
        }
        "trojan" => {
            object.insert("type".to_string(), json!("trojan"));
            object.insert(
                "password".to_string(),
                json!(proxy_str(proxy, "password").unwrap_or("")),
            );
            if let Some(tls) = sing_box_tls(proxy, true) {
                object.insert("tls".to_string(), tls);
            }
            if let Some(transport) = sing_box_transport(proxy) {
                object.insert("transport".to_string(), transport);
            }
        }
        "vless" => {
            object.insert("type".to_string(), json!("vless"));
            object.insert(
                "uuid".to_string(),
                json!(proxy_str(proxy, "uuid").unwrap_or("")),
            );
            if let Some(flow) = proxy_str(proxy, "flow") {
                object.insert("flow".to_string(), json!(flow));
            }
            if let Some(tls) = sing_box_tls(proxy, false) {
                object.insert("tls".to_string(), tls);
            }
            if let Some(transport) = sing_box_transport(proxy) {
                object.insert("transport".to_string(), transport);
            }
        }
        "hysteria2" => {
            object.insert("type".to_string(), json!("hysteria2"));
            object.insert(
                "password".to_string(),
                json!(proxy_str(proxy, "password").unwrap_or("")),
            );
            if let Some(tls) = sing_box_tls(proxy, true) {
                object.insert("tls".to_string(), tls);
            }
        }
        "tuic" => {
            object.insert("type".to_string(), json!("tuic"));
            object.insert(
                "uuid".to_string(),
                json!(proxy_str(proxy, "uuid").unwrap_or("")),
            );
            object.insert(
                "password".to_string(),
                json!(proxy_str(proxy, "password").unwrap_or("")),
            );
            if let Some(congestion) = proxy_str(proxy, "congestion-controller") {
                object.insert("congestion_control".to_string(), json!(congestion));
            }
            if let Some(tls) = sing_box_tls(proxy, true) {
                object.insert("tls".to_string(), tls);
            }
        }
        _ => return None,
    }

    Some(Value::Object(object))
}

fn converter_sing_box_json(proxies: &[Value]) -> Result<String, String> {
    let outbounds = proxies
        .iter()
        .filter_map(sing_box_outbound)
        .collect::<Vec<_>>();
    if outbounds.is_empty() {
        return Err("没有可转换为 sing-box 的代理节点".to_string());
    }

    let names = outbounds
        .iter()
        .filter_map(|outbound| outbound.get("tag").and_then(Value::as_str))
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    let mut selector = vec!["auto".to_string(), "direct".to_string()];
    selector.extend(names.clone());

    let mut all_outbounds = vec![
        json!({
            "type": "selector",
            "tag": "proxy",
            "outbounds": selector,
            "default": "auto"
        }),
        json!({
            "type": "urltest",
            "tag": "auto",
            "outbounds": names,
            "url": "https://www.gstatic.com/generate_204",
            "interval": "5m"
        }),
        json!({ "type": "direct", "tag": "direct" }),
        json!({ "type": "block", "tag": "block" }),
    ];
    all_outbounds.extend(outbounds);

    let config = json!({
        "log": { "level": "info" },
        "dns": {
            "servers": [
                { "tag": "dns_proxy", "address": "https://dns.google/dns-query", "detour": "proxy" },
                { "tag": "dns_direct", "address": "223.5.5.5", "detour": "direct" }
            ],
            "final": "dns_proxy"
        },
        "inbounds": [
            {
                "type": "mixed",
                "tag": "mixed-in",
                "listen": "127.0.0.1",
                "listen_port": 7890
            }
        ],
        "outbounds": all_outbounds,
        "route": {
            "rules": [
                { "protocol": "dns", "outbound": "dns_proxy" }
            ],
            "final": "proxy",
            "auto_detect_interface": true
        }
    });

    serde_json::to_string_pretty(&config).map_err(|err| err.to_string())
}

fn converter_ws_path(proxy: &Value) -> Option<&str> {
    proxy
        .get("ws-opts")
        .and_then(Value::as_object)
        .and_then(|opts| opts.get("path"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
}

fn converter_ws_host(proxy: &Value) -> Option<&str> {
    proxy
        .get("ws-opts")
        .and_then(Value::as_object)
        .and_then(|opts| opts.get("headers"))
        .and_then(Value::as_object)
        .and_then(|headers| headers.get("Host").or_else(|| headers.get("host")))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
}

fn converter_sni(proxy: &Value) -> Option<&str> {
    proxy_str(proxy, "sni")
        .or_else(|| proxy_str(proxy, "servername"))
        .filter(|value| !value.trim().is_empty())
}

fn converter_join_query(pairs: Vec<(&str, String)>) -> String {
    pairs
        .into_iter()
        .filter(|(_, value)| !value.trim().is_empty())
        .map(|(key, value)| {
            format!(
                "{}={}",
                urlencoding::encode(key),
                urlencoding::encode(&value)
            )
        })
        .collect::<Vec<_>>()
        .join("&")
}

fn converter_surge_line(proxy: &Value) -> Option<String> {
    let name = proxy_str(proxy, "name")?;
    let server = proxy_str(proxy, "server")?;
    let port = proxy_u64(proxy, "port")?;
    let proxy_type = proxy_str(proxy, "type")?;
    let mut parts = Vec::<String>::new();

    match proxy_type {
        "ss" => {
            parts.push(format!("{name} = ss"));
            parts.push(server.to_string());
            parts.push(port.to_string());
            parts.push(format!(
                "encrypt-method={}",
                proxy_str(proxy, "cipher").unwrap_or("aes-128-gcm")
            ));
            parts.push(format!(
                "password={}",
                proxy_str(proxy, "password").unwrap_or("")
            ));
        }
        "vmess" => {
            parts.push(format!("{name} = vmess"));
            parts.push(server.to_string());
            parts.push(port.to_string());
            parts.push(format!(
                "username={}",
                proxy_str(proxy, "uuid").unwrap_or("")
            ));
            if proxy_bool(proxy, "tls") {
                parts.push("tls=true".to_string());
            }
            if let Some(sni) = converter_sni(proxy) {
                parts.push(format!("sni={sni}"));
            }
            if proxy_str(proxy, "network") == Some("ws") {
                parts.push("ws=true".to_string());
                if let Some(path) = converter_ws_path(proxy) {
                    parts.push(format!("ws-path={path}"));
                }
                if let Some(host) = converter_ws_host(proxy) {
                    parts.push(format!("ws-headers=Host:{host}"));
                }
            }
        }
        "trojan" => {
            parts.push(format!("{name} = trojan"));
            parts.push(server.to_string());
            parts.push(port.to_string());
            parts.push(format!(
                "password={}",
                proxy_str(proxy, "password").unwrap_or("")
            ));
            if let Some(sni) = converter_sni(proxy) {
                parts.push(format!("sni={sni}"));
            }
            if proxy_str(proxy, "network") == Some("ws") {
                parts.push("ws=true".to_string());
                if let Some(path) = converter_ws_path(proxy) {
                    parts.push(format!("ws-path={path}"));
                }
                if let Some(host) = converter_ws_host(proxy) {
                    parts.push(format!("ws-headers=Host:{host}"));
                }
            }
        }
        "http" | "socks5" => {
            parts.push(format!("{name} = {proxy_type}"));
            parts.push(server.to_string());
            parts.push(port.to_string());
            if let Some(username) = proxy_str(proxy, "username") {
                parts.push(format!("username={username}"));
            }
            if let Some(password) = proxy_str(proxy, "password") {
                parts.push(format!("password={password}"));
            }
        }
        "hysteria2" => {
            parts.push(format!("{name} = hysteria2"));
            parts.push(server.to_string());
            parts.push(port.to_string());
            parts.push(format!(
                "password=\"{}\"",
                proxy_str(proxy, "password").unwrap_or("")
            ));
            if let Some(sni) = converter_sni(proxy) {
                parts.push(format!("sni={sni}"));
            }
        }
        "tuic" => {
            parts.push(format!("{name} = tuic-v5"));
            parts.push(server.to_string());
            parts.push(port.to_string());
            if let Some(uuid) = proxy_str(proxy, "uuid") {
                parts.push(format!("uuid={uuid}"));
            }
            if let Some(password) = proxy_str(proxy, "password") {
                parts.push(format!("password=\"{password}\""));
            }
            if let Some(sni) = converter_sni(proxy) {
                parts.push(format!("sni={sni}"));
            }
        }
        _ => return None,
    }

    if proxy_bool(proxy, "udp") {
        parts.push("udp-relay=true".to_string());
    }
    if proxy_bool(proxy, "skip-cert-verify") {
        parts.push("skip-cert-verify=true".to_string());
    }

    Some(parts.join(", "))
}

fn converter_surge_config(proxies: &[Value]) -> Result<String, String> {
    let converted = proxies
        .iter()
        .filter_map(|proxy| {
            let line = converter_surge_line(proxy)?;
            let name = proxy_str(proxy, "name")?.to_string();
            Some((name, line))
        })
        .collect::<Vec<_>>();
    if converted.is_empty() {
        return Err("没有可转换为 Surge 的代理节点".to_string());
    }

    let names = converted
        .iter()
        .map(|(name, _)| name.clone())
        .collect::<Vec<_>>();
    let proxy_lines = converted
        .iter()
        .map(|(_, line)| line.clone())
        .collect::<Vec<_>>();
    let mut select = vec!["Auto".to_string(), "DIRECT".to_string()];
    select.extend(names.clone());

    Ok(vec![
        "[General]".to_string(),
        "loglevel = notify".to_string(),
        "dns-server = 223.5.5.5, 119.29.29.29, 8.8.8.8".to_string(),
        "skip-proxy = 127.0.0.1, 192.168.0.0/16, 10.0.0.0/8, 172.16.0.0/12, localhost, *.local"
            .to_string(),
        String::new(),
        "[Proxy]".to_string(),
        proxy_lines.join("\n"),
        String::new(),
        "[Proxy Group]".to_string(),
        format!("Proxy = select, {}", select.join(", ")),
        format!(
            "Auto = url-test, {}, url=http://www.gstatic.com/generate_204, interval=300",
            names.join(", ")
        ),
        String::new(),
        "[Rule]".to_string(),
        "FINAL,Proxy".to_string(),
    ]
    .join("\n"))
}

fn converter_quantumult_x_line(proxy: &Value) -> Option<String> {
    let name = proxy_str(proxy, "name")?;
    let server = proxy_str(proxy, "server")?;
    let port = proxy_u64(proxy, "port")?;
    let proxy_type = proxy_str(proxy, "type")?;

    let mut line = match proxy_type {
        "ss" => format!(
            "shadowsocks={server}:{port}, method={}, password={}",
            proxy_str(proxy, "cipher").unwrap_or("aes-128-gcm"),
            proxy_str(proxy, "password").unwrap_or("")
        ),
        "vmess" => {
            let mut line = format!(
                "vmess={server}:{port}, method=chacha20-poly1305, password={}",
                proxy_str(proxy, "uuid").unwrap_or("")
            );
            if proxy_bool(proxy, "tls") {
                line.push_str(", obfs=over-tls");
            }
            if let Some(path) = converter_ws_path(proxy) {
                line.push_str(&format!(", obfs-uri={path}"));
            }
            if let Some(host) = converter_ws_host(proxy) {
                line.push_str(&format!(", obfs-host={host}"));
            }
            line
        }
        "trojan" => {
            let mut line = format!(
                "trojan={server}:{port}, password={}, over-tls=true",
                proxy_str(proxy, "password").unwrap_or("")
            );
            if let Some(sni) = converter_sni(proxy) {
                line.push_str(&format!(", tls-host={sni}"));
            }
            line
        }
        "http" | "socks5" => {
            let mut line = format!("{proxy_type}={server}:{port}");
            if let Some(username) = proxy_str(proxy, "username") {
                line.push_str(&format!(", username={username}"));
            }
            if let Some(password) = proxy_str(proxy, "password") {
                line.push_str(&format!(", password={password}"));
            }
            line
        }
        "hysteria2" => {
            let mut line = format!(
                "hysteria2={server}:{port}, password={}",
                proxy_str(proxy, "password").unwrap_or("")
            );
            if let Some(sni) = converter_sni(proxy) {
                line.push_str(&format!(", sni={sni}"));
            }
            line
        }
        _ => return None,
    };

    if proxy_bool(proxy, "skip-cert-verify") {
        line.push_str(", tls-verification=false");
    }
    line.push_str(&format!(", tag={name}"));
    Some(line)
}

fn converter_quantumult_x_config(proxies: &[Value]) -> Result<String, String> {
    let converted = proxies
        .iter()
        .filter_map(|proxy| {
            let line = converter_quantumult_x_line(proxy)?;
            let name = proxy_str(proxy, "name")?.to_string();
            Some((name, line))
        })
        .collect::<Vec<_>>();
    if converted.is_empty() {
        return Err("没有可转换为 Quantumult X 的代理节点".to_string());
    }

    let names = converted
        .iter()
        .map(|(name, _)| name.clone())
        .collect::<Vec<_>>();
    let proxy_lines = converted
        .iter()
        .map(|(_, line)| line.clone())
        .collect::<Vec<_>>();
    let mut select = vec!["Auto".to_string(), "direct".to_string()];
    select.extend(names.clone());

    Ok(vec![
        "[general]".to_string(),
        "server_check_url=http://www.gstatic.com/generate_204".to_string(),
        "dns_exclusion_list=*.cmpassport.com, *.jegotrip.com.cn, *.icitymobile.mobi, id6.me".to_string(),
        String::new(),
        "[dns]".to_string(),
        "server=223.5.5.5".to_string(),
        "server=119.29.29.29".to_string(),
        "server=8.8.8.8".to_string(),
        String::new(),
        "[policy]".to_string(),
        format!("static=Proxy, {}", select.join(", ")),
        format!(
            "url-latency-benchmark=Auto, {}, check-interval=300, url=http://www.gstatic.com/generate_204",
            names.join(", ")
        ),
        String::new(),
        "[server_local]".to_string(),
        proxy_lines.join("\n"),
        String::new(),
        "[filter_local]".to_string(),
        "FINAL,Proxy".to_string(),
    ]
    .join("\n"))
}

fn converter_uri_query(proxy: &Value, include_network: bool) -> String {
    let mut pairs = Vec::<(&str, String)>::new();
    if let Some(sni) = converter_sni(proxy) {
        pairs.push(("sni", sni.to_string()));
    }
    if proxy_bool(proxy, "skip-cert-verify") {
        pairs.push(("allowInsecure", "1".to_string()));
    }
    if include_network {
        if let Some(network) = proxy_str(proxy, "network") {
            pairs.push(("type", network.to_string()));
            if network == "ws" {
                if let Some(path) = converter_ws_path(proxy) {
                    pairs.push(("path", path.to_string()));
                }
                if let Some(host) = converter_ws_host(proxy) {
                    pairs.push(("host", host.to_string()));
                }
            }
        }
    }
    converter_join_query(pairs)
}

fn converter_shadowrocket_uri(proxy: &Value) -> Option<String> {
    let name = urlencoding::encode(proxy_str(proxy, "name")?).into_owned();
    let server = proxy_str(proxy, "server")?;
    let port = proxy_u64(proxy, "port")?;
    let proxy_type = proxy_str(proxy, "type")?;

    match proxy_type {
        "ss" => {
            let user = format!(
                "{}:{}",
                proxy_str(proxy, "cipher").unwrap_or("aes-128-gcm"),
                proxy_str(proxy, "password").unwrap_or("")
            );
            let encoded = general_purpose::STANDARD.encode(user);
            Some(format!("ss://{encoded}@{server}:{port}#{name}"))
        }
        "vmess" => {
            let config = json!({
                "v": "2",
                "ps": proxy_str(proxy, "name").unwrap_or("Proxy"),
                "add": server,
                "port": port.to_string(),
                "id": proxy_str(proxy, "uuid").unwrap_or(""),
                "aid": proxy_u64(proxy, "alterId").or_else(|| proxy_u64(proxy, "alter-id")).unwrap_or(0).to_string(),
                "scy": proxy_str(proxy, "cipher").unwrap_or("auto"),
                "net": proxy_str(proxy, "network").unwrap_or("tcp"),
                "type": "none",
                "tls": if proxy_bool(proxy, "tls") { "tls" } else { "" },
                "sni": converter_sni(proxy).unwrap_or("")
            });
            let encoded = general_purpose::STANDARD.encode(config.to_string());
            Some(format!("vmess://{encoded}"))
        }
        "trojan" => {
            let query = converter_uri_query(proxy, true);
            let password = urlencoding::encode(proxy_str(proxy, "password").unwrap_or(""));
            Some(if query.is_empty() {
                format!("trojan://{password}@{server}:{port}#{name}")
            } else {
                format!("trojan://{password}@{server}:{port}?{query}#{name}")
            })
        }
        "vless" => {
            let mut pairs = Vec::<(&str, String)>::new();
            pairs.push((
                "security",
                if proxy_bool(proxy, "tls") {
                    "tls"
                } else {
                    "none"
                }
                .to_string(),
            ));
            if let Some(flow) = proxy_str(proxy, "flow") {
                pairs.push(("flow", flow.to_string()));
            }
            let extra = converter_uri_query(proxy, true);
            let mut query = converter_join_query(pairs);
            if !extra.is_empty() {
                if !query.is_empty() {
                    query.push('&');
                }
                query.push_str(&extra);
            }
            Some(format!(
                "vless://{}@{server}:{port}?{query}#{name}",
                urlencoding::encode(proxy_str(proxy, "uuid").unwrap_or(""))
            ))
        }
        "hysteria2" => {
            let mut pairs = Vec::<(&str, String)>::new();
            if let Some(sni) = converter_sni(proxy) {
                pairs.push(("sni", sni.to_string()));
            }
            if proxy_bool(proxy, "skip-cert-verify") {
                pairs.push(("insecure", "1".to_string()));
            }
            let query = converter_join_query(pairs);
            let password = urlencoding::encode(proxy_str(proxy, "password").unwrap_or(""));
            Some(if query.is_empty() {
                format!("hysteria2://{password}@{server}:{port}#{name}")
            } else {
                format!("hysteria2://{password}@{server}:{port}?{query}#{name}")
            })
        }
        "tuic" => {
            let mut pairs = Vec::<(&str, String)>::new();
            if let Some(sni) = converter_sni(proxy) {
                pairs.push(("sni", sni.to_string()));
            }
            if let Some(congestion) = proxy_str(proxy, "congestion-controller") {
                pairs.push(("congestion_control", congestion.to_string()));
            }
            if proxy_bool(proxy, "skip-cert-verify") {
                pairs.push(("insecure", "1".to_string()));
            }
            let query = converter_join_query(pairs);
            let uuid = urlencoding::encode(proxy_str(proxy, "uuid").unwrap_or(""));
            let password = urlencoding::encode(proxy_str(proxy, "password").unwrap_or(""));
            Some(if query.is_empty() {
                format!("tuic://{uuid}:{password}@{server}:{port}#{name}")
            } else {
                format!("tuic://{uuid}:{password}@{server}:{port}?{query}#{name}")
            })
        }
        "socks5" | "http" => {
            let scheme = if proxy_type == "socks5" {
                "socks5"
            } else if proxy_bool(proxy, "tls") {
                "https"
            } else {
                "http"
            };
            let auth = match (proxy_str(proxy, "username"), proxy_str(proxy, "password")) {
                (Some(username), Some(password)) => format!(
                    "{}:{}@",
                    urlencoding::encode(username),
                    urlencoding::encode(password)
                ),
                _ => String::new(),
            };
            Some(format!("{scheme}://{auth}{server}:{port}#{name}"))
        }
        _ => None,
    }
}

fn converter_shadowrocket_config(proxies: &[Value]) -> Result<String, String> {
    let converted = proxies
        .iter()
        .filter_map(|proxy| {
            let line = converter_shadowrocket_uri(proxy)?;
            let name = proxy_str(proxy, "name")?.to_string();
            Some((name, line))
        })
        .collect::<Vec<_>>();
    if converted.is_empty() {
        return Err("没有可转换为 Shadowrocket 的代理节点".to_string());
    }

    let names = converted
        .iter()
        .map(|(name, _)| name.clone())
        .collect::<Vec<_>>();
    let proxy_lines = converted
        .iter()
        .map(|(_, line)| line.clone())
        .collect::<Vec<_>>();
    let mut select = vec!["Auto".to_string(), "DIRECT".to_string()];
    select.extend(names.clone());

    Ok(vec![
        "[General]".to_string(),
        "bypass-system = true".to_string(),
        "skip-proxy = 192.168.0.0/16, 10.0.0.0/8, 172.16.0.0/12, localhost, *.local, captive.apple.com".to_string(),
        "dns-server = 223.5.5.5, 119.29.29.29, 8.8.8.8".to_string(),
        String::new(),
        "[Proxy]".to_string(),
        proxy_lines.join("\n"),
        String::new(),
        "[Proxy Group]".to_string(),
        format!("Proxy = select, {}", select.join(", ")),
        format!(
            "Auto = url-test, {}, url=http://www.gstatic.com/generate_204, interval=300",
            names.join(", ")
        ),
        String::new(),
        "[Rule]".to_string(),
        "FINAL,Proxy".to_string(),
    ]
    .join("\n"))
}

pub(crate) fn converter_conversion_payload(
    input: &str,
    target_format: Option<&str>,
    filter_regex: Option<&str>,
    options: Option<&Value>,
    template_id: Option<&str>,
) -> Value {
    let target = target_format.unwrap_or("clash-meta");
    if !matches!(
        target,
        "clash" | "clash-meta" | "sing-box" | "surge" | "quantumult-x" | "shadowrocket"
    ) {
        return json!({
            "success": false,
            "output": "",
            "inputProxyCount": 0,
            "outputProxyCount": 0,
            "errorMessage": format!("Tauri 暂不支持转换为 {target}")
        });
    }

    let template = template_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|id| {
            converter_templates()
                .as_array()
                .and_then(|templates| {
                    templates
                        .iter()
                        .find(|template| template.get("id").and_then(Value::as_str) == Some(id))
                })
                .cloned()
                .ok_or_else(|| format!("模板不存在: {id}"))
        })
        .transpose();
    let template = match template {
        Ok(template) => template,
        Err(error) => {
            return json!({
                "success": false,
                "output": "",
                "inputProxyCount": 0,
                "outputProxyCount": 0,
                "errorMessage": error
            })
        }
    };

    let input_proxies = converter_parse_proxies(input);
    let input_count = input_proxies.len();
    let mut proxies = match converter_filter_proxies(input_proxies, filter_regex) {
        Ok(proxies) => proxies,
        Err(error) => {
            return json!({
                "success": false,
                "output": "",
                "inputProxyCount": input_count,
                "outputProxyCount": 0,
                "errorMessage": error
            })
        }
    };
    converter_unique_names(&mut proxies);
    converter_apply_options(&mut proxies, options);

    if proxies.is_empty() {
        return json!({
            "success": false,
            "output": "",
            "inputProxyCount": input_count,
            "outputProxyCount": 0,
            "errorMessage": "未检测到有效的代理节点"
        });
    }

    let generated = match target {
        "sing-box" => converter_sing_box_json(&proxies),
        "surge" => converter_surge_config(&proxies),
        "quantumult-x" => converter_quantumult_x_config(&proxies),
        "shadowrocket" => converter_shadowrocket_config(&proxies),
        _ => converter_mihomo_yaml(&proxies),
    };

    match generated {
        Ok(output) => success(json!({
            "output": output,
            "content": output,
            "result": output,
            "inputProxyCount": input_count,
            "outputProxyCount": proxies.len(),
            "errorMessage": Value::Null,
            "templateId": template
                .as_ref()
                .and_then(|template| template.get("id"))
                .cloned()
                .unwrap_or(Value::Null),
            "templateName": template
                .as_ref()
                .and_then(|template| template.get("name"))
                .cloned()
                .unwrap_or(Value::Null),
            "proxies": proxies
        })),
        Err(error) => json!({
            "success": false,
            "output": "",
            "inputProxyCount": input_count,
            "outputProxyCount": 0,
            "errorMessage": error
        }),
    }
}

pub(crate) fn converter_templates() -> Value {
    json!([
        {
            "id": "mihomo-default",
            "name": "Mihomo 默认模板",
            "description": "保留订阅原始结构并补充 FlyClash 运行参数",
            "target": "mihomo"
        }
    ])
}

fn converter_settings(app: &AppHandle) -> Result<Value, String> {
    Ok(setting(
        app,
        "converterSettings",
        json!({
            "port": 59999,
            "autoStart": false,
            "userAgent": "FlyClash-Converter/1.0"
        }),
    )?)
}

fn converter_port(app: &AppHandle) -> Result<u16, String> {
    Ok(converter_settings(app)?
        .get("port")
        .and_then(Value::as_u64)
        .filter(|port| (1..=65535).contains(port))
        .unwrap_or(59999) as u16)
}

fn converter_subscription_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app_data_dir(app)?.join("converter-subscriptions");
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    Ok(dir)
}

fn converter_subscription_file(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    Ok(converter_subscription_dir(app)?.join(format!("{}.json", sanitize_file_name(id))))
}

fn converter_public_url(port: u16, id: &str) -> String {
    format!("http://127.0.0.1:{port}/sub/{id}")
}

fn converter_content_type(target_format: &str) -> &'static str {
    match target_format {
        "sing-box" => "application/json; charset=utf-8",
        "clash" | "clash-meta" | "mihomo" => "application/yaml; charset=utf-8",
        _ => "text/plain; charset=utf-8",
    }
}

fn converter_file_extension(target_format: &str) -> &'static str {
    match target_format {
        "sing-box" => "json",
        "clash" | "clash-meta" | "mihomo" => "yaml",
        _ => "txt",
    }
}

fn converter_read_subscription(path: &Path) -> Option<Value> {
    fs::read_to_string(path)
        .ok()
        .and_then(|content| serde_json::from_str::<Value>(&content).ok())
}

fn converter_subscription_count(app: &AppHandle) -> usize {
    converter_subscription_dir(app)
        .ok()
        .and_then(|dir| fs::read_dir(dir).ok())
        .map(|entries| {
            entries
                .filter_map(|entry| entry.ok())
                .filter(|entry| {
                    entry.path().extension().and_then(|value| value.to_str()) == Some("json")
                })
                .count()
        })
        .unwrap_or(0)
}

fn converter_list_from_dir(dir: &Path, port: u16) -> Vec<Value> {
    fs::read_dir(dir)
        .ok()
        .into_iter()
        .flat_map(|entries| entries.filter_map(|entry| entry.ok()))
        .filter_map(|entry| converter_read_subscription(&entry.path()))
        .filter_map(|record| {
            let id = record.get("id").and_then(Value::as_str)?.to_string();
            Some(json!({
                "id": id,
                "name": record.get("name").and_then(Value::as_str).unwrap_or("Converted"),
                "targetFormat": record.get("targetFormat").and_then(Value::as_str).unwrap_or("clash-meta"),
                "lastUpdate": record.get("lastUpdate").and_then(Value::as_u64).unwrap_or(0),
                "url": converter_public_url(port, &id)
            }))
        })
        .collect()
}

fn converter_http_response(
    stream: &mut TcpStream,
    status: &str,
    content_type: &str,
    body: &[u8],
    extra_headers: &[String],
) -> io::Result<()> {
    let mut headers = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-cache\r\nConnection: close\r\n",
        body.len()
    );
    for header in extra_headers {
        headers.push_str(header);
        headers.push_str("\r\n");
    }
    headers.push_str("\r\n");
    stream.write_all(headers.as_bytes())?;
    stream.write_all(body)
}

fn converter_handle_stream(mut stream: TcpStream, dir: &Path, port: u16) {
    let mut buffer = [0u8; 8192];
    let Ok(size) = stream.read(&mut buffer) else {
        return;
    };
    if size == 0 {
        return;
    }

    let request = String::from_utf8_lossy(&buffer[..size]);
    let path = request
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .unwrap_or("/");

    if path == "/list" {
        let body = serde_json::to_vec_pretty(&converter_list_from_dir(dir, port))
            .unwrap_or_else(|_| b"[]".to_vec());
        let _ = converter_http_response(
            &mut stream,
            "200 OK",
            "application/json; charset=utf-8",
            &body,
            &[],
        );
        return;
    }

    if let Some(id) = path.strip_prefix("/sub/").filter(|id| !id.is_empty()) {
        let file = dir.join(format!("{}.json", sanitize_file_name(id)));
        if let Some(record) = converter_read_subscription(&file) {
            let content = record
                .get("content")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .as_bytes()
                .to_vec();
            let target_format = record
                .get("targetFormat")
                .and_then(Value::as_str)
                .unwrap_or("clash-meta");
            let name = sanitize_file_name(
                record
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("subscription"),
            );
            let disposition = format!(
                "Content-Disposition: attachment; filename=\"{}.{}\"",
                name,
                converter_file_extension(target_format)
            );
            let _ = converter_http_response(
                &mut stream,
                "200 OK",
                converter_content_type(target_format),
                &content,
                &[disposition],
            );
            return;
        }

        let _ = converter_http_response(
            &mut stream,
            "404 Not Found",
            "text/plain; charset=utf-8",
            b"Subscription not found",
            &[],
        );
        return;
    }

    let _ = converter_http_response(
        &mut stream,
        "404 Not Found",
        "text/plain; charset=utf-8",
        b"Not Found",
        &[],
    );
}

fn converter_server_loop(listener: TcpListener, dir: PathBuf, port: u16, stop: mpsc::Receiver<()>) {
    loop {
        if stop.try_recv().is_ok() {
            break;
        }
        match listener.accept() {
            Ok((stream, _)) => converter_handle_stream(stream, &dir, port),
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(100));
            }
            Err(_) => break,
        }
    }
}

fn converter_stop_locked(runtime: &mut RuntimeState) {
    if let Some(mut handle) = runtime.converter_server.take() {
        let _ = handle.stop.send(());
        if let Some(thread) = handle.thread.take() {
            let _ = thread.join();
        }
    }
}

fn converter_start_server(app: &AppHandle, state: &State<'_, AppState>) -> CompatResult {
    let port = converter_port(app)?;
    let dir = converter_subscription_dir(app)?;
    let mut runtime = state.runtime.lock().map_err(|err| err.to_string())?;

    if runtime
        .converter_server
        .as_ref()
        .is_some_and(|handle| handle.port == port)
    {
        return Ok(success(json!({
            "isRunning": true,
            "running": true,
            "port": port,
            "subscriptionCount": converter_subscription_count(app)
        })));
    }

    converter_stop_locked(&mut runtime);

    let listener = TcpListener::bind(("0.0.0.0", port)).map_err(|err| err.to_string())?;
    listener
        .set_nonblocking(true)
        .map_err(|err| err.to_string())?;
    let (tx, rx) = mpsc::channel();
    let thread_dir = dir.clone();
    let thread = thread::spawn(move || converter_server_loop(listener, thread_dir, port, rx));

    runtime.converter_server = Some(ConverterServerHandle {
        port,
        stop: tx,
        thread: Some(thread),
    });

    Ok(success(json!({
        "isRunning": true,
        "running": true,
        "port": port,
        "subscriptionCount": converter_subscription_count(app)
    })))
}

fn converter_stop_server(app: &AppHandle, state: &State<'_, AppState>) -> CompatResult {
    let mut runtime = state.runtime.lock().map_err(|err| err.to_string())?;
    converter_stop_locked(&mut runtime);
    Ok(success(json!({
        "isRunning": false,
        "running": false,
        "port": converter_port(app)?,
        "subscriptionCount": converter_subscription_count(app)
    })))
}

fn converter_server_status(app: &AppHandle, state: &State<'_, AppState>) -> CompatResult {
    let runtime = state.runtime.lock().map_err(|err| err.to_string())?;
    let running = runtime.converter_server.is_some();
    let port = runtime
        .converter_server
        .as_ref()
        .map(|handle| handle.port)
        .unwrap_or(converter_port(app)?);
    Ok(success(json!({
        "isRunning": running,
        "running": running,
        "mode": "local",
        "port": port,
        "subscriptionCount": converter_subscription_count(app)
    })))
}

async fn converter_source_content(params: &Value) -> Result<String, String> {
    if let Some(content) = params
        .get("sourceContent")
        .or_else(|| params.get("content"))
        .or_else(|| params.get("input"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
    {
        return Ok(content.to_string());
    }

    if let Some(url) = params
        .get("sourceUrl")
        .or_else(|| params.get("url"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
    {
        return reqwest::Client::builder()
            .danger_accept_invalid_certs(true)
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|err| err.to_string())?
            .get(url)
            .send()
            .await
            .map_err(|err| err.to_string())?
            .text()
            .await
            .map_err(|err| err.to_string());
    }

    Ok(String::new())
}

async fn converter_create_subscription(
    app: &AppHandle,
    state: &State<'_, AppState>,
    params: Value,
) -> CompatResult {
    let _ = converter_start_server(app, state)?;
    let port = converter_port(app)?;
    let id = params
        .get("id")
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .unwrap_or_else(|| format!("sub_{}", now_millis()));
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("Converted")
        .to_string();
    let target_format = params
        .get("targetFormat")
        .and_then(Value::as_str)
        .unwrap_or("clash-meta")
        .to_string();
    let source = converter_source_content(&params).await?;
    let converted = converter_conversion_payload(
        &source,
        Some(&target_format),
        params.get("filterRegex").and_then(Value::as_str),
        params.get("options"),
        params.get("templateId").and_then(Value::as_str),
    );
    if !converted
        .get("success")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Ok(converted);
    }
    let output = converted
        .get("output")
        .and_then(Value::as_str)
        .unwrap_or(source.as_str())
        .to_string();
    let proxy_count = converted
        .get("outputProxyCount")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let record = json!({
        "id": id,
        "name": name,
        "sourceUrl": params.get("sourceUrl").cloned().unwrap_or(Value::Null),
        "targetFormat": target_format,
        "filterRegex": params.get("filterRegex").cloned().unwrap_or(Value::Null),
        "templateId": params.get("templateId").cloned().unwrap_or(Value::Null),
        "options": params.get("options").cloned().unwrap_or_else(|| json!({})),
        "lastUpdate": now_millis(),
        "proxyCount": proxy_count,
        "content": output
    });
    fs::write(
        converter_subscription_file(app, &id)?,
        serde_json::to_string_pretty(&record).map_err(|err| err.to_string())?,
    )
    .map_err(|err| err.to_string())?;

    Ok(success(json!({
        "id": id,
        "url": converter_public_url(port, &id),
        "port": port,
        "outputProxyCount": proxy_count
    })))
}

fn converter_local_id_from_url(url: &str) -> Option<String> {
    let marker = "/sub/";
    let index = url.find(marker)?;
    let id = &url[index + marker.len()..];
    let id = id.split(['?', '#']).next().unwrap_or_default().trim();
    (!id.is_empty()).then(|| id.to_string())
}

async fn converter_add_to_config(app: &AppHandle, params: Value) -> CompatResult {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("Converted")
        .to_string();
    let url = params
        .get("url")
        .and_then(Value::as_str)
        .map(ToString::to_string);

    let content = if let Some(content) = params.get("content").and_then(Value::as_str) {
        content.to_string()
    } else if let Some(id) = url.as_deref().and_then(converter_local_id_from_url) {
        let record = converter_read_subscription(&converter_subscription_file(app, &id)?)
            .ok_or_else(|| "订阅转换结果不存在".to_string())?;
        record
            .get("content")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    } else if let Some(url) = url.as_deref() {
        let settings = converter_settings(app)?;
        let user_agent = settings
            .get("userAgent")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("FlyClash-Converter/1.0");
        let response = reqwest::Client::builder()
            .danger_accept_invalid_certs(true)
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|err| err.to_string())?
            .get(url)
            .header(reqwest::header::USER_AGENT, user_agent)
            .send()
            .await
            .map_err(|err| err.to_string())?;
        let status = response.status();
        if !status.is_success() {
            return Ok(json!({
                "success": false,
                "error": format!("HTTP {}", status.as_u16()),
                "status": status.as_u16()
            }));
        }
        response.text().await.map_err(|err| err.to_string())?
    } else {
        String::new()
    };

    if content.trim().is_empty() {
        return Ok(json!({ "success": false, "error": "转换结果为空，无法添加到配置" }));
    }

    save_subscription(app, url, content, Some(name), None)
}

pub(crate) async fn handle_compat_call(
    app: &AppHandle,
    state: &State<'_, AppState>,
    method: &str,
    args: &[Value],
) -> Option<CompatResult> {
    if !method.starts_with("converter.") && !method.starts_with("converter:") {
        return None;
    }

    Some(dispatch_compat_call(app, state, method, args).await)
}

async fn dispatch_compat_call(
    app: &AppHandle,
    state: &State<'_, AppState>,
    method: &str,
    args: &[Value],
) -> CompatResult {
    match method {
        "converter.fetchUrl" | "converter:fetch-url" => {
            let mut url = arg_string(args, 0).unwrap_or_default();
            url = url.trim().to_string();
            if url.is_empty() {
                return Ok(json!({ "success": false, "error": "URL 不能为空" }));
            }
            if !url.starts_with("http://") && !url.starts_with("https://") {
                url = format!("https://{url}");
            }

            let settings = converter_settings(app)?;
            let user_agent = settings
                .get("userAgent")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .unwrap_or("FlyClash-Converter/1.0");
            let response = reqwest::Client::builder()
                .danger_accept_invalid_certs(true)
                .timeout(Duration::from_secs(30))
                .build()
                .map_err(|err| err.to_string())?
                .get(url)
                .header(reqwest::header::USER_AGENT, user_agent)
                .send()
                .await
                .map_err(|err| err.to_string())?;
            let status = response.status();
            if !status.is_success() {
                return Ok(json!({
                    "success": false,
                    "error": format!("HTTP {}", status.as_u16()),
                    "status": status.as_u16()
                }));
            }
            let text = response.text().await.map_err(|err| err.to_string())?;
            Ok(success(json!({ "content": text })))
        }
        "converter.parseProxies" | "converter:parse-proxies" => {
            Ok(parse_proxy_names(&arg_string(args, 0).unwrap_or_default()))
        }
        "converter.getTemplates" | "converter:get-templates" => {
            Ok(success(json!({ "templates": converter_templates() })))
        }
        "converter.getTemplate" | "converter:get-template" => {
            let id = arg_string(args, 0).unwrap_or_else(|| "mihomo-default".to_string());
            let template = converter_templates()
                .as_array()
                .and_then(|items| {
                    items
                        .iter()
                        .find(|item| item.get("id").and_then(Value::as_str) == Some(id.as_str()))
                })
                .cloned()
                .unwrap_or_else(|| json!({ "id": id, "name": id }));
            Ok(success(json!({ "template": template })))
        }
        "converter.getSettings" | "converter:get-settings" => Ok(success(json!({
            "settings": converter_settings(app)?
        }))),
        "converter.saveSettings" | "converter:save-settings" => {
            set_setting(
                app,
                "converterSettings",
                args.first().cloned().unwrap_or_else(|| json!({})),
            )?;
            Ok(success(json!({})))
        }
        "converter.serverStatus" | "converter:server-status" => converter_server_status(app, state),
        "converter.startServer" | "converter:start-server" => converter_start_server(app, state),
        "converter.stopServer" | "converter:stop-server" => converter_stop_server(app, state),
        "converter.convert"
        | "converter.convertWithTemplate"
        | "converter:convert"
        | "converter:convert-with-template" => {
            let params = args.first().cloned().unwrap_or_else(|| json!({}));
            let content = params
                .get("content")
                .or_else(|| params.get("input"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            Ok(converter_conversion_payload(
                &content,
                params.get("targetFormat").and_then(Value::as_str),
                params.get("filterRegex").and_then(Value::as_str),
                params.get("options"),
                if matches!(
                    method,
                    "converter.convertWithTemplate" | "converter:convert-with-template"
                ) {
                    params.get("templateId").and_then(Value::as_str)
                } else {
                    None
                },
            ))
        }
        "converter.createSubscription" | "converter:create-subscription" => {
            converter_create_subscription(
                app,
                state,
                args.first().cloned().unwrap_or_else(|| json!({})),
            )
            .await
        }
        "converter.addToConfig" | "converter:add-to-config" => {
            converter_add_to_config(app, args.first().cloned().unwrap_or_else(|| json!({}))).await
        }
        "converter.listSubscriptions" | "converter:list-subscriptions" => Ok(success(json!({
            "subscriptions": converter_list_from_dir(&converter_subscription_dir(app)?, converter_port(app)?)
        }))),
        "converter.deleteSubscription" | "converter:delete-subscription" => {
            let id = arg_string(args, 0).unwrap_or_default();
            let path = converter_subscription_file(app, &id)?;
            if path.exists() {
                fs::remove_file(path).map_err(|err| err.to_string())?;
                Ok(success(json!({})))
            } else {
                Ok(json!({ "success": false, "error": "Subscription not found" }))
            }
        }
        _ if method.starts_with("converter.") || method.starts_with("converter:") => {
            Err(format!("Unsupported converter method: {method}"))
        }
        _ => Err(format!("Unsupported converter method: {method}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converter_template_conversion_rejects_missing_template() {
        let result = converter_conversion_payload(
            "proxies:\n  - name: node-a\n    type: ss\n    server: example.com\n    port: 443\n    cipher: aes-128-gcm\n    password: pass\n",
            Some("clash-meta"),
            None,
            None,
            Some("missing-template"),
        );

        assert_eq!(result.get("success").and_then(Value::as_bool), Some(false));
        assert!(result
            .get("errorMessage")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .contains("模板不存在"));
    }
}
