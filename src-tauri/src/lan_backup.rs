use std::{
    env, fs,
    io::{Read, Write},
    net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream, UdpSocket},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, State, WebviewWindow};

use crate::{
    backup::{backup_dir, create_backup_zip, finalize_backup_restore, restore_backup_zip},
    state::AppState,
};

type CompatResult = Result<Value, String>;

const MAGIC: &str = "FLYCLASH_LAN_BACKUP";
const VERSION: u64 = 2;
const DISCOVERY_PORT: u16 = 38457;
const MAX_BACKUP_BYTES: u64 = 512 * 1024 * 1024;
const HEADER_LIMIT: usize = 16 * 1024;

struct ReceiverSession {
    stop: Arc<AtomicBool>,
    status: Arc<Mutex<Value>>,
    received_path: Arc<Mutex<Option<PathBuf>>>,
}

static RECEIVER: OnceLock<Mutex<Option<ReceiverSession>>> = OnceLock::new();

fn receiver_slot() -> &'static Mutex<Option<ReceiverSession>> {
    RECEIVER.get_or_init(|| Mutex::new(None))
}

fn host_name() -> String {
    env::var("COMPUTERNAME")
        .or_else(|_| env::var("HOSTNAME"))
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "Desktop".to_string())
}

fn device_name() -> String {
    format!("FlyClash · {}", host_name())
}

fn device_platform() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "desktop"
    }
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

fn read_line(stream: &mut TcpStream) -> Result<String, String> {
    let mut bytes = Vec::new();
    let mut one = [0u8; 1];
    while bytes.len() < HEADER_LIMIT {
        stream.read_exact(&mut one).map_err(|err| err.to_string())?;
        if one[0] == b'\n' {
            return String::from_utf8(bytes)
                .map(|line| line.trim_end_matches('\r').to_string())
                .map_err(|err| err.to_string());
        }
        bytes.push(one[0]);
    }
    Err("协议头过长".to_string())
}

