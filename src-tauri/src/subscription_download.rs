use reqwest::{header::HeaderMap, Client, Url};
use std::time::Duration;

const MAX_BODY: usize = 16 * 1024 * 1024;

pub(crate) struct DownloadedSubscription {
    pub content: String,
    pub headers: HeaderMap,
}

pub(crate) fn normalize_url(input: &str) -> Result<Url, String> {
    let input = input.trim().trim_start_matches('\u{feff}').trim();
    if input.is_empty() {
        return Err("请输入订阅链接".into());
    }
    let input = if input.len() >= 2
        && ((input.starts_with('"') && input.ends_with('"'))
            || (input.starts_with('\'') && input.ends_with('\'')))
    {
        &input[1..input.len() - 1]
    } else {
        input
    };
    let normalized = if input.contains("://") {
        input.to_string()
    } else {
        format!("https://{input}")
    };
    let mut url = Url::parse(&normalized).map_err(|_| "订阅链接格式无效".to_string())?;
    if matches!(url.scheme(), "clash" | "clash-verge" | "flyclash") {
        let nested = url
            .query_pairs()
            .find(|(key, _)| key == "url")
            .map(|(_, value)| value.into_owned())
            .ok_or_else(|| "导入链接缺少 url 参数".to_string())?;
        // Only unwrap one level; nested custom schemes are not download targets.
        url = Url::parse(&nested).map_err(|_| "导入链接中的订阅地址无效".to_string())?;
    }
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("订阅地址需使用 HTTP 或 HTTPS".into());
    }
    if url.query().is_none() && url.path().contains('&') {
        let path = url.path().to_string();
        if let Some((path, query)) = path.split_once('&') {
            url.set_path(path);
            url.set_query(Some(query));
        }
    }
    url.set_fragment(None);
    Ok(url)
}

pub(crate) fn validate_content(content: &str) -> Result<String, String> {
    crate::subscription_content::normalize_content(content)
}

struct DownloadFailure {
    message: String,
    retry: RetryPolicy,
}

enum RetryPolicy {
    None,
    Transport,
    ServerError,
}

fn transport_failure(error: reqwest::Error) -> DownloadFailure {
    // reqwest's Display includes the full token-bearing URL. Never return it to UI/logs.
    let detail = format!("{error:?}").to_ascii_lowercase();
    let message = if ["certificate", "unknownissuer", "ssl", "tls"]
        .iter()
        .any(|word| detail.contains(word))
    {
        "订阅服务器 TLS 协议或证书校验失败，请检查服务器证书和本机时间"
    } else if error.is_timeout() {
        "订阅下载超时，请检查网络或代理节点后重试"
    } else if error.is_connect() {
        "连接订阅服务器失败，请检查网络、DNS 或代理设置"
    } else if error.is_redirect() {
        "订阅链接重定向次数过多"
    } else if error.is_builder() {
        "订阅请求参数无效，请检查链接与 User-Agent"
    } else {
        "订阅连接被中断或重置（ECONNRESET），请检查线路或稍后重试"
    };
    DownloadFailure {
        message: message.into(),
        retry: if error.is_builder() || error.is_redirect() {
            RetryPolicy::None
        } else {
            RetryPolicy::Transport
        },
    }
}

