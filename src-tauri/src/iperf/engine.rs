//! iperf3 TCP 协议（客户端 + 服务端），与官方 iperf3 3.x 以及安卓版 Diodos 互通。
//!
//! 控制连接先发 37 字节 cookie，之后用单字节状态码推进；参数与结果是
//! 4 字节大端长度 + JSON。数据连接只在开头发一次 cookie。

use std::{
    io::{self, Read, Write},
    net::{Shutdown, SocketAddr, TcpListener, TcpStream, ToSocketAddrs},
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

use serde_json::{json, Value};

pub const DEFAULT_PORT: u16 = 5201;
const COOKIE_SIZE: usize = 37;
const DEFAULT_BLOCK_SIZE: usize = 128 * 1024;
const CLIENT_VERSION: &str = "3.19";
const MAX_JSON_BYTES: usize = 1024 * 1024;
/// 服务端接受的最长测试时长（秒）
const MAX_DURATION: u32 = 3600;
/// 同时处理中的入站连接上限（单次测试最多 128 条数据流加一条控制连接），超出的直接关闭
const MAX_PENDING_CONNECTIONS: usize = 192;

const TEST_START: i8 = 1;
const TEST_RUNNING: i8 = 2;
const TEST_END: i8 = 4;
const PARAM_EXCHANGE: i8 = 9;
const CREATE_STREAMS: i8 = 10;
const SERVER_TERMINATE: i8 = 11;
const CLIENT_TERMINATE: i8 = 12;
const EXCHANGE_RESULTS: i8 = 13;
const DISPLAY_RESULTS: i8 = 14;
const IPERF_DONE: i8 = 16;
const ACCESS_DENIED: i8 = -1;
const SERVER_ERROR: i8 = -2;

const IE_UNIMP: i32 = 13;
const IE_ACCESS_DENIED: i32 = 121;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const CONTROL_TIMEOUT: Duration = Duration::from_secs(30);
const COOKIE_TIMEOUT: Duration = Duration::from_secs(10);
const STREAM_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Clone, Debug)]
pub struct Options {
    pub duration: u32,
    pub parallel: u32,
    pub reverse: bool,
    pub block_size: usize,
    pub omit: u32,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            duration: 10,
            parallel: 1,
            reverse: false,
            block_size: DEFAULT_BLOCK_SIZE,
            omit: 0,
        }
    }
}

impl Options {
    fn normalized(&self) -> Self {
        Self {
            duration: self.duration.clamp(1, 3600),
            parallel: self.parallel.clamp(1, 128),
            reverse: self.reverse,
            block_size: self.block_size.clamp(1024, 8 * 1024 * 1024),
            omit: self.omit.min(60),
        }
    }
}

#[derive(Clone, Debug)]
pub struct Interval {
    pub start: f64,
    pub end: f64,
    pub bytes: u64,
}

impl Interval {
    pub fn bits_per_second(&self) -> f64 {
        if self.end > self.start {
            self.bytes as f64 * 8.0 / (self.end - self.start)
        } else {
            0.0
        }
    }

    pub fn to_json(&self) -> Value {
        json!({ "start": self.start, "end": self.end, "bytes": self.bytes, "bitsPerSecond": self.bits_per_second() })
    }
}

#[derive(Clone, Debug)]
pub struct TestResult {
    pub reverse: bool,
    pub parallel: u32,
    pub sent_bytes: u64,
    pub sent_seconds: f64,
    pub received_bytes: u64,
    pub received_seconds: f64,
    pub intervals: Vec<Interval>,
}

impl TestResult {
    pub fn sender_bps(&self) -> f64 {
        rate(self.sent_bytes, self.sent_seconds)
    }

    pub fn receiver_bps(&self) -> f64 {
        rate(self.received_bytes, self.received_seconds)
    }

    pub fn to_json(&self) -> Value {
        json!({
            "reverse": self.reverse,
            "parallel": self.parallel,
            "sentBytes": self.sent_bytes,
            "sentSeconds": self.sent_seconds,
            "receivedBytes": self.received_bytes,
            "receivedSeconds": self.received_seconds,
            "senderBitsPerSecond": self.sender_bps(),
            "receiverBitsPerSecond": self.receiver_bps(),
            "intervals": self.intervals.iter().map(Interval::to_json).collect::<Vec<_>>()
        })
    }
}

