use std::{
    io::{Read, Write},
    net::{IpAddr, SocketAddr, TcpStream, ToSocketAddrs, UdpSocket},
    path::PathBuf,
    process::{Command, Stdio},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use regex::Regex;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

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

fn value_u16(value: Option<&Value>) -> Option<u16> {
    value
        .and_then(Value::as_u64)
        .and_then(|port| u16::try_from(port).ok())
        .or_else(|| {
            value
                .and_then(Value::as_str)
                .and_then(|port| port.parse::<u16>().ok())
        })
}

fn http_failure(response: &Value, fallback: &str) -> Option<String> {
    if response.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        return None;
    }

    Some(
        response
            .get("error")
            .or_else(|| response.get("statusText"))
            .or_else(|| response.get("text"))
            .and_then(Value::as_str)
            .map(ToString::to_string)
            .filter(|message| !message.trim().is_empty())
            .unwrap_or_else(|| fallback.to_string()),
    )
}

fn push_unique_path(paths: &mut Vec<PathBuf>, path: PathBuf) {
    if !paths.iter().any(|item| item == &path) {
        paths.push(path);
    }
}

fn resource_roots(app: &AppHandle) -> Vec<PathBuf> {
    let mut roots = Vec::new();

    if let Ok(current) = std::env::current_dir() {
        push_unique_path(&mut roots, current.clone());
        push_unique_path(&mut roots, current.join(".."));
        push_unique_path(&mut roots, current.join("flycast-ui"));
    }

    push_unique_path(&mut roots, PathBuf::from("."));

    if let Ok(resource_dir) = app.path().resource_dir() {
        push_unique_path(&mut roots, resource_dir.clone());
        push_unique_path(&mut roots, resource_dir.join("_up_"));
        push_unique_path(&mut roots, resource_dir.join(".."));
    }

    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(exe_dir) = current_exe.parent() {
            push_unique_path(&mut roots, exe_dir.to_path_buf());
            push_unique_path(&mut roots, exe_dir.join("_up_"));
            push_unique_path(&mut roots, exe_dir.join(".."));
            push_unique_path(&mut roots, exe_dir.join("..").join("Resources"));
        }
    }
    roots
}

fn tool_dirs(app: &AppHandle) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    for root in resource_roots(app) {
        push_unique_path(&mut dirs, root.join("tools"));
    }
    dirs
}

fn media_user_agent() -> &'static str {
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
}

fn media_result(
    available: bool,
    full_support: bool,
    message: impl Into<String>,
    region: Option<String>,
    check_time: u128,
) -> Value {
    json!({
        "available": available,
        "fullSupport": full_support,
        "message": message.into(),
        "region": region,
        "checkTime": check_time,
        "dnsStatus": { "resolved": true }
    })
}

async fn media_fetch_text(
    client: &reqwest::Client,
    url: &str,
    extra_headers: &[(&str, &str)],
) -> Result<(u16, String), String> {
    let mut request = client
        .get(url)
        .header("User-Agent", media_user_agent())
        .header("Accept-Language", "en-US,en;q=0.9")
        .header("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7");
    for (key, value) in extra_headers {
        request = request.header(*key, *value);
    }
    let response = request.send().await.map_err(|err| err.to_string())?;
    let status = response.status().as_u16();
    let text = response.text().await.map_err(|err| err.to_string())?;
    Ok((status, text))
}

fn decode_js_hex_escapes(input: &str) -> String {
    Regex::new(r"\\x([0-9A-Fa-f]{2})")
        .ok()
        .map(|regex| {
            regex
                .replace_all(input, |caps: &regex::Captures| {
                    u8::from_str_radix(&caps[1], 16)
                        .ok()
                        .map(|value| (value as char).to_string())
                        .unwrap_or_else(|| caps[0].to_string())
                })
                .to_string()
        })
        .unwrap_or_else(|| input.to_string())
}

fn first_regex_capture(input: &str, patterns: &[&str]) -> Option<String> {
    patterns.iter().find_map(|pattern| {
        Regex::new(pattern)
            .ok()?
            .captures(input)
            .and_then(|captures| {
                captures
                    .get(1)
                    .map(|matched| matched.as_str().trim().to_string())
            })
    })
}

// Align Netflix detection with Android NetflixDetector:
// - Original: LEGO Ninjago (81280792)
// - Non-original: Breaking Bad (70143836)
// - Prefer reactContext.graphql mediaTracks for the specific title id

fn netflix_browser_headers() -> &'static [(&'static str, &'static str)] {
    &[
        (
            "Accept",
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
        ),
        ("Accept-Language", "en-US,en;q=0.9"),
        (
            "Sec-CH-UA",
            "\"Google Chrome\";v=\"125\", \"Chromium\";v=\"125\", \"Not.A/Brand\";v=\"24\"",
        ),
        ("Sec-CH-UA-Mobile", "?0"),
        ("Sec-CH-UA-Platform", "\"Windows\""),
        ("Sec-Fetch-Dest", "document"),
        ("Sec-Fetch-Mode", "navigate"),
        ("Sec-Fetch-Site", "none"),
        ("Upgrade-Insecure-Requests", "1"),
    ]
}

