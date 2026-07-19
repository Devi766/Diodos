use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::{Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use base64::{engine::general_purpose, Engine as _};
use serde_json::{json, Value};
use tauri::{
    window::{Color, Effect, EffectsBuilder},
    AppHandle, Emitter, Manager, Theme, WebviewWindow,
};
use tauri_plugin_deep_link::DeepLinkExt;

use crate::resources::existing_resource_file;
use crate::storage::{set_setting, setting};

type CompatResult = Result<Value, String>;

const DEFAULT_PROXY_BYPASS: &str = "localhost;127.*;192.168.*;10.*;172.16.*;172.17.*;172.18.*;172.19.*;172.20.*;172.21.*;172.22.*;172.23.*;172.24.*;172.25.*;172.26.*;172.27.*;172.28.*;172.29.*;172.30.*;172.31.*;<local>";
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Generation counter for auto-lightweight timers. Incrementing cancels pending timers.
fn lightweight_timer_generation() -> &'static Mutex<u64> {
    static GEN: OnceLock<Mutex<u64>> = OnceLock::new();
    GEN.get_or_init(|| Mutex::new(0))
}

pub(crate) fn cancel_auto_lightweight_timer() {
    if let Ok(mut gen) = lightweight_timer_generation().lock() {
        *gen = gen.saturating_add(1);
    }
}

fn next_lightweight_timer_token() -> u64 {
    let mut gen = lightweight_timer_generation()
        .lock()
        .expect("lightweight timer mutex poisoned");
    *gen = gen.saturating_add(1);
    *gen
}


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

fn arg_bool(args: &[Value], index: usize) -> Option<bool> {
    args.get(index).and_then(Value::as_bool)
}

fn normalized_protocol_scheme(value: &str) -> Option<String> {
    let scheme = value
        .trim()
        .trim_end_matches(':')
        .trim_end_matches('/')
        .trim_end_matches('/')
        .to_ascii_lowercase();
    (!scheme.is_empty()
        && scheme
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '+' || ch == '-' || ch == '.'))
    .then_some(scheme)
}

fn command_output(program: &str, args: &[&str]) -> Result<String, String> {
    let mut command = Command::new(program);
    command.args(args);
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);
    let output = command.output().map_err(|err| err.to_string())?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            String::from_utf8_lossy(&output.stdout).trim().to_string()
        } else {
            stderr
        })
    }
}

fn command_status(program: &str, args: &[&str]) -> Result<(), String> {
    let mut command = Command::new(program);
    command.args(args);
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);
    let status = command.status().map_err(|err| err.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("{program} exited with status {status}"))
    }
}

fn set_autostart(app: &AppHandle, enabled: bool) -> Result<(), String> {
    set_setting(app, "autoStart", json!(enabled))?;
    if cfg!(target_os = "windows") {
        let exe = std::env::current_exe().map_err(|err| err.to_string())?;
        if enabled {
            let value = format!("\"{}\"", exe.to_string_lossy());
            let _ = command_output(
                "reg",
                &[
                    "add",
                    r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
                    "/v",
                    "FlyClash",
                    "/t",
                    "REG_SZ",
                    "/d",
                    &value,
                    "/f",
                ],
            )?;
        } else {
            let _ = command_output(
                "reg",
                &[
                    "delete",
                    r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
                    "/v",
                    "FlyClash",
                    "/f",
                ],
            );
        }
        return Ok(());
    }

    if cfg!(target_os = "macos") {
        // Best-effort LaunchAgent style autostart via `osascript` login item is brittle;
        // store preference and create a LaunchAgent plist under ~/Library/LaunchAgents.
        let home = std::env::var("HOME").map_err(|err| err.to_string())?;
        let agents = PathBuf::from(home).join("Library/LaunchAgents");
        let plist = agents.join("com.flyclash.desktop.plist");
        if enabled {
            let exe = std::env::current_exe().map_err(|err| err.to_string())?;
            fs::create_dir_all(&agents).map_err(|err| err.to_string())?;
            let content = format!(
                r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.flyclash.desktop</string>
  <key>ProgramArguments</key>
  <array>
    <string>{}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
"#,
                exe.to_string_lossy()
            );
            fs::write(&plist, content).map_err(|err| err.to_string())?;
            let _ = command_status("launchctl", &["load", &plist.to_string_lossy()]);
        } else if plist.exists() {
            let _ = command_status("launchctl", &["unload", &plist.to_string_lossy()]);
            let _ = fs::remove_file(&plist);
        }
        return Ok(());
    }

    if cfg!(target_os = "linux") {
        let home = std::env::var("HOME").map_err(|err| err.to_string())?;
        let autostart_dir = PathBuf::from(home).join(".config/autostart");
        let desktop = autostart_dir.join("flyclash.desktop");
        if enabled {
            let exe = std::env::current_exe().map_err(|err| err.to_string())?;
            fs::create_dir_all(&autostart_dir).map_err(|err| err.to_string())?;
            let content = format!(
                "[Desktop Entry]\nType=Application\nName=FlyClash\nExec=\"{}\"\nX-GNOME-Autostart-enabled=true\n",
                exe.to_string_lossy()
            );
            fs::write(&desktop, content).map_err(|err| err.to_string())?;
        } else if desktop.exists() {
            let _ = fs::remove_file(&desktop);
        }
        return Ok(());
    }

    Ok(())
}

fn autostart_enabled(app: &AppHandle) -> bool {
    if cfg!(target_os = "windows") {
        let output = command_output(
            "reg",
            &[
                "query",
                r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
                "/v",
                "FlyClash",
            ],
        );
        match output {
            Ok(text) => {
                let enabled = text
                    .lines()
                    .any(|line| line.contains("FlyClash") && line.contains(".exe"));
                let _ = set_setting(app, "autoStart", json!(enabled));
                return enabled;
            }
            Err(_) => {
                let _ = set_setting(app, "autoStart", json!(false));
                return false;
            }
        }
    }

    if cfg!(target_os = "macos") {
        if let Ok(home) = std::env::var("HOME") {
            let plist = PathBuf::from(home).join("Library/LaunchAgents/com.flyclash.desktop.plist");
            let enabled = plist.exists();
            let _ = set_setting(app, "autoStart", json!(enabled));
            return enabled;
        }
    }

    if cfg!(target_os = "linux") {
        if let Ok(home) = std::env::var("HOME") {
            let desktop = PathBuf::from(home).join(".config/autostart/flyclash.desktop");
            let enabled = desktop.exists();
            let _ = set_setting(app, "autoStart", json!(enabled));
            return enabled;
        }
    }

    setting(app, "autoStart", json!(false))
        .ok()
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
}