fn rate(bytes: u64, seconds: f64) -> f64 {
    if seconds > 0.0 {
        bytes as f64 * 8.0 / seconds
    } else {
        0.0
    }
}

// ---------------------------------------------------------------- 线路格式

fn new_cookie() -> [u8; COOKIE_SIZE] {
    const CHARS: &[u8] = b"abcdefghijklmnopqrstuvwxyz234567";
    let mut raw = [0u8; COOKIE_SIZE];
    if getrandom::getrandom(&mut raw).is_err() {
        let seed = Instant::now().elapsed().as_nanos() as u64 ^ std::process::id() as u64;
        for (i, byte) in raw.iter_mut().enumerate() {
            *byte = (seed.wrapping_mul(6364136223846793005).wrapping_add(i as u64) >> 33) as u8;
        }
    }
    let mut cookie = [0u8; COOKIE_SIZE];
    for i in 0..COOKIE_SIZE - 1 {
        cookie[i] = CHARS[raw[i] as usize % CHARS.len()];
    }
    cookie
}

/// iperf3 的流编号：第一条是 1，之后从 3 开始（官方实现的历史遗留）。
fn stream_id(index: usize) -> u64 {
    if index == 0 {
        1
    } else {
        index as u64 + 2
    }
}

fn read_state(stream: &mut TcpStream) -> io::Result<i8> {
    let mut byte = [0u8; 1];
    stream.read_exact(&mut byte)?;
    Ok(byte[0] as i8)
}

fn write_state(mut stream: &TcpStream, state: i8) -> io::Result<()> {
    stream.write_all(&[state as u8])?;
    stream.flush()
}

fn write_json(mut stream: &TcpStream, value: &Value) -> io::Result<()> {
    let body = value.to_string().into_bytes();
    let mut frame = (body.len() as u32).to_be_bytes().to_vec();
    frame.extend_from_slice(&body);
    stream.write_all(&frame)?;
    stream.flush()
}

fn read_json(stream: &mut TcpStream) -> io::Result<Value> {
    let mut header = [0u8; 4];
    stream.read_exact(&mut header)?;
    let size = u32::from_be_bytes(header) as usize;
    if size == 0 || size > MAX_JSON_BYTES {
        return Err(io::Error::new(io::ErrorKind::InvalidData, format!("invalid JSON length {size}")));
    }
    let mut body = vec![0u8; size];
    stream.read_exact(&mut body)?;
    serde_json::from_slice(&body).map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err))
}

fn write_server_error(mut stream: &TcpStream, errno: i32) -> io::Result<()> {
    let mut frame = vec![SERVER_ERROR as u8];
    frame.extend_from_slice(&errno.to_be_bytes());
    frame.extend_from_slice(&0i32.to_be_bytes());
    stream.write_all(&frame)?;
    stream.flush()
}

struct StreamReport {
    id: u64,
    bytes: u64,
    seconds: f64,
}

/// 官方实现要求这些字段都在，否则判定结果无效。
fn results_json(is_sender: bool, streams: &[StreamReport]) -> Value {
    json!({
        "cpu_util_total": 0,
        "cpu_util_user": 0,
        "cpu_util_system": 0,
        "sender_has_retransmits": if is_sender { 0 } else { -1 },
        "streams": streams.iter().map(|s| json!({
            "id": s.id,
            "bytes": s.bytes,
            "retransmits": -1,
            "jitter": 0,
            "errors": 0,
            "omitted_errors": 0,
            "packets": 0,
            "omitted_packets": 0,
            "start_time": 0,
            "end_time": s.seconds
        })).collect::<Vec<_>>()
    })
}

fn parse_reports(value: &Value) -> Vec<StreamReport> {
    value
        .get("streams")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|item| {
                    let start = item.get("start_time").and_then(Value::as_f64).unwrap_or(0.0);
                    let end = item.get("end_time").and_then(Value::as_f64).unwrap_or(0.0);
                    StreamReport {
                        id: item.get("id").and_then(Value::as_u64).unwrap_or(0),
                        bytes: item.get("bytes").and_then(Value::as_f64).unwrap_or(0.0) as u64,
                        seconds: (end - start).max(0.0),
                    }
                })
                .collect()
        })
        .unwrap_or_default()
}

