/**
 * 代理解析器
 * 对应安卓端的 ProxyParser.kt
 * 支持多种代理协议的 URI 格式解析
 */

const { Shadowsocks, VMess, Trojan, VLESS, Socks5, Http, Hysteria, Hysteria2, TUIC, WireGuard } = require('./proxy-models');
const SubscriptionPreprocessor = require('./subscription-preprocessor');
const yaml = require('js-yaml');
const JSON5 = require('json5');

/**
 * 解析器基类
 */
class Parser {
  constructor(name) {
    this.name = name;
  }

  test(line) {
    throw new Error('test() must be implemented');
  }

  parse(line) {
    throw new Error('parse() must be implemented');
  }
}

/**
 * Shadowsocks URI 解析器
 * 支持 SIP002 标准格式
 */
class URI_SS extends Parser {
  constructor() {
    super('URI SS Parser');
  }

  test(line) {
    return line.startsWith('ss://');
  }

  parse(line) {
    let content = line.substring(5); // 移除 "ss://"
    
    // 提取名称
    let name = null;
    if (content.includes('#')) {
      name = decodeURIComponent(content.split('#')[1]);
      content = content.split('#')[0];
    }

    // 提取查询参数
    let query = {};
    if (content.includes('?')) {
      const queryString = content.split('?')[1];
      content = content.split('?')[0];
      query = this.parseQuery(queryString);
    }

    // 解析主体部分
    let userInfo, serverInfo;
    if (content.includes('@')) {
      [userInfo, serverInfo] = content.split('@');
    } else {
      // 整个内容是 Base64 编码的
      const decoded = Buffer.from(content, 'base64').toString('utf-8');
      [userInfo, serverInfo] = decoded.split('@');
    }

    // 解析 userInfo (method:password)
    let method, password;
    try {
      const decodedUserInfo = Buffer.from(userInfo, 'base64').toString('utf-8');
      [method, password] = decodedUserInfo.split(':');
    } catch (e) {
      [method, password] = userInfo.split(':');
    }

    // 解析 serverInfo (server:port)
    const [server, port] = serverInfo.split(':');

    return new Shadowsocks({
      name: name || `${server}:${port}`,
      server,
      port: parseInt(port),
      cipher: method,
      password,
      plugin: query.plugin || null,
      pluginOpts: query['plugin-opts'] || null
    });
  }

  parseQuery(queryString) {
    const params = {};
    queryString.split('&').forEach(param => {
      const [key, value] = param.split('=');
      params[decodeURIComponent(key)] = decodeURIComponent(value || '');
    });
    return params;
  }
}

/**
 * VMess URI 解析器
 */
class URI_VMess extends Parser {
  constructor() {
    super('URI VMess Parser');
  }

  test(line) {
    return line.startsWith('vmess://');
  }

  parse(line) {
    const content = line.substring(8); // 移除 "vmess://"
    const decoded = Buffer.from(content, 'base64').toString('utf-8');
    const config = JSON.parse(decoded);

    const params = {
      name: config.ps || config.add,
      server: config.add,
      port: parseInt(config.port),
      uuid: config.id,
      alterId: parseInt(config.aid || 0),
      cipher: config.scy || 'auto',
      tls: config.tls === 'tls',
      network: config.net || 'tcp'
    };

    // TLS 配置
    if (params.tls) {
      params.servername = config.sni || config.host || config.add;
      params.skipCertVerify = config.verify_cert === false || config['skip-cert-verify'] === true;
    }

    // WebSocket 配置
    if (params.network === 'ws') {
      params.wsOpts = {
        path: config.path || '/',
        headers: config.host ? { Host: config.host } : {}
      };
    }

    // HTTP/2 配置
    if (params.network === 'h2') {
      params.h2Opts = {
        host: config.host ? [config.host] : [],
        path: config.path || '/'
      };
    }

    // gRPC 配置
    if (params.network === 'grpc') {
      params.grpcOpts = {
        'grpc-service-name': config.path || ''
      };
    }

    return new VMess(params);
  }
}

