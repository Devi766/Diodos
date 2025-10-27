/**
 * 配置模板数据模型
 * 对应安卓端的 ConfigTemplate.kt
 */

/**
 * 模板分类
 */
const TemplateCategory = {
  BASIC: 'basic',
  STREAMING: 'streaming',
  GAMING: 'gaming',
  PRIVACY: 'privacy',
  SPEED: 'speed',
  BALANCED: 'balanced',
  CUSTOM: 'custom'
};

/**
 * 代理组
 */
class ProxyGroup {
  constructor(params) {
    this.name = params.name;
    this.type = params.type; // select, url-test, fallback, load-balance
    this.proxies = params.proxies || [];
    this.url = params.url || null;
    this.interval = params.interval || null;
    this.tolerance = params.tolerance || null;
    this.icon = params.icon || null;
    this.filter = params.filter || null;
  }
}

/**
 * DNS配置
 */
class DnsConfig {
  constructor(params) {
    this.enable = params.enable !== undefined ? params.enable : true;
    this.ipv6 = params.ipv6 !== undefined ? params.ipv6 : false;
    this.nameserver = params.nameserver || ['223.5.5.5', '119.29.29.29'];
    this.fallback = params.fallback || ['8.8.8.8', '1.1.1.1'];
    this.fallbackFilter = params.fallbackFilter || null;
  }
}

/**
 * 高级配置
 */
class AdvancedConfig {
  constructor(params) {
    this.port = params.port || 7890;
    this.socksPort = params.socksPort || 7891;
    this.allowLan = params.allowLan !== undefined ? params.allowLan : false;
    this.mode = params.mode || 'rule';
    this.logLevel = params.logLevel || 'info';
    this.ipv6 = params.ipv6 !== undefined ? params.ipv6 : false;
  }
}

/**
 * 配置模板
 */
class ConfigTemplate {
  constructor(params) {
    this.id = params.id;
    this.name = params.name;
    this.description = params.description;
    this.category = params.category;
    this.proxyGroups = params.proxyGroups || [];
    this.rules = params.rules || [];
    this.dnsConfig = params.dnsConfig || null;
    this.advancedConfig = params.advancedConfig || null;
  }
}

module.exports = {
  TemplateCategory,
  ProxyGroup,
  DnsConfig,
  AdvancedConfig,
  ConfigTemplate
};

