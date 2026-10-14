//! 读取进程的 IPv4 TCP 连接远端地址。
//!
//! - Windows：GetExtendedTcpTable（TCP_TABLE_OWNER_PID_ALL），按 PID 过滤，无需管理员；
//! - macOS：proc_pidinfo 列出 socket 描述符，再用 proc_pidfdinfo 读取远端地址，需要与目标进程同一用户；
//! - Linux：读取 /proc/<pid>/fd 的 socket inode，与 /proc/<pid>/net/tcp 对应；读不到 fd 时返回错误。

use std::net::Ipv4Addr;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) struct RemoteEndpoint {
    pub(crate) ip: Ipv4Addr,
    pub(crate) port: u16,
    pub(crate) local_port: u16,
}

/// 连接表快照。`owned_by_pid` 表示结果确实只包含该进程的连接；
/// 读取失败时返回错误，避免把其他进程的连接误认为内核入口。
pub(crate) struct TcpSnapshot {
    pub(crate) endpoints: Vec<RemoteEndpoint>,
    pub(crate) owned_by_pid: bool,
}

#[cfg(target_os = "windows")]
pub(crate) fn snapshot(pid: Option<u32>) -> Result<TcpSnapshot, String> {
    use std::ffi::c_void;

    const AF_INET: u32 = 2;
    const TCP_TABLE_OWNER_PID_ALL: u32 = 5;
    const NO_ERROR: u32 = 0;
    const ERROR_INSUFFICIENT_BUFFER: u32 = 122;
    const MIB_TCP_STATE_LISTEN: u32 = 2;

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct MibTcpRowOwnerPid {
        state: u32,
        local_addr: u32,
        local_port: u32,
        remote_addr: u32,
        remote_port: u32,
        owning_pid: u32,
    }

    #[link(name = "iphlpapi")]
    extern "system" {
        fn GetExtendedTcpTable(
            table: *mut c_void,
            size: *mut u32,
            order: i32,
            address_family: u32,
            table_class: u32,
            reserved: u32,
        ) -> u32;
    }

    let pid = pid.ok_or_else(|| "未知内核进程".to_string())?;
    let mut size: u32 = 0;
    let mut buffer: Vec<u32> = Vec::new();
    let mut status = ERROR_INSUFFICIENT_BUFFER;
    // 两次调用之间连接数可能增长，多试几次
    for _ in 0..4 {
        unsafe {
            status = GetExtendedTcpTable(
                if buffer.is_empty() { std::ptr::null_mut() } else { buffer.as_mut_ptr().cast() },
                &mut size,
                0,
                AF_INET,
                TCP_TABLE_OWNER_PID_ALL,
                0,
            );
        }
        if status != ERROR_INSUFFICIENT_BUFFER {
            break;
        }
        buffer = vec![0u32; (size as usize).div_ceil(4) + 64];
        size = (buffer.len() * 4) as u32;
    }
    if status != NO_ERROR {
        return Err(format!("GetExtendedTcpTable 失败: {status}"));
    }

    let count = buffer.first().copied().unwrap_or(0) as usize;
    let row_words = std::mem::size_of::<MibTcpRowOwnerPid>() / 4;
    let mut endpoints = Vec::new();
    for index in 0..count {
        let start = 1 + index * row_words;
        let Some(words) = buffer.get(start..start + row_words) else {
            break;
        };
        let row = MibTcpRowOwnerPid {
            state: words[0],
            local_addr: words[1],
            local_port: words[2],
            remote_addr: words[3],
            remote_port: words[4],
            owning_pid: words[5],
        };
        if row.state == MIB_TCP_STATE_LISTEN {
            continue;
        }
        if pid != row.owning_pid {
            continue;
        }
        // 地址与端口均为网络字节序
        let ip = Ipv4Addr::from(row.remote_addr.to_le_bytes());
        let port = u16::from_be((row.remote_port & 0xFFFF) as u16);
        let _ = row.local_addr;
        let local_port = u16::from_be((row.local_port & 0xFFFF) as u16);
        endpoints.push(RemoteEndpoint { ip, port, local_port });
    }
    Ok(TcpSnapshot { endpoints, owned_by_pid: true })
}

