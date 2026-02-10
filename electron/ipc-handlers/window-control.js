'use strict';

/**
 * Window control IPC handlers
 * Handles minimize, maximize, get-state, and close window operations.
 */

const { ipcMain } = require('electron');

/**
 * Register window control IPC handlers.
 * @param {object} deps
 * @param {object} deps.state - Shared application state
 */
function registerWindowControlHandlers({ state }) {

  ipcMain.handle('window-minimize', () => {
    if (state.mainWindow) {
      state.mainWindow.minimize();
      return { success: true };
    }
    return { success: false };
  });

  ipcMain.handle('window-toggle-maximize', () => {
    if (!state.mainWindow) {
      return { success: false };
    }

    if (state.mainWindow.isMaximized()) {
      state.mainWindow.restore();
      return { success: true, maximized: false };
    }

    state.mainWindow.maximize();
    return { success: true, maximized: true };
  });

  ipcMain.handle('window-get-state', () => {
    if (!state.mainWindow) {
      return { success: false };
    }

    const maximized = state.mainWindow.isMaximized();
    const fullScreen =
      typeof state.mainWindow.isFullScreen === 'function'
        ? state.mainWindow.isFullScreen()
        : false;

    return {
      success: true,
      maximized,
      fullScreen,
    };
  });

  ipcMain.handle('window-close', () => {
    if (state.mainWindow) {
      state.mainWindow.close();
      return { success: true };
    }
    return { success: false };
  });
}

module.exports = { registerWindowControlHandlers };
