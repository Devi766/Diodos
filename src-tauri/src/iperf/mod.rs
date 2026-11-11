//! iperf3 测速工具：本机既是 iperf3 服务端也是客户端，局域网内的 Diodos 用
//! UDP 38458 广播互相发现，报文和安卓版共用一套字段。

mod engine;

use std::{
    net::{Ipv4Addr, SocketAddr, UdpSocket},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, MutexGuard, OnceLock,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde_json::{json, Value};

use crate::lan_backup::{device_name, device_platform, host_name};

type CompatResult = Result<Value, String>;

const MAGIC: &str = "DIODOS_LAN_IPERF";
const VERSION: u64 = 1;
const DISCOVERY_PORT: u16 = 38458;
const MAX_INTERVALS: usize = 3600;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .unwrap_or_default()
}

fn device_id() -> &'static str {
    static ID: OnceLock<String> = OnceLock::new();
    ID.get_or_init(|| {
        let mut raw = [0u8; 16];
        let _ = getrandom::getrandom(&mut raw);
        raw.iter().map(|byte| format!("{byte:02x}")).collect()
    })
}

// ---------------------------------------------------------------- 状态

struct ServerSlot {
    server: engine::Server,
    responder_stop: Arc<AtomicBool>,
}

fn server_slot() -> &'static Mutex<Option<ServerSlot>> {
    static SLOT: OnceLock<Mutex<Option<ServerSlot>>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(None))
}

/// 最近一次对端测本机的情况
fn peer_status() -> &'static Arc<Mutex<Value>> {
    static STATUS: OnceLock<Arc<Mutex<Value>>> = OnceLock::new();
    STATUS.get_or_init(|| Arc::new(Mutex::new(json!({ "state": "idle" }))))
}

struct ClientSlot {
    generation: u64,
    cancel: Option<engine::CancelHandle>,
    status: Arc<Mutex<Value>>,
}

fn client_slot() -> &'static Mutex<ClientSlot> {
    static SLOT: OnceLock<Mutex<ClientSlot>> = OnceLock::new();
    SLOT.get_or_init(|| {
        Mutex::new(ClientSlot {
            generation: 0,
            cancel: None,
            status: Arc::new(Mutex::new(json!({ "state": "idle" }))),
        })
    })
}

fn push_interval(status: &Mutex<Value>, interval: &engine::Interval) {
    let mut status = lock(status);
    if !status["intervals"].is_array() {
        status["intervals"] = json!([]);
    }
    if let Some(list) = status["intervals"].as_array_mut() {
        list.push(interval.to_json());
        if list.len() > MAX_INTERVALS {
            list.remove(0);
        }
    }
    status["updatedAt"] = json!(now_millis());
}

struct PeerEvents;

impl engine::ServerListener for PeerEvents {
    fn on_test_started(&self, peer: &str, peer_sends: bool, parallel: u32, duration: u32) {
        *lock(peer_status()) = json!({
            "state": "running",
            "peer": peer,
            "peerSends": peer_sends,
            "parallel": parallel,
            "duration": duration,
            "intervals": [],
            "startedAt": now_millis(),
            "updatedAt": now_millis()
        });
    }

    fn on_interval(&self, interval: &engine::Interval) {
        push_interval(peer_status(), interval);
    }

    fn on_test_finished(&self, peer: &str, result: &engine::TestResult) {
        let mut status = lock(peer_status());
        status["state"] = json!("done");
        status["peer"] = json!(peer);
        status["result"] = result.to_json();
        status["intervals"] = result.to_json()["intervals"].clone();
        status["updatedAt"] = json!(now_millis());
    }

    fn on_test_failed(&self, peer: &str, message: &str) {
        let mut status = lock(peer_status());
        status["state"] = json!("error");
        status["peer"] = json!(peer);
        status["error"] = json!(message);
        status["updatedAt"] = json!(now_millis());
    }
}

