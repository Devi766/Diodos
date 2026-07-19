//! Native Windows system-proxy control.
//!
//! Port of `native/sysproxy/main.go`:
//! - write HKCU Internet Settings via Advapi32
//! - notify WinINet with InternetSetOption(SETTINGS_CHANGED/REFRESH)
//!
//! No external `sysproxy.exe` / PowerShell / `reg.exe` process is required.

#![cfg(windows)]

use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::ptr;

type BOOL = i32;
type DWORD = u32;
type HKEY = isize;
type LSTATUS = i32;

const HKEY_CURRENT_USER: HKEY = 0x8000_0001u32 as HKEY;
const KEY_ALL_ACCESS: DWORD = 0xF003F;
const KEY_READ: DWORD = 0x20019;
const REG_SZ: DWORD = 1;
const REG_DWORD: DWORD = 4;
const ERROR_SUCCESS: LSTATUS = 0;
const ERROR_FILE_NOT_FOUND: LSTATUS = 2;
const ERROR_MORE_DATA: LSTATUS = 234;

const INTERNET_OPTION_SETTINGS_CHANGED: DWORD = 39;
const INTERNET_OPTION_REFRESH: DWORD = 37;

const INTERNET_SETTINGS_SUBKEY: &str =
    r"Software\Microsoft\Windows\CurrentVersion\Internet Settings";

pub const DEFAULT_BYPASS: &str = "localhost;127.*;192.168.*;10.*;172.16.*;172.17.*;172.18.*;172.19.*;172.20.*;172.21.*;172.22.*;172.23.*;172.24.*;172.25.*;172.26.*;172.27.*;172.28.*;172.29.*;172.30.*;172.31.*;<local>";