/**
 * Trojan URI 解析器
 */
class URI_Trojan extends Parser {
  constructor() {
    super('URI Trojan Parser');
  }

  test(line) {
    return line.startsWith('trojan://');
  }

  parse(line) {
    let content = line.substring(9); // 移除 "trojan://"
    
    // 提取名称
    let name = null;
    if (content.includes('#')) {
      name = decodeURIComponent(content.split('#')[1]);
      content = content.split('#')[0];
    }

    // 提取查询参数
    let query = {};
    if (content.includes('?')) {
      const queryString = content.split('?')[1];
      content = content.split('?')[0];
      query = this.parseQuery(queryString);
    }

    // 解析 password@server:port
    const [password, serverInfo] = content.split('@');
    const [server, port] = serverInfo.split(':');

    const params = {
      name: name || `${server}:${port}`,
      server,
      port: parseInt(port),
      password,
      sni: query.sni || query.peer || server,
      skipCertVerify: query.allowInsecure === '1' || query['skip-cert-verify'] === '1',
      network: query.type || 'tcp'
    };

    // WebSocket 配置
    if (params.network === 'ws') {
      params.wsOpts = {
        path: query.path || '/',
        headers: query.host ? { Host: query.host } : {}
      };
    }

    // gRPC 配置
    if (params.network === 'grpc') {
      params.grpcOpts = {
        'grpc-service-name': query.serviceName || query.path || ''
      };
    }

    return new Trojan(params);
  }

  parseQuery(queryString) {
    const params = {};
    queryString.split('&').forEach(param => {
      const [key, value] = param.split('=');
      params[decodeURIComponent(key)] = decodeURIComponent(value || '');
    });
    return params;
  }
}

/**
 * VLESS URI 解析器
 */
class URI_VLESS extends Parser {
  constructor() {
    super('URI VLESS Parser');
  }

  test(line) {
    return line.startsWith('vless://');
  }

  parse(line) {
    let content = line.substring(8); // 移除 "vless://"
    
    // 提取名称
    let name = null;
    if (content.includes('#')) {
      name = decodeURIComponent(content.split('#')[1]);
      content = content.split('#')[0];
    }

    // 提取查询参数
    let query = {};
    if (content.includes('?')) {
      const queryString = content.split('?')[1];
      content = content.split('?')[0];
      query = this.parseQuery(queryString);
    }

    // 解析 uuid@server:port
    const [uuid, serverInfo] = content.split('@');
    const [server, port] = serverInfo.split(':');

    const params = {
      name: name || `${server}:${port}`,
      server,
      port: parseInt(port),
      uuid,
      flow: query.flow || null,
      tls: query.security === 'tls' || query.security === 'reality',
      network: query.type || 'tcp'
    };

    // TLS 配置
    if (params.tls) {
      params.servername = query.sni || query.peer || server;
      params.skipCertVerify = query.allowInsecure === '1';
    }

    // Reality 配置
    if (query.security === 'reality') {
      params.reality = {
        publicKey: query.pbk || '',
        shortId: query.sid || ''
      };
    }

    // WebSocket 配置
    if (params.network === 'ws') {
      params.wsOpts = {
        path: query.path || '/',
        headers: query.host ? { Host: query.host } : {}
      };
    }

    // gRPC 配置
    if (params.network === 'grpc') {
      params.grpcOpts = {
        'grpc-service-name': query.serviceName || query.path || ''
      };
    }

    return new VLESS(params);
  }

  parseQuery(queryString) {
    const params = {};
    queryString.split('&').forEach(param => {
      const [key, value] = param.split('=');
      params[decodeURIComponent(key)] = decodeURIComponent(value || '');
    });
    return params;
  }
}

/**
 * Socks5 URI 解析器
 */
class URI_Socks5 extends Parser {
  constructor() {
    super('URI Socks5 Parser');
  }

  test(line) {
    return line.startsWith('socks5://') || line.startsWith('socks://');
  }

