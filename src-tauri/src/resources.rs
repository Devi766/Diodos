use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager};

use crate::core::identity as core_identity;
use crate::storage::app_data_dir;

const MIHOMO_DATA_FILES: &[&str] = &[
    "geoip.metadb",
    "geosite.dat",
    "country.mmdb",
    "geoip.dat",
    "ASN.mmdb",
];

fn push_unique_path(paths: &mut Vec<PathBuf>, path: PathBuf) {
    if !paths.iter().any(|item| item == &path) {
        paths.push(path);
    }
}

fn resource_roots(app: &AppHandle) -> Vec<PathBuf> {
    let mut roots = Vec::new();

    // Development builds may load checked-out resources. Release builds must
    // never trust an attacker-controlled working directory for executables.
    if cfg!(debug_assertions) {
        if let Ok(current) = std::env::current_dir() {
            push_unique_path(&mut roots, current.clone());
            push_unique_path(&mut roots, current.join(".."));
            push_unique_path(&mut roots, current.join("flycast-ui"));
        }
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        push_unique_path(&mut roots, resource_dir.clone());
        push_unique_path(&mut roots, resource_dir.join("_up_"));
        push_unique_path(&mut roots, resource_dir.join(".."));
    }

    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(exe_dir) = current_exe.parent() {
            push_unique_path(&mut roots, exe_dir.to_path_buf());
            push_unique_path(&mut roots, exe_dir.join("_up_"));
            push_unique_path(&mut roots, exe_dir.join(".."));
            push_unique_path(&mut roots, exe_dir.join("..").join("Resources"));
        }
    }
    roots
}

fn add_resource_candidates(paths: &mut Vec<PathBuf>, app: &AppHandle, relative: impl AsRef<Path>) {
    let relative = relative.as_ref();
    for root in resource_roots(app) {
        push_unique_path(paths, root.join(relative));
    }
}

pub(crate) fn existing_resource_dir(app: &AppHandle, relatives: &[&str]) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    for relative in relatives {
        add_resource_candidates(&mut candidates, app, relative);
    }
    candidates.into_iter().find(|path| path.is_dir())
}

pub(crate) fn existing_resource_file(app: &AppHandle, relatives: &[PathBuf]) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    for relative in relatives {
        add_resource_candidates(&mut candidates, app, relative);
    }
    candidates.into_iter().find(|path| path.is_file())
}

fn tool_dirs(app: &AppHandle) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    add_resource_candidates(&mut dirs, app, "tools");
    dirs
}

pub(crate) fn mihomo_dir(app: &AppHandle) -> Result<PathBuf, String> {
    // Keep on-disk compatibility with existing installs that already use `mihomo/`.
    let dir = app_data_dir(app)?.join(core_identity::runtime_work_dir_name());
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    Ok(dir)
}

pub(crate) fn core_log_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = mihomo_dir(app)?;
    let product = dir.join(core_identity::product_core_log_file_name());
    if product.exists() {
        return Ok(product);
    }
    let legacy = dir.join(core_identity::legacy_core_log_file_name());
    if legacy.exists() {
        return Ok(legacy);
    }
    Ok(product)
}

fn should_copy_bundled_file(source: &Path, target: &Path) -> bool {
    if !source.is_file() {
        return false;
    }
    match target.metadata() {
        Ok(metadata) => metadata.len() == 0,
        Err(_) => true,
    }
}

pub(crate) fn sync_bundled_mihomo_data(app: &AppHandle) -> Result<(), String> {
    let Some(source_dir) = existing_resource_dir(app, &["tools/data", "data"]) else {
        eprintln!("[mihomo-data] bundled tools/data directory not found; startup will continue");
        return Ok(());
    };

    let target_dir = mihomo_dir(app)?;
    for file_name in MIHOMO_DATA_FILES {
        let mut source = source_dir.join(file_name);
        if !source.is_file() && file_name.eq_ignore_ascii_case("country.mmdb") {
            let alias = source_dir.join("Country.mmdb");
            if alias.is_file() {
                source = alias;
            }
        }

        if !source.is_file() {
            eprintln!(
                "[mihomo-data] bundled data file missing: {}",
                source.display()
            );
            continue;
        }

        let target = target_dir.join(file_name);
        if should_copy_bundled_file(&source, &target) {
            fs::copy(&source, &target).map_err(|err| {
                format!(
                    "复制内核数据文件 {} 到 {} 失败: {err}",
                    source.display(),
                    target.display()
                )
            })?;
        }

        if file_name.eq_ignore_ascii_case("country.mmdb") {
            let alias_target = target_dir.join("Country.mmdb");
            if should_copy_bundled_file(&source, &alias_target) {
                fs::copy(&source, &alias_target).map_err(|err| {
                    format!(
                        "复制内核数据文件 {} 到 {} 失败: {err}",
                        source.display(),
                        alias_target.display()
                    )
                })?;
            }
        }
    }

    Ok(())
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

pub(crate) fn core_resource_status(app: &AppHandle) -> Value {
    let core = match crate::core_commands::find_mihomo_executable(app) {
        Ok(path) => json!({
            "available": true,
            "path": path_string(&path)
        }),
        Err(error) => json!({
            "available": false,
            "path": Value::Null,
            "error": error
        }),
    };

    let helper_required = cfg!(target_os = "windows");
    let helper = if helper_required {
        match crate::tun_service::find_helper_executable(app) {
            Ok(path) => json!({
                "required": true,
                "available": true,
                "path": path_string(&path)
            }),
            Err(error) => json!({
                "required": true,
                "available": false,
                "path": Value::Null,
                "error": error
            }),
        }
    } else {
        json!({
            "required": false,
            "available": true,
            "path": Value::Null
        })
    };

    let source_dir = existing_resource_dir(app, &["tools/data", "data"]);
    let target_dir = mihomo_dir(app).ok();
    let mut missing_files = Vec::<String>::new();
    let mut synced_files = Vec::<String>::new();

    if let Some(target_dir) = target_dir.as_ref() {
        for file_name in MIHOMO_DATA_FILES {
            let target = target_dir.join(file_name);
            if target.is_file()
                || (file_name.eq_ignore_ascii_case("country.mmdb")
                    && target_dir.join("Country.mmdb").is_file())
            {
                synced_files.push((*file_name).to_string());
            } else {
                missing_files.push((*file_name).to_string());
            }
        }
    } else {
        missing_files.extend(MIHOMO_DATA_FILES.iter().map(|name| (*name).to_string()));
    }

    let data_available = source_dir.is_some() || missing_files.is_empty();
    let data = json!({
        "available": data_available,
        "synced": missing_files.is_empty(),
        "sourceDir": source_dir.as_ref().map(|path| path_string(path)),
        "targetDir": target_dir.as_ref().map(|path| path_string(path)),
        "syncedFiles": synced_files,
        "missingFiles": missing_files
    });

    json!({
        "core": core,
        "helper": helper,
        "data": data
    })
}

pub(crate) fn find_tool_path(app: &AppHandle, tool_name: &str) -> Result<Option<PathBuf>, String> {
    let requested = Path::new(tool_name);
    if tool_name.trim().is_empty()
        || requested.is_absolute()
        || requested
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return Err("Invalid tool name".to_string());
    }

    for dir in tool_dirs(app) {
        let candidate = dir.join(requested);
        if candidate.is_file() {
            return Ok(Some(candidate));
        }
    }

    Ok(None)
}
