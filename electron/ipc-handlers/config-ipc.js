'use strict';

const { ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const yaml = require('js-yaml');

/**
 * Register kernel/DNS/sniffer configuration IPC handlers.
 *
 * Covers: get/save-kernel-config, get/save-dns-config,
 *         get/save-sniffer-config, save-hosts-config.
 *
 * @param {object} deps
 */
function registerConfigIpcHandlers(deps) {
  const { context, userDataPath } = deps;

  // =====================================================================
  // Helper: save config section and optionally restart service
  // =====================================================================
  async function saveConfigAndRestart(sectionName, currentSettings, newSettings) {
    if (context.updateUserSettingsRaw) {
      try {
        await context.updateUserSettingsRaw(newSettings);
        console.log(`[save-${sectionName}] User settings saved successfully`);
      } catch (saveError) {
        console.error(`[save-${sectionName}] Failed to save user settings:`, saveError);
        throw new Error('Failed to save user settings: ' + saveError.message);
      }
    } else {
      console.error(`[save-${sectionName}] updateUserSettingsRaw not available`);
      throw new Error('updateUserSettingsRaw not available');
    }

    // Restart Mihomo service to apply new config
    if (context.mihomoService && typeof context.mihomoService.restartMihomoService === 'function') {
      try {
        console.log(`[save-${sectionName}] Restarting service...`);
        const restartResult = await context.mihomoService.restartMihomoService();
        console.log(`[save-${sectionName}] Service restart result:`, restartResult);
        return {
          success: true,
          restarted: restartResult.success,
          message: restartResult.success
            ? `${sectionName} config saved and applied`
            : `${sectionName} config saved, but restart failed`,
        };
      } catch (restartError) {
        console.error(`[save-${sectionName}] Restart failed:`, restartError);
        return {
          success: true,
          restarted: false,
          message: `${sectionName} config saved, but restart failed: ${restartError.message}`,
        };
      }
    } else {
      console.warn(`[save-${sectionName}] mihomoService unavailable, cannot restart`);
      return {
        success: true,
        restarted: false,
        message: `${sectionName} config saved, but manual restart required`,
      };
    }
  }

  // =====================================================================
  // Kernel config
  // =====================================================================

  // Kernel config fields that live at the top level of a mihomo YAML
  const kernelFields = [
    'ipv6', 'log-level', 'mixed-port', 'allow-lan',
    'lan-allowed-ips', 'lan-disallowed-ips',
    'external-controller', 'secret', 'authentication', 'skip-auth-prefixes',
    'unified-delay', 'tcp-concurrent', 'disable-keep-alive',
    'keep-alive-idle', 'keep-alive-interval',
    'global-client-fingerprint', 'find-process-mode', 'interface-name', 'profile',
  ];

  ipcMain.handle('get-kernel-config', (event, configPath) => {
    try {
      let source;
      if (configPath && fs.existsSync(configPath)) {
        console.log('[get-kernel-config] Reading from subscription YAML:', configPath);
        const content = fs.readFileSync(configPath, 'utf8');
        source = yaml.load(content) || {};
      } else {
        console.log('[get-kernel-config] Reading from user settings');
        source = context.getUserSettings ? context.getUserSettings() : {};
      }

      const config = {};
      for (const key of kernelFields) {
        if (source[key] !== undefined) config[key] = source[key];
      }

      return { success: true, config };
    } catch (error) {
      console.error('Failed to get kernel config:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('save-kernel-config', async (event, kernelConfig, configPath) => {
    try {
      console.log('[save-kernel-config] ========== Saving kernel config ==========');

      if (configPath && fs.existsSync(configPath)) {
        // Write directly to subscription YAML file
        console.log('[save-kernel-config] Writing to subscription YAML:', configPath);
        const content = fs.readFileSync(configPath, 'utf8');
        const config = yaml.load(content) || {};

        for (const key of kernelFields) {
          if (kernelConfig[key] !== undefined && kernelConfig[key] !== '') {
            config[key] = kernelConfig[key];
          } else {
            delete config[key];
          }
        }

        fs.writeFileSync(configPath, yaml.dump(config, { lineWidth: -1 }), 'utf8');
        return { success: true, restarted: false, message: 'kernel config saved to YAML' };
      }

      // Fallback: save to user settings (no configPath)
      const currentSettings = context.getUserSettings ? context.getUserSettings() : {};

      const filteredConfig = { ...kernelConfig };
      if (filteredConfig['external-controller'] === '') {
        delete filteredConfig['external-controller'];
      }

      const newSettings = { ...currentSettings, ...filteredConfig };
      return await saveConfigAndRestart('kernel', currentSettings, newSettings);
    } catch (error) {
      console.error('[save-kernel-config] ========== Failed ==========');
      console.error('[save-kernel-config] Error:', error);
      return { success: false, error: error.message };
    }
  });

  // =====================================================================
  // DNS config
  // =====================================================================

  const defaultDnsConfig = {
    enable: true,
    ipv6: false,
    'enhanced-mode': 'fake-ip',
    'fake-ip-range': '198.18.0.1/16',
    'fake-ip-filter': [
      '*.lan', '*.local', 'localhost.ptlogin2.qq.com',
      '+.srv.nintendo.net', '+.stun.playstation.net',
      'xbox.*.microsoft.com', '+.xboxlive.com',
    ],
    'use-hosts': false,
    'use-system-hosts': true,
    'respect-rules': false,
    'default-nameserver': ['114.114.114.114', '223.5.5.5', '8.8.8.8'],
    nameserver: ['https://doh.pub/dns-query', 'https://dns.alidns.com/dns-query'],
    'proxy-server-nameserver': ['https://doh.pub/dns-query'],
    'direct-nameserver': ['https://doh.pub/dns-query', 'https://dns.alidns.com/dns-query'],
  };

  ipcMain.handle('get-dns-config', (event, configPath) => {
    try {
      let dnsConfig;
      let hosts = {};

      if (configPath && fs.existsSync(configPath)) {
        console.log('[get-dns-config] Reading from subscription YAML:', configPath);
        const content = fs.readFileSync(configPath, 'utf8');
        const config = yaml.load(content) || {};
        dnsConfig = config.dns;
        hosts = config.hosts || {};
      } else {
        const userSettings = context.getUserSettings ? context.getUserSettings() : {};
        dnsConfig = userSettings.dns;
        hosts = userSettings.hosts || {};
      }

      if (!dnsConfig || Object.keys(dnsConfig).length === 0) {
        console.log('[get-dns-config] No DNS config found, applying defaults');
        dnsConfig = defaultDnsConfig;
      }

      return { success: true, config: dnsConfig, hosts };
    } catch (error) {
      console.error('Failed to get DNS config:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('save-dns-config', async (event, dnsConfig, configPath) => {
    try {
      console.log('[save-dns-config] ========== Saving DNS config ==========');

      if (configPath && fs.existsSync(configPath)) {
        // Write directly to subscription YAML file
        console.log('[save-dns-config] Writing to subscription YAML:', configPath);
        const content = fs.readFileSync(configPath, 'utf8');
        const config = yaml.load(content) || {};
        config.dns = dnsConfig;
        fs.writeFileSync(configPath, yaml.dump(config, { lineWidth: -1 }), 'utf8');
        return { success: true, restarted: false, message: 'dns config saved to YAML' };
      }

      // Fallback: save to user settings (no configPath)
      const currentSettings = context.getUserSettings ? context.getUserSettings() : {};
      const newSettings = { ...currentSettings, dns: dnsConfig };
      return await saveConfigAndRestart('dns', currentSettings, newSettings);
    } catch (error) {
      console.error('[save-dns-config] ========== Failed ==========');
      console.error('[save-dns-config] Error:', error);
      return { success: false, error: error.message };
    }
  });

  // =====================================================================
  // Hosts config
  // =====================================================================

  ipcMain.handle('save-hosts-config', (event, hosts) => {
    try {
      const configPath = path.join(userDataPath, 'config.yaml');
      let config = {};

      if (fs.existsSync(configPath)) {
        const configContent = fs.readFileSync(configPath, 'utf8');
        config = yaml.load(configContent);
      }

      const hostsObject = {};
      hosts.forEach(({ domain, value }) => {
        hostsObject[domain] = value;
      });

      config.hosts = hostsObject;
      fs.writeFileSync(configPath, yaml.dump(config), 'utf8');

      return { success: true };
    } catch (error) {
      console.error('Failed to save hosts config:', error);
      return { success: false, error: error.message };
    }
  });

  // =====================================================================
  // Sniffer config
  // =====================================================================

  const defaultSnifferConfig = {
    enable: true,
    'parse-pure-ip': true,
    'force-dns-mapping': true,
    'override-destination': false,
    sniff: {
      HTTP: { ports: [80, 443], 'override-destination': false },
      TLS: { ports: [443] },
    },
    'skip-domain': ['+.push.apple.com'],
    'skip-dst-address': [
      '91.105.192.0/23', '91.108.4.0/22', '91.108.8.0/21',
      '91.108.16.0/21', '91.108.56.0/22', '95.161.64.0/20',
      '149.154.160.0/20', '185.76.151.0/24',
      '2001:67c:4e8::/48', '2001:b28:f23c::/47',
      '2001:b28:f23f::/48', '2a0a:f280:203::/48',
    ],
  };

  ipcMain.handle('get-sniffer-config', () => {
    try {
      const userSettings = context.getUserSettings ? context.getUserSettings() : {};
      let snifferConfig = userSettings.sniffer;

      if (!snifferConfig || Object.keys(snifferConfig).length === 0) {
        console.log('[get-sniffer-config] New user detected, applying default sniffer config');
        snifferConfig = defaultSnifferConfig;
      }

      return { success: true, config: snifferConfig };
    } catch (error) {
      console.error('Failed to get sniffer config:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('save-sniffer-config', async (event, snifferConfig) => {
    try {
      console.log('[save-sniffer-config] ========== Saving sniffer config ==========');
      const currentSettings = context.getUserSettings ? context.getUserSettings() : {};
      const newSettings = { ...currentSettings, sniffer: snifferConfig };
      return await saveConfigAndRestart('sniffer', currentSettings, newSettings);
    } catch (error) {
      console.error('[save-sniffer-config] ========== Failed ==========');
      console.error('[save-sniffer-config] Error:', error);
      return { success: false, error: error.message };
    }
  });

  // =====================================================================
  // Proxy Groups config (read/write subscription YAML directly)
  // =====================================================================

  ipcMain.handle('get-proxy-groups-config', (event, configPath) => {
    try {
      if (!configPath || !fs.existsSync(configPath)) {
        return { success: false, error: 'Config file not found' };
      }
      const content = fs.readFileSync(configPath, 'utf8');
      const config = yaml.load(content) || {};
      return { success: true, groups: config['proxy-groups'] || [] };
    } catch (error) {
      console.error('[get-proxy-groups-config] Error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('save-proxy-groups-config', (event, groups, configPath) => {
    try {
      if (!configPath || !fs.existsSync(configPath)) {
        return { success: false, error: 'Config file not found' };
      }
      const content = fs.readFileSync(configPath, 'utf8');
      const config = yaml.load(content) || {};
      config['proxy-groups'] = groups;
      fs.writeFileSync(configPath, yaml.dump(config, { lineWidth: -1 }), 'utf8');
      return { success: true };
    } catch (error) {
      console.error('[save-proxy-groups-config] Error:', error);
      return { success: false, error: error.message };
    }
  });

  // =====================================================================
  // Rules config (read/write subscription YAML directly)
  // =====================================================================

  ipcMain.handle('get-rules-config', (event, configPath) => {
    try {
      if (!configPath || !fs.existsSync(configPath)) {
        return { success: false, error: 'Config file not found' };
      }
      const content = fs.readFileSync(configPath, 'utf8');
      const config = yaml.load(content) || {};
      return { success: true, rules: config.rules || [] };
    } catch (error) {
      console.error('[get-rules-config] Error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('save-rules-config', (event, rules, configPath) => {
    try {
      if (!configPath || !fs.existsSync(configPath)) {
        return { success: false, error: 'Config file not found' };
      }
      const content = fs.readFileSync(configPath, 'utf8');
      const config = yaml.load(content) || {};
      config.rules = rules;
      fs.writeFileSync(configPath, yaml.dump(config, { lineWidth: -1 }), 'utf8');
      return { success: true };
    } catch (error) {
      console.error('[save-rules-config] Error:', error);
      return { success: false, error: error.message };
    }
  });

  // =====================================================================
  // Providers config (read/write subscription YAML directly)
  // =====================================================================

  ipcMain.handle('get-providers-config', (event, configPath) => {
    try {
      if (!configPath || !fs.existsSync(configPath)) {
        return { success: false, error: 'Config file not found' };
      }
      const content = fs.readFileSync(configPath, 'utf8');
      const config = yaml.load(content) || {};
      return {
        success: true,
        proxyProviders: config['proxy-providers'] || {},
        ruleProviders: config['rule-providers'] || {},
      };
    } catch (error) {
      console.error('[get-providers-config] Error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('save-providers-config', (event, proxyProviders, ruleProviders, configPath) => {
    try {
      if (!configPath || !fs.existsSync(configPath)) {
        return { success: false, error: 'Config file not found' };
      }
      const content = fs.readFileSync(configPath, 'utf8');
      const config = yaml.load(content) || {};
      config['proxy-providers'] = proxyProviders;
      config['rule-providers'] = ruleProviders;
      fs.writeFileSync(configPath, yaml.dump(config, { lineWidth: -1 }), 'utf8');
      return { success: true };
    } catch (error) {
      console.error('[save-providers-config] Error:', error);
      return { success: false, error: error.message };
    }
  });

  // =====================================================================
  // Proxies config (read/write subscription YAML directly)
  // =====================================================================

  ipcMain.handle('get-proxies-config', (event, configPath) => {
    try {
      if (!configPath || !fs.existsSync(configPath)) {
        return { success: false, error: 'Config file not found' };
      }
      const content = fs.readFileSync(configPath, 'utf8');
      const config = yaml.load(content) || {};
      return { success: true, proxies: config.proxies || [] };
    } catch (error) {
      console.error('[get-proxies-config] Error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('save-proxies-config', (event, proxies, configPath) => {
    try {
      if (!configPath || !fs.existsSync(configPath)) {
        return { success: false, error: 'Config file not found' };
      }
      const content = fs.readFileSync(configPath, 'utf8');
      const config = yaml.load(content) || {};
      config.proxies = proxies;
      fs.writeFileSync(configPath, yaml.dump(config, { lineWidth: -1 }), 'utf8');
      return { success: true };
    } catch (error) {
      console.error('[save-proxies-config] Error:', error);
      return { success: false, error: error.message };
    }
  });
}

module.exports = { registerConfigIpcHandlers };
