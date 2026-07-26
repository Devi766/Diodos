use std::time::{Duration, SystemTime, UNIX_EPOCH};

use regex::Regex;
use serde_json::{json, Value};
use tauri::{AppHandle, WebviewWindow};

type CompatResult = Result<Value, String>;

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}


fn arg_string(args: &[Value], index: usize) -> Option<String> {
    args.get(index)
        .and_then(Value::as_str)
        .map(ToString::to_string)
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


pub(crate) async fn handle_compat_call(
    app: &AppHandle,
    window: &WebviewWindow,
    default_mixed_port: u16,
    method: &str,
    args: &[Value],
) -> Option<CompatResult> {
    if method != "testMediaStreaming" {
        return None;
    }

    Some(dispatch_compat_call(app, window, default_mixed_port, method, args).await)
}

async fn dispatch_compat_call(
    _app: &AppHandle,
    _window: &WebviewWindow,
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
        _ => Err(format!("Unsupported network tools method: {method}")),
    }
}
