use serde_json::{json, Map, Value};
use std::{env, fs, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    time,
};

use super::manager::RunningMode;

#[derive(Debug, Clone)]
pub struct ControllerEndpoint {
    pub arg_name: &'static str,
    pub path: String,
}

pub fn service_endpoint() -> ControllerEndpoint {
    if cfg!(target_os = "windows") {
        ControllerEndpoint {
            arg_name: "-ext-ctl-pipe",
            path: r"\\.\pipe\flycast-mihomo-service".to_string(),
        }
    } else {
        ControllerEndpoint {
            arg_name: "-ext-ctl-unix",
            path: "/tmp/flyclash-mihomo-service.sock".to_string(),
        }
    }
}

pub fn sidecar_endpoint() -> ControllerEndpoint {
    if cfg!(target_os = "windows") {
        let session = env::var("SESSIONNAME")
            .or_else(|_| env::var("USERNAME"))
            .unwrap_or_else(|_| "default".to_string());
        ControllerEndpoint {
            arg_name: "-ext-ctl-pipe",
            path: format!(
                r"\\.\pipe\FlyClash\mihomo-{}-{}",
                session,
                std::process::id()
            ),
        }
    } else {
        let uid = env::var("UID").unwrap_or_else(|_| "unknown".to_string());
        let socket_dir = env::temp_dir().join(format!("flyclash-{uid}"));
        let _ = fs::create_dir_all(&socket_dir);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&socket_dir, fs::Permissions::from_mode(0o700));
        }
        ControllerEndpoint {
            arg_name: "-ext-ctl-unix",
            path: socket_dir
                .join(format!("mihomo-{}.sock", std::process::id()))
                .to_string_lossy()
                .to_string(),
        }
    }
}

pub fn endpoint_for_mode(mode: RunningMode) -> Option<ControllerEndpoint> {
    match mode {
        RunningMode::Service => Some(service_endpoint()),
        RunningMode::Sidecar => Some(sidecar_endpoint()),
        RunningMode::NotRunning => None,
    }
}

pub fn cleanup_socket_file(endpoint: &ControllerEndpoint) {
    if cfg!(target_os = "windows") {
        return;
    }
    let _ = fs::remove_file(&endpoint.path);
}

pub async fn request(
    endpoint: &ControllerEndpoint,
    method: &str,
    target: &str,
    headers: &Map<String, Value>,
    body: Option<Vec<u8>>,
    secret: &str,
    timeout: Duration,
) -> Result<Value, String> {
    let target = if target.starts_with('/') {
        target.to_string()
    } else {
        format!("/{target}")
    };

    let mut request = format!(
        "{} {} HTTP/1.1\r\nHost: mihomo\r\nConnection: close\r\nAccept: */*\r\n",
        method.to_ascii_uppercase(),
        target
    );
    if !secret.is_empty() {
        request.push_str(&format!("Authorization: Bearer {secret}\r\n"));
    }

    let mut has_content_type = false;
    for (key, value) in headers {
        if key.eq_ignore_ascii_case("content-length") || key.eq_ignore_ascii_case("host") {
            continue;
        }
        if key.eq_ignore_ascii_case("content-type") {
            has_content_type = true;
        }
        if let Some(value) = value.as_str() {
            request.push_str(&format!("{key}: {value}\r\n"));
        }
    }

    let body = body.unwrap_or_default();
    if !body.is_empty() && !has_content_type {
        request.push_str("Content-Type: application/json\r\n");
    }
    request.push_str(&format!("Content-Length: {}\r\n\r\n", body.len()));

    let mut bytes = request.into_bytes();
    bytes.extend_from_slice(&body);

    let response = send_raw_http(&endpoint.path, bytes, timeout).await?;
    let mut response = parse_http_response(&response)?;
    if let Some(object) = response.as_object_mut() {
        object.insert(
            "controllerMode".to_string(),
            Value::String("socket".to_string()),
        );
        object.insert(
            "socketPath".to_string(),
            Value::String(endpoint.path.clone()),
        );
        object.insert(
            "socketArg".to_string(),
            Value::String(endpoint.arg_name.to_string()),
        );
    }
    Ok(response)
}

