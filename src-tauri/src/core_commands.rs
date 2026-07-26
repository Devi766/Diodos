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
use tauri::{AppHandle, Emitter, State, WebviewWindow};

use crate::{
    core::{
        identity as core_identity, manager::RunningMode, paths as core_paths,
        service as core_service,
    },
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
    let exe_name = format!("mihomo{}", core_identity::executable_ext());
    let managed_cores_dir = app_data_dir(app)?.join("cores");
    let resource_candidates = [
        PathBuf::from("cores").join(&exe_name),
        PathBuf::from("extra").join("sidecar").join(&exe_name),
        PathBuf::from("sidecar").join(&exe_name),
        PathBuf::from(&exe_name),
    ];
    let resolved_resources = resource_candidates
        .iter()
        .filter_map(|relative| existing_resource_file(app, std::slice::from_ref(relative)))
        .collect::<Vec<_>>();
    let candidates = core_paths::default_core_candidates(&managed_cores_dir, &resolved_resources);
    core_paths::first_existing_file(candidates.iter().map(PathBuf::as_path)).ok_or_else(|| {
        format!(
            "未找到 {}，已检查应用资源、extra/sidecar 与应用数据 cores 目录中的 {exe_name}",
            core_identity::product_core_display_name()
        )
    })
}

pub(crate) fn find_mihomo_executable(app: &AppHandle) -> Result<PathBuf, String> {
    // macOS TUN requires the setuid root kernel under /Library/Application Support/Flycast.
    // Prefer it once authorized so runtime start actually uses the elevated binary.
    if let Some(path) = crate::tun_service::macos_authorized_kernel_path() {
        return Ok(path);
    }

    let custom = custom_kernel_path(app)?.map(PathBuf::from);
    let selected = core_path(app, None, None)?;
    // Prefer custom/selected when present; fall back to default discovery so the
    // missing-binary error still comes from the default search path message.
    match core_paths::choose_core_executable(custom.as_deref(), &selected, &[]) {
        Ok(path) => Ok(path),
        Err(_) => default_mihomo_executable(app),
    }
}

pub(crate) fn cores_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app_data_dir(app)?.join("cores");
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    Ok(dir)
}

/// 源内核指纹：大小 + 修改时间。用于在无法读取受保护目标副本时
/// 判断源内核（含用户自定义内核）是否发生过更新。
#[cfg(target_os = "windows")]
fn service_core_source_stamp(source: &Path) -> String {
    fs::metadata(source)
        .map(|meta| {
            let mtime = meta
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis())
                .unwrap_or_default();
            format!("{}:{}", meta.len(), mtime)
        })
        .unwrap_or_default()
}

#[cfg(target_os = "windows")]
fn service_core_stamp_key(target: &Path) -> String {
    format!(
        "serviceCoreStamp:{}",
        target
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_default()
    )
}

#[cfg(target_os = "windows")]
fn read_service_core_stamp(app: &AppHandle, target: &Path) -> Option<String> {
    crate::storage::setting(app, &service_core_stamp_key(target), serde_json::Value::Null)
        .ok()?
        .as_str()
        .map(ToString::to_string)
}

#[cfg(target_os = "windows")]
fn write_service_core_stamp(app: &AppHandle, target: &Path, stamp: &str) {
    if stamp.is_empty() {
        return;
    }
    let _ = crate::storage::set_setting(
        app,
        &service_core_stamp_key(target),
        serde_json::Value::String(stamp.to_string()),
    );
}

