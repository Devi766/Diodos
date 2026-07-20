#![cfg(windows)]

use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::fs;
use std::os::windows::ffi::OsStrExt;
use std::path::PathBuf;
use std::process::Command;
use std::ptr;
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

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
    fn OpenProcessToken(process: HANDLE, desired: DWORD, token: *mut HANDLE) -> BOOL;
    fn GetTokenInformation(
        token: HANDLE,
        class: DWORD,
        info: *mut core::ffi::c_void,
        length: DWORD,
        returned: *mut DWORD,
    ) -> BOOL;
}

#[link(name = "kernel32")]
extern "system" {
    fn LocalFree(h_mem: HANDLE) -> HANDLE;
    fn GetProcessHeap() -> HANDLE;
    fn HeapFree(h_heap: HANDLE, dw_flags: DWORD, lp_mem: *mut core::ffi::c_void) -> BOOL;
    fn LoadLibraryW(lp_lib_file_name: PCWSTR) -> HMODULE;
    fn GetProcAddress(h_module: HMODULE, lp_proc_name: *const u8) -> *const core::ffi::c_void;
    fn GetCurrentProcess() -> HANDLE;
    fn CloseHandle(h_object: HANDLE) -> BOOL;
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

const TOKEN_QUERY: DWORD = 0x0008;
const TOKEN_ELEVATION: DWORD = 20;

#[repr(C)]
struct TokenElevation {
    token_is_elevated: DWORD,
}

/// True when the current process already runs elevated (High/System integrity).
pub fn is_process_elevated() -> bool {
    unsafe {
        let mut token: HANDLE = 0;
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return false;
        }
        let mut elevation = TokenElevation {
            token_is_elevated: 0,
        };
        let mut returned: DWORD = 0;
        let ok = GetTokenInformation(
            token,
            TOKEN_ELEVATION,
            (&mut elevation as *mut TokenElevation).cast(),
            std::mem::size_of::<TokenElevation>() as DWORD,
            &mut returned,
        );
        let _ = CloseHandle(token);
        ok != 0 && elevation.token_is_elevated != 0
    }
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

fn set_config_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn is_app_container_sid(sid: &str) -> bool {
    let trimmed = sid.trim();
    if !trimmed.to_ascii_uppercase().starts_with("S-1-15-2-") {
        return false;
    }
    trimmed
        .chars()
        .all(|ch| ch.is_ascii_digit() || ch == '-' || ch == 'S' || ch == 's')
        && trimmed.len() >= 12
}

fn normalize_sids(sids: &[String]) -> Vec<String> {
    let known = all_container_sids().unwrap_or_default();
    let known_upper: HashSet<String> = known
        .iter()
        .map(|sid| sid.trim().to_ascii_uppercase())
        .filter(|sid| !sid.is_empty())
        .collect();

    let mut unique: Vec<String> = Vec::new();
    let mut seen = HashSet::new();
    for sid in sids {
        let trimmed = sid.trim();
        if trimmed.is_empty() || !is_app_container_sid(trimmed) {
            continue;
        }
        let key = trimmed.to_ascii_uppercase();
        if !known_upper.is_empty() && !known_upper.contains(&key) {
            continue;
        }
        if seen.insert(key) {
            unique.push(trimmed.to_string());
        }
    }
    unique
}

/// Public entry used by the UI. On access-denied (common for Medium integrity
/// processes on modern Windows), automatically re-launches this binary elevated
/// via UAC and applies the same SID list.
pub fn set_config(sids: &[String]) -> Result<usize, String> {
    let unique = normalize_sids(sids);
    match set_config_direct(&unique) {
        Ok(count) => Ok(count),
        Err(error)
            if error.contains("failed: 5")
                || error.contains("拒绝访问")
                || error.contains("ACCESS_DENIED") =>
        {
            if is_process_elevated() {
                return Err(error);
            }
            // Elevate once and retry. User will see a UAC prompt.
            set_config_elevated(&unique).map_err(|elev_error| {
                if elev_error.contains("取消") || elev_error.contains("cancel") {
                    elev_error
                } else {
                    format!("{error}；提权重试失败: {elev_error}")
                }
            })
        }
        Err(error) => Err(error),
    }
}

/// Apply loopback config in the *current* process (no UAC). Used by the elevated
/// helper child and by tests.
pub fn set_config_direct(sids: &[String]) -> Result<usize, String> {
    // Serialize writes — concurrent SetAppContainerConfig calls often fail with
    // ERROR_ACCESS_DENIED (5) even when each SID list is individually valid.
    let _guard = set_config_lock()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    let api = load_firewall_api()?;
    let unique = {
        // Caller may already have normalized; do a light dedupe again.
        let mut out = Vec::new();
        let mut seen = HashSet::new();
        for sid in sids {
            let trimmed = sid.trim();
            if trimmed.is_empty() || !is_app_container_sid(trimmed) {
                continue;
            }
            if seen.insert(trimmed.to_ascii_uppercase()) {
                out.push(trimmed.to_string());
            }
        }
        out
    };

    set_config_unlocked(api, &unique)
}

fn set_config_elevated(sids: &[String]) -> Result<usize, String> {
    let exe = std::env::current_exe().map_err(|err| format!("无法定位程序路径: {err}"))?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis())
        .unwrap_or(0);
    let dir = std::env::temp_dir();
    let request_path = dir.join(format!("flyclash-loopback-req-{stamp}.json"));
    let result_path = dir.join(format!("flyclash-loopback-res-{stamp}.json"));

    let payload = json!({
        "sids": sids,
        "resultPath": result_path.to_string_lossy(),
    });
    fs::write(
        &request_path,
        serde_json::to_vec_pretty(&payload).map_err(|err| err.to_string())?,
    )
    .map_err(|err| format!("写入提权请求失败: {err}"))?;

    // Clean any stale result.
    let _ = fs::remove_file(&result_path);

    // Use PowerShell Start-Process -Verb RunAs for reliable UAC elevation.
    // Hand-rolled ShellExecuteExW structs are easy to mis-align on x64.
    let exe_str = exe.to_string_lossy().replace('\'', "''");
    let req_str = request_path.to_string_lossy().replace('\'', "''");
    let ps = format!(
        "$p = Start-Process -FilePath '{exe_str}' -ArgumentList @('--flyclash-loopback-set','{req_str}') -Verb RunAs -Wait -PassThru -WindowStyle Hidden; if ($null -eq $p) {{ exit 1223 }}; exit $p.ExitCode"
    );

    let output = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &ps,
        ])
        .output()
        .map_err(|err| format!("启动 UAC 提权失败: {err}"))?;

    let status = output.status.code().unwrap_or(1);
    // 1223 = ERROR_CANCELLED (UAC denied)
    if status == 1223 {
        let _ = fs::remove_file(&request_path);
        return Err("已取消管理员授权，无法修改 UWP 回环豁免".to_string());
    }

    // Child writes the result file before exiting. Poll briefly.
    let deadline = SystemTime::now() + Duration::from_secs(5);
    while SystemTime::now() < deadline {
        if result_path.is_file() {
            break;
        }
        thread::sleep(Duration::from_millis(40));
    }

    let raw = fs::read_to_string(&result_path).map_err(|_| {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if status == 0 {
            if stderr.is_empty() {
                "提权进程未返回结果（可能 UAC 被取消）".to_string()
            } else {
                format!("提权进程未返回结果: {stderr}")
            }
        } else if stderr.is_empty() {
            format!("提权进程失败 (exit={status})")
        } else {
            format!("提权进程失败 (exit={status}): {stderr}")
        }
    })?;
    let _ = fs::remove_file(&request_path);
    let _ = fs::remove_file(&result_path);

    let value: Value =
        serde_json::from_str(&raw).map_err(|err| format!("解析提权结果失败: {err}"))?;
    if value
        .get("success")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        Ok(value
            .get("count")
            .and_then(Value::as_u64)
            .unwrap_or(sids.len() as u64) as usize)
    } else {
        Err(value
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("提权写入回环配置失败")
            .to_string())
    }
}