fn error_text(errno: i32) -> String {
    match errno {
        IE_ACCESS_DENIED => "the server is busy running a test".into(),
        IE_UNIMP => "an option is not supported by the server".into(),
        other => format!("server error {other}"),
    }
}

// ---------------------------------------------------------------- 数据流

struct DataStream {
    socket: TcpStream,
    id: u64,
    bytes: Arc<AtomicU64>,
    omitted: Arc<AtomicU64>,
}

impl DataStream {
    fn new(socket: TcpStream, index: usize) -> Self {
        Self {
            socket,
            id: stream_id(index),
            bytes: Arc::new(AtomicU64::new(0)),
            omitted: Arc::new(AtomicU64::new(0)),
        }
    }

    fn counted(&self) -> u64 {
        self.bytes
            .load(Ordering::Relaxed)
            .saturating_sub(self.omitted.load(Ordering::Relaxed))
    }

    fn start(&self, sending: bool, block_size: usize, stop: Arc<AtomicBool>, limit: u64) {
        let Ok(mut socket) = self.socket.try_clone() else { return };
        let bytes = self.bytes.clone();
        thread::spawn(move || {
            let mut buffer = vec![0u8; block_size.max(64 * 1024)];
            let _ = getrandom::getrandom(&mut buffer);
            while !stop.load(Ordering::Relaxed) {
                if sending {
                    let mut chunk = block_size;
                    if limit > 0 {
                        let left = limit.saturating_sub(bytes.load(Ordering::Relaxed));
                        if left == 0 {
                            return;
                        }
                        chunk = chunk.min(left as usize);
                    }
                    if socket.write_all(&buffer[..chunk]).is_err() {
                        return;
                    }
                    bytes.fetch_add(chunk as u64, Ordering::Relaxed);
                } else {
                    match socket.read(&mut buffer) {
                        Ok(0) | Err(_) => return,
                        Ok(read) => {
                            bytes.fetch_add(read as u64, Ordering::Relaxed);
                        }
                    }
                }
            }
        });
    }

    fn close(&self) {
        let _ = self.socket.shutdown(Shutdown::Both);
    }
}

/// 每秒打一次点。
struct Sampler {
    stop: Arc<AtomicBool>,
    intervals: Arc<Mutex<Vec<Interval>>>,
    counting_start: Arc<Mutex<Instant>>,
    handle: Option<thread::JoinHandle<()>>,
}

impl Sampler {
    fn start(
        counters: Vec<(Arc<AtomicU64>, Arc<AtomicU64>)>,
        omit: u32,
        on_interval: Arc<dyn Fn(&Interval) + Send + Sync>,
    ) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let intervals = Arc::new(Mutex::new(Vec::new()));
        let begin = Instant::now();
        let counting_start = Arc::new(Mutex::new(begin));
        let handle = {
            let stop = stop.clone();
            let intervals = intervals.clone();
            let counting_start = counting_start.clone();
            thread::spawn(move || {
                let counted = || -> u64 {
                    counters
                        .iter()
                        .map(|(bytes, omitted)| {
                            bytes.load(Ordering::Relaxed).saturating_sub(omitted.load(Ordering::Relaxed))
                        })
                        .sum()
                };
                if omit > 0 {
                    if !sleep_until(&stop, begin + Duration::from_secs(omit as u64)) {
                        return;
                    }
                    for (bytes, omitted) in &counters {
                        omitted.store(bytes.load(Ordering::Relaxed), Ordering::Relaxed);
                    }
                    *counting_start.lock().unwrap() = Instant::now();
                }
                let start = *counting_start.lock().unwrap();
                let mut last = 0u64;
                let mut last_at = start;
                let mut tick = 1u64;
                loop {
                    if !sleep_until(&stop, start + Duration::from_secs(tick)) {
                        return;
                    }
                    let now = Instant::now();
                    let current = counted();
                    let interval = Interval {
                        start: (last_at - start).as_secs_f64(),
                        end: (now - start).as_secs_f64(),
                        bytes: current.saturating_sub(last),
                    };
                    on_interval(&interval);
                    intervals.lock().unwrap().push(interval);
                    last = current;
                    last_at = now;
                    tick += 1;
                }
            })
        };
        Self {
            stop,
            intervals,
            counting_start,
            handle: Some(handle),
        }
    }

    fn elapsed(&self) -> f64 {
        self.counting_start.lock().unwrap().elapsed().as_secs_f64()
    }

    fn finish(&mut self) -> Vec<Interval> {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
        self.intervals.lock().unwrap().clone()
    }
}

