'use strict';

const { BrowserWindow, nativeTheme, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

/**
 * Create and manage the main application window.
 *
 * @param {object} deps
 * @returns {{ createWindow: Function }}
 */
function createWindowManager(deps) {
  const {
    state,
    context,
    dbManager,
    configDir,
    isWindows,
    isMac,
    isDev,
    enableAcrylic,
    applyMacOSBackdrop,
    refreshWindowsBackdrop,
    applyCustomBackground,
    autoStartMihomo,
    scheduleStartupUpdateCheck,
    stopTrafficStatsUpdate,
    startTrafficStatsUpdate,
    updateTrafficStats,
    loadPageWithServer,
  } = deps;

  const windowStatePath = path.join(configDir, 'window-state.json');

  // --- Window state persistence ----------------------------------------

  function loadWindowState() {
    try {
      if (!fs.existsSync(windowStatePath)) return null;
      const raw = fs.readFileSync(windowStatePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      const { x, y, width, height, isMaximized } = parsed;
      if (typeof width !== 'number' || typeof height !== 'number') return null;
      return {
        x: typeof x === 'number' ? x : undefined,
        y: typeof y === 'number' ? y : undefined,
        width,
        height,
        isMaximized: !!isMaximized,
      };
    } catch (e) {
      console.warn('[WindowState] Failed to load window state:', e?.message || e);
      return null;
    }
  }

  function saveWindowState(win) {
    if (!win || win.isDestroyed?.()) return;
    try {
      const bounds = win.getBounds();
      const data = {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        isMaximized: win.isMaximized(),
      };
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(windowStatePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (e) {
      console.warn('[WindowState] Failed to save window state:', e?.message || e);
    }
  }

  // --- createWindow ----------------------------------------------------

  function createWindow() {
    const savedState = loadWindowState() || {};

    state.mainWindow = new BrowserWindow({
      width: savedState.width || 1000,
      height: savedState.height || 700,
      x: typeof savedState.x === 'number' ? savedState.x : undefined,
      y: typeof savedState.y === 'number' ? savedState.y : undefined,
      minWidth: 800,
      minHeight: 600,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        webgl: true,
        enableWebSQL: false,
        backgroundThrottling: false,
      },
      show: false,
      frame: false,
      titleBarStyle: isWindows ? 'hidden' : 'hiddenInset',
      transparent: true,
      backgroundColor: '#00000000',
      backgroundMaterial: isWindows ? 'mica' : undefined,
      visualEffectState: isMac ? 'active' : undefined,
      titleBarOverlay: isMac
        ? {
            color: nativeTheme.shouldUseDarkColors ? '#1a1a1a' : '#f9f9f9',
            symbolColor: nativeTheme.shouldUseDarkColors ? '#f3f4f6' : '#000000',
            height: 48,
          }
        : undefined,
    });

    state.mainWindow.setBackgroundColor('#00000000');

    const notifyWindowState = () => {
      if (!state.mainWindow || state.mainWindow.isDestroyed?.()) return;
      try {
        const maximized = state.mainWindow.isMaximized();
        const fullScreen =
          typeof state.mainWindow.isFullScreen === 'function'
            ? state.mainWindow.isFullScreen()
            : false;
        state.mainWindow.webContents.send('window-state-changed', { maximized, fullScreen });
      } catch (e) {
        console.warn('[WindowState] Failed to notify window state:', e?.message || e);
      }
    };

    // Apply platform-specific backdrop effects
    if (isMac) {
      applyMacOSBackdrop(state.mainWindow);
    } else if (isWindows) {
      refreshWindowsBackdrop(state.mainWindow, 0);
    }

    // Listen for system theme changes
    nativeTheme.on('updated', () => {
      if (isMac) {
        applyMacOSBackdrop(state.mainWindow);
      }

      if (isWindows) {
        refreshWindowsBackdrop(state.mainWindow, 0);
        try {
          const rgba = (alpha, r, g, b) =>
            ((alpha & 0xff) << 24) | ((b & 0xff) << 16) | ((g & 0xff) << 8) | (r & 0xff);
          const isDark = nativeTheme.shouldUseDarkColors;
          const tint = isDark ? rgba(0xdc, 24, 32, 68) : rgba(0x66, 255, 255, 255);
          enableAcrylic(state.mainWindow, { tintColor: tint, accentFlags: 2 });
        } catch {}
      }

      const currentTheme = dbManager.getSetting('theme', 'system');
      if (currentTheme === 'system' && state.mainWindow && !state.mainWindow.isDestroyed()) {
        const actualTheme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
        console.log('System theme changed, current:', actualTheme);
        state.mainWindow.webContents.send('theme-changed', actualTheme);
      }
    });

    // Window state persistence (debounced)
    let saveWindowStateTimer = null;
    const scheduleSaveWindowState = () => {
      if (!state.mainWindow) return;
      if (saveWindowStateTimer) clearTimeout(saveWindowStateTimer);
      saveWindowStateTimer = setTimeout(() => {
        if (state.mainWindow && !state.mainWindow.isDestroyed?.()) {
          saveWindowState(state.mainWindow);
        }
      }, 300);
    };

    state.mainWindow.on('resize', scheduleSaveWindowState);
    state.mainWindow.on('move', scheduleSaveWindowState);
    state.mainWindow.on('maximize', scheduleSaveWindowState);
    state.mainWindow.on('unmaximize', scheduleSaveWindowState);
    state.mainWindow.on('close', scheduleSaveWindowState);

    state.mainWindow.on('maximize', notifyWindowState);
    state.mainWindow.on('unmaximize', notifyWindowState);
    state.mainWindow.on('enter-full-screen', notifyWindowState);
    state.mainWindow.on('leave-full-screen', notifyWindowState);

    if (savedState.isMaximized) {
      state.mainWindow.maximize();
    }

    // Load page
    if (isDev) {
      state.mainWindow.loadURL('http://localhost:3000');
    } else {
      loadPageWithServer('');
    }

    state.mainWindow.webContents.on('dom-ready', () => {
      if (isMac) {
        applyMacOSBackdrop(state.mainWindow);
      } else if (isWindows) {
        refreshWindowsBackdrop(state.mainWindow, 0);
      }
    });

    state.mainWindow.webContents.on('did-finish-load', () => {
      if (isMac) {
        applyMacOSBackdrop(state.mainWindow);
      } else if (isWindows) {
        refreshWindowsBackdrop(state.mainWindow, 1);
      }
      if (!isDev) {
        try {
          const cssDir = path.join(__dirname, '../../out/_next/static/css');
          const cssFiles = fs.readdirSync(cssDir);
          if (cssFiles.length > 0) {
            const cssContent = fs.readFileSync(path.join(cssDir, cssFiles[0]), 'utf8');
            state.mainWindow.webContents
              .insertCSS(cssContent)
              .catch((err) => console.error('Failed to inject CSS:', err));
          }
        } catch (error) {
          console.error('CSS injection error:', error);
        }
      }
    });

    // Page navigation handler
    ipcMain.handle('loadPage', async (event, pageName) => {
      try {
        console.log(`Switching to page: ${pageName}`);
        if (isDev) {
          await state.mainWindow.loadURL(`http://localhost:3000/${pageName}`);
          return { success: true };
        }
        await loadPageWithServer(pageName);
        return { success: true };
      } catch (error) {
        console.error('Failed to load page:', error);
        return { success: false, error: error.message };
      }
    });

    if (isDev) {
      state.mainWindow.webContents.openDevTools();
    }

    state.mainWindow.once('ready-to-show', () => {
      const silentStart = dbManager.getSetting('silentStart', false);
      if (!silentStart) {
        state.mainWindow.show();
        refreshWindowsBackdrop(state.mainWindow, 1);
      } else {
        console.log('Silent start mode: window not shown');
      }

      try {
        const currentTheme =
          nativeTheme.themeSource === 'system'
            ? nativeTheme.shouldUseDarkColors
              ? 'dark'
              : 'light'
            : nativeTheme.themeSource;
        state.mainWindow.webContents.send('theme-changed', currentTheme);
      } catch (error) {
        console.error('Failed to notify theme state:', error);
      }

      console.log('[main.js] ready-to-show: state.autoStartEnabled =', state.autoStartEnabled);
      if (state.autoStartEnabled) {
        console.log('[main.js] ready-to-show: will call autoStartMihomo in 1 second');
        setTimeout(autoStartMihomo, 1000);
      }
    });

    state.mainWindow.on('close', (event) => {
      if (!state.isQuitting) {
        event.preventDefault();
        state.mainWindow.hide();
        if (context.lightweightModeManager) {
          context.lightweightModeManager.startAutoLightweightTimer();
        }
      }
    });

    state.mainWindow.on('show', () => {
      refreshWindowsBackdrop(state.mainWindow, 0);
      if (context.lightweightModeManager) {
        context.lightweightModeManager.cancelAutoLightweightTimer();
      }
    });

    state.mainWindow.on('focus', () => {
      refreshWindowsBackdrop(state.mainWindow, 1);
    });

    scheduleStartupUpdateCheck();

    state.mainWindow.on('minimize', () => {
      console.log('[Debug] Window minimized, reducing update frequency');
      stopTrafficStatsUpdate();
      state.trafficStatsInterval = setInterval(() => {
        updateTrafficStats();
      }, 10000);

      if (context.lightweightModeManager) {
        context.lightweightModeManager.startAutoLightweightTimer();
      }
    });

    state.mainWindow.on('restore', () => {
      console.log('[Debug] Window restored, resuming normal update frequency');
      stopTrafficStatsUpdate();
      startTrafficStatsUpdate();

      if (context.lightweightModeManager) {
        context.lightweightModeManager.cancelAutoLightweightTimer();
      }
    });
  }

  return { createWindow };
}

module.exports = { createWindowManager };
