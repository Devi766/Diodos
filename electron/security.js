/**
 * 安全工具模块 - 提供输入验证和安全检查功能
 */
const path = require('path');
const fs = require('fs');
const url = require('url');

/**
 * 验证URL是否合法安全
 * @param {string} urlString - 要验证的URL字符串
 * @returns {object} - 验证结果对象 {valid: boolean, error?: string, url?: string}
 */
function validateUrl(urlString) {
  console.log('开始验证URL:', urlString);
  
  // 检查是否为空
  if (!urlString) {
    console.log('URL为空');
    return { valid: false, error: 'URL不能为空' };
  }
  
  // 规范化URL - 确保去除前后空格
  const trimmedUrl = urlString.trim();
  console.log('处理后的URL:', trimmedUrl);

  // 新增：检查是否为本地文件导入
  if (trimmedUrl.startsWith('local:')) {
    console.log('本地文件导入标识符，跳过标准URL验证:', trimmedUrl);
    // 对于本地文件，我们认为它是有效的，直接返回
    // 后续的文件路径有效性应该由其他专门的函数处理（如果需要）
    return { valid: true, url: trimmedUrl };
  }
  
  try {
    // 使用URL构造函数直接验证URL的有效性
    const parsedUrl = new URL(trimmedUrl);
    console.log('URL解析结果:', parsedUrl);
    
    // 检查协议是否为http或https
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      console.log('无效协议:', parsedUrl.protocol);
      return { valid: false, error: 'URL必须使用HTTP或HTTPS协议' };
    }
    
    // 检查危险字符 - 仅检查路径和查询部分
    const dangerousChars = /[|;`$(){}<>]/g;
    const pathToCheck = parsedUrl.pathname + parsedUrl.search;
    if (dangerousChars.test(pathToCheck)) {
      console.log('URL包含危险字符');
      return { valid: false, error: 'URL包含危险字符' };
    }
    
    console.log('URL验证通过:', parsedUrl.href);
    return { valid: true, url: parsedUrl.href };
  } catch (e) {
    console.error('URL解析失败:', e.message);
    
    // 尝试添加协议前缀并重新验证
    if (!trimmedUrl.match(/^https?:\/\//i)) {
      try {
        console.log('尝试添加https://前缀');
        const urlWithProtocol = 'https://' + trimmedUrl;
        const parsedWithProtocol = new URL(urlWithProtocol);
        
        console.log('添加协议后验证成功:', parsedWithProtocol.href);
        return { valid: true, url: parsedWithProtocol.href };
      } catch (e2) {
        console.error('添加协议后仍验证失败:', e2.message);
      }
    }
    
    return { valid: false, error: '无效的URL格式' };
  }
}

/**
 * 验证文件路径是否合法安全
 * @param {string} filePath - 要验证的文件路径
 * @returns {object} - 验证结果对象 {valid: boolean, error?: string, path?: string}
 */
function validateFilePath(filePath) {
  // 检查是否为空
  if (!filePath) {
    return { valid: false, error: '文件路径不能为空' };
  }
  
  // 规范化路径
  const normalized = path.normalize(filePath);
  
  // 检查路径遍历攻击
  if (normalized.includes('..')) {
    return { valid: false, error: '文件路径不能包含路径遍历序列(..)' };
  }
  
  // 检查危险字符
  const dangerousChars = /[&|;`$(){}]/g;
  if (dangerousChars.test(normalized)) {
    return { valid: false, error: '文件路径包含危险字符' };
  }
  
  return { valid: true, path: normalized };
}

/**
 * 验证代理配置是否合法
 * @param {object} config - 代理配置对象
 * @returns {object} - 验证结果对象 {valid: boolean, error?: string, config?: object}
 */
function validateProxyConfig(config) {
  // 检查是否为空
  if (!config) {
    return { valid: false, error: '配置对象不能为空' };
  }
  
  // 验证端口号
  if (config['mixed-port'] !== undefined) {
    const port = parseInt(config['mixed-port'], 10);
    if (isNaN(port) || port < 1024 || port > 65535) {
      return { valid: false, error: '无效的端口号，必须在1024-65535之间' };
    }
  }
  
  // 验证TUN设置
  if (config.tun && config.tun.enable === true) {
    // 检查TUN设备名称是否安全
    if (config.tun.device && !/^[a-zA-Z0-9_-]+$/.test(config.tun.device)) {
      return { valid: false, error: 'TUN设备名称包含无效字符' };
    }
  }
  
  // 检查DNS设置 - 只记录警告，不拒绝任何配置
  if (config.dns && config.dns.nameserver && Array.isArray(config.dns.nameserver)) {
    // 常见的有效格式
    const commonDnsRegex = /^(dhcp|system|local|(\d{1,3}\.){3}\d{1,3}(:\d+)?|(https?|tls|tcp|udp):\/\/.+)$/i;
    
    for (const ns of config.dns.nameserver) {
      if (ns && typeof ns === 'string' && !commonDnsRegex.test(ns)) {
        console.warn(`注意: 发现不常见的DNS服务器地址格式: ${ns}`);
      }
    }
    
    // DNS检查只记录警告，不返回错误，都允许通过
  }
  
  // 所有检查通过或仅有警告
  return { valid: true, config };
}

/**
 * 安全的User-Agent白名单
 */
const ALLOWED_USERAGENTS = {
  'Clash': 'Clash/2.0.0',
  'Mihomo': 'Mihomo/1.14.0',
  'MihomoParty': 'clash.meta',
  'Chrome': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
  'FlyClash': 'FlyClash/1.0.0' // 将在使用时动态替换为实际版本
};

/**
 * 获取安全的User-Agent
 * @param {string} uaKey - User-Agent键名
 * @param {string} appVersion - 应用版本号
 * @returns {string} - 安全的User-Agent字符串
 */
function getSafeUserAgent(uaKey, appVersion) {
  // 如果是FlyClash，动态设置版本号
  if (uaKey === 'FlyClash' && appVersion) {
    return `FlyClash/${appVersion}`;
  }
  
  // 从白名单中获取，如果不存在则使用默认值
  return ALLOWED_USERAGENTS[uaKey] || ALLOWED_USERAGENTS['MihomoParty'];
}

/**
 * 记录安全事件
 * @param {string} event - 事件名称
 * @param {object} details - 事件详情
 * @param {string} logPath - 日志文件路径
 */
function logSecurityEvent(event, details, logPath) {
  const timestamp = new Date().toISOString();
  const logEntry = {
    timestamp,
    event,
    details
  };
  
  console.log(`[安全事件] ${JSON.stringify(logEntry)}`);
  
  // 如果提供了日志路径，则写入文件
  if (logPath) {
    try {
      fs.appendFileSync(logPath, JSON.stringify(logEntry) + '\n');
    } catch (e) {
      console.error('无法写入安全日志', e);
    }
  }
}

module.exports = {
  validateUrl,
  validateFilePath,
  validateProxyConfig,
  getSafeUserAgent,
  ALLOWED_USERAGENTS,
  logSecurityEvent
}; 