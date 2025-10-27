const { ipcMain } = require('electron');
const { getInstance } = require('../config-icon/config-icon-manager');

/**
 * 注册配置图标相关的IPC处理器
 */
function registerConfigIconHandlers(app) {
  const iconManager = getInstance(app);

  /**
   * 获取配置图标
   */
  ipcMain.handle('config-icon:get-icon', async (event, iconUrl, configPath) => {
    try {
      const iconPath = await iconManager.getConfigIcon(iconUrl, configPath);
      return {
        success: true,
        iconPath
      };
    } catch (error) {
      console.error('[IPC] config-icon:get-icon error:', error);
      return {
        success: false,
        error: error.message
      };
    }
  });

  /**
   * 清除图标缓存
   */
  ipcMain.handle('config-icon:clear-cache', async () => {
    try {
      const success = iconManager.clearCache();
      return {
        success
      };
    } catch (error) {
      console.error('[IPC] config-icon:clear-cache error:', error);
      return {
        success: false,
        error: error.message
      };
    }
  });

  /**
   * 获取缓存大小
   */
  ipcMain.handle('config-icon:get-cache-size', async () => {
    try {
      const size = iconManager.getCacheSize();
      return {
        success: true,
        size
      };
    } catch (error) {
      console.error('[IPC] config-icon:get-cache-size error:', error);
      return {
        success: false,
        error: error.message
      };
    }
  });
}

module.exports = {
  registerConfigIconHandlers
};