fn write_line(stream: &mut TcpStream, value: &str) -> Result<(), String> {
    stream
        .write_all(format!("{value}\n").as_bytes())
        .map_err(|err| err.to_string())?;
    stream.flush().map_err(|err| err.to_string())
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn pairing_proof(session_key: &[u8], pairing_code: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(session_key);
    hasher.update(pairing_code.as_bytes());
    hasher.update(b"FlyClashPairingV1");
    format!("{:x}", hasher.finalize())
}

fn encrypt_backup(bytes: &[u8], session_key: &[u8], nonce: &[u8]) -> Result<Vec<u8>, String> {
    if session_key.len() != 32 || nonce.len() != 12 {
        return Err("无效的传输加密参数".to_string());
    }
    let cipher = Aes256Gcm::new_from_slice(session_key).map_err(|err| err.to_string())?;
    cipher
        .encrypt(Nonce::from_slice(nonce), bytes)
        .map_err(|_| "备份加密失败".to_string())
}

fn decrypt_backup(bytes: &[u8], session_key: &[u8], nonce: &[u8]) -> Result<Vec<u8>, String> {
    if session_key.len() != 32 || nonce.len() != 12 {
        return Err("无效的传输加密参数".to_string());
    }
    let cipher = Aes256Gcm::new_from_slice(session_key).map_err(|err| err.to_string())?;
    cipher
        .decrypt(Nonce::from_slice(nonce), bytes)
        .map_err(|_| "接收会话已失效或备份已损坏".to_string())
}

fn set_status(status: &Arc<Mutex<Value>>, value: Value) {
    if let Ok(mut current) = status.lock() {
        *current = value;
    }
}

fn handle_incoming(
    mut stream: TcpStream,
    session_key: &[u8],
    pairing_code: &str,
    stop: &Arc<AtomicBool>,
    status: &Arc<Mutex<Value>>,
    received_path: &Arc<Mutex<Option<PathBuf>>>,
    path: PathBuf,
) -> Result<(), String> {
    // TcpListener runs in nonblocking mode for cooperative shutdown. On Windows,
    // accepted sockets can retain that mode, which races with the sender after
    // READY and produces an empty file plus a Broken pipe on Android.
    stream
        .set_nonblocking(false)
        .map_err(|err| err.to_string())?;
    stream
        .set_read_timeout(Some(Duration::from_secs(60)))
        .map_err(|err| err.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(60)))
        .map_err(|err| err.to_string())?;
    let header: Value = serde_json::from_str(&read_line(&mut stream)?)
        .map_err(|_| "无效的跨设备备份协议头".to_string())?;
    if header.get("magic").and_then(Value::as_str) != Some(MAGIC)
        || header.get("version").and_then(Value::as_u64) != Some(VERSION)
    {
        let _ = write_line(&mut stream, "ERROR 协议版本不兼容");
        return Ok(());
    }
    if header.get("encryption").and_then(Value::as_str) != Some("AES-256-GCM-SESSION") {
        let _ = write_line(&mut stream, "ERROR 不支持的传输加密方式");
        return Ok(());
    }
    let actual_pairing_proof = header
        .get("pairingProof")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if actual_pairing_proof != pairing_proof(session_key, pairing_code) {
        let _ = write_line(&mut stream, "ERROR 配对码错误，请重新输入");
        return Ok(());
    }
    let size = header.get("size").and_then(Value::as_u64).unwrap_or(0);
    if size == 0 || size > MAX_BACKUP_BYTES + 32 {
        let _ = write_line(&mut stream, "ERROR 备份大小无效");
        return Ok(());
    }
    let expected_sha = header
        .get("sha256")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    let nonce = header
        .get("nonce")
        .and_then(Value::as_str)
        .ok_or_else(|| "缺少传输随机数".to_string())
        .and_then(|value| {
            BASE64
                .decode(value)
                .map_err(|_| "传输随机数无效".to_string())
        })?;
    let sender = header
        .get("deviceName")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("FlyClash device")
        .to_string();
    let sender_device_type = header
        .get("deviceType")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();
    let sender_platform = header
        .get("platform")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();

    set_status(
        status,
        json!({ "state": "receiving", "senderName": sender, "senderDeviceType": sender_device_type, "senderPlatform": sender_platform, "progress": 0 }),
    );
    write_line(&mut stream, "READY")?;
    let mut file = fs::File::create(&path).map_err(|err| err.to_string())?;
    let mut hasher = Sha256::new();
    let mut received = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    while received < size {
        let limit =
            usize::try_from((size - received).min(buffer.len() as u64)).unwrap_or(buffer.len());
        let count = stream
            .read(&mut buffer[..limit])
            .map_err(|err| err.to_string())?;
        if count == 0 {
            return Err("连接提前断开".to_string());
        }
        file.write_all(&buffer[..count])
            .map_err(|err| err.to_string())?;
        hasher.update(&buffer[..count]);
        received += count as u64;
        set_status(
            status,
            json!({
                "state": "receiving",
                "senderName": sender,
                "senderDeviceType": sender_device_type,
                "senderPlatform": sender_platform,
                "progress": (received.saturating_mul(100) / size)
            }),
        );
    }
    file.flush().map_err(|err| err.to_string())?;
    let actual_sha = format!("{:x}", hasher.finalize());
    if actual_sha != expected_sha {
        let _ = fs::remove_file(&path);
        let _ = write_line(&mut stream, "ERROR SHA-256 校验失败");
        return Err("SHA-256 校验失败".to_string());
    }
    let encrypted = fs::read(&path).map_err(|err| err.to_string())?;
    let decrypted = match decrypt_backup(&encrypted, session_key, &nonce) {
        Ok(bytes) => bytes,
        Err(error) => {
            let _ = fs::remove_file(&path);
            let _ = write_line(&mut stream, &format!("ERROR {error}"));
            return Ok(());
        }
    };
    fs::write(&path, &decrypted).map_err(|err| err.to_string())?;
    if let Ok(mut received_file) = received_path.lock() {
        *received_file = Some(path);
    }
    set_status(
        status,
        json!({ "state": "received", "senderName": sender, "senderDeviceType": sender_device_type, "senderPlatform": sender_platform, "size": size, "progress": 100 }),
    );
    write_line(&mut stream, "OK")?;
    stop.store(true, Ordering::Relaxed);
    Ok(())
}