impl Drop for Sampler {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

fn sleep_until(stop: &AtomicBool, deadline: Instant) -> bool {
    while !stop.load(Ordering::Relaxed) {
        let now = Instant::now();
        if now >= deadline {
            return true;
        }
        thread::sleep((deadline - now).min(Duration::from_millis(100)));
    }
    false
}

fn counters(streams: &[DataStream]) -> Vec<(Arc<AtomicU64>, Arc<AtomicU64>)> {
    streams.iter().map(|s| (s.bytes.clone(), s.omitted.clone())).collect()
}

// ---------------------------------------------------------------- 客户端

/// 用来从别的线程中止正在跑的客户端。
#[derive(Clone, Default)]
pub struct CancelHandle {
    cancelled: Arc<AtomicBool>,
    control: Arc<Mutex<Option<TcpStream>>>,
}

impl CancelHandle {
    pub fn cancel(&self) {
        if self.cancelled.swap(true, Ordering::SeqCst) {
            return;
        }
        if let Some(control) = self.control.lock().unwrap().as_ref() {
            let _ = write_state(control, CLIENT_TERMINATE);
            let _ = control.shutdown(Shutdown::Both);
        }
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
}

fn resolve(host: &str, port: u16) -> Result<SocketAddr, String> {
    (host, port)
        .to_socket_addrs()
        .map_err(|err| err.to_string())?
        .next()
        .ok_or_else(|| format!("unable to resolve {host}"))
}

fn connect(addr: SocketAddr) -> Result<TcpStream, String> {
    let stream = TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT).map_err(|err| match err.kind() {
        io::ErrorKind::ConnectionRefused => "connection refused".to_string(),
        io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock => "connection timed out".to_string(),
        _ => err.to_string(),
    })?;
    let _ = stream.set_nodelay(true);
    Ok(stream)
}

pub fn run_client(
    host: &str,
    port: u16,
    options: &Options,
    cancel: &CancelHandle,
    on_running: impl Fn(),
    on_interval: Arc<dyn Fn(&Interval) + Send + Sync>,
) -> Result<TestResult, String> {
    let options = options.normalized();
    let addr = resolve(host, port)?;
    let mut control = connect(addr)?;
    *cancel.control.lock().unwrap() = control.try_clone().ok();
    if cancel.is_cancelled() {
        return Err("cancelled".into());
    }
    let cookie = new_cookie();
    let stop = Arc::new(AtomicBool::new(false));
    let mut streams: Vec<DataStream> = Vec::new();
    let mut sampler: Option<Sampler> = None;
    let mut running_at: Option<Instant> = None;
    let mut result: Option<TestResult> = None;

    let outcome = (|| -> Result<TestResult, String> {
        control.set_read_timeout(Some(CONTROL_TIMEOUT)).map_err(|e| e.to_string())?;
        control.write_all(&cookie).map_err(|e| e.to_string())?;
        loop {
            let state = match read_state(&mut control) {
                Ok(state) => state,
                Err(err) if matches!(err.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut) => {
                    // 测试进行中控制通道本来就是安静的
                    let budget = Duration::from_secs((options.duration + options.omit) as u64) + CONTROL_TIMEOUT;
                    if running_at.map(|at| at.elapsed() < budget).unwrap_or(false) {
                        continue;
                    }
                    return Err("server stopped responding".into());
                }
                Err(err) => return Err(err.to_string()),
            };
            match state {
                PARAM_EXCHANGE => {
                    let mut params = json!({
                        "tcp": true,
                        "omit": options.omit,
                        "time": options.duration,
                        "num": 0,
                        "blockcount": 0,
                        "parallel": options.parallel,
                        "len": options.block_size,
                        "pacing_timer": 1000,
                        "client_version": CLIENT_VERSION
                    });
                    if options.reverse {
                        params["reverse"] = Value::Bool(true);
                    }
                    write_json(&control, &params).map_err(|e| e.to_string())?;
                }
                CREATE_STREAMS => {
                    for index in 0..options.parallel as usize {
                        if cancel.is_cancelled() {
                            return Err("cancelled".into());
                        }
                        let mut socket = connect(addr).map_err(|e| format!("unable to connect data stream: {e}"))?;
                        socket.write_all(&cookie).map_err(|e| e.to_string())?;
                        streams.push(DataStream::new(socket, index));
                    }
                }
                TEST_START => {}
                TEST_RUNNING => {
                    running_at = Some(Instant::now());
                    sampler = Some(Sampler::start(counters(&streams), options.omit, on_interval.clone()));
                    for stream in &streams {
                        stream.start(!options.reverse, options.block_size, stop.clone(), 0);
                    }
                    on_running();
                    let timer_stop = stop.clone();
                    let timer_control = control.try_clone().map_err(|e| e.to_string())?;
                    let total = Duration::from_secs((options.duration + options.omit) as u64);
                    let cancel_flag = cancel.cancelled.clone();
                    thread::spawn(move || {
                        let deadline = Instant::now() + total;
                        while Instant::now() < deadline {
                            if cancel_flag.load(Ordering::SeqCst) {
                                return;
                            }
                            thread::sleep(Duration::from_millis(50));
                        }
                        timer_stop.store(true, Ordering::Relaxed);
                        let _ = write_state(&timer_control, TEST_END);
                    });
                }
                EXCHANGE_RESULTS => {
                    stop.store(true, Ordering::Relaxed);
                    let seconds = sampler
                        .as_ref()
                        .map(Sampler::elapsed)
                        .unwrap_or_else(|| running_at.map(|at| at.elapsed().as_secs_f64()).unwrap_or(0.0));
                    for stream in &streams {
                        stream.close();
                    }
                    let own: Vec<StreamReport> = streams
                        .iter()
                        .map(|s| StreamReport { id: s.id, bytes: s.counted(), seconds })
                        .collect();
                    write_json(&control, &results_json(!options.reverse, &own)).map_err(|e| e.to_string())?;
                    let remote = parse_reports(&read_json(&mut control).map_err(|e| e.to_string())?);
                    let intervals = sampler.as_mut().map(Sampler::finish).unwrap_or_default();
                    result = Some(build_result(&options, &own, &remote, intervals));
                }
                DISPLAY_RESULTS => {
                    let _ = write_state(&control, IPERF_DONE);
                    return result.clone().ok_or_else(|| "server sent no results".to_string());
                }
                SERVER_TERMINATE => return Err("the server has terminated".into()),
                ACCESS_DENIED => return Err(error_text(IE_ACCESS_DENIED)),
                SERVER_ERROR => {
                    let mut errno = [0u8; 4];
                    let code = control.read_exact(&mut errno).map(|_| i32::from_be_bytes(errno)).unwrap_or(0);
                    let mut skip = [0u8; 4];
                    let _ = control.read_exact(&mut skip);
                    return Err(error_text(code));
                }
                other => return Err(format!("unexpected state {other}")),
            }
        }
    })();

    stop.store(true, Ordering::Relaxed);
    if let Some(mut sampler) = sampler {
        sampler.finish();
    }
    for stream in &streams {
        stream.close();
    }
    let _ = control.shutdown(Shutdown::Both);
    *cancel.control.lock().unwrap() = None;
    match outcome {
        Err(_) if cancel.is_cancelled() => Err("cancelled".into()),
        other => other,
    }
}

fn build_result(options: &Options, own: &[StreamReport], remote: &[StreamReport], intervals: Vec<Interval>) -> TestResult {
    let own_bytes: u64 = own.iter().map(|s| s.bytes).sum();
    let own_seconds = own.iter().map(|s| s.seconds).fold(0.0, f64::max);
    let remote_bytes: u64 = remote.iter().map(|s| s.bytes).sum();
    let remote_seconds = remote.iter().map(|s| s.seconds).fold(0.0, f64::max);
    let remote_seconds = if remote_seconds > 0.0 { remote_seconds } else { own_seconds };
    if options.reverse {
        TestResult {
            reverse: true,
            parallel: options.parallel,
            sent_bytes: remote_bytes,
            sent_seconds: remote_seconds,
            received_bytes: own_bytes,
            received_seconds: own_seconds,
            intervals,
        }
    } else {
        TestResult {
            reverse: false,
            parallel: options.parallel,
            sent_bytes: own_bytes,
            sent_seconds: own_seconds,
            received_bytes: remote_bytes,
            received_seconds: remote_seconds,
            intervals,
        }
    }
}

// ---------------------------------------------------------------- 服务端

pub trait ServerListener: Send + Sync {
    /// [peer_sends] 为 true 表示对端在上传、本机在接收
    fn on_test_started(&self, _peer: &str, _peer_sends: bool, _parallel: u32, _duration: u32) {}
    fn on_interval(&self, _interval: &Interval) {}
    fn on_test_finished(&self, _peer: &str, _result: &TestResult) {}
    fn on_test_failed(&self, _peer: &str, _message: &str) {}
}

struct Session {
    cookie: [u8; COOKIE_SIZE],
    accepting: AtomicBool,
    /// 结果已发出、只等对端收尾；此时来的新测试稍等即可，不必拒绝
    finishing: AtomicBool,
    incoming: Mutex<Option<mpsc::Sender<(u64, TcpStream)>>>,
    stop: Arc<AtomicBool>,
    control: TcpStream,
}

struct ServerShared {
    running: AtomicBool,
    active: Mutex<Option<Arc<Session>>>,
    listener: Arc<dyn ServerListener>,
    seq: AtomicU64,
    pending: AtomicUsize,
}

/// 入站连接处理期间占一个名额，结束时归还
struct PendingGuard(Arc<ServerShared>);

impl Drop for PendingGuard {
    fn drop(&mut self) {
        self.0.pending.fetch_sub(1, Ordering::SeqCst);
    }
}

/// 一次只跑一个测试，期间的新控制连接回 ACCESS_DENIED，和 `iperf3 -s` 行为一致。
pub struct Server {
    shared: Arc<ServerShared>,
    socket: TcpListener,
    port: u16,
}

impl Server {
    /// 优先用 [preferred]，被占用时退回系统分配的端口。
    pub fn start(preferred: u16, fallback: bool, listener: Arc<dyn ServerListener>) -> Result<Self, String> {
        let socket = TcpListener::bind(("0.0.0.0", preferred))
            .or_else(|err| if fallback { TcpListener::bind(("0.0.0.0", 0)) } else { Err(err) })
            .map_err(|err| err.to_string())?;
        let port = socket.local_addr().map_err(|e| e.to_string())?.port();
        let shared = Arc::new(ServerShared {
            running: AtomicBool::new(true),
            active: Mutex::new(None),
            listener,
            seq: AtomicU64::new(0),
            pending: AtomicUsize::new(0),
        });
        let accept_socket = socket.try_clone().map_err(|e| e.to_string())?;
        let accept_shared = shared.clone();
        thread::spawn(move || {
            for connection in accept_socket.incoming() {
                if !accept_shared.running.load(Ordering::SeqCst) {
                    break;
                }
                let Ok(connection) = connection else { continue };
                // 大量连上来却不发数据的连接会各占一个线程，超过上限直接关闭
                if accept_shared.pending.fetch_add(1, Ordering::SeqCst) >= MAX_PENDING_CONNECTIONS {
                    accept_shared.pending.fetch_sub(1, Ordering::SeqCst);
                    let _ = connection.shutdown(Shutdown::Both);
                    continue;
                }
                let guard = PendingGuard(accept_shared.clone());
                let seq = accept_shared.seq.fetch_add(1, Ordering::SeqCst);
                let shared = accept_shared.clone();
                thread::spawn(move || {
                    let _guard = guard;
                    classify(shared, connection, seq)
                });
            }
        });
        Ok(Self { shared, socket, port })
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn is_busy(&self) -> bool {
        self.shared.active.lock().unwrap().is_some()
    }

    pub fn stop(&self) {
        self.shared.running.store(false, Ordering::SeqCst);
        // 唤醒阻塞中的 accept
        let _ = TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], self.port)), Duration::from_millis(300));
        let _ = &self.socket;
        if let Some(session) = self.shared.active.lock().unwrap().take() {
            session.stop.store(true, Ordering::SeqCst);
            let _ = write_state(&session.control, SERVER_TERMINATE);
            let _ = session.control.shutdown(Shutdown::Both);
        }
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop();
    }
}