fn netflix_extract_react_context_json(html: &str) -> Option<String> {
    let marker = "netflix.reactContext = ";
    let start = html.find(marker)? + marker.len();
    let end = html[start..].find(";</script>")? + start;
    Some(decode_js_hex_escapes(&html[start..end]))
}

fn netflix_region(html: &str) -> Option<String> {
    let decoded = decode_js_hex_escapes(html);
    if let Some(region) = first_regex_capture(
        &decoded,
        &[
            r#""requestCountry"\s*:\s*\{[^}]*"id"\s*:\s*"([A-Za-z]{2})""#,
            r#"requestCountry"?\s*:\s*\{[^}]*"id"?\s*:\s*"([A-Za-z]{2})""#,
            r#"data-country=["']([A-Z]{2})["']"#,
            r#""countryCode"\s*:\s*"([A-Z]{2})""#,
            r#""countryOfSignup"\s*:\s*"([A-Za-z]{2})""#,
        ],
    ) {
        return Some(region.to_uppercase());
    }

    // Fallback: locale from originalUrl path like /sg-en/title/...
    first_regex_capture(
        &decoded,
        &[
            r#""originalUrl"\s*:\s*"/*([A-Za-z]{2})-[A-Za-z]{2}/"#,
            r#"/([a-z]{2})-[A-Za-z]{2}/title/"#,
        ],
    )
    .map(|value| value.to_uppercase())
}

