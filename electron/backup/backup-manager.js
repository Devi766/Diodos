/**
 * 备份管理器
 * 实现与安卓端兼容的备份和还原功能
 */

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const AdmZip = require('adm-zip');
const {
  BackupType,
  BackupData,
  ImportedProfileBackup
} = require('./backup-types');
const { getInstance: getProxyIconManager } = require('../proxy-icon/proxy-icon-manager');

class BackupManager {
  constructor(context) {
    this.context = context;
    this.dbManager = context.get('dbManager');
    this.configDir = context.get('configDir');
  }

  /**
   * 创建备份
   * @param {string} backupType - 备份类型 (CONFIG_ONLY 或 FULL_BACKUP)
   * @returns {BackupData} 备份数据对象
   */
  async createBackup(backupType = BackupType.CONFIG_ONLY) {
    console.log(`[BackupManager] 开始创建备份，类型: ${backupType}`);

    try {
      const backupData = new BackupData();
      backupData.backupType = backupType;
      backupData.timestamp = Date.now();

      // 1. 获取当前激活的配置
      const activeConfig = this.context.state?.configFilePath;
      if (activeConfig) {
        // 生成UUID（如果没有的话使用文件路径的hash）
        backupData.activeProfile = this.generateProfileUUID(activeConfig);
      }

      // 2. 备份所有订阅配置
      const subscriptions = this.dbManager.getAllSubscriptions();
      backupData.importedProfiles = await this.convertSubscriptionsToProfiles(subscriptions);

      console.log(`[BackupManager] 备份了 ${backupData.importedProfiles.length} 个配置`);

      // 3. 备份代理图标配置（总是备份）
      backupData.proxyIconConfig = this.backupProxyIconConfig();
      console.log('[BackupManager] 已备份代理图标配置');

      // 4. 如果是全量备份，包含设置
      if (backupType === BackupType.FULL_BACKUP) {
        backupData.uiSettings = this.backupUiSettings();
        backupData.webDAVSettings = this.backupWebDAVSettings();
        backupData.dashboardConfig = this.backupDashboardConfig();
        backupData.overrideSettings = this.backupOverrideSettings();
        console.log('[BackupManager] 已包含全量备份数据');
      }

      console.log('[BackupManager] 备份创建成功');
      return backupData;
    } catch (error) {
      console.error('[BackupManager] 创建备份失败:', error);
      throw error;
    }
  }

  /**
   * 将桌面端订阅转换为安卓端格式的配置
   */
  async convertSubscriptionsToProfiles(subscriptions) {
    const profiles = [];

    for (const sub of subscriptions) {
      try {
        const profile = new ImportedProfileBackup();

        // 基础信息
        profile.uuid = this.generateProfileUUID(sub.file_path);
        profile.name = sub.name || path.basename(sub.file_path, '.yaml');
        profile.type = sub.url ? (sub.url.startsWith('local:') ? 'FILE' : 'URL') : 'FILE';
        profile.source = sub.url || sub.file_path;
        profile.interval = sub.update_interval || 0;
        profile.createdAt = sub.created_at || Date.now();
        profile.iconUrl = sub.icon_url || '';

        // 流量信息
        profile.upload = sub.used_traffic || 0;
        profile.download = 0; // 桌面端没有分开存储
        profile.total = sub.total_traffic || 0;
        profile.expire = sub.expiry_timestamp || 0;

        // 读取配置文件内容
        if (fs.existsSync(sub.file_path)) {
          profile.configContent = fs.readFileSync(sub.file_path, 'utf8');
          console.log(`[BackupManager] 读取配置文件: ${sub.name} (${profile.configContent.length} bytes)`);
        } else {
          console.warn(`[BackupManager] 配置文件不存在: ${sub.file_path}`);
        }

        profiles.push(profile);
      } catch (error) {
        console.error(`[BackupManager] 转换订阅失败: ${sub.name}`, error);
      }
    }

    return profiles;
  }

  /**
   * 备份UI设置
   */
  backupUiSettings() {
    const UiSettingsBackup = require('./backup-types').UiSettingsBackup;
    const settings = new UiSettingsBackup();

    try {
      // 从数据库读取设置
      const theme = this.dbManager.getSetting('theme', 'light');
      const language = this.dbManager.getSetting('language', 'zh-CN');

      settings.darkMode = theme === 'dark' ? 'Dark' : (theme === 'light' ? 'Light' : 'Auto');
      settings.userAgent = `FlyClash/Desktop/${this.context.get('appVersion')}`;

      return settings;
    } catch (error) {
      console.error('[BackupManager] 备份UI设置失败:', error);
      return settings;
    }
  }

