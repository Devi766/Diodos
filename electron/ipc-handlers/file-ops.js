'use strict';

/**
 * File operations IPC handlers
 * Handles opening files and showing file locations with auth token verification.
 */

const { ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');

/**
 * Register file operation IPC handlers.
 * @param {object} deps
 * @param {Function} deps.verifyAuthToken - Token verification function
 */
function registerFileOpsHandlers({ verifyAuthToken }) {

  ipcMain.handle('open-file', async (event, token, filePath) => {
    try {
      console.log('打开文件请求，token:', token);
      console.log('打开文件请求，原始路径:', filePath);

      if (!verifyAuthToken(token)) {
        console.error('安全令牌验证失败');
        return { success: false, error: '安全令牌验证失败' };
      }

      const normalizedPath = path.normalize(filePath);
      console.log('规范化后的路径:', normalizedPath);

      if (!fs.existsSync(normalizedPath)) {
        console.error('文件不存在:', normalizedPath);
        return { success: false, error: `文件不存在: ${normalizedPath}` };
      }

      const errorMessage = await shell.openPath(normalizedPath);
      if (errorMessage) {
        console.error('打开文件失败:', errorMessage);
        return { success: false, error: errorMessage };
      }
      console.log('文件打开成功');
      return { success: true };
    } catch (error) {
      console.error('打开文件失败:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('open-file-location', (event, token, filePath) => {
    try {
      console.log('打开文件位置请求，token:', token);
      console.log('打开文件位置请求，原始路径:', filePath);

      if (!verifyAuthToken(token)) {
        console.error('安全令牌验证失败');
        return { success: false, error: '安全令牌验证失败' };
      }

      const normalizedPath = path.normalize(filePath);
      console.log('规范化后的路径:', normalizedPath);

      if (!fs.existsSync(normalizedPath)) {
        console.error('文件不存在:', normalizedPath);
        return { success: false, error: `文件不存在: ${normalizedPath}` };
      }

      shell.showItemInFolder(normalizedPath);
      console.log('文件位置打开成功');
      return { success: true };
    } catch (error) {
      console.error('打开文件所在目录失败:', error);
      return { success: false, error: error.message };
    }
  });
}

module.exports = { registerFileOpsHandlers };