pub(crate) fn electron_platform() -> &'static str {
    if cfg!(target_os = "windows") {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else if cfg!(target_os = "freebsd") {
        "freebsd"
    } else if cfg!(target_os = "openbsd") {
        "openbsd"
    } else {
        std::env::consts::OS
    }
}

pub(crate) fn open_file_location(path: &Path) -> Result<(), String> {
    if cfg!(target_os = "windows") {
        Command::new("explorer.exe")
            .arg(format!("/select,{}", path.display()))
            .spawn()
            .map_err(|err| err.to_string())?;
        return Ok(());
    }

    if cfg!(target_os = "macos") {
        Command::new("open")
            .arg("-R")
            .arg(path)
            .spawn()
            .map_err(|err| err.to_string())?;
        return Ok(());
    }

    if let Some(parent) = path.parent() {
        open::that(parent).map_err(|err| err.to_string())?;
    }
    Ok(())
}

pub(crate) fn show_main_window(app: &AppHandle) {
    // Showing the window always exits lightweight mode and cancels pending auto-enter.
    cancel_auto_lightweight_timer();
    let _ = set_setting(app, "lightweightModeActive", json!(false));
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

pub(crate) fn hide_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
}

/// Enter lightweight mode.
///
/// Tauri parity with Electron:
/// - Always hide the main window and mark lightweight active.
/// - When core is already under helper service mode, the UI process can exit
///   while the helper keeps the core running (closest to Electron detached mode).
/// - Otherwise keep tray-only UI process so the sidecar core is not orphaned.
pub(crate) fn enter_lightweight_mode(app: &AppHandle) -> Result<Value, String> {
    cancel_auto_lightweight_timer();
    set_setting(app, "lightweightModeActive", json!(true))?;
    hide_main_window(app);

    let service_mode = crate::tun_service::should_start_core_by_service(app)
        && crate::runtime::is_mihomo_running(app);
    if service_mode {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(400)).await;
            app.exit(0);
        });
        return Ok(json!({
            "success": true,
            "mode": "service-exit",
            "message": "已进入轻量模式：UI 即将退出，Helper 服务继续运行内核"
        }));
    }

    Ok(json!({
        "success": true,
        "mode": "tray",
        "message": "已进入托盘轻量模式（Sidecar 模式下保留 UI 进程以维持内核）"
    }))
}

/// Schedule auto enter lightweight mode after `delay_secs`, cancellable via
/// `cancel_auto_lightweight_timer` / `show_main_window`.
pub(crate) fn schedule_auto_lightweight_timer(app: &AppHandle, delay_secs: u64) {
    let auto_enter = setting(app, "autoEnterLightweightMode", json!(false))
        .ok()
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    if !auto_enter {
        return;
    }

    let delay = delay_secs.clamp(10, 600);
    let token = next_lightweight_timer_token();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(delay)).await;
        let current = lightweight_timer_generation()
            .lock()
            .map(|gen| *gen)
            .unwrap_or(0);
        if current != token {
            return;
        }
        let still_hidden = app
            .get_webview_window("main")
            .map(|window| !window.is_visible().unwrap_or(false))
            .unwrap_or(false);
        if !still_hidden {
            return;
        }
        if let Err(error) = enter_lightweight_mode(&app) {
            eprintln!("[lightweight] auto enter failed: {error}");
        }
    });
}

fn apply_solid_appearance(window: &WebviewWindow, is_dark: bool) -> Result<(), String> {
    // Clear any previous system effect first so a failed acrylic/mica path can recover.
    let _ = window.set_effects(None);
    // Match main Electron solid colors: dark #1a1a1a / light #e5e7eb
    let color = if is_dark {
        Color(26, 26, 26, 255)
    } else {
        Color(229, 231, 235, 255)
    };
    window
        .set_background_color(Some(color))
        .map_err(|err| err.to_string())
}

fn theme_setting(app: Option<&AppHandle>) -> String {
    app.and_then(|app| setting(app, "theme", json!("system")).ok())
        .and_then(|value| value.as_str().map(ToString::to_string))
        .unwrap_or_else(|| "system".to_string())
}

/// Mirror Electron `nativeTheme.themeSource` so Windows DWM backdrop follows the app theme.
fn apply_native_theme_source(window: &WebviewWindow, theme: &str) {
    let source = match theme {
        "dark" => Some(Theme::Dark),
        "light" => Some(Theme::Light),
        _ => None, // system
    };
    if let Err(error) = window.set_theme(source) {
        eprintln!("[appearance] set_theme({theme}) failed: {error}");
    }
}

fn current_is_dark(window: &WebviewWindow, app: Option<&AppHandle>) -> bool {
    let theme = theme_setting(app);
    resolved_theme(window, &theme) == "dark"
}

fn apply_effectful_appearance(
    window: &WebviewWindow,
    effects: EffectsBuilder,
    label: &str,
    is_dark: bool,
) -> Result<(), String> {
    // Transparent first so the system effect can show through when it works.
    window
        .set_background_color(Some(Color(0, 0, 0, 0)))
        .map_err(|err| err.to_string())?;

    match window.set_effects(effects.build()) {
        Ok(()) => Ok(()),
        Err(error) => {
            // Windows/WebView2 can reject acrylic/mica on some builds. Fall back to a
            // solid surface so the UI never becomes a fully invisible transparent pane.
            eprintln!(
                "[appearance] {label} effect failed, falling back to solid: {error}"
            );
            apply_solid_appearance(window, is_dark)
        }
    }
}

#[allow(dead_code)]
pub(crate) fn apply_appearance_mode(window: &WebviewWindow, mode: &str) -> Result<(), String> {
    apply_appearance_mode_for_theme(window, mode, None)
}

pub(crate) fn apply_appearance_mode_for_app(
    app: &AppHandle,
    window: &WebviewWindow,
    mode: &str,
) -> Result<(), String> {
    apply_appearance_mode_for_theme(window, mode, Some(app))
}

