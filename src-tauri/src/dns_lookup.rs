//! 按 Mihomo 配置里的 nameserver 解析域名，用于确定节点入口地址。
//! 支持普通 UDP、tcp://、https://（DoH）与 system；其余类型（tls://、quic:// 等）跳过。

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::Duration;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const QUERY_TIMEOUT: Duration = Duration::from_secs(4);
const TYPE_A: u16 = 1;
const TYPE_AAAA: u16 = 28;

#[derive(Debug, Default)]
pub(crate) struct LookupResult {
    pub(crate) ipv4: Vec<Ipv4Addr>,
    pub(crate) ipv6: Vec<Ipv6Addr>,
}

impl LookupResult {
    fn is_empty(&self) -> bool {
        self.ipv4.is_empty() && self.ipv6.is_empty()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Nameserver {
    Udp(SocketAddr),
    Tcp(SocketAddr),
    Https(String),
    System,
}

fn socket_addr(host: &str, default_port: u16) -> Option<SocketAddr> {
    if let Ok(addr) = host.parse::<SocketAddr>() {
        return Some(addr);
    }
    let trimmed = host.trim_start_matches('[').trim_end_matches(']');
    trimmed.parse::<IpAddr>().ok().map(|ip| SocketAddr::new(ip, default_port))
}

// 解析一条 nameserver 配置；"#" 之后的出站 / 参数部分不影响直接查询
fn parse_nameserver(raw: &str) -> Option<Nameserver> {
    let value = raw.split('#').next()?.trim();
    if value.is_empty() {
        return None;
    }
    if value == "system" || value.starts_with("system://") || value.starts_with("dhcp://") {
        return Some(Nameserver::System);
    }
    if value.starts_with("https://") {
        return Some(Nameserver::Https(value.to_string()));
    }
    if let Some(rest) = value.strip_prefix("tcp://") {
        return socket_addr(rest, 53).map(Nameserver::Tcp);
    }
    let rest = value.strip_prefix("udp://").unwrap_or(value);
    if rest.contains("://") {
        return None;
    }
    socket_addr(rest, 53).map(Nameserver::Udp)
}

fn build_query(domain: &str, qtype: u16) -> Result<(u16, Vec<u8>), String> {
    if domain.len() > 253 || !domain.is_ascii() {
        return Err("域名格式无效".to_string());
    }
    let mut id_bytes = [0u8; 2];
    getrandom::getrandom(&mut id_bytes).map_err(|err| err.to_string())?;
    let id = u16::from_be_bytes(id_bytes);
    let mut packet = Vec::with_capacity(32 + domain.len());
    packet.extend_from_slice(&id.to_be_bytes());
    packet.extend_from_slice(&[0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0]);
    for label in domain.trim_end_matches('.').split('.') {
        if label.is_empty() || label.len() > 63 {
            return Err("域名格式无效".to_string());
        }
        packet.push(label.len() as u8);
        packet.extend_from_slice(label.as_bytes());
    }
    packet.push(0);
    packet.extend_from_slice(&qtype.to_be_bytes());
    packet.extend_from_slice(&1u16.to_be_bytes());
    Ok((id, packet))
}

// 跳过报文中的域名（标签序列或压缩指针），返回其后的位置
fn skip_name(packet: &[u8], mut pos: usize) -> Option<usize> {
    loop {
        let len = *packet.get(pos)?;
        if len & 0xC0 == 0xC0 {
            packet.get(pos + 1)?;
            return Some(pos + 2);
        }
        if len & 0xC0 != 0 { return None; }
        if len == 0 {
            return Some(pos + 1);
        }
        pos += 1 + len as usize;
    }
}

fn parse_response(packet: &[u8], expected_id: Option<u16>, result: &mut LookupResult) -> Option<()> {
    if packet.len() < 12 || packet[2] & 0x80 == 0 || packet[2] & 0x02 != 0 || packet[3] & 0x0F != 0 {
        return None;
    }
    if let Some(id) = expected_id {
        if u16::from_be_bytes([packet[0], packet[1]]) != id {
            return None;
        }
    }
    let qdcount = u16::from_be_bytes([packet[4], packet[5]]);
    let ancount = u16::from_be_bytes([packet[6], packet[7]]);
    let mut pos = 12;
    for _ in 0..qdcount {
        pos = skip_name(packet, pos)? + 4;
    }
    for _ in 0..ancount {
        pos = skip_name(packet, pos)?;
        let header = packet.get(pos..pos + 10)?;
        let rtype = u16::from_be_bytes([header[0], header[1]]);
        let class = u16::from_be_bytes([header[2], header[3]]);
        let rdlen = u16::from_be_bytes([header[8], header[9]]) as usize;
        pos += 10;
        let data = packet.get(pos..pos + rdlen)?;
        match (if class == 1 { rtype } else { 0 }, rdlen) {
            (TYPE_A, 4) => result.ipv4.push(Ipv4Addr::new(data[0], data[1], data[2], data[3])),
            (TYPE_AAAA, 16) => {
                let bytes: [u8; 16] = data.try_into().ok()?;
                result.ipv6.push(Ipv6Addr::from(bytes));
            }
            _ => {}
        }
        pos += rdlen;
    }
    Some(())
}

async fn query_udp(addr: SocketAddr, query: &[u8]) -> Result<Vec<u8>, String> {
    let bind: SocketAddr = if addr.is_ipv4() { "0.0.0.0:0" } else { "[::]:0" }
        .parse()
        .map_err(|_| "无效的地址".to_string())?;
    let socket = tokio::net::UdpSocket::bind(bind).await.map_err(|err| err.to_string())?;
    socket.connect(addr).await.map_err(|err| err.to_string())?;
    socket.send(query).await.map_err(|err| err.to_string())?;
    let mut buffer = vec![0u8; 4096];
    let len = socket.recv(&mut buffer).await.map_err(|err| err.to_string())?;
    buffer.truncate(len);
    Ok(buffer)
}

async fn query_tcp(addr: SocketAddr, query: &[u8]) -> Result<Vec<u8>, String> {
    let mut stream = tokio::net::TcpStream::connect(addr).await.map_err(|err| err.to_string())?;
    let mut framed = (query.len() as u16).to_be_bytes().to_vec();
    framed.extend_from_slice(query);
    stream.write_all(&framed).await.map_err(|err| err.to_string())?;
    let mut len = [0u8; 2];
    stream.read_exact(&mut len).await.map_err(|err| err.to_string())?;
    let mut buffer = vec![0u8; u16::from_be_bytes(len) as usize];
    stream.read_exact(&mut buffer).await.map_err(|err| err.to_string())?;
    Ok(buffer)
}

async fn query_https(url: &str, query: &[u8]) -> Result<Vec<u8>, String> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(QUERY_TIMEOUT)
        .build()
        .map_err(|err| err.to_string())?;
    let separator = if url.contains('?') { '&' } else { '?' };
    let response = client
        .get(format!("{url}{separator}dns={}", URL_SAFE_NO_PAD.encode(query)))
        .header("Accept", "application/dns-message")
        .send()
        .await
        .map_err(|err| err.to_string())?;
    if !response.status().is_success() {
        return Err(format!("DoH HTTP {}", response.status().as_u16()));
    }
    response.bytes().await.map(|bytes| bytes.to_vec()).map_err(|err| err.to_string())
}

async fn query_one(server: &Nameserver, domain: &str, qtype: u16, result: &mut LookupResult) -> Result<(), String> {
    let (id, query) = build_query(domain, qtype)?;
    let response = tokio::time::timeout(QUERY_TIMEOUT, async {
        match server {
            Nameserver::Udp(addr) => {
                let response = query_udp(*addr, &query).await?;
                if response.get(2).is_some_and(|flags| flags & 0x02 != 0) {
                    query_tcp(*addr, &query).await
                } else { Ok(response) }
            }
            Nameserver::Tcp(addr) => query_tcp(*addr, &query).await,
            Nameserver::Https(url) => query_https(url, &query).await,
            Nameserver::System => Err("system".to_string()),
        }
    })
    .await
    .map_err(|_| "DNS 查询超时".to_string())??;
    // DoH 响应的 id 允许为 0
    let expected = if matches!(server, Nameserver::Https(_)) { None } else { Some(id) };
    parse_response(&response, expected, result).ok_or_else(|| "DNS 响应无法解析".to_string())
}

async fn lookup_system(domain: &str) -> Result<LookupResult, String> {
    let mut result = LookupResult::default();
    let addrs = tokio::time::timeout(QUERY_TIMEOUT, tokio::net::lookup_host((domain, 0)))
        .await
        .map_err(|_| "DNS 查询超时".to_string())?
        .map_err(|err| err.to_string())?;
    for addr in addrs {
        match addr.ip() {
            IpAddr::V4(ip) => result.ipv4.push(ip),
            IpAddr::V6(ip) => result.ipv6.push(ip),
        }
    }
    Ok(result)
}

/// 依次尝试给定的 nameserver，返回第一个有结果的解析；列表为空时使用系统解析
pub(crate) async fn lookup(domain: &str, nameservers: &[String]) -> Result<LookupResult, String> {
    let servers: Vec<Nameserver> = nameservers.iter().filter_map(|raw| parse_nameserver(raw)).collect();
    if servers.is_empty() {
        return if nameservers.is_empty() { lookup_system(domain).await }
            else { Err("配置中没有受支持的 DNS 服务器".to_string()) };
    }
    let mut last_error = "没有可用的 DNS 服务器".to_string();
    for server in &servers {
        if *server == Nameserver::System {
            match lookup_system(domain).await {
                Ok(result) if !result.is_empty() => return Ok(result),
                Ok(_) => last_error = "没有解析结果".to_string(),
                Err(error) => last_error = error,
            }
            continue;
        }
        let mut result = LookupResult::default();
        let v4 = query_one(server, domain, TYPE_A, &mut result).await;
        if result.ipv4.is_empty() {
            let _ = query_one(server, domain, TYPE_AAAA, &mut result).await;
        }
        if !result.is_empty() {
            return Ok(result);
        }
        last_error = v4.err().unwrap_or_else(|| "没有解析结果".to_string());
    }
    Err(last_error)
}

/// Mihomo nameserver-policy 的域名匹配：
/// "+.example.com" 匹配自身及所有子域，"*.example.com" 匹配一级子域，"." 开头匹配子域，其余为精确匹配
pub(crate) fn policy_matches(pattern: &str, domain: &str) -> bool {
    let pattern = pattern.trim().to_ascii_lowercase();
    let domain = domain.trim().trim_end_matches('.').to_ascii_lowercase();
    if pattern.contains(':') {
        // geosite: / rule-set: 等需要规则数据，这里不处理
        return false;
    }
    if let Some(suffix) = pattern.strip_prefix("+.") {
        return domain == suffix || domain.ends_with(&format!(".{suffix}"));
    }
    if let Some(suffix) = pattern.strip_prefix("*.") {
        return domain
            .strip_suffix(&format!(".{suffix}"))
            .is_some_and(|label| !label.is_empty() && !label.contains('.'));
    }
    if let Some(suffix) = pattern.strip_prefix('.') {
        return domain.ends_with(&format!(".{suffix}"));
    }
    domain == pattern
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_nameserver_formats() {
        assert_eq!(parse_nameserver("223.5.5.5"), Some(Nameserver::Udp("223.5.5.5:53".parse().unwrap())));
        assert_eq!(parse_nameserver("udp://1.1.1.1:5353"), Some(Nameserver::Udp("1.1.1.1:5353".parse().unwrap())));
        assert_eq!(parse_nameserver("tcp://8.8.8.8"), Some(Nameserver::Tcp("8.8.8.8:53".parse().unwrap())));
        assert_eq!(
            parse_nameserver("https://dns.alidns.com/dns-query#DIRECT"),
            Some(Nameserver::Https("https://dns.alidns.com/dns-query".to_string()))
        );
        assert_eq!(parse_nameserver("system"), Some(Nameserver::System));
        assert_eq!(parse_nameserver("tls://1.1.1.1"), None);
        assert_eq!(parse_nameserver("dns.google"), None);
    }

    #[test]
    fn matches_policy_patterns() {
        assert!(policy_matches("+.example.com", "example.com"));
        assert!(policy_matches("+.example.com", "a.b.example.com"));
        assert!(policy_matches("*.example.com", "a.example.com"));
        assert!(!policy_matches("*.example.com", "a.b.example.com"));
        assert!(policy_matches("example.com", "example.com"));
        assert!(!policy_matches("example.com", "a.example.com"));
        assert!(!policy_matches("geosite:cn", "baidu.com"));
    }

    #[test]
    fn parses_compressed_answers() {
        let (id, mut packet) = build_query("a.example.com", TYPE_A).unwrap();
        packet[2] = 0x81;
        packet[3] = 0x80;
        packet[7] = 1;
        packet.extend_from_slice(&[0xC0, 0x0C, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 1, 2, 3, 4]);
        let mut result = LookupResult::default();
        parse_response(&packet, Some(id), &mut result).unwrap();
        assert_eq!(result.ipv4, vec![Ipv4Addr::new(1, 2, 3, 4)]);
    }
}
