/**
 * 订阅内容预处理器
 * 参考 Sub-Store 的预处理逻辑，支持多种订阅格式
 * 对应安卓端的 SubscriptionPreprocessor.kt
 */

const yaml = require('js-yaml');

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

    // 1. HTML - 直接丢弃
    if (trimmed.toLowerCase().startsWith('<!doctype html>') ||
        trimmed.toLowerCase().startsWith('<html')) {
      console.log('[SubscriptionPreprocessor] Detected HTML response, discarding');
      return '';
    }

    // 2. 处理 Sing-box 配置
    const singBoxResult = this.handleSingBox(trimmed);
    if (singBoxResult) return singBoxResult;

    // 3. 处理 Clash 配置
    const clashResult = this.handleClash(trimmed);
    if (clashResult) return clashResult;

    // 4. 处理 SSD 格式
    if (trimmed.startsWith('ssd://')) {
      return this.handleSSD(trimmed);
    }

    // 5. 处理 Surge/QuantumultX 完整配置
    if (trimmed.includes('[Proxy]') || trimmed.includes('[Server]')) {
      return this.extractProxiesFromConfig(trimmed);
    }

    // 6. 智能检测 Base64
    if (this.looksLikeBase64(trimmed)) {
      try {
        const decoded = Buffer.from(trimmed, 'base64').toString('utf-8');
        // 递归处理解码后的内容
        return this.preprocess(decoded);
      } catch (e) {
        console.warn('[SubscriptionPreprocessor] Base64 decode failed:', e.message);
      }
    }

    // 7. Fallback: 尝试 Base64 解码
    // 只有在不包含协议前缀时才尝试解码
    if (!trimmed.includes('://') && !trimmed.includes(' = ') && trimmed.length > 100) {
      try {
        const decoded = Buffer.from(trimmed, 'base64').toString('utf-8');
        // 验证解码后的内容是否包含协议或配置关键字
        if (decoded && decoded.length > 0 && decoded !== trimmed &&
            (decoded.includes('://') || decoded.includes('proxies'))) {
          console.log('[SubscriptionPreprocessor] Detected Base64 encoded content (fallback)');
          return this.preprocess(decoded);
        }
      } catch (e) {
        // 忽略解码失败
      }
    }

    // 8. 返回原始内容
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
        console.log('[SubscriptionPreprocessor] Detected Sing-box config');
        
        // 提取所有代理节点
        const proxies = json.outbounds
          .filter(outbound => {
            const type = outbound.type?.toLowerCase();
            return type && !['direct', 'block', 'dns', 'selector', 'urltest'].includes(type);
          })
          .map(outbound => this.convertSingBoxToClashJson(outbound))
          .filter(proxy => proxy !== null);

        if (proxies.length > 0) {
          // 转换为 Clash YAML 格式
          const clashConfig = { proxies };
          return yaml.dump(clashConfig);
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
    try {
      const config = yaml.load(content);
      
      if (config && config.proxies && Array.isArray(config.proxies)) {
        console.log('[SubscriptionPreprocessor] Detected Clash config');
        // 返回 YAML 格式的 proxies 部分
        return yaml.dump({ proxies: config.proxies });
      }
    } catch (e) {
      // 不是有效的 YAML
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
   * 从完整配置中提取代理部分
   */
  static extractProxiesFromConfig(content) {
    const lines = content.split('\n');
    const proxies = [];
    let inProxySection = false;

    for (const line of lines) {
      const trimmed = line.trim();
      
      // 检测代理段开始
      if (trimmed === '[Proxy]' || trimmed === '[Server]') {
        inProxySection = true;
        continue;
      }
      
      // 检测代理段结束
      if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        inProxySection = false;
        continue;
      }
      
      // 提取代理行
      if (inProxySection && trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('//')) {
        proxies.push(trimmed);
      }
    }

    return proxies.join('\n');
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
    return {
      name: outbound.tag || 'SS',
      type: 'ss',
      server: outbound.server,
      port: outbound.server_port,
      cipher: outbound.method,
      password: outbound.password,
      udp: true
    };
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

  // 其他转换方法将在后续添加...
  static convertSingBoxTrojan(outbound) { return null; }
  static convertSingBoxVLESS(outbound) { return null; }
  static convertSingBoxHysteria(outbound) { return null; }
  static convertSingBoxHysteria2(outbound) { return null; }
  static convertSingBoxTUIC(outbound) { return null; }
  static convertSingBoxWireGuard(outbound) { return null; }
}

module.exports = SubscriptionPreprocessor;