// ---------------------------------------------------------------- 服务端

fn primary_ipv4() -> Option<Ipv4Addr> {
    let probe = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok()?;
    probe.connect(("8.8.8.8", 53)).ok()?;
    match probe.local_addr().ok()? {
        SocketAddr::V4(local) if !local.ip().is_unspecified() => Some(*local.ip()),
        _ => None,
    }
}

fn local_addresses() -> Vec<String> {
    primary_ipv4().map(|ip| vec![ip.to_string()]).unwrap_or_default()
}

fn server_info(slot: &Option<ServerSlot>) -> Value {
    match slot {
        Some(slot) => json!({
            "running": true,
            "port": slot.server.port(),
            "busy": slot.server.is_busy(),
            "addresses": local_addresses()
        }),
        None => json!({ "running": false }),
    }
}

fn start_server(args: &[Value]) -> CompatResult {
    let mut slot = lock(server_slot());
    if slot.is_none() {
        let preferred = args
            .first()
            .and_then(|value| value.get("port"))
            .and_then(Value::as_u64)
            .filter(|port| (1..=65535).contains(port))
            .unwrap_or(engine::DEFAULT_PORT as u64) as u16;
        let server = engine::Server::start(preferred, true, Arc::new(PeerEvents))?;
        let responder_stop = Arc::new(AtomicBool::new(false));
        start_responder(responder_stop.clone());
        *slot = Some(ServerSlot { server, responder_stop });
    }
    Ok(json!({ "success": true, "server": server_info(&slot) }))
}

fn stop_server() {
    if let Some(slot) = lock(server_slot()).take() {
        slot.responder_stop.store(true, Ordering::SeqCst);
        slot.server.stop();
    }
}

/// 应答其他设备的发现请求，服务端关闭时一起退出。
fn start_responder(stop: Arc<AtomicBool>) {
    thread::spawn(move || {
        let socket = match bind_discovery_socket() {
            Some(socket) => socket,
            None => return,
        };
        let mut buffer = [0u8; 4096];
        while !stop.load(Ordering::SeqCst) {
            let Ok((count, source)) = socket.recv_from(&mut buffer) else { continue };
            // 应答里带设备名和主机名，只回给局域网内的地址
            if !is_local_peer(source) {
                continue;
            }
            let request = serde_json::from_slice::<Value>(&buffer[..count]).unwrap_or(Value::Null);
            if request.get("magic").and_then(Value::as_str) != Some(MAGIC)
                || request.get("version").and_then(Value::as_u64) != Some(VERSION)
                || request.get("type").and_then(Value::as_str) != Some("discover")
                || request.get("deviceId").and_then(Value::as_str) == Some(device_id())
            {
                continue;
            }
            let (port, busy) = {
                let slot = lock(server_slot());
                match slot.as_ref() {
                    Some(slot) => (slot.server.port(), slot.server.is_busy()),
                    None => continue,
                }
            };
            let offer = json!({
                "magic": MAGIC,
                "version": VERSION,
                "type": "offer",
                "requestId": request.get("requestId").cloned().unwrap_or(Value::Null),
                "deviceId": device_id(),
                "deviceName": device_name(),
                "hostName": host_name(),
                "deviceType": "desktop",
                "platform": device_platform(),
                "port": port,
                "busy": busy
            })
            .to_string();
            let _ = socket.send_to(offer.as_bytes(), source);
        }
    });
}

fn is_local_peer(source: SocketAddr) -> bool {
    match source {
        SocketAddr::V4(addr) => {
            let ip = addr.ip();
            ip.is_private() || ip.is_link_local() || ip.is_loopback()
        }
        SocketAddr::V6(addr) => {
            let ip = addr.ip();
            let segment = ip.segments()[0];
            ip.is_loopback() || (segment & 0xffc0) == 0xfe80 || (segment & 0xfe00) == 0xfc00
        }
    }
}

