/**
 * 代理模型定义
 * 对应安卓端的 ProxyModels.kt
 */

/**
 * 代理基类
 */
class Proxy {
  constructor(name, type) {
    this.name = name;
    this.type = type;
  }
}

/**
 * Shadowsocks 代理
 */
class Shadowsocks extends Proxy {
  constructor(params) {
    super(params.name, 'ss');
    this.server = params.server;
    this.port = params.port;
    this.cipher = params.cipher;
    this.password = params.password;
    this.plugin = params.plugin || null;
    this.pluginOpts = params.pluginOpts || null;
    this.udp = params.udp !== undefined ? params.udp : true;
    // Shadowsocks 2022 扩展
    this.udpOverTcp = params.udpOverTcp || false;
    this.network = params.network || null;
    this.tfo = params.tfo || false;
    this.psk = params.psk || null;
    this.shortId = params.shortId || null;
  }
}

/**
 * VMess 代理
 */
class VMess extends Proxy {
  constructor(params) {
    super(params.name, 'vmess');
    this.server = params.server;
    this.port = params.port;
    this.uuid = params.uuid;
    this.alterId = params.alterId || 0;
    this.cipher = params.cipher || 'auto';
    this.tls = params.tls || false;
    this.skipCertVerify = params.skipCertVerify || false;
    this.servername = params.servername || null;
    this.network = params.network || 'tcp';
    this.wsOpts = params.wsOpts || null;
    this.h2Opts = params.h2Opts || null;
    this.httpOpts = params.httpOpts || null;
    this.grpcOpts = params.grpcOpts || null;
    this.udp = params.udp !== undefined ? params.udp : true;
  }
}

/**
 * Trojan 代理
 */
class Trojan extends Proxy {
  constructor(params) {
    super(params.name, 'trojan');
    this.server = params.server;
    this.port = params.port;
    this.password = params.password;
    this.sni = params.sni || null;
    this.skipCertVerify = params.skipCertVerify || false;
    this.network = params.network || 'tcp';
    this.wsOpts = params.wsOpts || null;
    this.grpcOpts = params.grpcOpts || null;
    this.udp = params.udp !== undefined ? params.udp : true;
  }
}

/**
 * VLESS 代理
 */
class VLESS extends Proxy {
  constructor(params) {
    super(params.name, 'vless');
    this.server = params.server;
    this.port = params.port;
    this.uuid = params.uuid;
    this.flow = params.flow || null;
    this.tls = params.tls || false;
    this.skipCertVerify = params.skipCertVerify || false;
    this.servername = params.servername || null;
    this.network = params.network || 'tcp';
    this.wsOpts = params.wsOpts || null;
    this.grpcOpts = params.grpcOpts || null;
    this.reality = params.reality || null;
    this.udp = params.udp !== undefined ? params.udp : true;
  }
}

/**
 * Socks5 代理
 */
class Socks5 extends Proxy {
  constructor(params) {
    super(params.name, 'socks5');
    this.server = params.server;
    this.port = params.port;
    this.username = params.username || null;
    this.password = params.password || null;
    this.tls = params.tls || false;
    this.skipCertVerify = params.skipCertVerify || false;
    this.udp = params.udp !== undefined ? params.udp : true;
  }
}

/**
 * HTTP 代理
 */
class Http extends Proxy {
  constructor(params) {
    super(params.name, 'http');
    this.server = params.server;
    this.port = params.port;
    this.username = params.username || null;
    this.password = params.password || null;
    this.tls = params.tls || false;
    this.skipCertVerify = params.skipCertVerify || false;
  }
}

/**
 * Hysteria 代理
 */
class Hysteria extends Proxy {
  constructor(params) {
    super(params.name, 'hysteria');
    this.server = params.server;
    this.port = params.port;
    this.protocol = params.protocol || 'udp';
    this.up = params.up || null;
    this.down = params.down || null;
    this.auth = params.auth || null;
    this.obfs = params.obfs || null;
    this.alpn = params.alpn || [];
    this.sni = params.sni || null;
    this.skipCertVerify = params.skipCertVerify || false;
  }
}

/**
 * Hysteria2 代理
 */
class Hysteria2 extends Proxy {
  constructor(params) {
    super(params.name, 'hysteria2');
    this.server = params.server;
    this.port = params.port;
    this.password = params.password;
    this.obfs = params.obfs || null;
    this.obfsPassword = params.obfsPassword || null;
    this.sni = params.sni || null;
    this.skipCertVerify = params.skipCertVerify || false;
    this.up = params.up || null;
    this.down = params.down || null;
    this.alpn = params.alpn || [];
    this.hopInterval = params.hopInterval || null;
  }
}

