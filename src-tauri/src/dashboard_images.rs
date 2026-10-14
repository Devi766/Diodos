use std::fs;
use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde_json::{json, Value};
use tauri::AppHandle;

use crate::storage::app_data_dir;

type CompatResult = Result<Value, String>;

// 选图时允许读取的原图上限，压缩在前端完成
const MAX_SOURCE_BYTES: u64 = 40 * 1024 * 1024;
// 前端压缩后回传的图片上限
const MAX_SAVED_BYTES: usize = 8 * 1024 * 1024;
const IMAGE_EXTENSIONS: [&str; 4] = ["webp", "jpg", "png", "gif"];

fn arg_string(args: &[Value], index: usize) -> Option<String> {
    args.get(index)
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

fn images_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app_data_dir(app)?.join("dashboard-images");
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    Ok(dir)
}

// 卡片 id 只保留字母、数字和连字符，副本 id 中的 # 换成下划线
fn file_stem(card_id: &str) -> Result<String, String> {
    let stem: String = card_id
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() || ch == '-' { ch } else { '_' })
        .collect();
    if stem.is_empty() || stem.len() > 80 {
        return Err("无效的卡片 id".to_string());
    }
    Ok(stem)
}

fn mime_of(extension: &str) -> &'static str {
    match extension {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        _ => "application/octet-stream",
    }
}

fn data_url(path: &Path, extension: &str) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|err| err.to_string())?;
    Ok(format!("data:{};base64,{}", mime_of(extension), BASE64.encode(bytes)))
}

fn existing_image(dir: &Path, stem: &str) -> Option<(PathBuf, &'static str)> {
    IMAGE_EXTENSIONS.iter().find_map(|extension| {
        let path = dir.join(format!("{stem}.{extension}"));
        path.is_file().then_some((path, *extension))
    })
}

fn remove_images(dir: &Path, stem: &str) {
    for extension in IMAGE_EXTENSIONS {
        let _ = fs::remove_file(dir.join(format!("{stem}.{extension}")));
    }
}

async fn pick_image() -> CompatResult {
    let picked = tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_title("选择图片")
            .add_filter("图片", &["png", "jpg", "jpeg", "webp", "gif", "bmp"])
            .pick_file()
    })
    .await
    .map_err(|err| err.to_string())?;

    let Some(path) = picked else {
        return Ok(json!({ "success": false, "canceled": true }));
    };
    let size = fs::metadata(&path).map_err(|err| err.to_string())?.len();
    if size > MAX_SOURCE_BYTES {
        return Ok(json!({ "success": false, "error": "图片文件过大" }));
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .unwrap_or_default();
    Ok(json!({ "success": true, "dataUrl": data_url(&path, &extension)? }))
}

fn save_image(app: &AppHandle, card_id: &str, encoded: &str, extension: &str) -> CompatResult {
    let extension = match extension {
        "jpeg" => "jpg",
        other => other,
    };
    if !IMAGE_EXTENSIONS.contains(&extension) {
        return Err("不支持的图片格式".to_string());
    }
    let payload = encoded.split_once(',').map(|(_, data)| data).unwrap_or(encoded);
    let bytes = BASE64.decode(payload).map_err(|err| err.to_string())?;
    if bytes.is_empty() || bytes.len() > MAX_SAVED_BYTES {
        return Err("图片大小无效".to_string());
    }
    let dir = images_dir(app)?;
    let stem = file_stem(card_id)?;
    remove_images(&dir, &stem);
    fs::write(dir.join(format!("{stem}.{extension}")), bytes).map_err(|err| err.to_string())?;
    Ok(json!({ "success": true }))
}

fn load_image(app: &AppHandle, card_id: &str) -> CompatResult {
    let dir = images_dir(app)?;
    let stem = file_stem(card_id)?;
    match existing_image(&dir, &stem) {
        Some((path, extension)) => Ok(json!({ "success": true, "dataUrl": data_url(&path, extension)? })),
        None => Ok(json!({ "success": true, "dataUrl": null })),
    }
}

fn remove_image(app: &AppHandle, card_id: &str) -> CompatResult {
    let dir = images_dir(app)?;
    remove_images(&dir, &file_stem(card_id)?);
    Ok(json!({ "success": true }))
}

pub(crate) async fn handle_compat_call(
    app: &AppHandle,
    method: &str,
    args: &[Value],
) -> Option<CompatResult> {
    let result = match method {
        "pickDashboardImage" => pick_image().await,
        "saveDashboardImage" => {
            let card_id = arg_string(args, 0).unwrap_or_default();
            let encoded = arg_string(args, 1).unwrap_or_default();
            let extension = arg_string(args, 2).unwrap_or_default();
            save_image(app, &card_id, &encoded, &extension)
        }
        "loadDashboardImage" => load_image(app, &arg_string(args, 0).unwrap_or_default()),
        "removeDashboardImage" => remove_image(app, &arg_string(args, 0).unwrap_or_default()),
        _ => return None,
    };
    Some(result)
}