fn bind_discovery_socket() -> Option<UdpSocket> {
    // 上一个应答线程可能还没退出，稍等再绑
    for _ in 0..10 {
        if let Ok(socket) = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, DISCOVERY_PORT)) {
            let _ = socket.set_broadcast(true);
            let _ = socket.set_read_timeout(Some(Duration::from_millis(500)));
            return Some(socket);
        }
        thread::sleep(Duration::from_millis(200));
    }
    None
}

// ---------------------------------------------------------------- 发现

fn discovery_targets() -> Vec<SocketAddr> {
    let mut targets = vec![SocketAddr::from(([255, 255, 255, 255], DISCOVERY_PORT))];
    if let Some(ip) = primary_ipv4() {
        let octets = ip.octets();
        targets.push(SocketAddr::from(([octets[0], octets[1], octets[2], 255], DISCOVERY_PORT)));
    }
    targets.sort_unstable();
    targets.dedup();
    targets
}

fn discover() -> CompatResult {
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).map_err(|err| err.to_string())?;
    socket.set_broadcast(true).map_err(|err| err.to_string())?;
    socket
        .set_read_timeout(Some(Duration::from_millis(250)))
        .map_err(|err| err.to_string())?;
    let request_id = format!("{}-{}", std::process::id(), now_millis());
    let request = json!({
        "magic": MAGIC,
        "version": VERSION,
        "type": "discover",
        "requestId": request_id,
        "deviceId": device_id()
    })
    .to_string();
    let targets = discovery_targets();
    let mut devices = std::collections::BTreeMap::<String, Value>::new();
    let mut buffer = [0u8; 4096];
    // 丢包时补发一次
    for _ in 0..2 {
        for target in &targets {
            let _ = socket.send_to(request.as_bytes(), target);
        }
        let deadline = Instant::now() + Duration::from_millis(750);
        while Instant::now() < deadline {
            let Ok((count, source)) = socket.recv_from(&mut buffer) else { continue };
            let offer = serde_json::from_slice::<Value>(&buffer[..count]).unwrap_or(Value::Null);
            if offer.get("magic").and_then(Value::as_str) != Some(MAGIC)
                || offer.get("version").and_then(Value::as_u64) != Some(VERSION)
                || offer.get("type").and_then(Value::as_str) != Some("offer")
                || offer.get("requestId").and_then(Value::as_str) != Some(&request_id)
            {
                continue;
            }
            let port = offer.get("port").and_then(Value::as_u64).unwrap_or(0);
            if !(1..=65535).contains(&port) {
                continue;
            }
            let id = offer
                .get("deviceId")
                .and_then(Value::as_str)
                .map(ToString::to_string)
                .unwrap_or_else(|| format!("{}:{port}", source.ip()));
            if id == device_id() {
                continue;
            }
            devices.insert(
                id.clone(),
                json!({
                    "id": id,
                    "name": offer.get("deviceName").and_then(Value::as_str).unwrap_or("Diodos device"),
                    "hostName": offer.get("hostName").and_then(Value::as_str),
                    "deviceType": offer.get("deviceType").and_then(Value::as_str).unwrap_or("unknown"),
                    "platform": offer.get("platform").and_then(Value::as_str).unwrap_or("unknown"),
                    "address": source.ip().to_string(),
                    "port": port,
                    "busy": offer.get("busy").and_then(Value::as_bool).unwrap_or(false)
                }),
            );
        }
    }
    Ok(json!({ "success": true, "devices": devices.into_values().collect::<Vec<_>>() }))
}

// ---------------------------------------------------------------- 客户端

