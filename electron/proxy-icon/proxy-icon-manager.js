const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const https = require('https');
const http = require('http');

class ProxyIconManager {
  constructor() {
    this.configPath = path.join(app.getPath('userData'), 'proxy-icon-config.json');
    this.cacheDir = path.join(app.getPath('userData'), 'icon-cache');
    this.config = this.loadConfig();
    this.ensureCacheDir();
  }

  /**
   * 确保缓存目录存在
   */
  ensureCacheDir() {
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  /**
   * 加载配置
   */
  loadConfig() {
    try {
      if (fs.existsSync(this.configPath)) {
        const data = fs.readFileSync(this.configPath, 'utf8');
        return JSON.parse(data);
      }
    } catch (error) {
      console.error('[ProxyIconManager] 加载配置失败:', error);
    }

    // 返回默认配置
    return {
      enabled: true,
      rules: []
    };
  }

  /**
   * 保存配置
   */
  saveConfig(config) {
    try {
      fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2), 'utf8');
      this.config = config;
      return { success: true };
    } catch (error) {
      console.error('[ProxyIconManager] 保存配置失败:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 获取配置
   */
  getConfig() {
    return this.config;
  }

  /**
   * 获取代理组图标
   * @param {string} groupName - 代理组名称
   * @param {string} configIcon - 配置文件中的icon字段（优先使用）
   */
  getProxyGroupIcon(groupName, configIcon = null) {
    // 优先使用配置文件中的icon字段
    if (configIcon) {
      const iconPath = this.getIconFromUrl(configIcon, `config_${groupName}_${this.hashCode(configIcon)}`);
      if (iconPath) {
        console.log(`[ProxyIconManager] 使用配置图标: ${groupName} -> ${iconPath.substring(0, 100)}`);
        return iconPath;
      }
    }

    if (!this.config.enabled) {
      console.log(`[ProxyIconManager] 图标功能未启用`);
      return null;
    }

    // 按优先级排序查找匹配的规则
    const sortedRules = this.config.rules
      .filter(rule => rule.enabled)
      .sort((a, b) => b.priority - a.priority);

    for (const rule of sortedRules) {
      if (this.matchesRule(groupName, rule)) {
        const iconPath = this.getIconFromRule(rule);
        console.log(`[ProxyIconManager] 匹配规则: ${groupName} -> ${rule.name} -> ${iconPath ? iconPath.substring(0, 100) : 'null'}`);
        return iconPath;
      }
    }

    console.log(`[ProxyIconManager] 未找到匹配规则: ${groupName}`);
    return null;
  }

  /**
   * 检查代理组名称是否匹配规则
   */
  matchesRule(groupName, rule) {
    try {
      const regex = new RegExp(rule.regex);
      return regex.test(groupName);
    } catch (error) {
      console.error('[ProxyIconManager] 正则表达式错误:', rule.regex, error);
      return false;
    }
  }

  /**
   * 从规则获取图标
   */
  getIconFromRule(rule) {
    const cacheKey = `${rule.id}_${this.hashCode(rule.iconData)}`;

    if (rule.iconType === 'BASE64') {
      // Base64图标直接返回data URL
      // 检查是否已经包含data URL前缀
      if (rule.iconData.startsWith('data:')) {
        return rule.iconData;
      }
      return `data:image/png;base64,${rule.iconData}`;
    } else if (rule.iconType === 'URL') {
      return this.getIconFromUrl(rule.iconData, cacheKey);
    }

    return null;
  }

  /**
   * 从URL获取图标
   */
  getIconFromUrl(url, cacheKey) {
    // 检测文件扩展名
    const isSvg = url.toLowerCase().endsWith('.svg');
    const ext = isSvg ? '.svg' : '.png';
    const cacheFile = path.join(this.cacheDir, `${cacheKey}${ext}`);

    // 如果缓存文件存在，读取并转换为Base64
    if (fs.existsSync(cacheFile)) {
      try {
        if (isSvg) {
          // SVG文件直接读取为文本
          const svgContent = fs.readFileSync(cacheFile, 'utf-8');
          const base64 = Buffer.from(svgContent).toString('base64');
          return `data:image/svg+xml;base64,${base64}`;
        } else {
          // PNG/JPG等二进制图片
          const imageBuffer = fs.readFileSync(cacheFile);
          const base64 = imageBuffer.toString('base64');
          return `data:image/png;base64,${base64}`;
        }
      } catch (error) {
        console.error('[ProxyIconManager] 读取缓存文件失败:', cacheFile, error);
        return null;
      }
    }

    // 异步下载图标
    this.downloadIcon(url, cacheFile).catch(error => {
      console.error('[ProxyIconManager] 下载图标失败:', url, error);
    });

    return null;
  }

  /**
   * 下载图标
   */
  async downloadIcon(url, filePath) {
    return new Promise((resolve, reject) => {
      const protocol = url.startsWith('https') ? https : http;

      protocol.get(url, (response) => {
        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode}`));
          return;
        }

        const fileStream = fs.createWriteStream(filePath);
        response.pipe(fileStream);

        fileStream.on('finish', () => {
          fileStream.close();
          resolve();
        });

        fileStream.on('error', (error) => {
          fs.unlink(filePath, () => {});
          reject(error);
        });
      }).on('error', reject);
    });
  }

  /**
   * 获取图标缓存目录
   */
  getIconCacheDir() {
    return this.cacheDir;
  }

  /**
   * 获取所有缓存的图标文件
   */
  getCachedIcons() {
    try {
      const files = fs.readdirSync(this.cacheDir);
      return files.filter(file => file.endsWith('.png'));
    } catch (error) {
      console.error('[ProxyIconManager] 读取缓存目录失败:', error);
      return [];
    }
  }

  /**
   * 清除图标缓存
   */
  clearCache() {
    try {
      const files = this.getCachedIcons();
      for (const file of files) {
        fs.unlinkSync(path.join(this.cacheDir, file));
      }
      return { success: true };
    } catch (error) {
      console.error('[ProxyIconManager] 清除缓存失败:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 简单的字符串哈希函数
   */
  hashCode(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash).toString(36);
  }

  /**
   * 添加规则
   */
  addRule(rule) {
    const newRule = {
      id: Date.now().toString(),
      name: rule.name,
      regex: rule.regex,
      iconType: rule.iconType, // 'BASE64' or 'URL'
      iconData: rule.iconData,
      enabled: rule.enabled !== undefined ? rule.enabled : true,
      priority: rule.priority !== undefined ? rule.priority : 0
    };

    this.config.rules.push(newRule);
    return this.saveConfig(this.config);
  }

  /**
   * 更新规则
   */
  updateRule(ruleId, updates) {
    const index = this.config.rules.findIndex(r => r.id === ruleId);
    if (index === -1) {
      return { success: false, error: '规则不存在' };
    }

    this.config.rules[index] = {
      ...this.config.rules[index],
      ...updates
    };

    return this.saveConfig(this.config);
  }

  /**
   * 删除规则
   */
  deleteRule(ruleId) {
    this.config.rules = this.config.rules.filter(r => r.id !== ruleId);
    return this.saveConfig(this.config);
  }

  /**
   * 切换规则启用状态
   */
  toggleRule(ruleId, enabled) {
    return this.updateRule(ruleId, { enabled });
  }
}

// 单例模式
let instance = null;

function getInstance() {
  if (!instance) {
    instance = new ProxyIconManager();
  }
  return instance;
}

module.exports = {
  getInstance
};

