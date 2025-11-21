/**
 * 代理生成器
 * 对应安卓端的 ProxyProducer.kt
 * 支持多种输出格式
 */

const yaml = require('js-yaml');
const { OutputFormat } = require('./proxy-models');

/**
 * 生成器基类
 */
class Producer {
  constructor(name) {
    this.name = name;
  }

  produce(proxies) {
    throw new Error('produce() must be implemented');
  }
}

/**
 * Clash 标准格式生成器
 */
class ClashProducer extends Producer {
  constructor() {
    super('Clash Producer');
  }

  produce(proxies) {
    console.log(`[ClashProducer] Received ${proxies.length} proxies`);

    const validProxies = proxies.filter(proxy => this.isSupported(proxy));
    console.log(`[ClashProducer] After filtering: ${validProxies.length} valid proxies`);

    const proxiesList = validProxies
      .map(proxy => this.convertProxy(proxy))
      .filter(Boolean);
    if (proxiesList.length !== validProxies.length) {
      console.log(`[ClashProducer] Dropped ${validProxies.length - proxiesList.length} proxies not convertible to Clash format`);
    }
    
    const config = { proxies: proxiesList };
    const yamlStr = yaml.dump(config, {
      indent: 2,
      lineWidth: -1,
      noRefs: true,
      sortKeys: false
    });

    return yamlStr;
  }

  isSupported(proxy) {
    const type = proxy.type;
    
    // Clash 标准版支持的协议
    const supportedTypes = ['ss', 'vmess', 'trojan', 'socks5', 'http'];
    
    // VLESS 需要检查是否有 flow 或 reality (Clash 不支持)
    if (type === 'vless') {
      return !proxy.flow && !proxy.reality;
    }
    
    return supportedTypes.includes(type);
  }

  convertProxy(proxy) {
    const type = proxy.type;

    switch (type) {
      case 'ss':
        return this.convertShadowsocks(proxy);
      case 'ssr':
        return this.convertSSR(proxy);
      case 'vmess':
        return this.convertVMess(proxy);
      case 'trojan':
        return this.convertTrojan(proxy);
      case 'vless':
        return this.convertVLESS(proxy);
      case 'socks5':
        return this.convertSocks5(proxy);
      case 'http':
        return this.convertHttp(proxy);
      case 'anytls':
        // AnyTLS 在 sing-box 中通常以 trojan/outbound 形式表现，此处先映射为 trojan-like 配置
        return this.convertAnyTLS(proxy);
      default:
        return null;
    }
  }

  convertShadowsocks(proxy) {
    const config = {
      name: proxy.name,
      type: 'ss',
      server: proxy.server,
      port: proxy.port,
      cipher: proxy.cipher,
      password: proxy.password,
      udp: proxy.udp
    };

    if (proxy.plugin) {
      config.plugin = proxy.plugin;
      config['plugin-opts'] = proxy.pluginOpts || {};
    }

    if (proxy.udpOverTcp) {
      config['udp-over-tcp'] = true;
    }
    if (proxy.tfo) {
      config['fast-open'] = true;
    }
    if (proxy.psk) {
      config.psk = proxy.psk;
    }
    if (proxy.shortId) {
      config['short-id'] = proxy.shortId;
    }

    return config;
  }

  convertVMess(proxy) {
    const config = {
      name: proxy.name,
      type: 'vmess',
      server: proxy.server,
      port: proxy.port,
      uuid: proxy.uuid,
      alterId: proxy.alterId,
      cipher: proxy.cipher,
      udp: proxy.udp
    };

    if (proxy.tls) {
      config.tls = true;
      if (proxy.servername) {
        config.servername = proxy.servername;
      }
      if (proxy.skipCertVerify) {
        config['skip-cert-verify'] = true;
      }
    }

    config.network = proxy.network;

    if (proxy.network === 'ws' && proxy.wsOpts) {
      config['ws-opts'] = proxy.wsOpts;
    } else if (proxy.network === 'h2' && proxy.h2Opts) {
      config['h2-opts'] = proxy.h2Opts;
    } else if (proxy.network === 'http' && proxy.httpOpts) {
      config['http-opts'] = proxy.httpOpts;
    } else if (proxy.network === 'grpc' && proxy.grpcOpts) {
      config['grpc-opts'] = proxy.grpcOpts;
    }

    return config;
  }

  convertTrojan(proxy) {
    const config = {
      name: proxy.name,
      type: 'trojan',
      server: proxy.server,
      port: proxy.port,
      password: proxy.password,
      udp: proxy.udp
    };

    if (proxy.sni) {
      config.sni = proxy.sni;
    }

    if (proxy.skipCertVerify) {
      config['skip-cert-verify'] = true;
    }

    config.network = proxy.network;

    if (proxy.network === 'ws' && proxy.wsOpts) {
      config['ws-opts'] = proxy.wsOpts;
      if (proxy.wsOpts['max-early-data'] && !proxy.wsOpts['early-data-header-name']) {
        config['ws-opts']['early-data-header-name'] = 'Sec-WebSocket-Protocol';
      }
    } else if (proxy.network === 'grpc' && proxy.grpcOpts) {
      config['grpc-opts'] = proxy.grpcOpts;
    }

    return config;
  }

  convertVLESS(proxy) {
    const config = {
      name: proxy.name,
      type: 'vless',
      server: proxy.server,
      port: proxy.port,
      uuid: proxy.uuid,
      udp: proxy.udp
    };

    if (proxy.flow) {
      config.flow = proxy.flow;
    }

    if (proxy.reality) {
      config['reality-opts'] = proxy.reality;
    }

    if (proxy.tls) {
      config.tls = true;
      if (proxy.servername) {
        config.servername = proxy.servername;
      }
      if (proxy.skipCertVerify) {
        config['skip-cert-verify'] = true;
      }
    }

    config.network = proxy.network;

    if (proxy.network === 'ws' && proxy.wsOpts) {
      config['ws-opts'] = proxy.wsOpts;
      if (proxy.wsOpts['max-early-data'] && !proxy.wsOpts['early-data-header-name']) {
        config['ws-opts']['early-data-header-name'] = 'Sec-WebSocket-Protocol';
      }
    } else if (proxy.network === 'grpc' && proxy.grpcOpts) {
      config['grpc-opts'] = proxy.grpcOpts;
    }

    return config;
  }

