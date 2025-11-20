/**
 * 订阅内容预处理器
 * 参考 Sub-Store 的预处理逻辑，支持多种订阅格式
 * 对应安卓端的 SubscriptionPreprocessor.kt
 */

const yaml = require('js-yaml');
const SurgeParser = require('./surge-parser');
const QXParser = require('./qx-parser');

class SubscriptionPreprocessor {
  /**
   * 预处理订阅内容
   * 支持格式：
   * 1. HTML（丢弃）
   * 2. Clash YAML 配置文件
   * 3. SSD 格式
   * 4. Surge/QuantumultX 完整配置文件
   * 5. Base64 编码（智能检测）
   * 6. Fallback Base64
   */
  static preprocess(raw) {
    const trimmed = raw.trim();
    console.log(`[SubscriptionPreprocessor] Processing input (${trimmed.length} bytes)`);

    // 1. HTML - 直接丢弃
    if (trimmed.toLowerCase().startsWith('<!doctype html>') ||
        trimmed.toLowerCase().startsWith('<html')) {
      console.log('[SubscriptionPreprocessor] Detected HTML response, discarding');
      return '';
    }

    // 2. 处理 Sing-box 配置
    const singBoxResult = this.handleSingBox(trimmed);
    if (singBoxResult) {
      console.log('[SubscriptionPreprocessor] Successfully processed as Sing-box config');
      return singBoxResult;
    }

    // 3. 处理 Clash 配置
    const clashResult = this.handleClash(trimmed);
    if (clashResult) {
      console.log('[SubscriptionPreprocessor] Successfully processed as Clash config');
      return clashResult;
    }

    // 4. 处理 SSD 格式
    if (trimmed.startsWith('ssd://')) {
      console.log('[SubscriptionPreprocessor] Processing as SSD format');
      return this.handleSSD(trimmed);
    }

    // 5. 处理 Surge/QuantumultX 完整配置
    if (trimmed.includes('[Proxy]') || trimmed.includes('[Server]') || trimmed.includes('[server_local]')) {
      console.log('[SubscriptionPreprocessor] Processing as Surge/QuantumultX config');
      return this.extractProxiesFromConfig(trimmed);
    }

    // 6. 智能检测 Base64 (检查是否包含 Base64 编码的协议关键字)
    const base64Keys = [
      'dm1lc3M',      // vmess
      'c3NyOi8v',     // ssr://
      'c29ja3M6Ly',   // socks://
      'dHJvamFu',     // trojan
      'c3M6Ly',       // ss:/
      'c3NkOi8v',     // ssd://
      'c2hhZG93',     // shadow
      'aHR0c',        // htt
      'dmxlc3M=',     // vless
      'aHlzdGVyaWEy', // hysteria2
      'aHkyOi8v',     // hy2://
      'd2lyZWd1YXJkOi8v', // wireguard://
      'd2c6Ly8=',     // wg://
      'dHVpYzovLw=='  // tuic://
    ];

    // 如果不包含协议前缀，但包含 Base64 关键字，尝试解码
    if (!/^\w+:\/\/\w+/.test(trimmed) && base64Keys.some(key => trimmed.includes(key))) {
      try {
        const decoded = Buffer.from(trimmed, 'base64').toString('utf-8');
        // 验证解码后的内容是否包含协议
        if (/^\w+(:|\/\/|\s*?=\s*?)\w+/m.test(decoded)) {
          console.log('[SubscriptionPreprocessor] Detected Base64 encoded content (smart detection)');
          // 递归处理解码后的内容
          const singBoxResult = this.handleSingBox(decoded);
          if (singBoxResult) return singBoxResult;
          return this.preprocess(decoded);
        }
      } catch (e) {
        console.log('[SubscriptionPreprocessor] Base64 smart detection failed:', e.message);
      }
    }

    // 7. Fallback Base64 - 最后尝试解码
    // 如果看起来像 Base64，无论是否包含协议字符，都尝试一次解码
    if (this.looksLikeBase64(trimmed)) {
      const decoded = this.tryDecodeBase64(trimmed);
      if (decoded && /^\w+(:|\/\/|\s*?=\s*?)\w+/m.test(decoded)) {
        console.log('[SubscriptionPreprocessor] Detected Base64 encoded content (fallback)');
        // 递归处理解码后的内容
        const singBoxResult = this.handleSingBox(decoded);
        if (singBoxResult) return singBoxResult;
        return this.preprocess(decoded);
      }
    }

    // 8. 返回原始内容
    console.log('[SubscriptionPreprocessor] No special format detected, returning raw content');
    return trimmed;
  }

