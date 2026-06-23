use serde_json::Value;
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    time::{timeout, Duration},
};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_RESPONSE_BYTES: usize = 10 * 1024 * 1024;

pub(crate) async fn request_json(
    socket_path: &str,
    method: &str,
    path: &str,
    body: &Value,
) -> Result<(u16, String), String> {
    #[cfg(unix)]
    {
        let stream = tokio::net::UnixStream::connect(socket_path)
            .await
            .map_err(|err| format!("failed to connect unix socket {socket_path}: {err}"))?;
        send_http_request(stream, method, path, body).await
    }

    #[cfg(windows)]
    {
        let stream = connect_named_pipe(socket_path).await?;
        send_http_request(stream, method, path, body).await
    }
}

#[cfg(windows)]
async fn connect_named_pipe(
    socket_path: &str,
) -> Result<tokio::net::windows::named_pipe::NamedPipeClient, String> {
    const ERROR_PIPE_BUSY: i32 = 231;
    let mut retries = 3;

    loop {
        match tokio::net::windows::named_pipe::ClientOptions::new().open(socket_path) {
            Ok(client) => return Ok(client),
            Err(err) if err.raw_os_error() == Some(ERROR_PIPE_BUSY) && retries > 0 => {
                retries -= 1;
                tokio::time::sleep(Duration::from_millis(125)).await;
            }
            Err(err) if retries > 0 => {
                retries -= 1;
                tokio::time::sleep(Duration::from_millis(125)).await;
                if retries == 0 {
                    return Err(format!("failed to connect named pipe {socket_path}: {err}"));
                }
            }
            Err(err) => return Err(format!("failed to connect named pipe {socket_path}: {err}")),
        }
    }
}

async fn send_http_request<S>(
    mut stream: S,
    method: &str,
    path: &str,
    body: &Value,
) -> Result<(u16, String), String>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let body_text = if body.is_null() {
        String::new()
    } else {
        serde_json::to_string(body).map_err(|err| err.to_string())?
    };
    let body_bytes = body_text.as_bytes();
    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: localhost\r\nAccept: application/json\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body_bytes.len(),
    );

    timeout(REQUEST_TIMEOUT, async {
        stream
            .write_all(request.as_bytes())
            .await
            .map_err(|err| err.to_string())?;
        if !body_bytes.is_empty() {
            stream
                .write_all(body_bytes)
                .await
                .map_err(|err| err.to_string())?;
        }
        stream.flush().await.map_err(|err| err.to_string())
    })
    .await
    .map_err(|_| "local socket request write timed out".to_string())??;

    read_http_response(&mut stream).await
}

async fn read_http_response<S>(stream: &mut S) -> Result<(u16, String), String>
where
    S: AsyncRead + Unpin,
{
    let mut buffer = Vec::new();
    let mut header_end = None;
    let mut content_length = None;
    let mut status = None;

    loop {
        let mut chunk = [0_u8; 4096];
        let read = timeout(REQUEST_TIMEOUT, stream.read(&mut chunk))
            .await
            .map_err(|_| "local socket response read timed out".to_string())?
            .map_err(|err| err.to_string())?;
        if read == 0 {
            break;
        }

        buffer.extend_from_slice(&chunk[..read]);
        if buffer.len() > MAX_RESPONSE_BYTES {
            return Err("local socket response is too large".to_string());
        }

        if header_end.is_none() {
            if let Some(end) = find_header_end(&buffer) {
                let header_text = String::from_utf8_lossy(&buffer[..end]).to_string();
                status = parse_status(&header_text);
                content_length = parse_content_length(&header_text);
                header_end = Some(end + 4);
            }
        }

        if let Some(end) = header_end {
            if let Some(length) = content_length {
                if buffer.len().saturating_sub(end) >= length {
                    break;
                }
            } else if matches!(status, Some(204 | 304)) {
                break;
            }
        }
    }

    let end = header_end.ok_or_else(|| "invalid local socket HTTP response".to_string())?;
    let status = status.ok_or_else(|| "missing local socket HTTP status".to_string())?;
    let mut body = buffer[end..].to_vec();
    if let Some(length) = content_length {
        body.truncate(length);
    }

    Ok((status, String::from_utf8_lossy(&body).to_string()))
}

fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|window| window == b"\r\n\r\n")
}

fn parse_status(headers: &str) -> Option<u16> {
    headers
        .lines()
        .next()?
        .split_whitespace()
        .nth(1)?
        .parse::<u16>()
        .ok()
}

fn parse_content_length(headers: &str) -> Option<usize> {
    headers.lines().skip(1).find_map(|line| {
        let (key, value) = line.split_once(':')?;
        key.eq_ignore_ascii_case("content-length")
            .then(|| value.trim().parse::<usize>().ok())
            .flatten()
    })
}
