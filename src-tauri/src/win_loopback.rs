#![cfg(windows)]

use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::ptr;
use std::sync::OnceLock;

use serde_json::{json, Value};

type BOOL = i32;
type DWORD = u32;
type HRESULT = i32;
type HANDLE = isize;
type HMODULE = isize;
type PWSTR = *mut u16;
type PCWSTR = *const u16;
type PSID = *mut core::ffi::c_void;

const ERROR_SUCCESS: DWORD = 0;

#[repr(C)]
struct SidAndAttributes {
    sid: PSID,
    attributes: DWORD,
}

#[repr(C)]
struct InetFirewallAcCapabilities {
    count: DWORD,
    capabilities: *mut SidAndAttributes,
}

#[repr(C)]
struct InetFirewallAcBinaries {
    count: DWORD,
    binaries: *mut PWSTR,
}

#[repr(C)]
struct InetFirewallAppContainer {
    app_container_sid: PSID,
    user_sid: PSID,
    app_container_name: PWSTR,
    display_name: PWSTR,
    description: PWSTR,
    capabilities: InetFirewallAcCapabilities,
    binaries: InetFirewallAcBinaries,
    working_directory: PWSTR,
    package_full_name: PWSTR,
}

type FnNetworkIsolationEnumAppContainers = unsafe extern "system" fn(
    flags: DWORD,
    pdw_num_public_app_cs: *mut DWORD,
    pp_public_app_cs: *mut *mut InetFirewallAppContainer,
) -> DWORD;
type FnNetworkIsolationGetAppContainerConfig = unsafe extern "system" fn(
    pdw_num_public_app_cs: *mut DWORD,
    app_container_sids: *mut *mut SidAndAttributes,
) -> DWORD;
type FnNetworkIsolationSetAppContainerConfig = unsafe extern "system" fn(
    dw_num_public_app_cs: DWORD,
    app_container_sids: *const SidAndAttributes,
) -> DWORD;
type FnNetworkIsolationFreeAppContainers =
    unsafe extern "system" fn(p_public_app_cs: *mut InetFirewallAppContainer);

#[link(name = "advapi32")]
extern "system" {
    fn ConvertSidToStringSidW(sid: PSID, string_sid: *mut PWSTR) -> BOOL;
    fn ConvertStringSidToSidW(string_sid: PCWSTR, sid: *mut PSID) -> BOOL;
}

#[link(name = "kernel32")]
extern "system" {
    fn LocalFree(h_mem: HANDLE) -> HANDLE;
    fn GetProcessHeap() -> HANDLE;
    fn HeapFree(h_heap: HANDLE, dw_flags: DWORD, lp_mem: *mut core::ffi::c_void) -> BOOL;
    fn LoadLibraryW(lp_lib_file_name: PCWSTR) -> HMODULE;
    fn GetProcAddress(h_module: HMODULE, lp_proc_name: *const u8) -> *const core::ffi::c_void;
}

#[link(name = "shlwapi")]
extern "system" {
    fn SHLoadIndirectString(
        psz_source: PCWSTR,
        psz_out_buf: PWSTR,
        cch_out_buf: u32,
        ppv_reserved: *mut core::ffi::c_void,
    ) -> HRESULT;
}

struct FirewallApi {
    enum_app_containers: FnNetworkIsolationEnumAppContainers,
    get_app_container_config: FnNetworkIsolationGetAppContainerConfig,
    set_app_container_config: FnNetworkIsolationSetAppContainerConfig,
    free_app_containers: FnNetworkIsolationFreeAppContainers,
}

fn to_wide_null(value: &str) -> Vec<u16> {
    OsStr::new(value)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

fn load_firewall_api() -> Result<&'static FirewallApi, String> {
    static API: OnceLock<Result<FirewallApi, String>> = OnceLock::new();
    API.get_or_init(|| {
        unsafe {
            let lib_name = to_wide_null("FirewallAPI.dll");
            let module = LoadLibraryW(lib_name.as_ptr());
            if module == 0 {
                return Err("加载 FirewallAPI.dll 失败".to_string());
            }

            let load = |name: &[u8]| -> Result<*const core::ffi::c_void, String> {
                let proc = GetProcAddress(module, name.as_ptr());
                if proc.is_null() {
                    Err(format!(
                        "FirewallAPI 缺少导出: {}",
                        String::from_utf8_lossy(&name[..name.len().saturating_sub(1)])
                    ))
                } else {
                    Ok(proc)
                }
            };

            let enum_app_containers = load(b"NetworkIsolationEnumAppContainers\0")?;
            let get_app_container_config = load(b"NetworkIsolationGetAppContainerConfig\0")?;
            let set_app_container_config = load(b"NetworkIsolationSetAppContainerConfig\0")?;
            let free_app_containers = load(b"NetworkIsolationFreeAppContainers\0")?;

            Ok(FirewallApi {
                enum_app_containers: std::mem::transmute(enum_app_containers),
                get_app_container_config: std::mem::transmute(get_app_container_config),
                set_app_container_config: std::mem::transmute(set_app_container_config),
                free_app_containers: std::mem::transmute(free_app_containers),
            })
        }
    })
    .as_ref()
    .map_err(|error| error.clone())
}

