//! Native Windows system-proxy control.
//!
//! Critical path is **not** registry-only. Setting must go through WinINet:
//! 1. `InternetSetOptionW(INTERNET_OPTION_PER_CONNECTION_OPTION, …)`
//! 2. `InternetSetOptionW(INTERNET_OPTION_PROXY_SETTINGS_CHANGED, …)`
//! 3. `InternetSetOptionW(INTERNET_OPTION_REFRESH, …)`
//!
//! Registry is only used for querying current status.

#![cfg(windows)]

use std::ffi::OsStr;
use std::mem::{size_of, ManuallyDrop};
use std::os::windows::ffi::OsStrExt;
use std::ptr;

type BOOL = i32;
type DWORD = u32;
type HKEY = isize;
type LSTATUS = i32;

const HKEY_CURRENT_USER: HKEY = 0x8000_0001u32 as HKEY;
const KEY_READ: DWORD = 0x20019;
const ERROR_SUCCESS: LSTATUS = 0;
const ERROR_MORE_DATA: LSTATUS = 234;

// WinINet option codes (wininet.h)
const INTERNET_OPTION_REFRESH: DWORD = 37;
const INTERNET_OPTION_PER_CONNECTION_OPTION: DWORD = 75;
const INTERNET_OPTION_PROXY_SETTINGS_CHANGED: DWORD = 95;

// INTERNET_PER_CONN_OPTION dwOption values
const INTERNET_PER_CONN_FLAGS: DWORD = 1;
const INTERNET_PER_CONN_PROXY_SERVER: DWORD = 2;
const INTERNET_PER_CONN_PROXY_BYPASS: DWORD = 3;
const INTERNET_PER_CONN_AUTOCONFIG_URL: DWORD = 4;

// Proxy type flags for INTERNET_PER_CONN_FLAGS
const PROXY_TYPE_DIRECT: DWORD = 0x0000_0001;
const PROXY_TYPE_PROXY: DWORD = 0x0000_0002;
const PROXY_TYPE_AUTO_PROXY_URL: DWORD = 0x0000_0004;
const PROXY_TYPE_AUTO_DETECT: DWORD = 0x0000_0008;

const INTERNET_SETTINGS_SUBKEY: &str =
    r"Software\Microsoft\Windows\CurrentVersion\Internet Settings";

pub const DEFAULT_BYPASS: &str = "localhost;127.*;192.168.*;10.*;172.16.*;172.17.*;172.18.*;172.19.*;172.20.*;172.21.*;172.22.*;172.23.*;172.24.*;172.25.*;172.26.*;172.27.*;172.28.*;172.29.*;172.30.*;172.31.*;<local>";

#[repr(C)]
struct InternetPerConnOptionW {
    dw_option: DWORD,
    value: InternetPerConnOptionValue,
}

#[repr(C)]
union InternetPerConnOptionValue {
    dw_value: DWORD,
    psz_value: *mut u16,
    ft_value: u64,
}

#[repr(C)]
struct InternetPerConnOptionListW {
    dw_size: DWORD,
    psz_connection: *mut u16,
    dw_option_count: DWORD,
    dw_option_error: DWORD,
    p_options: *mut InternetPerConnOptionW,
}

#[link(name = "wininet")]
extern "system" {
    fn InternetSetOptionW(
        h_internet: *mut core::ffi::c_void,
        dw_option: DWORD,
        lp_buffer: *mut core::ffi::c_void,
        dw_buffer_length: DWORD,
    ) -> BOOL;
}

#[link(name = "advapi32")]
extern "system" {
    fn RegOpenKeyExW(
        hkey: HKEY,
        lp_sub_key: *const u16,
        ul_options: DWORD,
        sam_desired: DWORD,
        phk_result: *mut HKEY,
    ) -> LSTATUS;

    fn RegQueryValueExW(
        hkey: HKEY,
        lp_value_name: *const u16,
        lp_reserved: *mut DWORD,
        lp_type: *mut DWORD,
        lp_data: *mut u8,
        lpcb_data: *mut DWORD,
    ) -> LSTATUS;

    fn RegCloseKey(hkey: HKEY) -> LSTATUS;
}

