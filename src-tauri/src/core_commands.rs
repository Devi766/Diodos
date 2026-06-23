#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::{
    fs, io,
    io::Write,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use flate2::read::GzDecoder;
use regex::Regex;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, State, WebviewWindow};

use crate::{
    core::{identity as core_identity, manager::RunningMode, service as core_service},
    core_lifecycle_commands::restart_active_config_after_core_switch,
    profiles::read_last_config,
    resources::{core_resource_status, existing_resource_dir, existing_resource_file},
    runtime::is_mihomo_running,
    state::{AppState, VersionCacheEntry},
    storage::{app_data_dir, set_setting, setting},
};

type CompatResult = Result<Value, String>;

const VERSION_CACHE_EXPIRE_MS: u128 = 5 * 60 * 1000;

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

fn success(value: Value) -> Value {
    match value {
        Value::Object(mut object) => {
            object.entry("success").or_insert(Value::Bool(true));
            Value::Object(object)
        }
        other => json!({ "success": true, "value": other }),
    }
}

fn arg_string(args: &[Value], index: usize) -> Option<String> {
    args.get(index)
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

pub(crate) fn custom_kernel_path(app: &AppHandle) -> Result<Option<String>, String> {
    for key in ["kernelPath", "core_custom_path"] {
        if let Some(path) = setting(app, key, Value::Null)?
            .as_str()
            .map(str::trim)
            .filter(|path| !path.is_empty())
        {
            return Ok(Some(path.to_string()));
        }
    }
    Ok(None)
}

pub(crate) fn set_custom_kernel_path(app: &AppHandle, path: Option<&str>) -> Result<(), String> {
    let value = path
        .map(|path| Value::String(path.to_string()))
        .unwrap_or(Value::Null);
    set_setting(app, "kernelPath", value.clone())?;
    set_setting(app, "core_custom_path", value)
}

pub(crate) fn default_mihomo_executable(app: &AppHandle) -> Result<PathBuf, String> {
    let exe_name = if cfg!(windows) {
        "mihomo.exe"
    } else {
        "mihomo"
    };
    let managed_core = app_data_dir(app)?.join("cores").join(exe_name);
    if managed_core.is_file() {
        return Ok(managed_core);
    }

    existing_resource_file(
        app,
        &[
            PathBuf::from("cores").join(exe_name),
            PathBuf::from("extra").join("sidecar").join(exe_name),
            PathBuf::from("sidecar").join(exe_name),
            PathBuf::from(exe_name),
        ],
    )
    .ok_or_else(|| {
        format!(
            "未找到 Mihomo 内核，已检查应用资源、extra/sidecar 与应用数据 cores 目录中的 {exe_name}"
        )
    })
}

pub(crate) fn find_mihomo_executable(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(custom) = custom_kernel_path(app)?.filter(|path| Path::new(path).exists()) {
        return Ok(PathBuf::from(custom));
    }
    let selected = core_path(app, None, None)?;
    if selected.is_file() {
        return Ok(selected);
    }
    default_mihomo_executable(app)
}

pub(crate) fn cores_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app_data_dir(app)?.join("cores");
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    Ok(dir)
}

fn short_path_digest(path: &Path) -> String {
    let digest = Sha256::digest(path.to_string_lossy().as_bytes());
    digest
        .iter()
        .take(6)
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()
}