fn apply_appearance_mode_for_theme(
    window: &WebviewWindow,
    mode: &str,
    app: Option<&AppHandle>,
) -> Result<(), String> {
    // Keep DWM immersive dark mode in sync before applying materials. Without this,
    // Tabbed/Mica follow the *system* theme and dark app chrome sits on a light backdrop.
    apply_native_theme_source(window, &theme_setting(app));

    let is_dark = current_is_dark(window, app);

    // Main Electron acrylic tint:
    // dark  => rgba(0xf0, 24, 32, 68)
    // light => rgba(0x99, 255, 255, 255)
    let acrylic_color = if is_dark {
        Color(24, 32, 68, 0xf0)
    } else {
        Color(255, 255, 255, 0x99)
    };

    match mode {
        "solid" => apply_solid_appearance(window, is_dark),
        "acrylic" => apply_effectful_appearance(
            window,
            EffectsBuilder::new()
                .effect(Effect::Acrylic)
                .color(acrylic_color),
            "acrylic",
            is_dark,
        ),
        "custom" => {
            // Custom mode paints its own image from the frontend. Keep the window
            // transparent, but never leave a previous mica/acrylic effect active.
            let _ = window.set_effects(None);
            window
                .set_background_color(Some(Color(0, 0, 0, 0)))
                .map_err(|err| err.to_string())
        }
        // Force dark/light material variants. Generic Tabbed/Mica follow the OS theme
        // and are the root cause of "dark UI on light window background".
        _ if is_dark => apply_effectful_appearance(
            window,
            EffectsBuilder::new().effects([
                Effect::TabbedDark,
                Effect::MicaDark,
                Effect::Blur,
            ]),
            "dynamic-dark",
            true,
        ),
        _ => apply_effectful_appearance(
            window,
            EffectsBuilder::new().effects([
                Effect::TabbedLight,
                Effect::MicaLight,
                Effect::Blur,
            ]),
            "dynamic-light",
            false,
        ),
    }
}

pub(crate) fn resolved_theme(window: &WebviewWindow, theme: &str) -> String {
    if theme != "system" {
        return theme.to_string();
    }

    window
        .theme()
        .ok()
        .map(|theme| {
            let name = if matches!(theme, Theme::Dark) {
                "dark"
            } else {
                "light"
            };
            name.to_string()
        })
        .unwrap_or_else(|| "light".to_string())
}


pub(crate) fn window_state_payload(window: &WebviewWindow) -> Value {
    let maximized = window.is_maximized().unwrap_or(false);
    let full_screen = window.is_fullscreen().unwrap_or(false);
    json!({
        "success": true,
        "maximized": maximized,
        "isMaximized": maximized,
        "fullScreen": full_screen,
        "isFullscreen": full_screen
    })
}

pub(crate) fn emit_window_state(window: &WebviewWindow) {
    let _ = window.emit("window-state-changed", window_state_payload(window));
}

fn custom_background_config(app: &AppHandle) -> Result<Option<Value>, String> {
    let value = setting(app, "customBackground", Value::Null)?;
    if value.is_null() {
        return Ok(None);
    }

    if let Some(raw) = value.as_str() {
        if raw.trim().is_empty() {
            return Ok(None);
        }
        return serde_json::from_str::<Value>(raw)
            .map(Some)
            .map_err(|err| err.to_string());
    }

    Ok(Some(value))
}

fn clamp_u64(value: Option<u64>, min: u64, max: u64, fallback: u64) -> u64 {
    value.unwrap_or(fallback).clamp(min, max)
}

fn background_image_data(path: &str) -> Option<String> {
    let bytes = fs::read(path).ok()?;
    let ext = Path::new(path)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mime = match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "webp" => "image/webp",
        _ => "application/octet-stream",
    };
    Some(format!(
        "data:{};base64,{}",
        mime,
        general_purpose::STANDARD.encode(bytes)
    ))
}

pub(crate) fn emit_custom_background(
    app: &AppHandle,
    window: &WebviewWindow,
) -> Result<(), String> {
    let Some(config) = custom_background_config(app)? else {
        return Ok(());
    };

    let image_path = config
        .get("imagePath")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    if image_path.is_empty() {
        return Ok(());
    }

    let opacity = clamp_u64(config.get("opacity").and_then(Value::as_u64), 0, 100, 80);
    let blur = clamp_u64(config.get("blur").and_then(Value::as_u64), 0, 100, 10);
    let image_data = background_image_data(&image_path);

    window
        .emit(
            "apply-custom-background",
            json!({
                "imagePath": image_path,
                "imageData": image_data,
                "opacity": opacity,
                "blur": blur
            }),
        )
        .map_err(|err| err.to_string())
}

fn parse_host_port(value: &str) -> (Option<String>, Option<u16>) {
    let mut candidate = value.trim();
    if let Some((_, server)) = candidate.split_once('=') {
        candidate = server;
    }
    candidate = candidate.split(';').next().unwrap_or(candidate).trim();
    let Some((host, port)) = candidate.rsplit_once(':') else {
        return (
            if candidate.is_empty() {
                None
            } else {
                Some(candidate.to_string())
            },
            None,
        );
    };
    (
        if host.is_empty() {
            None
        } else {
            Some(host.to_string())
        },
        port.parse::<u16>().ok(),
    )
}

/// Native Windows system-proxy control.
/// Port of `native/sysproxy/main.go` (Advapi32 registry + WinINet InternetSetOption).
/// Does **not** shell out to sysproxy.exe / reg.exe / PowerShell.
#[cfg(windows)]
fn set_windows_proxy(
    _app: Option<&AppHandle>,
    enabled: bool,
    host: &str,
    port: u16,
    bypass: Option<&str>,
) -> Result<(), String> {
    crate::win_sysproxy::set_proxy(enabled, host, port, bypass)
}

#[cfg(not(windows))]
fn set_windows_proxy(
    _app: Option<&AppHandle>,
    _enabled: bool,
    _host: &str,
    _port: u16,
    _bypass: Option<&str>,
) -> Result<(), String> {
    Err("系统代理仅支持 Windows".to_string())
}

fn windows_proxy_status() -> Result<Value, String> {
    // Prefer native Advapi32 query (same source as set path) over shelling `reg query`.
    #[cfg(windows)]
    {
        let query = crate::win_sysproxy::query_proxy()?;
        let (host, port) = query
            .server
            .as_deref()
            .map(parse_host_port)
            .unwrap_or((None, None));
        return Ok(success(json!({
            "enabled": query.enabled,
            "host": host,
            "port": port,
            "bypass": query.bypass,
            "pacUrl": query.pac_url,
            "source": "windows-native"
        })));
    }
    #[cfg(not(windows))]
    {
        Ok(success(json!({
            "enabled": false,
            "host": Value::Null,
            "port": Value::Null,
            "source": "windows"
        })))
    }
}