#[link(name = "advapi32")]
extern "system" {
    fn RegOpenKeyExW(
        hkey: HKEY,
        lp_sub_key: *const u16,
        ul_options: DWORD,
        sam_desired: DWORD,
        phk_result: *mut HKEY,
    ) -> LSTATUS;

    fn RegSetValueExW(
        hkey: HKEY,
        lp_value_name: *const u16,
        reserved: DWORD,
        dw_type: DWORD,
        lp_data: *const u8,
        cb_data: DWORD,
    ) -> LSTATUS;

    fn RegDeleteValueW(hkey: HKEY, lp_value_name: *const u16) -> LSTATUS;

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

#[link(name = "wininet")]
extern "system" {
    fn InternetSetOptionW(
        h_internet: *mut core::ffi::c_void,
        dw_option: DWORD,
        lp_buffer: *mut core::ffi::c_void,
        dw_buffer_length: DWORD,
    ) -> BOOL;
}

fn to_wide_null(value: &str) -> Vec<u16> {
    OsStr::new(value)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

fn open_internet_settings(access: DWORD) -> Result<HKEY, String> {
    let subkey = to_wide_null(INTERNET_SETTINGS_SUBKEY);
    let mut hkey: HKEY = 0;
    let status = unsafe {
        RegOpenKeyExW(
            HKEY_CURRENT_USER,
            subkey.as_ptr(),
            0,
            access,
            &mut hkey,
        )
    };
    if status != ERROR_SUCCESS {
        return Err(format!("无法打开注册表键 Internet Settings: 错误码 {status}"));
    }
    Ok(hkey)
}

fn close_key(hkey: HKEY) {
    unsafe {
        let _ = RegCloseKey(hkey);
    }
}

fn set_reg_dword(hkey: HKEY, name: &str, value: u32) -> Result<(), String> {
    let name_w = to_wide_null(name);
    let mut data = value;
    let status = unsafe {
        RegSetValueExW(
            hkey,
            name_w.as_ptr(),
            0,
            REG_DWORD,
            (&mut data as *mut u32).cast::<u8>(),
            4,
        )
    };
    if status != ERROR_SUCCESS {
        return Err(format!("设置 {name} 失败: 错误码 {status}"));
    }
    Ok(())
}

fn set_reg_string(hkey: HKEY, name: &str, value: &str) -> Result<(), String> {
    let name_w = to_wide_null(name);
    // REG_SZ payload is UTF-16 including trailing NUL.
    let mut data: Vec<u16> = OsStr::new(value).encode_wide().chain(std::iter::once(0)).collect();
    let bytes = (data.len() * 2) as DWORD;
    let status = unsafe {
        RegSetValueExW(
            hkey,
            name_w.as_ptr(),
            0,
            REG_SZ,
            data.as_mut_ptr().cast::<u8>(),
            bytes,
        )
    };
    if status != ERROR_SUCCESS {
        return Err(format!("设置 {name} 失败: 错误码 {status}"));
    }
    Ok(())
}

fn delete_reg_value(hkey: HKEY, name: &str) -> Result<(), String> {
    let name_w = to_wide_null(name);
    let status = unsafe { RegDeleteValueW(hkey, name_w.as_ptr()) };
    if status != ERROR_SUCCESS && status != ERROR_FILE_NOT_FOUND {
        return Err(format!("删除 {name} 失败: 错误码 {status}"));
    }
    Ok(())
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

/// Same as Go `refreshProxySettings`: notify WinINet that settings changed.
pub fn refresh_proxy_settings() -> Result<(), String> {
    let ok_changed = unsafe {
        InternetSetOptionW(
            ptr::null_mut(),
            INTERNET_OPTION_SETTINGS_CHANGED,
            ptr::null_mut(),
            0,
        )
    };
    if ok_changed == 0 {
        return Err("INTERNET_OPTION_SETTINGS_CHANGED 失败".to_string());
    }
    let ok_refresh = unsafe {
        InternetSetOptionW(ptr::null_mut(), INTERNET_OPTION_REFRESH, ptr::null_mut(), 0)
    };
    if ok_refresh == 0 {
        return Err("INTERNET_OPTION_REFRESH 失败".to_string());
    }
    Ok(())
}

/// Enable global proxy: ProxyEnable=1, ProxyServer=host:port, ProxyOverride=bypass,
/// clear AutoConfigURL, then refresh WinINet.
pub fn set_global_proxy(server: &str, bypass: &str) -> Result<(), String> {
    let hkey = open_internet_settings(KEY_ALL_ACCESS)?;
    let result = (|| {
        set_reg_dword(hkey, "ProxyEnable", 1)?;
        set_reg_string(hkey, "ProxyServer", server)?;
        set_reg_string(hkey, "ProxyOverride", bypass)?;
        let _ = delete_reg_value(hkey, "AutoConfigURL");
        refresh_proxy_settings()?;
        Ok(())
    })();
    close_key(hkey);
    result
}

/// Disable manual proxy and clear PAC URL, then refresh.
pub fn disable_proxy() -> Result<(), String> {
    let hkey = open_internet_settings(KEY_ALL_ACCESS)?;
    let result = (|| {
        set_reg_dword(hkey, "ProxyEnable", 0)?;
        let _ = delete_reg_value(hkey, "AutoConfigURL");
        refresh_proxy_settings()?;
        Ok(())
    })();
    close_key(hkey);
    result
}

/// Optional PAC mode (kept for parity with native/sysproxy).
#[allow(dead_code)]
pub fn set_pac_proxy(pac_url: &str) -> Result<(), String> {
    let hkey = open_internet_settings(KEY_ALL_ACCESS)?;
    let result = (|| {
        set_reg_dword(hkey, "ProxyEnable", 0)?;
        set_reg_string(hkey, "AutoConfigURL", pac_url)?;
        refresh_proxy_settings()?;
        Ok(())
    })();
    close_key(hkey);
    result
}

#[derive(Debug, Clone, Default)]
pub struct ProxyQuery {
    pub enabled: bool,
    pub server: Option<String>,
    pub bypass: Option<String>,
    pub pac_url: Option<String>,
}

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
pub fn set_proxy(enabled: bool, host: &str, port: u16, bypass: Option<&str>) -> Result<(), String> {
    if enabled {
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
        // Should not panic / fail to open the key on a normal Windows session.
        let query = query_proxy().expect("query_proxy");
        // enabled may be true or false depending on user state; just ensure shape is valid.
        if let Some(server) = query.server.as_deref() {
            assert!(!server.trim().is_empty());
        }
    }

    #[test]
    fn set_and_disable_roundtrip_restores_previous_state() {
        let before = query_proxy().expect("query before");
        // Apply a known server, then restore.
        set_proxy(true, "127.0.0.1", 17890, Some(DEFAULT_BYPASS)).expect("enable test proxy");
        let mid = query_proxy().expect("query mid");
        assert!(mid.enabled, "proxy should be enabled after set");
        assert_eq!(mid.server.as_deref(), Some("127.0.0.1:17890"));

        // Restore previous state as faithfully as possible.
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