  /**
   * 备份WebDAV设置
   */
  backupWebDAVSettings() {
    const WebDAVSettingsBackup = require('./backup-types').WebDAVSettingsBackup;
    const settings = new WebDAVSettingsBackup();

    try {
      settings.uri = this.dbManager.getSetting('webdav_uri', '');
      settings.username = this.dbManager.getSetting('webdav_username', '');
      settings.password = this.dbManager.getSetting('webdav_password', '');
      settings.backupDirectory = this.dbManager.getSetting('webdav_backup_dir', 'FlyClash');
      settings.fileName = this.dbManager.getSetting('webdav_backup_filename', 'flyclash_backup.zip');

      return settings;
    } catch (error) {
      console.error('[BackupManager] 备份WebDAV设置失败:', error);
      return settings;
    }
  }

  /**
   * 备份仪表板配置
   */
  backupDashboardConfig() {
    const DashboardConfigBackup = require('./backup-types').DashboardConfigBackup;
    const config = new DashboardConfigBackup();

    try {
      const dashboardConfig = this.dbManager.getSetting('dashboard_config', null);
      if (dashboardConfig) {
        config.cardOrder = dashboardConfig.cardOrder || [];
        config.enabledCards = dashboardConfig.enabledCards || [];
        config.cardSettings = dashboardConfig.cardSettings || {};
      }

      return config;
    } catch (error) {
      console.error('[BackupManager] 备份仪表板配置失败:', error);
      return config;
    }
  }

  /**
   * 备份覆盖设置
   */
  backupOverrideSettings() {
    const OverrideSettingsBackup = require('./backup-types').OverrideSettingsBackup;
    const settings = new OverrideSettingsBackup();

    try {
      // 从数据库读取覆盖设置
      settings.jsOverrideEnabled = this.dbManager.getSetting('js_override_enabled', false);
      settings.jsOverrideContent = this.dbManager.getSetting('js_override_content', '');
      settings.yamlOverrideEnabled = this.dbManager.getSetting('yaml_override_enabled', false);
      settings.yamlOverrideContent = this.dbManager.getSetting('yaml_override_content', '');

      return settings;
    } catch (error) {
      console.error('[BackupManager] 备份覆盖设置失败:', error);
      return settings;
    }
  }

  /**
   * 还原备份
   * @param {BackupData} backupData - 备份数据对象
   * @returns {boolean} 是否成功
   */
  async restoreBackup(backupData) {
    console.log('[BackupManager] 开始还原备份');

    try {
      // 1. 验证备份数据
      if (!backupData || !backupData.version) {
        throw new Error('无效的备份数据');
      }

      console.log(`[BackupManager] 备份版本: ${backupData.version}, 类型: ${backupData.backupType}`);

      // 2. 还原配置文件
      let restoredActiveConfigPath = null;
      if (backupData.importedProfiles && backupData.importedProfiles.length > 0) {
        restoredActiveConfigPath = await this.restoreProfiles(
          backupData.importedProfiles,
          backupData.activeProfile
        );
        console.log(`[BackupManager] 还原了 ${backupData.importedProfiles.length} 个配置`);
      }

      // 3. 还原代理图标配置（总是还原）
      if (backupData.proxyIconConfig) {
        this.restoreProxyIconConfig(backupData.proxyIconConfig);
        console.log('[BackupManager] 已还原代理图标配置');
      }

      // 4. 如果是全量备份，还原设置
      if (backupData.backupType === BackupType.FULL_BACKUP) {
        if (backupData.uiSettings) {
          this.restoreUiSettings(backupData.uiSettings);
        }
        if (backupData.webDAVSettings) {
          this.restoreWebDAVSettings(backupData.webDAVSettings);
        }
        if (backupData.dashboardConfig) {
          this.restoreDashboardConfig(backupData.dashboardConfig);
        }
        if (backupData.overrideSettings) {
          this.restoreOverrideSettings(backupData.overrideSettings);
        }
        console.log('[BackupManager] 已还原全量备份数据');
      }

      // 5. 如果有激活的配置，设置为激活状态
      if (restoredActiveConfigPath) {
        this.context.state.configFilePath = restoredActiveConfigPath;
        console.log(`[BackupManager] 设置激活配置: ${restoredActiveConfigPath}`);
      }

      console.log('[BackupManager] 备份还原成功');
      return true;
    } catch (error) {
      console.error('[BackupManager] 还原备份失败:', error);
      throw error;
    }
  }

