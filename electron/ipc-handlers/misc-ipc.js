'use strict';

const { ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

/**
 * Register miscellaneous IPC handlers.
 *
 * Covers: favorite nodes, collapsed groups, save logs,
 *         system proxy toggle/status, connections management,
 *         save-last-config, auto-launch, save-proxy-settings,
 *         get-icon-dataurl, open-tools-app, media streaming test,
 *         mihomo start/stop/restart/reload, get-api-config,
 *         request-mihomo-api.
 *
 * @param {object} deps
 */
function registerMiscIpcHandlers(deps) {
  const {
    state,
    context,
    dbManager,
    security,
    verifyAuthToken,
    userDataPath,
    isDev,
    fetchMihomoAPI,
    toggleSystemProxy,
    updateSystemProxyIfEnabled,
    updateUserSettings,
    startMihomo,
    stopMihomo,
    restartMihomoService,
    reloadMihomoConfig,
    startTrafficStatsUpdate,
    stopTrafficStatsUpdate,
    stopConnectionsWebSocket,
    stopMihomoLogs,
    fetchConnectionsInfo,
    getIconDataURL,
    testMediaStreaming,
    setAutoLaunch,
    getAutoLaunchState,
    shell,
    app,
  } = deps;

  // --- Favorite nodes --------------------------------------------------

  ipcMain.handle('get-favorite-nodes', () => {
    try {
      const favoritesPath = path.join(userDataPath, 'favorites.json');
      if (!fs.existsSync(favoritesPath)) {
        return { success: true, nodes: [] };
      }
      const favoritesData = JSON.parse(fs.readFileSync(favoritesPath, 'utf8'));
      return { success: true, nodes: favoritesData };
    } catch (error) {
      console.error('Failed to get favorite nodes:', error);
      return { success: false, nodes: [], error: error.message };
    }
  });

  ipcMain.handle('save-favorite-nodes', (event, nodes) => {
    try {
      if (!Array.isArray(nodes)) {
        throw new Error('Invalid node data format');
      }
      const favoritesPath = path.join(userDataPath, 'favorites.json');
      fs.writeFileSync(favoritesPath, JSON.stringify(nodes), 'utf8');
      return { success: true };
    } catch (error) {
      console.error('Failed to save favorite nodes:', error);
      return { success: false, error: error.message };
    }
  });

  // --- Collapsed groups ------------------------------------------------

  ipcMain.handle('get-collapsed-groups', () => {
    try {
      const collapsedPath = path.join(userDataPath, 'collapsed-groups.json');
      if (!fs.existsSync(collapsedPath)) {
        return { success: true, groups: [] };
      }
      const collapsedData = JSON.parse(fs.readFileSync(collapsedPath, 'utf8'));
      return { success: true, groups: collapsedData };
    } catch (error) {
      console.error('Failed to get collapsed groups:', error);
      return { success: false, groups: [], error: error.message };
    }
  });

  ipcMain.handle('save-collapsed-groups', (event, groups) => {
    try {
      if (!Array.isArray(groups)) {
        throw new Error('Invalid group data format');
      }
      const collapsedPath = path.join(userDataPath, 'collapsed-groups.json');
      fs.writeFileSync(collapsedPath, JSON.stringify(groups), 'utf8');
      return { success: true };
    } catch (error) {
      console.error('Failed to save collapsed groups:', error);
      return { success: false, error: error.message };
    }
  });

  // --- Save logs -------------------------------------------------------

  ipcMain.handle('save-logs', (event, logEntries) => {
    try {
      const logsDir = path.join(userDataPath, 'logs');
      if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
      }

      const date = new Date();
      const fileName = `mihomo-logs-${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}-${String(date.getHours()).padStart(2, '0')}-${String(date.getMinutes()).padStart(2, '0')}.txt`;
      const filePath = path.join(logsDir, fileName);

      const logContent = logEntries
        .map((entry) => {
          const timestamp = new Date(entry.timestamp).toLocaleString();
          const type = entry.type === 'error' ? '[ERROR]' : '[INFO]';
          return `${timestamp} ${type} ${entry.content}`;
        })
        .join('\n');

      fs.writeFileSync(filePath, logContent, 'utf8');
      console.log(`Logs saved to: ${filePath}`);

      return { success: true, filePath };
    } catch (error) {
      console.error('Failed to save logs:', error);
      return { success: false, error: error.message };
    }
  });

  // --- System proxy ----------------------------------------------------

  ipcMain.handle('toggleSystemProxy', async (event, token, enabled) => {
    try {
      if (!verifyAuthToken(token)) {
        security?.logSecurityEvent?.('invalid-token', { action: 'toggleSystemProxy' });
        return { success: false, error: 'Security check failed, please retry' };
      }

      const menuItem = { checked: Boolean(enabled) };
      toggleSystemProxy(menuItem);

      return { success: true, enabled: state.systemProxyEnabled };
    } catch (error) {
      console.error('Failed to toggle system proxy:', error);
      return { success: false, error: error?.message || String(error) };
    }
  });

  ipcMain.handle('getProxyStatus', async () => {
    return state.systemProxyEnabled;
  });

  // --- Connections management ------------------------------------------

  ipcMain.handle('get-connections', async () => {
    try {
      const response = await fetch('http://127.0.0.1:9090/connections');
      if (response.ok) {
        const data = await response.json();
        return data;
      } else {
        console.error('Failed to get connections:', response.status, response.statusText);
        return null;
      }
    } catch (error) {
      console.error('Failed to get connections:', error);
      return null;
    }
  });

  ipcMain.handle('close-connection', async (event, connectionId) => {
    try {
      const response = await fetch(`http://127.0.0.1:9090/connections/${connectionId}`, {
        method: 'DELETE',
      });
      return response.ok;
    } catch (error) {
      console.error('Failed to close connection:', error);
      return false;
    }
  });

  ipcMain.handle('close-all-connections', async () => {
    try {
      const response = await fetch('http://127.0.0.1:9090/connections', {
        method: 'DELETE',
      });
      return response.ok;
    } catch (error) {
      console.error('Failed to close all connections:', error);
      return false;
    }
  });

  ipcMain.on('connections-update', (event, data) => {
    if (state.mainWindow) {
      const connections = data.connections || [];
      const activeConnections = connections.filter((conn) => conn.isActive !== false).length;

      state.mainWindow.webContents.send('connections-update', {
        connections,
        downloadTotal: data.downloadTotal || 0,
        uploadTotal: data.uploadTotal || 0,
        currentNode: state.currentNode,
        activeConnections,
      });
    }
  });

  ipcMain.on('node-changed', (event, data) => {
    if (state.mainWindow) {
      if (data && data.nodeName) {
        state.currentNode = data.nodeName;
      }

      state.mainWindow.webContents.send('node-changed', {
        nodeName: data && data.nodeName ? data.nodeName : state.currentNode || 'None',
      });

      const connections = state.lastConnectionsInfo.connections || [];
      const activeConnections = connections.filter((conn) => conn.isActive !== false).length;

      state.mainWindow.webContents.send('connections-update', {
        ...state.lastConnectionsInfo,
        currentNode: state.currentNode,
        activeConnections,
      });
    }
  });

  ipcMain.handle('fetch-connections-info', async () => {
    return fetchConnectionsInfo();
  });

  // --- Save last config ------------------------------------------------

  ipcMain.handle('save-last-config', (event, configPath) => {
    try {
      if (!configPath) {
        return { success: false, error: 'Invalid config path' };
      }
      const lastConfigPath = path.join(userDataPath, 'last-config.json');
      fs.writeFileSync(lastConfigPath, JSON.stringify({ path: configPath }, null, 2), 'utf8');
      console.log('Last used config saved:', configPath);
      return { success: true };
    } catch (error) {
      console.error('Failed to save last config:', error);
      return { success: false, error: error.message };
    }
  });

  // --- Auto launch -----------------------------------------------------

  ipcMain.handle('get-auto-launch-state', () => {
    return getAutoLaunchState();
  });

  ipcMain.handle('set-auto-launch', (event, enabled) => {
    setAutoLaunch(enabled);
    return true;
  });

  // --- Save proxy settings ---------------------------------------------

  ipcMain.handle('save-proxy-settings', (event, settings) => {
    try {
      console.log('Saving proxy settings:', settings);

      if (!settings || typeof settings !== 'object') {
        return { success: false, error: 'Invalid settings object' };
      }

      if ('mixed-port' in settings) {
        const portValue = Number(settings['mixed-port']);
        if (!Number.isInteger(portValue)) {
          return { success: false, error: 'Port must be a number' };
        }
        if (portValue < 1 || portValue > 65535) {
          return { success: false, error: 'Port must be between 1 and 65535' };
        }
        settings['mixed-port'] = portValue;
      }

      if ('allow-lan' in settings) {
        settings['allow-lan'] = Boolean(settings['allow-lan']);
      }

      if ('ipv6' in settings) {
        settings['ipv6'] = Boolean(settings['ipv6']);
      }

      const success = updateUserSettings(settings);

      if (success) {
        try {
          updateSystemProxyIfEnabled();
        } catch (proxyError) {
          console.error('Failed to update system proxy settings:', proxyError);
        }
      }

      const currentConfig = state.configFilePath;

      if (success && state.mihomoProcess && state.mihomoProcess.pid && currentConfig) {
        console.log('Mihomo is running, will restart to apply new settings');
        try {
          if (state.mihomoProcess) {
            state.mihomoProcess.kill();
            stopTrafficStatsUpdate();
            stopConnectionsWebSocket();
            stopMihomoLogs();
            setTimeout(async () => {
              state.mihomoProcess = null;
              const restarted = await startMihomo(currentConfig);
              console.log('Restart result:', restarted);

              if (restarted) {
                if (state.mainWindow) {
                  state.mainWindow.webContents.send('service-restarted', { success: true });
                }
              } else {
                if (state.mainWindow) {
                  state.mainWindow.webContents.send('service-restarted', {
                    success: false,
                    error: 'Failed to restart service',
                  });
                }
              }
            }, 1000);
          }

          return { success: true, message: 'Settings saved, restarting service...' };
        } catch (restartError) {
          console.error('Error during service restart:', restartError);
          return { success: true, message: 'Settings saved, but restart failed: ' + restartError.message };
        }
      }

      return { success, message: success ? 'Settings saved' : 'Failed to save settings' };
    } catch (error) {
      console.error('Failed to save proxy settings:', error);
      return { success: false, error: `Error saving settings: ${error.message}` };
    }
  });

  // --- Icon data URL ---------------------------------------------------

  ipcMain.handle('get-icon-dataurl', async (event, processPath) => {
    try {
      const iconDataURL = await getIconDataURL(processPath);
      return iconDataURL;
    } catch (error) {
      console.error('Failed to get process icon:', error);
      return '';
    }
  });

  // --- Open tools app --------------------------------------------------

  async function openToolsApp(toolName) {
    try {
      let toolsPath;
      if (isDev) {
        toolsPath = path.join(process.cwd(), 'tools', toolName);
      } else {
        toolsPath = path.join(process.resourcesPath, 'tools', toolName);
      }

      if (!fs.existsSync(toolsPath)) {
        console.error(`Tool file does not exist: ${toolsPath}`);
        return { success: false, error: 'Tool file does not exist' };
      }

      await shell.openPath(toolsPath);
      console.log(`Tool launched: ${toolsPath}`);
      return { success: true };
    } catch (error) {
      console.error('Error launching tool:', error);
      return { success: false, error: error.message || 'Unknown error' };
    }
  }

  ipcMain.handle('open-tools-app', (_, toolName) => openToolsApp(toolName));

  // --- Mihomo start/stop/restart/reload --------------------------------

  ipcMain.handle('start-mihomo', (_, configPath) => startMihomo(configPath));
  ipcMain.handle('stop-mihomo', stopMihomo);
  ipcMain.handle('restart-service', restartMihomoService);
  ipcMain.handle('reload-mihomo-config', (_, configPath) => reloadMihomoConfig(configPath));

  // --- Media streaming test --------------------------------------------

  ipcMain.handle('test-media-streaming', async (event, serviceName, checkUrl) => {
    try {
      console.log(`Received media test request: ${serviceName}, URL: ${checkUrl}`);

      const nameVariants = {
        AbemaTV: ['Abema TV', 'AbemaTV', 'Abema'],
        myTVSuper: ['MyTVSuper', 'myTVSuper', 'mytvsuper', 'My TV Super'],
      };

      for (const [standardName, variants] of Object.entries(nameVariants)) {
        if (variants.includes(serviceName)) {
          console.log(`Service name "${serviceName}" is a variant of "${standardName}"`);
        }
      }

      const result = await testMediaStreaming(serviceName, checkUrl);
      console.log('Media test completed, result:', result);
      return result;
    } catch (error) {
      console.error('Error processing media test request:', error);
      return {
        available: false,
        message: 'Internal error: ' + error.message,
        checkTime: 0,
      };
    }
  });

  // --- API config (socket mode) ----------------------------------------

  ipcMain.handle('get-api-config', (event) => {
    try {
      return {
        success: true,
        socketPath: state.activeApiConfig.socketPath,
        controllerHost: null,
        controllerPort: null,
        secret: '',
      };
    } catch (error) {
      console.error('Failed to get API config:', error);
      return { success: false, error: 'Failed to get API config: ' + error.message };
    }
  });

  // --- Request mihomo API via socket -----------------------------------

  ipcMain.handle('request-mihomo-api', async (event, endpoint, options = {}) => {
    try {
      console.log(`[Socket] IPC handler - API request: ${endpoint}`);
      const response = await fetchMihomoAPI(endpoint, options);
      console.log('[Socket] IPC handler - API request succeeded');

      let data = null;
      try {
        data = await response.json();
      } catch (e) {
        try {
          data = await response.text();
        } catch (e2) {
          data = null;
        }
      }

      return { ok: response.ok, status: response.status, data };
    } catch (error) {
      console.error('[Socket] IPC handler - API request failed:', error);
      return { ok: false, status: 500, data: { error: error.message || 'Request failed' } };
    }
  });
}

module.exports = { registerMiscIpcHandlers };