  /**
   * 处理 Sing-box 配置
   */
  static handleSingBox(content) {
    try {
      const json = JSON.parse(content);

      // 检查是否是 Sing-box 配置
      if (json.outbounds && Array.isArray(json.outbounds)) {
        console.log(`[SubscriptionPreprocessor] Detected Sing-box config with ${json.outbounds.length} outbounds`);

        // 提取所有代理节点并转换为 Clash JSON
        const jsonLines = json.outbounds
          .filter(outbound => {
            const type = outbound.type?.toLowerCase();
            const isProxy = type && !['direct', 'block', 'dns', 'selector', 'urltest'].includes(type);
            if (!isProxy && type) {
              console.log(`[SubscriptionPreprocessor] Skipping Sing-box outbound type: ${type}`);
            }
            return isProxy;
          })
          .map(outbound => {
            const clashProxy = this.convertSingBoxToClashJson(outbound);
            if (clashProxy) {
              console.log(`[SubscriptionPreprocessor] Converted Sing-box ${outbound.type}: ${outbound.tag}`);
            } else {
              console.warn(`[SubscriptionPreprocessor] Failed to convert Sing-box ${outbound.type}: ${outbound.tag}`);
            }
            return clashProxy ? JSON.stringify(clashProxy) : null;
          })
          .filter(line => line !== null);

        if (jsonLines.length > 0) {
          console.log(`[SubscriptionPreprocessor] Converted ${jsonLines.length} proxies from Sing-box config`);
          return jsonLines.join('\n');
        } else {
          console.warn('[SubscriptionPreprocessor] No valid proxies found in Sing-box config');
        }
      }
    } catch (e) {
      // 不是 JSON 或不是 Sing-box 配置
    }
    return null;
  }

  /**
   * 处理 Clash 配置
   */
  static handleClash(content) {
    // 检查是否包含 proxies: 关键字
    if (!content.includes('proxies:') && !content.includes('proxies :')) {
      return null;
    }

    try {
      const normalized = this.normalizeClashContent(content);
      const config = yaml.load(normalized);

      if (config && config.proxies && Array.isArray(config.proxies)) {
        console.log(`[SubscriptionPreprocessor] Detected Clash YAML format with ${config.proxies.length} proxies`);

        // 处理 global-client-fingerprint
        const globalFingerprint = config['global-client-fingerprint'];

        // 将每个代理转换为 JSON 字符串，每行一个
        const jsonLines = config.proxies.map(proxy => {
          // 如果有全局 fingerprint 且代理没有，则添加
          if (globalFingerprint && !proxy['client-fingerprint']) {
            proxy['client-fingerprint'] = globalFingerprint;
          }
          return JSON.stringify(proxy);
        });

        return jsonLines.join('\n');
      }
    } catch (e) {
      console.log('[SubscriptionPreprocessor] Not a valid Clash YAML:', e.message);
    }
    return null;
  }

  /**
   * 处理 SSD 格式
   */
  static handleSSD(ssdUrl) {
    try {
      const content = ssdUrl.substring(6); // 移除 "ssd://"
      const decoded = Buffer.from(content, 'base64').toString('utf-8');
      const config = JSON.parse(decoded);

      const proxies = [];
      const servers = config.servers || [];
      
      for (const server of servers) {
        const proxy = `ss://${Buffer.from(
          `${config.encryption}:${config.password}@${server.server}:${server.port}`
        ).toString('base64')}#${encodeURIComponent(server.remarks || server.server)}`;
        proxies.push(proxy);
      }

      return proxies.join('\n');
    } catch (e) {
      console.warn('[SubscriptionPreprocessor] SSD parse failed:', e.message);
      return '';
    }
  }