  /**
   * 还原配置文件
   */
  async restoreProfiles(profiles, activeProfileUUID) {
    let restoredActiveConfigPath = null;

    for (const profile of profiles) {
      try {
        console.log(`[BackupManager] 还原配置: ${profile.name}`);

        // 生成文件名（清理特殊字符）
        const sanitized = profile.name.replace(/[/\\?%*:|"<>]/g, '_');
        const fileName = `${sanitized}.yaml`;
        const filePath = path.join(this.configDir, fileName);

        // 写入配置文件
        if (profile.configContent) {
          fs.writeFileSync(filePath, profile.configContent, 'utf8');
          console.log(`[BackupManager] 写入配置文件: ${filePath}`);
        }

        // 添加到数据库
        this.dbManager.addSubscription(
          profile.name,
          filePath,
          profile.source,
          profile.interval || 0
        );

        // 设置图标URL
        if (profile.iconUrl) {
          this.dbManager.updateSubscriptionByPath(filePath, {
            icon_url: profile.iconUrl
          });
        }

        // 设置流量信息
        if (profile.total > 0 || profile.expire > 0) {
          this.dbManager.setSubscriptionInfoByPath(
            filePath,
            profile.upload,
            profile.total,
            profile.expire
          );
        }

        // 如果是激活的配置，记录路径
        if (profile.uuid === activeProfileUUID) {
          restoredActiveConfigPath = filePath;
        }

        console.log(`[BackupManager] 配置还原成功: ${profile.name}`);
      } catch (error) {
        console.error(`[BackupManager] 还原配置失败: ${profile.name}`, error);
      }
    }

    return restoredActiveConfigPath;
  }

  /**
   * 还原UI设置
   */
  restoreUiSettings(settings) {
    try {
      // 转换主题
      let theme = 'system';
      if (settings.darkMode === 'Dark') theme = 'dark';
      else if (settings.darkMode === 'Light') theme = 'light';

      this.dbManager.setSetting('theme', theme);

      console.log('[BackupManager] UI设置还原成功');
    } catch (error) {
      console.error('[BackupManager] 还原UI设置失败:', error);
    }
  }

  /**
   * 还原WebDAV设置
   */
  restoreWebDAVSettings(settings) {
    try {
      this.dbManager.setSetting('webdav_uri', settings.uri);
      this.dbManager.setSetting('webdav_username', settings.username);
      this.dbManager.setSetting('webdav_password', settings.password);
      this.dbManager.setSetting('webdav_backup_dir', settings.backupDirectory);
      this.dbManager.setSetting('webdav_backup_filename', settings.fileName);

      console.log('[BackupManager] WebDAV设置还原成功');
    } catch (error) {
      console.error('[BackupManager] 还原WebDAV设置失败:', error);
    }
  }

  /**
   * 还原仪表板配置
   */
  restoreDashboardConfig(config) {
    try {
      this.dbManager.setSetting('dashboard_config', {
        cardOrder: config.cardOrder,
        enabledCards: config.enabledCards,
        cardSettings: config.cardSettings
      });

      console.log('[BackupManager] 仪表板配置还原成功');
    } catch (error) {
      console.error('[BackupManager] 还原仪表板配置失败:', error);
    }
  }

  /**
   * 还原覆盖设置
   */
  restoreOverrideSettings(settings) {
    try {
      this.dbManager.setSetting('js_override_enabled', settings.jsOverrideEnabled);
      this.dbManager.setSetting('js_override_content', settings.jsOverrideContent);
      this.dbManager.setSetting('yaml_override_enabled', settings.yamlOverrideEnabled);
      this.dbManager.setSetting('yaml_override_content', settings.yamlOverrideContent);

      console.log('[BackupManager] 覆盖设置还原成功');
    } catch (error) {
      console.error('[BackupManager] 还原覆盖设置失败:', error);
    }
  }

  /**
   * 生成配置UUID（基于文件路径）
   */
  generateProfileUUID(filePath) {
    // 使用文件路径生成确定性的UUID
    const crypto = require('crypto');
    const hash = crypto.createHash('md5').update(filePath).digest('hex');
    // 转换为UUID格式
    return `${hash.substr(0, 8)}-${hash.substr(8, 4)}-${hash.substr(12, 4)}-${hash.substr(16, 4)}-${hash.substr(20, 12)}`;
  }

  /**
   * 将备份数据序列化为JSON字符串
   */
  serializeBackup(backupData) {
    return JSON.stringify(backupData, null, 2);
  }

  /**
   * 从JSON字符串反序列化备份数据
   * 支持标准备份和增强版备份
   */
  deserializeBackup(jsonString) {
    try {
      const data = JSON.parse(jsonString);

      // 调试：打印数据的前1000个字符
      console.log('[BackupManager] 备份数据预览:', JSON.stringify(data).substring(0, 500));
      console.log('[BackupManager] 备份数据字段:', Object.keys(data));
      console.log('[BackupManager] 版本号:', data.version);

      // 检测备份类型
      // 1. 如果有version字段且为2.0，是增强版备份
      // 2. 如果没有version字段但有importedProfiles，可能是安卓端的备份（缺少version字段）
      // 3. 如果有version字段且为1.2，是标准备份

      if (!data.version && data.importedProfiles) {
        // 安卓端备份可能缺少version字段，添加默认值
        console.log('[BackupManager] 检测到安卓端备份（缺少version字段），添加默认值');
        data.version = '2.0'; // 假设是增强版备份
        data.backupType = 'CONFIG_ONLY'; // 默认类型
      }

      // 检查是否是增强版备份（version 2.0）
      if (data.version === '2.0') {
        console.log('[BackupManager] 检测到增强版备份，转换为标准格式');

        // 增强版备份转换为标准备份格式
        // 保留配置相关的数据，忽略systemBackup（PC端不支持）
        return {
          version: data.version,
          timestamp: data.timestamp || Date.now(),
          backupType: data.backupType || 'CONFIG_ONLY',
          activeProfile: data.activeProfile,
          importedProfiles: data.importedProfiles || [],
          pendingProfiles: data.pendingProfiles || [],
          selections: data.selections || [],
          proxyIconConfig: data.proxyIconConfig,
          // 增强版备份中的systemBackup包含了设置信息，但PC端结构不同，暂时忽略
          uiSettings: null,
          webDAVSettings: null,
          dashboardConfig: null,
          overrideSettings: null
        };
      }

      // 标准备份格式（version 1.2），直接返回
      console.log('[BackupManager] 标准备份格式');
      return data;
    } catch (error) {
      console.error('[BackupManager] 反序列化备份数据失败:', error);
      console.error('[BackupManager] JSON字符串长度:', jsonString.length);
      console.error('[BackupManager] JSON字符串前500字符:', jsonString.substring(0, 500));
      throw error;
    }
  }

  /**
   * 创建备份ZIP文件
   * @param {BackupData} backupData - 备份数据
   * @param {string} outputPath - 输出文件路径
   */
  async createBackupZip(backupData, outputPath) {
    try {
      console.log(`[BackupManager] 创建备份ZIP: ${outputPath}`);

      const zip = new AdmZip();

      // 将备份数据转换为JSON并添加到ZIP
      // 使用 backup_metadata.json 以兼容安卓端
      const jsonData = this.serializeBackup(backupData);
      zip.addFile('backup_metadata.json', Buffer.from(jsonData, 'utf8'));

      // 写入ZIP文件
      zip.writeZip(outputPath);

      console.log(`[BackupManager] 备份ZIP创建成功: ${outputPath}`);
      return true;
    } catch (error) {
      console.error('[BackupManager] 创建备份ZIP失败:', error);
      throw error;
    }
  }

  /**
   * 使用流式读取ZIP文件（类似安卓端的ZipInputStream）
   * 这种方法不依赖中央目录，可以读取"损坏"的ZIP文件
   * @param {string} zipPath - ZIP文件路径
   * @returns {Object|null} 包含文件名和内容的对象，如果失败则返回null
   */
  readZipStreamBased(zipPath) {
    try {
      console.log('[BackupManager] 使用流式方法读取ZIP文件...');

      const fileData = fs.readFileSync(zipPath);
      const files = {};
      let offset = 0;

      // ZIP签名
      const LOCAL_FILE_HEADER_SIG = 0x04034b50;  // PK\x03\x04
      const DATA_DESCRIPTOR_SIG = 0x08074b50;     // PK\x07\x08

      while (offset < fileData.length - 30) {
        // 读取签名
        const signature = fileData.readUInt32LE(offset);

        if (signature === LOCAL_FILE_HEADER_SIG) {
          // 找到本地文件头
          const flags = fileData.readUInt16LE(offset + 6);
          const method = fileData.readUInt16LE(offset + 8);
          let compressedSize = fileData.readUInt32LE(offset + 18);
          let uncompressedSize = fileData.readUInt32LE(offset + 22);
          const fileNameLength = fileData.readUInt16LE(offset + 26);
          const extraFieldLength = fileData.readUInt16LE(offset + 28);

          // 检查是否使用数据描述符（bit 3）
          const hasDataDescriptor = (flags & 0x08) !== 0;

          // 读取文件名
          const fileNameStart = offset + 30;
          const fileName = fileData.toString('utf8', fileNameStart, fileNameStart + fileNameLength);

          // 数据起始位置
          const dataStart = fileNameStart + fileNameLength + extraFieldLength;

          let fileContent = null;
          let actualDataEnd = dataStart;
          let nextOffset = dataStart; // 下一个文件的偏移量

          if (hasDataDescriptor) {
            // 使用数据描述符，需要查找数据结束位置
            console.log(`[BackupManager] 文件 ${fileName} 使用数据描述符`);

            // 查找数据描述符签名或下一个文件头
            let searchOffset = dataStart;
            let foundEnd = false;

            while (searchOffset < fileData.length - 16) {
              const sig = fileData.readUInt32LE(searchOffset);

              if (sig === DATA_DESCRIPTOR_SIG || sig === LOCAL_FILE_HEADER_SIG || sig === 0x02014b50) {
                // 找到数据描述符或下一个文件头
                actualDataEnd = searchOffset;
                foundEnd = true;

                if (sig === DATA_DESCRIPTOR_SIG) {
                  // 读取数据描述符中的大小信息
                  compressedSize = fileData.readUInt32LE(searchOffset + 8);
                  uncompressedSize = fileData.readUInt32LE(searchOffset + 12);
                  actualDataEnd = searchOffset;
                  nextOffset = searchOffset + 16; // 跳过数据描述符
                } else {
                  // 找到下一个文件头，不跳过
                  nextOffset = searchOffset;
                }
                break;
              }
              searchOffset++;
            }

            if (!foundEnd) {
              console.warn(`[BackupManager] 无法找到文件 ${fileName} 的结束位置`);
              break;
            }
          } else {
            // 不使用数据描述符，直接使用头部的大小
            actualDataEnd = dataStart + compressedSize;
            nextOffset = actualDataEnd;
          }

          // 提取并解压数据
          if (actualDataEnd <= fileData.length) {
            const compressedData = Buffer.from(fileData.buffer, fileData.byteOffset + dataStart, actualDataEnd - dataStart);

            if (method === 0) {
              // 未压缩
              fileContent = compressedData;
            } else if (method === 8) {
              // Deflate压缩
              try {
                const zlib = require('zlib');
                fileContent = zlib.inflateRawSync(compressedData);
              } catch (zlibError) {
                console.error(`[BackupManager] 解压文件失败: ${fileName}`, zlibError);
                console.error(`[BackupManager] 压缩数据大小: ${compressedData.length}, 预期: ${compressedSize}`);
                fileContent = null;
              }
            } else {
              console.warn(`[BackupManager] 不支持的压缩方法: ${method}`);
              fileContent = null;
            }

            if (fileContent) {
              files[fileName] = fileContent;
              console.log(`[BackupManager] 读取文件: ${fileName} (${fileContent.length} bytes)`);
            }

            // 移动到下一个位置
            offset = nextOffset;
          } else {
            console.warn('[BackupManager] 文件数据超出范围，停止读取');
            break;
          }
        } else {
          // 不是本地文件头，跳过
          offset++;
        }
      }

      console.log(`[BackupManager] 流式读取完成，找到 ${Object.keys(files).length} 个文件`);
      return files;
    } catch (error) {
      console.error('[BackupManager] 流式读取ZIP失败:', error);
      return null;
    }
  }

  /**
   * 从ZIP文件读取备份数据
   * @param {string} zipPath - ZIP文件路径
   * @returns {BackupData} 备份数据
   */
  async extractBackupZip(zipPath) {
    try {
      console.log(`[BackupManager] 读取备份ZIP: ${zipPath}`);

      let files = null;
      let useStreamMethod = false;

      // 尝试使用AdmZip读取
      try {
        const zip = new AdmZip(zipPath);
        const entries = zip.getEntries();

        // 转换为文件对象
        files = {};
        entries.forEach(entry => {
          if (!entry.isDirectory) {
            files[entry.entryName] = entry.getData();
          }
        });

        console.log(`[BackupManager] AdmZip读取成功，找到 ${Object.keys(files).length} 个文件`);
      } catch (error) {
        console.warn('[BackupManager] AdmZip读取失败，尝试流式读取:', error.message);

        // 使用流式方法读取（类似安卓端的ZipInputStream）
        files = this.readZipStreamBased(zipPath);
        useStreamMethod = true;

        if (!files || Object.keys(files).length === 0) {
          throw new Error('无法读取ZIP文件内容');
        }
      }

      // 支持多种备份文件名，按优先级尝试
      const possibleFileNames = [
        'enhanced_backup_metadata.json',  // 安卓端增强版备份
        'backup_metadata.json',           // 安卓端标准备份
        'backup.json'                     // PC端旧版备份
      ];

      let foundFileName = null;
      let jsonData = null;

      for (const fileName of possibleFileNames) {
        if (files[fileName]) {
          foundFileName = fileName;
          jsonData = files[fileName].toString('utf8');
          console.log(`[BackupManager] 找到备份文件: ${fileName} (${useStreamMethod ? '流式读取' : 'AdmZip'})`);
          break;
        }
      }

      if (!jsonData) {
        // 列出ZIP中的所有文件以便调试
        console.error('[BackupManager] ZIP文件内容:', Object.keys(files));
        throw new Error('ZIP文件中未找到有效的备份数据文件');
      }

      const backupData = this.deserializeBackup(jsonData);

      console.log(`[BackupManager] 备份ZIP读取成功, 文件: ${foundFileName}, 版本: ${backupData.version}`);
      return backupData;
    } catch (error) {
      console.error('[BackupManager] 读取备份ZIP失败:', error);
      throw error;
    }
  }

  /**
   * 备份代理图标配置
   */
  backupProxyIconConfig() {
    try {
      const iconManager = getProxyIconManager();
      const config = iconManager.getConfig();

      // 获取图标缓存文件
      const iconCacheFiles = {};
      const cachedIcons = iconManager.getCachedIcons();

      for (const filename of cachedIcons) {
        try {
          const filePath = path.join(iconManager.getIconCacheDir(), filename);
          const fileData = fs.readFileSync(filePath);
          const base64 = fileData.toString('base64');
          iconCacheFiles[filename] = base64;
        } catch (error) {
          console.warn(`[BackupManager] 读取图标缓存文件失败: ${filename}`, error);
        }
      }

      console.log(`[BackupManager] 备份代理图标配置: ${config.rules.length} 条规则, ${Object.keys(iconCacheFiles).length} 个缓存文件`);

      return {
        enabled: config.enabled,
        rules: config.rules,
        iconCacheFiles: iconCacheFiles
      };
    } catch (error) {
      console.error('[BackupManager] 备份代理图标配置失败:', error);
      return null;
    }
  }

  /**
   * 还原代理图标配置
   */
  restoreProxyIconConfig(configBackup) {
    try {
      console.log('[BackupManager] 开始还原代理图标配置...');

      const iconManager = getProxyIconManager();

      // 还原配置
      const config = {
        enabled: configBackup.enabled !== undefined ? configBackup.enabled : true,
        rules: configBackup.rules || []
      };
      iconManager.saveConfig(config);

      // 还原图标缓存文件
      if (configBackup.iconCacheFiles) {
        const cacheDir = iconManager.getIconCacheDir();

        for (const [filename, base64Content] of Object.entries(configBackup.iconCacheFiles)) {
          try {
            const buffer = Buffer.from(base64Content, 'base64');
            const filePath = path.join(cacheDir, filename);
            fs.writeFileSync(filePath, buffer);
          } catch (error) {
            console.warn(`[BackupManager] 还原图标缓存文件失败: ${filename}`, error);
          }
        }

        console.log(`[BackupManager] 代理图标配置还原成功: ${config.rules.length} 条规则, ${Object.keys(configBackup.iconCacheFiles).length} 个缓存文件`);
      }
    } catch (error) {
      console.error('[BackupManager] 还原代理图标配置失败:', error);
    }
  }
}

module.exports = BackupManager;