  convertSocks5(proxy) {
    const config = {
      name: proxy.name,
      type: 'socks5',
      server: proxy.server,
      port: proxy.port,
      udp: proxy.udp
    };

    if (proxy.username) {
      config.username = proxy.username;
    }
    if (proxy.password) {
      config.password = proxy.password;
    }
    if (proxy.tls) {
      config.tls = true;
    }
    if (proxy.skipCertVerify) {
      config['skip-cert-verify'] = true;
    }

    return config;
  }

  convertHttp(proxy) {
    const config = {
      name: proxy.name,
      type: 'http',
      server: proxy.server,
      port: proxy.port
    };

    if (proxy.username) {
      config.username = proxy.username;
    }
    if (proxy.password) {
      config.password = proxy.password;
    }
    if (proxy.tls) {
      config.tls = true;
    }
    if (proxy.skipCertVerify) {
      config['skip-cert-verify'] = true;
    }

    return config;
  }
}

/**
 * Clash Meta 格式生成器
 * 支持更多协议
 */
class ClashMetaProducer extends ClashProducer {
  constructor() {
    super();
    this.name = 'Clash Meta Producer';
  }

  isSupported(proxy) {
    const supportedTypes = new Set([
      'ss',
      'vmess',
      'trojan',
      'vless',
      'socks5',
      'http',
      'hysteria',
      'hysteria2',
      'tuic',
      'wireguard',
      'snell',
      'ssh',
      'anytls',
      'juicity'
    ]);

    // Clash Meta 支持 ss-2022 等新算法，这里不做 cipher 白名单过滤
    return supportedTypes.has(proxy.type);
  }

  convertProxy(proxy) {
    const type = proxy.type;
    
    // 先尝试父类的转换
    const baseResult = super.convertProxy(proxy);
    if (baseResult) return baseResult;
    
    // Clash Meta 特有的协议
    switch (type) {
      case 'hysteria':
        return this.convertHysteria(proxy);
      case 'hysteria2':
        return this.convertHysteria2(proxy);
      case 'tuic':
        return this.convertTUIC(proxy);
      case 'wireguard':
        return this.convertWireGuard(proxy);
      case 'snell':
        return this.convertSnell(proxy);
      case 'ssh':
        return this.convertSSH(proxy);
      case 'anytls':
        return this.convertAnyTLS(proxy);
      case 'juicity':
        return this.convertJuicity(proxy);
      default:
        return null;
    }
  }

  convertHysteria(proxy) {
    const config = {
      name: proxy.name,
      type: 'hysteria',
      server: proxy.server,
      port: proxy.port,
      protocol: proxy.protocol
    };

    if (proxy.up) config.up = proxy.up;
    if (proxy.down) config.down = proxy.down;
    if (proxy.auth) config.auth = proxy.auth;
    if (proxy.obfs) config.obfs = proxy.obfs;
    if (proxy.alpn && proxy.alpn.length > 0) config.alpn = proxy.alpn;
    if (proxy.sni) config.sni = proxy.sni;
    if (proxy.skipCertVerify) config['skip-cert-verify'] = true;

    return config;
  }

  convertHysteria2(proxy) {
    const config = {
      name: proxy.name,
      type: 'hysteria2',
      server: proxy.server,
      port: proxy.port,
      password: proxy.password
    };

    if (proxy.obfs) config.obfs = proxy.obfs;
    if (proxy.obfsPassword) config['obfs-password'] = proxy.obfsPassword;
    if (proxy.sni) config.sni = proxy.sni;
    if (proxy.skipCertVerify) config['skip-cert-verify'] = true;
    if (proxy.up) config.up = proxy.up;
    if (proxy.down) config.down = proxy.down;
    if (proxy.hopInterval) config['hop-interval'] = proxy.hopInterval;
    if (proxy.alpn && proxy.alpn.length > 0) config.alpn = proxy.alpn;

    return config;
  }

  convertTUIC(proxy) {
    const config = {
      name: proxy.name,
      type: 'tuic',
      server: proxy.server,
      port: proxy.port,
      uuid: proxy.uuid,
      password: proxy.password
    };

    if (proxy.version) config.version = proxy.version;
    if (proxy.alpn && proxy.alpn.length > 0) config.alpn = proxy.alpn;
    if (proxy.sni) config.sni = proxy.sni;
    if (proxy.skipCertVerify) config['skip-cert-verify'] = true;
    if (proxy.congestionController) config['congestion-controller'] = proxy.congestionController;
    if (proxy.udpRelayMode) config['udp-relay-mode'] = proxy.udpRelayMode;
    if (proxy.hopInterval) config['hop-interval'] = proxy.hopInterval;
    if (proxy.reduceRtt) config['reduce-rtt'] = true;
    if (proxy.disableSni) config['disable-sni'] = true;
    if (proxy.udpOverStream) config['udp-over-stream'] = true;
    if (proxy.heartbeatInterval) config['heartbeat-interval'] = proxy.heartbeatInterval;

    return config;
  }

  convertWireGuard(proxy) {
    const config = {
      name: proxy.name,
      type: 'wireguard',
      server: proxy.server,
      port: proxy.port,
      'private-key': proxy.privateKey,
      'public-key': proxy.publicKey,
      ip: proxy.ip
    };

    if (proxy.presharedKey) config['preshared-key'] = proxy.presharedKey;
    if (proxy.ipv6) config.ipv6 = proxy.ipv6;
    if (proxy.mtu) config.mtu = proxy.mtu;

    return config;
  }

  convertSnell(proxy) {
    const config = {
      name: proxy.name,
      type: 'snell',
      server: proxy.server,
      port: proxy.port,
      psk: proxy.psk,
      version: proxy.version
    };

    if (proxy.ipVersion) config['ip-version'] = proxy.ipVersion;
    if (proxy.udp !== undefined) config.udp = proxy.udp;
    if (proxy.tfo) config.tfo = true;
    if (proxy.obfs) {
      config.obfs = proxy.obfs;
      if (proxy.obfsHost) config['obfs-host'] = proxy.obfsHost;
      if (proxy.obfsUri) config['obfs-uri'] = proxy.obfsUri;
    }

    return config;
  }