fn wide_to_string(ptr: PWSTR) -> String {
    if ptr.is_null() {
        return String::new();
    }
    unsafe {
        let mut len = 0usize;
        while *ptr.add(len) != 0 {
            len += 1;
        }
        String::from_utf16_lossy(std::slice::from_raw_parts(ptr, len))
    }
}

fn sid_to_string(sid: PSID) -> Option<String> {
    if sid.is_null() {
        return None;
    }
    unsafe {
        let mut string_sid: PWSTR = ptr::null_mut();
        if ConvertSidToStringSidW(sid, &mut string_sid) == 0 || string_sid.is_null() {
            return None;
        }
        let value = wide_to_string(string_sid);
        let _ = LocalFree(string_sid as HANDLE);
        if value.is_empty() {
            None
        } else {
            Some(value)
        }
    }
}

fn resolve_display_name(raw: &str, fallback: &str) -> String {
    if raw.is_empty() {
        return fallback.to_string();
    }
    if !raw.starts_with('@') {
        return raw.to_string();
    }

    let source = to_wide_null(raw);
    let mut out = vec![0u16; 1024];
    let hr = unsafe {
        SHLoadIndirectString(
            source.as_ptr(),
            out.as_mut_ptr(),
            out.len() as u32,
            ptr::null_mut(),
        )
    };
    if hr == 0 {
        let end = out.iter().position(|&c| c == 0).unwrap_or(out.len());
        if end > 0 {
            return String::from_utf16_lossy(&out[..end]);
        }
    }
    if fallback.is_empty() {
        raw.to_string()
    } else {
        fallback.to_string()
    }
}

fn extract_package_family_name(package_full_name: &str) -> Option<String> {
    if package_full_name.is_empty() {
        return None;
    }
    let parts: Vec<&str> = package_full_name.split('_').collect();
    if parts.len() >= 5 {
        Some(format!("{}_{}", parts[0], parts[parts.len() - 1]))
    } else {
        None
    }
}

fn current_exempt_sid_set(api: &FirewallApi) -> HashSet<String> {
    let mut set = HashSet::new();
    unsafe {
        let mut count: DWORD = 0;
        let mut sids: *mut SidAndAttributes = ptr::null_mut();
        let status = (api.get_app_container_config)(&mut count, &mut sids);
        if status != ERROR_SUCCESS || sids.is_null() || count == 0 {
            return set;
        }
        for index in 0..count as usize {
            let entry = &*sids.add(index);
            if let Some(sid) = sid_to_string(entry.sid) {
                set.insert(sid.to_ascii_uppercase());
            }
        }
        let _ = HeapFree(GetProcessHeap(), 0, sids.cast());
    }
    set
}

pub fn enum_app_containers() -> Result<Vec<Value>, String> {
    let api = load_firewall_api()?;
    unsafe {
        let mut count: DWORD = 0;
        let mut containers: *mut InetFirewallAppContainer = ptr::null_mut();
        let status = (api.enum_app_containers)(0, &mut count, &mut containers);
        if status != ERROR_SUCCESS {
            return Err(format!("EnumAppContainers failed with code: {status}"));
        }

        let exempt = current_exempt_sid_set(api);
        let mut apps = Vec::with_capacity(count as usize);

        if !containers.is_null() {
            for index in 0..count as usize {
                let container = &*containers.add(index);
                let Some(sid) = sid_to_string(container.app_container_sid) else {
                    continue;
                };
                let name = wide_to_string(container.app_container_name);
                let raw_display = wide_to_string(container.display_name);
                let display = resolve_display_name(&raw_display, &name);
                let work_dir = wide_to_string(container.working_directory);
                let package_full_name = wide_to_string(container.package_full_name);
                let package_family_name = extract_package_family_name(&package_full_name)
                    .unwrap_or_else(|| name.clone());
                let is_exempt = exempt.contains(&sid.to_ascii_uppercase());

                apps.push(json!({
                    "appContainerName": name,
                    "displayName": display,
                    "packageFamilyName": package_family_name,
                    "packageFullName": package_full_name,
                    "sid": sid,
                    "workingDir": work_dir,
                    "isExempt": is_exempt
                }));
            }
            (api.free_app_containers)(containers);
        }

        Ok(apps)
    }
}