fn netflix_has_unavailable_signal(html: &str) -> bool {
    let lower = html.to_ascii_lowercase();
    [
        "oh no!",
        "not available in your country",
        "isn't available to watch in your country",
        "isn't available in your country",
        "not available in your region",
        "isn't available in your region",
        "currently isn't available",
        "isn't available to watch",
        "not available to watch",
        "unavailable in your area",
        "locally-unavailable",
        "nses-nti",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

fn netflix_has_page_error_signal(html: &str) -> bool {
    let lower = html.to_ascii_lowercase();
    [
        "<title>netflix - error</title>",
        "<title>netflix - oops</title>",
        "<title>netflix - 出错了</title>",
        "error-page",
        "serviceerrormessage",
        "nses-403",
        "nses-404",
        "nses-500",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

fn netflix_looks_like_title_page(html: &str, title_id: &str) -> bool {
    if !html.to_ascii_lowercase().contains("netflix") {
        return false;
    }
    html.contains(title_id)
        || html.contains(&format!("/title/{title_id}"))
        || html.contains(&format!("videoId\":{title_id}"))
        || html.contains(&format!("videoId\\\":{title_id}"))
}

/// True when reactContext graphql exposes non-empty mediaTracks for this title.
fn netflix_playable_from_graphql(html: &str, title_id: &str) -> bool {
    let Some(raw_json) = netflix_extract_react_context_json(html) else {
        return false;
    };
    let Ok(context) = serde_json::from_str::<Value>(&raw_json) else {
        return false;
    };
    let Some(graphql) = context
        .pointer("/models/graphql/data")
        .and_then(Value::as_object)
    else {
        return false;
    };

    let show_key = format!("Show:{{\"videoId\":{title_id}}}");
    let movie_key = format!("Movie:{{\"videoId\":{title_id}}}");
    let video_node = graphql.get(&show_key).or_else(|| graphql.get(&movie_key));

    match video_node.and_then(|node| node.get("mediaTracks")) {
        Some(Value::Object(map)) => !map.is_empty(),
        Some(Value::Array(items)) => !items.is_empty(),
        _ => false,
    }
}

/// Probe result: (success, playable, region, error)
fn netflix_analyze_response(
    status: u16,
    html: &str,
    title_id: &str,
) -> (bool, bool, Option<String>, Option<String>) {
    let region = netflix_region(html);
    let blocked = netflix_has_unavailable_signal(html);
    let page_error = netflix_has_page_error_signal(html);
    let playable_graphql = netflix_playable_from_graphql(html, title_id);
    let valid_title_page = netflix_looks_like_title_page(html, title_id);

    if playable_graphql {
        return (true, true, region, None);
    }

    if blocked || status == 403 || status == 404 {
        return (true, false, region, None);
    }

    if (200..400).contains(&status) && !page_error && valid_title_page {
        // Fallback when page shell loads for the title but graphql payload is stripped.
        return (true, true, region, None);
    }

    if (200..400).contains(&status) {
        return (
            false,
            false,
            region,
            Some("Netflix页面结构变化，无法判定".to_string()),
        );
    }

    (false, false, region, Some(format!("HTTP {status}")))
}

async fn test_netflix(client: &reqwest::Client, started: u128) -> Value {
    async fn probe(
        client: &reqwest::Client,
        url: &str,
        title_id: &str,
    ) -> (bool, bool, Option<String>, Option<String>) {
        match media_fetch_text(client, url, netflix_browser_headers()).await {
            Ok((status, html)) => netflix_analyze_response(status, &html, title_id),
            Err(error) => (false, false, None, Some(error)),
        }
    }

    // Keep IDs in sync with Android NetflixDetector
    let original = probe(client, "https://www.netflix.com/title/81280792", "81280792").await;
    let non_original = probe(client, "https://www.netflix.com/title/70143836", "70143836").await;
    let check_time = now_millis().saturating_sub(started);
    let region = original.2.clone().or(non_original.2.clone());

    if !original.0 && !non_original.0 {
        let reason = original
            .3
            .or(non_original.3)
            .unwrap_or_else(|| "未知错误".to_string());
        return media_result(
            false,
            false,
            format!("检测失败: {reason}"),
            region,
            check_time,
        );
    }

    if !original.0 && non_original.0 {
        return if non_original.1 {
            media_result(true, true, "解锁非自制剧", region, check_time)
        } else {
            media_result(false, false, "不支持", region, check_time)
        };
    }

    if original.0 && !non_original.0 {
        return if original.1 {
            media_result(true, false, "仅支持自制剧", region, check_time)
        } else {
            let reason = non_original
                .3
                .unwrap_or_else(|| "非自制剧检测失败".to_string());
            media_result(
                false,
                false,
                format!("检测失败: {reason}"),
                region,
                check_time,
            )
        };
    }

    match (original.1, non_original.1) {
        (true, true) => media_result(true, true, "解锁所有内容", region, check_time),
        (true, false) => media_result(true, false, "仅支持自制剧", region, check_time),
        (false, true) => media_result(true, true, "解锁非自制剧", region, check_time),
        (false, false) => media_result(false, false, "不支持", region, check_time),
    }
}

async fn test_youtube_premium(client: &reqwest::Client, started: u128) -> Value {
    match media_fetch_text(client, "https://www.youtube.com/premium", &[]).await {
        Ok((status, html)) => {
            let check_time = now_millis().saturating_sub(started);
            let lower = html.to_ascii_lowercase();
            let region = first_regex_capture(
                &html,
                &[
                    r#""GL"\s*:\s*"([A-Z]{2})""#,
                    r#""countryCode"\s*:\s*"([A-Z]{2})""#,
                    r#""country"\s*:\s*"([A-Z]{2})""#,
                ],
            );
            if !(200..400).contains(&status) {
                return media_result(
                    false,
                    false,
                    format!("YouTube Premium HTTP {status}"),
                    region,
                    check_time,
                );
            }
            let unavailable = lower.contains("not available in your country")
                || lower.contains("premium is not available")
                || lower.contains("youtube premium isn't available");
            if unavailable {
                media_result(
                    false,
                    false,
                    "YouTube Premium 区域不支持",
                    region,
                    check_time,
                )
            } else if lower.contains("ad-free") || lower.contains("youtube premium") {
                media_result(true, true, "支持 YouTube Premium", region, check_time)
            } else {
                media_result(
                    true,
                    false,
                    "YouTube 可访问，Premium 状态未知",
                    region,
                    check_time,
                )
            }
        }
        Err(error) => media_result(
            false,
            false,
            format!("YouTube Premium 检测失败: {error}"),
            None,
            now_millis().saturating_sub(started),
        ),
    }
}

async fn test_bbc_iplayer(client: &reqwest::Client, started: u128) -> Value {
    let url = "https://open.live.bbc.co.uk/mediaselector/6/select/version/2.0/mediaset/pc/vpid/bbc_one_london/format/json/jsfunc/JS_callbacks0";
    match media_fetch_text(client, url, &[]).await {
        Ok((status, body)) => {
            let check_time = now_millis().saturating_sub(started);
            let lower = body.to_ascii_lowercase();
            if !(200..400).contains(&status) {
                return media_result(
                    false,
                    false,
                    format!("BBC iPlayer HTTP {status}"),
                    Some("UK".to_string()),
                    check_time,
                );
            }
            let blocked = lower.contains("geolocation")
                || lower.contains("notuk")
                || lower.contains("outside")
                || lower.contains("unavailable");
            if blocked {
                media_result(
                    false,
                    false,
                    "BBC iPlayer 区域限制",
                    Some("UK".to_string()),
                    check_time,
                )
            } else {
                media_result(
                    true,
                    true,
                    "BBC iPlayer 可用",
                    Some("UK".to_string()),
                    check_time,
                )
            }
        }
        Err(error) => media_result(
            false,
            false,
            format!("BBC iPlayer 检测失败: {error}"),
            Some("UK".to_string()),
            now_millis().saturating_sub(started),
        ),
    }
}

async fn test_abema(client: &reqwest::Client, started: u128) -> Value {
    match media_fetch_text(
        client,
        "https://api.abema.io/v1/ip/check?device=android",
        &[("Accept", "application/json")],
    )
    .await
    {
        Ok((status, body)) => {
            let check_time = now_millis().saturating_sub(started);
            if !(200..400).contains(&status) {
                return media_result(
                    false,
                    false,
                    format!("AbemaTV HTTP {status}"),
                    None,
                    check_time,
                );
            }
            let parsed = serde_json::from_str::<Value>(&body).unwrap_or(Value::Null);
            let region = parsed
                .get("isoCountryCode")
                .or_else(|| parsed.get("countryCode"))
                .or_else(|| parsed.get("country"))
                .and_then(Value::as_str)
                .map(|value| value.to_uppercase());
            let available = parsed
                .get("isAvailable")
                .or_else(|| parsed.get("available"))
                .and_then(Value::as_bool)
                .unwrap_or_else(|| region.as_deref() == Some("JP"));
            if available {
                media_result(
                    true,
                    true,
                    "AbemaTV 完全支持",
                    region.or(Some("JP".to_string())),
                    check_time,
                )
            } else {
                media_result(false, false, "AbemaTV 仅限日本地区", region, check_time)
            }
        }
        Err(error) => media_result(
            false,
            false,
            format!("AbemaTV 检测失败: {error}"),
            None,
            now_millis().saturating_sub(started),
        ),
    }
}

async fn specialized_media_streaming(
    client: &reqwest::Client,
    service_name: &str,
    started: u128,
) -> Option<Value> {
    match service_name {
        "Netflix" => Some(test_netflix(client, started).await),
        "YouTube Premium" => Some(test_youtube_premium(client, started).await),
        "BBC iPlayer" => Some(test_bbc_iplayer(client, started).await),
        "AbemaTV" | "Abema TV" | "Abema" => Some(test_abema(client, started).await),
        _ => None,
    }
}

pub(crate) async fn test_media_streaming(
    proxy_port: u16,
    service_name: &str,
    check_url: Option<String>,
) -> Result<Value, String> {
    let proxy_url = format!("http://127.0.0.1:{proxy_port}");
    let started = now_millis();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .proxy(reqwest::Proxy::all(&proxy_url).map_err(|err| err.to_string())?)
        .build()
        .map_err(|err| err.to_string())?;

    if let Some(result) = specialized_media_streaming(&client, service_name, started).await {
        return Ok(result);
    }

    let Some(url) = check_url.filter(|value| !value.trim().is_empty()) else {
        return Ok(json!({
            "available": false,
            "fullSupport": false,
            "message": "缺少检测地址",
            "checkTime": 0
        }));
    };

    let response = client
        .get(&url)
        .header("User-Agent", media_user_agent())
        .header("Accept-Language", "en-US,en;q=0.9")
        .send()
        .await;
    let check_time = now_millis().saturating_sub(started);

    match response {
        Ok(response) => {
            let status = response.status();
            let available = status.is_success() || status.is_redirection();
            let partial = matches!(status.as_u16(), 401 | 403 | 451);
            let message = if available {
                format!("{service_name} 可访问")
            } else if partial {
                format!("{service_name} 返回限制状态 {}", status.as_u16())
            } else {
                format!("{service_name} 不可用: HTTP {}", status.as_u16())
            };

            Ok(json!({
                "available": available || partial,
                "fullSupport": available,
                "message": message,
                "checkTime": check_time,
                "dnsStatus": { "resolved": true }
            }))
        }
        Err(error) => Ok(json!({
            "available": false,
            "fullSupport": false,
            "message": format!("检测失败: {error}"),
            "checkTime": check_time,
            "dnsStatus": { "resolved": false }
        })),
    }
}

async fn simple_speedtest() -> CompatResult {
    let url = "https://speed.cloudflare.com/__down?bytes=1000000";
    let started = now_millis();
    let bytes = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|err| err.to_string())?
        .get(url)
        .send()
        .await
        .map_err(|err| err.to_string())?
        .bytes()
        .await
        .map_err(|err| err.to_string())?;
    let duration = ((now_millis().saturating_sub(started)) as f64 / 1000.0).max(0.001);
    let bytes = bytes.len() as u64;
    Ok(success(json!({
        "data": {
            "download": (bytes as f64 * 8.0 / duration / 1_000_000.0),
            "downloadSpeed": (bytes as f64 * 8.0 / duration / 1_000_000.0),
            "upload": 0,
            "uploadSpeed": 0,
            "ping": 0,
            "jitter": 0,
            "server": { "host": "speed.cloudflare.com", "name": "Cloudflare", "country": "" }
        }
    })))
}

fn speedtest_proxy_endpoint(
    default_mixed_port: u16,
    options: &Value,
) -> Result<(String, u16), String> {
    let proxy = options.get("proxy").cloned().unwrap_or_else(|| json!({}));
    let host = proxy
        .get("host")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("127.0.0.1")
        .to_string();
    let port = value_u16(proxy.get("port")).unwrap_or(default_mixed_port);
    if port == 0 {
        return Err("代理端口无效".to_string());
    }
    Ok((host, port))
}

async fn proxy_speedtest_download(
    default_mixed_port: u16,
    options: &Value,
    url: &str,
) -> CompatResult {
    let (proxy_host, proxy_port) = speedtest_proxy_endpoint(default_mixed_port, options)?;
    let proxy_url = format!("http://{proxy_host}:{proxy_port}");
    let response = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .proxy(reqwest::Proxy::all(&proxy_url).map_err(|err| err.to_string())?)
        .build()
        .map_err(|err| err.to_string())?
        .get(url)
        .send()
        .await
        .map_err(|err| err.to_string())?;
    let status = response.status();
    let status_text = status.canonical_reason().unwrap_or("").to_string();
    let bytes = response.bytes().await.map_err(|err| err.to_string())?;

    Ok(json!({
        "ok": status.is_success(),
        "status": status.as_u16(),
        "statusText": status_text,
        "bytes": bytes.len() as u64,
        "proxy": {
            "host": proxy_host,
            "port": proxy_port
        }
    }))
}

fn udp_test_servers(options: &Value) -> Vec<Value> {
    let configured = options
        .get("testServers")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|server| {
            let address = server.get("address").and_then(Value::as_str)?.trim();
            let port = value_u16(server.get("port")).unwrap_or(53);
            if address.is_empty() || port == 0 {
                return None;
            }
            Some(json!({
                "name": server
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or(address),
                "address": address,
                "port": port
            }))
        })
        .collect::<Vec<_>>();

    if !configured.is_empty() {
        return configured;
    }

    vec![
        json!({ "name": "Cloudflare DNS", "address": "1.1.1.1", "port": 53 }),
        json!({ "name": "Google DNS", "address": "8.8.8.8", "port": 53 }),
        json!({ "name": "Quad9 DNS", "address": "9.9.9.9", "port": 53 }),
    ]
}

fn resolve_socket_addr(host: &str, port: u16) -> Result<SocketAddr, String> {
    (host, port)
        .to_socket_addrs()
        .map_err(|err| err.to_string())?
        .next()
        .ok_or_else(|| format!("无法解析地址 {host}:{port}"))
}

fn socks5_address_bytes(host: &str, port: u16) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    if let Ok(ip) = host.parse::<IpAddr>() {
        match ip {
            IpAddr::V4(ip) => {
                bytes.push(0x01);
                bytes.extend_from_slice(&ip.octets());
            }
            IpAddr::V6(ip) => {
                bytes.push(0x04);
                bytes.extend_from_slice(&ip.octets());
            }
        }
    } else {
        let host_bytes = host.as_bytes();
        if host_bytes.len() > u8::MAX as usize {
            return Err("目标域名过长".to_string());
        }
        bytes.push(0x03);
        bytes.push(host_bytes.len() as u8);
        bytes.extend_from_slice(host_bytes);
    }
    bytes.extend_from_slice(&port.to_be_bytes());
    Ok(bytes)
}

fn read_socks5_bound_addr(
    stream: &mut TcpStream,
    proxy_addr: SocketAddr,
) -> Result<SocketAddr, String> {
    let mut head = [0u8; 4];
    stream
        .read_exact(&mut head)
        .map_err(|err| err.to_string())?;
    if head[0] != 0x05 {
        return Err("SOCKS5 代理返回了无效版本".to_string());
    }
    if head[1] != 0x00 {
        return Err(format!("SOCKS5 UDP ASSOCIATE 失败，REP={}", head[1]));
    }

    let ip = match head[3] {
        0x01 => {
            let mut raw = [0u8; 4];
            stream.read_exact(&mut raw).map_err(|err| err.to_string())?;
            IpAddr::from(raw)
        }
        0x04 => {
            let mut raw = [0u8; 16];
            stream.read_exact(&mut raw).map_err(|err| err.to_string())?;
            IpAddr::from(raw)
        }
        0x03 => {
            let mut len = [0u8; 1];
            stream.read_exact(&mut len).map_err(|err| err.to_string())?;
            let mut raw = vec![0u8; len[0] as usize];
            stream.read_exact(&mut raw).map_err(|err| err.to_string())?;
            let host = String::from_utf8_lossy(&raw).to_string();
            resolve_socket_addr(&host, proxy_addr.port())?.ip()
        }
        _ => return Err("SOCKS5 代理返回了不支持的地址类型".to_string()),
    };
    let mut port = [0u8; 2];
    stream
        .read_exact(&mut port)
        .map_err(|err| err.to_string())?;
    let port = u16::from_be_bytes(port);
    let ip = if ip.is_unspecified() {
        proxy_addr.ip()
    } else {
        ip
    };
    Ok(SocketAddr::new(ip, port))
}

fn dns_probe_packet() -> Vec<u8> {
    let id = (now_millis() as u16).to_be_bytes();
    let mut packet = Vec::with_capacity(29);
    packet.extend_from_slice(&id);
    packet.extend_from_slice(&[0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    packet.push(7);
    packet.extend_from_slice(b"example");
    packet.push(3);
    packet.extend_from_slice(b"com");
    packet.push(0);
    packet.extend_from_slice(&[0x00, 0x01, 0x00, 0x01]);
    packet
}

fn socks5_udp_probe(
    proxy_host: &str,
    proxy_port: u16,
    server_host: &str,
    server_port: u16,
) -> Result<u128, String> {
    let timeout = Duration::from_secs(5);
    let proxy_addr = resolve_socket_addr(proxy_host, proxy_port)?;
    let mut stream =
        TcpStream::connect_timeout(&proxy_addr, timeout).map_err(|err| err.to_string())?;
    stream
        .set_read_timeout(Some(timeout))
        .map_err(|err| err.to_string())?;
    stream
        .set_write_timeout(Some(timeout))
        .map_err(|err| err.to_string())?;

    stream
        .write_all(&[0x05, 0x01, 0x00])
        .map_err(|err| err.to_string())?;
    let mut greeting = [0u8; 2];
    stream
        .read_exact(&mut greeting)
        .map_err(|err| err.to_string())?;
    if greeting != [0x05, 0x00] {
        return Err("SOCKS5 代理不支持无认证 UDP 探测".to_string());
    }

    let mut request = vec![0x05, 0x03, 0x00, 0x01, 0, 0, 0, 0, 0, 0];
    stream.write_all(&request).map_err(|err| err.to_string())?;
    let relay_addr = read_socks5_bound_addr(&mut stream, proxy_addr)?;

    let udp = UdpSocket::bind(if relay_addr.is_ipv4() {
        "0.0.0.0:0"
    } else {
        "[::]:0"
    })
    .map_err(|err| err.to_string())?;
    udp.set_read_timeout(Some(timeout))
        .map_err(|err| err.to_string())?;
    udp.set_write_timeout(Some(timeout))
        .map_err(|err| err.to_string())?;

    request.clear();
    request.extend_from_slice(&[0x00, 0x00, 0x00]);
    request.extend_from_slice(&socks5_address_bytes(server_host, server_port)?);
    request.extend_from_slice(&dns_probe_packet());

    let started = now_millis();
    udp.send_to(&request, relay_addr)
        .map_err(|err| err.to_string())?;
    let mut response = [0u8; 2048];
    let (size, _) = udp
        .recv_from(&mut response)
        .map_err(|err| err.to_string())?;
    if size <= 10 {
        return Err("UDP 响应过短".to_string());
    }
    Ok(now_millis().saturating_sub(started))
}

async fn test_udp_connectivity(default_mixed_port: u16, options: Value) -> CompatResult {
    let proxy = options.get("proxy").cloned().unwrap_or_else(|| json!({}));
    let proxy_host = proxy
        .get("host")
        .and_then(Value::as_str)
        .unwrap_or("127.0.0.1")
        .trim()
        .to_string();
    let proxy_port = value_u16(proxy.get("port")).unwrap_or(default_mixed_port);
    if proxy_host.is_empty() || proxy_port == 0 {
        return Ok(json!({
            "success": false,
            "udpType": "unknown",
            "successCount": 0,
            "details": [],
            "error": "缺少 SOCKS5 代理地址或端口"
        }));
    }

    let servers = udp_test_servers(&options);
    let mut details = Vec::new();
    let mut success_count = 0usize;

    for server in servers {
        let name = server
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("UDP Server")
            .to_string();
        let address = server
            .get("address")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let port = value_u16(server.get("port")).unwrap_or(53);
        // 阻塞式 socket 探测放到阻塞线程池，避免占用 tokio worker
        let result = {
            let proxy_host = proxy_host.clone();
            let probe_address = address.clone();
            tauri::async_runtime::spawn_blocking(move || {
                socks5_udp_probe(&proxy_host, proxy_port, &probe_address, port)
            })
            .await
            .unwrap_or_else(|err| Err(err.to_string()))
        };
        match result {
            Ok(latency) => {
                success_count += 1;
                details.push(json!({
                    "name": name,
                    "address": address,
                    "port": port,
                    "success": true,
                    "latency": latency
                }));
            }
            Err(error) => details.push(json!({
                "name": name,
                "address": address,
                "port": port,
                "success": false,
                "error": error
            })),
        }
    }

    Ok(json!({
        "success": success_count > 0,
        "udpType": if success_count > 0 { "available" } else { "blocked" },
        "successCount": success_count,
        "details": details,
        "proxy": {
            "host": proxy_host,
            "port": proxy_port,
            "nodeName": proxy.get("nodeName").cloned().unwrap_or(Value::Null)
        },
        "error": if success_count > 0 { Value::Null } else { json!("UDP 连通性探测失败") }
    }))
}

fn emit_speedtest_output(window: &WebviewWindow, payload: Value) {
    let _ = window.emit("speedtest-output", payload);
}

fn find_speedtest_executable(app: &AppHandle) -> Option<PathBuf> {
    if !cfg!(target_os = "windows") {
        return None;
    }

    for dir in tool_dirs(app) {
        for candidate in [
            dir.join("speedtest.exe"),
            dir.join("speedtest-cli").join("speedtest.exe"),
            dir.join("ookla-speedtest-1.2.0-win64")
                .join("speedtest.exe"),
        ] {
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    None
}

fn json_number_at(value: &Value, path: &[&str]) -> f64 {
    let mut current = value;
    for key in path {
        let Some(next) = current.get(*key) else {
            return 0.0;
        };
        current = next;
    }
    current.as_f64().unwrap_or_else(|| {
        current
            .as_str()
            .and_then(|text| text.parse::<f64>().ok())
            .unwrap_or(0.0)
    })
}

fn json_string_at(value: &Value, path: &[&str]) -> String {
    let mut current = value;
    for key in path {
        let Some(next) = current.get(*key) else {
            return String::new();
        };
        current = next;
    }
    current.as_str().unwrap_or_default().to_string()
}

fn ookla_bandwidth_mbps(value: &Value, key: &str) -> f64 {
    let bandwidth = json_number_at(value, &[key, "bandwidth"]);
    if bandwidth > 0.0 {
        bandwidth * 8.0 / 1_000_000.0
    } else {
        json_number_at(value, &[key])
    }
}

fn speedtest_data_from_ookla_json(raw: &str) -> Result<Value, String> {
    let parsed = serde_json::from_str::<Value>(raw).map_err(|err| err.to_string())?;
    let download = ookla_bandwidth_mbps(&parsed, "download");
    let upload = ookla_bandwidth_mbps(&parsed, "upload");
    let ping = json_number_at(&parsed, &["ping", "latency"]);
    let jitter = json_number_at(&parsed, &["ping", "jitter"]);
    let server_name = json_string_at(&parsed, &["server", "name"]);
    let server_country = json_string_at(&parsed, &["server", "country"]);
    let server_host = json_string_at(&parsed, &["server", "host"]);

    Ok(json!({
        "download": download,
        "downloadSpeed": download,
        "upload": upload,
        "uploadSpeed": upload,
        "ping": ping,
        "jitter": jitter,
        "server": {
            "host": server_host,
            "name": server_name,
            "country": server_country
        }
    }))
}

fn emit_speedtest_result_events(window: &WebviewWindow, data: &Value) {
    let ping = data.get("ping").and_then(Value::as_f64).unwrap_or(0.0);
    let jitter = data.get("jitter").and_then(Value::as_f64).unwrap_or(0.0);
    let download = data.get("download").and_then(Value::as_f64).unwrap_or(0.0);
    let upload = data.get("upload").and_then(Value::as_f64).unwrap_or(0.0);

    emit_speedtest_output(
        window,
        json!({
            "type": "progress",
            "phase": "ping",
            "progress": 30,
            "ping": ping,
            "jitter": jitter
        }),
    );
    emit_speedtest_output(
        window,
        json!({
            "type": "progress",
            "phase": "download",
            "progress": 65,
            "downloadSpeed": download
        }),
    );
    emit_speedtest_output(
        window,
        json!({
            "type": "progress",
            "phase": "upload",
            "progress": 90,
            "uploadSpeed": upload
        }),
    );
    emit_speedtest_output(
        window,
        json!({
            "type": "status",
            "phase": "complete",
            "progress": 100,
            "message": "测速完成"
        }),
    );
}

fn run_ookla_speedtest(app: &AppHandle, window: &WebviewWindow) -> Option<CompatResult> {
    let speedtest = find_speedtest_executable(app)?;
    emit_speedtest_output(
        window,
        json!({
            "type": "stdout",
            "message": format!("Using {}", speedtest.to_string_lossy())
        }),
    );

    let mut child = match Command::new(&speedtest)
        .args([
            "--format=json",
            "--accept-license",
            "--accept-gdpr",
            "--unit=Mbps",
            "--precision=2",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            emit_speedtest_output(
                window,
                json!({
                    "type": "status",
                    "phase": "error",
                    "message": format!("启动测速工具失败: {error}"),
                    "error": error.to_string()
                }),
            );
            return Some(Ok(json!({
                "success": false,
                "error": format!("启动测速工具失败: {error}")
            })));
        }
    };

    let started = SystemTime::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if started
                    .elapsed()
                    .map(|elapsed| elapsed > Duration::from_secs(120))
                    .unwrap_or(false)
                {
                    let _ = child.kill();
                    let output = child.wait_with_output().map_err(|err| err.to_string());
                    let stderr = output
                        .ok()
                        .map(|output| String::from_utf8_lossy(&output.stderr).trim().to_string())
                        .unwrap_or_default();
                    let message = if stderr.is_empty() {
                        "测速超时".to_string()
                    } else {
                        format!("测速超时: {stderr}")
                    };
                    emit_speedtest_output(
                        window,
                        json!({ "type": "status", "phase": "error", "message": message }),
                    );
                    return Some(Ok(json!({ "success": false, "error": message })));
                }
                thread::sleep(Duration::from_millis(200));
            }
            Err(error) => {
                let message = format!("等待测速工具失败: {error}");
                emit_speedtest_output(
                    window,
                    json!({ "type": "status", "phase": "error", "message": message }),
                );
                return Some(Ok(json!({ "success": false, "error": message })));
            }
        }
    }

    let output = match child.wait_with_output() {
        Ok(output) => output,
        Err(error) => {
            let message = format!("读取测速结果失败: {error}");
            emit_speedtest_output(
                window,
                json!({ "type": "status", "phase": "error", "message": message }),
            );
            return Some(Ok(json!({ "success": false, "error": message })));
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !stderr.is_empty() {
        emit_speedtest_output(window, json!({ "type": "stderr", "message": stderr }));
    }

    let success_code = output
        .status
        .code()
        .is_some_and(|code| code == 0 || code == 2);
    if !success_code {
        let message = if stderr.is_empty() {
            format!("测速失败，退出码: {}", output.status.code().unwrap_or(-1))
        } else {
            stderr
        };
        emit_speedtest_output(
            window,
            json!({
                "type": "status",
                "phase": "error",
                "progress": 100,
                "message": message,
                "exitCode": output.status.code()
            }),
        );
        return Some(Ok(json!({ "success": false, "error": message })));
    }

    match speedtest_data_from_ookla_json(&stdout) {
        Ok(data) => {
            emit_speedtest_result_events(window, &data);
            Some(Ok(success(json!({ "data": data }))))
        }
        Err(error) => {
            let message = format!("解析测速结果失败: {error}");
            emit_speedtest_output(
                window,
                json!({ "type": "status", "phase": "error", "message": message }),
            );
            Some(Ok(json!({ "success": false, "error": message })))
        }
    }
}

pub(crate) async fn handle_compat_call(
    app: &AppHandle,
    window: &WebviewWindow,
    default_mixed_port: u16,
    method: &str,
    args: &[Value],
) -> Option<CompatResult> {
    if !matches!(
        method,
        "testMediaStreaming"
            | "runSpeedtest"
            | "runSpeedtestDirect"
            | "runProxySpeedtest"
            | "testUdpConnectivity"
    ) {
        return None;
    }

    Some(dispatch_compat_call(app, window, default_mixed_port, method, args).await)
}

async fn dispatch_compat_call(
    app: &AppHandle,
    window: &WebviewWindow,
    default_mixed_port: u16,
    method: &str,
    args: &[Value],
) -> CompatResult {
    match method {
        "testMediaStreaming" => {
            let service_name = arg_string(args, 0).unwrap_or_else(|| "Media".to_string());
            let check_url = arg_string(args, 1);
            test_media_streaming(default_mixed_port, &service_name, check_url).await
        }
        "runSpeedtest" | "runSpeedtestDirect" => {
            emit_speedtest_output(
                window,
                json!({
                    "type": "status",
                    "phase": "start",
                    "message": "Speedtest started"
                }),
            );
            emit_speedtest_output(
                window,
                json!({
                    "type": "progress",
                    "phase": "ping",
                    "progress": 15
                }),
            );
            // speedtest 子进程轮询最长 120 秒，放到阻塞线程池执行
            let ookla_result = {
                let app = app.clone();
                let window = window.clone();
                tauri::async_runtime::spawn_blocking(move || run_ookla_speedtest(&app, &window))
                    .await
                    .unwrap_or(None)
            };
            if let Some(result) = ookla_result {
                return result;
            }
            emit_speedtest_output(
                window,
                json!({
                    "type": "stdout",
                    "message": "speedtest.exe not found, using lightweight Cloudflare download test"
                }),
            );
            let result = simple_speedtest().await;
            match &result {
                Ok(value) => {
                    if let Some(data) = value.get("data") {
                        emit_speedtest_result_events(window, data);
                    }
                }
                Err(error) => {
                    emit_speedtest_output(
                        window,
                        json!({
                            "type": "status",
                            "phase": "error",
                            "message": error
                        }),
                    );
                }
            }
            result
        }
        "runProxySpeedtest" => {
            let options = args.first().cloned().unwrap_or_else(|| json!({}));
            let url = args
                .first()
                .and_then(|value| value.get("url"))
                .and_then(Value::as_str)
                .unwrap_or("https://speed.cloudflare.com/__down?bytes=1000000");
            emit_speedtest_output(
                window,
                json!({
                    "type": "status",
                    "phase": "start",
                    "message": "Proxy speedtest started"
                }),
            );
            let started = now_millis();
            let response = match proxy_speedtest_download(default_mixed_port, &options, url).await {
                Ok(response) => response,
                Err(error) => {
                    emit_speedtest_output(
                        window,
                        json!({
                            "type": "status",
                            "phase": "error",
                            "message": error
                        }),
                    );
                    return Ok(json!({ "success": false, "error": error }));
                }
            };
            if let Some(error) = http_failure(&response, "Proxy speedtest failed") {
                emit_speedtest_output(
                    window,
                    json!({
                        "type": "status",
                        "phase": "error",
                        "message": error
                    }),
                );
                return Ok(json!({
                    "success": false,
                    "error": error,
                    "status": response.get("status").cloned().unwrap_or(Value::Null)
                }));
            }
            let duration = ((now_millis().saturating_sub(started)) as f64 / 1000.0).max(0.001);
            let bytes = response.get("bytes").and_then(Value::as_u64).unwrap_or(0);
            let download_speed = bytes as f64 / duration;
            emit_speedtest_output(
                window,
                json!({
                    "type": "progress",
                    "phase": "download",
                    "progress": 100,
                    "downloadSpeed": download_speed
                }),
            );
            emit_speedtest_output(
                window,
                json!({
                    "type": "status",
                    "phase": "complete",
                    "message": "Proxy speedtest completed"
                }),
            );
            Ok(success(json!({ "data": {
                "downloadSpeed": download_speed,
                "bytesReceived": bytes,
                "duration": duration,
                "url": url,
                "proxy": response.get("proxy").cloned().unwrap_or(Value::Null)
            }})))
        }
        "testUdpConnectivity" => {
            test_udp_connectivity(
                default_mixed_port,
                args.first().cloned().unwrap_or_else(|| json!({})),
            )
            .await
        }
        _ => Err(format!("Unsupported network tools method: {method}")),
    }
}