  parse(line) {
    const prefix = line.startsWith('socks5://') ? 'socks5://' : 'socks://';
    let content = line.substring(prefix.length);

    // 提取名称
    let name = null;
    if (content.includes('#')) {
      name = decodeURIComponent(content.split('#')[1]);
      content = content.split('#')[0];
    }

    // 解析认证信息和服务器信息
    let username = null, password = null;
    let serverInfo = content;

    if (content.includes('@')) {
      const [auth, server] = content.split('@');
      serverInfo = server;
      if (auth.includes(':')) {
        [username, password] = auth.split(':');
      }
    }

    const [server, port] = serverInfo.split(':');

    return new Socks5({
      name: name || `${server}:${port}`,
      server,
      port: parseInt(port),
      username,
      password
    });
  }
}

/**
 * HTTP URI 解析器
 */
class URI_Http extends Parser {
  constructor() {
    super('URI HTTP Parser');
  }

  test(line) {
    return line.startsWith('http://') || line.startsWith('https://');
  }

  parse(line) {
    const tls = line.startsWith('https://');
    const prefix = tls ? 'https://' : 'http://';
    let content = line.substring(prefix.length);

    // 提取名称
    let name = null;
    if (content.includes('#')) {
      name = decodeURIComponent(content.split('#')[1]);
      content = content.split('#')[0];
    }

    // 解析认证信息和服务器信息
    let username = null, password = null;
    let serverInfo = content;

    if (content.includes('@')) {
      const [auth, server] = content.split('@');
      serverInfo = server;
      if (auth.includes(':')) {
        [username, password] = auth.split(':');
      }
    }

    const [server, port] = serverInfo.split(':');

    return new Http({
      name: name || `${server}:${port}`,
      server,
      port: parseInt(port || (tls ? 443 : 80)),
      username,
      password,
      tls
    });
  }
}

/**
 * Hysteria URI 解析器
 */
class URI_Hysteria extends Parser {
  constructor() {
    super('URI Hysteria Parser');
  }

  test(line) {
    return line.startsWith('hysteria://');
  }

  parse(line) {
    // hysteria://server:port?protocol=udp&auth=xxx&peer=xxx&insecure=1&upmbps=100&downmbps=100&alpn=h3&obfs=xplus&obfsParam=xxx#name
    const url = new URL(line);
    const server = url.hostname;
    const port = parseInt(url.port) || 443;
    const params = url.searchParams;

    return new Hysteria({
      name: decodeURIComponent(url.hash.substring(1)) || `${server}:${port}`,
      server,
      port,
      protocol: params.get('protocol') || 'udp',
      auth: params.get('auth') || params.get('password'),
      up: params.get('upmbps') || params.get('up'),
      down: params.get('downmbps') || params.get('down'),
      obfs: params.get('obfs'),
      alpn: params.get('alpn') ? params.get('alpn').split(',') : [],
      sni: params.get('peer') || params.get('sni'),
      skipCertVerify: params.get('insecure') === '1' || params.get('insecure') === 'true'
    });
  }
}

/**
 * Hysteria2 URI 解析器
 */
class URI_Hysteria2 extends Parser {
  constructor() {
    super('URI Hysteria2 Parser');
  }

  test(line) {
    return line.startsWith('hysteria2://') || line.startsWith('hy2://');
  }

  parse(line) {
    // hysteria2://password@server:port?obfs=salamander&obfs-password=xxx&sni=xxx&insecure=1#name
    const url = new URL(line);
    const password = decodeURIComponent(url.username);
    const server = url.hostname;
    const port = parseInt(url.port) || 443;
    const params = url.searchParams;

    return new Hysteria2({
      name: decodeURIComponent(url.hash.substring(1)) || `${server}:${port}`,
      server,
      port,
      password,
      obfs: params.get('obfs'),
      obfsPassword: params.get('obfs-password'),
      sni: params.get('sni'),
      skipCertVerify: params.get('insecure') === '1' || params.get('insecure') === 'true',
      up: params.get('up'),
      down: params.get('down')
    });
  }
}