  convertSSH(proxy) {
    const config = {
      name: proxy.name,
      type: 'ssh',
      server: proxy.server,
      port: proxy.port,
      username: proxy.username
    };

    if (proxy.password) config.password = proxy.password;
    if (proxy.privateKey) config['private-key'] = proxy.privateKey;
    if (proxy.privateKeyPassphrase) {
      config['private-key-passphrase'] = proxy.privateKeyPassphrase;
    }
    if (proxy.serverFingerprint) {
      config['server-fingerprint'] = proxy.serverFingerprint;
    }
    if (proxy.hostKey) {
      config['host-key'] = proxy.hostKey;
    }
    if (proxy.hostKeyAlgorithms) {
      config['host-key-algorithms'] = proxy.hostKeyAlgorithms;
    }
    if (proxy.sni) config.sni = proxy.sni;
    if (proxy.skipCertVerify) config['skip-cert-verify'] = true;
    if (proxy.tfo) config.tfo = true;

    return config;
  }

  convertAnyTLS(proxy) {
    const config = {
      name: proxy.name,
      type: 'anytls',
      server: proxy.server,
      port: proxy.port,
      password: proxy.password
    };

    if (proxy.sni) config.sni = proxy.sni;
    if (proxy.reality) config['reality-opts'] = proxy.reality;
    if (proxy.udp !== undefined) config.udp = proxy.udp;

    return config;
  }

  convertJuicity(proxy) {
    const config = {
      name: proxy.name,
      type: 'juicity',
      server: proxy.server,
      port: proxy.port,
      uuid: proxy.uuid,
      password: proxy.password
    };

    if (proxy.sni) config.sni = proxy.sni;
    if (proxy.skipCertVerify) config['skip-cert-verify'] = true;

    return config;
  }
}

/**
 * Sing-box 格式生成器
 */
class SingBoxProducer extends Producer {
  constructor() {
    super('Sing-box Producer');
  }

  produce(proxies) {
    const outbounds = proxies.map(proxy => this.convertProxy(proxy)).filter(o => o !== null);

    const config = {
      outbounds: outbounds
    };

    return JSON.stringify(config, null, 2);
  }

  convertProxy(proxy) {
    const type = proxy.type;

    switch (type) {
      case 'ss':
        return this.convertShadowsocks(proxy);
      case 'ssr':
        return this.convertSSR(proxy);
      case 'vmess':
        return this.convertVMess(proxy);
      case 'trojan':
        return this.convertTrojan(proxy);
      case 'vless':
        return this.convertVLESS(proxy);
      case 'hysteria':
        return this.convertHysteria(proxy);
      case 'hysteria2':
        return this.convertHysteria2(proxy);
      case 'tuic':
        return this.convertTUIC(proxy);
      case 'socks5':
        return this.convertSocks5(proxy);
      case 'http':
        return this.convertHttp(proxy);
      case 'wireguard':
        return this.convertWireGuard(proxy);
      case 'ssh':
        return this.convertSSH(proxy);
      default:
        return null;
    }
  }

  convertShadowsocks(proxy) {
    return {
      tag: proxy.name,
      type: 'shadowsocks',
      server: proxy.server,
      server_port: proxy.port,
      method: proxy.cipher,
      password: proxy.password,
      psk: proxy.psk || undefined,
      'short-id': proxy.shortId || undefined
    };
  }

  convertVMess(proxy) {
    const outbound = {
      tag: proxy.name,
      type: 'vmess',
      server: proxy.server,
      server_port: proxy.port,
      uuid: proxy.uuid,
      security: proxy.cipher,
      alter_id: proxy.alterId
    };

    if (proxy.tls) {
      outbound.tls = {
        enabled: true,
        server_name: proxy.servername || proxy.server,
        insecure: proxy.skipCertVerify || false
      };
    }

    if (proxy.network && proxy.network !== 'tcp') {
      outbound.transport = {
        type: proxy.network
      };

      if (proxy.network === 'ws' && proxy.wsOpts) {
        outbound.transport.path = proxy.wsOpts.path || '/';
        if (proxy.wsOpts.headers) {
          outbound.transport.headers = proxy.wsOpts.headers;
        }
        if (proxy.wsOpts['max-early-data']) {
          outbound.transport.max_early_data = proxy.wsOpts['max-early-data'];
        }
        if (proxy.wsOpts['early-data-header-name']) {
          outbound.transport.early_data_header_name = proxy.wsOpts['early-data-header-name'];
        }
      } else if (proxy.network === 'grpc' && proxy.grpcOpts) {
        outbound.transport.service_name = proxy.grpcOpts['grpc-service-name'] || '';
      }
    }

    return outbound;
  }

  convertTrojan(proxy) {
    const outbound = {
      tag: proxy.name,
      type: 'trojan',
      server: proxy.server,
      server_port: proxy.port,
      password: proxy.password
    };

    outbound.tls = {
      enabled: true,
      server_name: proxy.sni || proxy.server,
      insecure: proxy.skipCertVerify || false
    };

    if (proxy.network && proxy.network !== 'tcp') {
      outbound.transport = {
        type: proxy.network
      };

      if (proxy.network === 'ws' && proxy.wsOpts) {
        outbound.transport.path = proxy.wsOpts.path || '/';
        if (proxy.wsOpts.headers) {
          outbound.transport.headers = proxy.wsOpts.headers;
        }
        if (proxy.wsOpts['max-early-data']) {
          outbound.transport.max_early_data = proxy.wsOpts['max-early-data'];
        }
        if (proxy.wsOpts['early-data-header-name']) {
          outbound.transport.early_data_header_name = proxy.wsOpts['early-data-header-name'];
        }
      } else if (proxy.network === 'grpc' && proxy.grpcOpts) {
        outbound.transport.service_name = proxy.grpcOpts['grpc-service-name'] || '';
      }
    }

    return outbound;
  }

