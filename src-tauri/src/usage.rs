use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::AppHandle;

use crate::{
    mihomo_transport,
    runtime::is_mihomo_running,
    storage::{db, set_setting, setting},
};

type CompatResult = Result<Value, String>;

const HOUR_MS: i64 = 3_600_000;
const DAY_MS: i64 = 86_400_000;

const DIM_SITE: i64 = 1;
const DIM_HOST: i64 = 2;
const DIM_APP: i64 = 3;
const DIM_NODE: i64 = 4;
const DIM_GROUP: i64 = 5;
const DIM_RULE: i64 = 6;

const SETTING_ENABLED: &str = "usageEnabled";
const SETTING_DETAIL: &str = "usageDetail";
const SETTING_RETENTION_DAYS: &str = "usageRetentionDays";

#[derive(Debug, Clone, Hash, PartialEq, Eq)]
struct UsageKey {
    host: String,
    app: String,
    app_path: String,
    node: String,
    via: String,
    group: String,
    rule: String,
    proxy: bool,
}

#[derive(Debug, Clone, Default)]
struct UsageEntry {
    up: i64,
    down: i64,
    conns: i64,
}

#[derive(Debug, Clone)]
struct TrackedConn {
    key: UsageKey,
    up: i64,
    down: i64,
}

#[derive(Default)]
struct RecorderState {
    conns: HashMap<String, TrackedConn>,
    pending: HashMap<UsageKey, UsageEntry>,
}

fn recorder_state() -> &'static Arc<Mutex<RecorderState>> {
    static STATE: OnceLock<Arc<Mutex<RecorderState>>> = OnceLock::new();
    STATE.get_or_init(|| Arc::new(Mutex::new(RecorderState::default())))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UsageSettings {
    pub enabled: bool,
    pub detail: bool,
    pub retention_days: i64,
}

impl Default for UsageSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            detail: true,
            retention_days: 30,
        }
    }
}

fn read_usage_settings(app: &AppHandle) -> UsageSettings {
    let enabled = setting(app, SETTING_ENABLED, json!(true))
        .ok()
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let detail = setting(app, SETTING_DETAIL, json!(true))
        .ok()
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let retention_days = setting(app, SETTING_RETENTION_DAYS, json!(30))
        .ok()
        .and_then(|v| v.as_i64())
        .map(|d| d.clamp(7, 365))
        .unwrap_or(30);
    UsageSettings {
        enabled,
        detail,
        retention_days,
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 本地时区偏移（毫秒，例如 UTC+8 为 +28_800_000）
fn local_tz_offset_ms() -> i64 {
    #[cfg(target_os = "windows")]
    {
        #[repr(C)]
        #[derive(Default)]
        struct SystemTimeWin {
            year: u16,
            month: u16,
            day_of_week: u16,
            day: u16,
            hour: u16,
            minute: u16,
            second: u16,
            milliseconds: u16,
        }
        #[link(name = "kernel32")]
        extern "system" {
            fn GetLocalTime(st: *mut SystemTimeWin);
            fn GetSystemTime(st: *mut SystemTimeWin);
        }
        let mut local = SystemTimeWin::default();
        let mut utc = SystemTimeWin::default();
        unsafe {
            GetLocalTime(&mut local);
            GetSystemTime(&mut utc);
        }
        let local_secs = unix_secs_from_ymd_hms(
            local.year as i32,
            local.month as u32,
            local.day as u32,
            local.hour as u32,
            local.minute as u32,
            local.second as u32,
        );
        let utc_secs = unix_secs_from_ymd_hms(
            utc.year as i32,
            utc.month as u32,
            utc.day as u32,
            utc.hour as u32,
            utc.minute as u32,
            utc.second as u32,
        );
        // Round to nearest minute to avoid boundary jitter between the two calls
        let diff_mins = ((local_secs - utc_secs) as f64 / 60.0).round() as i64;
        diff_mins * 60_000
    }
    #[cfg(unix)]
    {
        use std::os::raw::c_long;
        #[repr(C)]
        struct Tm {
            fields: [i32; 9],
            tail: [u64; 8],
        }
        extern "C" {
            fn time(timer: *mut c_long) -> c_long;
            fn localtime_r(timer: *const c_long, result: *mut Tm) -> *mut Tm;
        }
        let mut tm = Tm {
            fields: [0; 9],
            tail: [0; 8],
        };
        let now_sec = unsafe {
            let t = time(std::ptr::null_mut());
            if localtime_r(&t, &mut tm).is_null() {
                return 0;
            }
            t as i64
        };
        let local_secs = unix_secs_from_ymd_hms(
            tm.fields[5] + 1900,
            (tm.fields[4] + 1) as u32,
            tm.fields[3] as u32,
            tm.fields[2] as u32,
            tm.fields[1] as u32,
            tm.fields[0] as u32,
        );
        let diff_mins = ((local_secs - now_sec) as f64 / 60.0).round() as i64;
        diff_mins * 60_000
    }
    #[cfg(not(any(target_os = "windows", unix)))]
    {
        0
    }
}

fn unix_days_from_civil(year: i32, month: u32, day: u32) -> i64 {
    let y = year as i64 - if month <= 2 { 1 } else { 0 };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u64;
    let m = month as u64;
    let d = day as u64;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe as i64 - 719_468
}

fn civil_from_unix_days(days: i64) -> (i32, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    let year = y + if month <= 2 { 1 } else { 0 };
    (year as i32, month as u32, day as u32)
}

fn unix_secs_from_ymd_hms(year: i32, month: u32, day: u32, hour: u32, min: u32, sec: u32) -> i64 {
    unix_days_from_civil(year, month, day) * 86_400
        + hour as i64 * 3_600
        + min as i64 * 60
        + sec as i64
}

fn days_in_month(year: i32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0) {
                29
            } else {
                28
            }
        }
        _ => 30,
    }
}