async fn attempt(
    url: &Url,
    ua: &str,
    proxy: Option<&str>,
    http1: bool,
) -> Result<DownloadedSubscription, DownloadFailure> {
    let mut builder = Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::limited(10))
        .timeout(Duration::from_secs(15))
        .connect_timeout(Duration::from_secs(8))
        .pool_max_idle_per_host(0)
        .tcp_keepalive(Duration::from_secs(60));
    if let Some(proxy) = proxy {
        builder = builder.proxy(reqwest::Proxy::all(proxy).map_err(transport_failure)?);
    }
    // The first pass retains platform trust; the retry uses verified Rustls roots
    // and HTTP/1.1 for server/protocol compatibility. Never disable verification.
    if http1 {
        builder = builder.use_rustls_tls().http1_only();
    }
    let client = builder.build().map_err(transport_failure)?;
    let mut target = url.clone();
    let credentials = if !target.username().is_empty() {
        Some((
            urlencoding::decode(target.username())
                .unwrap_or_else(|_| target.username().into())
                .into_owned(),
            urlencoding::decode(target.password().unwrap_or(""))
                .unwrap_or_else(|_| target.password().unwrap_or("").into())
                .into_owned(),
        ))
    } else {
        None
    };
    let _ = target.set_username("");
    let _ = target.set_password(None);
    let mut request = client
        .get(target)
        .header(reqwest::header::USER_AGENT, ua)
        .header(
            reqwest::header::ACCEPT,
            "application/yaml, text/yaml, text/plain, */*",
        );
    if let Some((user, password)) = credentials {
        request = request.basic_auth(user, Some(password));
    }
    let mut response = request.send().await.map_err(transport_failure)?;
    let status = response.status();
    if !status.is_success() {
        let message = match status.as_u16() {
            401 | 403 => format!(
                "订阅服务器拒绝访问（HTTP {status}），请检查订阅是否失效、请求头或服务器访问限制"
            ),
            404 | 410 => format!("订阅链接不存在或已失效（HTTP {status}）"),
            429 => "订阅服务器请求频率限制（HTTP 429），请稍后重试".into(),
            _ => format!("订阅服务器返回 HTTP {status}"),
        };
        return Err(DownloadFailure {
            message,
            retry: if status.is_server_error() {
                RetryPolicy::ServerError
            } else {
                RetryPolicy::None
            },
        });
    }
    let headers = response.headers().clone();
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(transport_failure)? {
        if body.len() + chunk.len() > MAX_BODY {
            return Err(DownloadFailure {
                message: "订阅文件超过 16 MiB，请检查下载地址".into(),
                retry: RetryPolicy::None,
            });
        }
        body.extend_from_slice(&chunk);
    }
    let content = String::from_utf8(body).map_err(|_| DownloadFailure {
        message: "订阅文件不是 UTF-8 编码".into(),
        retry: RetryPolicy::None,
    })?;
    let content = validate_content(&content).map_err(|message| DownloadFailure {
        message,
        retry: RetryPolicy::None,
    })?;
    Ok(DownloadedSubscription { content, headers })
}

