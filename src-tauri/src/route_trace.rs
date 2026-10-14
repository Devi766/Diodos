use std::{net::Ipv4Addr, process::{Command, Stdio}, time::{Duration, Instant}};
use serde_json::{json, Value};

fn bounded_output(mut command: Command, timeout: Duration) -> Result<String, String> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    let started = Instant::now();
    loop {
        if child.try_wait().map_err(|e| e.to_string())?.is_some() { break; }
        if started.elapsed() > timeout {
            let _ = child.kill(); let _ = child.wait(); return Err("probe_timeout".into());
        }
        std::thread::sleep(Duration::from_millis(15));
    }
    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    Ok(format!("{}\n{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr)))
}

// 只选择具有默认网关的物理网卡，避免探测包进入 TUN 虚拟接口
fn physical_source() -> Result<String, String> {
    #[cfg(windows)]
    {
        let mut command = Command::new("powershell.exe");
        command.args(["-NoProfile", "-NonInteractive", "-Command", r#"$ErrorActionPreference='Stop'; $ids=@(Get-NetAdapter -Physical | Where-Object Status -eq 'Up' | ForEach-Object ifIndex); $route=Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' | Where-Object { $ids -contains $_.ifIndex -and $_.NextHop -ne '0.0.0.0' } | Sort-Object RouteMetric | Select-Object -First 1; if($route){ Get-NetIPAddress -AddressFamily IPv4 -InterfaceIndex $route.ifIndex | Where-Object { $_.AddressState -eq 'Preferred' -and -not $_.SkipAsSource } | Select-Object -First 1 -ExpandProperty IPAddress }"#]);
        let text = bounded_output(command, Duration::from_secs(8))?;
        return text.lines().find_map(|line| line.trim().parse::<Ipv4Addr>().ok()).map(|ip| ip.to_string()).ok_or("physical_interface_unavailable".into());
    }
    #[cfg(target_os = "macos")]
    {
        let mut command = Command::new("/sbin/route"); command.args(["-n", "get", "default"]);
        let text = bounded_output(command, Duration::from_secs(3))?;
        let interface = text.lines().find_map(|line| line.trim().strip_prefix("interface:").map(str::trim)).filter(|name| !name.starts_with("utun")).ok_or("physical_interface_unavailable")?;
        let mut command = Command::new("/usr/sbin/ipconfig"); command.args(["getifaddr", interface]);
        let ip = bounded_output(command, Duration::from_secs(3))?.trim().parse::<Ipv4Addr>().map_err(|_| "physical_interface_unavailable")?;
        return Ok(ip.to_string());
    }
    #[cfg(target_os = "linux")]
    {
        let mut command = Command::new("ip"); command.args(["-j", "route", "show", "default", "table", "main"]);
        let routes: Value = serde_json::from_str(&bounded_output(command, Duration::from_secs(3))?).map_err(|e| e.to_string())?;
        let interface = routes.as_array().into_iter().flatten().filter_map(|r| r.get("dev").and_then(Value::as_str)).find(|name| !["tun", "tap", "utun", "mihomo", "clash"].iter().any(|prefix| name.starts_with(prefix))).ok_or("physical_interface_unavailable")?;
        let mut command = Command::new("ip"); command.args(["-j", "-4", "addr", "show", "dev", interface]);
        let addresses: Value = serde_json::from_str(&bounded_output(command, Duration::from_secs(3))?).map_err(|e| e.to_string())?;
        let ip = addresses.as_array().into_iter().flatten().flat_map(|r| r.get("addr_info").and_then(Value::as_array).into_iter().flatten()).filter(|a| a.get("scope").and_then(Value::as_str) == Some("global")).find_map(|a| a.get("local").and_then(Value::as_str)).ok_or("physical_interface_unavailable")?;
        return Ok(ip.to_string());
    }
    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    Err("unsupported_platform".into())
}

#[cfg(windows)]
fn probe_once(target: Ipv4Addr, source: Ipv4Addr, ttl: u8, timeout: u32) -> Result<Option<(Ipv4Addr, f64, bool)>, String> {
    use std::ffi::c_void;
    #[repr(C)]
    struct Options { ttl: u8, tos: u8, flags: u8, size: u8, data: u32 }
    #[link(name = "iphlpapi")]
    extern "system" {
        fn IcmpCreateFile() -> *mut c_void;
        fn IcmpCloseHandle(handle: *mut c_void) -> i32;
        fn IcmpSendEcho2Ex(handle: *mut c_void, event: *mut c_void, apc: *mut c_void, context: *mut c_void,
            source: u32, target: u32, data: *const u8, size: u16, options: *const Options,
            reply: *mut c_void, reply_size: u32, timeout: u32) -> u32;
    }
    #[link(name = "kernel32")]
    extern "system" { fn GetLastError() -> u32; }
    let handle = unsafe { IcmpCreateFile() };
    if handle as isize == -1 { return Err("icmp_unavailable".into()); }
    let options = Options { ttl, tos: 0, flags: 0, size: 0, data: 0 };
    let payload = b"FlyClash-route";
    let mut buffer = vec![0u32; 256];
    let start = Instant::now();
    let count = unsafe { IcmpSendEcho2Ex(handle, std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut(),
        u32::from_ne_bytes(source.octets()), u32::from_ne_bytes(target.octets()), payload.as_ptr(), payload.len() as u16,
        &options, buffer.as_mut_ptr().cast(), (buffer.len() * 4) as u32, timeout) };
    let error = unsafe { GetLastError() };
    unsafe { IcmpCloseHandle(handle); }
    if count == 0 {
        return if matches!(error, 11010 | 11013 | 11003 | 11002) { Ok(None) } else { Err(format!("icmp_error:{error}")) };
    }
    // 两种位宽的回复结构前十二字节都依次为地址、状态和毫秒延迟
    let ip = Ipv4Addr::from(buffer[0].to_ne_bytes());
    let status = buffer[1];
    if !matches!(status, 0 | 11013) || ip.is_unspecified() { return Ok(None); }
    let rtt = if buffer[2] > 0 { buffer[2] as f64 } else { start.elapsed().as_secs_f64() * 1000.0 };
    Ok(Some((ip, rtt, status == 0 && ip == target)))
}

#[cfg(not(windows))]
fn probe_once(target: Ipv4Addr, source: Ipv4Addr, ttl: u8, timeout: u32) -> Result<Option<(Ipv4Addr, f64, bool)>, String> {
    let mut command = Command::new("ping");
    command.env("LC_ALL", "C");
    #[cfg(target_os = "macos")]
    command.args(["-n", "-c", "1", "-m", &ttl.to_string(), "-W", &timeout.to_string(), "-S", &source.to_string(), &target.to_string()]);
    #[cfg(not(target_os = "macos"))]
    command.args(["-n", "-c", "1", "-t", &ttl.to_string(), "-W", &((timeout + 999) / 1000).to_string(), "-I", &source.to_string(), &target.to_string()]);
    let start = Instant::now();
    let output = match bounded_output(command, Duration::from_millis(timeout as u64 + 500)) {
        Ok(output) => output, Err(e) if e == "probe_timeout" => return Ok(None), Err(e) => return Err(e),
    };
    parse_ping(&output, target, start.elapsed().as_secs_f64() * 1000.0)
}

#[cfg(any(not(windows), test))]
fn parse_ping(text: &str, target: Ipv4Addr, elapsed: f64) -> Result<Option<(Ipv4Addr, f64, bool)>, String> {
    let ip_pattern = regex::Regex::new(r"(?:from|From)\s+(?:[^\s(]+\s+\()?((?:\d{1,3}\.){3}\d{1,3})").map_err(|e| e.to_string())?;
    let time_pattern = regex::Regex::new(r"time[=<]\s*([\d.]+)").map_err(|e| e.to_string())?;
    for line in text.lines() {
        let lower = line.to_lowercase();
        let echo = lower.contains("bytes from") && lower.contains("time");
        let transit = lower.contains("time to live exceeded") || lower.contains("ttl expired") || lower.contains("time exceeded");
        if !echo && !transit { continue; }
        if let Some(ip) = ip_pattern.captures(line).and_then(|c| c[1].parse::<Ipv4Addr>().ok()) {
            let rtt = time_pattern.captures(line).and_then(|c| c[1].parse::<f64>().ok()).unwrap_or(elapsed);
            return Ok(Some((ip, rtt, echo && ip == target)));
        }
    }
    if text.contains("Operation not permitted") || text.contains("Permission denied") { return Err("icmp_permission_required".into()); }
    Ok(None)
}

fn probe(target: Ipv4Addr, source: Ipv4Addr, ttl: u8, count: usize, timeout: u32) -> Result<Value, String> {
    let mut samples = Vec::new();
    let mut ip = None;
    let mut reached = false;
    for _ in 0..count {
        if let Some((address, rtt, done)) = probe_once(target, source, ttl, timeout)? {
            // 同一跳的 RTT 只累计到同一个回应地址，避免混合负载均衡路径
            if ip.is_none() { ip = Some(address); }
            if ip == Some(address) { samples.push(rtt); }
            reached |= done;
        }
    }
    let replies = samples.len();
    let avg = if replies > 0 { Some(samples.iter().sum::<f64>() / replies as f64) } else { None };
    Ok(json!({"ttl":ttl,"ip":ip.map(|v|v.to_string()),"sent":count,"received":replies,
        "loss":100.0*(count-replies) as f64/count as f64,"avg":avg,
        "min":samples.iter().copied().reduce(f64::min),"max":samples.iter().copied().reduce(f64::max),"reached":reached}))
}

fn valid_target_ip(ip: Ipv4Addr) -> bool {
    let [a, b, ..] = ip.octets();
    !(ip.is_unspecified() || ip.is_loopback() || ip.is_broadcast() || ip.is_multicast() || a == 0 || a >= 240 || (a == 198 && (b == 18 || b == 19)))
}

async fn resolve_target(raw: &str) -> Result<Value, String> {
    let target = raw.trim().trim_end_matches('.');
    if let Ok(ip) = target.parse::<Ipv4Addr>() {
        return if valid_target_ip(ip) { Ok(json!({"ip":ip.to_string()})) } else { Err("invalid_probe_address".into()) };
    }
    if target.parse::<std::net::Ipv6Addr>().is_ok() { return Err("ipv6_only".into()); }
    if target.is_empty() || target.len() > 253 || !target.is_ascii() || target.split('.').any(|label| label.is_empty() || label.len() > 63
        || label.starts_with('-') || label.ends_with('-') || !label.bytes().all(|c|c.is_ascii_alphanumeric() || c == b'-')) {
        return Err("invalid_target".into());
    }
    let lookup = crate::dns_lookup::lookup(target, &[]).await;
    if let Ok(result) = &lookup {
        if let Some(ip) = result.ipv4.iter().find(|ip| valid_target_ip(**ip)) { return Ok(json!({"ip":ip.to_string()})); }
    }
    // 系统解析返回 fake-ip 时，以公开 DoH 查询真实地址
    let servers = vec!["https://cloudflare-dns.com/dns-query".into(), "https://dns.google/dns-query".into()];
    let result = tokio::time::timeout(Duration::from_secs(10), crate::dns_lookup::lookup(target, &servers)).await.map_err(|_|"dns_failed")??;
    if let Some(ip) = result.ipv4.iter().find(|ip|valid_target_ip(**ip)) { return Ok(json!({"ip":ip.to_string()})); }
    Err(if !result.ipv6.is_empty() { "ipv6_only" } else { "dns_failed" }.into())
}

pub(crate) async fn handle_compat_call(method: &str, args: &[Value]) -> Option<Result<Value, String>> {
    if method == "resolveRouteTarget" {
        return Some(resolve_target(args.first().and_then(Value::as_str).unwrap_or("")).await);
    }
    if method == "prepareRouteTrace" {
        return Some(tauri::async_runtime::spawn_blocking(|| physical_source().map(|source| json!({"source":source}))).await.map_err(|e|e.to_string()).and_then(|v|v));
    }
    if method != "probeHop" { return None; }
    let options = args.first().cloned().unwrap_or(Value::Null);
    let target = options.get("target").and_then(Value::as_str).and_then(|v|v.parse::<Ipv4Addr>().ok());
    let source = options.get("source").and_then(Value::as_str).and_then(|v|v.parse::<Ipv4Addr>().ok());
    let (Some(target), Some(source)) = (target, source) else { return Some(Err("invalid_probe_address".into())); };
    if !valid_target_ip(target) || source.is_unspecified() || source.is_loopback() {
        return Some(Err("invalid_probe_address".into()));
    }
    let ttl = options.get("ttl").and_then(Value::as_u64).unwrap_or(1).clamp(1, 24) as u8;
    let count = options.get("count").and_then(Value::as_u64).unwrap_or(3).clamp(1, 3) as usize;
    let timeout = options.get("timeoutMs").and_then(Value::as_u64).unwrap_or(1000).clamp(200, 2000) as u32;
    Some(tauri::async_runtime::spawn_blocking(move || probe(target, source, ttl, count, timeout)).await.map_err(|e|e.to_string()).and_then(|v|v))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn validates_tool_targets_without_network_requests() {
        assert_eq!(resolve_target("192.168.1.1").await.unwrap()["ip"], "192.168.1.1");
        assert!(resolve_target("127.0.0.1").await.is_err());
        assert!(resolve_target("198.18.0.1").await.is_err());
        assert_eq!(resolve_target("2001:db8::1").await.unwrap_err(), "ipv6_only");
        assert_eq!(resolve_target("https://example.com/a").await.unwrap_err(), "invalid_target");
    }
    #[test]
    fn parses_echo_and_ttl_without_parsing_banner_as_reply() {
        let target = "1.1.1.1".parse().unwrap();
        assert!(parse_ping("PING 1.1.1.1 (1.1.1.1)", target, 1000.0).unwrap().is_none());
        let reply = parse_ping("64 bytes from 1.1.1.1: icmp_seq=1 ttl=57 time=12.4 ms", target, 20.0).unwrap().unwrap();
        assert!(reply.2); assert_eq!(reply.1, 12.4);
        let expired = parse_ping("From 192.168.1.1 icmp_seq=1 Time to live exceeded", target, 3.0).unwrap().unwrap();
        assert!(!expired.2); assert_eq!(expired.0.to_string(), "192.168.1.1");
    }

    #[cfg(windows)]
    #[test]
    #[ignore]
    fn live_physical_icmp_probe() {
        let source = physical_source().expect("physical IPv4 interface").parse().unwrap();
        let result = probe_once("1.1.1.1".parse().unwrap(), source, 1, 700).expect("native ICMP request accepted");
        println!("native ICMP: {}", if result.is_some() { "hop replied" } else { "no reply within timeout" });
    }
}