fn macos_network_services() -> Result<Vec<String>, String> {
    let output = command_output("networksetup", &["-listallnetworkservices"])?;
    Ok(output
        .lines()
        .skip(1)
        .map(str::trim)
        .filter(|service| !service.is_empty() && !service.starts_with('*'))
        .map(ToString::to_string)
        .collect())
}

fn set_macos_proxy(enabled: bool, host: &str, port: u16) -> Result<(), String> {
    let services = macos_network_services()?;
    let port = port.to_string();
    for service in services {
        if enabled {
            command_output("networksetup", &["-setwebproxy", &service, host, &port])?;
            command_output(
                "networksetup",
                &["-setsecurewebproxy", &service, host, &port],
            )?;
            command_output(
                "networksetup",
                &["-setsocksfirewallproxy", &service, host, &port],
            )?;
        } else {
            command_output("networksetup", &["-setwebproxystate", &service, "off"])?;
            command_output(
                "networksetup",
                &["-setsecurewebproxystate", &service, "off"],
            )?;
            command_output(
                "networksetup",
                &["-setsocksfirewallproxystate", &service, "off"],
            )?;
        }
    }
    Ok(())
}

fn macos_proxy_status() -> Result<Value, String> {
    let Some(service) = macos_network_services()?.into_iter().next() else {
        return Ok(success(json!({
            "enabled": false,
            "host": Value::Null,
            "port": Value::Null,
            "source": "macos"
        })));
    };
    let output = command_output("networksetup", &["-getwebproxy", &service])?;
    let mut enabled = false;
    let mut host = None;
    let mut port = None;
    for line in output.lines() {
        if let Some(value) = line.strip_prefix("Enabled:") {
            enabled = value.trim().eq_ignore_ascii_case("yes");
        } else if let Some(value) = line.strip_prefix("Server:") {
            let value = value.trim();
            if !value.is_empty() {
                host = Some(value.to_string());
            }
        } else if let Some(value) = line.strip_prefix("Port:") {
            port = value.trim().parse::<u16>().ok();
        }
    }
    Ok(success(json!({
        "enabled": enabled,
        "host": host,
        "port": port,
        "source": "macos",
        "service": service
    })))
}

pub(crate) fn system_proxy_status(app: &AppHandle) -> Value {
    let result = if cfg!(target_os = "windows") {
        windows_proxy_status()
    } else if cfg!(target_os = "macos") {
        macos_proxy_status()
    } else {
        Ok(success(json!({
            "enabled": setting(app, "systemProxyEnabled", json!(false))
                .ok()
                .and_then(|value| value.as_bool())
                .unwrap_or(false),
            "host": Value::Null,
            "port": Value::Null,
            "source": "stored"
        })))
    };

    match result {
        Ok(status) => status,
        Err(error) => success(json!({
            "enabled": setting(app, "systemProxyEnabled", json!(false))
                .ok()
                .and_then(|value| value.as_bool())
                .unwrap_or(false),
            "host": Value::Null,
            "port": Value::Null,
            "source": "stored",
            "error": error
        })),
    }
}

pub(crate) fn set_system_proxy(
    app: &AppHandle,
    enabled: bool,
    host: &str,
    port: u16,
) -> Result<(), String> {
    let bypass = setting(app, "system_proxy_bypass", json!(DEFAULT_PROXY_BYPASS))
        .ok()
        .and_then(|value| value.as_str().map(ToString::to_string));
    if cfg!(target_os = "windows") {
        set_windows_proxy(Some(app), enabled, host, port, bypass.as_deref())?;
    } else if cfg!(target_os = "macos") {
        set_macos_proxy(enabled, host, port)?;
    } else if enabled {
        return Err("当前平台暂不支持自动设置系统代理".to_string());
    }

    if enabled {
        std::env::set_var("HTTP_PROXY", format!("http://{host}:{port}"));
        std::env::set_var("HTTPS_PROXY", format!("http://{host}:{port}"));
        std::env::set_var("ALL_PROXY", format!("http://{host}:{port}"));
        std::env::set_var("http_proxy", format!("http://{host}:{port}"));
        std::env::set_var("https_proxy", format!("http://{host}:{port}"));
        std::env::set_var("all_proxy", format!("http://{host}:{port}"));
    } else {
        std::env::remove_var("HTTP_PROXY");
        std::env::remove_var("HTTPS_PROXY");
        std::env::remove_var("ALL_PROXY");
        std::env::remove_var("http_proxy");
        std::env::remove_var("https_proxy");
        std::env::remove_var("all_proxy");
    }
    set_setting(app, "systemProxyEnabled", json!(enabled))?;
    Ok(())
}

fn process_icon_data_url(process_path: &str) -> Result<Option<String>, String> {
    if !cfg!(target_os = "windows") {
        return Ok(None);
    }

    let path = if process_path == "mihomo" {
        std::env::current_exe().map_err(|err| err.to_string())?
    } else {
        PathBuf::from(process_path)
    };

    if !path.exists() || !path.is_file() {
        return Ok(None);
    }

    let script = r#"
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$path = $env:FLYCLASH_ICON_PATH
$icon = [System.Drawing.Icon]::ExtractAssociatedIcon($path)
if ($null -eq $icon) { exit 2 }
$bitmap = $icon.ToBitmap()
$stream = New-Object System.IO.MemoryStream
$bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
[Console]::Out.Write([Convert]::ToBase64String($stream.ToArray()))
$stream.Dispose()
$bitmap.Dispose()
$icon.Dispose()
"#;

    let mut command = Command::new("powershell.exe");
    command
        .args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script,
        ])
        .env("FLYCLASH_ICON_PATH", &path);
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);

    let output = command.output().map_err(|err| err.to_string())?;
    if !output.status.success() {
        return Ok(None);
    }

    let encoded = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if encoded.is_empty() {
        Ok(None)
    } else {
        Ok(Some(format!("data:image/png;base64,{encoded}")))
    }
}