/// CLI helper entry for elevated writes.
/// Returns true when argv requested the helper (caller should exit).
pub fn maybe_run_elevated_cli(args: &[String]) -> bool {
    let Some(flag_pos) = args.iter().position(|arg| arg == "--flyclash-loopback-set") else {
        return false;
    };
    let request = args
        .get(flag_pos + 1)
        .map(PathBuf::from)
        .unwrap_or_default();

    let result = (|| -> Result<Value, String> {
        let raw = fs::read_to_string(&request).map_err(|err| format!("读取请求失败: {err}"))?;
        let value: Value =
            serde_json::from_str(&raw).map_err(|err| format!("解析请求失败: {err}"))?;
        let sids = value
            .get("sids")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|item| item.as_str().map(ToString::to_string))
            .collect::<Vec<_>>();
        let result_path = value
            .get("resultPath")
            .and_then(Value::as_str)
            .map(PathBuf::from)
            .unwrap_or_else(|| request.with_extension("result.json"));

        let count = set_config_direct(&sids)?;
        let body = json!({ "success": true, "count": count });
        fs::write(
            &result_path,
            serde_json::to_vec_pretty(&body).map_err(|err| err.to_string())?,
        )
        .map_err(|err| format!("写入结果失败: {err}"))?;
        Ok(body)
    })();

    if let Err(error) = result {
        // Best-effort write an error result next to the request.
        let fallback = request.with_extension("result.json");
        let body = json!({ "success": false, "error": error });
        let _ = fs::write(fallback, serde_json::to_vec_pretty(&body).unwrap_or_default());
        // Also try resultPath from file if readable.
        if let Ok(raw) = fs::read_to_string(&request) {
            if let Ok(value) = serde_json::from_str::<Value>(&raw) {
                if let Some(path) = value.get("resultPath").and_then(Value::as_str) {
                    let _ = fs::write(path, serde_json::to_vec_pretty(&body).unwrap_or_default());
                }
            }
        }
        // Non-zero exit for the parent waiter.
        std::process::exit(2);
    }

    true
}

