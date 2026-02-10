'use strict';

const { ipcMain } = require('electron');

/**
 * Register UWP loopback exemption IPC handlers.
 *
 * @param {object} deps
 */
function registerLoopbackIpcHandlers(deps) {
  const loopbackManager = require('../loopback-manager');

  ipcMain.handle('loopback:get-apps', async () => {
    try {
      return await loopbackManager.getAppsWithLoopbackStatus();
    } catch (error) {
      console.error('[IPC] loopback:get-apps failed:', error);
      return { success: false, error: error.message, apps: [], isAdmin: true };
    }
  });

  ipcMain.handle('loopback:save-config', async (_, exemptSids) => {
    try {
      return await loopbackManager.saveLoopbackConfig(exemptSids);
    } catch (error) {
      console.error('[IPC] loopback:save-config failed:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('loopback:add-exemption', async (_, sid) => {
    try {
      return await loopbackManager.addLoopbackExemption(sid);
    } catch (error) {
      console.error('[IPC] loopback:add-exemption failed:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('loopback:remove-exemption', async (_, sid) => {
    try {
      return await loopbackManager.removeLoopbackExemption(sid);
    } catch (error) {
      console.error('[IPC] loopback:remove-exemption failed:', error);
      return { success: false, error: error.message };
    }
  });
}

module.exports = { registerLoopbackIpcHandlers };