fn stop_receiver(delete_received: bool) {
    if let Ok(mut slot) = receiver_slot().lock() {
        if let Some(session) = slot.take() {
            session.stop.store(true, Ordering::Relaxed);
            if delete_received {
                if let Ok(mut path) = session.received_path.lock() {
                    if let Some(path) = path.take() {
                        let _ = fs::remove_file(path);
                    }
                }
            }
        }
    }
}

fn start_receiver(app: &AppHandle) -> CompatResult {
    stop_receiver(true);
    thread::sleep(Duration::from_millis(250));

    let tcp = TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0)).map_err(|err| err.to_string())?;
    tcp.set_nonblocking(true).map_err(|err| err.to_string())?;
    let tcp_port = tcp.local_addr().map_err(|err| err.to_string())?.port();
    let udp = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, DISCOVERY_PORT))
        .map_err(|err| format!("无法启动局域网发现服务: {err}"))?;
    udp.set_read_timeout(Some(Duration::from_millis(250)))
        .map_err(|err| err.to_string())?;
    udp.set_broadcast(true).map_err(|err| err.to_string())?;

    let mut session_key = [0u8; 32];
    getrandom::getrandom(&mut session_key).map_err(|err| err.to_string())?;
    let mut pairing_random = [0u8; 4];
    getrandom::getrandom(&mut pairing_random).map_err(|err| err.to_string())?;
    let pairing_code = format!("{:06}", u32::from_le_bytes(pairing_random) % 1_000_000);
    let encoded_session_key = BASE64.encode(session_key);
    let id = format!("desktop-{}-{}", std::process::id(), now_millis());
    let name = device_name();
    let stop = Arc::new(AtomicBool::new(false));
    let status = Arc::new(Mutex::new(json!({ "state": "waiting", "port": tcp_port })));
    let received_path = Arc::new(Mutex::new(None));
    let path = backup_dir(app)?.join(format!("lan_received_{}.zip", now_millis()));

    let udp_stop = stop.clone();
    let udp_session_key = encoded_session_key.clone();
    let udp_status = status.clone();
    thread::spawn(move || {
        let mut buffer = [0u8; 8192];
        while !udp_stop.load(Ordering::Relaxed) {
            match udp.recv_from(&mut buffer) {
                Ok((count, source)) => {
                    let request =
                        serde_json::from_slice::<Value>(&buffer[..count]).unwrap_or(Value::Null);
                    if request.get("magic").and_then(Value::as_str) != Some(MAGIC)
                        || request.get("version").and_then(Value::as_u64) != Some(VERSION)
                        || request.get("type").and_then(Value::as_str) != Some("discover")
                    {
                        continue;
                    }
                    let response = json!({
                        "magic": MAGIC,
                        "version": VERSION,
                        "type": "offer",
                        "requestId": request.get("requestId").cloned().unwrap_or(Value::Null),
                        "deviceId": id,
                        "deviceName": name,
                        "hostName": host_name(),
                        "deviceType": "desktop",
                        "platform": device_platform(),
                        "port": tcp_port,
                        "sessionKey": udp_session_key
                    });
                    let _ = udp.send_to(response.to_string().as_bytes(), source);
                }
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) => {}
                Err(error) => {
                    set_status(
                        &udp_status,
                        json!({ "state": "error", "error": error.to_string() }),
                    );
                    break;
                }
            }
        }
    });

    let tcp_stop = stop.clone();
    let tcp_status = status.clone();
    let tcp_received_path = received_path.clone();
    let tcp_session_key = session_key;
    let tcp_pairing_code = pairing_code.clone();
    thread::spawn(move || {
        while !tcp_stop.load(Ordering::Relaxed) {
            match tcp.accept() {
                Ok((stream, _)) => {
                    if let Err(error) = handle_incoming(
                        stream,
                        &tcp_session_key,
                        &tcp_pairing_code,
                        &tcp_stop,
                        &tcp_status,
                        &tcp_received_path,
                        path.clone(),
                    ) {
                        set_status(&tcp_status, json!({ "state": "error", "error": error }));
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(100));
                }
                Err(error) => {
                    set_status(
                        &tcp_status,
                        json!({ "state": "error", "error": error.to_string() }),
                    );
                    break;
                }
            }
        }
    });

    *receiver_slot()
        .lock()
        .map_err(|_| "接收状态锁异常".to_string())? = Some(ReceiverSession {
        stop,
        status,
        received_path,
    });
    Ok(json!({
        "success": true,
        "port": tcp_port,
        "deviceName": device_name(),
        "hostName": host_name(),
        "deviceType": "desktop",
        "platform": device_platform(),
        "pairingCode": pairing_code
    }))
}