pub(crate) fn service_compatible_core_path(
    app: &AppHandle,
    source: &Path,
) -> Result<PathBuf, String> {
    if !cfg!(target_os = "windows") {
        return Ok(source.to_path_buf());
    }

    let managed_dir = cores_dir(app)?;
    if let (Ok(source_real), Ok(managed_real)) =
        (fs::canonicalize(source), fs::canonicalize(&managed_dir))
    {
        if source_real.starts_with(&managed_real) {
            return Ok(source.to_path_buf());
        }
    }

    let source_name = source
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or("mihomo.exe");
    let ext = Path::new(source_name)
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| format!(".{value}"))
        .unwrap_or_else(|| ".exe".to_string());
    let stem = Path::new(source_name)
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("mihomo");
    let digest = short_path_digest(source);
    let target = managed_dir.join(format!(".service-runtime-{stem}-{digest}{ext}"));

    let should_copy = match (source.metadata(), target.metadata()) {
        (Ok(source_meta), Ok(target_meta)) => {
            source_meta.len() != target_meta.len()
                || source_meta
                    .modified()
                    .ok()
                    .zip(target_meta.modified().ok())
                    .map(|(source_modified, target_modified)| source_modified > target_modified)
                    .unwrap_or(false)
        }
        (Ok(_), Err(_)) => true,
        _ => false,
    };

    if should_copy {
        fs::copy(source, &target).map_err(|err| {
            format!(
                "复制 service 模式内核 {} 到 {} 失败: {err}",
                source.display(),
                target.display()
            )
        })?;
    }

    Ok(target)
}

