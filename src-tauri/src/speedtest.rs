//! 网速测试：内核运行时走混合端口（按规则选出站），否则直连。
//! 依次测延迟、抖动、下载和上传，前端轮询状态画实时曲线。

use std::{
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, MutexGuard, OnceLock,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde_json::{json, Value};

type CompatResult = Result<Value, String>;

const CLOUDFLARE_HOST: &str = "https://speed.cloudflare.com";
const APPLE_CONFIG_URL: &str = "https://mensura.cdn-apple.com/api/v1/gm/config";
const SPEEDTEST_SERVERS_URL: &str =
    "https://www.speedtest.net/api/js/servers?engine=js&limit=5&https_functional=true";

const DOWNLOAD_BYTES: u64 = 25_000_000;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(8);
const LATENCY_TIMEOUT: Duration = Duration::from_secs(3);
const LATENCY_SAMPLES: usize = 8;
const SAMPLE_INTERVAL: Duration = Duration::from_millis(250);
const MAX_SERIES: usize = 240;
const MIN_UPLOAD_CHUNK: usize = 256 * 1024;
const MAX_UPLOAD_CHUNK: usize = 4 * 1024 * 1024;
const USER_AGENT: &str = "Diodos/1.0";

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .unwrap_or_default()
}

// ---------------------------------------------------------------- 计算

fn median(values: &[f64]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    let middle = sorted.len() / 2;
    if sorted.len() % 2 == 0 {
        (sorted[middle - 1] + sorted[middle]) / 2.0
    } else {
        sorted[middle]
    }
}

/// 相邻两次延迟之差的平均值
fn jitter(values: &[f64]) -> f64 {
    if values.len() < 2 {
        return 0.0;
    }
    let total: f64 = values.windows(2).map(|pair| (pair[1] - pair[0]).abs()).sum();
    total / (values.len() - 1) as f64
}

/// (已过秒数, 累计字节数)
type Sample = (f64, u64);

/// 最近一秒的速率（bit/s）
fn window_speed(samples: &[Sample]) -> f64 {
    let Some(&(end_at, end_bytes)) = samples.last() else {
        return 0.0;
    };
    let from = end_at - 1.0;
    let &(start_at, start_bytes) = samples
        .iter()
        .find(|(at, _)| *at >= from)
        .unwrap_or(&samples[0]);
    let elapsed = end_at - start_at;
    if elapsed <= 0.0 {
        return 0.0;
    }
    end_bytes.saturating_sub(start_bytes) as f64 * 8.0 / elapsed
}

/// 去掉前 20% 的慢启动，取之后的平均速率（bit/s）
fn stable_speed(samples: &[Sample]) -> f64 {
    let Some(&(end_at, end_bytes)) = samples.last() else {
        return 0.0;
    };
    let from = end_at * 0.2;
    let &(start_at, start_bytes) = samples
        .iter()
        .find(|(at, _)| *at >= from)
        .unwrap_or(&samples[0]);
    let elapsed = end_at - start_at;
    if elapsed <= 0.0 {
        return 0.0;
    }
    end_bytes.saturating_sub(start_bytes) as f64 * 8.0 / elapsed
}

// ---------------------------------------------------------------- 测速目标

#[derive(Debug, Clone, PartialEq)]
struct Target {
    latency_url: String,
    download_url: String,
    upload_url: String,
    server: Value,
}

fn parse_trace(body: &str) -> Option<(String, String, String)> {
    let field = |name: &str| {
        body.lines()
            .find_map(|line| line.strip_prefix(name)?.strip_prefix('='))
            .map(|value| value.trim().to_string())
            .unwrap_or_default()
    };
    let ip = field("ip");
    if ip.is_empty() {
        return None;
    }
    Some((ip, field("loc").to_uppercase(), field("colo").to_uppercase()))
}

fn cloudflare_target(host: &str, trace: &str) -> Option<Target> {
    let (ip, country, colo) = parse_trace(trace)?;
    Some(Target {
        latency_url: format!("{host}/__down?bytes=0"),
        download_url: format!("{host}/__down?bytes={DOWNLOAD_BYTES}"),
        upload_url: format!("{host}/__up"),
        server: json!({ "name": "Cloudflare", "location": colo, "country": country, "exitIp": ip }),
    })
}