fn classify(shared: Arc<ServerShared>, mut socket: TcpStream, seq: u64) {
    if !shared.running.load(Ordering::SeqCst) {
        return;
    }
    let _ = socket.set_nodelay(true);
    let _ = socket.set_read_timeout(Some(COOKIE_TIMEOUT));
    let mut cookie = [0u8; COOKIE_SIZE];
    if socket.read_exact(&mut cookie).is_err() {
        return;
    }
    // 上一个测试在收尾时，给它一点时间结束
    let wait_until = Instant::now() + Duration::from_secs(3);
    loop {
        let finishing = shared
            .active
            .lock()
            .unwrap()
            .as_ref()
            .map(|s| s.finishing.load(Ordering::SeqCst))
            .unwrap_or(false);
        if !finishing || Instant::now() >= wait_until {
            break;
        }
        thread::sleep(Duration::from_millis(20));
    }
    let session = {
        let mut active = shared.active.lock().unwrap();
        if let Some(current) = active.as_ref() {
            if current.accepting.load(Ordering::SeqCst) && current.cookie == cookie {
                let _ = socket.set_read_timeout(None);
                if let Some(sender) = current.incoming.lock().unwrap().as_ref() {
                    let _ = sender.send((seq, socket));
                }
            } else {
                let _ = write_state(&socket, ACCESS_DENIED);
            }
            return;
        }
        let Ok(control) = socket.try_clone() else { return };
        let session = Arc::new(Session {
            cookie,
            accepting: AtomicBool::new(false),
            finishing: AtomicBool::new(false),
            incoming: Mutex::new(None),
            stop: Arc::new(AtomicBool::new(false)),
            control,
        });
        *active = Some(session.clone());
        session
    };
    let peer = socket.peer_addr().map(|a| a.ip().to_string()).unwrap_or_default();
    if let Err(message) = run_session(&shared, &session, &mut socket, &peer) {
        if !session.stop.load(Ordering::SeqCst) {
            shared.listener.on_test_failed(&peer, &message);
        }
    }
    session.stop.store(true, Ordering::SeqCst);
    let _ = socket.shutdown(Shutdown::Both);
    let mut active = shared.active.lock().unwrap();
    if active.as_ref().map(|s| Arc::ptr_eq(s, &session)).unwrap_or(false) {
        *active = None;
    }
}