  convertVLESS(proxy) {
    const outbound = {
      tag: proxy.name,
      type: 'vless',
      server: proxy.server,
      server_port: proxy.port,
      uuid: proxy.uuid
    };

    if (proxy.flow) {
      outbound.flow = proxy.flow;
    }

    if (proxy.tls) {
      outbound.tls = {
        enabled: true,
        server_name: proxy.servername || proxy.server,
        insecure: proxy.skipCertVerify || false
      };

      if (proxy.reality) {
        outbound.tls.reality = {
          enabled: true,
          public_key: proxy.reality.publicKey,
          short_id: proxy.reality.shortId
        };
      }
    }

    if (proxy.network && proxy.network !== 'tcp') {
      outbound.transport = {
        type: proxy.network
      };

      if (proxy.network === 'ws' && proxy.wsOpts) {
        outbound.transport.path = proxy.wsOpts.path || '/';
        if (proxy.wsOpts.headers) {
          outbound.transport.headers = proxy.wsOpts.headers;
        }
        if (proxy.wsOpts['max-early-data']) {
          outbound.transport.max_early_data = proxy.wsOpts['max-early-data'];
        }
        if (proxy.wsOpts['early-data-header-name']) {
          outbound.transport.early_data_header_name = proxy.wsOpts['early-data-header-name'];
        }
      } else if (proxy.network === 'grpc' && proxy.grpcOpts) {
        outbound.transport.service_name = proxy.grpcOpts['grpc-service-name'] || '';
      }
    }

    return outbound;
  }

  convertHysteria(proxy) {
    return {
      tag: proxy.name,
      type: 'hysteria',
      server: proxy.server,
      server_port: proxy.port,
      up_mbps: proxy.up ? parseInt(proxy.up) : 10,
      down_mbps: proxy.down ? parseInt(proxy.down) : 50,
      auth_str: proxy.auth,
      obfs: proxy.obfs
    };
  }

  convertHysteria2(proxy) {
    return {
      tag: proxy.name,
      type: 'hysteria2',
      server: proxy.server,
      server_port: proxy.port,
      password: proxy.password,
      obfs: proxy.obfs ? {
        type: proxy.obfs,
        password: proxy.obfsPassword
      } : undefined,
      alpn: proxy.alpn && proxy.alpn.length > 0 ? proxy.alpn : undefined,
      tls: proxy.sni || proxy.skipCertVerify ? {
        enabled: true,
        server_name: proxy.sni,
        insecure: proxy.skipCertVerify || false
      } : undefined,
      hop_interval: proxy.hopInterval || undefined
    };
  }

  convertTUIC(proxy) {
    const outbound = {
      tag: proxy.name,
      type: 'tuic',
      server: proxy.server,
      server_port: proxy.port,
      uuid: proxy.uuid,
      password: proxy.password,
      congestion_control: proxy.congestionController || 'bbr',
      hop_interval: proxy.hopInterval || undefined
    };

    if (proxy.reduceRtt) {
      outbound.zero_rtt_handshake = true;
    }
    if (proxy.udpOverStream) {
      outbound.udp_over_stream = true;
    }
    if (proxy.heartbeatInterval) {
      outbound.heartbeat = `${proxy.heartbeatInterval}ms`;
    }

    return outbound;
  }

  convertSocks5(proxy) {
    return {
      tag: proxy.name,
      type: 'socks',
      server: proxy.server,
      server_port: proxy.port,
      username: proxy.username,
      password: proxy.password
    };
  }

  convertAnyTLS(proxy) {
    const outbound = {
      tag: proxy.name,
      type: 'trojan',
      server: proxy.server,
      server_port: proxy.port,
      password: proxy.password
    };

    outbound.tls = {
      enabled: true,
      server_name: proxy.sni || proxy.server,
      insecure: proxy.skipCertVerify || false
    };

    if (proxy.reality) {
      outbound.tls.reality = {
        enabled: true,
        public_key: proxy.reality.publicKey,
        short_id: proxy.reality.shortId
      };
    }

    return outbound;
  }

  convertHttp(proxy) {
    return {
      tag: proxy.name,
      type: 'http',
      server: proxy.server,
      server_port: proxy.port,
      username: proxy.username,
      password: proxy.password
    };
  }

  convertWireGuard(proxy) {
    const localAddress = [];
    if (proxy.ip) {
      localAddress.push(`${proxy.ip}/32`);
    }
    if (proxy.ipv6) {
      localAddress.push(`${proxy.ipv6}/128`);
    }

    const outbound = {
      tag: proxy.name,
      type: 'wireguard',
      server: proxy.server,
      server_port: proxy.port,
      private_key: proxy.privateKey,
      peer_public_key: proxy.publicKey
    };

    if (localAddress.length > 0) {
      outbound.local_address = localAddress;
    }
    if (proxy.presharedKey) {
      outbound.pre_shared_key = proxy.presharedKey;
    }
    if (proxy.mtu) {
      outbound.mtu = proxy.mtu;
    }

    return outbound;
  }
}

/**
 * URI 格式生成器
 */
class URIProducer extends Producer {
  constructor() {
    super('URI Producer');
  }

  produce(proxies) {
    const uris = proxies.map(proxy => this.convertProxy(proxy)).filter(uri => uri !== null);
    return uris.join('\n');
  }

  convertProxy(proxy) {
    const type = proxy.type;

    switch (type) {
      case 'ss':
        return this.convertShadowsocks(proxy);
      case 'vmess':
        return this.convertVMess(proxy);
      case 'trojan':
        return this.convertTrojan(proxy);
      case 'vless':
        return this.convertVLESS(proxy);
      case 'hysteria':
        return this.convertHysteria(proxy);
      case 'hysteria2':
        return this.convertHysteria2(proxy);
      case 'tuic':
        return this.convertTUIC(proxy);
      case 'wireguard':
        return this.convertWireGuard(proxy);
      case 'socks5':
        return this.convertSocks5(proxy);
      case 'http':
        return this.convertHttp(proxy);
      case 'anytls':
        // AnyTLS 暂不生成标准 URI，避免误导
        return null;
      case 'snell':
      case 'ssh':
        // 暂不生成 Snell/SSH URI
        return null;
      case 'juicity': {
        // juicity URI: juicity://uuid:password@server:port?alpn=...&sni=...&insecure=1#name
        const params = new URLSearchParams();
        if (proxy.alpn && proxy.alpn.length > 0) {
          params.append('alpn', proxy.alpn.join(','));
        }
        if (proxy.sni) {
          params.append('sni', proxy.sni);
        }
        if (proxy.skipCertVerify) {
          params.append('insecure', '1');
        }
        const user = encodeURIComponent(proxy.uuid);
        const pass = encodeURIComponent(proxy.password);
        let uri = `juicity://${user}:${pass}@${proxy.server}:${proxy.port}`;
        const qs = params.toString();
        if (qs) uri += `?${qs}`;
        uri += `#${encodeURIComponent(proxy.name)}`;
        return uri;
      }
      default:
        return null;
    }
  }

