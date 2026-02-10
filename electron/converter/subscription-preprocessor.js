/**
 * 订阅内容预处理器
 * 支持多种订阅格式的预处理逻辑
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

    // 3.5 处理 Base64 包裹的分享链接列表（SIP003 / 通用 URI 列表）
    const base64UriList = this.handleBase64UriList(trimmed);
    if (base64UriList) {
      return base64UriList;
    }

    // 3.6 处理每行一个 Base64 的 URI 列表（txt 等文件内每行 Base64）
    const perLineBase64 = this.handlePerLineBase64UriList(trimmed);
    if (perLineBase64) {
      return perLineBase64;
    }

    // 4. 处理 SIP008（含 Base64 封装）
    const sip008Result = this.handleSip008(trimmed);
    if (sip008Result) {
      return sip008Result;
    }

    // 5. 处理 SSD 格式
    if (trimmed.startsWith('ssd://')) {
      console.log('[SubscriptionPreprocessor] Processing as SSD format');
      return this.handleSSD(trimmed);
    }

    // 6. 处理 Surge/QuantumultX 完整配置
    if (trimmed.includes('[Proxy]') || trimmed.includes('[Server]') || trimmed.includes('[server_local]')) {
      console.log('[SubscriptionPreprocessor] Processing as Surge/QuantumultX config');
      return this.extractProxiesFromConfig(trimmed);
    }

    // 7. 智能检测 Base64 (检查是否包含 Base64 编码的协议关键字)
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

    // 8. Fallback Base64 - 最后尝试解码
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

    // 8.1 分段 Base64：删除空白后再尝试一次
    const compactForBase64 = trimmed.replace(/\s+/g, '');
    if (compactForBase64 !== trimmed && this.looksLikeBase64(compactForBase64)) {
      const decoded = this.tryDecodeBase64(compactForBase64);
      if (decoded && /^\w+(:|\/\/|\s*?=\s*?)\w+/m.test(decoded)) {
        console.log('[SubscriptionPreprocessor] Detected segmented Base64 content');
        const singBoxResult = this.handleSingBox(decoded);
        if (singBoxResult) return singBoxResult;
        return this.preprocess(decoded);
      }
    }

    // 9. 返回原始内容
    console.log('[SubscriptionPreprocessor] No special format detected, returning raw content');
    return trimmed;
  }

  /**
   * 处理 SIP008 订阅（支持原始 JSON 与 Base64 包裹）
   */
  static handleSip008(content) {
    // 直接尝试 JSON
    const parsedDirect = this.parseSip008Json(content);
    if (parsedDirect) {
      console.log(`[SubscriptionPreprocessor] Detected SIP008 JSON with ${parsedDirect.serverCount} servers`);
      return parsedDirect.lines.join('\n');
    }

    // 尝试 Base64 包裹（去除空白方便识别分段 Base64）
    const compact = content.replace(/\s+/g, '');
    const base64Charset = /^[A-Za-z0-9+/=]+$/;
    if (base64Charset.test(compact) && compact.length >= 16) {
      const padded = this.padBase64(compact);
      const decoded = padded ? this.tryDecodeBase64(padded) : null;
      const parsedBase64 = decoded ? this.parseSip008Json(decoded) : null;
      if (parsedBase64) {
        console.log(`[SubscriptionPreprocessor] Detected SIP008 Base64 with ${parsedBase64.serverCount} servers`);
        return parsedBase64.lines.join('\n');
      }
    }

    return null;
  }

  /**
   * 处理 Base64 包裹的分享链接列表（SIP003 等）
   * - 典型场景：整个订阅内容是多行 ss:// / vmess:// / vless:// 等 URI 的 Base64
   * - 也可能包含其它协议：hy2://、anytls://、trojan:// 等
   * - 如果解码后看起来是一串 URI 列表，就直接返回解码结果，交由后续按行解析
   */
  static handleBase64UriList(content) {
    // 去掉空白，宽松判断是否为 Base64 封装
    const compact = content.replace(/\s+/g, '');
    if (compact.length < 16) {
      return null;
    }

    const padded = this.padBase64(compact);
    const decoded = padded ? this.tryDecodeBase64(padded) : null;
    if (!decoded) {
      return null;
    }

    const decodedTrimmed = decoded.trim();

    // 明显是 JSON / YAML 的情况交给其他处理器（Sing-box / Clash / SIP008 等）
    if (decodedTrimmed.startsWith('{') || decodedTrimmed.startsWith('[')) {
      return null;
    }
    if (decodedTrimmed.startsWith('proxies:') || decodedTrimmed.includes('proxies:')) {
      return null;
    }

    const lines = decoded.split('\n')
      .map(line => line.trim())
      .filter(Boolean);

    if (lines.length === 0) {
      return null;
    }

    // 判断是否主要是 URI 列表：存在至少一行 URI，并且大部分行形如 scheme://...
    const uriRegex = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//;
    const uriLines = lines.filter(line => uriRegex.test(line));

    if (uriLines.length === 0) {
      return null;
    }

    // 当 URI 行占比足够高时，认为是分享链接列表
    if (uriLines.length / lines.length < 0.6) {
      return null;
    }

    console.log(`[SubscriptionPreprocessor] Detected Base64 URI list with ${lines.length} lines`);
    return decoded;
  }

  /**
   * 处理「每行一个 Base64 串」的订阅
   * 典型场景：txt 等文件中，每一行是独立的 Base64（解码后是一条 URI），而不是整段合并的 Base64。
   * 例如：
   *   c3M6Ly9...
   *   dm1lc3M6Ly9...
   */
  static handlePerLineBase64UriList(content) {
    const lines = content.split('\n');
    const uriRegex = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//;

    const decodedLines = [];
    let decodedCount = 0;

    for (const originalLine of lines) {
      const line = originalLine.trim();
      if (!line || line.startsWith('#') || line.startsWith('//')) {
        continue;
      }

      // 已经是 URI 的行，直接保留
      if (uriRegex.test(line)) {
        decodedLines.push(line);
        continue;
      }

      // 尝试将该行视为 Base64 解码（宽松处理，兼容 URL-safe Base64）
      const compact = line.replace(/\s+/g, '');
      if (compact.length < 16) {
        continue;
      }

      const padded = this.padBase64(compact);
      const decoded = padded ? this.tryDecodeBase64(padded) : null;
      if (!decoded) {
        continue;
      }

      // 有些行解码后可能包含换行，但一般是单条 URI，取第一行
      const decodedFirstLine = decoded.split('\n')[0].trim();
      if (uriRegex.test(decodedFirstLine)) {
        decodedLines.push(decodedFirstLine);
        decodedCount += 1;
      }
    }

    if (decodedCount === 0 || decodedLines.length === 0) {
      return null;
    }

    console.log(
      `[SubscriptionPreprocessor] Detected per-line Base64 URI list, decoded ${decodedCount} lines`
    );
    return decodedLines.join('\n');
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
   * 解析 SIP008 JSON，返回 JSON 行格式
   */
  static parseSip008Json(content) {
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      return null;
    }

    const servers = parsed?.servers;
    if (!Array.isArray(servers) || servers.length === 0) {
      return null;
    }

    const lines = servers
      .map((server, index) => this.convertSip008Server(server, index))
      .filter(line => line !== null);

    if (lines.length === 0) {
      return null;
    }

    return {
      serverCount: servers.length,
      lines
    };
  }

  /**
   * 将单个 SIP008 server 转换为 Clash JSON 行
   */
  static convertSip008Server(server, index) {
    if (!server || typeof server !== 'object') {
      return null;
    }

    const host = server.server || server.address;
    const portRaw = server.server_port ?? server.serverPort ?? server.port;
    const cipher = server.method || server.cipher;
    const password = server.password;

    const port = parseInt(portRaw, 10);
    if (!host || !port || !cipher || !password) {
      return null;
    }

    const proxy = {
      name: server.remarks || server.name || server.tag || `SIP008-${index + 1}`,
      type: 'ss',
      server: host,
      port,
      cipher,
      password
    };

    if (typeof server.udp === 'boolean') {
      proxy.udp = server.udp;
    }

    const plugin = server.plugin || server.plugin_name;
    const pluginOptsRaw = server['plugin_opts'] ?? server.plugin_opts ?? server['plugin-opts'] ?? server.pluginOptions ?? server['plugin_options'];
    if (plugin) {
      proxy.plugin = plugin;
      const pluginOpts = this.parseSip008PluginOpts(pluginOptsRaw);
      if (pluginOpts !== null) {
        proxy['plugin-opts'] = pluginOpts;
      }
    }

    if (server['udp-over-tcp'] !== undefined) {
      proxy['udp-over-tcp'] = server['udp-over-tcp'];
    }
    if (server['fast-open'] !== undefined) {
      proxy['fast-open'] = server['fast-open'];
    }

    return JSON.stringify(proxy);
  }

  /**
   * 解析 SIP008 plugin_opts 字段
   */
  static parseSip008PluginOpts(raw) {
    if (raw === null || raw === undefined) {
      return null;
    }

    if (typeof raw === 'object') {
      return raw;
    }

    if (typeof raw !== 'string') {
      return null;
    }

    const segments = raw.split(';')
      .map(part => part.trim())
      .filter(Boolean);

    if (segments.length === 0) {
      return raw || null;
    }

    const opts = {};
    for (const segment of segments) {
      if (segment.includes('=')) {
        const [key, ...rest] = segment.split('=');
        const value = rest.join('=').trim();
        opts[key.trim()] = value || true;
      } else {
        opts[segment] = true;
      }
    }

    return Object.keys(opts).length > 0 ? opts : raw;
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
   * 填充 Base64 字符串至合法长度
   */
  static padBase64(str) {
    const compact = str.replace(/\s+/g, '');
    const remainder = compact.length % 4;
    if (remainder === 0) {
      return compact;
    }
    // 其余情况统一使用补齐方式，尽量容忍缺失的填充位
    return compact.padEnd(compact.length + (4 - remainder), '=');
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
      if (!raw) return null;
      // 先按标准 Base64 解码
      return Buffer.from(raw, 'base64').toString('utf-8');
    } catch {
      try {
        // 兼容 URL-safe Base64：-_/ 无填充
        const normalized = raw.replace(/-/g, '+').replace(/_/g, '/');
        const padded = this.padBase64(normalized);
        return Buffer.from(padded, 'base64').toString('utf-8');
      } catch {
        return null;
      }
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