fn apple_target(config: &Value) -> Option<Target> {
    let urls = config.get("urls")?;
    let text = |key: &str| urls.get(key).and_then(Value::as_str).filter(|value| !value.is_empty());
    let large = text("large_https_download_url")?;
    let upload = text("https_upload_url")?;
    Some(Target {
        latency_url: text("small_https_download_url").unwrap_or(large).to_string(),
        download_url: large.to_string(),
        upload_url: upload.to_string(),
        server: json!({
            "name": "Apple",
            "location": config.get("test_endpoint").and_then(Value::as_str).unwrap_or_default(),
        }),
    })
}

fn speedtest_targets(servers: &Value) -> Vec<Target> {
    let Some(list) = servers.as_array() else {
        return Vec::new();
    };
    list.iter()
        .filter_map(|server| {
            let host = server.get("host")?.as_str().filter(|value| !value.is_empty())?;
            let text = |key: &str| server.get(key).and_then(Value::as_str).unwrap_or_default();
            Some(Target {
                latency_url: format!("https://{host}/latency.txt"),
                download_url: format!("https://{host}/download?size={DOWNLOAD_BYTES}"),
                upload_url: format!("https://{host}/upload"),
                server: json!({
                    "name": text("sponsor"),
                    "location": text("name"),
                    "country": text("cc").to_uppercase(),
                }),
            })
        })
        .collect()
}

// ---------------------------------------------------------------- 运行

#[derive(Debug)]
enum Failure {
    Blocked,
    Unavailable,
    Timeout,
    Cancelled,
}

impl Failure {
    fn code(&self) -> &'static str {
        match self {
            Failure::Blocked => "blocked",
            Failure::Unavailable => "unavailable",
            Failure::Timeout => "timeout",
            Failure::Cancelled => "cancelled",
        }
    }

    fn from_request(error: &reqwest::Error) -> Self {
        if error.is_timeout() {
            Failure::Timeout
        } else {
            Failure::Unavailable
        }
    }
}

struct Run {
    client: reqwest::Client,
    status: Arc<Mutex<Value>>,
    cancel: Arc<AtomicBool>,
    duration: Duration,
    streams: usize,
}

impl Run {
    fn update(&self, change: impl FnOnce(&mut Value)) {
        let mut status = lock(&self.status);
        change(&mut status);
        status["updatedAt"] = json!(now_millis());
    }

    fn check_cancel(&self) -> Result<(), Failure> {
        if self.cancel.load(Ordering::Relaxed) {
            Err(Failure::Cancelled)
        } else {
            Ok(())
        }
    }

    async fn get_text(&self, url: &str) -> Result<String, Failure> {
        let response = self
            .client
            .get(url)
            .timeout(REQUEST_TIMEOUT)
            .send()
            .await
            .map_err(|error| Failure::from_request(&error))?;
        if !response.status().is_success() {
            return Err(Failure::Blocked);
        }
        response.text().await.map_err(|error| Failure::from_request(&error))
    }

    async fn latency_once(&self, url: &str) -> Option<f64> {
        let started = Instant::now();
        let response = self.client.get(url).timeout(LATENCY_TIMEOUT).send().await.ok()?;
        let elapsed = started.elapsed().as_secs_f64() * 1000.0;
        if !response.status().is_success() {
            return None;
        }
        // 读完才能复用连接，下一次才不包含建连时间
        let _ = response.bytes().await;
        Some(elapsed)
    }

    async fn prepare(&self, provider: &str) -> Result<Target, Failure> {
        match provider {
            "apple" => {
                let body = self.get_text(APPLE_CONFIG_URL).await?;
                let config = serde_json::from_str::<Value>(&body).map_err(|_| Failure::Blocked)?;
                apple_target(&config).ok_or(Failure::Blocked)
            }
            "speedtest" => {
                let body = self.get_text(SPEEDTEST_SERVERS_URL).await?;
                let servers = serde_json::from_str::<Value>(&body).map_err(|_| Failure::Blocked)?;
                let mut best: Option<(f64, Target)> = None;
                for target in speedtest_targets(&servers) {
                    self.check_cancel()?;
                    if let Some(rtt) = self.latency_once(&target.latency_url).await {
                        if best.as_ref().map_or(true, |(fastest, _)| rtt < *fastest) {
                            best = Some((rtt, target));
                        }
                    }
                }
                best.map(|(_, target)| target).ok_or(Failure::Blocked)
            }
            _ => {
                let trace = self.get_text(&format!("{CLOUDFLARE_HOST}/cdn-cgi/trace")).await?;
                cloudflare_target(CLOUDFLARE_HOST, &trace).ok_or(Failure::Blocked)
            }
        }
    }