/**
 * TUIC 代理
 */
class TUIC extends Proxy {
  constructor(params) {
    super(params.name, 'tuic');
    this.server = params.server;
    this.port = params.port;
    this.uuid = params.uuid;
    this.password = params.password;
    this.version = params.version || 5;
    this.alpn = params.alpn || [];
    this.sni = params.sni || null;
    this.skipCertVerify = params.skipCertVerify || false;
    this.congestionController = params.congestionController || 'bbr';
    this.udpRelayMode = params.udpRelayMode || 'native';
    this.hopInterval = params.hopInterval || null;
    // 高级参数
    this.reduceRtt = params.reduceRtt || false;
    this.disableSni = params.disableSni || false;
    this.udpOverStream = params.udpOverStream || false;
    this.heartbeatInterval = params.heartbeatInterval || null; // 毫秒
  }
}

/**
 * WireGuard 代理
 */
class WireGuard extends Proxy {
  constructor(params) {
    super(params.name, 'wireguard');
    this.server = params.server;
    this.port = params.port;
    this.privateKey = params.privateKey;
    this.publicKey = params.publicKey;
    this.presharedKey = params.presharedKey || null;
    this.ip = params.ip;
    this.ipv6 = params.ipv6 || null;
    this.mtu = params.mtu || 1420;
    this.udp = true;
  }
}

/**
 * ShadowsocksR 代理
 */
class ShadowsocksR extends Proxy {
  constructor(params) {
    super(params.name, 'ssr');
    this.server = params.server;
    this.port = params.port;
    this.protocol = params.protocol;
    this.cipher = params.cipher;
    this.obfs = params.obfs;
    this.password = params.password;
    this.protocolParam = params.protocolParam || null;
    this.obfsParam = params.obfsParam || null;
    this.udp = params.udp !== undefined ? params.udp : true;
  }
}

/**
 * Snell 代理
 * 主要用于 Clash.Meta / Surge 等客户端
 */
class Snell extends Proxy {
  constructor(params) {
    super(params.name, 'snell');
    this.server = params.server;
    this.port = params.port;
    this.psk = params.psk;
    this.version = params.version || 3;
    this.ipVersion = params.ipVersion || null;
    this.udp = params.udp !== undefined ? params.udp : true;
    this.tfo = params.tfo || false;
    this.obfs = params.obfs || null;
    this.obfsHost = params.obfsHost || null;
    this.obfsUri = params.obfsUri || null;
  }
}

/**
 * SSH 代理
 */
class SSH extends Proxy {
  constructor(params) {
    super(params.name, 'ssh');
    this.server = params.server;
    this.port = params.port;
    this.username = params.username;
    this.password = params.password || null;
    this.privateKey = params.privateKey || null;
    this.privateKeyPassphrase = params.privateKeyPassphrase || null;
    this.serverFingerprint = params.serverFingerprint || null;
    this.hostKey = params.hostKey || null;
    this.hostKeyAlgorithms = params.hostKeyAlgorithms || null;
    this.sni = params.sni || null;
    this.skipCertVerify = params.skipCertVerify || false;
    this.tfo = params.tfo || false;
  }
}

/**
 * AnyTLS 代理
 */
class AnyTLS extends Proxy {
  constructor(params) {
    super(params.name, 'anytls');
    this.server = params.server;
    this.port = params.port;
    this.password = params.password;
    this.sni = params.sni || null;
    this.reality = params.reality || null;
    this.udp = params.udp !== undefined ? params.udp : true;
  }
}

/**
 * Juicity 代理
 */
class Juicity extends Proxy {
  constructor(params) {
    super(params.name, 'juicity');
    this.server = params.server;
    this.port = params.port;
    this.uuid = params.uuid;
    this.password = params.password;
    this.sni = params.sni || null;
    this.skipCertVerify = params.skipCertVerify || false;
  }
}

/**
 * 输出格式枚举
 */
const OutputFormat = {
  CLASH: 'clash',
  CLASH_META: 'clash-meta',
  SING_BOX: 'sing-box',
  SURGE: 'surge',
  QUANTUMULT_X: 'quantumult-x',
  SHADOWROCKET: 'shadowrocket',
  V2RAY: 'v2ray',
  URI: 'uri',
  BASE64: 'base64'
};

module.exports = {
  Proxy,
  Shadowsocks,
  VMess,
  Trojan,
  VLESS,
  Socks5,
  Http,
  Hysteria,
  Hysteria2,
  TUIC,
  WireGuard,
  ShadowsocksR,
  Snell,
  SSH,
  AnyTLS,
  Juicity,
  OutputFormat
};

