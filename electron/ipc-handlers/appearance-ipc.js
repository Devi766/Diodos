'use strict';

const { ipcMain, dialog } = require('electron');
const os = require('os');

/**
 * Register appearance-related IPC handlers.
 *
 * Covers: backdrop detection, appearance mode, custom background,
 *         theme colour.
 *
 * @param {object} deps
 */
function registerAppearanceIpcHandlers(deps) {
  const {
    state,
    dbManager,
    isWindows,
    isMac,
    applyMacOSBackdrop,
    applyWindowsBackdrop,
    refreshWindowsBackdrop,
    applyCustomBackground,
  } = deps;

  // --- Backdrop support detection --------------------------------------

  function supportsAdvancedBackdrop() {
    if (process.platform === 'darwin') return true;
    if (process.platform === 'linux') return false;

    if (process.platform === 'win32') {
      try {
        const release = os.release();
        const parts = release.split('.');
        const major = parseInt(parts[0], 10);
        const build = parseInt(parts[2], 10);
        if (major === 10 && build >= 22000) return true;
        if (major > 10) return true;
        return false;
      } catch (error) {
        console.error('Failed to detect Windows version:', error);
        return false;
      }
    }
    return false;
  }

  ipcMain.handle('supports-advanced-backdrop', () => {
    return { success: true, supported: supportsAdvancedBackdrop() };
  });

  // --- Appearance mode -------------------------------------------------

  ipcMain.handle('get-appearance-mode', () => {
    return { success: true, mode: state.appearanceMode || 'acrylic' };
  });

  ipcMain.handle('set-appearance-mode', (event, mode) => {
    try {
      const allowedModes = ['acrylic', 'dynamic', 'solid', 'custom'];
      if (!allowedModes.includes(mode)) {
        return { success: false, error: 'Unsupported appearance mode' };
      }

      state.appearanceMode = mode;
      dbManager.setSetting('appearanceMode', mode);

      if (state.mainWindow && !state.mainWindow.isDestroyed()) {
        if (mode === 'custom') {
          applyCustomBackground(state.mainWindow);
        } else {
          try {
            state.mainWindow.webContents.send('clear-custom-background');
          } catch {}

          if (isMac) {
            applyMacOSBackdrop(state.mainWindow);
          } else if (isWindows) {
            state.mainWindow[Symbol.for('flyclash.backdropNudgeCount')] = 0;
            applyWindowsBackdrop(state.mainWindow);
            refreshWindowsBackdrop(state.mainWindow, 0);
          }
        }
        try {
          state.mainWindow.webContents.send('appearance-mode-changed', mode);
        } catch {}
      }

      return { success: true, mode };
    } catch (error) {
      console.error('Failed to set appearance mode:', error);
      return { success: false, error: error?.message || String(error) };
    }
  });

  // --- Custom background -----------------------------------------------

  ipcMain.handle('select-background-image', async () => {
    try {
      const result = await dialog.showOpenDialog(state.mainWindow, {
        title: 'Select background image',
        properties: ['openFile'],
        filters: [
          { name: 'Image files', extensions: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'] },
        ],
      });

      if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
        return { success: true, canceled: true };
      }

      return { success: true, path: result.filePaths[0] };
    } catch (error) {
      console.error('Failed to select background image:', error);
      return { success: false, error: error?.message || String(error) };
    }
  });

  ipcMain.handle('set-custom-background', (event, config) => {
    try {
      if (!config || !config.imagePath) {
        return { success: false, error: 'Image path cannot be empty' };
      }

      const opacity = Math.max(0, Math.min(100, config.opacity ?? 80));
      const blur = Math.max(0, Math.min(100, config.blur ?? 10));

      const backgroundConfig = { imagePath: config.imagePath, opacity, blur };
      dbManager.setSetting('customBackground', JSON.stringify(backgroundConfig));

      if (state.appearanceMode === 'custom' && state.mainWindow && !state.mainWindow.isDestroyed()) {
        applyCustomBackground(state.mainWindow);
      }

      return { success: true };
    } catch (error) {
      console.error('Failed to set custom background:', error);
      return { success: false, error: error?.message || String(error) };
    }
  });

  ipcMain.handle('get-custom-background', () => {
    try {
      const configStr = dbManager.getSetting('customBackground', null);
      if (!configStr) {
        return { success: true, config: null };
      }
      const config = JSON.parse(configStr);
      return { success: true, config };
    } catch (error) {
      console.error('Failed to get custom background config:', error);
      return { success: false, error: error?.message || String(error) };
    }
  });

  ipcMain.handle('clear-custom-background', () => {
    try {
      dbManager.setSetting('customBackground', null);

      if (state.appearanceMode === 'custom') {
        state.appearanceMode = 'dynamic';
        dbManager.setSetting('appearanceMode', 'dynamic');

        if (state.mainWindow && !state.mainWindow.isDestroyed()) {
          if (isMac) {
            applyMacOSBackdrop(state.mainWindow);
          } else if (isWindows) {
            applyWindowsBackdrop(state.mainWindow);
          }
        }
      }

      return { success: true };
    } catch (error) {
      console.error('Failed to clear custom background:', error);
      return { success: false, error: error?.message || String(error) };
    }
  });

  // --- Theme colour ----------------------------------------------------

  ipcMain.handle('set-theme-color', (event, color) => {
    try {
      if (!color || typeof color !== 'string') {
        return { success: false, error: 'Invalid colour value' };
      }

      dbManager.setSetting('themeColor', color);
      console.log('Theme colour saved:', color);

      if (state.mainWindow && !state.mainWindow.isDestroyed()) {
        try {
          state.mainWindow.webContents.send('theme-color-changed', color);
        } catch (err) {
          console.error('Failed to send theme colour change notification:', err);
        }
      }

      return { success: true };
    } catch (error) {
      console.error('Failed to set theme colour:', error);
      return { success: false, error: error?.message || String(error) };
    }
  });

  ipcMain.handle('get-theme-color', () => {
    try {
      const color = dbManager.getSetting('themeColor', null);
      return { success: true, color };
    } catch (error) {
      console.error('Failed to get theme colour:', error);
      return { success: false, error: error?.message || String(error) };
    }
  });
}

module.exports = { registerAppearanceIpcHandlers };