  convertShadowsocks(proxy) {
    const userInfo =
      proxy.cipher && proxy.cipher.startsWith('2022-')
        ? `${proxy.cipher}:${proxy.password}`
        : Buffer.from(`${proxy.cipher}:${proxy.password}`).toString('base64');

    const params = new URLSearchParams();
    if (proxy.plugin) {
      params.append('plugin', proxy.plugin);
      if (proxy.pluginOpts) {
        params.append('plugin-opts', JSON.stringify(proxy.pluginOpts));
      }
    }
    if (proxy.udpOverTcp) {
      params.append('udp-over-tcp', '1');
    }
    if (proxy.udp === false) {
      params.append('udp', '0');
    }
    if (proxy.network) params.append('type', proxy.network);
    if (proxy.tfo) params.append('tfo', '1');
    if (proxy.psk) params.append('psk', proxy.psk);
    if (proxy.shortId) params.append('sid', proxy.shortId);

    let uri = `ss://${userInfo}@${proxy.server}:${proxy.port}`;
    const queryString = params.toString();
    if (queryString) uri += `?${queryString}`;
    uri += `#${encodeURIComponent(proxy.name)}`;
    return uri;
  }

  convertSSR(proxy) {
    const head = [
      proxy.server,
      proxy.port,
      proxy.protocol || 'origin',
      proxy.cipher,
      proxy.obfs || 'plain',
      Buffer.from(proxy.password).toString('base64')
    ].join(':');

    const params = new URLSearchParams();
    if (proxy.protocolParam) {
      params.append('protoparam', Buffer.from(proxy.protocolParam).toString('base64'));
    }
    if (proxy.obfsParam) {
      params.append('obfsparam', Buffer.from(proxy.obfsParam).toString('base64'));
    }
    params.append('remarks', Buffer.from(proxy.name).toString('base64'));

    const full = `${head}/?${params.toString()}`;
    return `ssr://${Buffer.from(full).toString('base64')}`;
  }

  convertVMess(proxy) {
    const config = {
      v: '2',
      ps: proxy.name,
      add: proxy.server,
      port: proxy.port.toString(),
      id: proxy.uuid,
      aid: proxy.alterId.toString(),
      scy: proxy.cipher,
      net: proxy.network,
      type: 'none',
      tls: proxy.tls ? 'tls' : ''
    };

    if (proxy.tls && proxy.servername) {
      config.sni = proxy.servername;
    }

    if (proxy.network === 'ws' && proxy.wsOpts) {
      config.path = proxy.wsOpts.path || '/';
      if (proxy.wsOpts.headers && proxy.wsOpts.headers.Host) {
        config.host = proxy.wsOpts.headers.Host;
      }
      if (proxy.wsOpts['max-early-data']) {
        config.ed = proxy.wsOpts['max-early-data'];
        if (proxy.wsOpts['early-data-header-name']) {
          config.edh = proxy.wsOpts['early-data-header-name'];
        }
      }
    }

    const encoded = Buffer.from(JSON.stringify(config)).toString('base64');
    return `vmess://${encoded}`;
  }

  convertTrojan(proxy) {
    const params = new URLSearchParams();
    if (proxy.sni) params.append('sni', proxy.sni);
    if (proxy.skipCertVerify) params.append('allowInsecure', '1');
    if (proxy.network && proxy.network !== 'tcp') {
      params.append('type', proxy.network);
      if (proxy.network === 'ws' && proxy.wsOpts) {
        if (proxy.wsOpts.path) params.append('path', proxy.wsOpts.path);
        if (proxy.wsOpts.headers && proxy.wsOpts.headers.Host) {
          params.append('host', proxy.wsOpts.headers.Host);
        }
        if (proxy.wsOpts['max-early-data']) {
          params.append('ed', proxy.wsOpts['max-early-data']);
          if (proxy.wsOpts['early-data-header-name']) {
            params.append('edh', proxy.wsOpts['early-data-header-name']);
          }
        }
      }
    }

    let uri = `trojan://${proxy.password}@${proxy.server}:${proxy.port}`;
    const queryString = params.toString();
    if (queryString) uri += `?${queryString}`;
    uri += `#${encodeURIComponent(proxy.name)}`;
    return uri;
  }

  convertVLESS(proxy) {
    const params = new URLSearchParams();
    const security = proxy.reality ? 'reality' : proxy.tls ? 'tls' : 'none';

    if (proxy.flow) params.append('flow', proxy.flow);
    params.append('security', security);

    if (proxy.tls && proxy.servername) params.append('sni', proxy.servername);
    if (proxy.reality?.publicKey) params.append('pbk', proxy.reality.publicKey);
    if (proxy.reality?.shortId) params.append('sid', proxy.reality.shortId);
    if (proxy.reality?.spiderX) params.append('spx', proxy.reality.spiderX);

    if (proxy.skipCertVerify) params.append('allowInsecure', '1');
    if (proxy.network) params.append('type', proxy.network);

    if (proxy.network === 'ws' && proxy.wsOpts) {
      if (proxy.wsOpts.path) params.append('path', proxy.wsOpts.path);
      if (proxy.wsOpts.headers && proxy.wsOpts.headers.Host) {
        params.append('host', proxy.wsOpts.headers.Host);
      }
      if (proxy.wsOpts['max-early-data']) {
        params.append('ed', proxy.wsOpts['max-early-data']);
        if (proxy.wsOpts['early-data-header-name']) {
          params.append('edh', proxy.wsOpts['early-data-header-name']);
        }
      }
    }

    let uri = `vless://${proxy.uuid}@${proxy.server}:${proxy.port}`;
    uri += `?${params.toString()}`;
    uri += `#${encodeURIComponent(proxy.name)}`;
    return uri;
  }