fn discovery_targets() -> Vec<SocketAddr> {
    let mut targets = vec![SocketAddr::from(([255, 255, 255, 255], DISCOVERY_PORT))];
    if let Ok(probe) = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)) {
        if probe.connect(("8.8.8.8", 53)).is_ok() {
            if let Ok(SocketAddr::V4(local)) = probe.local_addr() {
                let octets = local.ip().octets();
                targets.push(SocketAddr::from((
                    [octets[0], octets[1], octets[2], 255],
                    DISCOVERY_PORT,
                )));
            }
        }
    }
    targets.sort_unstable();
    targets.dedup();
    targets
}

fn discover_devices() -> CompatResult {
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
        "requestId": request_id
    })
    .to_string();
    for target in discovery_targets() {
        let _ = socket.send_to(request.as_bytes(), target);
    }
    let deadline = Instant::now() + Duration::from_millis(2500);
    let mut devices = std::collections::BTreeMap::<String, Value>::new();
    let mut buffer = [0u8; 8192];
    while Instant::now() < deadline {
        match socket.recv_from(&mut buffer) {
            Ok((count, source)) => {
                let offer =
                    serde_json::from_slice::<Value>(&buffer[..count]).unwrap_or(Value::Null);
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
                let session_key = offer
                    .get("sessionKey")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty());
                if session_key.is_none() {
                    continue;
                }
                let id = offer
                    .get("deviceId")
                    .and_then(Value::as_str)
                    .map(ToString::to_string)
                    .unwrap_or_else(|| format!("{}:{port}", source.ip()));
                devices.insert(
                    id.clone(),
                    json!({
                        "id": id,
                        "name": offer.get("deviceName").and_then(Value::as_str).unwrap_or("FlyClash device"),
                        "hostName": offer.get("hostName").and_then(Value::as_str),
                        "deviceType": offer.get("deviceType").and_then(Value::as_str).unwrap_or("unknown"),
                        "platform": offer.get("platform").and_then(Value::as_str).unwrap_or("unknown"),
                        "address": source.ip().to_string(),
                        "port": port,
                        "sessionKey": session_key
                    }),
                );
            }
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(json!({ "success": true, "devices": devices.into_values().collect::<Vec<_>>() }))
}