pub(crate) fn same_existing_path(left: &Path, right: &Path) -> bool {
    match (fs::canonicalize(left), fs::canonicalize(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

fn core_file_name(core_type: &str, specific_version: Option<&str>) -> String {
    core_identity::managed_core_file_name(core_type, specific_version)
}

pub(crate) fn normalize_core_version(value: &str) -> String {
    core_identity::normalize_core_version(value)
}

fn core_version_from_output(output: &str) -> Option<String> {
    Regex::new(r"(?i)Mihomo.*?\sv([0-9A-Za-z.\-]+)")
        .ok()
        .and_then(|regex| {
            regex
                .captures(output)
                .and_then(|captures| captures.get(1).map(|value| value.as_str().to_string()))
        })
}

pub(crate) fn core_binary_version(path: &Path) -> Option<String> {
    if !path.exists() {
        return None;
    }

    crate::tun_service::command_output(&path.to_string_lossy(), &["-v"])
        .ok()
        .and_then(|output| core_version_from_output(&output))
}

fn installed_core_identity(name: &str) -> Option<(&'static str, Option<String>)> {
    core_identity::installed_core_identity(name)
}

fn system_time_millis(time: SystemTime) -> Option<u64> {
    let millis = time.duration_since(UNIX_EPOCH).ok()?.as_millis();
    Some(millis.min(u64::MAX as u128) as u64)
}

pub(crate) fn core_path(
    app: &AppHandle,
    core_type: Option<&str>,
    specific_version: Option<&str>,
) -> Result<PathBuf, String> {
    if core_type.is_none() {
        if let Some(custom) = custom_kernel_path(app)?.filter(|path| Path::new(path).exists()) {
            return Ok(PathBuf::from(custom));
        }
    }
    let core_type = core_type
        .map(ToString::to_string)
        .or_else(|| {
            setting(app, "core_type", json!("mihomo"))
                .ok()
                .and_then(|value| value.as_str().map(ToString::to_string))
        })
        .unwrap_or_else(|| "mihomo".to_string());
    let stored_specific_version = if core_type == "mihomo-specific" && specific_version.is_none() {
        setting(app, "core_specific_version", Value::Null)
            .ok()
            .and_then(|value| value.as_str().map(normalize_core_version))
            .filter(|value| !value.is_empty())
    } else {
        None
    };
    Ok(cores_dir(app)?.join(core_file_name(
        &core_type,
        specific_version.or(stored_specific_version.as_deref()),
    )))
}

pub(crate) fn core_current_config(app: &AppHandle) -> CompatResult {
    let core_type = setting(app, "core_type", json!("mihomo"))?;
    let core_type_str = core_type
        .as_str()
        .map(ToString::to_string)
        .unwrap_or_else(|| "mihomo".to_string());
    let specific_version = setting(app, "core_specific_version", Value::Null)?;
    let custom_path = custom_kernel_path(app)?
        .map(Value::String)
        .unwrap_or(Value::Null);
    let path = core_path(app, None, None)?;
    let version = core_binary_version(&path)
        .map(Value::String)
        .unwrap_or(Value::Null);
    Ok(success(json!({
        "config": {
            "coreType": core_type,
            "specificVersion": specific_version,
            "customPath": custom_path
        },
        "corePath": path.to_string_lossy(),
        "version": version,
        "stableReleaseSeries": core_identity::is_stable_release_series(&core_type_str),
        "exists": path.exists()
    })))
}

pub(crate) fn core_installed(app: &AppHandle) -> CompatResult {
    let mut cores = Vec::new();
    let managed_dir = cores_dir(app)?;
    let mut sources = vec![(managed_dir.clone(), true, "managed")];
    if let Some(bundled_dir) = existing_resource_dir(app, &["extra/sidecar", "sidecar", "cores"]) {
        if !same_existing_path(&bundled_dir, &managed_dir) {
            sources.push((bundled_dir, false, "bundled"));
        }
    }

    for (dir, managed, source) in sources {
        if !dir.exists() {
            continue;
        }
        for entry in fs::read_dir(dir).map_err(|err| err.to_string())? {
            let entry = entry.map_err(|err| err.to_string())?;
            let path = entry.path();
            let metadata = entry.metadata().map_err(|err| err.to_string())?;
            if !metadata.is_file() {
                continue;
            }

            let name = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("");
            if let Some((core_type, file_version)) = installed_core_identity(name) {
                let version = file_version.or_else(|| core_binary_version(&path));
                let modified_at = metadata
                    .modified()
                    .ok()
                    .and_then(system_time_millis)
                    .unwrap_or(0);

                cores.push(json!({
                    "type": core_type,
                    "coreType": core_type,
                    "version": version,
                    "path": path.to_string_lossy(),
                    "size": metadata.len(),
                    "modifiedAt": modified_at,
                    "managed": managed,
                    "source": source
                }));
            }
        }
    }
    cores.sort_by(|a, b| {
        let a_time = a.get("modifiedAt").and_then(Value::as_u64).unwrap_or(0);
        let b_time = b.get("modifiedAt").and_then(Value::as_u64).unwrap_or(0);
        b_time.cmp(&a_time)
    });
    Ok(success(json!({ "cores": cores })))
}

fn core_repo(core_type: &str) -> (&'static str, &'static str, Option<&'static str>) {
    let repo = core_identity::core_repo(core_type);
    (repo.owner, repo.repo, repo.release_tag)
}

async fn github_json(url: &str) -> Result<Value, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|err| err.to_string())?
        .get(url)
        .header("User-Agent", "FlyClash-Tauri")
        .send()
        .await
        .map_err(|err| err.to_string())?
        .error_for_status()
        .map_err(|err| err.to_string())?
        .json::<Value>()
        .await
        .map_err(|err| err.to_string())
}

pub(crate) async fn latest_release(core_type: &str) -> Result<Value, String> {
    let (owner, repo, tag) = core_repo(core_type);
    if let Some(tag) = tag {
        let url = format!("https://api.github.com/repos/{owner}/{repo}/releases/tags/{tag}");
        return github_json(&url).await;
    }
    let url = format!("https://api.github.com/repos/{owner}/{repo}/releases/latest");
    github_json(&url).await
}

fn version_cache_key(core_type: &str, limit: usize) -> String {
    format!("{core_type}:{limit}")
}

pub(crate) fn clear_version_cache(state: &State<'_, AppState>, core_type: Option<&str>) -> usize {
    let mut runtime = state.runtime.lock().expect("runtime mutex poisoned");
    let before = runtime.version_cache.len();

    if let Some(core_type) = core_type.filter(|value| !value.trim().is_empty()) {
        let prefix = format!("{core_type}:");
        runtime
            .version_cache
            .retain(|key, _| !key.starts_with(&prefix));
    } else {
        runtime.version_cache.clear();
    }

    before.saturating_sub(runtime.version_cache.len())
}

fn release_to_version(release: Value) -> Value {
    let tag_name = release
        .get("tag_name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let version = tag_name.strip_prefix('v').unwrap_or(&tag_name).to_string();

    json!({
        "version": version,
        "tagName": tag_name,
        "name": release
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        "publishedAt": release
            .get("published_at")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        "prerelease": release
            .get("prerelease")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        "body": release
            .get("body")
            .and_then(Value::as_str)
            .unwrap_or_default()
    })
}

async fn release_versions(core_type: &str, limit: usize) -> Result<Vec<Value>, String> {
    let (owner, repo, _) = core_repo(core_type);
    let url = format!("https://api.github.com/repos/{owner}/{repo}/releases?per_page=100");
    let releases = github_json(&url).await?;
    let limit = limit.clamp(1, 100);
    let mut releases = releases.as_array().cloned().unwrap_or_default();

    if matches!(core_type, "mihomo" | "mihomo-specific") {
        releases.retain(|release| {
            !release
                .get("prerelease")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        });
    }

    Ok(releases
        .into_iter()
        .take(limit)
        .map(release_to_version)
        .collect())
}

pub(crate) async fn cached_release_versions(
    state: &State<'_, AppState>,
    core_type: &str,
    limit: usize,
    force_refresh: bool,
) -> Result<Vec<Value>, String> {
    let key = version_cache_key(core_type, limit);
    let now = now_millis();

    if !force_refresh {
        let cached = {
            let runtime = state.runtime.lock().expect("runtime mutex poisoned");
            runtime.version_cache.get(&key).cloned()
        };

        if let Some(entry) = cached {
            if now.saturating_sub(entry.timestamp) < VERSION_CACHE_EXPIRE_MS {
                return Ok(entry.versions);
            }
        }
    }

    let versions = release_versions(core_type, limit).await?;
    {
        let mut runtime = state.runtime.lock().expect("runtime mutex poisoned");
        runtime.version_cache.insert(
            key,
            VersionCacheEntry {
                versions: versions.clone(),
                timestamp: now_millis(),
            },
        );
    }
    Ok(versions)
}

fn wanted_asset_name() -> (&'static str, &'static str) {
    let os = if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    };
    let arch = if cfg!(target_arch = "x86_64") {
        "amd64"
    } else if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "386"
    };
    (os, arch)
}