/**
 * TUIC URI 解析器
 */
class URI_TUIC extends Parser {
  constructor() {
    super('URI TUIC Parser');
  }

  test(line) {
    return line.startsWith('tuic://');
  }

  parse(line) {
    // tuic://uuid:password@server:port?congestion_control=bbr&udp_relay_mode=native&alpn=h3&sni=xxx&insecure=1#name
    const url = new URL(line);
    const uuid = decodeURIComponent(url.username);
    const password = decodeURIComponent(url.password);
    const server = url.hostname;
    const port = parseInt(url.port) || 443;
    const params = url.searchParams;

    return new TUIC({
      name: decodeURIComponent(url.hash.substring(1)) || `${server}:${port}`,
      server,
      port,
      uuid,
      password,
      version: parseInt(params.get('version')) || 5,
      alpn: params.get('alpn') ? params.get('alpn').split(',') : ['h3'],
      sni: params.get('sni'),
      skipCertVerify: params.get('insecure') === '1' || params.get('insecure') === 'true',
      congestionController: params.get('congestion_control') || params.get('congestion_controller') || 'bbr',
      udpRelayMode: params.get('udp_relay_mode') || 'native'
    });
  }
}

/**
 * WireGuard URI 解析器
 */
class URI_WireGuard extends Parser {
  constructor() {
    super('URI WireGuard Parser');
  }

  test(line) {
    return line.startsWith('wireguard://');
  }

  parse(line) {
    // wireguard://private-key@server:port?public-key=xxx&preshared-key=xxx&ip=xxx&ipv6=xxx&mtu=1420#name
    const url = new URL(line);
    const privateKey = decodeURIComponent(url.username);
    const server = url.hostname;
    const port = parseInt(url.port) || 51820;
    const params = url.searchParams;

    return new WireGuard({
      name: decodeURIComponent(url.hash.substring(1)) || `${server}:${port}`,
      server,
      port,
      privateKey,
      publicKey: params.get('public-key') || params.get('publicKey'),
      presharedKey: params.get('preshared-key') || params.get('presharedKey'),
      ip: params.get('ip'),
      ipv6: params.get('ipv6'),
      mtu: parseInt(params.get('mtu')) || 1420
    });
  }
}

/**
 * Clash YAML 格式解析器
 */
class Clash_All extends Parser {
  constructor() {
    super('Clash YAML Parser');
  }

  test(line) {
    // 检测是否是 YAML 或 JSON 格式的代理配置
    const trimmed = line.trim();
    let proxy;
    try {
      proxy = JSON5.parse(trimmed);
    } catch (e) {
      try {
        proxy = yaml.load(trimmed);
      } catch (yamlError) {
        return false;
      }
    }
    return !!proxy?.type;
  }

  parse(line) {
    try {
      let config;
      const trimmed = line.trim();

      // 尝试解析 JSON5 格式(支持更宽松的JSON语法)
      try {
        config = JSON5.parse(trimmed);
      } catch (jsonError) {
        // 如果 JSON5 解析失败，尝试 YAML
        config = yaml.load(trimmed);
      }

      // 处理 vmess/vless 的 sni 字段
      if (['vmess', 'vless'].includes(config.type)) {
        if (config.servername && !config.sni) {
          config.sni = config.servername;
          delete config.servername;
        }
      }

      // 处理 server-cert-fingerprint
      if (config['server-cert-fingerprint']) {
        config['tls-fingerprint'] = config['server-cert-fingerprint'];
      }

      return this.convertClashProxy(config);
    } catch (e) {
      console.error('[Clash_All] Parse failed:', e.message);
      return null;
    }
  }