fn run_powershell_script(script: &str) -> Result<String, String> {
    if !cfg!(target_os = "windows") {
        return Err("Loopback 仅支持 Windows".to_string());
    }

    let path = std::env::temp_dir().join(format!(
        "flyclash-loopback-{}-{}.ps1",
        std::process::id(),
        now_millis()
    ));
    let mut bytes = vec![0xEF, 0xBB, 0xBF];
    bytes.extend_from_slice(
        format!(
            "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n{}",
            script
        )
        .as_bytes(),
    );
    fs::write(&path, bytes).map_err(|err| err.to_string())?;

    let mut command = Command::new("powershell.exe");
    command
        .arg("-NoProfile")
        .arg("-NonInteractive")
        .arg("-ExecutionPolicy")
        .arg("Bypass")
        .arg("-File")
        .arg(&path);
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);

    let output = command.output().map_err(|err| err.to_string());
    let _ = fs::remove_file(&path);
    let output = output?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return Err(if stderr.is_empty() { stdout } else { stderr });
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn loopback_api_call(method_call: &str) -> Result<String, String> {
    let csharp = include_str!("../../electron/loopback-helper.cs");
    let script = format!(
        "$ErrorActionPreference = 'Stop'\nAdd-Type -TypeDefinition @'\n{}\n'@\n{}",
        csharp, method_call
    );
    run_powershell_script(&script)
}

fn loopback_display_names() -> HashMap<String, String> {
    let script = r#"
$ErrorActionPreference = 'SilentlyContinue'
$results = @{}
try {
  Get-StartApps | ForEach-Object {
    if ($_.AppID -and $_.Name -and $_.AppID -like '*!*') {
      $pfn = ($_.AppID -split '!')[0]
      if ($pfn) { $results[$pfn] = $_.Name }
    }
  }
} catch {}
try {
  Get-AppxPackage | ForEach-Object {
    $pkgName = $_.Name
    $pfn = $_.PackageFamilyName
    if ($pfn -and $results.ContainsKey($pfn)) {
      $results[$pkgName] = $results[$pfn]
    }
  }
} catch {}
$results | ConvertTo-Json -Compress -Depth 1
"#;

    let Ok(output) = run_powershell_script(script) else {
        return HashMap::new();
    };
    let Ok(value) = serde_json::from_str::<Value>(&output) else {
        return HashMap::new();
    };
    value
        .as_object()
        .map(|object| {
            object
                .iter()
                .filter_map(|(key, value)| {
                    value
                        .as_str()
                        .map(|display| (key.to_ascii_lowercase(), display.to_string()))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn loopback_resolve_display_name(app: &mut Value, names: &HashMap<String, String>) {
    let container_name = app
        .get("appContainerName")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    let package_family_name = app
        .get("packageFamilyName")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();

    let mut resolved = names
        .get(&package_family_name)
        .or_else(|| names.get(&container_name))
        .cloned();

    if resolved.is_none() {
        if let Some((prefix, _)) = package_family_name.rsplit_once('_') {
            resolved = names.get(prefix).cloned();
        }
    }

    if resolved.is_none() && !container_name.is_empty() {
        resolved = names.iter().find_map(|(key, value)| {
            (key.starts_with(&container_name) || container_name.starts_with(key))
                .then(|| value.clone())
        });
    }

    if let Some(resolved) = resolved {
        if let Some(object) = app.as_object_mut() {
            object.insert("displayName".to_string(), Value::String(resolved));
        }
    }
}

fn loopback_sid_valid(sid: &str) -> bool {
    // AppContainer SIDs look like S-1-15-2-<digits>...
    let upper = sid.trim();
    if !upper.to_ascii_uppercase().starts_with("S-1-15-2-") {
        return false;
    }
    upper
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '-')
        && upper.contains('-')
        && upper.len() >= 12
}

fn find_enable_loopback_tool(app: &AppHandle) -> Option<PathBuf> {
    existing_resource_file(
        app,
        &[
            PathBuf::from("extra")
                .join("files")
                .join("EnableLoopback.exe"),
            PathBuf::from("files").join("EnableLoopback.exe"),
            PathBuf::from("tools").join("EnableLoopback.exe"),
            PathBuf::from("EnableLoopback.exe"),
            PathBuf::from("extra")
                .join("files")
                .join("enableLoopback.exe"),
            PathBuf::from("files").join("enableLoopback.exe"),
            PathBuf::from("tools").join("enableLoopback.exe"),
            PathBuf::from("enableLoopback.exe"),
        ],
    )
}

fn windows_process_is_elevated() -> bool {
    if !cfg!(target_os = "windows") {
        return false;
    }
    // Mirror helper service check used elsewhere; best-effort via whoami /groups.
    let mut command = Command::new("whoami");
    command.arg("/groups");
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);
    let Ok(output) = command.output() else {
        return false;
    };
    if !output.status.success() {
        return false;
    }
    let text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
    .to_ascii_lowercase();
    text.contains("s-1-5-32-544") && text.contains("enabled")
}

/// Open the classic EnableLoopback utility (Clash Party / Verge style fallback).
/// Elevates with UAC when the current process is not admin.
fn open_enable_loopback_tool(app: &AppHandle) -> CompatResult {
    if !cfg!(target_os = "windows") {
        return Ok(json!({
            "success": false,
            "error": "EnableLoopback 仅支持 Windows"
        }));
    }

    let Some(tool_path) = find_enable_loopback_tool(app) else {
        return Ok(json!({
            "success": false,
            "error": "未找到 EnableLoopback.exe，请确认 extra/files 或应用资源目录中已打包该工具"
        }));
    };

    let elevated = windows_process_is_elevated();
    if elevated {
        // GUI tool must keep its window — do not set CREATE_NO_WINDOW here.
        Command::new(&tool_path)
            .spawn()
            .map_err(|err| format!("启动 EnableLoopback 失败: {err}"))?;
        return Ok(success(json!({
            "launched": true,
            "elevated": true,
            "path": tool_path.to_string_lossy()
        })));
    }

    // Not elevated: relaunch tool with RunAs, matching Clash Party openUWPTool().
    let escaped = tool_path.to_string_lossy().replace('\'', "''");
    let ps = format!(
        "Start-Process -FilePath '{escaped}' -Verb RunAs"
    );
    let mut command = Command::new("powershell.exe");
    command
        .arg("-NoProfile")
        .arg("-NonInteractive")
        .arg("-ExecutionPolicy")
        .arg("Bypass")
        .arg("-Command")
        .arg(ps);
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);
    let output = command
        .output()
        .map_err(|err| format!("提权启动 EnableLoopback 失败: {err}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return Ok(json!({
            "success": false,
            "error": if !stderr.is_empty() { stderr } else if !stdout.is_empty() { stdout } else {
                "用户取消了 UAC 提权或启动失败".to_string()
            }
        }));
    }

    Ok(success(json!({
        "launched": true,
        "elevated": false,
        "path": tool_path.to_string_lossy()
    })))
}