pub(crate) fn service_compatible_core_path(
    app: &AppHandle,
    source: &Path,
) -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    {
        let helper = crate::tun_service::find_helper_executable(app)?;
        let helper_dir = helper
            .parent()
            .ok_or_else(|| "无法确定 Helper 安装目录".to_string())?;
        let packaged_core_dirs = [
            helper_dir.to_path_buf(),
            helper_dir.join("cores"),
            helper_dir
                .parent()
                .map(|parent| parent.join("cores"))
                .unwrap_or_default(),
        ];
        if packaged_core_dirs
            .iter()
            .any(|dir| core_paths::path_is_under(source, dir))
        {
            return Ok(source.to_path_buf());
        }

        let program_data = std::env::var_os("ProgramData")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\ProgramData"));
        let managed_dir = program_data.join("FlyClash").join("service-cores");
        let target = core_paths::service_runtime_target(&managed_dir, source);
        let source_stamp = service_core_source_stamp(source);
        // 服务内核目录被 ACL 加固后，用户态可能读不到目标元数据（os error 5）。
        // 此时用「上次安装时记录的源内核指纹」判断是否需要重新安装，
        // 保证自定义内核被替换/更新后服务副本仍会刷新，同时避免每次启动都误判。
        let refresh_needed = match fs::metadata(&target) {
            Ok(_) => core_paths::needs_service_runtime_refresh(source, &target),
            Err(err) if err.kind() == std::io::ErrorKind::PermissionDenied => {
                read_service_core_stamp(app, &target).as_deref() != Some(source_stamp.as_str())
                    || source_stamp.is_empty()
            }
            Err(_) => true,
        };
        let trusted = if refresh_needed {
            false
        } else {
            core_service::service_core_is_trusted(&helper, &target)?
        };
        if refresh_needed || !trusted {
            core_service::install_service_core(&helper, source, &target)?;
        }
        if !core_service::service_core_is_trusted(&helper, &target)? {
            return Err("受保护服务内核完整性校验失败".to_string());
        }
        write_service_core_stamp(app, &target, &source_stamp);
        return Ok(target);
    }

    #[cfg(not(target_os = "windows"))]
    {
        let managed_dir = cores_dir(app)?;
        core_paths::ensure_service_compatible_core(source, &managed_dir, false)
    }
}

pub(crate) fn same_existing_path(left: &Path, right: &Path) -> bool {
    core_paths::same_existing_path(left, right)
}

pub(crate) fn normalize_core_version(value: &str) -> String {
    core_identity::normalize_core_version(value)
}

fn core_version_from_output(output: &str) -> Option<String> {
    // Stable:  "Mihomo Meta v1.19.12 ..."
    // Alpha:   "Mihomo Meta alpha-59ffb63 windows amd64 ..."
    // Smart:   "Mihomo Meta smart-xxxx ..." / "Mihomo Meta v1.x-smart ..."
    let patterns = [
        r"(?i)Mihomo(?:\s+Meta)?\s+v([0-9A-Za-z.\-]+)",
        r"(?i)Mihomo(?:\s+Meta)?\s+(alpha-[0-9A-Za-z.\-]+)",
        r"(?i)Mihomo(?:\s+Meta)?\s+(smart-[0-9A-Za-z.\-]+)",
        r"(?i)\bv([0-9]+\.[0-9A-Za-z.\-]+)\b",
    ];

    for pattern in patterns {
        if let Some(version) = Regex::new(pattern).ok().and_then(|regex| {
            regex
                .captures(output)
                .and_then(|captures| captures.get(1).map(|value| value.as_str().to_string()))
        }) {
            let normalized = normalize_core_version(&version);
            if !normalized.is_empty() {
                return Some(normalized);
            }
        }
    }
    None
}