fn run_session(shared: &ServerShared, session: &Session, control: &mut TcpStream, peer: &str) -> Result<(), String> {
    let io = |e: io::Error| e.to_string();
    control.set_read_timeout(Some(CONTROL_TIMEOUT)).map_err(io)?;
    write_state(control, PARAM_EXCHANGE).map_err(io)?;
    let params = read_json(control).map_err(io)?;
    let flag = |key: &str| params.get(key).and_then(Value::as_bool).unwrap_or(false);
    if flag("udp") || flag("sctp") || flag("bidirectional") {
        let _ = write_server_error(control, IE_UNIMP);
        return Err("unsupported test mode".into());
    }
    let number = |key: &str| params.get(key).and_then(Value::as_f64).unwrap_or(0.0);
    let parallel = (number("parallel") as u32).clamp(1, 128);
    let reverse = flag("reverse");
    let duration = (params.get("time").and_then(Value::as_f64).unwrap_or(10.0).max(0.0) as u32).min(MAX_DURATION);
    let omit = (number("omit") as u32).min(60);
    let block_size = match number("len") as usize {
        size @ 1..=16_777_216 => size,
        _ => DEFAULT_BLOCK_SIZE,
    };
    let total = if number("num") > 0.0 {
        number("num") as u64
    } else {
        (number("blockcount") as u64).saturating_mul(block_size as u64)
    };
    let limit = if total > 0 { total.div_ceil(parallel as u64) } else { 0 };
    // 既不限时长又不限字节数的测试会一直占用本机，直接拒绝
    if duration == 0 && limit == 0 {
        let _ = write_server_error(control, IE_UNIMP);
        return Err("unbounded test rejected".into());
    }

    let (sender, receiver) = mpsc::channel();
    *session.incoming.lock().unwrap() = Some(sender);
    session.accepting.store(true, Ordering::SeqCst);
    write_state(control, CREATE_STREAMS).map_err(io)?;
    let deadline = Instant::now() + STREAM_TIMEOUT;
    let mut accepted = Vec::new();
    while accepted.len() < parallel as usize {
        let left = deadline.saturating_duration_since(Instant::now());
        match receiver.recv_timeout(left) {
            Ok(item) => accepted.push(item),
            Err(_) => return Err("data streams did not arrive".into()),
        }
    }
    session.accepting.store(false, Ordering::SeqCst);
    *session.incoming.lock().unwrap() = None;
    // 客户端按顺序建流，按接受顺序编号才能和客户端的流号对上
    accepted.sort_by_key(|(seq, _)| *seq);
    let streams: Vec<DataStream> = accepted
        .into_iter()
        .enumerate()
        .map(|(index, (_, socket))| DataStream::new(socket, index))
        .collect();
    let close_streams = |streams: &[DataStream]| streams.iter().for_each(DataStream::close);

    let result = (|| -> Result<(), String> {
        write_state(control, TEST_START).map_err(io)?;
        write_state(control, TEST_RUNNING).map_err(io)?;
        shared.listener.on_test_started(peer, !reverse, parallel, duration);
        let listener = shared.listener.clone();
        let mut sampler = Sampler::start(counters(&streams), omit, Arc::new(move |i: &Interval| listener.on_interval(i)));
        for stream in &streams {
            stream.start(reverse, block_size, session.stop.clone(), limit);
        }
        // 按字节数限定的测试没有时长，按最长时长兜底，避免对端不收尾时一直占用
        let run_seconds = if duration == 0 { MAX_DURATION } else { duration + omit };
        let budget = Duration::from_secs(run_seconds as u64) + CONTROL_TIMEOUT * 2;
        let running_at = Instant::now();
        loop {
            match read_state(control) {
                Ok(TEST_END) => break,
                Ok(TEST_START) | Ok(TEST_RUNNING) => {}
                Ok(CLIENT_TERMINATE) => return Err("the client has terminated".into()),
                Ok(IPERF_DONE) => return Err("the client has closed the test".into()),
                Ok(other) => return Err(format!("unexpected state {other}")),
                Err(err) if matches!(err.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut) => {
                    if running_at.elapsed() < budget {
                        continue;
                    }
                    return Err("client stopped responding".into());
                }
                Err(err) => return Err(err.to_string()),
            }
        }
        session.stop.store(true, Ordering::SeqCst);
        let seconds = sampler.elapsed();
        close_streams(&streams);
        let own: Vec<StreamReport> = streams
            .iter()
            .map(|s| StreamReport { id: s.id, bytes: s.counted(), seconds })
            .collect();
        write_state(control, EXCHANGE_RESULTS).map_err(io)?;
        let remote = parse_reports(&read_json(control).map_err(io)?);
        write_json(control, &results_json(reverse, &own)).map_err(io)?;
        session.finishing.store(true, Ordering::SeqCst);
        write_state(control, DISPLAY_RESULTS).map_err(io)?;
        let intervals = sampler.finish();
        let _ = control.set_read_timeout(Some(Duration::from_secs(3)));
        let _ = read_state(control);

        let own_bytes: u64 = own.iter().map(|s| s.bytes).sum();
        let remote_bytes: u64 = remote.iter().map(|s| s.bytes).sum();
        let remote_seconds = remote.iter().map(|s| s.seconds).fold(0.0, f64::max);
        let remote_seconds = if remote_seconds > 0.0 { remote_seconds } else { seconds };
        let result = if reverse {
            TestResult { reverse, parallel, sent_bytes: own_bytes, sent_seconds: seconds, received_bytes: remote_bytes, received_seconds: remote_seconds, intervals }
        } else {
            TestResult { reverse, parallel, sent_bytes: remote_bytes, sent_seconds: remote_seconds, received_bytes: own_bytes, received_seconds: seconds, intervals }
        };
        shared.listener.on_test_finished(peer, &result);
        Ok(())
    })();
    session.stop.store(true, Ordering::SeqCst);
    close_streams(&streams);
    result
}