  convertHysteria(proxy) {
    const params = new URLSearchParams();
    if (proxy.protocol) params.append('protocol', proxy.protocol);
    if (proxy.auth) params.append('auth', proxy.auth);
    if (proxy.up) params.append('upmbps', proxy.up);
    if (proxy.down) params.append('downmbps', proxy.down);
    if (proxy.obfs) params.append('obfs', proxy.obfs);
    if (proxy.alpn && proxy.alpn.length > 0) params.append('alpn', proxy.alpn.join(','));
    if (proxy.sni) params.append('peer', proxy.sni);
    if (proxy.skipCertVerify) params.append('insecure', '1');

    let uri = `hysteria://${proxy.server}:${proxy.port}`;
    const queryString = params.toString();
    if (queryString) uri += `?${queryString}`;
    uri += `#${encodeURIComponent(proxy.name)}`;
    return uri;
  }

  convertHysteria2(proxy) {
    const params = new URLSearchParams();
    if (proxy.obfs) params.append('obfs', proxy.obfs);
    if (proxy.obfsPassword) params.append('obfs-password', proxy.obfsPassword);
    if (proxy.sni) params.append('sni', proxy.sni);
    if (proxy.skipCertVerify) params.append('insecure', '1');
    if (proxy.up) params.append('up', proxy.up);
    if (proxy.down) params.append('down', proxy.down);
    if (proxy.alpn && proxy.alpn.length > 0) params.append('alpn', proxy.alpn.join(','));
    if (proxy.hopInterval) params.append('hop-interval', proxy.hopInterval);

    let uri = `hysteria2://${encodeURIComponent(proxy.password)}@${proxy.server}:${proxy.port}`;
    const queryString = params.toString();
    if (queryString) uri += `?${queryString}`;
    uri += `#${encodeURIComponent(proxy.name)}`;
    return uri;
  }

  convertTUIC(proxy) {
    const params = new URLSearchParams();
    if (proxy.version) params.append('version', proxy.version);
    if (proxy.alpn && proxy.alpn.length > 0) params.append('alpn', proxy.alpn.join(','));
    if (proxy.sni) params.append('sni', proxy.sni);
    if (proxy.skipCertVerify) params.append('insecure', '1');
    if (proxy.congestionController) params.append('congestion_control', proxy.congestionController);
    if (proxy.udpRelayMode) params.append('udp_relay_mode', proxy.udpRelayMode);
    if (proxy.hopInterval) params.append('hop-interval', proxy.hopInterval);

    let uri = `tuic://${encodeURIComponent(proxy.uuid)}:${encodeURIComponent(proxy.password)}@${proxy.server}:${proxy.port}`;
    const queryString = params.toString();
    if (queryString) uri += `?${queryString}`;
    uri += `#${encodeURIComponent(proxy.name)}`;
    return uri;
  }

  convertWireGuard(proxy) {
    const params = new URLSearchParams();
    params.append('public-key', proxy.publicKey);
    if (proxy.presharedKey) params.append('preshared-key', proxy.presharedKey);
    params.append('ip', proxy.ip);
    if (proxy.ipv6) params.append('ipv6', proxy.ipv6);
    if (proxy.mtu) params.append('mtu', proxy.mtu);

    let uri = `wireguard://${encodeURIComponent(proxy.privateKey)}@${proxy.server}:${proxy.port}`;
    uri += `?${params.toString()}`;
    uri += `#${encodeURIComponent(proxy.name)}`;
    return uri;
  }

  convertSocks5(proxy) {
    let uri = 'socks5://';
    if (proxy.username && proxy.password) {
      uri += `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@`;
    }
    uri += `${proxy.server}:${proxy.port}`;
    uri += `#${encodeURIComponent(proxy.name)}`;
    return uri;
  }

  convertHttp(proxy) {
    const protocol = proxy.tls ? 'https' : 'http';
    let uri = `${protocol}://`;
    if (proxy.username && proxy.password) {
      uri += `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@`;
    }
    uri += `${proxy.server}:${proxy.port}`;
    uri += `#${encodeURIComponent(proxy.name)}`;
    return uri;
  }
}

/**
 * Base64 格式生成器
 */
class Base64Producer extends URIProducer {
  constructor() {
    super();
    this.name = 'Base64 Producer';
  }

  produce(proxies) {
    const uris = super.produce(proxies);
    return Buffer.from(uris).toString('base64');
  }
}

/**
 * Surge 格式生成器
 */
class SurgeProducer extends Producer {
  constructor() {
    super('Surge Producer');
  }

  produce(proxies) {
    const proxyLines = proxies.map(proxy => this.convertToSurgeFormat(proxy)).filter(line => line !== null);
    return proxyLines.join('\n');
  }

  convertToSurgeFormat(proxy) {
    switch (proxy.type) {
      case 'ss':
        return this.convertShadowsocks(proxy);
      case 'vmess':
        return this.convertVMess(proxy);
      case 'trojan':
        return this.convertTrojan(proxy);
      case 'http':
        return this.convertHttp(proxy);
      case 'socks5':
        return this.convertSocks5(proxy);
      case 'hysteria2':
        return this.convertHysteria2(proxy);
      case 'tuic':
        return this.convertTUIC(proxy);
      case 'wireguard':
        // 先输出注释形式的占位，避免直接丢失节点
        return this.convertWireGuardSurgeComment(proxy);
      default:
        return null; // Surge 不支持的类型跳过
    }
  }

  convertShadowsocks(proxy) {
    const parts = [];
    parts.push(`${proxy.name} = ss`);
    parts.push(proxy.server);
    parts.push(proxy.port.toString());
    parts.push(`encrypt-method=${proxy.cipher}`);
    parts.push(`password=${proxy.password}`);

    // obfs
    if (proxy.plugin === 'obfs' && proxy.pluginOpts) {
      if (proxy.pluginOpts.mode) {
        parts.push(`obfs=${proxy.pluginOpts.mode}`);
      }
      if (proxy.pluginOpts.host !== undefined) {
        parts.push(`obfs-host=${proxy.pluginOpts.host}`);
      }
      if (proxy.pluginOpts.path) {
        parts.push(`obfs-uri=${proxy.pluginOpts.path}`);
      }
    }

    if (proxy.udp) {
      parts.push('udp-relay=true');
    }

    return parts.join(', ');
  }