fn select_release_asset(release: &Value) -> Option<Value> {
    let (os, arch) = wanted_asset_name();
    release
        .get("assets")?
        .as_array()?
        .iter()
        .find(|asset| {
            let name = asset
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_lowercase();
            name.contains(os)
                && name.contains(arch)
                && (name.ends_with(".zip") || name.ends_with(".gz"))
        })
        .cloned()
}

pub(crate) fn emit_core_progress(
    window: &WebviewWindow,
    core_type: &str,
    version: Option<&str>,
    phase: &str,
    progress: f64,
    downloaded: u64,
    total: u64,
) {
    let _ = window.emit(
        "core:download-progress",
        json!({
            "coreType": core_type,
            "version": version,
            "phase": phase,
            "progress": progress.clamp(0.0, 100.0),
            "downloaded": downloaded,
            "total": total
        }),
    );
}

pub(crate) fn emit_core_error(
    window: &WebviewWindow,
    core_type: &str,
    version: Option<&str>,
    error: &str,
) {
    let _ = window.emit(
        "core:download-progress",
        json!({
            "coreType": core_type,
            "version": version,
            "phase": "error",
            "progress": 0,
            "downloaded": 0,
            "total": 0,
            "error": error
        }),
    );
}

async fn download_to(
    window: &WebviewWindow,
    core_type: &str,
    version: Option<&str>,
    url: &str,
    path: &Path,
) -> Result<(), String> {
    let mut response = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|err| err.to_string())?
        .get(url)
        .header("User-Agent", "FlyClash-Tauri")
        .send()
        .await
        .map_err(|err| err.to_string())?
        .error_for_status()
        .map_err(|err| err.to_string())?;
    let total = response.content_length().unwrap_or(0);
    let mut downloaded = 0u64;
    let mut file = fs::File::create(path).map_err(|err| err.to_string())?;

    emit_core_progress(window, core_type, version, "downloading", 0.0, 0, total);

    while let Some(chunk) = response.chunk().await.map_err(|err| err.to_string())? {
        file.write_all(&chunk).map_err(|err| err.to_string())?;
        downloaded = downloaded.saturating_add(chunk.len() as u64);
        let progress = if total > 0 {
            downloaded as f64 * 100.0 / total as f64
        } else {
            0.0
        };
        emit_core_progress(
            window,
            core_type,
            version,
            "downloading",
            progress,
            downloaded,
            total,
        );
    }

    file.flush().map_err(|err| err.to_string())
}