pub fn set_config(sids: &[String]) -> Result<usize, String> {
    let api = load_firewall_api()?;

    // Deduplicate and normalize SIDs first. Passing invalid/duplicated SIDs can
    // make NetworkIsolationSetAppContainerConfig return ERROR_ACCESS_DENIED (5).
    let mut unique: Vec<String> = Vec::new();
    let mut seen = HashSet::new();
    for sid in sids {
        let trimmed = sid.trim();
        if trimmed.is_empty() {
            continue;
        }
        let key = trimmed.to_ascii_uppercase();
        if seen.insert(key) {
            unique.push(trimmed.to_string());
        }
    }

    if unique.is_empty() {
        let status = unsafe { (api.set_app_container_config)(0, ptr::null()) };
        if status != ERROR_SUCCESS {
            return Err(format!("SetAppContainerConfig failed: {status}"));
        }
        return Ok(0);
    }

    // Keep wide SID buffers alive for the duration of ConvertStringSidToSidW.
    let mut wide_sids: Vec<Vec<u16>> = unique.iter().map(|sid| to_wide_null(sid)).collect();
    let mut allocated: Vec<PSID> = Vec::with_capacity(unique.len());
    let mut entries: Vec<SidAndAttributes> = Vec::with_capacity(unique.len());

    for (index, wide) in wide_sids.iter_mut().enumerate() {
        let mut sid: PSID = ptr::null_mut();
        let ok = unsafe { ConvertStringSidToSidW(wide.as_ptr(), &mut sid) };
        if ok == 0 || sid.is_null() {
            for allocated_sid in &allocated {
                unsafe {
                    let _ = LocalFree(*allocated_sid as HANDLE);
                }
            }
            return Err(format!("Invalid SID: {}", unique[index]));
        }
        allocated.push(sid);
        entries.push(SidAndAttributes {
            sid,
            attributes: 0,
        });
    }

    let status = unsafe {
        (api.set_app_container_config)(entries.len() as DWORD, entries.as_ptr())
    };

    for allocated_sid in allocated {
        unsafe {
            let _ = LocalFree(allocated_sid as HANDLE);
        }
    }

    if status != ERROR_SUCCESS {
        // Error 5 is ERROR_ACCESS_DENIED. Surface a clearer message.
        if status == 5 {
            return Err(
                "SetAppContainerConfig failed: 5 (拒绝访问，可能包含无效 SID 或权限不足)"
                    .to_string(),
            );
        }
        return Err(format!("SetAppContainerConfig failed: {status}"));
    }
    Ok(entries.len())
}

pub fn all_container_sids() -> Result<Vec<String>, String> {
    let apps = enum_app_containers()?;
    Ok(apps
        .into_iter()
        .filter_map(|app| {
            app.get("sid")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
        })
        .collect())
}

pub fn enrich_display_names(apps: &mut [Value], names: &HashMap<String, String>) {
    for app in apps {
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
        let current = app
            .get("displayName")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();

        let needs_better = current.is_empty()
            || current.starts_with('@')
            || current.eq_ignore_ascii_case(&container_name)
            || current.eq_ignore_ascii_case(&package_family_name);

        if !needs_better {
            continue;
        }

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
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_package_family_name_from_full_name() {
        assert_eq!(
            extract_package_family_name(
                "Microsoft.WindowsSoundRecorder_10.2403.20.0_x64__8wekyb3d8bbwe"
            )
            .as_deref(),
            Some("Microsoft.WindowsSoundRecorder_8wekyb3d8bbwe")
        );
    }

    #[test]
    fn enum_app_containers_does_not_panic() {
        let result = enum_app_containers();
        assert!(result.is_ok() || result.is_err());
    }
}