fn set_config_unlocked(api: &FirewallApi, sids: &[String]) -> Result<usize, String> {
    if sids.is_empty() {
        let status = unsafe { (api.set_app_container_config)(0, ptr::null()) };
        if status != ERROR_SUCCESS {
            if status == 5 {
                return Err(
                    "SetAppContainerConfig failed: 5 (拒绝访问，需要管理员权限写入回环配置)"
                        .to_string(),
                );
            }
            return Err(format!("SetAppContainerConfig failed: {status}"));
        }
        return Ok(0);
    }

    let mut wide_sids: Vec<Vec<u16>> = sids.iter().map(|sid| to_wide_null(sid)).collect();
    let mut allocated: Vec<PSID> = Vec::with_capacity(sids.len());
    let mut entries: Vec<SidAndAttributes> = Vec::with_capacity(sids.len());
    let mut valid: Vec<String> = Vec::with_capacity(sids.len());

    for (index, wide) in wide_sids.iter_mut().enumerate() {
        let mut sid: PSID = ptr::null_mut();
        let ok = unsafe { ConvertStringSidToSidW(wide.as_ptr(), &mut sid) };
        if ok == 0 || sid.is_null() {
            continue;
        }
        allocated.push(sid);
        entries.push(SidAndAttributes {
            sid,
            attributes: 0,
        });
        valid.push(sids[index].clone());
    }

    if entries.is_empty() {
        for allocated_sid in allocated {
            unsafe {
                let _ = LocalFree(allocated_sid as HANDLE);
            }
        }
        return set_config_unlocked(api, &[]);
    }

    let status = unsafe {
        (api.set_app_container_config)(entries.len() as DWORD, entries.as_ptr())
    };

    for allocated_sid in allocated {
        unsafe {
            let _ = LocalFree(allocated_sid as HANDLE);
        }
    }

    // When elevated, some stale SIDs still return 5. Binary-prune and keep survivors.
    if status == 5 && valid.len() > 1 {
        let surviving = prune_rejected_sids(api, &valid)?;
        return Ok(surviving.len());
    }

    if status != ERROR_SUCCESS {
        if status == 5 {
            return Err(
                "SetAppContainerConfig failed: 5 (拒绝访问，需要管理员权限写入回环配置)"
                    .to_string(),
            );
        }
        return Err(format!("SetAppContainerConfig failed: {status}"));
    }
    Ok(entries.len())
}

/// Binary-search which SIDs Windows accepts. Used only as a fallback when a
/// full batch fails with ERROR_ACCESS_DENIED.
fn prune_rejected_sids(api: &FirewallApi, sids: &[String]) -> Result<Vec<String>, String> {
    if sids.is_empty() {
        return Ok(Vec::new());
    }
    if sids.len() == 1 {
        return match set_config_unlocked(api, sids) {
            Ok(_) => Ok(sids.to_vec()),
            Err(_) => Ok(Vec::new()),
        };
    }

    let mid = sids.len() / 2;
    let left = &sids[..mid];
    let right = &sids[mid..];

    let mut kept = Vec::new();
    if set_config_unlocked(api, left).is_ok() {
        kept.extend(left.iter().cloned());
    } else {
        kept.extend(prune_rejected_sids(api, left)?);
    }
    if set_config_unlocked(api, right).is_ok() {
        kept.extend(right.iter().cloned());
    } else {
        kept.extend(prune_rejected_sids(api, right)?);
    }

    // Re-apply the combined surviving set so the OS ends with the full keep list.
    set_config_unlocked(api, &kept)?;
    Ok(kept)
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