fn start_test(args: &[Value]) -> CompatResult {
    let request = args.first().cloned().unwrap_or(Value::Null);
    let host = request
        .get("host")
        .and_then(Value::as_str)
        .map(|value| value.trim().trim_start_matches('[').trim_end_matches(']').to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "invalid_target".to_string())?;
    let port = request
        .get("port")
        .and_then(Value::as_u64)
        .filter(|port| (1..=65535).contains(port))
        .unwrap_or(engine::DEFAULT_PORT as u64) as u16;
    let number = |key: &str, default: u64| request.get(key).and_then(Value::as_u64).unwrap_or(default);
    let options = engine::Options {
        duration: number("duration", 10).clamp(1, 3600) as u32,
        parallel: number("parallel", 1).clamp(1, 128) as u32,
        reverse: request.get("reverse").and_then(Value::as_bool).unwrap_or(false),
        ..engine::Options::default()
    };
    let label = request
        .get("label")
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .unwrap_or_else(|| host.clone());

    let (generation, cancel, status) = {
        let mut slot = lock(client_slot());
        if let Some(previous) = slot.cancel.take() {
            previous.cancel();
        }
        slot.generation += 1;
        let cancel = engine::CancelHandle::default();
        let status = Arc::new(Mutex::new(json!({
            "state": "connecting",
            "host": host,
            "port": port,
            "label": label,
            "duration": options.duration,
            "parallel": options.parallel,
            "reverse": options.reverse,
            "intervals": [],
            "startedAt": now_millis(),
            "updatedAt": now_millis()
        })));
        slot.cancel = Some(cancel.clone());
        slot.status = status.clone();
        (slot.generation, cancel, status)
    };

    thread::spawn(move || {
        let interval_status = status.clone();
        let running_status = status.clone();
        let outcome = engine::run_client(
            &host,
            port,
            &options,
            &cancel,
            move || {
                let mut status = lock(&running_status);
                status["state"] = json!("running");
                status["updatedAt"] = json!(now_millis());
            },
            Arc::new(move |interval: &engine::Interval| push_interval(&interval_status, interval)),
        );
        let mut current = lock(&status);
        match outcome {
            Ok(result) => {
                current["state"] = json!("done");
                current["result"] = result.to_json();
                current["intervals"] = result.to_json()["intervals"].clone();
            }
            Err(error) if error == "cancelled" => current["state"] = json!("cancelled"),
            Err(error) => {
                current["state"] = json!("error");
                current["error"] = json!(error);
            }
        }
        current["updatedAt"] = json!(now_millis());
        drop(current);
        let mut slot = lock(client_slot());
        if slot.generation == generation {
            slot.cancel = None;
        }
    });
    Ok(json!({ "success": true }))
}

fn cancel_test() {
    if let Some(cancel) = lock(client_slot()).cancel.take() {
        cancel.cancel();
    }
}

fn status() -> Value {
    let client = lock(&lock(client_slot()).status).clone();
    let peer = lock(peer_status()).clone();
    let server = server_info(&lock(server_slot()));
    json!({ "success": true, "server": server, "peer": peer, "client": client })
}

pub(crate) async fn handle_compat_call(method: &str, args: &[Value]) -> Option<CompatResult> {
    let args = args.to_vec();
    let result = match method {
        "iperfServerStart" => start_server(&args),
        "iperfServerStop" => {
            stop_server();
            Ok(json!({ "success": true }))
        }
        "iperfStatus" => Ok(status()),
        "iperfDiscover" => tauri::async_runtime::spawn_blocking(discover)
            .await
            .map_err(|err| err.to_string())
            .and_then(|result| result),
        "iperfStart" => start_test(&args),
        "iperfCancel" => {
            cancel_test();
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
    fn discovery_only_answers_local_peers() {
        for local in ["192.168.1.8:1", "10.0.0.2:1", "172.16.5.1:1", "169.254.3.3:1", "127.0.0.1:1", "[fe80::1]:1", "[fd00::2]:1"] {
            assert!(is_local_peer(local.parse().unwrap()), "{local}");
        }
        for remote in ["8.8.8.8:1", "100.64.0.1:1", "[2001:db8::1]:1"] {
            assert!(!is_local_peer(remote.parse().unwrap()), "{remote}");
        }
    }
}
