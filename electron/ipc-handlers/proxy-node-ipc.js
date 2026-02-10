'use strict';

const { ipcMain } = require('electron');

/**
 * Register proxy-node-related IPC handlers.
 *
 * Covers: select-node, notify-node-changed, get-proxies,
 *         test-node-delay, get-proxy-nodes, get-active-config,
 *         set-preferred-config, is-mihomo-running, get-config-order.
 *
 * @param {object} deps
 */
function registerProxyNodeIpcHandlers(deps) {
  const {
    state,
    context,
    fetchMihomoAPI,
    checkMihomoService,
    parseConfigFile,
    userDataPath,
  } = deps;

  const path = require('path');
  const fs = require('fs');

  // --- Select node -----------------------------------------------------

  ipcMain.handle('select-node', async (event, nodeName, groupName, updateGlobal = false) => {
    try {
      console.log(`Switching node: ${nodeName} in group ${groupName}`);

      if (!groupName) {
        groupName = 'PROXY';
      }

      const response = await fetch(
        `http://127.0.0.1:9090/proxies/${encodeURIComponent(groupName)}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: nodeName }),
        }
      );

      if (!response.ok) {
        throw new Error(`Failed to switch node: ${response.statusText}`);
      }

      console.log(`Successfully switched to node: ${nodeName} in group ${groupName}`);

      if (groupName === 'PROXY' || groupName === 'GLOBAL' || updateGlobal) {
        state.currentNode = nodeName;
        console.log('Updated current node:', state.currentNode);
        context.trayManager.updateTrayMenu();
      }

      return { success: true };
    } catch (error) {
      console.error('Failed to select node:', error);
      return { success: false, error: error.message };
    }
  });

  // --- Notify node changed ---------------------------------------------

  ipcMain.handle('notify-node-changed', async (event, nodeName) => {
    try {
      console.log(`Received node change notification: ${nodeName}`);
      state.currentNode = nodeName;
      context.trayManager.updateTrayMenu();
      return { success: true };
    } catch (error) {
      console.error('Failed to handle node change notification:', error);
      return { success: false, error: error.message };
    }
  });

  // --- Get proxies -----------------------------------------------------

  ipcMain.handle('get-proxies', async (event) => {
    try {
      console.log('[DEBUG] Fetching proxy node info');

      const isServiceRunning = await checkMihomoService();
      if (!isServiceRunning) {
        console.error('[DEBUG] Mihomo service not running');
        throw new Error('Mihomo service not running, please start Mihomo first');
      }

      if (!state.activeApiConfig) {
        console.error('Cannot get proxies: API config unavailable');
        return;
      }

      const response = await fetchMihomoAPI('/proxies');
      if (response.ok) {
        const data = await response.json();
        console.log('[DEBUG] Proxy node info fetched successfully');

        const groups = [];
        let selected = null;

        // Look for PROXY group first
        if (data.proxies && data.proxies['PROXY']) {
          const proxyGroup = data.proxies['PROXY'];
          selected = proxyGroup.now;

          if (proxyGroup.all && proxyGroup.all.length > 0) {
            const nodes = [];
            for (const nodeName of proxyGroup.all) {
              if (data.proxies[nodeName]) {
                const node = data.proxies[nodeName];
                nodes.push({
                  name: nodeName,
                  type: node.type,
                  server: node.server || '',
                  port: node.port || 0,
                  delay: node.delay || undefined,
                });
              }
            }
            groups.push({ name: 'PROXY', type: proxyGroup.type, nodes });
          }
        } else if (data.proxies && data.proxies['GLOBAL']) {
          const globalGroup = data.proxies['GLOBAL'];
          selected = globalGroup.now;

          if (globalGroup.all && globalGroup.all.length > 0) {
            const nodes = [];
            for (const nodeName of globalGroup.all) {
              if (data.proxies[nodeName]) {
                const node = data.proxies[nodeName];
                nodes.push({
                  name: nodeName,
                  type: node.type,
                  server: node.server || '',
                  port: node.port || 0,
                  delay: node.delay || undefined,
                });
              }
            }
            groups.push({ name: 'GLOBAL', type: globalGroup.type, nodes });
          }
        }

        // Extract other selector-type groups
        const isSelectorType = (type) => {
          const normalized = typeof type === 'string' ? type.toLowerCase() : '';
          return ['selector', 'urltest', 'fallback', 'loadbalance', 'smart'].includes(normalized);
        };

        for (const [name, proxy] of Object.entries(data.proxies)) {
          if (!isSelectorType(proxy.type)) continue;
          if (name === 'GLOBAL' || name === 'PROXY') continue;
          if (!proxy.all || proxy.all.length === 0) continue;

          const nodes = [];
          for (const nodeName of proxy.all) {
            if (data.proxies[nodeName]) {
              const node = data.proxies[nodeName];
              nodes.push({
                name: nodeName,
                type: node.type,
                server: node.server || '',
                port: node.port || 0,
                delay: node.delay || undefined,
              });
            }
          }
          groups.push({ name, type: proxy.type, nodes });
        }

        return { groups, selected };
      }
    } catch (error) {
      console.error('[DEBUG] Failed to fetch proxy node info:', error);
      return { groups: [], selected: null };
    }
  });

  // --- Test node delay -------------------------------------------------

  ipcMain.handle('test-node-delay', async (event, nodeName) => {
    try {
      console.log(`[DEBUG] Testing node delay: ${nodeName}`);

      const isServiceRunning = await checkMihomoService();
      if (!isServiceRunning) {
        console.error('[DEBUG] Mihomo service not running, cannot test node delay');
        throw new Error('Mihomo service not running');
      }

      const url = new URL(`http://127.0.0.1:9090/proxies/${encodeURIComponent(nodeName)}/delay`);
      url.searchParams.append('url', 'http://www.gstatic.com/generate_204');
      url.searchParams.append('timeout', '5000');

      console.log(`[DEBUG] Sending delay test request: ${url.toString()}`);
      const response = await fetch(url.toString());

      if (response.ok) {
        const data = await response.json();
        console.log(`[DEBUG] Node ${nodeName} delay result: ${data.delay}ms`);
        return data.delay;
      } else {
        const errorText = await response.text();
        console.error(`[DEBUG] Delay test failed: ${response.status} ${response.statusText} - ${errorText}`);
        return 0;
      }
    } catch (error) {
      console.error('[DEBUG] Error during node delay test:', error);
      return 0;
    }
  });

  // --- Active config / preferred config --------------------------------

  ipcMain.handle('get-active-config', () => {
    return state.preferredConfig || state.configFilePath || null;
  });

  ipcMain.handle('set-preferred-config', (event, configPath) => {
    try {
      state.preferredConfig = configPath;
      const lastConfigPath = path.join(userDataPath, 'last-config.json');
      fs.writeFileSync(lastConfigPath, JSON.stringify({ path: configPath }, null, 2), 'utf8');
      console.log('Preferred config set:', configPath);
      return true;
    } catch (error) {
      console.error('Failed to set preferred config:', error);
      return false;
    }
  });

  // --- Is mihomo running -----------------------------------------------

  ipcMain.handle('is-mihomo-running', async () => {
    const { getRunningMode, RunningMode } = require('../utils/running-mode');
    const currentMode = getRunningMode();

    if (currentMode === RunningMode.NOT_RUNNING) {
      return false;
    }

    try {
      const axios = await context.getAxiosInstance(true);
      if (axios) {
        await axios.get('/version', { timeout: 1000 });
        return true;
      }
    } catch (error) {
      console.log(`[is-mihomo-running] API check failed (mode: ${currentMode}):`, error.message);
      return false;
    }

    if (currentMode === RunningMode.SIDECAR) {
      return !!(state.mihomoProcess && state.mihomoProcess.pid && state.mihomoProcess.exitCode === null);
    }

    return false;
  });

  // --- Get proxy nodes from config file --------------------------------

  ipcMain.handle('get-proxy-nodes', (event, configPath) => {
    try {
      const config = configPath || state.configFilePath;
      if (!config) return null;
      return parseConfigFile(config);
    } catch (error) {
      console.error('Failed to get proxy nodes:', error);
      return null;
    }
  });

  // --- Get config order ------------------------------------------------

  ipcMain.handle('get-config-order', async (event) => {
    try {
      if (!state.configFilePath) {
        return { success: false, error: 'Mihomo not running, no active config file' };
      }

      const configFilename = path.basename(state.configFilePath);
      const overrideConfigFilename = 'override-' + configFilename;
      const mihomoDir = path.join(context.get('userDataPath'), 'mihomo');
      const overrideConfigPath = path.join(mihomoDir, overrideConfigFilename);

      let configPathToUse = overrideConfigPath;
      if (!fs.existsSync(configPathToUse)) {
        configPathToUse = state.configFilePath;
      }

      console.log('[get-config-order] Original config path:', state.configFilePath);
      console.log('[get-config-order] Override config path:', overrideConfigPath);
      console.log('[get-config-order] Actual path used:', configPathToUse);

      const configData = parseConfigFile(configPathToUse);
      if (!configData) {
        return { success: false, error: 'Failed to parse config file' };
      }

      return { success: true, data: configData };
    } catch (error) {
      console.error('Failed to get config order:', error);
      return { success: false, error: `Failed to get config order: ${error.message}` };
    }
  });
}

module.exports = { registerProxyNodeIpcHandlers };