  /**
   * 从完整配置中提取代理部分 (Surge/QuantumultX)
   */
  static extractProxiesFromConfig(content) {
    try {
      console.log('[SubscriptionPreprocessor] Detected Full Config format (Surge/QuantumultX)');
      const lines = content.split('\n');
      const headerRegex = /^\s*\[(.+?)]/;
      const extracted = [];
      let inTargetSection = false;
      let collectedSection = false;
      let isSurge = false;
      let isQX = false;

      for (const originalLine of lines) {
        const line = originalLine.trimEnd();
        const headerMatch = line.match(headerRegex);

        if (headerMatch) {
          const sectionName = headerMatch[1].trim().toLowerCase();
          if (sectionName === 'proxy') {
            // Surge 格式
            if (!collectedSection) {
              inTargetSection = true;
              isSurge = true;
              isQX = false;
              extracted.length = 0; // 清空之前的内容
            } else {
              inTargetSection = false;
            }
          } else if (sectionName === 'server_local') {
            // QuantumultX 格式
            if (!collectedSection) {
              inTargetSection = true;
              isQX = true;
              isSurge = false;
              extracted.length = 0; // 清空之前的内容
            } else {
              inTargetSection = false;
            }
          } else {
            if (inTargetSection) {
              collectedSection = true;
            }
            inTargetSection = false;
          }
          continue;
        }

        if (inTargetSection && line.trim()) {
          extracted.push(line);
        }
      }

      if (extracted.length === 0) {
        return '';
      }

      console.log(`[SubscriptionPreprocessor] Extracted ${extracted.length} lines from Full Config`);

      // 解析并转换为 JSON 行格式
      const jsonLines = [];
      for (const line of extracted) {
        try {
          let proxy = null;
          if (isSurge) {
            console.log('[SubscriptionPreprocessor] Parsing Surge line:', line.substring(0, 100));
            proxy = SurgeParser.parseLine(line);
          } else if (isQX) {
            console.log('[SubscriptionPreprocessor] Parsing QX line:', line.substring(0, 100));
            proxy = QXParser.parseLine(line);
          }

          if (proxy) {
            // 转换为 Clash JSON 格式
            const clashJson = this.convertProxyToClashJson(proxy);
            if (clashJson) {
              jsonLines.push(JSON.stringify(clashJson));
              console.log('[SubscriptionPreprocessor] Successfully converted proxy:', proxy.name);
            }
          }
        } catch (e) {
          console.warn('[SubscriptionPreprocessor] Failed to parse line:', line.substring(0, 100), e.message);
        }
      }

      if (jsonLines.length > 0) {
        console.log(`[SubscriptionPreprocessor] Converted ${jsonLines.length} proxies from Full Config`);
        return jsonLines.join('\n');
      }
    } catch (e) {
      console.log('[SubscriptionPreprocessor] Failed to extract from Full Config:', e.message);
    }
    return '';
  }

  /**
   * 将代理对象转换为 Clash JSON 格式
   */
  static convertProxyToClashJson(proxy) {
    if (!proxy) return null;

    const json = {
      name: proxy.name,
      type: proxy.type,
      server: proxy.server,
      port: proxy.port
    };

    // 复制所有其他属性,但要转换属性名
    for (const key in proxy) {
      if (['name', 'type', 'server', 'port'].includes(key)) {
        continue;
      }

      const value = proxy[key];
      if (value === null || value === undefined) {
        continue;
      }

      // 转换属性名: camelCase -> kebab-case
      const clashKey = this.toKebabCase(key);
      json[clashKey] = value;
    }

    return json;
  }

  /**
   * 将 camelCase 转换为 kebab-case
   */
  static toKebabCase(str) {
    // 特殊映射
    const specialMappings = {
      'skipCertVerify': 'skip-cert-verify',
      'pluginOpts': 'plugin-opts',
      'wsOpts': 'ws-opts',
      'grpcOpts': 'grpc-opts',
      'h2Opts': 'h2-opts',
      'httpOpts': 'http-opts',
      'alterId': 'alterId', // VMess 保持原样
      'servername': 'servername' // 保持原样
    };

    if (specialMappings[str]) {
      return specialMappings[str];
    }

    // 默认转换
    return str.replace(/([A-Z])/g, '-$1').toLowerCase();
  }

