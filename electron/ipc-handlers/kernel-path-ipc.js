'use strict';

/**
 * Kernel path IPC handlers
 * Handles getting, selecting, and resetting the Mihomo kernel executable path.
 */

const { ipcMain, dialog } = require('electron');
const fs = require('fs');

/**
 * Register kernel path IPC handlers.
 * @param {object} deps
 * @param {object} deps.state - Shared application state
 * @param {object} deps.context - Shared context object
 * @param {boolean} deps.isWindows - Whether running on Windows
 * @param {Function} deps.loadKernelPreference - Load kernel preference
 * @param {Function} deps.resolveDefaultKernelPath - Resolve default kernel path
 * @param {Function} deps.saveKernelPreference - Save kernel preference
 * @param {Function} deps.clearKernelPreference - Clear kernel preference
 */
function registerKernelPathHandlers({ state, context, isWindows, loadKernelPreference, resolveDefaultKernelPath, saveKernelPreference, clearKernelPreference }) {

  ipcMain.handle('get-kernel-path', async () => {
    try {
      const preference = context.kernelPreference || loadKernelPreference();
      const customPath = preference?.customPath ? String(preference.customPath).trim() : '';
      const defaultPath = resolveDefaultKernelPath();
      const activePath = customPath || defaultPath || '';
      const exists = activePath ? fs.existsSync(activePath) : false;

      return {
        success: true,
        path: activePath,
        isDefault: !customPath,
        exists
      };
    } catch (error) {
      console.error('获取内核路径失败:', error);
      return {
        success: false,
        error: error?.message || String(error)
      };
    }
  });

  ipcMain.handle('select-kernel-executable', async () => {
    try {
      const result = await dialog.showOpenDialog(state.mainWindow ?? undefined, {
        title: '选择 Mihomo 内核',
        properties: ['openFile'],
        filters: isWindows
          ? [
              {
                name: '可执行文件',
                extensions: ['exe']
              }
            ]
          : [
              {
                name: '可执行文件',
                extensions: ['*']
              }
            ]
      });

      if (result.canceled || !result.filePaths?.length) {
        return { success: false, canceled: true };
      }

      const selectedPath = result.filePaths[0];
      saveKernelPreference({ customPath: selectedPath });

      return {
        success: true,
        path: selectedPath,
        isDefault: false,
        exists: fs.existsSync(selectedPath),
        needsRestart: Boolean(state.mihomoProcess)
      };
    } catch (error) {
      console.error('选择内核文件失败:', error);
      return {
        success: false,
        error: error?.message || String(error)
      };
    }
  });

  ipcMain.handle('reset-kernel-path', async () => {
    try {
      clearKernelPreference();
      const defaultPath = resolveDefaultKernelPath();
      return {
        success: true,
        path: defaultPath || '',
        isDefault: true,
        exists: defaultPath ? fs.existsSync(defaultPath) : false,
        needsRestart: Boolean(state.mihomoProcess)
      };
    } catch (error) {
      console.error('恢复默认内核失败:', error);
      return {
        success: false,
        error: error?.message || String(error)
      };
    }
  });
}

module.exports = { registerKernelPathHandlers };
