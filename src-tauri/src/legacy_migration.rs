//! 改名前（FlyClash）的数据目录迁移。
//!
//! 应用标识从 `com.flyclash.desktop` 改成了 `com.devi766.diodos.desktop`，Tauri 按标识决定
//! 数据目录、WebView 存储目录等位置。启动时把旧目录整体改名到新位置，订阅、数据库、
//! 加密密钥和 WebView 里的本地存储都能原样带过来。必须在创建任何窗口之前执行。

use std::{env, fs, path::PathBuf};

const LEGACY_IDENTIFIER: &str = "com.flyclash.desktop";
const IDENTIFIER: &str = "com.devi766.diodos.desktop";

/// 各平台 Tauri 用来存放应用数据的父目录（数据、本地数据、缓存、日志、WebView）
fn candidate_bases() -> Vec<PathBuf> {
    let mut bases = Vec::new();
    let var = |key: &str| env::var_os(key).filter(|value| !value.is_empty()).map(PathBuf::from);

    if cfg!(windows) {
        bases.extend(var("APPDATA"));
        bases.extend(var("LOCALAPPDATA"));
    } else if cfg!(target_os = "macos") {
        if let Some(home) = var("HOME") {
            let library = home.join("Library");
            bases.push(library.join("Application Support"));
            bases.push(library.join("Caches"));
            bases.push(library.join("Logs"));
            bases.push(library.join("WebKit"));
        }
    } else if let Some(home) = var("HOME") {
        bases.push(var("XDG_DATA_HOME").unwrap_or_else(|| home.join(".local/share")));
        bases.push(var("XDG_CONFIG_HOME").unwrap_or_else(|| home.join(".config")));
        bases.push(var("XDG_CACHE_HOME").unwrap_or_else(|| home.join(".cache")));
    }

    bases.dedup();
    bases
}

/// 旧目录存在且新目录还没有时，把旧目录改名为新目录；任何失败都只跳过，不影响启动
pub fn migrate_legacy_app_dirs() {
    for base in candidate_bases() {
        let legacy = base.join(LEGACY_IDENTIFIER);
        let current = base.join(IDENTIFIER);
        if legacy.is_dir() && !current.exists() {
            if let Err(err) = fs::rename(&legacy, &current) {
                eprintln!("[migration] 迁移 {} 失败: {err}", legacy.display());
            }
        }
    }
}

/// 删除旧版留下的开机自启项。返回 true 表示旧版开过自启，调用方应为新版重新开启。
#[cfg(windows)]
pub fn remove_legacy_autostart() -> bool {
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
    let exists = Command::new("reg")
        .args(["query", RUN_KEY, "/v", "FlyClash"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false);
    if exists {
        let _ = Command::new("reg")
            .args(["delete", RUN_KEY, "/v", "FlyClash", "/f"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
    }
    exists
}

/// 删除旧版留下的开机自启项。返回 true 表示旧版开过自启，调用方应为新版重新开启。
#[cfg(not(windows))]
pub fn remove_legacy_autostart() -> bool {
    let Some(home) = env::var_os("HOME").map(PathBuf::from) else {
        return false;
    };
    let legacy = if cfg!(target_os = "macos") {
        home.join("Library/LaunchAgents")
            .join(format!("{LEGACY_IDENTIFIER}.plist"))
    } else {
        home.join(".config/autostart/flyclash.desktop")
    };
    if !legacy.exists() {
        return false;
    }
    if cfg!(target_os = "macos") {
        let _ = std::process::Command::new("launchctl")
            .arg("unload")
            .arg(&legacy)
            .output();
    }
    fs::remove_file(&legacy).is_ok()
}