#[cfg(target_os = "windows")]
async fn send_raw_http(
    socket_path: &str,
    request: Vec<u8>,
    timeout: Duration,
) -> Result<Vec<u8>, String> {
    use tokio::net::windows::named_pipe::ClientOptions;

    let mut client = ClientOptions::new()
        .open(socket_path)
        .map_err(|err| format!("无法打开 Mihomo 控制管道 {socket_path}: {err}"))?;
    time::timeout(timeout, client.write_all(&request))
        .await
        .map_err(|_| "Mihomo 控制管道写入超时".to_string())?
        .map_err(|err| err.to_string())?;
    let _ = client.shutdown().await;

    let mut response = Vec::new();
    time::timeout(timeout, client.read_to_end(&mut response))
        .await
        .map_err(|_| "Mihomo 控制管道读取超时".to_string())?
        .map_err(|err| err.to_string())?;
    Ok(response)
}

#[cfg(unix)]
async fn send_raw_http(
    socket_path: &str,
    request: Vec<u8>,
    timeout: Duration,
) -> Result<Vec<u8>, String> {
    use tokio::net::UnixStream;

    let mut stream = time::timeout(timeout, UnixStream::connect(socket_path))
        .await
        .map_err(|_| "Mihomo Unix 控制 socket 连接超时".to_string())?
        .map_err(|err| format!("无法连接 Mihomo Unix 控制 socket {socket_path}: {err}"))?;
    time::timeout(timeout, stream.write_all(&request))
        .await
        .map_err(|_| "Mihomo Unix 控制 socket 写入超时".to_string())?
        .map_err(|err| err.to_string())?;
    let _ = stream.shutdown().await;

    let mut response = Vec::new();
    time::timeout(timeout, stream.read_to_end(&mut response))
        .await
        .map_err(|_| "Mihomo Unix 控制 socket 读取超时".to_string())?
        .map_err(|err| err.to_string())?;
    Ok(response)
}

#[cfg(not(any(target_os = "windows", unix)))]
async fn send_raw_http(
    _socket_path: &str,
    _request: Vec<u8>,
    _timeout: Duration,
) -> Result<Vec<u8>, String> {
    Err("当前平台不支持 Mihomo socket controller".to_string())
}

fn parse_http_response(response: &[u8]) -> Result<Value, String> {
    let header_end = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| "Mihomo socket controller 返回了无效 HTTP 响应".to_string())?;
    let header_bytes = &response[..header_end];
    let body_bytes = &response[header_end + 4..];
    let header_text = String::from_utf8_lossy(header_bytes);
    let mut lines = header_text.lines();
    let status_line = lines.next().unwrap_or_default();
    let mut status_parts = status_line.splitn(3, ' ');
    let _http_version = status_parts.next();
    let status = status_parts
        .next()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(0);
    let status_text = status_parts.next().unwrap_or_default().to_string();

    let mut headers = Map::new();
    let mut chunked = false;
    for line in lines {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let key = key.trim().to_string();
        let value = value.trim().to_string();
        if key.eq_ignore_ascii_case("transfer-encoding") && value.eq_ignore_ascii_case("chunked") {
            chunked = true;
        }
        headers.insert(key, Value::String(value));
    }

    let body = if chunked {
        decode_chunked_body(body_bytes).unwrap_or_else(|| body_bytes.to_vec())
    } else {
        body_bytes.to_vec()
    };
    let text = String::from_utf8_lossy(&body).to_string();
    let data =
        serde_json::from_slice::<Value>(&body).unwrap_or_else(|_| Value::String(text.clone()));

    Ok(json!({
        "ok": (200..300).contains(&status),
        "status": status,
        "statusText": status_text,
        "headers": headers,
        "data": data,
        "text": text
    }))
}

fn decode_chunked_body(body: &[u8]) -> Option<Vec<u8>> {
    let mut cursor = 0usize;
    let mut output = Vec::new();
    loop {
        let line_end = body[cursor..]
            .windows(2)
            .position(|window| window == b"\r\n")?
            + cursor;
        let size_text = String::from_utf8_lossy(&body[cursor..line_end]);
        let size =
            usize::from_str_radix(size_text.trim().split(';').next().unwrap_or(""), 16).ok()?;
        cursor = line_end + 2;
        if size == 0 {
            break;
        }
        if cursor + size > body.len() {
            return None;
        }
        output.extend_from_slice(&body[cursor..cursor + size]);
        cursor += size;
        if body.get(cursor..cursor + 2)? != b"\r\n" {
            return None;
        }
        cursor += 2;
    }
    Some(output)
}