    async fn measure_latency(&self, url: &str) -> Result<(), Failure> {
        // 第一次包含建连，只用来热身
        let _ = self.latency_once(url).await;
        let mut samples = Vec::with_capacity(LATENCY_SAMPLES);
        for index in 0..LATENCY_SAMPLES {
            self.check_cancel()?;
            if let Some(rtt) = self.latency_once(url).await {
                samples.push(rtt);
            }
            let (latency, spread) = (median(&samples), jitter(&samples));
            self.update(|status| {
                status["latency"] = json!(latency);
                status["jitter"] = json!(spread);
                status["phaseProgress"] = json!((index + 1) as f64 / LATENCY_SAMPLES as f64);
            });
        }
        if samples.is_empty() {
            return Err(Failure::Timeout);
        }
        Ok(())
    }

    /// 同时跑多条连接直到时间到，返回稳定速率；过程中更新实时速率和曲线
    async fn measure_load(
        &self,
        series: &str,
        spawn_worker: impl Fn(Arc<AtomicU64>, Arc<AtomicU64>) -> tokio::task::JoinHandle<()>,
    ) -> Result<(f64, u64), Failure> {
        let counter = Arc::new(AtomicU64::new(0));
        let failures = Arc::new(AtomicU64::new(0));
        let workers = (0..self.streams)
            .map(|_| spawn_worker(counter.clone(), failures.clone()))
            .collect::<Vec<_>>();
        let abort_all = |workers: &[tokio::task::JoinHandle<()>]| {
            for worker in workers {
                worker.abort();
            }
        };

        let started = Instant::now();
        let mut samples: Vec<Sample> = vec![(0.0, 0)];
        let outcome = loop {
            tokio::time::sleep(SAMPLE_INTERVAL).await;
            if self.cancel.load(Ordering::Relaxed) {
                break Err(Failure::Cancelled);
            }
            let elapsed = started.elapsed();
            let bytes = counter.load(Ordering::Relaxed);
            samples.push((elapsed.as_secs_f64(), bytes));
            let speed = window_speed(&samples);
            self.update(|status| {
                status["speed"] = json!(speed);
                status["phaseProgress"] = json!((elapsed.as_secs_f64() / self.duration.as_secs_f64()).min(1.0));
                if let Some(list) = status[series].as_array_mut() {
                    list.push(json!(speed));
                    if list.len() > MAX_SERIES {
                        list.remove(0);
                    }
                }
            });
            // 一个字节都没传成功、连接又在反复失败，继续等也没有意义
            if bytes == 0 && failures.load(Ordering::Relaxed) > self.streams as u64 * 3 {
                break Err(Failure::Unavailable);
            }
            if elapsed >= self.duration {
                break Ok(());
            }
        };
        abort_all(&workers);
        outcome?;

        let bytes = counter.load(Ordering::Relaxed);
        if bytes == 0 {
            return Err(Failure::Timeout);
        }
        Ok((stable_speed(&samples), bytes))
    }

    async fn download(&self, url: &str) -> Result<(f64, u64), Failure> {
        let client = self.client.clone();
        let url = url.to_string();
        self.measure_load("downloadSeries", move |counter, failures| {
            let client = client.clone();
            let url = url.clone();
            tokio::spawn(async move {
                loop {
                    let finished = async {
                        let mut response = client.get(&url).send().await.ok()?;
                        if !response.status().is_success() {
                            return None;
                        }
                        while let Some(chunk) = response.chunk().await.ok()? {
                            counter.fetch_add(chunk.len() as u64, Ordering::Relaxed);
                        }
                        Some(())
                    }
                    .await;
                    if finished.is_none() {
                        failures.fetch_add(1, Ordering::Relaxed);
                        tokio::time::sleep(Duration::from_millis(200)).await;
                    }
                }
            })
        })
        .await
    }

    async fn upload(&self, url: &str) -> Result<(f64, u64), Failure> {
        let client = self.client.clone();
        let url = url.to_string();
        self.measure_load("uploadSeries", move |counter, failures| {
            let client = client.clone();
            let url = url.clone();
            tokio::spawn(async move {
                // 从小块开始，传得快再加大：慢线路上一个大块可能到结束都传不完，算不出速度
                let mut size = MIN_UPLOAD_CHUNK;
                loop {
                    let started = Instant::now();
                    let body: &'static [u8] = &upload_payload()[..size];
                    let result = client
                        .post(&url)
                        .header("Content-Type", "application/octet-stream")
                        .body(body)
                        .send()
                        .await;
                    match result {
                        Ok(response) if response.status().is_success() => {
                            let _ = response.bytes().await;
                            counter.fetch_add(size as u64, Ordering::Relaxed);
                            if started.elapsed() < Duration::from_millis(500) {
                                size = (size * 2).min(MAX_UPLOAD_CHUNK);
                            }
                        }
                        _ => {
                            failures.fetch_add(1, Ordering::Relaxed);
                            tokio::time::sleep(Duration::from_millis(200)).await;
                        }
                    }
                }
            })
        })
        .await
    }

