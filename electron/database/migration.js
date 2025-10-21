const fs = require('fs');
const path = require('path');

/**
 * 数据迁移管理器
 * 负责将JSON数据迁移到SQLite数据库
 */
class MigrationManager {
  constructor(configDir, dbManager) {
    this.configDir = configDir;
    this.dbManager = dbManager;
    this.migrationFlagPath = path.join(configDir, '.db_migrated');
  }

  /**
   * 检查是否已经迁移
   */
  isMigrated() {
    return fs.existsSync(this.migrationFlagPath);
  }

  /**
   * 标记为已迁移
   */
  markAsMigrated() {
    fs.writeFileSync(this.migrationFlagPath, new Date().toISOString(), 'utf8');
  }

  /**
   * 执行完整迁移
   */
  async migrate() {
    try {
      console.log('[迁移] 开始数据迁移...');

      // 备份JSON文件
      this.backupJsonFiles();

      // 迁移订阅数据
      await this.migrateSubscriptions();

      // 迁移设置数据
      await this.migrateSettings();

      // 迁移应用配置
      await this.migrateAppConfig();

      // 标记为已迁移
      this.markAsMigrated();

      console.log('[迁移] 数据迁移完成');
      return { success: true };
    } catch (error) {
      console.error('[迁移] 数据迁移失败:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 备份JSON文件
   */
  backupJsonFiles() {
    const backupDir = path.join(this.configDir, 'json_backup');
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }

    const filesToBackup = [
      'subscription_urls.json',
      'subscription_info.json',
      'user-settings.json'
    ];

    // 备份应用数据目录下的配置文件
    const userDataPath = path.dirname(this.configDir);
    const appConfigFiles = [
      'theme-config.json',
      'proxy-config.json',
      'tun-config.json'
    ];

    for (const file of filesToBackup) {
      const sourcePath = path.join(this.configDir, file);
      if (fs.existsSync(sourcePath)) {
        const backupPath = path.join(backupDir, file);
        fs.copyFileSync(sourcePath, backupPath);
        console.log(`[迁移] 已备份: ${file}`);
      }
    }

    for (const file of appConfigFiles) {
      const sourcePath = path.join(userDataPath, file);
      if (fs.existsSync(sourcePath)) {
        const backupPath = path.join(backupDir, file);
        fs.copyFileSync(sourcePath, backupPath);
        console.log(`[迁移] 已备份: ${file}`);
      }
    }
  }

  /**
   * 迁移订阅数据
   */
  async migrateSubscriptions() {
    console.log('[迁移] 开始迁移订阅数据...');
    
    // 读取订阅URL记录
    const urlsPath = path.join(this.configDir, 'subscription_urls.json');
    let urlRecords = {};
    if (fs.existsSync(urlsPath)) {
      try {
        urlRecords = JSON.parse(fs.readFileSync(urlsPath, 'utf8'));
      } catch (error) {
        console.error('[迁移] 读取subscription_urls.json失败:', error);
      }
    }

    // 读取订阅信息
    const infoPath = path.join(this.configDir, 'subscription_info.json');
    let infoRecords = {};
    if (fs.existsSync(infoPath)) {
      try {
        infoRecords = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
      } catch (error) {
        console.error('[迁移] 读取subscription_info.json失败:', error);
      }
    }

    // 获取所有YAML配置文件
    const files = fs.readdirSync(this.configDir);
    const yamlFiles = files.filter(file => file.endsWith('.yaml'));

    let migratedCount = 0;
    for (const fileName of yamlFiles) {
      try {
        const filePath = path.join(this.configDir, fileName);
        const stats = fs.statSync(filePath);
        
        // 获取配置名称(去掉.yaml后缀)
        const name = fileName.replace(/\.yaml$/, '');
        
        // 获取URL
        const url = urlRecords[fileName] || null;
        
        // 添加订阅记录
        const subscriptionId = this.dbManager.addSubscription(name, filePath, url);
        
        // 添加流量信息(如果存在)
        const info = infoRecords[fileName];
        if (info) {
          const usedTraffic = this.parseTraffic(info.usedTraffic);
          const totalTraffic = this.parseTraffic(info.totalTraffic);
          const expiryTimestamp = info.expiryDate ? new Date(info.expiryDate).getTime() : null;
          
          this.dbManager.setSubscriptionInfo(
            subscriptionId,
            usedTraffic,
            totalTraffic,
            expiryTimestamp
          );
        }
        
        migratedCount++;
      } catch (error) {
        console.error(`[迁移] 迁移订阅失败: ${fileName}`, error);
      }
    }

    console.log(`[迁移] 已迁移 ${migratedCount} 个订阅`);
  }

  /**
   * 迁移设置数据
   */
  async migrateSettings() {
    console.log('[迁移] 开始迁移设置数据...');

    const settingsPath = path.join(this.configDir, 'user-settings.json');
    if (!fs.existsSync(settingsPath)) {
      console.log('[迁移] 未找到user-settings.json,跳过设置迁移');
      return;
    }

    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));

      let migratedCount = 0;
      for (const [key, value] of Object.entries(settings)) {
        try {
          this.dbManager.setSetting(key, value);
          migratedCount++;
        } catch (error) {
          console.error(`[迁移] 迁移设置失败: ${key}`, error);
        }
      }

      console.log(`[迁移] 已迁移 ${migratedCount} 个设置项`);
    } catch (error) {
      console.error('[迁移] 读取user-settings.json失败:', error);
    }
  }

  /**
   * 迁移应用配置(主题、系统代理、TUN模式)
   */
  async migrateAppConfig() {
    console.log('[迁移] 开始迁移应用配置...');

    const userDataPath = path.dirname(this.configDir);
    let migratedCount = 0;

    // 迁移主题设置
    const themeConfigPath = path.join(userDataPath, 'theme-config.json');
    if (fs.existsSync(themeConfigPath)) {
      try {
        const themeConfig = JSON.parse(fs.readFileSync(themeConfigPath, 'utf8'));
        if (themeConfig.theme) {
          this.dbManager.setSetting('theme', themeConfig.theme);
          migratedCount++;
          console.log('[迁移] 已迁移主题设置:', themeConfig.theme);
        }
      } catch (error) {
        console.error('[迁移] 迁移主题设置失败:', error);
      }
    }

    // 迁移系统代理状态
    const proxyConfigPath = path.join(userDataPath, 'proxy-config.json');
    if (fs.existsSync(proxyConfigPath)) {
      try {
        const proxyConfig = JSON.parse(fs.readFileSync(proxyConfigPath, 'utf8'));
        if (typeof proxyConfig.enabled === 'boolean') {
          this.dbManager.setSetting('systemProxyEnabled', proxyConfig.enabled);
          migratedCount++;
          console.log('[迁移] 已迁移系统代理状态:', proxyConfig.enabled);
        }
      } catch (error) {
        console.error('[迁移] 迁移系统代理状态失败:', error);
      }
    }

    // 迁移TUN模式状态
    const tunConfigPath = path.join(userDataPath, 'tun-config.json');
    if (fs.existsSync(tunConfigPath)) {
      try {
        const tunConfig = JSON.parse(fs.readFileSync(tunConfigPath, 'utf8'));
        if (typeof tunConfig.enabled === 'boolean') {
          this.dbManager.setSetting('tunModeEnabled', tunConfig.enabled);
          migratedCount++;
          console.log('[迁移] 已迁移TUN模式状态:', tunConfig.enabled);
        }
      } catch (error) {
        console.error('[迁移] 迁移TUN模式状态失败:', error);
      }
    }

    console.log(`[迁移] 已迁移 ${migratedCount} 个应用配置项`);
  }

  /**
   * 解析流量字符串为字节数
   * 例如: "1.23 GB" -> 1320702443
   */
  parseTraffic(trafficStr) {
    if (!trafficStr || typeof trafficStr !== 'string') {
      return null;
    }

    const match = trafficStr.match(/^([\d.]+)\s*([A-Z]+)$/i);
    if (!match) {
      return null;
    }

    const value = parseFloat(match[1]);
    const unit = match[2].toUpperCase();

    const units = {
      'B': 1,
      'KB': 1024,
      'MB': 1024 * 1024,
      'GB': 1024 * 1024 * 1024,
      'TB': 1024 * 1024 * 1024 * 1024
    };

    const multiplier = units[unit];
    if (!multiplier) {
      return null;
    }

    return Math.floor(value * multiplier);
  }

  /**
   * 格式化字节数为流量字符串
   * 例如: 1320702443 -> "1.23 GB"
   */
  formatTraffic(bytes) {
    if (!bytes || bytes === 0) {
      return '0 B';
    }

    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let index = 0;
    let size = bytes;

    while (size >= 1024 && index < units.length - 1) {
      size /= 1024;
      index++;
    }

    return `${size.toFixed(2)} ${units[index]}`;
  }
}

module.exports = MigrationManager;