fn send_backup(app: &AppHandle, window: &WebviewWindow, args: &[Value]) -> CompatResult {
    let device = args.first().ok_or_else(|| "缺少接收设备".to_string())?;
    let address = device
        .get("address")
        .and_then(Value::as_str)
        .ok_or_else(|| "接收设备地址无效".to_string())?;
    let port = device
        .get("port")
        .and_then(Value::as_u64)
        .filter(|port| (1..=65535).contains(port))
        .ok_or_else(|| "接收设备端口无效".to_string())? as u16;
    let session_key = device
        .get("sessionKey")
        .and_then(Value::as_str)
        .ok_or_else(|| "接收设备会话已失效，请重新搜索".to_string())
        .and_then(|value| {
            BASE64
                .decode(value)
                .map_err(|_| "接收设备会话已失效，请重新搜索".to_string())
        })?;
    if session_key.len() != 32 {
        return Err("接收设备会话已失效，请重新搜索".to_string());
    }
    let pairing_code = args
        .get(2)
        .and_then(Value::as_str)
        .filter(|value| value.len() == 6 && value.bytes().all(|byte| byte.is_ascii_digit()))
        .ok_or_else(|| "请输入 6 位配对码".to_string())?;
    let backup_type = args.get(1).and_then(Value::as_str).unwrap_or("CONFIG_ONLY");
    let created = create_backup_zip(app, backup_type)?;
    let path = PathBuf::from(
        created
            .get("filePath")
            .and_then(Value::as_str)
            .ok_or_else(|| "备份创建失败".to_string())?,
    );
    let result = (|| -> CompatResult {
        let bytes = fs::read(&path).map_err(|err| err.to_string())?;
        if bytes.is_empty() || bytes.len() as u64 > MAX_BACKUP_BYTES {
            return Err("备份大小无效或超过 512 MiB 限制".to_string());
        }
        let mut nonce = [0u8; 12];
        getrandom::getrandom(&mut nonce).map_err(|err| err.to_string())?;
        let encrypted = encrypt_backup(&bytes, &session_key, &nonce)?;
        let mut stream = TcpStream::connect_timeout(
            &format!("{address}:{port}")
                .parse()
                .map_err(|_| "接收设备地址无效".to_string())?,
            Duration::from_secs(8),
        )
        .map_err(|err| err.to_string())?;
        stream
            .set_read_timeout(Some(Duration::from_secs(60)))
            .map_err(|err| err.to_string())?;
        let header = json!({
            "magic": MAGIC,
            "version": VERSION,
            "deviceName": device_name(),
            "hostName": host_name(),
            "deviceType": "desktop",
            "platform": device_platform(),
            "encryption": "AES-256-GCM-SESSION",
            "pairingProof": pairing_proof(&session_key, pairing_code),
            "nonce": BASE64.encode(nonce),
            "size": encrypted.len(),
            "sha256": sha256_hex(&encrypted)
        });
        write_line(&mut stream, &header.to_string())?;
        let ready = read_line(&mut stream)?;
        if ready != "READY" {
            return Err(ready
                .strip_prefix("ERROR ")
                .unwrap_or("接收端拒绝了传输")
                .to_string());
        }
        let total = encrypted.len() as u64;
        let mut sent = 0usize;
        for chunk in encrypted.chunks(64 * 1024) {
            stream.write_all(chunk).map_err(|err| err.to_string())?;
            sent += chunk.len();
            let _ = window.emit(
                "backup-lan-progress",
                json!({ "sent": sent, "total": total, "percentage": sent as u64 * 100 / total }),
            );
        }
        stream.flush().map_err(|err| err.to_string())?;
        let response = read_line(&mut stream)?;
        if response != "OK" {
            return Err(response
                .strip_prefix("ERROR ")
                .unwrap_or("接收端校验失败")
                .to_string());
        }
        Ok(json!({ "success": true, "sent": total }))
    })();
    let _ = fs::remove_file(path);
    result
}

async fn restore_received(app: &AppHandle, state: &State<'_, AppState>) -> CompatResult {
    let path = {
        let slot = receiver_slot()
            .lock()
            .map_err(|_| "接收状态锁异常".to_string())?;
        let session = slot
            .as_ref()
            .ok_or_else(|| "当前没有待导入的备份".to_string())?;
        let path = session
            .received_path
            .lock()
            .map_err(|_| "接收文件锁异常".to_string())?
            .clone()
            .ok_or_else(|| "当前没有待导入的备份".to_string())?;
        path
    };
    let result = restore_backup_zip(app, &path)?;
    let finalized = finalize_backup_restore(app, state, result).await;
    let _ = fs::remove_file(path);
    stop_receiver(false);
    finalized
}