  convertVMess(proxy) {
    const parts = [];
    parts.push(`${proxy.name} = vmess`);
    parts.push(proxy.server);
    parts.push(proxy.port.toString());
    parts.push(`username=${proxy.uuid}`);

    if (proxy.tls) {
      parts.push('tls=true');
      if (proxy.sni) {
        parts.push(`sni=${proxy.sni}`);
      }
      if (proxy.skipCertVerify) {
        parts.push('skip-cert-verify=true');
      }
    }

    // ws
    if (proxy.network === 'ws' && proxy.wsOpts) {
      parts.push('ws=true');
      if (proxy.wsOpts.path) {
        parts.push(`ws-path=${proxy.wsOpts.path}`);
      }
      if (proxy.wsOpts.headers && proxy.wsOpts.headers.Host) {
        parts.push(`ws-headers=Host:${proxy.wsOpts.headers.Host}`);
      }
    }

    return parts.join(', ');
  }

  convertTrojan(proxy) {
    const parts = [];
    parts.push(`${proxy.name} = trojan`);
    parts.push(proxy.server);
    parts.push(proxy.port.toString());
    parts.push(`password=${proxy.password}`);

    if (proxy.sni) {
      parts.push(`sni=${proxy.sni}`);
    }

    if (proxy.skipCertVerify) {
      parts.push('skip-cert-verify=true');
    }

    // ws
    if (proxy.network === 'ws' && proxy.wsOpts) {
      parts.push('ws=true');
      if (proxy.wsOpts.path) {
        parts.push(`ws-path=${proxy.wsOpts.path}`);
      }
      if (proxy.wsOpts.headers && proxy.wsOpts.headers.Host) {
        parts.push(`ws-headers=Host:${proxy.wsOpts.headers.Host}`);
      }
    }

    return parts.join(', ');
  }

  convertHttp(proxy) {
    const parts = [];
    parts.push(`${proxy.name} = http`);
    parts.push(proxy.server);
    parts.push(proxy.port.toString());

    if (proxy.username) {
      parts.push(`username=${proxy.username}`);
    }
    if (proxy.password) {
      parts.push(`password=${proxy.password}`);
    }

    if (proxy.tls) {
      parts.push('tls=true');
      if (proxy.skipCertVerify) {
        parts.push('skip-cert-verify=true');
      }
    }

    return parts.join(', ');
  }

  convertSocks5(proxy) {
    const parts = [];
    parts.push(`${proxy.name} = socks5`);
    parts.push(proxy.server);
    parts.push(proxy.port.toString());

    if (proxy.username) {
      parts.push(`username=${proxy.username}`);
    }
    if (proxy.password) {
      parts.push(`password=${proxy.password}`);
    }

    if (proxy.tls) {
      parts.push('tls=true');
      if (proxy.skipCertVerify) {
        parts.push('skip-cert-verify=true');
      }
    }

    return parts.join(', ');
  }

  convertHysteria2(proxy) {
    const parts = [];
    parts.push(`${proxy.name} = hysteria2`);
    parts.push(proxy.server);
    parts.push(proxy.port.toString());

    if (proxy.password) {
      parts.push(`password="${proxy.password}"`);
    }

    if (proxy.hopInterval) {
      parts.push(`port-hopping-interval=${proxy.hopInterval}`);
    }

    if (proxy.sni) {
      parts.push(`sni=${proxy.sni}`);
    }

    if (proxy.skipCertVerify) {
      parts.push('skip-cert-verify=true');
    }

    if (proxy.alpn && proxy.alpn.length > 0) {
      parts.push(`alpn=${proxy.alpn[0]}`);
    }

    return parts.join(', ');
  }

  convertTUIC(proxy) {
    const parts = [];
    const type = 'tuic-v5';
    parts.push(`${proxy.name} = ${type}`);
    parts.push(proxy.server);
    parts.push(proxy.port.toString());

    if (proxy.uuid) {
      parts.push(`uuid=${proxy.uuid}`);
    }
    if (proxy.password) {
      parts.push(`password="${proxy.password}"`);
    }

    if (proxy.alpn && proxy.alpn.length > 0) {
      parts.push(`alpn=${proxy.alpn[0]}`);
    }

    if (proxy.hopInterval) {
      parts.push(`port-hopping-interval=${proxy.hopInterval}`);
    }

    if (proxy.sni) {
      parts.push(`sni=${proxy.sni}`);
    }

    if (proxy.skipCertVerify) {
      parts.push('skip-cert-verify=true');
    }

    return parts.join(', ');
  }

  convertWireGuardSurgeComment(proxy) {
    const parts = [];
    parts.push(`# > WireGuard Proxy ${proxy.name}`);
    parts.push(`# ${proxy.name}=wireguard,${proxy.server},${proxy.port}`);
    return parts.join('\n');
  }
}

/**
 * QuantumultX 格式生成器
 */
class QuantumultXProducer extends Producer {
  constructor() {
    super('QuantumultX Producer');
  }

  produce(proxies) {
    const proxyLines = proxies.map(proxy => this.convertToQuantumultXFormat(proxy)).filter(line => line !== null);
    return proxyLines.join('\n');
  }

  convertToQuantumultXFormat(proxy) {
    switch (proxy.type) {
      case 'ss':
        return this.convertShadowsocks(proxy);
      case 'vmess':
        return this.convertVMess(proxy);
      case 'trojan':
        return this.convertTrojan(proxy);
      case 'http':
        return this.convertHttp(proxy);
      case 'socks5':
        return this.convertSocks5(proxy);
      case 'hysteria2':
        return this.convertHysteria2(proxy);
      default:
        return null;
    }
  }

  convertShadowsocks(proxy) {
    let line = `shadowsocks=${proxy.server}:${proxy.port}`;
    line += `, method=${proxy.cipher}`;
    line += `, password=${proxy.password}`;

    // obfs
    if (proxy.plugin === 'obfs' && proxy.pluginOpts) {
      if (proxy.pluginOpts.mode) {
        line += `, obfs=${proxy.pluginOpts.mode}`;
      }
      if (proxy.pluginOpts.host) {
        line += `, obfs-host=${proxy.pluginOpts.host}`;
      }
      if (proxy.pluginOpts.path) {
        line += `, obfs-uri=${proxy.pluginOpts.path}`;
      }
    }

    line += `, tag=${proxy.name}`;
    return line;
  }

