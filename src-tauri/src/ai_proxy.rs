use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

use crate::{fetch::FetchOptions, mihomo_transport, state::AppState};

type CompatResult = Result<Value, String>;

fn arg_string(args: &[Value], index: usize) -> Option<String> {
    args.get(index)
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

fn send_stream_ready(sender: &mut Option<tokio::sync::oneshot::Sender<Value>>, value: Value) {
    if let Some(sender) = sender.take() {
        let _ = sender.send(value);
    }
}

fn register_stream(app: &AppHandle, request_id: &str, abort_tx: tokio::sync::oneshot::Sender<()>) {
    let previous = {
        let state = app.state::<AppState>();
        let mut runtime = state.runtime.lock().expect("runtime mutex poisoned");
        runtime.ai_streams.insert(request_id.to_string(), abort_tx)
    };

    if let Some(previous) = previous {
        let _ = previous.send(());
    }
}

fn unregister_stream(app: &AppHandle, request_id: &str) {
    let state = app.state::<AppState>();
    let mut runtime = state.runtime.lock().expect("runtime mutex poisoned");
    runtime.ai_streams.remove(request_id);
}

fn abort_stream(app: &AppHandle, request_id: &str) -> bool {
    let sender = {
        let state = app.state::<AppState>();
        let mut runtime = state.runtime.lock().expect("runtime mutex poisoned");
        runtime.ai_streams.remove(request_id)
    };

    if let Some(sender) = sender {
        let _ = sender.send(());
        true
    } else {
        false
    }
}

async fn run_stream(
    app: AppHandle,
    window: WebviewWindow,
    options: FetchOptions,
    request_id: String,
    mut ready_tx: Option<tokio::sync::oneshot::Sender<Value>>,
    mut abort_rx: tokio::sync::oneshot::Receiver<()>,
) {
    let endpoint = options.url.clone().unwrap_or_default();
    if endpoint.is_empty() {
        send_stream_ready(
            &mut ready_tx,
            json!({ "ok": false, "status": 0, "errorBody": "missing request url" }),
        );
        unregister_stream(&app, &request_id);
        return;
    }

    if !endpoint.starts_with("http://") && !endpoint.starts_with("https://") {
        send_stream_ready(
            &mut ready_tx,
            json!({
                "ok": false,
                "status": 400,
                "errorBody": "Mihomo controller HTTP fallback has been disabled; use IPC endpoints only"
            }),
        );
        unregister_stream(&app, &request_id);
        return;
    }

    let timeout_ms = options.timeout.unwrap_or(60_000).max(1);
    let client = match reqwest::Client::builder()
        .connect_timeout(Duration::from_millis(timeout_ms))
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            send_stream_ready(
                &mut ready_tx,
                json!({ "ok": false, "status": 0, "errorBody": error.to_string() }),
            );
            unregister_stream(&app, &request_id);
            return;
        }
    };

    let method = match options.method.parse::<reqwest::Method>() {
        Ok(method) => method,
        Err(error) => {
            send_stream_ready(
                &mut ready_tx,
                json!({ "ok": false, "status": 0, "errorBody": error.to_string() }),
            );
            unregister_stream(&app, &request_id);
            return;
        }
    };

    let mut request = client.request(method, &endpoint);
    for (key, value) in options.headers {
        if let Some(value) = value.as_str() {
            request = request.header(key, value);
        }
    }

    if let Some(body) = options.body {
        request = match body {
            Value::String(text) => request.body(text),
            other => request.json(&other),
        };
    }

    let send_future = request.send();
    let response = tokio::select! {
        _ = &mut abort_rx => {
            send_stream_ready(
                &mut ready_tx,
                json!({ "ok": false, "status": 0, "errorBody": "aborted" }),
            );
            unregister_stream(&app, &request_id);
            return;
        }
        result = tokio::time::timeout(Duration::from_millis(timeout_ms), send_future) => {
            match result {
                Ok(Ok(response)) => response,
                Ok(Err(error)) => {
                    send_stream_ready(
                        &mut ready_tx,
                        json!({ "ok": false, "status": 0, "errorBody": error.to_string() }),
                    );
                    unregister_stream(&app, &request_id);
                    return;
                }
                Err(_) => {
                    send_stream_ready(
                        &mut ready_tx,
                        json!({ "ok": false, "status": 0, "errorBody": "请求超时，请检查网络连接" }),
                    );
                    unregister_stream(&app, &request_id);
                    return;
                }
            }
        }
    };

    let mut response = response;
    let status = response.status();
    if !status.is_success() {
        let error_body = response.text().await.unwrap_or_default();
        send_stream_ready(
            &mut ready_tx,
            json!({
                "ok": false,
                "status": status.as_u16(),
                "errorBody": error_body
            }),
        );
        unregister_stream(&app, &request_id);
        return;
    }

    send_stream_ready(
        &mut ready_tx,
        json!({ "ok": true, "status": status.as_u16() }),
    );

    // 空闲超时：服务端返回响应头后中途停发数据但不关闭连接（网关半开、
    // 模型侧卡死）时，若无超时会永久阻塞在 chunk()，前端卡在「生成中」。
    const STREAM_IDLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

    loop {
        let chunk = tokio::select! {
            _ = &mut abort_rx => {
                let _ = window.emit(
                    "ai-proxy-stream-error",
                    json!({ "requestId": request_id.as_str(), "error": "AbortError" }),
                );
                unregister_stream(&app, &request_id);
                return;
            }
            result = tokio::time::timeout(STREAM_IDLE_TIMEOUT, response.chunk()) => match result {
                Ok(chunk) => chunk,
                Err(_) => {
                    let _ = window.emit(
                        "ai-proxy-stream-error",
                        json!({ "requestId": request_id.as_str(), "error": "流响应超时" }),
                    );
                    unregister_stream(&app, &request_id);
                    return;
                }
            },
        };

        match chunk {
            Ok(Some(chunk)) => {
                let _ = window.emit(
                    "ai-proxy-stream-chunk",
                    json!({ "requestId": request_id.as_str(), "chunk": chunk.to_vec() }),
                );
            }
            Ok(None) => {
                let _ = window.emit(
                    "ai-proxy-stream-end",
                    json!({ "requestId": request_id.as_str() }),
                );
                unregister_stream(&app, &request_id);
                return;
            }
            Err(error) => {
                let _ = window.emit(
                    "ai-proxy-stream-error",
                    json!({ "requestId": request_id.as_str(), "error": error.to_string() }),
                );
                unregister_stream(&app, &request_id);
                return;
            }
        }
    }
}

