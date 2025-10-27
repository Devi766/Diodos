module.exports = function initUserSettings(context) {
  const { fs, path, yaml, userDataPath, dbManager } = context;

  const userSettingsPath = path.join(userDataPath, 'user-settings.yaml');

  function ensureUserSettingsFile() {
    if (fs.existsSync(userSettingsPath)) {
      return;
    }

    const defaultSettings = {
      'mixed-port': 7890,
      'allow-lan': false,
      'ipv6': false,
      'find-process-mode': 'always',
      'tun': {
        enable: false
      }
      // 注意: 不设置 external-controller 和 secret,默认不启动外部控制器(安全)
    };

    try {
      fs.writeFileSync(userSettingsPath, yaml.dump(defaultSettings), 'utf8');
      console.log('已创建用户设置文件:', userSettingsPath);
    } catch (error) {
      console.error('创建用户设置文件失败:', error);
    }
  }

  function getUserSettings() {
    try {
      // 从数据库读取设置
      if (dbManager) {
        return dbManager.getAllSettings();
      }

      // 降级方案:从YAML文件读取
      ensureUserSettingsFile();
      const content = fs.readFileSync(userSettingsPath, 'utf8');
      return yaml.load(content) || {};
    } catch (error) {
      console.error('读取用户设置失败:', error);
      return {};
    }
  }

  function normalizeSettings(settings) {
    const updated = { ...settings };

    if ('mixed-port' in updated) {
      if (
        typeof updated['mixed-port'] !== 'number' ||
        updated['mixed-port'] < 1 ||
        updated['mixed-port'] > 65535
      ) {
        console.warn('端口号无效，将使用默认值');
        updated['mixed-port'] = 7890;
      }
    }

    for (const key of ['allow-lan', 'ipv6']) {
      if (key in updated) {
        updated[key] = Boolean(updated[key]);
      }
    }

    if (updated.tun && typeof updated.tun === 'object') {
      if ('enable' in updated.tun) {
        updated.tun.enable = Boolean(updated.tun.enable);
      }
    }

    return updated;
  }

  function updateUserSettings(settings) {
    try {
      console.log('[updateUserSettings] 开始更新用户设置');
      console.log('[updateUserSettings] 输入设置:', JSON.stringify(settings, null, 2));

      const currentSettings = getUserSettings();
      console.log('[updateUserSettings] 当前设置:', JSON.stringify(currentSettings, null, 2));

      const normalized = normalizeSettings(settings || {});
      console.log('[updateUserSettings] 规范化后的设置:', JSON.stringify(normalized, null, 2));

      const newSettings = { ...currentSettings, ...normalized };
      console.log('[updateUserSettings] 合并后的新设置:', JSON.stringify(newSettings, null, 2));

      // 保存到数据库
      if (dbManager) {
        console.log('[updateUserSettings] 正在保存到数据库...');
        for (const [key, value] of Object.entries(newSettings)) {
          // 跳过 undefined 和 null 值
          if (value === undefined || value === null) {
            console.log(`[updateUserSettings] 跳过空值: ${key} = ${value}`);
            continue;
          }

          try {
            console.log(`[updateUserSettings] 保存设置: ${key} = ${JSON.stringify(value)}`);
            dbManager.setSetting(key, value);
          } catch (setError) {
            console.error(`[updateUserSettings] 保存设置失败: ${key}`, setError);
            throw setError;
          }
        }
        console.log('[updateUserSettings] 数据库保存完成');
      } else {
        console.warn('[updateUserSettings] dbManager 不可用，跳过数据库保存');
      }

      // 同时保存到YAML文件作为备份
      console.log('[updateUserSettings] 正在保存到YAML文件:', userSettingsPath);
      ensureUserSettingsFile();
      fs.writeFileSync(userSettingsPath, yaml.dump(newSettings), 'utf8');
      console.log('[updateUserSettings] YAML文件保存完成');

      console.log('[updateUserSettings] 用户设置更新成功');
      return true;
    } catch (error) {
      console.error('[updateUserSettings] 更新用户设置失败:', error);
      console.error('[updateUserSettings] 错误堆栈:', error.stack);
      throw error; // 抛出错误而不是返回 false
    }
  }

  context.userSettings = {
    path: userSettingsPath,
    ensureUserSettingsFile,
    getUserSettings,
    updateUserSettings
  };

  context.ensureUserSettingsFile = ensureUserSettingsFile;
  context.getUserSettings = getUserSettings;
  context.updateUserSettingsRaw = updateUserSettings;
};