fn loopback_apps(app: &AppHandle) -> CompatResult {
    if !cfg!(target_os = "windows") {
        return Ok(success(json!({
            "apps": [],
            "isAdmin": false,
            "toolAvailable": false,
            "total": 0,
            "exempt": 0
        })));
    }

    let tool_available = find_enable_loopback_tool(app).is_some();
    let output = match loopback_api_call("[NetworkIsolationHelper]::EnumAppContainers()") {
        Ok(output) => output,
        Err(error) => {
            return Ok(json!({
                "success": false,
                "error": error,
                "apps": [],
                "isAdmin": true,
                "toolAvailable": tool_available
            }))
        }
    };
    if output.is_empty() || output == "null" {
        return Ok(success(json!({
            "apps": [],
            "isAdmin": true,
            "toolAvailable": tool_available,
            "total": 0,
            "exempt": 0
        })));
    }

    let parsed = match serde_json::from_str::<Value>(&output) {
        Ok(parsed) => parsed,
        Err(error) => {
            return Ok(json!({
                "success": false,
                "error": format!("解析 Loopback 应用列表失败: {error}"),
                "apps": [],
                "isAdmin": true,
                "toolAvailable": tool_available
            }))
        }
    };
    if let Some(error) = parsed.get("error").and_then(Value::as_str) {
        return Ok(json!({
            "success": false,
            "error": error,
            "apps": [],
            "isAdmin": true,
            "toolAvailable": tool_available
        }));
    }

    let mut apps = match parsed {
        Value::Array(items) => items,
        other => vec![other],
    };

    // Drop invalid entries and dedupe by SID (last wins).
    let mut by_sid: HashMap<String, Value> = HashMap::new();
    for item in apps.drain(..) {
        let Some(sid) = item
            .get("sid")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty() && loopback_sid_valid(value))
            .map(ToString::to_string)
        else {
            continue;
        };
        by_sid.insert(sid.to_ascii_uppercase(), item);
    }
    apps = by_sid.into_values().collect();

    let display_names = loopback_display_names();
    for app in &mut apps {
        loopback_resolve_display_name(app, &display_names);
        // Prefer a non-empty displayName fallback.
        if let Some(object) = app.as_object_mut() {
            let display = object
                .get("displayName")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string);
            if display.is_none() {
                let fallback = object
                    .get("packageFamilyName")
                    .and_then(Value::as_str)
                    .or_else(|| object.get("appContainerName").and_then(Value::as_str))
                    .unwrap_or("Unknown App")
                    .to_string();
                object.insert("displayName".to_string(), Value::String(fallback));
            }
        }
    }
    apps.sort_by(|left, right| {
        let left_exempt = left
            .get("isExempt")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let right_exempt = right
            .get("isExempt")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        right_exempt.cmp(&left_exempt).then_with(|| {
            let left_name = left
                .get("displayName")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let right_name = right
                .get("displayName")
                .and_then(Value::as_str)
                .unwrap_or_default();
            left_name
                .to_ascii_lowercase()
                .cmp(&right_name.to_ascii_lowercase())
        })
    });

    let exempt_sids = apps
        .iter()
        .filter(|item| {
            item.get("isExempt")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        })
        .filter_map(|item| item.get("sid").and_then(Value::as_str))
        .collect::<Vec<_>>();
    let total = apps.len();
    let exempt = exempt_sids.len();
    set_setting(app, "loopbackExemptSids", json!(exempt_sids))?;

    Ok(success(json!({
        "apps": apps,
        "isAdmin": true,
        "toolAvailable": tool_available,
        "total": total,
        "exempt": exempt
    })))
}

fn loopback_set(app: &AppHandle, sids: Vec<String>) -> CompatResult {
    if !cfg!(target_os = "windows") {
        set_setting(app, "loopbackExemptSids", json!(sids))?;
        return Ok(success(json!({ "count": 0 })));
    }

    for sid in &sids {
        if !loopback_sid_valid(sid) {
            return Ok(json!({
                "success": false,
                "error": format!("Invalid SID format: {sid}")
            }));
        }
    }

    let sid_list = sids
        .iter()
        .map(|sid| format!("\"{}\"", sid.replace('"', "")))
        .collect::<Vec<_>>()
        .join(",");
    let method_call = format!("$sids = @({sid_list})\n[NetworkIsolationHelper]::SetConfig($sids)");
    let output = match loopback_api_call(&method_call) {
        Ok(output) => output,
        Err(error) => return Ok(json!({ "success": false, "error": error })),
    };
    let result = match serde_json::from_str::<Value>(&output) {
        Ok(result) => result,
        Err(error) => {
            return Ok(json!({
                "success": false,
                "error": format!("解析 Loopback 保存结果失败: {error}")
            }))
        }
    };

    if result
        .get("success")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        set_setting(app, "loopbackExemptSids", json!(sids))?;
    }

    Ok(result)
}

fn loopback_current_exempt_sids(app: &AppHandle) -> Result<Vec<String>, String> {
    let result = loopback_apps(app)?;
    if !result
        .get("success")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Err(result
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("读取 Loopback 状态失败")
            .to_string());
    }
    Ok(result
        .get("apps")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|value| {
            value
                .get("isExempt")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        })
        .filter_map(|value| {
            value
                .get("sid")
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
        .collect())
}

pub(crate) async fn handle_compat_call(
    app: &AppHandle,
    window: &WebviewWindow,
    method: &str,
    args: &[Value],
) -> Option<CompatResult> {
    if !method.starts_with("loopback.")
        && !method.starts_with("loopback:")
        && !matches!(
            method,
            "getPlatform"
                | "loadPage"
                | "navigateTo"
                | "getTheme"
                | "setTheme"
                | "getThemeColor"
                | "setThemeColor"
                | "supportsAdvancedBackdrop"
                | "getAppearanceMode"
                | "setAppearanceMode"
                | "getCustomBackground"
                | "setCustomBackground"
                | "clearCustomBackground"
                | "selectBackgroundImage"
                | "window-minimize"
                | "minimizeWindow"
                | "window-show"
                | "showWindow"
                | "window-hide"
                | "hideWindow"
                | "quitApp"
                | "appQuit"
                | "window-toggle-maximize"
                | "maximizeWindow"
                | "window-close"
                | "closeWindow"
                | "getWindowState"
                | "getIconDataURL"
                | "getSystemProxyStatus"
                | "getProxyStatus"
                | "setAsDefaultProtocolClient"
                | "registerProtocol"
                | "isDefaultProtocolClient"
                | "isProtocolRegistered"
                | "removeAsDefaultProtocolClient"
                | "unregisterProtocol"
                | "setAutoStart"
                | "setAutoLaunch"
                | "getAutoStart"
                | "getAutoLaunchState"
                | "setSilentStart"
                | "getSilentStart"
                | "getMinimizeToTray"
                | "get-minimize-to-tray"
                | "setMinimizeToTray"
                | "set-minimize-to-tray"
                | "getLightweightModeSettings"
                | "setLightweightModeSettings"
                | "enterLightweightMode"
        )
    {
        return None;
    }

    Some(dispatch_compat_call(app, window, method, args).await)
}

