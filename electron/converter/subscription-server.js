/**
 * 本地订阅服务器
 * 对应安卓端的 SubscriptionServer.kt
 * 提供订阅链接供客户端下载配置
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { SubscriptionConverter, ConversionOptions } = require('./subscription-converter');
const { OutputFormat } = require('./proxy-models');
const { fetchWithOptions, DEFAULT_UA, DEFAULT_TIMEOUT } = require('./request-helper');

/**
 * 订阅配置数据类
 */
class SubscriptionConfig {
  constructor(params) {
    this.id = params.id;
    this.name = params.name;
    this.sourceUrl = params.sourceUrl || null;
    this.sourceContent = params.sourceContent || null;
    this.targetFormat = params.targetFormat;
    this.filterRegex = params.filterRegex || null;
    this.templateId = params.templateId || null;
    this.options = params.options || new ConversionOptions();
    this.updateInterval = params.updateInterval || 0;
    this.lastUpdate = params.lastUpdate || Date.now();
    this.cachedContent = params.cachedContent || null;
  }
}

/**
 * 订阅服务器
 */
class SubscriptionServer {
  constructor(port = 8080, configDir = null, requestSettings = {}) {
    this.port = port;
    this.configDir = configDir || path.join(process.cwd(), 'subscriptions');
    this.subscriptions = new Map();
    this.server = null;
    this.converter = new SubscriptionConverter();
    this.requestSettings = {
      userAgent: requestSettings.userAgent || DEFAULT_UA,
      proxy: '',
      insecure: false,
      timeout: DEFAULT_TIMEOUT,
      noCache: false
    };

    // 确保配置目录存在
    if (!fs.existsSync(this.configDir)) {
      fs.mkdirSync(this.configDir, { recursive: true });
    }

    this.loadSubscriptions();
  }

