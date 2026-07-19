//! Pure path/discovery helpers for core start prep.
//!
//! These functions intentionally take concrete paths and settings instead of
//! `AppHandle`, so lifecycle/prep tests can fully mock them without Tauri.

use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
};

use super::identity::{self, product_core_display_name};

/// Prefer an existing custom kernel, then a selected managed binary, then the
/// first existing default candidate.
pub fn choose_core_executable(
    custom: Option<&Path>,
    selected: &Path,
    default_candidates: &[PathBuf],
) -> Result<PathBuf, String> {
    if let Some(path) = custom.filter(|path| path.is_file()) {
        return Ok(path.to_path_buf());
    }
    if selected.is_file() {
        return Ok(selected.to_path_buf());
    }
    first_existing_file(default_candidates.iter().map(PathBuf::as_path)).ok_or_else(|| {
        format!(
            "未找到 {}，已检查应用资源、extra/sidecar 与应用数据 cores 目录中的候选内核",
            product_core_display_name()
        )
    })
}

pub fn first_existing_file<'a, I>(candidates: I) -> Option<PathBuf>
where
    I: IntoIterator<Item = &'a Path>,
{
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .map(Path::to_path_buf)
}

/// Build default discovery candidates: managed cores first, then resource paths.
pub fn default_core_candidates(
    managed_cores_dir: &Path,
    resource_candidates: &[PathBuf],
) -> Vec<PathBuf> {
    let exe_name = format!("mihomo{}", identity::executable_ext());
    let mut candidates = Vec::with_capacity(1 + resource_candidates.len());
    candidates.push(managed_cores_dir.join(&exe_name));
    candidates.extend(resource_candidates.iter().cloned());
    candidates
}

/// Managed cores path for a selected core type / specific version.
pub fn managed_core_path(
    cores_dir: &Path,
    core_type: &str,
    specific_version: Option<&str>,
) -> PathBuf {
    cores_dir.join(identity::managed_core_file_name(core_type, specific_version))
}

/// Service-mode start decision from already-resolved settings.
pub fn should_start_by_service(is_windows: bool, elevation_mode: &str, tun_enabled: bool) -> bool {
    is_windows && elevation_mode.trim() == "service" && tun_enabled
}

pub fn short_path_digest(path: &Path) -> String {
    let digest = Sha256::digest(path.to_string_lossy().as_bytes());
    digest
        .iter()
        .take(6)
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()
}

/// Target path under managed cores for a service-mode runtime copy.
pub fn service_runtime_target(managed_dir: &Path, source: &Path) -> PathBuf {
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
    managed_dir.join(format!(".service-runtime-{stem}-{digest}{ext}"))
}

pub fn path_is_under(child: &Path, parent: &Path) -> bool {
    match (fs::canonicalize(child), fs::canonicalize(parent)) {
        (Ok(child), Ok(parent)) => child.starts_with(parent),
        _ => false,
    }
}

pub fn needs_service_runtime_refresh(source: &Path, target: &Path) -> bool {
    match (source.metadata(), target.metadata()) {
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
    }
}

/// Resolve a core binary path that Windows helper service can execute.
///
/// Non-Windows: return source as-is.
/// Windows + already under managed cores: return source.
/// Otherwise: copy into managed cores when stale/missing.
pub fn ensure_service_compatible_core(
    source: &Path,
    managed_dir: &Path,
    is_windows: bool,
) -> Result<PathBuf, String> {
    if !is_windows {
        return Ok(source.to_path_buf());
    }

    if path_is_under(source, managed_dir) {
        return Ok(source.to_path_buf());
    }

    fs::create_dir_all(managed_dir).map_err(|err| {
        format!(
            "创建 service 内核目录 {} 失败: {err}",
            managed_dir.display()
        )
    })?;

    let target = service_runtime_target(managed_dir, source);
    if needs_service_runtime_refresh(source, &target) {
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

pub fn same_existing_path(left: &Path, right: &Path) -> bool {
    match (fs::canonicalize(left), fs::canonicalize(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default();
        let dir = std::env::temp_dir().join(format!("flyclash-core-paths-{label}-{nanos}"));
        fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    fn write_file(path: &Path, content: &[u8]) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("parent");
        }
        let mut file = fs::File::create(path).expect("create");
        file.write_all(content).expect("write");
    }

    #[test]
    fn choose_core_executable_prefers_custom_then_selected_then_default() {
        let root = temp_dir("choose");
        let custom = root.join("custom.exe");
        let selected = root.join("selected.exe");
        let default = root.join("default.exe");
        write_file(&custom, b"c");
        write_file(&selected, b"s");
        write_file(&default, b"d");

        assert_eq!(
            choose_core_executable(Some(&custom), &selected, &[default.clone()]).unwrap(),
            custom
        );

        fs::remove_file(&custom).unwrap();
        assert_eq!(
            choose_core_executable(Some(&custom), &selected, &[default.clone()]).unwrap(),
            selected
        );

        fs::remove_file(&selected).unwrap();
        assert_eq!(
            choose_core_executable(Some(&custom), &selected, &[default.clone()]).unwrap(),
            default
        );
    }

    #[test]
    fn should_start_by_service_requires_windows_service_mode_and_tun() {
        assert!(should_start_by_service(true, "service", true));
        assert!(!should_start_by_service(false, "service", true));
        assert!(!should_start_by_service(true, "task", true));
        assert!(!should_start_by_service(true, "service", false));
    }

    #[test]
    fn service_runtime_target_is_stable_for_source() {
        let managed = PathBuf::from("C:/app/cores");
        let source = PathBuf::from("D:/kernels/mihomo-alpha.exe");
        let target = service_runtime_target(&managed, &source);
        let name = target.file_name().unwrap().to_string_lossy();
        assert!(name.starts_with(".service-runtime-mihomo-alpha-"));
        assert!(name.ends_with(".exe"));
        assert_eq!(
            service_runtime_target(&managed, &source),
            target,
            "digest target must be stable"
        );
    }

    #[test]
    fn ensure_service_compatible_core_copies_outside_managed_on_windows() {
        let root = temp_dir("service-copy");
        let managed = root.join("cores");
        let source = root.join("outside").join("mihomo.exe");
        write_file(&source, b"binary-v1");

        let target = ensure_service_compatible_core(&source, &managed, true).expect("copy");
        assert!(target.starts_with(&managed));
        assert_eq!(fs::read(&target).unwrap(), b"binary-v1");

        // Already managed path is returned as-is.
        let again = ensure_service_compatible_core(&target, &managed, true).expect("managed");
        assert_eq!(again, target);

        // Non-windows leaves source untouched.
        let non_win = ensure_service_compatible_core(&source, &managed, false).expect("non-win");
        assert_eq!(non_win, source);
    }

    #[test]
    fn managed_core_path_uses_identity_file_names() {
        let cores = PathBuf::from("/data/cores");
        assert_eq!(
            managed_core_path(&cores, "mihomo-alpha", None),
            cores.join(format!("mihomo-alpha{}", identity::executable_ext()))
        );
        assert_eq!(
            managed_core_path(&cores, "mihomo-specific", Some("v1.2.3")),
            cores.join(format!("mihomo-1.2.3{}", identity::executable_ext()))
        );
    }
}
