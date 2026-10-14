use base64::{engine::general_purpose, Engine as _};

fn decode_subscription(input: &str) -> Option<String> {
    let compact = input
        .chars()
        .filter(|ch| !ch.is_whitespace())
        .collect::<String>();
    if compact.is_empty() || compact.len() > 24 * 1024 * 1024 {
        return None;
    }
    [
        general_purpose::STANDARD,
        general_purpose::STANDARD_NO_PAD,
        general_purpose::URL_SAFE,
        general_purpose::URL_SAFE_NO_PAD,
    ]
    .iter()
    .find_map(|engine| {
        engine
            .decode(&compact)
            .ok()
            .and_then(|bytes| String::from_utf8(bytes).ok())
    })
}

/// Preserve mapping-style configurations verbatim; normalize only alternate input formats.
pub(crate) fn normalize_content(input: &str) -> Result<String, String> {
    normalize_inner(input, 0)
}

fn normalize_inner(input: &str, depth: u8) -> Result<String, String> {
    let input = input.trim().trim_start_matches('\u{feff}').trim();
    if input.is_empty() {
        return Err("配置内容为空".into());
    }
    if depth < 3 && input.starts_with("```") {
        if let Some((_, body)) = input.split_once('\n') {
            if let Some(body) = body.trim_end().strip_suffix("```") {
                return normalize_inner(body, depth + 1);
            }
        }
    }
    let prefix = input
        .chars()
        .take(256)
        .collect::<String>()
        .to_ascii_lowercase();
    if prefix.contains("<!doctype html") || prefix.contains("<html") || prefix.starts_with("<head")
    {
        return Err("订阅返回了网页或验证页面，请检查订阅链接与 User-Agent".into());
    }
    if let Ok(yaml) = serde_yaml::from_str::<serde_yaml::Value>(input) {
        if let Some(mapping) = yaml.as_mapping() {
            if depth < 3 && mapping.len() == 1 {
                for field in ["content", "config", "data"] {
                    if let Some(value) = mapping.get(serde_yaml::Value::String(field.into())) {
                        let nested = value.as_str().map(ToString::to_string).or_else(|| {
                            (value.is_mapping() || value.is_sequence())
                                .then(|| serde_yaml::to_string(value).ok())
                                .flatten()
                        });
                        if let Some(nested) = nested {
                            return normalize_inner(&nested, depth + 1);
                        }
                    }
                }
            }
            // Don't demand proxies/provider fields: rule-only, DNS, listener and
            // other partial Mihomo configurations are legitimate import material.
            let error_keys = [
                "error", "message", "msg", "code", "status", "success", "detail", "data",
            ];
            if !mapping.is_empty()
                && mapping
                    .keys()
                    .all(|key| key.as_str().is_some_and(|key| error_keys.contains(&key)))
            {
                return Err("服务器返回了错误信息而非配置，请检查订阅状态".into());
            }
            if mapping.contains_key(serde_yaml::Value::String("outbounds".into()))
                && !mapping.contains_key(serde_yaml::Value::String("proxies".into()))
            {
                return Err(
                    "这是其他内核的配置格式，请导出 Clash/Mihomo 配置或节点链接后导入".into(),
                );
            }
            return Ok(input.to_string());
        }
        if yaml.is_sequence() {
            return crate::converter::convert_import_nodes(input);
        }
        // Only unwrap explicitly quoted strings. YAML folds ordinary multiline
        // scalar text, which could otherwise merge two node links into one.
        if depth < 3 && (input.starts_with('"') || input.starts_with('\'')) {
            if let Some(value) = yaml.as_str().filter(|value| *value != input) {
                return normalize_inner(value, depth + 1);
            }
        }
    }
    if input.lines().any(|line| line.trim().contains("://")) {
        return crate::converter::convert_import_nodes(input);
    }
    if depth < 2 {
        if let Some(decoded) = decode_subscription(input) {
            return normalize_inner(&decoded, depth + 1);
        }
    }
    Err("配置格式未识别，请粘贴 YAML/JSON 配置、节点链接列表或 Base64 订阅".into())
}