fn local_ymd(ms: i64, tz_offset_ms: i64) -> (i32, u32, u32) {
    let local_ms = ms + tz_offset_ms;
    let days = local_ms.div_euclid(DAY_MS);
    civil_from_unix_days(days)
}

fn day_key(ms: i64, tz_offset_ms: i64) -> i64 {
    let (y, m, d) = local_ymd(ms, tz_offset_ms);
    y as i64 * 10_000 + m as i64 * 100 + d as i64
}

fn start_of_day(ms: i64, tz_offset_ms: i64) -> i64 {
    let local_ms = ms + tz_offset_ms;
    let days = local_ms.div_euclid(DAY_MS);
    days * DAY_MS - tz_offset_ms
}

/// 周一 = 0 .. 周日 = 6
fn weekday_mon0(ms: i64, tz_offset_ms: i64) -> usize {
    let local_ms = ms + tz_offset_ms;
    let days = local_ms.div_euclid(DAY_MS);
    // 1970-01-01 was Thursday (3 in Mon=0)
    (days + 3).rem_euclid(7) as usize
}

fn local_hour_of_day(ms: i64, tz_offset_ms: i64) -> usize {
    let local_ms = ms + tz_offset_ms;
    (local_ms.rem_euclid(DAY_MS) / HOUR_MS) as usize
}

fn start_of_week(ms: i64, tz_offset_ms: i64) -> i64 {
    let sod = start_of_day(ms, tz_offset_ms);
    let dow = weekday_mon0(ms, tz_offset_ms) as i64;
    sod - dow * DAY_MS
}

fn start_of_month_ym(year: i32, month: u32, tz_offset_ms: i64) -> i64 {
    unix_days_from_civil(year, month, 1) * DAY_MS - tz_offset_ms
}

fn add_months_ym(year: i32, month: u32, delta: i32) -> (i32, u32) {
    let total = year * 12 + (month as i32 - 1) + delta;
    let new_year = total.div_euclid(12);
    let new_month = (total.rem_euclid(12) + 1) as u32;
    (new_year, new_month)
}

fn is_proxy_node(node: &str) -> bool {
    let upper = node.trim().to_ascii_uppercase();
    !matches!(
        upper.as_str(),
        "" | "DIRECT" | "REJECT" | "REJECT-DROP" | "PASS"
    )
}

