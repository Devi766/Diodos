const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { URL } = require('url');

/**
 * 配置图标管理器
 * 负责下载、缓存和管理配置文件的自定义图标
 */
class ConfigIconManager {
  constructor(app) {
    this.app = app;
    this.cacheDir = path.join(app.getPath('userData'), 'config-icons');
    this.iconCache = new Map(); // 内存缓存
    
    // 确保缓存目录存在
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  /**
   * 获取配置图标
   * @param {string} iconUrl - 图标URL
   * @param {string} configPath - 配置文件路径(用于生成缓存key)
   * @returns {string|null} - 图标路径或data URL
   */
  async getConfigIcon(iconUrl, configPath) {
    if (!iconUrl) return null;

    const cacheKey = this.getCacheKey(iconUrl, configPath);

    // 先从内存缓存获取
    if (this.iconCache.has(cacheKey)) {
      return this.iconCache.get(cacheKey);
    }

    // 尝试从本地缓存加载
    const cachedPath = path.join(this.cacheDir, cacheKey);
    if (fs.existsSync(cachedPath)) {
      try {
        const iconData = fs.readFileSync(cachedPath);
        const ext = path.extname(cachedPath).toLowerCase();
        const mimeType = this.getMimeType(ext);
        const dataUrl = `data:${mimeType};base64,${iconData.toString('base64')}`;
        
        // 缓存到内存
        this.iconCache.set(cacheKey, dataUrl);
        return dataUrl;
      } catch (error) {
        console.error('[ConfigIconManager] 读取缓存图标失败:', error);
      }
    }

    // 下载图标
    try {
      const iconData = await this.downloadIcon(iconUrl);
      if (iconData) {
        // 保存到本地缓存
        fs.writeFileSync(cachedPath, iconData);
        
        // 生成data URL
        const ext = this.getExtensionFromUrl(iconUrl);
        const mimeType = this.getMimeType(ext);
        const dataUrl = `data:${mimeType};base64,${iconData.toString('base64')}`;
        
        // 缓存到内存
        this.iconCache.set(cacheKey, dataUrl);
        return dataUrl;
      }
    } catch (error) {
      console.error('[ConfigIconManager] 下载图标失败:', error);
    }

    return null;
  }

  /**
   * 下载图标
   * @param {string} iconUrl - 图标URL
   * @returns {Promise<Buffer|null>}
   */
  async downloadIcon(iconUrl) {
    return new Promise((resolve, reject) => {
      try {
        // 判断是网站URL还是直接图片链接
        const isImageUrl = this.isImageUrl(iconUrl);
        const targetUrl = isImageUrl ? iconUrl : this.getFaviconUrl(iconUrl);

        const parsedUrl = new URL(targetUrl);
        const protocol = parsedUrl.protocol === 'https:' ? https : http;

        const options = {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          },
          timeout: 10000
        };

        protocol.get(targetUrl, options, (res) => {
          if (res.statusCode === 301 || res.statusCode === 302) {
            // 处理重定向
            const redirectUrl = res.headers.location;
            if (redirectUrl) {
              this.downloadIcon(redirectUrl).then(resolve).catch(reject);
              return;
            }
          }

          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }

          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            const buffer = Buffer.concat(chunks);
            resolve(buffer);
          });
        }).on('error', reject).on('timeout', () => {
          reject(new Error('Download timeout'));
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * 判断URL是否为图片链接
   * @param {string} url
   * @returns {boolean}
   */
  isImageUrl(url) {
    const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico'];
    const lowerUrl = url.toLowerCase();
    return imageExtensions.some(ext => lowerUrl.includes(ext));
  }

  /**
   * 从网站URL获取favicon URL
   * @param {string} websiteUrl
   * @returns {string}
   */
  getFaviconUrl(websiteUrl) {
    try {
      const parsedUrl = new URL(websiteUrl);
      return `${parsedUrl.protocol}//${parsedUrl.host}/favicon.ico`;
    } catch (error) {
      console.error('[ConfigIconManager] 解析网站URL失败:', error);
      return websiteUrl;
    }
  }

  /**
   * 从URL获取文件扩展名
   * @param {string} url
   * @returns {string}
   */
  getExtensionFromUrl(url) {
    try {
      const parsedUrl = new URL(url);
      const pathname = parsedUrl.pathname;
      const ext = path.extname(pathname);
      return ext || '.png';
    } catch (error) {
      return '.png';
    }
  }

  /**
   * 获取MIME类型
   * @param {string} ext - 文件扩展名
   * @returns {string}
   */
  getMimeType(ext) {
    const mimeTypes = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon'
    };
    return mimeTypes[ext.toLowerCase()] || 'image/png';
  }

  /**
   * 生成缓存key
   * @param {string} iconUrl
   * @param {string} configPath
   * @returns {string}
   */
  getCacheKey(iconUrl, configPath) {
    const hash = this.hashCode(iconUrl + configPath);
    const ext = this.getExtensionFromUrl(iconUrl);
    return `config_${hash}${ext}`;
  }

  /**
   * 简单的哈希函数
   * @param {string} str
   * @returns {string}
   */
  hashCode(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(36);
  }

  /**
   * 清除缓存
   */
  clearCache() {
    try {
      // 清除内存缓存
      this.iconCache.clear();
      
      // 清除磁盘缓存
      if (fs.existsSync(this.cacheDir)) {
        const files = fs.readdirSync(this.cacheDir);
        for (const file of files) {
          fs.unlinkSync(path.join(this.cacheDir, file));
        }
      }
      
      console.log('[ConfigIconManager] 缓存已清除');
      return true;
    } catch (error) {
      console.error('[ConfigIconManager] 清除缓存失败:', error);
      return false;
    }
  }

  /**
   * 获取缓存大小
   * @returns {number} - 字节数
   */
  getCacheSize() {
    try {
      if (!fs.existsSync(this.cacheDir)) {
        return 0;
      }

      let totalSize = 0;
      const files = fs.readdirSync(this.cacheDir);
      for (const file of files) {
        const filePath = path.join(this.cacheDir, file);
        const stats = fs.statSync(filePath);
        totalSize += stats.size;
      }
      
      return totalSize;
    } catch (error) {
      console.error('[ConfigIconManager] 获取缓存大小失败:', error);
      return 0;
    }
  }
}

// 导出单例
let instance = null;

module.exports = {
  getInstance: (app) => {
    if (!instance) {
      instance = new ConfigIconManager(app);
    }
    return instance;
  }
};

