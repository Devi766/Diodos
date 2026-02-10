'use strict';

const { ipcMain, nativeTheme } = require('electron');

/**
 * Register settings-related IPC handlers.
 *
 * Covers: theme, silent-start, generic get/set-setting,
 *         get-proxy-settings, save-ua-settings, auto-start toggle,
 *         get-app-version, open-external.
 *
 * @param {object} deps
 */
function registerSettingsIpcHandlers(deps) {
  const {
    state,
    dbManager,
    security,
    verifyAuthToken,
    updateUserSettingsRaw,
    getUserSettings,
    APP_VERSION,
    app,
    shell,
  } = deps;

  // --- Theme -----------------------------------------------------------

  ipcMain.handle('set-theme', (event, theme) => {
    try {
      console.log('Setting theme:', theme);
      if (!state.mainWindow || state.mainWindow.isDestroyed()) {
        return { success: false, error: 'Window does not exist' };
      }

      dbManager.setSetting('theme', theme);

      switch (theme) {
        case 'light':
          nativeTheme.themeSource = 'light';
          state.mainWindow.webContents.send('theme-changed', 'light');
          break;
        case 'dark':
          nativeTheme.themeSource = 'dark';
          state.mainWindow.webContents.send('theme-changed', 'dark');
          break;
        case 'system':
        default:
          nativeTheme.themeSource = 'system';
          state.mainWindow.webContents.send('theme-changed', nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
          break;
      }

      // Update title bar overlay colour (macOS only when enabled)
      try {
        if (state.mainWindow.setTitleBarOverlay) {
          state.mainWindow.setTitleBarOverlay({
            color: nativeTheme.shouldUseDarkColors ? '#1a1a1a' : '#f9f9f9',
            symbolColor: nativeTheme.shouldUseDarkColors ? '#f3f4f6' : '#000000',
            height: 48,
          });
        }
      } catch (overlayError) {
        console.log('Title bar overlay update failed (may not be enabled):', overlayError.message);
      }

      return { success: true, theme };
    } catch (error) {
      console.error('Failed to set theme:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('get-theme', () => {
    try {
      const theme = dbManager.getSetting('theme', 'system');
      return { success: true, theme };
    } catch (error) {
      console.error('Failed to get theme:', error);
      return { success: false, theme: 'system', error: error.message };
    }
  });

  // --- Silent start ----------------------------------------------------

  ipcMain.handle('get-silent-start', () => {
    try {
      const silentStart = dbManager.getSetting('silentStart', false);
      return { success: true, silentStart };
    } catch (error) {
      console.error('Failed to get silent start setting:', error);
      return { success: false, silentStart: false, error: error.message };
    }
  });

  ipcMain.handle('set-silent-start', (event, enabled) => {
    try {
      dbManager.setSetting('silentStart', Boolean(enabled));
      console.log('Silent start setting updated:', enabled);
      return { success: true };
    } catch (error) {
      console.error('Failed to set silent start:', error);
      return { success: false, error: error.message };
    }
  });

  // --- Generic setting get/set -----------------------------------------

  ipcMain.handle('get-setting', (event, key, defaultValue = null) => {
    try {
      const value = dbManager.getSetting(key, defaultValue);
      return { success: true, value };
    } catch (error) {
      console.error(`Failed to get setting [${key}]:`, error);
      return { success: false, value: defaultValue, error: error.message };
    }
  });

  ipcMain.handle('set-setting', (event, key, value) => {
    try {
      dbManager.setSetting(key, value);
      console.log(`Setting saved [${key}]`);
      return { success: true };
    } catch (error) {
      console.error(`Failed to save setting [${key}]:`, error);
      return { success: false, error: error.message };
    }
  });

  // --- Proxy settings --------------------------------------------------

  ipcMain.handle('get-proxy-settings', async () => {
    try {
      const settings = getUserSettings();
      return { success: true, settings };
    } catch (error) {
      console.error('Failed to get proxy settings:', error);
      return { success: false, error: error.message };
    }
  });

  // Save subscription User-Agent only (no service restart)
  ipcMain.handle('save-ua-settings', async (_event, uaKey) => {
    try {
      const allowedUAs = security?.ALLOWED_USERAGENTS
        ? Object.keys(security.ALLOWED_USERAGENTS)
        : [];
      const normalizedKey = typeof uaKey === 'string' ? uaKey.trim() : '';

      if (!normalizedKey) {
        return { success: false, error: 'Invalid User-Agent option' };
      }

      if (allowedUAs.length && !allowedUAs.includes(normalizedKey)) {
        return { success: false, error: 'Unsupported User-Agent option' };
      }

      if (typeof updateUserSettingsRaw === 'function') {
        await updateUserSettingsRaw({ 'subscription-ua': normalizedKey });
      } else {
        dbManager?.setSetting?.('subscription-ua', normalizedKey);
      }

      return { success: true, message: 'User-Agent updated' };
    } catch (error) {
      console.error('Failed to save User-Agent setting:', error);
      return { success: false, error: error?.message || String(error) };
    }
  });

  // --- Auto-start (mihomo) ---------------------------------------------

  ipcMain.handle('set-auto-start', (event, enabled) => {
    state.autoStartEnabled = enabled;
    return true;
  });

  ipcMain.handle('get-auto-start', () => {
    return state.autoStartEnabled;
  });

  // --- App version -----------------------------------------------------

  ipcMain.handle('get-app-version', () => {
    try {
      return typeof app.getVersion === 'function' ? app.getVersion() : APP_VERSION;
    } catch (error) {
      console.warn('Failed to get app version:', error?.message || error);
      return APP_VERSION;
    }
  });

  // --- Open external link ----------------------------------------------

  ipcMain.handle('open-external', async (event, url) => {
    try {
      if (!url || typeof url !== 'string') {
        throw new Error('Invalid URL');
      }
      await shell.openExternal(url);
      return { success: true };
    } catch (error) {
      console.error('Failed to open external link:', error);
      return { success: false, error: error.message };
    }
  });
}

module.exports = { registerSettingsIpcHandlers };
