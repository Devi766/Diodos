#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ai_proxy;
mod app;
mod backup;
mod compat;
mod config_commands;
mod converter;
mod core;
mod core_commands;
mod core_lifecycle_commands;
mod dashboard_images;
mod dns_lookup;
mod fetch;
mod lan_backup;
mod mihomo_controller;
mod mihomo_ipc;
mod mihomo_local_socket;
mod mihomo_transport;
mod network_tools;
mod open_commands;
mod overrides;
mod platform;
mod profiles;
mod process_icons;
mod proxy_icons;
mod proxy_entry;
mod resources;
mod route_trace;
mod runtime;
mod runtime_commands;
mod runtime_config;
mod settings_commands;
mod state;
mod storage;
mod subscription_commands;
mod subscription_content;
mod subscription_download;
mod telemetry;
mod tcp_table;
mod tray;
mod tun_service;
#[cfg(windows)]
mod win_loopback;
#[cfg(windows)]
mod win_sysproxy;

fn main() {
    // Elevated helper path for UWP loopback writes (UAC). Must run before UI boot.
    #[cfg(windows)]
    {
        let args = std::env::args().collect::<Vec<_>>();
        if win_loopback::maybe_run_elevated_cli(&args) {
            return;
        }

        // Never host WebView2 inside LocalSystem/LocalService/NetworkService.
        // Privileged work belongs in the narrow helper processes above; a
        // service-hosted WebView is both unsafe and unable to use systemprofile's
        // LocalAppData with its normal sandbox permissions.
        if tun_service::windows_desktop_process_is_service_account() {
            let _ = rfd::MessageDialog::new()
                .set_title("FlyClash 无法以系统服务账户启动")
                .set_description(
                    "请从当前登录用户的开始菜单或桌面启动 FlyClash。\n\nTUN 管理员权限将由 FlyClash Helper Service 单独处理，桌面界面不能以 SYSTEM、LocalService 或 NetworkService 身份运行。",
                )
                .set_level(rfd::MessageLevel::Error)
                .show();
            return;
        }
    }

    app::run();
}
