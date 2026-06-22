use crate::{app, state::AppState};
use serde::Deserialize;
use serde_json::Value;
use tauri::{AppHandle, State, WebviewWindow};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CompatRequest {
    method: String,
    #[serde(default)]
    args: Vec<Value>,
}

#[tauri::command]
pub(crate) async fn tauri_compat_call(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    request: CompatRequest,
) -> Result<Value, String> {
    app::handle_compat_call(app, window, state, request.method, request.args).await
}