fn to_wide_null(value: &str) -> Vec<u16> {
    OsStr::new(value)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

/// Apply per-connection options, then propagate and refresh the system state.
fn apply(options: &InternetPerConnOptionListW) -> Result<(), String> {
    unsafe {
        let opts = options as *const InternetPerConnOptionListW as *mut core::ffi::c_void;
        let ok = InternetSetOptionW(
            ptr::null_mut(),
            INTERNET_OPTION_PER_CONNECTION_OPTION,
            opts,
            size_of::<InternetPerConnOptionListW>() as u32,
        );
        if ok == 0 {
            return Err("INTERNET_OPTION_PER_CONNECTION_OPTION 失败".to_string());
        }

        let ok = InternetSetOptionW(
            ptr::null_mut(),
            INTERNET_OPTION_PROXY_SETTINGS_CHANGED,
            ptr::null_mut(),
            0,
        );
        if ok == 0 {
            return Err("INTERNET_OPTION_PROXY_SETTINGS_CHANGED 失败".to_string());
        }

        let ok = InternetSetOptionW(ptr::null_mut(), INTERNET_OPTION_REFRESH, ptr::null_mut(), 0);
        if ok == 0 {
            return Err("INTERNET_OPTION_REFRESH 失败".to_string());
        }
    }
    Ok(())
}

/// Enable global/manual proxy.
pub fn set_global_proxy(server: &str, bypass: &str) -> Result<(), String> {
    // Keep wide strings alive until after apply().
    let mut server_w = ManuallyDrop::new(to_wide_null(server));
    let mut bypass_w = ManuallyDrop::new(to_wide_null(bypass));

    let mut options = [
        InternetPerConnOptionW {
            dw_option: INTERNET_PER_CONN_FLAGS,
            value: InternetPerConnOptionValue {
                dw_value: PROXY_TYPE_PROXY | PROXY_TYPE_DIRECT,
            },
        },
        InternetPerConnOptionW {
            dw_option: INTERNET_PER_CONN_PROXY_SERVER,
            value: InternetPerConnOptionValue {
                psz_value: server_w.as_mut_ptr(),
            },
        },
        InternetPerConnOptionW {
            dw_option: INTERNET_PER_CONN_PROXY_BYPASS,
            value: InternetPerConnOptionValue {
                psz_value: bypass_w.as_mut_ptr(),
            },
        },
    ];

    let list = InternetPerConnOptionListW {
        dw_size: size_of::<InternetPerConnOptionListW>() as DWORD,
        psz_connection: ptr::null_mut(), // NULL = LAN / default connection
        dw_option_count: options.len() as DWORD,
        dw_option_error: 0,
        p_options: options.as_mut_ptr(),
    };

    let result = apply(&list);

    unsafe {
        ManuallyDrop::drop(&mut server_w);
        ManuallyDrop::drop(&mut bypass_w);
    }
    result
}

/// Disable system proxy.
pub fn disable_proxy() -> Result<(), String> {
    let mut options = [InternetPerConnOptionW {
        dw_option: INTERNET_PER_CONN_FLAGS,
        value: InternetPerConnOptionValue {
            dw_value: PROXY_TYPE_DIRECT,
        },
    }];

    let list = InternetPerConnOptionListW {
        dw_size: size_of::<InternetPerConnOptionListW>() as DWORD,
        psz_connection: ptr::null_mut(),
        dw_option_count: 1,
        dw_option_error: 0,
        p_options: options.as_mut_ptr(),
    };

    apply(&list)
}

/// Optional PAC mode.
#[allow(dead_code)]
pub fn set_pac_proxy(pac_url: &str) -> Result<(), String> {
    let mut pac_w = ManuallyDrop::new(to_wide_null(pac_url));

    let mut options = [
        InternetPerConnOptionW {
            dw_option: INTERNET_PER_CONN_FLAGS,
            value: InternetPerConnOptionValue {
                dw_value: PROXY_TYPE_AUTO_DETECT | PROXY_TYPE_AUTO_PROXY_URL | PROXY_TYPE_DIRECT,
            },
        },
        InternetPerConnOptionW {
            dw_option: INTERNET_PER_CONN_AUTOCONFIG_URL,
            value: InternetPerConnOptionValue {
                psz_value: pac_w.as_mut_ptr(),
            },
        },
    ];

    let list = InternetPerConnOptionListW {
        dw_size: size_of::<InternetPerConnOptionListW>() as DWORD,
        psz_connection: ptr::null_mut(),
        dw_option_count: options.len() as DWORD,
        dw_option_error: 0,
        p_options: options.as_mut_ptr(),
    };

    let result = apply(&list);
    unsafe {
        ManuallyDrop::drop(&mut pac_w);
    }
    result
}

#[derive(Debug, Clone, Default)]
pub struct ProxyQuery {
    pub enabled: bool,
    pub server: Option<String>,
    pub bypass: Option<String>,
    pub pac_url: Option<String>,
}

fn open_internet_settings(access: DWORD) -> Result<HKEY, String> {
    let subkey = to_wide_null(INTERNET_SETTINGS_SUBKEY);
    let mut hkey: HKEY = 0;
    let status = unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, subkey.as_ptr(), 0, access, &mut hkey) };
    if status != ERROR_SUCCESS {
        return Err(format!(
            "无法打开注册表键 Internet Settings: 错误码 {status}"
        ));
    }
    Ok(hkey)
}

