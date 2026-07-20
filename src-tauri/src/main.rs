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
mod fetch;
mod mihomo_controller;
mod mihomo_ipc;
mod mihomo_local_socket;
mod mihomo_transport;
mod network_tools;
mod open_commands;
mod overrides;
mod platform;
mod profiles;
mod proxy_icons;
mod resources;
mod runtime;
mod runtime_commands;
mod runtime_config;
mod settings_commands;
mod state;
mod storage;
mod subscription_commands;
mod telemetry;
mod tray;
mod tun_service;
#[cfg(windows)]
mod win_loopback;
#[cfg(windows)]
mod win_sysproxy;

fn main() {
    app::run();
}