#[cfg(target_os = "macos")]
pub(crate) fn snapshot(pid: Option<u32>) -> Result<TcpSnapshot, String> {
    use std::ffi::c_void;

    const PROC_PIDLISTFDS: i32 = 1;
    const PROC_PIDFDSOCKETINFO: i32 = 3;
    const PROX_FDTYPE_SOCKET: u32 = 2;
    const SOCKINFO_TCP: i32 = 2;
    const AF_INET: i32 = 2;
    const AF_INET6: i32 = 30;
    const INI_IPV4: u8 = 0x1;

    // struct socket_fdinfo 中用到的字段偏移（bsd/sys/proc_info.h）：
    // proc_fileinfo 24 字节之后是 socket_info；soi_family 位于 socket_info + 160，
    // soi_kind 位于 + 232，soi_proto 联合体位于 + 240；in_sockinfo 内
    // insi_fport 偏移 0，insi_vflag 偏移 24，insi_faddr 偏移 32（IPv4 地址在其 + 12）
    const PSI: usize = 24;
    const SOI_FAMILY: usize = PSI + 160;
    const SOI_KIND: usize = PSI + 232;
    const SOI_PROTO: usize = PSI + 240;
    const INSI_FPORT: usize = SOI_PROTO;
    const INSI_VFLAG: usize = SOI_PROTO + 24;
    const INSI_FADDR_V4: usize = SOI_PROTO + 32 + 12;
    const SOCKET_FDINFO_MIN: usize = INSI_FADDR_V4 + 4;

    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    struct ProcFdInfo {
        proc_fd: i32,
        proc_fdtype: u32,
    }

    #[link(name = "proc")]
    extern "C" {
        fn proc_pidinfo(pid: i32, flavor: i32, arg: u64, buffer: *mut c_void, size: i32) -> i32;
        fn proc_pidfdinfo(pid: i32, fd: i32, flavor: i32, buffer: *mut c_void, size: i32) -> i32;
    }

    let pid = pid.ok_or_else(|| "未知内核进程".to_string())? as i32;
    let needed = unsafe { proc_pidinfo(pid, PROC_PIDLISTFDS, 0, std::ptr::null_mut(), 0) };
    if needed <= 0 {
        return Err("无法读取内核进程的描述符".to_string());
    }
    let capacity = needed as usize / std::mem::size_of::<ProcFdInfo>() + 32;
    let mut fds = vec![ProcFdInfo::default(); capacity];
    let written = unsafe {
        proc_pidinfo(
            pid,
            PROC_PIDLISTFDS,
            0,
            fds.as_mut_ptr().cast(),
            (fds.len() * std::mem::size_of::<ProcFdInfo>()) as i32,
        )
    };
    if written <= 0 {
        return Err("无法读取内核进程的描述符".to_string());
    }
    fds.truncate(written as usize / std::mem::size_of::<ProcFdInfo>());

    let read_i32 = |buf: &[u8], offset: usize| i32::from_ne_bytes(buf[offset..offset + 4].try_into().unwrap());
    let mut endpoints = Vec::new();
    let mut info = vec![0u8; 2048];
    for fd in fds.iter().filter(|fd| fd.proc_fdtype == PROX_FDTYPE_SOCKET) {
        let size = unsafe {
            proc_pidfdinfo(pid, fd.proc_fd, PROC_PIDFDSOCKETINFO, info.as_mut_ptr().cast(), info.len() as i32)
        };
        if size <= 0 || (size as usize) < SOCKET_FDINFO_MIN {
            continue;
        }
        let family = read_i32(&info, SOI_FAMILY);
        if read_i32(&info, SOI_KIND) != SOCKINFO_TCP || (family != AF_INET && family != AF_INET6) {
            continue;
        }
        // 双栈 socket 上的 IPv4 连接同样带 INI_IPV4 标记
        if info[INSI_VFLAG] & INI_IPV4 == 0 {
            continue;
        }
        let port = u16::from_be((read_i32(&info, INSI_FPORT) & 0xFFFF) as u16);
        let ip = Ipv4Addr::new(
            info[INSI_FADDR_V4],
            info[INSI_FADDR_V4 + 1],
            info[INSI_FADDR_V4 + 2],
            info[INSI_FADDR_V4 + 3],
        );
        if port == 0 || ip.is_unspecified() {
            continue;
        }
        let local_port = u16::from_be((read_i32(&info, INSI_FPORT + 4) & 0xFFFF) as u16);
        endpoints.push(RemoteEndpoint { ip, port, local_port });
    }
    Ok(TcpSnapshot { endpoints, owned_by_pid: true })
}

#[cfg(target_os = "linux")]
pub(crate) fn snapshot(pid: Option<u32>) -> Result<TcpSnapshot, String> {
    use std::collections::HashSet;
    use std::fs;

    // 内核进程持有的 socket inode；读不到（权限不足）时返回 None
    let inodes = pid.and_then(|pid| {
        let entries = fs::read_dir(format!("/proc/{pid}/fd")).ok()?;
        let set: HashSet<u64> = entries
            .filter_map(|entry| fs::read_link(entry.ok()?.path()).ok())
            .filter_map(|target| {
                let text = target.to_string_lossy().to_string();
                text.strip_prefix("socket:[")?.strip_suffix(']')?.parse().ok()
            })
            .collect();
        Some(set)
    });
    let pid = pid.ok_or_else(|| "未知内核进程".to_string())?;
    let inodes = inodes.ok_or_else(|| "内核连接表权限不足".to_string())?;
    let table = fs::read_to_string(format!("/proc/{pid}/net/tcp")).map_err(|err| err.to_string())?;

    let mut endpoints = Vec::new();
    for line in table.lines().skip(1) {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 10 {
            continue;
        }
        // 0A 为 LISTEN
        if fields[3] == "0A" {
            continue;
        }
        {
            let Ok(inode) = fields[9].parse::<u64>() else { continue };
            if !inodes.contains(&inode) {
                continue;
            }
        }
        let Some((addr, port)) = fields[2].split_once(':') else { continue };
        let (Ok(addr), Ok(port)) = (u32::from_str_radix(addr, 16), u16::from_str_radix(port, 16)) else {
            continue;
        };
        // 地址按本机字节序打印的网络序整数
        let local_port = fields[1].split_once(':').and_then(|(_, p)| u16::from_str_radix(p, 16).ok()).unwrap_or(0);
        endpoints.push(RemoteEndpoint { ip: Ipv4Addr::from(addr.to_ne_bytes()), port, local_port });
    }
    Ok(TcpSnapshot { endpoints, owned_by_pid: true })
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
pub(crate) fn snapshot(_pid: Option<u32>) -> Result<TcpSnapshot, String> {
    Err("当前平台不支持读取连接表".to_string())
}

/// 可作为入口服务器的公网 IPv4：排除私网、回环、链路本地、CGNAT、保留与 fake-ip 网段
pub(crate) fn is_public_ipv4(ip: Ipv4Addr) -> bool {
    let [a, b, ..] = ip.octets();
    !(ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_broadcast()
        || ip.is_multicast()
        || ip.is_documentation()
        || a == 0
        || a >= 240
        || (a == 100 && (64..128).contains(&b))
        || (a == 198 && (b == 18 || b == 19)))
}