pub(crate) async fn download(
    url: &str,
    ua: &str,
    routes: Vec<Option<String>>,
) -> Result<DownloadedSubscription, String> {
    let url = normalize_url(url)?;
    // Total bound includes retries, DNS, redirects and response body reads.
    tokio::time::timeout(Duration::from_secs(45), async {
        let mut last_error = "订阅下载失败".to_string();
        // Try each available route before spending the budget on protocol retries.
        for http1 in [false, true] {
            for (index, route) in routes.iter().enumerate() {
                match attempt(&url, ua, route.as_deref(), http1).await {
                    Ok(result) => return Ok(result),
                    Err(error) => {
                        match error.retry {
                            RetryPolicy::None => return Err(error.message),
                            RetryPolicy::ServerError => {
                                // One alternate-route attempt only. Its outcome is final,
                                // even if it fails at the transport layer rather than HTTP.
                                let alternate = routes
                                    .iter()
                                    .skip(index + 1)
                                    .chain(routes.iter().take(index))
                                    .find(|alternate| *alternate != route);
                                let Some(alternate) = alternate else {
                                    return Err(error.message);
                                };
                                tokio::time::sleep(Duration::from_millis(150)).await;
                                return attempt(&url, ua, alternate.as_deref(), http1)
                                    .await
                                    .map_err(|retry_error| retry_error.message);
                            }
                            RetryPolicy::Transport => {}
                        }
                        last_error = error.message;
                    }
                }
                tokio::time::sleep(Duration::from_millis(150)).await;
            }
        }
        Err(last_error)
    })
    .await
    .map_err(|_| "订阅下载及线路重试已超时，请检查订阅地址或网络后重试".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_and_preserve_tokens() {
        assert_eq!(
            normalize_url(" \u{feff}example.com/sub?token=a%2Bb%26c ")
                .unwrap()
                .query(),
            Some("token=a%2Bb%26c")
        );
        assert_eq!(
            normalize_url("https://example.com/sub&token=abc")
                .unwrap()
                .as_str(),
            "https://example.com/sub?token=abc"
        );
        assert_eq!(
            normalize_url(
                "clash://install-config?url=https%3A%2F%2Fexample.com%2Fsub%3Ftoken%3Dabc"
            )
            .unwrap()
            .as_str(),
            "https://example.com/sub?token=abc"
        );
        assert!(normalize_url("file:///secret.yaml").is_err());
        assert!(normalize_url("").is_err());
    }

    #[test]
    fn validates_before_replacing_a_subscription() {
        assert_eq!(
            validate_content("\u{feff}proxies: []\n").unwrap(),
            "proxies: []"
        );
        assert!(validate_content("proxy-providers: {} ").is_ok());
        for invalid in [
            "",
            "<html>verification</html>",
            "error: expired",
            "c3M6Ly9leGFtcGxl",
            "- node",
        ] {
            assert!(validate_content(invalid).is_err());
        }
    }

    fn server(responses: Vec<Option<String>>) -> (String, std::thread::JoinHandle<Vec<String>>) {
        use std::io::{BufRead, BufReader, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        listener.set_nonblocking(true).unwrap();
        let handle = std::thread::spawn(move || {
            let mut requests = Vec::new();
            for response in responses {
                let start = std::time::Instant::now();
                let mut socket = loop {
                    match listener.accept() {
                        Ok((socket, _)) => break socket,
                        Err(error)
                            if error.kind() == std::io::ErrorKind::WouldBlock
                                && start.elapsed() < Duration::from_secs(5) =>
                        {
                            std::thread::sleep(Duration::from_millis(5));
                        }
                        Err(error) => panic!("fixture accept: {error}"),
                    }
                };
                socket.set_nonblocking(false).unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut reader = BufReader::new(socket.try_clone().unwrap());
                let mut request = String::new();
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap() == 0 || line == "\r\n" {
                        break;
                    }
                    request.push_str(&line);
                }
                requests.push(request);
                if let Some(response) = response {
                    socket.write_all(response.as_bytes()).unwrap();
                }
            }
            requests
        });
        (format!("http://{address}"), handle)
    }

    fn ok() -> String {
        let body = "\u{feff}proxies: []\n";
        format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\nsubscription-userinfo: upload=1; download=2; total=100\r\n\r\n{body}", body.len())
    }

    #[tokio::test]
    async fn retries_a_reset_connection_and_preserves_metadata() {
        let (url, worker) = server(vec![None, Some(ok())]);
        let result = download(&format!("{url}/sub?token=SECRET"), "clash.meta", vec![None])
            .await
            .unwrap();
        assert_eq!(result.content, "proxies: []");
        assert!(result.headers.contains_key("subscription-userinfo"));
        assert_eq!(worker.join().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn retries_an_interrupted_response_body() {
        let (url, worker) = server(vec![
            Some(
                "HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\nproxies:"
                    .into(),
            ),
            Some(ok()),
        ]);
        assert_eq!(
            download(&url, "clash.meta", vec![None])
                .await
                .unwrap()
                .content,
            "proxies: []"
        );
        assert_eq!(worker.join().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn encoded_basic_auth_is_sent_as_a_header() {
        let (url, worker) = server(vec![Some(ok())]);
        let url = url.replacen("http://", "http://user:p%40ss@", 1);
        download(&url, "clash.meta", vec![None]).await.unwrap();
        let requests = worker.join().unwrap();
        assert!(requests[0]
            .to_ascii_lowercase()
            .contains("authorization: basic dxnlcjpwqhnz"));
        assert!(!requests[0].starts_with("GET http://user:"));
    }

    #[tokio::test]
    async fn follows_redirects_and_sends_user_agent() {
        let (url, worker) = server(vec![Some("HTTP/1.1 302 Found\r\nLocation: /final\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into()), Some(ok())]);
        download(&url, "clash.meta", vec![None]).await.unwrap();
        let requests = worker.join().unwrap();
        assert!(requests[1].starts_with("GET /final "));
        assert!(requests[1]
            .to_ascii_lowercase()
            .contains("user-agent: clash.meta"));
    }

    #[tokio::test]
    async fn authentication_errors_are_not_retried_or_leaked() {
        let (url, worker) = server(vec![Some(
            "HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into(),
        )]);
        let error = download(
            &format!("{url}/SECRET?token=SECRET"),
            "clash.meta",
            vec![None, None],
        )
        .await
        .err()
        .unwrap();
        assert!(error.contains("401"));
        assert!(!error.contains("SECRET"));
        assert_eq!(worker.join().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn falls_back_to_an_explicit_local_proxy() {
        let reservation = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let unavailable = format!("http://{}/sub", reservation.local_addr().unwrap());
        drop(reservation);
        let (proxy, worker) = server(vec![Some(ok())]);
        let result = download(&unavailable, "clash.meta", vec![None, Some(proxy)])
            .await
            .unwrap();
        assert_eq!(result.content, "proxies: []");
        assert!(worker.join().unwrap()[0].starts_with("GET http://"));
    }

    fn unavailable_response() -> String {
        "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into()
    }

    #[tokio::test]
    async fn server_errors_stop_without_a_distinct_alternate_route() {
        let (url, worker) = server(vec![Some(unavailable_response())]);
        let error = download(&url, "clash.meta", vec![None, None])
            .await
            .err()
            .unwrap();
        assert!(error.contains("503"));
        assert_eq!(worker.join().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn server_errors_retry_once_on_another_route_then_stop() {
        let (url, direct) = server(vec![Some(unavailable_response())]);
        let (proxy, alternate) = server(vec![Some(unavailable_response())]);
        // If a third route or protocol round is tried, the final error won't be 503.
        let error = download(
            &url,
            "clash.meta",
            vec![None, Some(proxy), Some("http://[invalid".into())],
        )
        .await
        .err()
        .unwrap();
        assert!(error.contains("503"));
        assert_eq!(direct.join().unwrap().len(), 1);
        assert_eq!(alternate.join().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn server_error_alternate_route_can_succeed() {
        let (url, direct) = server(vec![Some(unavailable_response())]);
        let (proxy, alternate) = server(vec![Some(ok())]);
        let result = download(&url, "clash.meta", vec![None, Some(proxy)])
            .await
            .unwrap();
        assert_eq!(result.content, "proxies: []");
        assert_eq!(direct.join().unwrap().len(), 1);
        let requests = alternate.join().unwrap();
        assert_eq!(requests.len(), 1);
        assert!(requests[0].starts_with("GET http://"));
    }

    #[tokio::test]
    async fn server_error_followed_by_transport_failure_does_not_reset_retry_budget() {
        let (url, direct) = server(vec![Some(unavailable_response())]);
        let (proxy, alternate) = server(vec![None]);
        let error = download(
            &url,
            "clash.meta",
            vec![None, Some(proxy), Some("http://[invalid".into())],
        )
        .await
        .err()
        .unwrap();
        assert!(error.contains("ECONNRESET"));
        assert_eq!(direct.join().unwrap().len(), 1);
        assert_eq!(alternate.join().unwrap().len(), 1);
    }
}