fn registrable_domain(host: &str) -> String {
    let h = host.trim().trim_end_matches('.').to_ascii_lowercase();
    if h.is_empty() || h.contains(':') {
        return h;
    }
    // IPv4 check
    let parts: Vec<&str> = h.split('.').collect();
    if parts.len() == 4 && parts.iter().all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit())) {
        return h;
    }
    if parts.len() <= 2 {
        return h;
    }
    let last_two = format!("{}.{}", parts[parts.len() - 2], parts[parts.len() - 1]);
    const TWO_LEVEL_SUFFIXES: &[&str] = &[
        "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk",
        "com.cn", "net.cn", "org.cn", "gov.cn", "edu.cn",
        "com.hk", "net.hk", "org.hk", "com.tw", "net.tw", "org.tw", "com.mo",
        "co.jp", "ne.jp", "or.jp", "ac.jp", "co.kr", "or.kr",
        "com.sg", "com.my", "com.au", "net.au", "org.au", "co.nz",
        "com.br", "co.in", "co.id", "com.tr", "com.vn",
        "github.io", "vercel.app", "pages.dev", "workers.dev", "netlify.app",
        "herokuapp.com", "appspot.com", "web.app", "firebaseapp.com",
    ];
    let keep = if TWO_LEVEL_SUFFIXES.contains(&last_two.as_str()) {
        3
    } else {
        2
    };
    parts[parts.len().saturating_sub(keep)..].join(".")
}

fn sample_connections(connections: &[Value], detail: bool) {
    let mut state = recorder_state().lock().expect("usage recorder mutex poisoned");
    let mut seen: HashSet<String> = HashSet::with_capacity(connections.len());

    for conn in connections {
        let Some(id) = conn.get("id").and_then(Value::as_str) else {
            continue;
        };
        let up = conn.get("upload").and_then(Value::as_i64).unwrap_or(0);
        let down = conn.get("download").and_then(Value::as_i64).unwrap_or(0);
        seen.insert(id.to_string());

        let (key, du, dd, is_new) = if let Some(tracked) = state.conns.get_mut(id) {
            let du = (up - tracked.up).max(0);
            let dd = (down - tracked.down).max(0);
            tracked.up = up;
            tracked.down = down;
            (tracked.key.clone(), du, dd, false)
        } else {
            let key = extract_usage_key(conn, detail);
            state.conns.insert(
                id.to_string(),
                TrackedConn {
                    key: key.clone(),
                    up,
                    down,
                },
            );
            (key, up.max(0), down.max(0), true)
        };

        if is_new || du > 0 || dd > 0 {
            let entry = state.pending.entry(key).or_default();
            if is_new {
                entry.conns += 1;
            }
            entry.up += du;
            entry.down += dd;
        }
    }

    // Remove closed connections from tracker
    state.conns.retain(|id, _| seen.contains(id));
}