async fn dispatch(
    app: &AppHandle,
    window: &WebviewWindow,
    state: &State<'_, AppState>,
    method: &str,
    args: &[Value],
) -> CompatResult {
    match method {
        "backupLanDiscover" => tauri::async_runtime::spawn_blocking(discover_devices)
            .await
            .map_err(|err| err.to_string())?,
        "backupLanStartReceiver" => start_receiver(app),
        "backupLanStatus" => {
            let slot = receiver_slot()
                .lock()
                .map_err(|_| "接收状态锁异常".to_string())?;
            if let Some(session) = slot.as_ref() {
                let status = session
                    .status
                    .lock()
                    .map_err(|_| "接收状态锁异常".to_string())?
                    .clone();
                Ok(json!({ "success": true, "status": status }))
            } else {
                Ok(json!({ "success": true, "status": { "state": "idle" } }))
            }
        }
        "backupLanStopReceiver" => {
            stop_receiver(true);
            Ok(json!({ "success": true }))
        }
        "backupLanSend" => {
            let app = app.clone();
            let window = window.clone();
            let args = args.to_vec();
            tauri::async_runtime::spawn_blocking(move || send_backup(&app, &window, &args))
                .await
                .map_err(|err| err.to_string())?
        }
        "backupLanRestoreReceived" => restore_received(app, state).await,
        _ => Err(format!("Unsupported LAN backup method: {method}")),
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
        "backupLanDiscover"
            | "backupLanStartReceiver"
            | "backupLanStatus"
            | "backupLanStopReceiver"
            | "backupLanSend"
            | "backupLanRestoreReceived"
    ) {
        return None;
    }
    Some(dispatch(app, window, state, method, args).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encryption_matches_cross_platform_vector() {
        let session_key = (0u8..32).collect::<Vec<_>>();
        let nonce = (0u8..12).collect::<Vec<_>>();
        let plaintext = b"FlyClash LAN backup protocol";
        let encrypted = encrypt_backup(plaintext, &session_key, &nonce).unwrap();
        assert_eq!(
            encrypted.iter().map(|byte| format!("{byte:02x}")).collect::<String>(),
            "016eaf58a984b173ad0dd6c5918b190ee8a3f7148009300857048ae95cbb1933e907e34d4d0732110f8c8abb"
        );
        assert_eq!(
            decrypt_backup(&encrypted, &session_key, &nonce).unwrap(),
            plaintext
        );
    }

    #[test]
    fn pairing_proof_matches_cross_platform_vector() {
        let session_key = (0u8..32).collect::<Vec<_>>();
        assert_eq!(
            pairing_proof(&session_key, "123456"),
            "99f9913da40c4fd2feac3b0d75846690ff70fdbfc8699503468823d7789393f6"
        );
    }

    #[test]
    fn receiver_accepts_payload_from_nonblocking_listener() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let session_key = (0u8..32).collect::<Vec<_>>();
        let nonce = (0u8..12).collect::<Vec<_>>();
        let plaintext = b"FlyClash Android to desktop backup".to_vec();
        let encrypted = encrypt_backup(&plaintext, &session_key, &nonce).unwrap();
        let header = json!({
            "magic": MAGIC,
            "version": VERSION,
            "deviceName": "FlyClash · Android",
            "encryption": "AES-256-GCM-SESSION",
            "pairingProof": pairing_proof(&session_key, "123456"),
            "nonce": BASE64.encode(&nonce),
            "size": encrypted.len(),
            "sha256": sha256_hex(&encrypted)
        });

        let sender = thread::spawn(move || {
            let mut stream = TcpStream::connect(address).unwrap();
            write_line(&mut stream, &header.to_string()).unwrap();
            assert_eq!(read_line(&mut stream).unwrap(), "READY");
            stream.write_all(&encrypted).unwrap();
            stream.flush().unwrap();
            assert_eq!(read_line(&mut stream).unwrap(), "OK");
        });

        let stream = loop {
            match listener.accept() {
                Ok((stream, _)) => break stream,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(5));
                }
                Err(error) => panic!("accept failed: {error}"),
            }
        };
        let path = env::temp_dir().join(format!("flyclash_lan_test_{}.zip", now_millis()));
        let stop = Arc::new(AtomicBool::new(false));
        let status = Arc::new(Mutex::new(json!({ "state": "waiting" })));
        let received_path = Arc::new(Mutex::new(None));
        handle_incoming(
            stream,
            &session_key,
            "123456",
            &stop,
            &status,
            &received_path,
            path.clone(),
        )
        .unwrap();
        sender.join().unwrap();
        assert_eq!(fs::read(&path).unwrap(), plaintext);
        let _ = fs::remove_file(path);
    }
}