    fn set_phase(&self, phase: &str) {
        self.update(|status| {
            status["phase"] = json!(phase);
            status["phaseProgress"] = json!(0);
            status["speed"] = json!(0);
        });
    }

    async fn execute(&self, target: Target) -> Result<(), Failure> {
        self.update(|status| status["server"] = target.server.clone());

        self.set_phase("latency");
        self.measure_latency(&target.latency_url).await?;

        self.set_phase("download");
        let (download, down_bytes) = self.download(&target.download_url).await?;
        self.update(|status| {
            status["download"] = json!(download);
            status["bytes"] = json!(down_bytes);
        });

        self.set_phase("upload");
        let (upload, up_bytes) = self.upload(&target.upload_url).await?;
        self.update(|status| {
            status["upload"] = json!(upload);
            status["bytes"] = json!(down_bytes + up_bytes);
            status["speed"] = json!(0);
        });
        Ok(())
    }

    fn finish(&self, result: Result<(), Failure>) {
        self.update(|status| {
            status["speed"] = json!(0);
            match result {
                Ok(()) => {
                    status["state"] = json!("done");
                    status["phase"] = json!("done");
                }
                Err(Failure::Cancelled) => status["state"] = json!("cancelled"),
                Err(failure) => {
                    status["state"] = json!("error");
                    status["error"] = json!(failure.code());
                }
            }
        });
    }
}

/// 不可压缩的上传数据，整个进程共用一份
fn upload_payload() -> &'static [u8] {
    static PAYLOAD: OnceLock<Vec<u8>> = OnceLock::new();
    PAYLOAD.get_or_init(|| {
        let mut state = 0x9E37_79B9_7F4A_7C15_u64;
        let mut data = Vec::with_capacity(MAX_UPLOAD_CHUNK + 8);
        while data.len() < MAX_UPLOAD_CHUNK {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            data.extend_from_slice(&state.to_le_bytes());
        }
        data.truncate(MAX_UPLOAD_CHUNK);
        data
    })
}

fn initial_status(provider: &str, direct: bool, duration: u64, streams: usize) -> Value {
    json!({
        "state": "running",
        "provider": provider,
        "direct": direct,
        "duration": duration,
        "streams": streams,
        "phase": "connecting",
        "phaseProgress": 0,
        "speed": 0,
        "latency": 0,
        "jitter": 0,
        "download": 0,
        "upload": 0,
        "bytes": 0,
        "downloadSeries": [],
        "uploadSeries": [],
        "startedAt": now_millis(),
        "updatedAt": now_millis()
    })
}

fn build_client(proxy_url: Option<&str>) -> Result<reqwest::Client, String> {
    let builder = reqwest::Client::builder()
        .connect_timeout(REQUEST_TIMEOUT)
        .user_agent(USER_AGENT)
        .pool_max_idle_per_host(16);
    let builder = match proxy_url {
        Some(url) => builder.proxy(reqwest::Proxy::all(url).map_err(|error| error.to_string())?),
        // 明确直连，不读系统代理
        None => builder.no_proxy(),
    };
    builder.build().map_err(|error| error.to_string())
}

// ---------------------------------------------------------------- 状态

struct Slot {
    cancel: Arc<AtomicBool>,
    status: Arc<Mutex<Value>>,
}

fn slot() -> &'static Mutex<Slot> {
    static SLOT: OnceLock<Mutex<Slot>> = OnceLock::new();
    SLOT.get_or_init(|| {
        Mutex::new(Slot {
            cancel: Arc::new(AtomicBool::new(false)),
            status: Arc::new(Mutex::new(json!({ "state": "idle" }))),
        })
    })
}