async fn start_stream(app: &AppHandle, window: &WebviewWindow, config: Value) -> CompatResult {
    let request_id = config
        .get("requestId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .ok_or_else(|| "missing AI stream requestId".to_string())?;
    let options = serde_json::from_value::<FetchOptions>(config).map_err(|err| err.to_string())?;

    let (abort_tx, abort_rx) = tokio::sync::oneshot::channel();
    register_stream(app, &request_id, abort_tx);

    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
    let task_app = app.clone();
    let task_window = window.clone();
    let task_request_id = request_id.clone();

    tokio::spawn(async move {
        run_stream(
            task_app,
            task_window,
            options,
            task_request_id,
            Some(ready_tx),
            abort_rx,
        )
        .await;
    });

    ready_rx
        .await
        .map_err(|_| "AI stream task stopped before response".to_string())
}

async fn dispatch_compat_call(
    app: &AppHandle,
    window: &WebviewWindow,
    method: &str,
    args: &[Value],
) -> CompatResult {
    match method {
        "aiProxyStreamStart" => {
            let config = args.first().cloned().unwrap_or_else(|| json!({}));
            start_stream(app, window, config).await
        }
        "aiProxyStreamAbort" => {
            let request_id = arg_string(args, 0).unwrap_or_default();
            let aborted = abort_stream(app, &request_id);
            Ok(json!({ "success": true, "aborted": aborted }))
        }
        "aiProxyFetch" => {
            let config = args.first().cloned().unwrap_or_else(|| json!({}));
            let response = mihomo_transport::request(app, None, Some(config)).await?;
            Ok(json!({
                "ok": response.get("ok").and_then(Value::as_bool).unwrap_or(false),
                "status": response.get("status").and_then(Value::as_u64).unwrap_or(0),
                "body": response.get("text").and_then(Value::as_str).unwrap_or("").to_string()
            }))
        }
        _ => Err(format!("Unsupported AI proxy method: {method}")),
    }
}

pub(crate) async fn handle_compat_call(
    app: &AppHandle,
    window: &WebviewWindow,
    method: &str,
    args: &[Value],
) -> Option<CompatResult> {
    if !matches!(
        method,
        "aiProxyStreamStart" | "aiProxyStreamAbort" | "aiProxyFetch"
    ) {
        return None;
    }

    Some(dispatch_compat_call(app, window, method, args).await)
}