fn close_key(hkey: HKEY) {
    unsafe {
        let _ = RegCloseKey(hkey);
    }
}

fn get_reg_dword(hkey: HKEY, name: &str) -> Result<u32, String> {
    let name_w = to_wide_null(name);
    let mut value: u32 = 0;
    let mut size: DWORD = 4;
    let mut reg_type: DWORD = 0;
    let status = unsafe {
        RegQueryValueExW(
            hkey,
            name_w.as_ptr(),
            ptr::null_mut(),
            &mut reg_type,
            (&mut value as *mut u32).cast::<u8>(),
            &mut size,
        )
    };
    if status != ERROR_SUCCESS {
        return Err(format!("获取 {name} 失败: 错误码 {status}"));
    }
    Ok(value)
}

fn get_reg_string(hkey: HKEY, name: &str) -> Result<String, String> {
    let name_w = to_wide_null(name);
    let mut size: DWORD = 0;
    let mut reg_type: DWORD = 0;
    let status = unsafe {
        RegQueryValueExW(
            hkey,
            name_w.as_ptr(),
            ptr::null_mut(),
            &mut reg_type,
            ptr::null_mut(),
            &mut size,
        )
    };
    if status != ERROR_SUCCESS && status != ERROR_MORE_DATA {
        return Err(format!("获取 {name} 大小失败: 错误码 {status}"));
    }
    if size == 0 {
        return Ok(String::new());
    }

    let mut buf = vec![0u16; (size as usize / 2).saturating_add(1)];
    let mut size2 = size;
    let status = unsafe {
        RegQueryValueExW(
            hkey,
            name_w.as_ptr(),
            ptr::null_mut(),
            &mut reg_type,
            buf.as_mut_ptr().cast::<u8>(),
            &mut size2,
        )
    };
    if status != ERROR_SUCCESS {
        return Err(format!("获取 {name} 失败: 错误码 {status}"));
    }
    Ok(String::from_utf16_lossy(
        &buf[..buf.iter().position(|&c| c == 0).unwrap_or(buf.len())],
    ))
}

/// Query the current proxy state from the registry.
pub fn query_proxy() -> Result<ProxyQuery, String> {
    let hkey = open_internet_settings(KEY_READ)?;
    let enabled = get_reg_dword(hkey, "ProxyEnable").unwrap_or(0) == 1;
    let server = get_reg_string(hkey, "ProxyServer")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let bypass = get_reg_string(hkey, "ProxyOverride")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let pac_url = get_reg_string(hkey, "AutoConfigURL")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    close_key(hkey);
    Ok(ProxyQuery {
        enabled,
        server,
        bypass,
        pac_url,
    })
}

/// High-level enable/disable used by the app.
///
/// Clear stale PAC and per-connection flags before enabling a manual proxy.
pub fn set_proxy(enabled: bool, host: &str, port: u16, bypass: Option<&str>) -> Result<(), String> {
    if enabled {
        if host.trim().is_empty() || port == 0 {
            return Err("系统代理 host/port 无效".to_string());
        }
        // Clear previous state before applying the new manual proxy.
        let _ = disable_proxy();
        let server = format!("{host}:{port}");
        set_global_proxy(server.as_str(), bypass.unwrap_or(DEFAULT_BYPASS))
    } else {
        disable_proxy()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_proxy_reads_without_error() {
        let query = query_proxy().expect("query_proxy");
        if let Some(server) = query.server.as_deref() {
            assert!(!server.trim().is_empty());
        }
    }

    #[test]
    #[ignore = "changes the live system proxy; run explicitly in an isolated Windows environment"]
    fn set_and_disable_roundtrip_restores_previous_state() {
        let before = query_proxy().expect("query before");
        set_proxy(true, "127.0.0.1", 17890, Some(DEFAULT_BYPASS)).expect("enable test proxy");
        let mid = query_proxy().expect("query mid");
        assert!(mid.enabled, "proxy should be enabled after set");
        assert_eq!(mid.server.as_deref(), Some("127.0.0.1:17890"));

        if before.enabled {
            if let Some(server) = before.server.as_deref() {
                let bypass = before.bypass.as_deref().unwrap_or(DEFAULT_BYPASS);
                set_global_proxy(server, bypass).expect("restore previous global");
            } else {
                disable_proxy().expect("disable after empty server");
            }
        } else {
            disable_proxy().expect("restore disabled");
        }
    }
}