fn start(args: &[Value], mixed_port: impl FnOnce() -> u16) -> CompatResult {
    let options = args.first().cloned().unwrap_or_else(|| json!({}));
    let provider = match options.get("provider").and_then(Value::as_str) {
        Some("apple") => "apple",
        Some("speedtest") => "speedtest",
        _ => "cloudflare",
    };
    let duration = options.get("duration").and_then(Value::as_u64).unwrap_or(10).clamp(3, 30);
    let streams = options.get("streams").and_then(Value::as_u64).unwrap_or(6).clamp(1, 16) as usize;
    let use_proxy = options.get("useProxy").and_then(Value::as_bool).unwrap_or(false);
    let proxy_url = use_proxy.then(|| format!("http://127.0.0.1:{}", mixed_port()));
    let client = build_client(proxy_url.as_deref())?;

    let mut slot = lock(slot());
    if lock(&slot.status)["state"] == "running" {
        return Ok(json!({ "success": false, "error": "busy" }));
    }
    let status = Arc::new(Mutex::new(initial_status(provider, !use_proxy, duration, streams)));
    let cancel = Arc::new(AtomicBool::new(false));
    slot.status = status.clone();
    slot.cancel = cancel.clone();
    drop(slot);

    let provider = provider.to_string();
    let run = Run {
        client,
        status,
        cancel,
        duration: Duration::from_secs(duration),
        streams,
    };
    tokio::spawn(async move {
        let result = match run.prepare(&provider).await {
            Ok(target) => run.execute(target).await,
            Err(failure) => Err(failure),
        };
        run.finish(result);
    });
    Ok(json!({ "success": true }))
}