pub(crate) fn inline_content(input: &str) -> Option<Result<String, String>> {
    let input = input.trim().trim_start_matches('\u{feff}').trim();
    let input = input
        .strip_prefix('"')
        .and_then(|value| value.strip_suffix('"'))
        .or_else(|| {
            input
                .strip_prefix('\'')
                .and_then(|value| value.strip_suffix('\''))
        })
        .unwrap_or(input)
        .trim();
    let lower = input.to_ascii_lowercase();
    if lower.starts_with("http://")
        || lower.starts_with("https://")
        || ["clash://", "clash-verge://", "flyclash://"]
            .iter()
            .any(|scheme| lower.starts_with(scheme))
    {
        return None;
    }
    if input.contains("://")
        || input.contains('\n')
        || input.starts_with('{')
        || input.starts_with('[')
        || serde_yaml::from_str::<serde_yaml::Value>(input)
            .is_ok_and(|yaml| yaml.is_mapping() || yaml.is_sequence())
    {
        return Some(normalize_content(input));
    }
    decode_subscription(input).map(|_| normalize_content(input))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_partial_and_json_configs_without_fixed_required_keys() {
        for input in [
            "rules: [MATCH,DIRECT]",
            "dns: {enable: true}",
            "listeners: []",
            "{}",
            "{\"mode\":\"direct\"}",
            "custom-field: preserved",
        ] {
            assert_eq!(normalize_content(input).unwrap(), input);
        }
    }

    #[test]
    fn decodes_base64_yaml_and_both_subscription_alphabets() {
        for engine in [
            general_purpose::STANDARD,
            general_purpose::STANDARD_NO_PAD,
            general_purpose::URL_SAFE,
            general_purpose::URL_SAFE_NO_PAD,
        ] {
            let encoded = engine.encode("\u{feff}rules: [MATCH,DIRECT]");
            assert_eq!(
                normalize_content(&encoded).unwrap(),
                "rules: [MATCH,DIRECT]"
            );
        }
    }

    #[test]
    fn converts_nodes_and_provider_lists_into_runnable_configs() {
        let node = "trojan://password@example.com:443#test";
        for input in [node.to_string(), general_purpose::STANDARD.encode(node),
            "- {name: test, type: ss, server: example.com, port: 443, cipher: aes-128-gcm, password: pass}".into()] {
            let output = normalize_content(&input).unwrap();
            let yaml: serde_yaml::Value = serde_yaml::from_str(&output).unwrap();
            assert_eq!(yaml["proxies"].as_sequence().unwrap().len(), 1);
            assert!(yaml["proxy-groups"].is_sequence());
            assert!(yaml["rules"].is_sequence());
        }
    }

    #[test]
    fn accepts_copied_code_blocks_and_simple_api_wrappers() {
        for input in [
            "```yaml\nrules: []\n```",
            "{\"content\":\"rules: []\"}",
            "{\"config\":{\"rules\":[]}}",
        ] {
            let normalized = normalize_content(input).unwrap();
            let yaml: serde_yaml::Value = serde_yaml::from_str(&normalized).unwrap();
            assert!(yaml["rules"].is_sequence());
        }
        assert!(inline_content("\"HTTPS://example.com/sub?token=abc\"").is_none());
    }

    #[test]
    fn converts_common_protocols_and_keeps_generated_names_unique() {
        let vmess = general_purpose::STANDARD.encode(r#"{"v":"2","ps":"Proxy","add":"example.com","port":"443","id":"11111111-1111-1111-1111-111111111111","aid":"0","net":"ws","path":"/","tls":"tls"}"#);
        let nodes = [
            "SS://YWVzLTEyOC1nY206cGFzcw==@example.com:443#Proxy".to_string(),
            format!("vmess://{vmess}"),
            "vless://11111111-1111-1111-1111-111111111111@example.com:443?security=tls&type=ws#Proxy".into(),
            "trojan://password@example.com:443#Proxy".into(),
            "hy2://password@example.com:443#Proxy".into(),
            "tuic://11111111-1111-1111-1111-111111111111:password@example.com:443#Proxy".into(),
        ];
        let yaml: serde_yaml::Value =
            serde_yaml::from_str(&normalize_content(&nodes.join("\n")).unwrap()).unwrap();
        let proxies = yaml["proxies"].as_sequence().unwrap();
        assert_eq!(proxies.len(), 6);
        let names = proxies
            .iter()
            .map(|node| node["name"].as_str().unwrap())
            .collect::<std::collections::HashSet<_>>();
        assert_eq!(names.len(), 6);
        assert!(!names.contains("Proxy"));
    }

    #[test]
    fn avoids_silent_drops_and_obvious_error_pages() {
        for input in [
            "",
            "<!doctype html><html>challenge</html>",
            "{\"error\":\"expired\"}",
            "- not-a-node",
            "trojan://password@example.com:443#test\nunsupported://secret@example.com",
        ] {
            assert!(
                normalize_content(input).is_err(),
                "unexpectedly accepted input fixture"
            );
        }
        assert!(inline_content("example.com/sub?token=abc").is_none());
        assert!(inline_content("trojan://password@example.com:443#test")
            .unwrap()
            .is_ok());
    }
}
