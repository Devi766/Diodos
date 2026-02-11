'use strict';

/**
 * Core manager IPC handlers
 * Handles core:get-current-config, core:get-installed-cores, core:get-available-versions,
 * core:clear-version-cache, core:download-specific-version, core:check-update,
 * core:download-core, core:switch-core, core:delete-core, core:set-custom-path.
 */

const { ipcMain } = require('electron');
const fs = require('fs');

/**
 * Register core manager IPC handlers.
 * @param {object} deps
 * @param {object} deps.state - Shared application state
 * @param {object} deps.context - Shared context object
 * @param {object} deps.dbManager - Database manager (for core:set-custom-path)
 */
function registerCoreManagerIpcHandlers({ state, context, dbManager }) {

  // 获取当前内核配置
  ipcMain.handle('core:get-current-config', async () => {
    try {
      if (!context.coreManager) {
        return { success: false, error: 'CoreManager not initialized' };
      }
      const config = context.coreManager.getCurrentCoreConfig();
      const corePath = context.coreManager.getCorePath();
      const version = await context.coreManager.getCoreVersion(corePath);

      return {
        success: true,
        config,
        corePath,
        version,
        exists: fs.existsSync(corePath)
      };
    } catch (error) {
      console.error('[IPC] 获取内核配置失败:', error);
      return { success: false, error: error.message };
    }
  });

  // 获取已安装的内核列表
  ipcMain.handle('core:get-installed-cores', async () => {
    try {
      if (!context.coreManager) {
        return { success: false, error: 'CoreManager not initialized' };
      }
      const cores = context.coreManager.getInstalledCores();

      const coresWithVersion = await Promise.all(
        cores.map(async (core) => {
          const version = await context.coreManager.getCoreVersion(core.path);
          return { ...core, version };
        })
      );

      return { success: true, cores: coresWithVersion };
    } catch (error) {
      console.error('[IPC] 获取内核列表失败:', error);
      return { success: false, error: error.message };
    }
  });

  // 获取可用版本列表
  ipcMain.handle('core:get-available-versions', async (event, coreType, limit, forceRefresh = false) => {
    try {
      if (!context.coreManager) {
        return { success: false, error: 'CoreManager not initialized' };
      }
      const versions = await context.coreManager.getAvailableVersions(coreType, limit, Boolean(forceRefresh));
      return { success: true, versions };
    } catch (error) {
      console.error('[IPC] 获取版本列表失败:', error);
      return { success: false, error: error.message };
    }
  });

  // 清理内核版本缓存
  ipcMain.handle('core:clear-version-cache', async (event, coreType = null) => {
    try {
      if (!context.coreManager) {
        return { success: false, error: 'CoreManager not initialized' };
      }
      context.coreManager.clearVersionCache(coreType || null);
      return { success: true };
    } catch (error) {
      console.error('[IPC] 清理版本缓存失败:', error);
      return { success: false, error: error.message };
    }
  });

  // 下载指定版本的内核
  ipcMain.handle('core:download-specific-version', async (event, coreType, version) => {
    try {
      if (!context.coreManager) {
        return { success: false, error: 'CoreManager not initialized' };
      }

      const result = await context.coreManager.downloadSpecificVersion(coreType, version, (progress, downloaded, total) => {
        if (state.mainWindow && !state.mainWindow.isDestroyed()) {
          state.mainWindow.webContents.send('core:download-progress', {
            coreType,
            version,
            progress,
            downloaded,
            total
          });
        }
      });

      return result;
    } catch (error) {
      console.error('[IPC] 下载指定版本失败:', error);
      return { success: false, error: error.message };
    }
  });

  // 检查内核更新
  ipcMain.handle('core:check-update', async (event, coreType) => {
    try {
      if (!context.coreManager) {
        return { success: false, error: 'CoreManager not initialized' };
      }
      const updateInfo = await context.coreManager.checkCoreUpdate(coreType);
      return { success: true, ...updateInfo };
    } catch (error) {
      console.error('[IPC] 检查内核更新失败:', error);
      return { success: false, error: error.message };
    }
  });

  // 下载内核
  ipcMain.handle('core:download-core', async (event, coreType) => {
    try {
      if (!context.coreManager) {
        return { success: false, error: 'CoreManager not initialized' };
      }

      const result = await context.coreManager.downloadCore(coreType, (progress, downloaded, total) => {
        if (state.mainWindow && !state.mainWindow.isDestroyed()) {
          state.mainWindow.webContents.send('core:download-progress', {
            coreType,
            progress,
            downloaded,
            total
          });
        }
      });

      return result;
    } catch (error) {
      console.error('[IPC] 下载内核失败:', error);
      return { success: false, error: error.message };
    }
  });

  // 切换内核
  ipcMain.handle('core:switch-core', async (event, coreType, specificVersion) => {
    try {
      if (!context.coreManager) {
        return { success: false, error: 'CoreManager not initialized' };
      }
      const result = await context.coreManager.switchCore(coreType, specificVersion);
      return result;
    } catch (error) {
      console.error('[IPC] 切换内核失败:', error);
      return { success: false, error: error.message };
    }
  });

  // 删除内核
  ipcMain.handle('core:delete-core', async (event, corePath) => {
    try {
      if (!context.coreManager) {
        return { success: false, error: 'CoreManager not initialized' };
      }
      const result = context.coreManager.deleteCore(corePath);
      return result;
    } catch (error) {
      console.error('[IPC] 删除内核失败:', error);
      return { success: false, error: error.message };
    }
  });

  // 设置自定义内核路径
  ipcMain.handle('core:set-custom-path', async (event, customPath) => {
    try {
      if (!context.dbManager) {
        return { success: false, error: 'Database not initialized' };
      }
      context.dbManager.setSetting('core_custom_path', customPath);

      // macOS/Linux: 同步新内核到系统目录以保持 TUN 授权
      if (context.coreManager && typeof context.coreManager._syncKernelForTun === 'function') {
        await context.coreManager._syncKernelForTun();
      }

      return { success: true };
    } catch (error) {
      console.error('[IPC] 设置自定义内核路径失败:', error);
      return { success: false, error: error.message };
    }
  });
}

module.exports = { registerCoreManagerIpcHandlers };