pub(crate) async fn handle_compat_call(
    method: &str,
    args: &[Value],
    mixed_port: impl FnOnce() -> u16,
) -> Option<CompatResult> {
    let result = match method {
        "speedTestStart" => start(args, mixed_port),
        "speedTestStatus" => {
            let status = lock(&lock(slot()).status).clone();
            Ok(json!({ "success": true, "status": status }))
        }
        "speedTestCancel" => {
            lock(slot()).cancel.store(true, Ordering::Relaxed);
            Ok(json!({ "success": true }))
        }
        _ => return None,
    };
    Some(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn median_handles_odd_even_and_empty() {
        assert_eq!(median(&[]), 0.0);
        assert_eq!(median(&[3.0, 1.0, 2.0]), 2.0);
        assert_eq!(median(&[4.0, 1.0, 3.0, 2.0]), 2.5);
    }

    #[test]
    fn jitter_is_the_mean_step_between_samples() {
        assert_eq!(jitter(&[10.0]), 0.0);
        assert_eq!(jitter(&[10.0, 14.0, 12.0]), 3.0);
    }

    #[test]
    fn window_speed_uses_the_last_second() {
        let samples = vec![(0.0, 0), (1.0, 1_000_000), (2.0, 1_000_000), (3.0, 2_000_000)];
        assert_eq!(window_speed(&samples), 8_000_000.0);
        assert_eq!(window_speed(&[]), 0.0);
    }

    #[test]
    fn stable_speed_skips_slow_start() {
        let samples = vec![(0.0, 0), (2.0, 0), (4.0, 1_000_000), (10.0, 4_000_000)];
        // 从第 2 秒算起：4 MB / 8 s = 4 Mbps
        assert_eq!(stable_speed(&samples), 4_000_000.0);
    }

    #[test]
    fn cloudflare_needs_an_ip_in_the_trace() {
        let target = cloudflare_target("https://h", "fl=1\nip=203.0.113.8\nloc=jp\ncolo=nrt\n").unwrap();
        assert_eq!(target.download_url, "https://h/__down?bytes=25000000");
        assert_eq!(target.server["location"], "NRT");
        assert_eq!(target.server["country"], "JP");
        assert!(cloudflare_target("https://h", "<html>blocked</html>").is_none());
    }

    #[test]
    fn apple_config_requires_download_and_upload() {
        let config = json!({
            "test_endpoint": "edge.example",
            "urls": {
                "small_https_download_url": "https://a/small",
                "large_https_download_url": "https://a/large",
                "https_upload_url": "https://a/slurp"
            }
        });
        let target = apple_target(&config).unwrap();
        assert_eq!(target.latency_url, "https://a/small");
        assert_eq!(target.upload_url, "https://a/slurp");
        assert!(apple_target(&json!({ "urls": { "https_upload_url": "x" } })).is_none());
        assert!(apple_target(&json!({})).is_none());
    }

    #[test]
    fn speedtest_servers_skip_entries_without_a_host() {
        let targets = speedtest_targets(&json!([
            { "host": "a.example:8080", "sponsor": "ISP", "name": "Tokyo", "cc": "jp" },
            { "host": "" },
            { "sponsor": "no host" }
        ]));
        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].latency_url, "https://a.example:8080/latency.txt");
        assert_eq!(targets[0].upload_url, "https://a.example:8080/upload");
        assert_eq!(targets[0].server["name"], "ISP");
        assert_eq!(targets[0].server["country"], "JP");
        assert!(speedtest_targets(&json!({})).is_empty());
    }

    #[test]
    fn upload_payload_covers_the_largest_chunk() {
        assert_eq!(upload_payload().len(), MAX_UPLOAD_CHUNK);
        assert_ne!(upload_payload()[0..8], upload_payload()[8..16]);
    }

    /// 本地起一个假的测速服务器，把完整流程跑一遍
    async fn mock_server(fail_all: bool) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else { return };
                tokio::spawn(async move {
                    let mut buffer = vec![0u8; 64 * 1024];
                    let mut request = Vec::new();
                    let (head_end, length) = loop {
                        let Ok(read) = socket.read(&mut buffer).await else { return };
                        if read == 0 {
                            return;
                        }
                        request.extend_from_slice(&buffer[..read]);
                        if let Some(end) = request.windows(4).position(|w| w == b"\r\n\r\n") {
                            let head = String::from_utf8_lossy(&request[..end]).to_lowercase();
                            let length = head
                                .lines()
                                .find_map(|line| line.strip_prefix("content-length:"))
                                .and_then(|value| value.trim().parse::<usize>().ok())
                                .unwrap_or(0);
                            break (end + 4, length);
                        }
                    };
                    let mut received = request.len() - head_end;
                    while received < length {
                        let Ok(read) = socket.read(&mut buffer).await else { return };
                        if read == 0 {
                            return;
                        }
                        received += read;
                    }
                    if fail_all {
                        let _ = socket
                            .write_all(b"HTTP/1.1 500 X\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                            .await;
                        return;
                    }
                    let path = String::from_utf8_lossy(&request).to_string();
                    let body_size = if path.starts_with("GET /down") { 2_000_000 } else { 0 };
                    let head = format!("HTTP/1.1 200 OK\r\nContent-Length: {body_size}\r\nConnection: close\r\n\r\n");
                    let _ = socket.write_all(head.as_bytes()).await;
                    let _ = socket.write_all(&vec![7u8; body_size]).await;
                });
            }
        });
        format!("http://{address}")
    }

    fn test_run(duration: Duration) -> Run {
        Run {
            client: build_client(None).unwrap(),
            status: Arc::new(Mutex::new(initial_status("cloudflare", true, 1, 2))),
            cancel: Arc::new(AtomicBool::new(false)),
            duration,
            streams: 2,
        }
    }

    fn target_at(base: &str) -> Target {
        Target {
            latency_url: format!("{base}/ping"),
            download_url: format!("{base}/down"),
            upload_url: format!("{base}/up"),
            server: json!({ "name": "mock" }),
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn full_run_reports_every_result() {
        let base = mock_server(false).await;
        let run = test_run(Duration::from_millis(1200));
        let result = run.execute(target_at(&base)).await;
        assert!(result.is_ok(), "{result:?}");
        run.finish(result);
        let status = lock(&run.status).clone();
        assert_eq!(status["state"], "done");
        assert_eq!(status["phase"], "done");
        assert_eq!(status["server"]["name"], "mock");
        assert!(status["latency"].as_f64().unwrap() > 0.0);
        assert!(status["download"].as_f64().unwrap() > 0.0);
        assert!(status["upload"].as_f64().unwrap() > 0.0);
        assert!(status["bytes"].as_u64().unwrap() > 0);
        assert!(!status["downloadSeries"].as_array().unwrap().is_empty());
        assert!(!status["uploadSeries"].as_array().unwrap().is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn failing_server_reports_an_error_quickly() {
        let base = mock_server(true).await;
        let run = test_run(Duration::from_secs(20));
        let started = Instant::now();
        let result = run.execute(target_at(&base)).await;
        assert!(result.is_err());
        assert!(started.elapsed() < Duration::from_secs(15));
        run.finish(result);
        assert_eq!(lock(&run.status)["state"], "error");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn cancel_stops_a_running_load() {
        let base = mock_server(false).await;
        let run = test_run(Duration::from_secs(20));
        let cancel = run.cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(600)).await;
            cancel.store(true, Ordering::Relaxed);
        });
        let started = Instant::now();
        let result = run.download(&format!("{base}/down")).await;
        assert!(matches!(result, Err(Failure::Cancelled)));
        assert!(started.elapsed() < Duration::from_secs(3));
    }
}
