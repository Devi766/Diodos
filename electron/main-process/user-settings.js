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
      'tun': {
        enable: false
      }
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
      const currentSettings = getUserSettings();
      const normalized = normalizeSettings(settings || {});
      const newSettings = { ...currentSettings, ...normalized };

      // 保存到数据库
      if (dbManager) {
        for (const [key, value] of Object.entries(newSettings)) {
          dbManager.setSetting(key, value);
        }
      }

      // 同时保存到YAML文件作为备份
      ensureUserSettingsFile();
      fs.writeFileSync(userSettingsPath, yaml.dump(newSettings), 'utf8');

      console.log('已更新用户设置:', newSettings);
      return true;
    } catch (error) {
      console.error('更新用户设置失败:', error);
      return false;
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