pub(crate) fn core_binary_version(path: &Path) -> Option<String> {
    if !path.exists() {
        return None;
    }

    let mut command = std::process::Command::new(path);
    command.arg("-v");
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let output = command.output().ok()?;
    let combined = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    core_version_from_output(&combined)
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
    Ok(core_paths::managed_core_path(
        &cores_dir(app)?,
        &core_type,
        specific_version.or(stored_specific_version.as_deref()),
    ))
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
        let raw = version.trim().trim_start_matches(['v', 'V']);
        // GitHub release tags for stable mihomo are "vX.Y.Z". UI versions are stored
        // without the leading "v", so always request with "v" prefix first.
        let candidates = [
            format!("v{raw}"),
            raw.to_string(),
            version.trim().to_string(),
        ];
        let mut last_error = None;
        let mut found = None;
        for tag in candidates {
            if tag.trim().is_empty() {
                continue;
            }
            let url = format!("https://api.github.com/repos/{owner}/{repo}/releases/tags/{tag}");
            match github_json(&url).await {
                Ok(release) => {
                    found = Some(release);
                    break;
                }
                Err(error) => last_error = Some(error),
            }
        }
        found.ok_or_else(|| last_error.unwrap_or_else(|| format!("未找到内核版本 {version}")))?
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
            let probe = crate::mihomo_controller::controller_probe_payload(app).await;
            let controller_available = probe
                .get("controllerAvailable")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let (core_state, runtime_view) = {
                let mut runtime = state.runtime.lock().expect("runtime mutex poisoned");
                let core_state = runtime.core.state();
                let runtime_view = runtime.core.resolve_runtime_state(
                    running,
                    controller_available,
                    preferred_config.clone(),
                );
                (core_state, runtime_view)
            };
            let mut payload = serde_json::to_value(&core_state).unwrap_or_else(|_| json!({}));
            if let Some(object) = payload.as_object_mut() {
                object.insert(
                    "runningMode".to_string(),
                    Value::String(match runtime_view.running_mode {
                        RunningMode::Service => "service".to_string(),
                        RunningMode::Sidecar => "sidecar".to_string(),
                        RunningMode::NotRunning => "notRunning".to_string(),
                    }),
                );
            }
            if runtime_view.running_mode == RunningMode::Service {
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

            // Always attach helper readiness so Dashboard/TUN can share one status machine.
            let helper_flags = core_service::query_helper_service_flags();
            let helper_snapshot = core_service::helper_ipc_snapshot(helper_flags.running);
            let helper_status =
                core_service::helper_service_status_payload(helper_flags, helper_snapshot);
            if let Some(object) = payload.as_object_mut() {
                object.insert("helper".to_string(), helper_status);
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
                    if runtime_view.effective_running {
                        runtime_view
                            .active_config
                            .config
                            .clone()
                            .or_else(|| preferred_config.clone())
                    } else {
                        None
                    }
                    .map(Value::String)
                    .unwrap_or(Value::Null),
                );
                object.insert(
                    "activeConfigSource".to_string(),
                    Value::String(
                        if runtime_view.effective_running
                            && runtime_view.active_config.config.is_none()
                        {
                            "preferred"
                        } else {
                            runtime_view.active_config.source.as_str()
                        }
                        .to_string(),
                    ),
                );
                object.insert(
                    "identity".to_string(),
                    serde_json::to_value(core_identity::product_identity())
                        .unwrap_or_else(|_| json!({})),
                );
                object.insert("resources".to_string(), core_resource_status(app));
                if let Some(probe) = probe.as_object() {
                    for (key, value) in probe {
                        object.insert(key.clone(), value.clone());
                    }
                }
                if runtime_view.effective_running {
                    object.insert("coreRunning".to_string(), Value::Bool(true));
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
                let error = restart_error.unwrap_or("重启内核失败");
                return Ok(json!({
                    "success": false,
                    "error": format!("内核已切换，但重启内核失败: {error}"),
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
                let dialog = rfd::FileDialog::new().set_title("选择 FlyClash Core");
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

#[cfg(test)]
mod tests {
    use super::core_version_from_output;

    #[test]
    fn parses_stable_version_output() {
        let output = "Mihomo Meta v1.19.12 windows amd64 with go1.24.1";
        assert_eq!(core_version_from_output(output).as_deref(), Some("1.19.12"));
    }

    #[test]
    fn parses_alpha_version_output() {
        let output =
            "Mihomo Meta alpha-59ffb63 windows amd64 with go1.26.4 Tue Jun 23 11:08:27 UTC 2026\nUse tags: with_gvisor";
        assert_eq!(
            core_version_from_output(output).as_deref(),
            Some("alpha-59ffb63")
        );
    }

    #[test]
    fn parses_smart_version_output() {
        let output = "Mihomo Meta smart-abc123 windows amd64";
        assert_eq!(
            core_version_from_output(output).as_deref(),
            Some("smart-abc123")
        );
    }
}