  convertVMess(proxy) {
    let line = `vmess=${proxy.server}:${proxy.port}`;
    line += `, method=chacha20-poly1305`;
    line += `, password=${proxy.uuid}`;

    if (proxy.tls) {
      line += ', obfs=over-tls';
    }

    if (proxy.network === 'ws' && proxy.wsOpts) {
      if (proxy.wsOpts.path) {
        line += `, obfs-uri=${proxy.wsOpts.path}`;
      }
      if (proxy.wsOpts.headers && proxy.wsOpts.headers.Host) {
        line += `, obfs-host=${proxy.wsOpts.headers.Host}`;
      }
    }

    line += `, tag=${proxy.name}`;
    return line;
  }

  convertTrojan(proxy) {
    let line = `trojan=${proxy.server}:${proxy.port}`;
    line += `, password=${proxy.password}`;
    line += ', over-tls=true';

    if (proxy.sni) {
      line += `, tls-host=${proxy.sni}`;
    }

    if (proxy.skipCertVerify) {
      line += ', tls-verification=false';
    }

    line += `, tag=${proxy.name}`;
    return line;
  }

  convertHttp(proxy) {
    let line = `http=${proxy.server}:${proxy.port}`;

    if (proxy.username) {
      line += `, username=${proxy.username}`;
    }
    if (proxy.password) {
      line += `, password=${proxy.password}`;
    }

    if (proxy.tls) {
      line += ', over-tls=true';
    }

    line += `, tag=${proxy.name}`;
    return line;
  }

  convertSocks5(proxy) {
    let line = `socks5=${proxy.server}:${proxy.port}`;

    if (proxy.username) {
      line += `, username=${proxy.username}`;
    }
    if (proxy.password) {
      line += `, password=${proxy.password}`;
    }

    line += `, tag=${proxy.name}`;
    return line;
  }

  convertHysteria2(proxy) {
    let line = `hysteria2=${proxy.server}:${proxy.port}`;

    if (proxy.password) {
      line += `, password=${proxy.password}`;
    }

    if (proxy.up) {
      line += `, up=${proxy.up}`;
    }
    if (proxy.down) {
      line += `, down=${proxy.down}`;
    }

    if (proxy.obfs === 'salamander') {
      line += `, obfs=salamander`;
      if (proxy.obfsPassword) {
        line += `, obfs-password=${proxy.obfsPassword}`;
      }
    }

    if (proxy.sni) {
      line += `, sni=${proxy.sni}`;
    }

    if (proxy.skipCertVerify) {
      line += ', skip-cert-verify=true';
    }

    if (proxy.alpn && proxy.alpn.length > 0) {
      line += `, alpn=${proxy.alpn.join('|')}`;
    }

    line += `, tag=${proxy.name}`;
    return line;
  }
}

/**
 * Shadowrocket 格式生成器
 * Shadowrocket 通常使用 URI 格式
 */
class ShadowrocketProducer extends URIProducer {
  constructor() {
    super();
    this.name = 'Shadowrocket Producer';
  }
}

/**
 * V2Ray 格式生成器
 */
class V2RayProducer extends Producer {
  constructor() {
    super('V2Ray Producer');
  }

  produce(proxies) {
    const outbounds = proxies.map(proxy => this.convertProxy(proxy));
    const config = {
      outbounds: outbounds
    };
    return JSON.stringify(config, null, 2);
  }

  convertProxy(proxy) {
    const outbound = {
      tag: proxy.name,
      protocol: proxy.type
    };

    // 根据不同类型添加settings
    switch (proxy.type) {
      case 'vmess':
        outbound.settings = {
          vnext: [{
            address: proxy.server,
            port: proxy.port,
            users: [{
              id: proxy.uuid,
              alterId: proxy.alterId || 0,
              security: proxy.cipher || 'auto'
            }]
          }]
        };
        break;
      case 'ss':
        outbound.settings = {
          servers: [{
            address: proxy.server,
            port: proxy.port,
            method: proxy.cipher,
            password: proxy.password
          }]
        };
        break;
      case 'trojan':
        outbound.settings = {
          servers: [{
            address: proxy.server,
            port: proxy.port,
            password: proxy.password
          }]
        };
        break;
      case 'socks5':
        outbound.settings = {
          servers: [{
            address: proxy.server,
            port: proxy.port,
            users: proxy.username ? [{
              user: proxy.username,
              pass: proxy.password
            }] : undefined
          }]
        };
        break;
      case 'http':
        outbound.settings = {
          servers: [{
            address: proxy.server,
            port: proxy.port,
            users: proxy.username ? [{
              user: proxy.username,
              pass: proxy.password
            }] : undefined
          }]
        };
        break;
    }

    return outbound;
  }
}

/**
 * 生成器工厂
 */
class ProxyProducers {
  static getProducer(format) {
    console.log('[ProxyProducers] getProducer called with format:', format);
    console.log('[ProxyProducers] OutputFormat:', OutputFormat);
    console.log('[ProxyProducers] OutputFormat.CLASH:', OutputFormat.CLASH);
    console.log('[ProxyProducers] OutputFormat.CLASH_META:', OutputFormat.CLASH_META);

    switch (format) {
      case OutputFormat.CLASH:
        return new ClashProducer();
      case OutputFormat.CLASH_META:
        return new ClashMetaProducer();
      case OutputFormat.SING_BOX:
        return new SingBoxProducer();
      case OutputFormat.SURGE:
        return new SurgeProducer();
      case OutputFormat.QUANTUMULT_X:
        return new QuantumultXProducer();
      case OutputFormat.SHADOWROCKET:
        return new ShadowrocketProducer();
      case OutputFormat.V2RAY:
        return new V2RayProducer();
      case OutputFormat.URI:
        return new URIProducer();
      case OutputFormat.BASE64:
        return new Base64Producer();
      default:
        throw new Error(`Unsupported format: ${format}`);
    }
  }
}

module.exports = {
  Producer,
  ClashProducer,
  ClashMetaProducer,
  SingBoxProducer,
  SurgeProducer,
  QuantumultXProducer,
  ShadowrocketProducer,
  V2RayProducer,
  URIProducer,
  Base64Producer,
  ProxyProducers,
  OutputFormat
};