  /**
   * 检测是否看起来像 Base64
   */
  static looksLikeBase64(str) {
    // Base64 字符集
    const base64Regex = /^[A-Za-z0-9+/=]+$/;
    
    // 必须匹配 Base64 字符集
    if (!base64Regex.test(str)) {
      return false;
    }
    
    // 长度必须是 4 的倍数（Base64 特性）
    if (str.length % 4 !== 0) {
      return false;
    }
    
    // 不应该包含换行符（已经是单行）
    if (str.includes('\n')) {
      return false;
    }
    
    // 长度应该足够长（至少 20 个字符）
    return str.length >= 20;
  }

  /**
   * 预处理 Clash YAML，修正容易被解析成 Infinity 的 short-id 字段
   */
  static normalizeClashContent(content) {
    return content.replace(/short-id:([ \t]*[^#\n,}]*)/g, (matched, value) => {
      const afterTrim = value.trim();

      if (!afterTrim) {
        return 'short-id: ""';
      }

      if (/^(['"]).*\1$/.test(afterTrim)) {
        return `short-id: ${afterTrim}`;
      }

      if (afterTrim === 'null') {
        return 'short-id: null';
      }

      return `short-id: "${afterTrim}"`;
    });
  }

  /**
   * 尝试 Base64 解码，失败返回 null
   */
  static tryDecodeBase64(raw) {
    try {
      return Buffer.from(raw, 'base64').toString('utf-8');
    } catch {
      return null;
    }
  }

  /**
   * 将 Sing-box outbound 转换为 Clash JSON
   */
  static convertSingBoxToClashJson(outbound) {
    const type = outbound.type?.toLowerCase();
    
    try {
      switch (type) {
        case 'shadowsocks':
          return this.convertSingBoxSS(outbound);
        case 'vmess':
          return this.convertSingBoxVMess(outbound);
        case 'trojan':
          return this.convertSingBoxTrojan(outbound);
        case 'vless':
          return this.convertSingBoxVLESS(outbound);
        case 'hysteria':
          return this.convertSingBoxHysteria(outbound);
        case 'hysteria2':
          return this.convertSingBoxHysteria2(outbound);
        case 'tuic':
          return this.convertSingBoxTUIC(outbound);
        case 'wireguard':
          return this.convertSingBoxWireGuard(outbound);
        default:
          console.warn(`[SubscriptionPreprocessor] Unsupported Sing-box type: ${type}`);
          return null;
      }
    } catch (e) {
      console.error(`[SubscriptionPreprocessor] Failed to convert ${type}:`, e.message);
      return null;
    }
  }

  /**
   * 转换 Sing-box Shadowsocks
   */
  static convertSingBoxSS(outbound) {
    const proxy = {
      name: outbound.tag || 'SS',
      type: 'ss',
      server: outbound.server,
      port: outbound.server_port || outbound.port,
      cipher: outbound.method,
      password: outbound.password,
      udp: true
    };

    // Plugin 配置
    if (outbound.plugin) {
      proxy.plugin = outbound.plugin;
      if (outbound.plugin_opts) {
        proxy['plugin-opts'] = outbound.plugin_opts;
      }
    }

    return proxy;
  }

  /**
   * 转换 Sing-box VMess
   */
  static convertSingBoxVMess(outbound) {
    const proxy = {
      name: outbound.tag || 'VMess',
      type: 'vmess',
      server: outbound.server,
      port: outbound.server_port,
      uuid: outbound.uuid,
      alterId: outbound.alter_id || 0,
      cipher: outbound.security || 'auto',
      udp: true
    };

    // TLS 配置
    if (outbound.tls) {
      proxy.tls = true;
      if (outbound.tls.server_name) {
        proxy.servername = outbound.tls.server_name;
      }
      if (outbound.tls.insecure) {
        proxy['skip-cert-verify'] = true;
      }
    }

    // 传输层配置
    if (outbound.transport) {
      const transport = outbound.transport;
      proxy.network = transport.type || 'tcp';
      
      if (transport.type === 'ws') {
        proxy['ws-opts'] = {
          path: transport.path || '/',
          headers: transport.headers || {}
        };
      } else if (transport.type === 'grpc') {
        proxy['grpc-opts'] = {
          'grpc-service-name': transport.service_name || ''
        };
      }
    }

    return proxy;
  }

  /**
   * 转换 Sing-box Trojan
   */
  static convertSingBoxTrojan(outbound) {
    const proxy = {
      name: outbound.tag || 'Trojan',
      type: 'trojan',
      server: outbound.server,
      port: outbound.server_port || outbound.port,
      password: outbound.password,
      udp: true
    };

    // TLS 配置
    if (outbound.tls) {
      if (outbound.tls.server_name) {
        proxy.sni = outbound.tls.server_name;
      }
      if (outbound.tls.insecure) {
        proxy['skip-cert-verify'] = true;
      }
    }

    // 传输层配置
    if (outbound.transport) {
      const transport = outbound.transport;
      proxy.network = transport.type || 'tcp';

      if (transport.type === 'ws') {
        proxy['ws-opts'] = {
          path: transport.path || '/',
          headers: transport.headers || {}
        };
      } else if (transport.type === 'grpc') {
        proxy['grpc-opts'] = {
          'grpc-service-name': transport.service_name || ''
        };
      }
    }

    return proxy;
  }

  /**
   * 转换 Sing-box VLESS
   */
  static convertSingBoxVLESS(outbound) {
    const proxy = {
      name: outbound.tag || 'VLESS',
      type: 'vless',
      server: outbound.server,
      port: outbound.server_port || outbound.port,
      uuid: outbound.uuid,
      udp: true
    };

    // TLS 配置
    if (outbound.tls) {
      proxy.tls = true;
      if (outbound.tls.server_name) {
        proxy.servername = outbound.tls.server_name;
      }
      if (outbound.tls.insecure) {
        proxy['skip-cert-verify'] = true;
      }
    }

    // 传输层配置
    if (outbound.transport) {
      const transport = outbound.transport;
      proxy.network = transport.type || 'tcp';

      if (transport.type === 'ws') {
        proxy['ws-opts'] = {
          path: transport.path || '/',
          headers: transport.headers || {}
        };
      } else if (transport.type === 'grpc') {
        proxy['grpc-opts'] = {
          'grpc-service-name': transport.service_name || ''
        };
      }
    }

    return proxy;
  }

  /**
   * 转换 Sing-box Hysteria
   */
  static convertSingBoxHysteria(outbound) {
    return {
      name: outbound.tag || 'Hysteria',
      type: 'hysteria',
      server: outbound.server,
      port: outbound.server_port || outbound.port,
      auth: outbound.auth || outbound.auth_str,
      obfs: outbound.obfs,
      'up-mbps': outbound.up_mbps || outbound.up,
      'down-mbps': outbound.down_mbps || outbound.down,
      sni: outbound.tls?.server_name,
      'skip-cert-verify': outbound.tls?.insecure || false,
      udp: true
    };
  }

  /**
   * 转换 Sing-box Hysteria2
   */
  static convertSingBoxHysteria2(outbound) {
    return {
      name: outbound.tag || 'Hysteria2',
      type: 'hysteria2',
      server: outbound.server,
      port: outbound.server_port || outbound.port,
      password: outbound.password,
      obfs: outbound.obfs?.type,
      'obfs-password': outbound.obfs?.password,
      sni: outbound.tls?.server_name,
      'skip-cert-verify': outbound.tls?.insecure || false,
      udp: true
    };
  }

  /**
   * 转换 Sing-box TUIC
   */
  static convertSingBoxTUIC(outbound) {
    return {
      name: outbound.tag || 'TUIC',
      type: 'tuic',
      server: outbound.server,
      port: outbound.server_port || outbound.port,
      uuid: outbound.uuid,
      password: outbound.password,
      sni: outbound.tls?.server_name,
      'skip-cert-verify': outbound.tls?.insecure || false,
      udp: true
    };
  }

  /**
   * 转换 Sing-box WireGuard
   */
  static convertSingBoxWireGuard(outbound) {
    return {
      name: outbound.tag || 'WireGuard',
      type: 'wireguard',
      server: outbound.server,
      port: outbound.server_port || outbound.port,
      'private-key': outbound.private_key,
      'public-key': outbound.peer_public_key,
      'preshared-key': outbound.pre_shared_key,
      ip: outbound.local_address?.[0],
      udp: true
    };
  }
}

module.exports = SubscriptionPreprocessor;