fn ensure_core_executable(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        let mut permissions = fs::metadata(path)
            .map_err(|err| err.to_string())?
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(path, permissions).map_err(|err| err.to_string())?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn extract_zip_core_archive(archive: &Path, dest: &Path) -> Result<(), String> {
    let file = fs::File::open(archive).map_err(|err| err.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|err| err.to_string())?;
    for index in 0..zip.len() {
        let mut entry = zip.by_index(index).map_err(|err| err.to_string())?;
        let name = entry.name().to_lowercase();
        if name.contains("mihomo") && !name.ends_with('/') {
            let mut out = fs::File::create(dest).map_err(|err| err.to_string())?;
            io::copy(&mut entry, &mut out).map_err(|err| err.to_string())?;
            ensure_core_executable(dest)?;
            return Ok(());
        }
    }
    Err("下载包中未找到 mihomo 可执行文件".to_string())
}

fn extract_gz_core_archive(archive: &Path, dest: &Path) -> Result<(), String> {
    let file = fs::File::open(archive).map_err(|err| err.to_string())?;
    let mut decoder = GzDecoder::new(file);
    let mut out = fs::File::create(dest).map_err(|err| err.to_string())?;
    io::copy(&mut decoder, &mut out).map_err(|err| err.to_string())?;
    ensure_core_executable(dest)
}

fn extract_core_archive(archive: &Path, dest: &Path, archive_name: &str) -> Result<(), String> {
    let normalized = archive_name.to_lowercase();
    if normalized.ends_with(".zip") {
        return extract_zip_core_archive(archive, dest);
    }
    if normalized.ends_with(".gz") {
        return extract_gz_core_archive(archive, dest);
    }
    Err("不支持的内核压缩包格式".to_string())
}

pub(crate) async fn download_core(
    app: &AppHandle,
    window: &WebviewWindow,
    core_type: &str,
    version: Option<String>,
) -> CompatResult {
    let release = if let Some(version) = version.clone() {
        let (owner, repo, _) = core_repo(core_type);
        github_json(&format!(
            "https://api.github.com/repos/{owner}/{repo}/releases/tags/{version}"
        ))
        .await?
    } else {
        latest_release(core_type).await?
    };
    let tag = release
        .get("tag_name")
        .and_then(Value::as_str)
        .unwrap_or("latest")
        .to_string();
    let asset = select_release_asset(&release)
        .ok_or_else(|| "未找到当前平台可用的 mihomo 下载资源".to_string())?;
    let download_url = asset
        .get("browser_download_url")
        .and_then(Value::as_str)
        .ok_or_else(|| "release asset 缺少下载链接".to_string())?;
    let archive_name = asset
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("mihomo.zip");
    let tmp = cores_dir(app)?.join(format!("{archive_name}.tmp"));
    download_to(window, core_type, Some(&tag), download_url, &tmp).await?;
    emit_core_progress(window, core_type, Some(&tag), "verifying", 100.0, 0, 0);
    let dest = core_path(app, Some(core_type), version.as_deref().or(Some(&tag)))?;
    emit_core_progress(window, core_type, Some(&tag), "extracting", 100.0, 0, 0);
    let extract_result = extract_core_archive(&tmp, &dest, archive_name);
    let _ = fs::remove_file(tmp);
    extract_result?;
    emit_core_progress(window, core_type, Some(&tag), "done", 100.0, 0, 0);
    Ok(success(json!({
        "version": tag,
        "path": dest.to_string_lossy()
    })))
}

async fn dispatch_compat_call(
    app: &AppHandle,
    window: &WebviewWindow,
    state: &State<'_, AppState>,
    method: &str,
    args: &[Value],
) -> CompatResult {
    match method {
        "coreGetCurrentConfig" | "core:get-current-config" => core_current_config(app),
        "coreGetRuntimeState" | "core:get-runtime-state" => {
            let running = is_mihomo_running(app);
            let preferred_config = read_last_config(app).ok().flatten();
            let (core_state, runtime_active_config) = {
                let mut runtime = state.runtime.lock().expect("runtime mutex poisoned");
                let core_state = runtime.core.state();
                let runtime_active_config = runtime
                    .core
                    .runtime_active_config(running, preferred_config.clone());
                (core_state, runtime_active_config)
            };
            let mut payload = serde_json::to_value(&core_state).unwrap_or_else(|_| json!({}));
            if core_state.running_mode == RunningMode::Service {
                if let Ok(helper_status) = core_service::get_status() {
                    if let Some(object) = payload.as_object_mut() {
                        object.insert(
                            "coreRunning".to_string(),
                            Value::Bool(helper_status.running),
                        );
                        let pid_value = helper_status
                            .pid
                            .map(|pid| Value::Number(serde_json::Number::from(pid)))
                            .unwrap_or(Value::Null);
                        object.insert("pid".to_string(), pid_value.clone());
                        object.insert("corePid".to_string(), pid_value);
                    }
                }
            }
            if let Some(object) = payload.as_object_mut() {
                object.insert(
                    "preferredConfig".to_string(),
                    preferred_config
                        .clone()
                        .map(Value::String)
                        .unwrap_or(Value::Null),
                );
                object.insert(
                    "runtimeActiveConfig".to_string(),
                    runtime_active_config
                        .config
                        .clone()
                        .map(Value::String)
                        .unwrap_or(Value::Null),
                );
                object.insert(
                    "activeConfigSource".to_string(),
                    Value::String(runtime_active_config.source.as_str().to_string()),
                );
                object.insert(
                    "identity".to_string(),
                    serde_json::to_value(core_identity::product_identity())
                        .unwrap_or_else(|_| json!({})),
                );
                object.insert("resources".to_string(), core_resource_status(app));
                if running {
                    if let Some(probe) = crate::mihomo_controller::controller_probe_payload(app)
                        .await
                        .as_object()
                    {
                        for (key, value) in probe {
                            object.insert(key.clone(), value.clone());
                        }
                    }
                } else {
                    object.insert("controllerAvailable".to_string(), Value::Bool(false));
                    object.insert("controllerError".to_string(), Value::Null);
                    object.insert("controllerStatus".to_string(), Value::Null);
                    object.insert("coreVersion".to_string(), Value::Null);
                    object.insert("coreMeta".to_string(), Value::Null);
                    object.insert("corePremium".to_string(), Value::Null);
                }
            }
            Ok(success(payload))
        }
        "coreGetInstalledCores" | "core:get-installed-cores" => core_installed(app),
        "coreSwitchCore" | "core:switch-core" => {
            let core_type = arg_string(args, 0).unwrap_or_else(|| "mihomo".to_string());
            let specific = arg_string(args, 1)
                .map(|value| normalize_core_version(&value))
                .filter(|value| !value.is_empty());

            if core_type == "mihomo-specific" && specific.is_none() {
                return Ok(json!({
                    "success": false,
                    "error": "请先选择具体版本"
                }));
            }

            let path = core_path(app, Some(&core_type), specific.as_deref())?;
            if !path.exists() {
                return Ok(json!({
                    "success": false,
                    "error": "内核文件不存在，请先下载"
                }));
            }

            emit_core_progress(
                window,
                &core_type,
                specific.as_deref(),
                "switching",
                100.0,
                0,
                0,
            );
            set_setting(app, "core_type", json!(core_type.clone()))?;
            set_setting(
                app,
                "core_specific_version",
                specific.clone().map(Value::String).unwrap_or(Value::Null),
            )?;
            set_custom_kernel_path(app, None)?;

            let runtime_restart = restart_active_config_after_core_switch(
                app,
                window,
                state,
                &core_type,
                specific.as_deref(),
            )
            .await;
            let restart_skipped = runtime_restart
                .get("skipped")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let restart_failed = !restart_skipped
                && !runtime_restart
                    .get("restarted")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
            let restart_error = runtime_restart
                .get("error")
                .and_then(Value::as_str)
                .or_else(|| {
                    runtime_restart
                        .get("result")
                        .and_then(|result| result.get("error"))
                        .and_then(Value::as_str)
                });
            if restart_failed || restart_error.is_some() {
                let error = restart_error.unwrap_or("重启 Mihomo 失败");
                return Ok(json!({
                    "success": false,
                    "error": format!("内核已切换，但重启 Mihomo 失败: {error}"),
                    "runtimeRestart": runtime_restart
                }));
            }

            Ok(success(json!({ "runtimeRestart": runtime_restart })))
        }
        "coreSetCustomPath" | "core:set-custom-path" => {
            let path = arg_string(args, 0)
                .map(|path| path.trim().to_string())
                .filter(|path| !path.is_empty());
            if let Some(path) = path.as_deref() {
                if !Path::new(path).exists() {
                    return Ok(json!({
                        "success": false,
                        "error": "内核文件不存在"
                    }));
                }
            }
            set_custom_kernel_path(app, path.as_deref())?;
            Ok(success(json!({ "path": path })))
        }
        "getKernelPath" => {
            let custom = custom_kernel_path(app)?;
            let path = custom
                .as_deref()
                .map(PathBuf::from)
                .or_else(|| default_mihomo_executable(app).ok())
                .unwrap_or_default();
            Ok(success(json!({
                "path": path.to_string_lossy(),
                "isDefault": custom.is_none(),
                "exists": path.exists()
            })))
        }
        "selectKernelExecutable" => {
            let path = tauri::async_runtime::spawn_blocking(|| {
                let dialog = rfd::FileDialog::new().set_title("选择 Mihomo 内核");
                #[cfg(target_os = "windows")]
                let dialog = dialog.add_filter("可执行文件", &["exe"]);
                dialog.pick_file()
            })
            .await
            .map_err(|err| err.to_string())?;

            let Some(path) = path else {
                return Ok(json!({ "success": false, "canceled": true }));
            };
            if !path.exists() {
                return Ok(json!({
                    "success": false,
                    "error": "选择的内核文件不存在"
                }));
            }
            let selected = path.to_string_lossy().to_string();
            set_custom_kernel_path(app, Some(&selected))?;
            Ok(success(json!({
                "path": selected,
                "isDefault": false,
                "exists": true,
                "needsRestart": is_mihomo_running(app),
                "canceled": false
            })))
        }
        "resetKernelPath" => {
            set_custom_kernel_path(app, None)?;
            let path = default_mihomo_executable(app).ok();
            let exists = path.as_ref().map(|path| path.exists()).unwrap_or(false);
            Ok(success(json!({
                "path": path
                    .as_ref()
                    .map(|path| path.to_string_lossy().to_string())
                    .unwrap_or_default(),
                "isDefault": true,
                "exists": exists,
                "needsRestart": is_mihomo_running(app)
            })))
        }
        "coreDeleteCore" | "core:delete-core" => {
            let path = arg_string(args, 0).unwrap_or_default();
            if path.trim().is_empty() {
                return Ok(json!({ "success": false, "error": "缺少内核路径" }));
            }

            let path = PathBuf::from(path.trim());
            if !path.exists() {
                return Ok(json!({ "success": false, "error": "内核文件不存在" }));
            }

            let managed_dir = fs::canonicalize(cores_dir(app)?).map_err(|err| err.to_string())?;
            let target = fs::canonicalize(&path).map_err(|err| err.to_string())?;
            if !target.starts_with(&managed_dir) {
                return Ok(json!({
                    "success": false,
                    "error": "仅允许删除应用管理的内核目录内的文件"
                }));
            }

            if let Some(custom) = custom_kernel_path(app)? {
                if same_existing_path(&path, Path::new(&custom)) {
                    return Ok(json!({
                        "success": false,
                        "error": "当前文件是自定义内核路径，请先取消自定义路径后再删除"
                    }));
                }
            }

            if same_existing_path(&path, &core_path(app, None, None)?) {
                return Ok(json!({
                    "success": false,
                    "error": "不能删除当前选择的内核，请先切换到其他内核"
                }));
            }

            if is_mihomo_running(app)
                && find_mihomo_executable(app)
                    .map(|current| same_existing_path(&path, &current))
                    .unwrap_or(false)
            {
                return Ok(json!({
                    "success": false,
                    "error": "内核正在运行，停止后再删除"
                }));
            }

            fs::remove_file(&target).map_err(|err| err.to_string())?;
            Ok(success(
                json!({ "deleted": true, "path": target.to_string_lossy() }),
            ))
        }
        "coreClearVersionCache" | "core:clear-version-cache" => {
            let core_type = arg_string(args, 0)
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty());
            let cleared = clear_version_cache(state, core_type.as_deref());
            Ok(success(json!({ "cleared": cleared })))
        }
        "coreCheckUpdate" | "core:check-update" => {
            let core_type = arg_string(args, 0).unwrap_or_else(|| "mihomo".to_string());
            let current_path = core_path(app, Some(&core_type), None)?;
            let current_version = core_binary_version(&current_path);
            let release = latest_release(&core_type).await?;
            let latest_version = release
                .get("tag_name")
                .and_then(Value::as_str)
                .map(normalize_core_version)
                .filter(|value| !value.is_empty());
            let has_update = match (current_version.as_deref(), latest_version.as_deref()) {
                (Some(current), Some(latest)) => normalize_core_version(current) != latest,
                _ => true,
            };
            Ok(success(json!({
                "hasUpdate": has_update,
                "currentVersion": current_version,
                "latestVersion": latest_version,
                "releaseInfo": release
            })))
        }
        "coreGetAvailableVersions" | "core:get-available-versions" => {
            let core_type = arg_string(args, 0).unwrap_or_else(|| "mihomo".to_string());
            let limit = args.get(1).and_then(Value::as_u64).unwrap_or(20) as usize;
            let force_refresh = args.get(2).and_then(Value::as_bool).unwrap_or(false);
            Ok(success(
                json!({ "versions": cached_release_versions(state, &core_type, limit, force_refresh).await? }),
            ))
        }
        "coreDownloadCore" | "core:download-core" => {
            let core_type = arg_string(args, 0).unwrap_or_else(|| "mihomo".to_string());
            let result = download_core(app, window, &core_type, None).await;
            if let Err(error) = &result {
                emit_core_error(window, &core_type, None, error);
            } else {
                clear_version_cache(state, Some(&core_type));
            }
            result
        }
        "coreDownloadSpecificVersion" | "core:download-specific-version" => {
            let core_type = arg_string(args, 0).unwrap_or_else(|| "mihomo-specific".to_string());
            let version = arg_string(args, 1);
            let result = download_core(app, window, &core_type, version.clone()).await;
            if let Err(error) = &result {
                emit_core_error(window, &core_type, version.as_deref(), error);
            } else {
                clear_version_cache(state, Some(&core_type));
            }
            result
        }
        _ => Err(format!("Unsupported core method: {method}")),
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
        "coreGetCurrentConfig"
            | "core:get-current-config"
            | "coreGetRuntimeState"
            | "core:get-runtime-state"
            | "coreGetInstalledCores"
            | "core:get-installed-cores"
            | "coreSwitchCore"
            | "core:switch-core"
            | "coreSetCustomPath"
            | "core:set-custom-path"
            | "getKernelPath"
            | "selectKernelExecutable"
            | "resetKernelPath"
            | "coreDeleteCore"
            | "core:delete-core"
            | "coreClearVersionCache"
            | "core:clear-version-cache"
            | "coreCheckUpdate"
            | "core:check-update"
            | "coreGetAvailableVersions"
            | "core:get-available-versions"
            | "coreDownloadCore"
            | "core:download-core"
            | "coreDownloadSpecificVersion"
            | "core:download-specific-version"
    ) {
        return None;
    }

    Some(dispatch_compat_call(app, window, state, method, args).await)
}