fn extract_usage_key(conn: &Value, detail: bool) -> UsageKey {
    let chains: Vec<&str> = conn
        .get("chains")
        .and_then(Value::as_array)
        .map(|arr| arr.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let node = chains.first().copied().unwrap_or("").to_string();
    let proxy = is_proxy_node(&node);

    if !detail {
        return UsageKey {
            host: String::new(),
            app: String::new(),
            app_path: String::new(),
            node: String::new(),
            via: String::new(),
            group: String::new(),
            rule: String::new(),
            proxy,
        };
    }

    let (via, group) = if chains.len() > 1 {
        (
            chains[1].to_string(),
            chains[chains.len() - 1].to_string(),
        )
    } else {
        (String::new(), node.clone())
    };

    let rule_name = conn.get("rule").and_then(Value::as_str).unwrap_or("");
    let rule_payload = conn.get("rulePayload").and_then(Value::as_str).unwrap_or("");
    let rule = if !rule_name.is_empty() {
        if !rule_payload.is_empty() {
            format!("{rule_name},{rule_payload}")
        } else {
            rule_name.to_string()
        }
    } else {
        String::new()
    };

    let meta = conn.get("metadata");
    let raw_host = meta
        .and_then(|m| m.get("host"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .trim_end_matches('.')
        .to_ascii_lowercase();
    let host = if !raw_host.is_empty() {
        raw_host
    } else {
        meta.and_then(|m| m.get("destinationIP"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string()
    };
    let app = meta
        .and_then(|m| m.get("process"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let app_path = meta
        .and_then(|m| m.get("processPath"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();

    UsageKey {
        host,
        app,
        app_path,
        node,
        via,
        group,
        rule,
        proxy,
    }
}

fn drain_pending() -> Vec<(UsageKey, UsageEntry)> {
    let mut state = recorder_state().lock().expect("usage recorder mutex poisoned");
    state
        .pending
        .drain()
        .filter(|(_, e)| e.up + e.down > 0 || e.conns > 0)
        .collect()
}

fn flush_pending_to_db(app: &AppHandle, detail: bool) -> Result<(), String> {
    let entries = drain_pending();
    if entries.is_empty() {
        return Ok(());
    }
    let now = now_ms();
    let tz = local_tz_offset_ms();
    let hour = now.div_euclid(HOUR_MS);
    let day = day_key(now, tz);

    let mut conn = db(app)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    {
        let mut upsert_hour = tx
            .prepare(
                "INSERT INTO usage_hourly(hour, proxy, up, down) VALUES(?1, ?2, ?3, ?4)
                 ON CONFLICT(hour, proxy) DO UPDATE SET up = up + excluded.up, down = down + excluded.down",
            )
            .map_err(|e| e.to_string())?;
        let mut upsert_item = tx
            .prepare(
                "INSERT INTO usage_items(day, dim, name, extra, proxy, up, down, hits)
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT(day, dim, name, extra, proxy) DO UPDATE SET
                   up = up + excluded.up,
                   down = down + excluded.down,
                   hits = hits + excluded.hits",
            )
            .map_err(|e| e.to_string())?;

        for (key, entry) in entries {
            let proxy_i = if key.proxy { 1i64 } else { 0i64 };
            if entry.up + entry.down > 0 {
                upsert_hour
                    .execute(params![hour, proxy_i, entry.up, entry.down])
                    .map_err(|e| e.to_string())?;
            }
            if !detail {
                continue;
            }

            let mut write_item = |dim: i64, name: &str, extra: &str| -> Result<(), String> {
                if name.trim().is_empty() {
                    return Ok(());
                }
                upsert_item
                    .execute(params![
                        day,
                        dim,
                        name,
                        extra,
                        proxy_i,
                        entry.up,
                        entry.down,
                        entry.conns
                    ])
                    .map_err(|e| e.to_string())?;
                Ok(())
            };

            let domain = registrable_domain(&key.host);
            write_item(DIM_SITE, &domain, &key.group)?;
            write_item(DIM_HOST, &key.host, &domain)?;
            write_item(DIM_APP, &key.app, &key.app_path)?;
            write_item(DIM_NODE, &key.node, &key.via)?;
            let group_extra = if !key.via.is_empty() {
                key.via.as_str()
            } else {
                key.node.as_str()
            };
            write_item(DIM_GROUP, &key.group, group_extra)?;
            write_item(DIM_RULE, &key.rule, &key.group)?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

fn prune_old_usage(app: &AppHandle, retention_days: i64) -> Result<(), String> {
    let now = now_ms();
    let tz = local_tz_offset_ms();
    let cutoff_ms = start_of_day(now, tz) - (retention_days - 1).max(0) * DAY_MS;
    let cutoff_hour = cutoff_ms.div_euclid(HOUR_MS);
    let cutoff_day = day_key(cutoff_ms, tz);
    let conn = db(app)?;
    conn.execute("DELETE FROM usage_hourly WHERE hour < ?1", params![cutoff_hour])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM usage_items WHERE day < ?1", params![cutoff_day])
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn clear_all_usage(app: &AppHandle) -> Result<(), String> {
    {
        let mut state = recorder_state().lock().expect("usage recorder mutex poisoned");
        state.pending.clear();
    }
    let conn = db(app)?;
    conn.execute("DELETE FROM usage_hourly", [])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM usage_items", [])
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub(crate) fn start_usage_recorder(app: &AppHandle) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut tick: u64 = 0;
        let mut last_prune_ms: i64 = 0;
        loop {
            tokio::time::sleep(Duration::from_secs(2)).await;
            tick = tick.wrapping_add(1);

            let settings = read_usage_settings(&handle);
            if !settings.enabled {
                let mut state = recorder_state().lock().expect("usage recorder mutex poisoned");
                state.conns.clear();
                state.pending.clear();
                continue;
            }

            if is_mihomo_running(&handle) {
                if let Ok(resp) =
                    mihomo_transport::request(&handle, Some("/connections".to_string()), None).await
                {
                    if let Some(conns) = resp
                        .get("data")
                        .and_then(|d| d.get("connections"))
                        .and_then(Value::as_array)
                    {
                        sample_connections(conns, settings.detail);
                    }
                }
            }

            // Every 10 seconds flush pending deltas to SQLite
            if tick % 5 == 0 {
                let _ = flush_pending_to_db(&handle, settings.detail);
            }

            // Every 1 hour prune expired rows
            let now = now_ms();
            if now - last_prune_ms > 3_600_000 {
                last_prune_ms = now;
                let _ = prune_old_usage(&handle, settings.retention_days);
            }
        }
    });
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Totals {
    up: i64,
    down: i64,
    proxy: i64,
    direct: i64,
    total: i64,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Point {
    proxy: i64,
    direct: i64,
    total: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RankItem {
    name: String,
    up: i64,
    down: i64,
    total: i64,
    proxy_bytes: i64,
    mostly_proxy: bool,
    extra: String,
    hits: i64,
    sub_count: i64,
}

fn ceil_hour(ms: i64) -> i64 {
    (ms + HOUR_MS - 1).div_euclid(HOUR_MS)
}

fn query_totals(conn: &Connection, from_ms: i64, to_ms: i64) -> Result<Totals, String> {
    let mut stmt = conn
        .prepare(
            "SELECT proxy, COALESCE(SUM(up), 0), COALESCE(SUM(down), 0)
             FROM usage_hourly WHERE hour >= ?1 AND hour < ?2 GROUP BY proxy",
        )
        .map_err(|e| e.to_string())?;
    let mut rows = stmt
        .query(params![from_ms.div_euclid(HOUR_MS), ceil_hour(to_ms)])
        .map_err(|e| e.to_string())?;

    let mut up = 0i64;
    let mut down = 0i64;
    let mut proxy = 0i64;
    let mut direct = 0i64;
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let is_proxy = row.get::<_, i64>(0).unwrap_or(0) == 1;
        let u = row.get::<_, i64>(1).unwrap_or(0);
        let d = row.get::<_, i64>(2).unwrap_or(0);
        up += u;
        down += d;
        if is_proxy {
            proxy += u + d;
        } else {
            direct += u + d;
        }
    }
    Ok(Totals {
        up,
        down,
        proxy,
        direct,
        total: up + down,
    })
}

fn query_buckets_by_hour<F>(
    conn: &Connection,
    from_ms: i64,
    to_ms: i64,
    mut each: F,
) -> Result<(), String>
where
    F: FnMut(i64, bool, i64),
{
    let mut stmt = conn
        .prepare(
            "SELECT hour, proxy, COALESCE(SUM(up + down), 0)
             FROM usage_hourly WHERE hour >= ?1 AND hour < ?2 GROUP BY hour, proxy",
        )
        .map_err(|e| e.to_string())?;
    let mut rows = stmt
        .query(params![from_ms.div_euclid(HOUR_MS), ceil_hour(to_ms)])
        .map_err(|e| e.to_string())?;
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let h = row.get::<_, i64>(0).unwrap_or(0);
        let is_proxy = row.get::<_, i64>(1).unwrap_or(0) == 1;
        let bytes = row.get::<_, i64>(2).unwrap_or(0);
        each(h * HOUR_MS, is_proxy, bytes);
    }
    Ok(())
}

fn query_hourly(conn: &Connection, day_start_ms: i64) -> Result<Vec<Point>, String> {
    let mut result = vec![Point::default(); 24];
    let first_hour = day_start_ms.div_euclid(HOUR_MS);
    query_buckets_by_hour(conn, day_start_ms, day_start_ms + DAY_MS, |hour_ms, is_proxy, bytes| {
        let idx = (hour_ms.div_euclid(HOUR_MS) - first_hour) as isize;
        if (0..24).contains(&idx) {
            let p = &mut result[idx as usize];
            if is_proxy {
                p.proxy += bytes;
            } else {
                p.direct += bytes;
            }
            p.total = p.proxy + p.direct;
        }
    })?;
    Ok(result)
}

fn query_daily(conn: &Connection, start_ms: i64, days: usize, tz: i64) -> Result<Vec<Point>, String> {
    let base = start_of_day(start_ms, tz);
    let mut result = vec![Point::default(); days];
    let end = base + days as i64 * DAY_MS;
    query_buckets_by_hour(conn, base, end, |hour_ms, is_proxy, bytes| {
        let idx = (hour_ms - base).div_euclid(DAY_MS);
        if idx >= 0 && (idx as usize) < days {
            let p = &mut result[idx as usize];
            if is_proxy {
                p.proxy += bytes;
            } else {
                p.direct += bytes;
            }
            p.total = p.proxy + p.direct;
        }
    })?;
    Ok(result)
}

fn query_monthly(conn: &Connection, year: i32, tz: i64) -> Result<Vec<Point>, String> {
    let starts: Vec<i64> = (0..=12)
        .map(|i| {
            let (y, m) = add_months_ym(year, 1, i);
            start_of_month_ym(y, m, tz)
        })
        .collect();
    let mut result = vec![Point::default(); 12];
    query_buckets_by_hour(conn, starts[0], starts[12], |hour_ms, is_proxy, bytes| {
        if let Some(idx) = starts[..12].iter().rposition(|&s| s <= hour_ms) {
            let p = &mut result[idx];
            if is_proxy {
                p.proxy += bytes;
            } else {
                p.direct += bytes;
            }
            p.total = p.proxy + p.direct;
        }
    })?;
    Ok(result)
}

fn query_week_heat(conn: &Connection, now: i64, tz: i64) -> Result<Vec<Vec<i64>>, String> {
    let mut heat = vec![vec![0i64; 24]; 7];
    let end = start_of_day(now, tz) + DAY_MS;
    let start = end - 7 * DAY_MS;
    query_buckets_by_hour(conn, start, end, |hour_ms, _, bytes| {
        let dow = weekday_mon0(hour_ms, tz);
        let hour = local_hour_of_day(hour_ms, tz);
        if dow < 7 && hour < 24 {
            heat[dow][hour] += bytes;
        }
    })?;
    Ok(heat)
}

fn query_ranking(
    conn: &Connection,
    dim: i64,
    from_ms: i64,
    to_ms: i64,
    limit: i64,
    tz: i64,
) -> Result<Vec<RankItem>, String> {
    let from_day = day_key(from_ms, tz);
    let to_day = day_key(to_ms - 1, tz);

    let mut stmt = conn
        .prepare(
            "SELECT name, COALESCE(SUM(up), 0), COALESCE(SUM(down), 0),
                    COALESCE(SUM(CASE proxy WHEN 1 THEN up + down ELSE 0 END), 0),
                    COALESCE(SUM(hits), 0)
             FROM usage_items
             WHERE dim = ?1 AND day >= ?2 AND day <= ?3
             GROUP BY name
             ORDER BY SUM(up + down) DESC, SUM(hits) DESC
             LIMIT ?4",
        )
        .map_err(|e| e.to_string())?;

    let mut rows = stmt
        .query(params![dim, from_day, to_day, limit])
        .map_err(|e| e.to_string())?;

    let mut base_items = Vec::new();
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let name: String = row.get(0).unwrap_or_default();
        let up: i64 = row.get(1).unwrap_or(0);
        let down: i64 = row.get(2).unwrap_or(0);
        let proxy_bytes: i64 = row.get(3).unwrap_or(0);
        let hits: i64 = row.get(4).unwrap_or(0);
        let total = up + down;
        base_items.push(RankItem {
            name,
            up,
            down,
            total,
            proxy_bytes,
            mostly_proxy: proxy_bytes * 2 >= total,
            extra: String::new(),
            hits,
            sub_count: 0,
        });
    }
    drop(rows);
    drop(stmt);

    let mut extra_stmt = conn
        .prepare(
            "SELECT extra FROM usage_items
             WHERE dim = ?1 AND name = ?2 AND day >= ?3 AND day <= ?4
             GROUP BY extra ORDER BY SUM(up + down) DESC LIMIT 1",
        )
        .map_err(|e| e.to_string())?;
    let mut sub_stmt = conn
        .prepare(
            "SELECT COUNT(DISTINCT name) FROM usage_items
             WHERE dim = ?1 AND extra = ?2 AND day >= ?3 AND day <= ?4",
        )
        .map_err(|e| e.to_string())?;

    for item in &mut base_items {
        item.extra = extra_stmt
            .query_row(params![dim, &item.name, from_day, to_day], |r| {
                r.get::<_, String>(0)
            })
            .unwrap_or_default();
        if dim == DIM_SITE {
            item.sub_count = sub_stmt
                .query_row(params![DIM_HOST, &item.name, from_day, to_day], |r| {
                    r.get::<_, i64>(0)
                })
                .unwrap_or(0);
        }
    }

    Ok(base_items)
}

fn compute_period(range: &str, offset: i32, now: i64, tz: i64) -> (i64, i64, usize) {
    match range {
        "week" => {
            let start = start_of_week(now, tz) + offset as i64 * 7 * DAY_MS;
            (start, start + 7 * DAY_MS, 7)
        }
        "month" => {
            let (y, m, _) = local_ymd(now, tz);
            let (ty, tm) = add_months_ym(y, m, offset);
            let (ny, nm) = add_months_ym(ty, tm, 1);
            let start = start_of_month_ym(ty, tm, tz);
            let end = start_of_month_ym(ny, nm, tz);
            (start, end, days_in_month(ty, tm) as usize)
        }
        "year" => {
            let (y, _, _) = local_ymd(now, tz);
            let ty = y + offset;
            let start = start_of_month_ym(ty, 1, tz);
            let end = start_of_month_ym(ty + 1, 1, tz);
            (start, end, 12)
        }
        _ => {
            let start = start_of_day(now, tz) + offset as i64 * DAY_MS;
            (start, start + DAY_MS, 24)
        }
    }
}

fn handle_query_snapshot(app: &AppHandle, args: &[Value]) -> CompatResult {
    let settings = read_usage_settings(app);
    if settings.enabled {
        let _ = flush_pending_to_db(app, settings.detail);
    }

    let params_obj = args.first().and_then(Value::as_object);
    let range = params_obj
        .and_then(|o| o.get("range"))
        .and_then(Value::as_str)
        .unwrap_or("day");
    let offset = params_obj
        .and_then(|o| o.get("offset"))
        .and_then(Value::as_i64)
        .unwrap_or(0) as i32;
    let rank_dim = params_obj
        .and_then(|o| o.get("rankDim"))
        .and_then(Value::as_i64)
        .unwrap_or(DIM_SITE);
    let rank_limit = params_obj
        .and_then(|o| o.get("rankLimit"))
        .and_then(Value::as_i64)
        .unwrap_or(6)
        .clamp(1, 100);

    let now = now_ms();
    let tz = local_tz_offset_ms();
    let (start_ms, end_ms, buckets) = compute_period(range, offset, now, tz);
    let conn = db(app)?;

    let totals = query_totals(&conn, start_ms, end_ms)?;
    let series = match range {
        "day" => query_hourly(&conn, start_ms)?,
        "year" => {
            let (y, _, _) = local_ymd(start_ms, tz);
            query_monthly(&conn, y, tz)?
        }
        _ => query_daily(&conn, start_ms, buckets, tz)?,
    };
    let heat = query_week_heat(&conn, now, tz)?;
    let ranking = query_ranking(&conn, rank_dim, start_ms, end_ms, rank_limit, tz)?;

    Ok(json!({
        "success": true,
        "data": {
            "totals": totals,
            "series": series,
            "heat": heat,
            "ranking": ranking,
            "settings": settings,
            "period": {
                "startMs": start_ms,
                "endMs": end_ms,
                "buckets": buckets
            }
        }
    }))
}

fn range_start_for_widget(range: &str, now: i64, tz: i64) -> i64 {
    match range {
        "week" => start_of_week(now, tz),
        "month" => {
            let (y, m, _) = local_ymd(now, tz);
            start_of_month_ym(y, m, tz)
        }
        "year" => {
            let (y, _, _) = local_ymd(now, tz);
            start_of_month_ym(y, 1, tz)
        }
        _ => start_of_day(now, tz),
    }
}

fn handle_query_widget(app: &AppHandle, args: &[Value]) -> CompatResult {
    let settings = read_usage_settings(app);
    if settings.enabled {
        let _ = flush_pending_to_db(app, settings.detail);
    }

    let params_obj = args.first().and_then(Value::as_object);
    let kind = params_obj
        .and_then(|o| o.get("kind"))
        .and_then(Value::as_str)
        .unwrap_or("today");
    let range = params_obj
        .and_then(|o| o.get("range"))
        .and_then(Value::as_str)
        .unwrap_or("day");

    let now = now_ms();
    let tz = local_tz_offset_ms();
    let conn = db(app)?;

    let payload = match kind {
        "today" => {
            let start = start_of_day(now, tz);
            let y_start = start - DAY_MS;
            let today = query_totals(&conn, start, now + 1)?;
            let yesterday = query_totals(&conn, y_start, now - DAY_MS + 1)?.total;
            json!({ "today": today, "yesterdaySameTime": yesterday })
        }
        "month" => {
            let (y, m, d) = local_ymd(now, tz);
            let start = start_of_month_ym(y, m, tz);
            let days_count = days_in_month(y, m) as usize;
            let daily = query_daily(&conn, start, days_count, tz)?;
            let days: Vec<i64> = daily.into_iter().map(|p| p.total).collect();
            json!({ "days": days, "today": d, "monthStartMs": start })
        }
        "trend" => {
            let start = start_of_day(now, tz) - 6 * DAY_MS;
            let current: Vec<i64> = query_daily(&conn, start, 7, tz)?
                .into_iter()
                .map(|p| p.total)
                .collect();
            let previous: Vec<i64> = query_daily(&conn, start - 7 * DAY_MS, 7, tz)?
                .into_iter()
                .map(|p| p.total)
                .collect();
            json!({ "days": current, "previous": previous, "startMs": start })
        }
        "destinations" => {
            let start = range_start_for_widget(range, now, tz);
            let items = query_ranking(&conn, DIM_GROUP, start, now + 1, 6, tz)?;
            json!({ "items": items })
        }
        "apps" => {
            let start = range_start_for_widget(range, now, tz);
            let items = query_ranking(&conn, DIM_APP, start, now + 1, 10, tz)?;
            json!({ "items": items })
        }
        "nodes" => {
            let start = range_start_for_widget(range, now, tz);
            let items: Vec<RankItem> = query_ranking(&conn, DIM_NODE, start, now + 1, 14, tz)?
                .into_iter()
                .filter(|it| is_proxy_node(&it.name))
                .take(10)
                .collect();
            json!({ "items": items })
        }
        "heatmap" => {
            let heat = query_week_heat(&conn, now, tz)?;
            json!({ "heat": heat })
        }
        _ => return Err(format!("Unsupported usage widget kind: {kind}")),
    };

    Ok(json!({
        "success": true,
        "data": payload
    }))
}

pub(crate) async fn handle_compat_call(
    app: &AppHandle,
    method: &str,
    args: &[Value],
) -> Option<CompatResult> {
    if !matches!(
        method,
        "usageQuerySnapshot"
            | "usageQueryWidget"
            | "usageGetSettings"
            | "usageUpdateSettings"
            | "usageClear"
    ) {
        return None;
    }

    let result = match method {
        "usageQuerySnapshot" => handle_query_snapshot(app, args),
        "usageQueryWidget" => handle_query_widget(app, args),
        "usageGetSettings" => Ok(json!({
            "success": true,
            "data": read_usage_settings(app)
        })),
        "usageUpdateSettings" => {
            if let Some(obj) = args.first().and_then(Value::as_object) {
                if let Some(enabled) = obj.get("enabled").and_then(Value::as_bool) {
                    let _ = set_setting(app, SETTING_ENABLED, json!(enabled));
                    if !enabled {
                        let mut state = recorder_state().lock().expect("usage recorder mutex poisoned");
                        state.conns.clear();
                        state.pending.clear();
                    }
                }
                if let Some(detail) = obj.get("detail").and_then(Value::as_bool) {
                    let _ = set_setting(app, SETTING_DETAIL, json!(detail));
                }
                if let Some(days) = obj.get("retentionDays").and_then(Value::as_i64) {
                    let clamped = days.clamp(7, 365);
                    let _ = set_setting(app, SETTING_RETENTION_DAYS, json!(clamped));
                    let _ = prune_old_usage(app, clamped);
                }
            }
            Ok(json!({
                "success": true,
                "data": read_usage_settings(app)
            }))
        }
        "usageClear" => clear_all_usage(app).map(|_| json!({ "success": true })),
        _ => unreachable!(),
    };

    Some(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registrable_domain_merges_subdomains() {
        assert_eq!(registrable_domain("rr3---sn-xxx.googlevideo.com"), "googlevideo.com");
        assert_eq!(registrable_domain("api.github.com."), "github.com");
        assert_eq!(registrable_domain("sub.example.co.uk"), "example.co.uk");
        assert_eq!(registrable_domain("1.1.1.1"), "1.1.1.1");
        assert_eq!(registrable_domain("2001:db8::1"), "2001:db8::1");
    }

    #[test]
    fn proxy_node_classification() {
        assert!(!is_proxy_node("DIRECT"));
        assert!(!is_proxy_node("reject"));
        assert!(!is_proxy_node("REJECT-DROP"));
        assert!(!is_proxy_node(""));
        assert!(is_proxy_node("Hong Kong 01"));
    }
}
