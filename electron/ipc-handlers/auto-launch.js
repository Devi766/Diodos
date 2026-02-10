'use strict';

/**
 * Auto-launch IPC handlers and utility functions
 * Manages system login item settings for auto-start on boot.
 */

const { app } = require('electron');

function setAutoLaunch(enabled) {
  try {
    if (process.platform === 'win32') {
      app.setLoginItemSettings({
        openAtLogin: enabled,
        path: process.execPath,
        args: []
      });

      console.log(`开机启动状态已${enabled ? '启用' : '禁用'}`);
      return true;
    } else if (process.platform === 'darwin') {
      app.setLoginItemSettings({
        openAtLogin: enabled,
        openAsHidden: false
      });

      console.log(`macOS开机启动状态已${enabled ? '启用' : '禁用'}`);
      return true;
    } else {
      console.warn('当前平台不支持设置开机启动');
      return false;
    }
  } catch (error) {
    console.error('设置开机启动失败:', error);
    return false;
  }
}

function getAutoLaunchState() {
  try {
    const settings = app.getLoginItemSettings();
    return settings.openAtLogin;
  } catch (error) {
    console.error('获取开机启动状态失败:', error);
    return false;
  }
}

module.exports = { setAutoLaunch, getAutoLaunchState };