async fn dispatch_compat_call(
    app: &AppHandle,
    window: &WebviewWindow,
    method: &str,
    args: &[Value],
) -> CompatResult {
    match method {
        "getPlatform" => Ok(Value::String(electron_platform().to_string())),
        "loadPage" | "navigateTo" => {
            let target = arg_string(args, 0).unwrap_or_default();
            window
                .emit("navigate-to", target.clone())
                .map_err(|err| err.to_string())?;
            Ok(success(json!({ "target": target })))
        }
        "getTheme" => Ok(success(
            json!({ "theme": setting(app, "theme", json!("system"))? }),
        )),
        "setTheme" => {
            let theme = arg_string(args, 0).unwrap_or_else(|| "system".to_string());
            set_setting(app, "theme", json!(theme))?;
            // Electron sets nativeTheme.themeSource here; do the same for DWM.
            apply_native_theme_source(window, &theme);
            let resolved = resolved_theme(window, &theme);
            let _ = window.emit("theme-changed", resolved);
            // Re-apply backdrop so mica/acrylic/tabbed follow the app theme.
            let mode = setting(app, "appearanceMode", json!("dynamic"))?
                .as_str()
                .unwrap_or("dynamic")
                .to_string();
            let _ = apply_appearance_mode_for_app(app, window, &mode);
            Ok(success(json!({ "theme": theme })))
        }
        "getThemeColor" => Ok(success(
            json!({ "color": setting(app, "themeColor", json!("#2563eb"))? }),
        )),
        "setThemeColor" => {
            let color = arg_string(args, 0).unwrap_or_else(|| "#2563eb".to_string());
            set_setting(app, "themeColor", json!(color))?;
            let _ = window.emit("theme-color-changed", color.clone());
            Ok(success(json!({})))
        }
        "supportsAdvancedBackdrop" => Ok(success(json!({
            "supported": cfg!(any(target_os = "windows", target_os = "macos"))
        }))),
        "getAppearanceMode" => Ok(success(json!({
            "mode": setting(app, "appearanceMode", json!("dynamic"))?
        }))),
        "setAppearanceMode" => {
            let mode = arg_string(args, 0).unwrap_or_else(|| "dynamic".to_string());
            if !matches!(mode.as_str(), "acrylic" | "dynamic" | "solid" | "custom") {
                return Ok(json!({
                    "success": false,
                    "error": "Unsupported appearance mode"
                }));
            }

            set_setting(app, "appearanceMode", json!(mode.clone()))?;
            apply_appearance_mode_for_app(app, window, &mode)?;

            if mode == "custom" {
                emit_custom_background(app, window)?;
            } else {
                window
                    .emit("clear-custom-background", json!({}))
                    .map_err(|err| err.to_string())?;
            }

            window
                .emit("appearance-mode-changed", mode.clone())
                .map_err(|err| err.to_string())?;

            Ok(success(json!({ "mode": mode })))
        }
        "getCustomBackground" => Ok(success(json!({
            "config": custom_background_config(app)?
        }))),
        "setCustomBackground" => {
            let config = args.first().cloned().unwrap_or(Value::Null);
            let Some(image_path) = config.get("imagePath").and_then(Value::as_str) else {
                return Ok(json!({
                    "success": false,
                    "error": "Image path cannot be empty"
                }));
            };

            let opacity = clamp_u64(config.get("opacity").and_then(Value::as_u64), 0, 100, 80);
            let blur = clamp_u64(config.get("blur").and_then(Value::as_u64), 0, 100, 10);
            set_setting(
                app,
                "customBackground",
                json!({
                    "imagePath": image_path,
                    "opacity": opacity,
                    "blur": blur
                }),
            )?;

            if setting(app, "appearanceMode", json!("dynamic"))?
                .as_str()
                .unwrap_or("dynamic")
                == "custom"
            {
                emit_custom_background(app, window)?;
            }

            Ok(success(json!({})))
        }
        "clearCustomBackground" => {
            set_setting(app, "customBackground", Value::Null)?;

            if setting(app, "appearanceMode", json!("dynamic"))?
                .as_str()
                .unwrap_or("dynamic")
                == "custom"
            {
                set_setting(app, "appearanceMode", json!("dynamic"))?;
                apply_appearance_mode(window, "dynamic")?;
                window
                    .emit("appearance-mode-changed", "dynamic")
                    .map_err(|err| err.to_string())?;
            }

            window
                .emit("clear-custom-background", json!({}))
                .map_err(|err| err.to_string())?;
            Ok(success(json!({})))
        }
        "selectBackgroundImage" => {
            let path = tauri::async_runtime::spawn_blocking(|| {
                rfd::FileDialog::new()
                    .set_title("Select background image")
                    .add_filter("Image files", &["jpg", "jpeg", "png", "gif", "bmp", "webp"])
                    .pick_file()
            })
            .await
            .map_err(|err| err.to_string())?;

            if let Some(path) = path {
                Ok(success(json!({ "path": path.to_string_lossy() })))
            } else {
                Ok(success(json!({ "canceled": true })))
            }
        }
        "window-minimize" | "minimizeWindow" => {
            window.minimize().map_err(|err| err.to_string())?;
            Ok(success(json!({})))
        }
        "window-show" | "showWindow" => {
            window.show().map_err(|err| err.to_string())?;
            window.set_focus().map_err(|err| err.to_string())?;
            Ok(success(json!({})))
        }
        "window-hide" | "hideWindow" => {
            window.hide().map_err(|err| err.to_string())?;
            Ok(success(json!({})))
        }
        "quitApp" | "appQuit" => {
            app.exit(0);
            Ok(success(json!({})))
        }
        "window-toggle-maximize" | "maximizeWindow" => {
            let result = if window.is_maximized().map_err(|err| err.to_string())? {
                window.unmaximize().map_err(|err| err.to_string())?;
                window_state_payload(window)
            } else {
                window.maximize().map_err(|err| err.to_string())?;
                window_state_payload(window)
            };
            emit_window_state(window);
            Ok(result)
        }
        "window-close" | "closeWindow" => {
            let minimize_to_tray = setting(app, "minimizeToTray", json!(true))?
                .as_bool()
                .unwrap_or(true);
            if minimize_to_tray {
                window.hide().map_err(|err| err.to_string())?;
            } else {
                window.close().map_err(|err| err.to_string())?;
            }
            Ok(success(json!({})))
        }
        "getWindowState" => Ok(window_state_payload(window)),
        "getIconDataURL" => {
            let Some(path) = arg_string(args, 0) else {
                return Ok(Value::Null);
            };
            Ok(process_icon_data_url(&path)?
                .map(Value::String)
                .unwrap_or(Value::Null))
        }
        "getSystemProxyStatus" => Ok(system_proxy_status(app)),
        "getProxyStatus" => {
            let status = system_proxy_status(app);
            let enabled = status
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if setting(app, "systemProxyEnabled", json!(false))?
                .as_bool()
                .unwrap_or(false)
                != enabled
            {
                set_setting(app, "systemProxyEnabled", json!(enabled))?;
            }
            Ok(Value::Bool(enabled))
        }
        "setAsDefaultProtocolClient" | "registerProtocol" => {
            let protocol = arg_string(args, 0)
                .and_then(|value| normalized_protocol_scheme(&value))
                .ok_or_else(|| "missing protocol scheme".to_string())?;
            match app.deep_link().register(&protocol) {
                Ok(_) => Ok(success(json!({ "protocol": protocol, "registered": true }))),
                Err(error) => Ok(json!({
                    "success": false,
                    "protocol": protocol,
                    "registered": false,
                    "error": error.to_string()
                })),
            }
        }
        "isDefaultProtocolClient" | "isProtocolRegistered" => {
            let protocol = arg_string(args, 0)
                .and_then(|value| normalized_protocol_scheme(&value))
                .ok_or_else(|| "missing protocol scheme".to_string())?;
            match app.deep_link().is_registered(&protocol) {
                Ok(registered) => Ok(success(json!({
                    "protocol": protocol,
                    "registered": registered
                }))),
                Err(error) => Ok(json!({
                    "success": false,
                    "protocol": protocol,
                    "registered": false,
                    "error": error.to_string()
                })),
            }
        }
        "removeAsDefaultProtocolClient" | "unregisterProtocol" => {
            let protocol = arg_string(args, 0)
                .and_then(|value| normalized_protocol_scheme(&value))
                .ok_or_else(|| "missing protocol scheme".to_string())?;
            match app.deep_link().unregister(&protocol) {
                Ok(_) => Ok(success(
                    json!({ "protocol": protocol, "registered": false }),
                )),
                Err(error) => Ok(json!({
                    "success": false,
                    "protocol": protocol,
                    "error": error.to_string()
                })),
            }
        }
        "setAutoStart" | "setAutoLaunch" => {
            let enabled = arg_bool(args, 0).unwrap_or(false);
            set_autostart(app, enabled)?;
            Ok(Value::Bool(enabled))
        }
        "getAutoStart" | "getAutoLaunchState" => Ok(Value::Bool(autostart_enabled(app))),
        "setSilentStart" => {
            set_setting(
                app,
                "silentStart",
                json!(arg_bool(args, 0).unwrap_or(false)),
            )?;
            Ok(success(json!({})))
        }
        "getSilentStart" => Ok(success(json!({
            "silentStart": setting(app, "silentStart", json!(false))?
        }))),
        "getMinimizeToTray" | "get-minimize-to-tray" => Ok(Value::Bool(
            setting(app, "minimizeToTray", json!(true))?
                .as_bool()
                .unwrap_or(true),
        )),
        "setMinimizeToTray" | "set-minimize-to-tray" => {
            let enabled = arg_bool(args, 0).unwrap_or(true);
            set_setting(app, "minimizeToTray", json!(enabled))?;
            Ok(Value::Bool(enabled))
        }
        "getLightweightModeSettings" => Ok(success(json!({
            "settings": {
                "autoEnter": setting(app, "autoEnterLightweightMode", json!(false))?
                    .as_bool()
                    .unwrap_or(false),
                "delay": setting(app, "lightweightModeDelay", json!(60))?
                    .as_u64()
                    .unwrap_or(60)
                    .clamp(10, 600),
                "active": setting(app, "lightweightModeActive", json!(false))?
                    .as_bool()
                    .unwrap_or(false)
            }
        }))),
        "setLightweightModeSettings" => {
            let settings = args.first().cloned().unwrap_or_else(|| json!({}));
            if let Some(auto_enter) = settings.get("autoEnter").and_then(Value::as_bool) {
                set_setting(app, "autoEnterLightweightMode", json!(auto_enter))?;
            }
            if let Some(delay) = settings.get("delay").and_then(Value::as_u64) {
                set_setting(app, "lightweightModeDelay", json!(delay.clamp(10, 600)))?;
            }
            Ok(success(json!({})))
        }
        "enterLightweightMode" => enter_lightweight_mode(app),
        "loopback.getApps" | "loopback:get-apps" => loopback_apps(app),
        "loopback.saveConfig" | "loopback:save-config" => {
            let sids = args
                .first()
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .filter_map(|value| value.as_str().map(ToString::to_string))
                .collect();
            loopback_set(app, sids)
        }
        "loopback.addExemption" | "loopback:add-exemption" => {
            let mut sids = loopback_current_exempt_sids(app)?;
            if let Some(sid) = arg_string(args, 0) {
                if !sids.iter().any(|value| value.eq_ignore_ascii_case(&sid)) {
                    sids.push(sid);
                }
            }
            loopback_set(app, sids)
        }
        "loopback.removeExemption" | "loopback:remove-exemption" => {
            let sid = arg_string(args, 0).unwrap_or_default();
            let sids = loopback_current_exempt_sids(app)?
                .into_iter()
                .filter(|value| !value.eq_ignore_ascii_case(&sid))
                .collect();
            loopback_set(app, sids)
        }
        "loopback.openTool"
        | "loopback:open-tool"
        | "loopback.launchEnableLoopback"
        | "openEnableLoopback" => open_enable_loopback_tool(app),
        "loopback.toolAvailable" | "loopback:tool-available" => Ok(success(json!({
            "available": find_enable_loopback_tool(app).is_some()
        }))),
        _ => Err(format!("Unsupported loopback method: {method}")),
    }
}