  /**
   * 启动服务器
   */
  start() {
    return new Promise((resolve, reject) => {
      if (this.server && this.server.listening) {
        console.log(`[SubscriptionServer] Server already running on port ${this.port}`);
        resolve();
        return;
      }

      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });

      this.server.on('error', (error) => {
        if (error.code === 'EADDRINUSE') {
          console.error(`[SubscriptionServer] Port ${this.port} is already in use`);
          reject(new Error(`Port ${this.port} is already in use`));
        } else {
          console.error('[SubscriptionServer] Server error:', error);
          reject(error);
        }
      });

      this.server.listen(this.port, '0.0.0.0', () => {
        const ip = this.getLocalIp();
        console.log(`[SubscriptionServer] Server started on http://${ip}:${this.port}`);
        resolve();
      });
    });
  }

  /**
   * 停止服务器
   */
  stop() {
    return new Promise((resolve) => {
      if (!this.server || !this.server.listening) {
        resolve();
        return;
      }

      this.server.close(() => {
        console.log('[SubscriptionServer] Server stopped');
        this.server = null;
        resolve();
      });
    });
  }

  /**
   * 处理 HTTP 请求
   */
  handleRequest(req, res) {
    const url = new URL(req.url, `http://127.0.0.1:${this.port}`);
    const pathname = url.pathname;

    console.log(`[SubscriptionServer] Request: ${pathname}`);

    // 路由: /sub/{id}
    if (pathname.startsWith('/sub/')) {
      const id = pathname.substring(5);
      this.handleSubscriptionRequest(id, res);
      return;
    }

    // 路由: /list
    if (pathname === '/list') {
      this.handleListRequest(res);
      return;
    }

    // 404
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }

  /**
   * 处理订阅请求
   */
  async handleSubscriptionRequest(id, res) {
    const subscription = this.subscriptions.get(id);

    if (!subscription) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Subscription not found');
      return;
    }

    try {
      // 获取订阅内容
      let content;
      let upstreamHeaders = null;
      if (subscription.sourceUrl) {
        // 从 URL 获取
        const result = await this.fetchFromUrl(subscription.sourceUrl);
        content = result.content;
        upstreamHeaders = result.headers || null;
      } else if (subscription.sourceContent) {
        // 使用本地内容
        content = subscription.sourceContent;
      } else {
        throw new Error('No source available');
      }

      // 转换内容
      const result = this.converter.convert(
        content,
        subscription.targetFormat,
        subscription.filterRegex,
        subscription.options,
        subscription.templateId
      );

      if (!result.success) {
        throw new Error(result.errorMessage || 'Conversion failed');
      }

      // 缓存结果
      subscription.cachedContent = result.output;
      subscription.lastUpdate = Date.now();
      this.saveSubscription(subscription);

      // 返回结果
      const contentType = this.getContentType(subscription.targetFormat);
      const headers = {
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${subscription.name}.${this.getFileExtension(subscription.targetFormat)}"`,
        'Cache-Control': 'no-cache'
      };

      // 添加订阅信息头
      const userinfo = upstreamHeaders?.['subscription-userinfo'] || upstreamHeaders?.['Subscription-Userinfo'] || this.generateSubscriptionUserinfo(result);
      if (userinfo) {
        headers['subscription-userinfo'] = userinfo;
      }

      // 添加更新间隔头
      // 透传/回填更新间隔
      const upstreamPui = upstreamHeaders?.['profile-update-interval'] || upstreamHeaders?.['Profile-Update-Interval'];
      const updateInterval = upstreamPui || (subscription.updateInterval > 0 ? subscription.updateInterval.toString() : null);
      if (updateInterval) {
        headers['profile-update-interval'] = updateInterval;
      }

      res.writeHead(200, headers);
      res.end(result.output);

      console.log(`[SubscriptionServer] Served subscription: ${id}, ${result.outputProxyCount} proxies`);
    } catch (error) {
      console.error(`[SubscriptionServer] Error serving subscription ${id}:`, error);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`Error: ${error.message}`);
    }
  }

  /**
   * 处理列表请求
   */
  handleListRequest(res) {
    const ip = this.getLocalIp();
    const list = Array.from(this.subscriptions.values()).map(sub => ({
      id: sub.id,
      name: sub.name,
      targetFormat: sub.targetFormat,
      lastUpdate: sub.lastUpdate,
      url: `http://${ip}:${this.port}/sub/${sub.id}`
    }));

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(list, null, 2));
  }

  /**
   * 从 URL 获取内容
   */
  async fetchFromUrl(url) {
    const { data, headers } = await fetchWithOptions(url, this.requestSettings);
    const content = typeof data === 'string'
      ? data
      : Buffer.isBuffer(data)
        ? data.toString('utf-8')
        : JSON.stringify(data);
    return { content, headers };
  }

  /**
   * 创建订阅
   */
  createSubscription(params) {
    const id = params.id || this.generateId();
    
    const subscription = new SubscriptionConfig({
      id,
      name: params.name,
      sourceUrl: params.sourceUrl,
      sourceContent: params.sourceContent,
      targetFormat: params.targetFormat,
      filterRegex: params.filterRegex,
      templateId: params.templateId,
      options: params.options || new ConversionOptions()
    });

    this.subscriptions.set(id, subscription);
    this.saveSubscription(subscription);

    console.log(`[SubscriptionServer] Created subscription: ${id}`);
    return id;
  }

  /**
   * 删除订阅
   */
  deleteSubscription(id) {
    const subscription = this.subscriptions.get(id);
    if (!subscription) {
      return false;
    }

    this.subscriptions.delete(id);
    
    // 删除配置文件
    const configFile = path.join(this.configDir, `${id}.json`);
    if (fs.existsSync(configFile)) {
      fs.unlinkSync(configFile);
    }

    console.log(`[SubscriptionServer] Deleted subscription: ${id}`);
    return true;
  }

  /**
   * 获取本地IP地址
   */
  getLocalIp() {
    const os = require('os');
    const interfaces = os.networkInterfaces();

    // 虚拟网卡名称列表(需要过滤)
    const virtualInterfaces = [
      'utun',           // macOS VPN
      'tun',            // VPN/虚拟网卡
      'tap',            // VPN/虚拟网卡
      'ppp',            // PPP连接
      'vEthernet',      // Hyper-V虚拟网卡
      'VMware',         // VMware虚拟网卡
      'VirtualBox',     // VirtualBox虚拟网卡
      'docker',         // Docker网卡
      'vboxnet',        // VirtualBox网卡
      'virbr',          // KVM/libvirt网卡
      'br-',            // Docker bridge
      'Meta',           // Clash Meta虚拟网卡
      'Clash'           // Clash虚拟网卡
    ];

    // 优先级列表(优先选择这些网卡)
    const preferredInterfaces = [
      'en0',            // macOS以太网/Wi-Fi
      'eth0',           // Linux以太网
      'wlan0',          // Linux Wi-Fi
      'Wi-Fi',          // Windows Wi-Fi
      'Ethernet',       // Windows以太网
      '以太网',         // Windows中文以太网
      'WLAN'            // Windows WLAN
    ];

    const validIps = [];

    for (const name of Object.keys(interfaces)) {
      // 跳过虚拟网卡
      if (virtualInterfaces.some(v => name.toLowerCase().includes(v.toLowerCase()))) {
        continue;
      }

      for (const iface of interfaces[name]) {
        // 跳过内部地址、非IPv4地址和169.254开头的地址(APIPA)
        if (iface.family === 'IPv4' && !iface.internal && !iface.address.startsWith('169.254')) {
          validIps.push({ name, address: iface.address });
        }
      }
    }

    // 如果没有找到有效IP,返回127.0.0.1
    if (validIps.length === 0) {
      return '127.0.0.1';
    }

    // 优先选择首选网卡
    for (const preferred of preferredInterfaces) {
      const found = validIps.find(ip => ip.name === preferred);
      if (found) {
        return found.address;
      }
    }

    // 返回第一个有效IP
    return validIps[0].address;
  }

  /**
   * 获取订阅 URL
   */
  getSubscriptionUrl(id) {
    const ip = this.getLocalIp();
    return `http://${ip}:${this.port}/sub/${id}`;
  }

  /**
   * 保存订阅配置
   */
  saveSubscription(subscription) {
    const configFile = path.join(this.configDir, `${subscription.id}.json`);
    fs.writeFileSync(configFile, JSON.stringify(subscription, null, 2));
  }

  /**
   * 加载所有订阅配置
   */
  loadSubscriptions() {
    if (!fs.existsSync(this.configDir)) {
      return;
    }

    const files = fs.readdirSync(this.configDir);
    
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      
      try {
        const configFile = path.join(this.configDir, file);
        const data = fs.readFileSync(configFile, 'utf-8');
        const config = JSON.parse(data);
        const subscription = new SubscriptionConfig(config);
        this.subscriptions.set(subscription.id, subscription);
      } catch (error) {
        console.error(`[SubscriptionServer] Failed to load ${file}:`, error);
      }
    }

    console.log(`[SubscriptionServer] Loaded ${this.subscriptions.size} subscriptions`);
  }

  /**
   * 生成唯一 ID
   */
  generateId() {
    return `sub_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  /**
   * 生成订阅信息头
   * 格式: upload=0; download=0; total=10737418240; expire=1671815872
   */
  generateSubscriptionUserinfo(result) {
    if (!result || !result.outputProxyCount) {
      return null;
    }

    const parts = [];

    // 上传流量 (0 表示无限制)
    parts.push('upload=0');

    // 下载流量 (0 表示无限制)
    parts.push('download=0');

    // 总流量 (10GB 示例)
    parts.push('total=10737418240');

    // 过期时间 (1年后)
    const expireTime = Math.floor(Date.now() / 1000) + (365 * 24 * 60 * 60);
    parts.push(`expire=${expireTime}`);

    return parts.join('; ');
  }

  /**
   * 获取内容类型
   */
  getContentType(format) {
    switch (format) {
      case OutputFormat.CLASH:
      case OutputFormat.CLASH_META:
        return 'text/yaml; charset=utf-8';
      case OutputFormat.SING_BOX:
        return 'application/json; charset=utf-8';
      default:
        return 'text/plain; charset=utf-8';
    }
  }

  /**
   * 获取文件扩展名
   */
  getFileExtension(format) {
    switch (format) {
      case OutputFormat.CLASH:
      case OutputFormat.CLASH_META:
        return 'yaml';
      case OutputFormat.SING_BOX:
        return 'json';
      default:
        return 'txt';
    }
  }
}

module.exports = {
  SubscriptionServer,
  SubscriptionConfig
};