  convertClashProxy(config) {
    const type = config.type?.toLowerCase();

    switch (type) {
      case 'ss':
      case 'shadowsocks':
        return new Shadowsocks({
          name: config.name,
          server: config.server,
          port: config.port,
          cipher: config.cipher,
          password: config.password,
          plugin: config.plugin || null,
          pluginOpts: config['plugin-opts'] || null,
          udp: config.udp !== false
        });

      case 'vmess':
        return new VMess({
          name: config.name,
          server: config.server,
          port: config.port,
          uuid: config.uuid,
          alterId: config.alterId || 0,
          cipher: config.cipher || 'auto',
          tls: config.tls || false,
          skipCertVerify: config['skip-cert-verify'] || false,
          servername: config.servername || null,
          network: config.network || 'tcp',
          wsOpts: config['ws-opts'] || null,
          h2Opts: config['h2-opts'] || null,
          httpOpts: config['http-opts'] || null,
          grpcOpts: config['grpc-opts'] || null,
          udp: config.udp !== false
        });

      case 'trojan':
        return new Trojan({
          name: config.name,
          server: config.server,
          port: config.port,
          password: config.password,
          sni: config.sni || null,
          skipCertVerify: config['skip-cert-verify'] || false,
          network: config.network || 'tcp',
          wsOpts: config['ws-opts'] || null,
          grpcOpts: config['grpc-opts'] || null,
          udp: config.udp !== false
        });

      case 'vless':
        return new VLESS({
          name: config.name,
          server: config.server,
          port: config.port,
          uuid: config.uuid,
          flow: config.flow || null,
          tls: config.tls || false,
          skipCertVerify: config['skip-cert-verify'] || false,
          servername: config.servername || null,
          network: config.network || 'tcp',
          wsOpts: config['ws-opts'] || null,
          grpcOpts: config['grpc-opts'] || null,
          reality: config['reality-opts'] || null,
          udp: config.udp !== false
        });

      case 'socks5':
      case 'socks':
        return new Socks5({
          name: config.name,
          server: config.server,
          port: config.port,
          username: config.username || null,
          password: config.password || null,
          tls: config.tls || false,
          skipCertVerify: config['skip-cert-verify'] || false,
          udp: config.udp !== false
        });

      case 'http':
      case 'https':
        return new Http({
          name: config.name,
          server: config.server,
          port: config.port,
          username: config.username || null,
          password: config.password || null,
          tls: config.tls || type === 'https',
          skipCertVerify: config['skip-cert-verify'] || false
        });

      case 'direct':
      case 'reject':
        // Direct和Reject类型不需要转换,直接跳过
        console.log(`[Clash_All] Skipping ${type} type proxy`);
        return null;

      default:
        console.warn(`[Clash_All] Unsupported type: ${type}`);
        return null;
    }
  }
}

/**
 * 解析器集合
 */
class ProxyParsers {
  constructor() {
    this.parsers = [
      new URI_Socks5(),
      new URI_Http(),
      new URI_SS(),
      new URI_VMess(),
      new URI_VLESS(),
      new URI_Trojan(),
      new URI_Hysteria2(),
      new URI_Hysteria(),
      new URI_TUIC(),
      new URI_WireGuard(),
      new Clash_All()
    ];
  }

  /**
   * 解析单行代理配置
   */
  parseLine(line) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) {
      return null;
    }

    for (const parser of this.parsers) {
      try {
        if (parser.test(trimmed)) {
          console.log(`[ProxyParsers] Using parser: ${parser.name}`);
          return parser.parse(trimmed);
        }
      } catch (e) {
        console.error(`[ProxyParsers] Parser ${parser.name} failed:`, e.message);
      }
    }

    console.warn(`[ProxyParsers] No parser found for line: ${trimmed.substring(0, 50)}...`);
    return null;
  }

  /**
   * 解析多行配置
   */
  parseLines(content) {
    const preprocessed = SubscriptionPreprocessor.preprocess(content);
    return preprocessed.split('\n')
      .map(line => this.parseLine(line))
      .filter(proxy => proxy !== null);
  }
}

module.exports = {
  Parser,
  URI_SS,
  URI_VMess,
  URI_Trojan,
  URI_VLESS,
  URI_Socks5,
  URI_Http,
  URI_Hysteria,
  URI_Hysteria2,
  URI_TUIC,
  URI_WireGuard,
  Clash_All,
  ProxyParsers
};

