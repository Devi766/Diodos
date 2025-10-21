module.exports = function initSystemIntegration(context) {
  const {
    dialog,
    execSync,
    fs,
    path,
    state,
    userDataPath,
    dbManager
  } = context;

  function ensureUpdateSettingsFn() {
    return context.updateUserSettings || context.updateUserSettingsRaw;
  }

  function toggleSystemProxy(menuItem) {
    if (!state.mihomoProcess) {
      dialog.showErrorBox('错误', '请先启动代理服务');
      return;
    }

    try {
      const getSettings = context.getUserSettings || (() => ({}));
      const userSettings = getSettings();
      const port = userSettings['mixed-port'] || 7890;

      if (menuItem.checked) {
        console.log('启用系统代理，端口:', port);
        if (process.platform === 'win32') {
          execSync('reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 1 /f');
          execSync(`reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer /t REG_SZ /d "127.0.0.1:${port}" /f`);
          process.env.HTTP_PROXY = `http://127.0.0.1:${port}`;
          process.env.HTTPS_PROXY = `http://127.0.0.1:${port}`;
        } else if (process.platform === 'darwin') {
          const services = execSync('networksetup -listallnetworkservices').toString().split('\n');
          for (let i = 1; i < services.length; i++) {
            const service = services[i].trim();
            if (service && !service.includes('*')) {
              execSync(`networksetup -setwebproxy "${service}" 127.0.0.1 ${port}`);
              execSync(`networksetup -setsecurewebproxy "${service}" 127.0.0.1 ${port}`);
              execSync(`networksetup -setsocksfirewallproxy "${service}" 127.0.0.1 ${port}`);
            }
          }
        }

        state.systemProxyEnabled = true;
        dbManager.setSetting('systemProxyEnabled', true);
        state.mainWindow?.webContents.send('proxy-status', true);
      } else {
        console.log('禁用系统代理');
        if (process.platform === 'win32') {
          execSync('reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 0 /f');
          delete process.env.HTTP_PROXY;
          delete process.env.HTTPS_PROXY;
        } else if (process.platform === 'darwin') {
          const services = execSync('networksetup -listallnetworkservices').toString().split('\n');
          for (let i = 1; i < services.length; i++) {
            const service = services[i].trim();
            if (service && !service.includes('*')) {
              execSync(`networksetup -setwebproxystate "${service}" off`);
              execSync(`networksetup -setsecurewebproxystate "${service}" off`);
              execSync(`networksetup -setsocksfirewallproxystate "${service}" off`);
            }
          }
        }

        state.systemProxyEnabled = false;
        dbManager.setSetting('systemProxyEnabled', false);
        state.mainWindow?.webContents.send('proxy-status', false);
      }
    } catch (error) {
      console.error('设置系统代理失败:', error);
      dialog.showErrorBox('系统代理错误', `设置系统代理失败: ${error.message}`);

      menuItem.checked = !menuItem.checked;
      state.systemProxyEnabled = !menuItem.checked;

      try {
        dbManager.setSetting('systemProxyEnabled', state.systemProxyEnabled);
      } catch (saveError) {
        console.error('保存代理状态失败:', saveError);
      }

      state.mainWindow?.webContents.send('proxy-status', state.systemProxyEnabled);
    }
  }

  function enableSystemProxy() {
    toggleSystemProxy({ checked: true });
  }

  function disableSystemProxy() {
    toggleSystemProxy({ checked: false });
  }

  function updateSystemProxyIfEnabled() {
    if (!state.systemProxyEnabled) {
      return;
    }

    try {
      const getSettings = context.getUserSettings || (() => ({}));
      const userSettings = getSettings();
      const port = userSettings['mixed-port'] || 7890;

      console.log('更新系统代理设置，使用新端口:', port);

      if (process.platform === 'win32') {
        execSync('reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 1 /f');
        execSync(`reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer /t REG_SZ /d "127.0.0.1:${port}" /f`);
        process.env.HTTP_PROXY = `http://127.0.0.1:${port}`;
        process.env.HTTPS_PROXY = `http://127.0.0.1:${port}`;
      } else if (process.platform === 'darwin') {
        const services = execSync('networksetup -listallnetworkservices').toString().split('\n');
        for (let i = 1; i < services.length; i++) {
          const service = services[i].trim();
          if (service && !service.includes('*')) {
            execSync(`networksetup -setwebproxy "${service}" 127.0.0.1 ${port}`);
            execSync(`networksetup -setsecurewebproxy "${service}" 127.0.0.1 ${port}`);
            execSync(`networksetup -setsocksfirewallproxy "${service}" 127.0.0.1 ${port}`);
          }
        }
      }

      console.log('系统代理设置已更新');
    } catch (error) {
      console.error('更新系统代理设置失败:', error);
      dialog.showErrorBox('系统代理错误', `更新系统代理设置失败: ${error.message}`);
    }
  }

  function toggleTunMode(menuItem) {
    if (!state.mihomoProcess) {
      dialog.showErrorBox('错误', '请先启动代理服务');
      return;
    }

    try {
      const getSettings = context.getUserSettings || (() => ({}));
      const userSettings = getSettings();

      if (!userSettings.tun || typeof userSettings.tun !== 'object') {
        userSettings.tun = {};
      }

      userSettings.tun.enable = menuItem.checked;

      if (menuItem.checked) {
        userSettings.tun = {
          ...userSettings.tun,
          enable: true,
          stack: 'system',
          'auto-route': true,
          'auto-detect-interface': true,
          'dns-hijack': ['any:53']
        };
        console.log('启用TUN模式，配置:', userSettings.tun);
      } else {
        userSettings.tun.enable = false;
        console.log('禁用TUN模式');
      }

      const updater = ensureUpdateSettingsFn();
      if (updater && updater(userSettings)) {
        state.tunModeEnabled = menuItem.checked;
        dbManager.setSetting('tunModeEnabled', state.tunModeEnabled);
        state.mainWindow?.webContents.send('tun-status', state.tunModeEnabled);
      }
    } catch (error) {
      console.error('设置TUN模式失败:', error);
      dialog.showErrorBox('TUN模式错误', `设置TUN模式失败: ${error.message}`);

      menuItem.checked = !menuItem.checked;
      state.tunModeEnabled = !menuItem.checked;

      try {
        dbManager.setSetting('tunModeEnabled', state.tunModeEnabled);
      } catch (saveError) {
        console.error('保存TUN模式状态失败:', saveError);
      }

      state.mainWindow?.webContents.send('tun-status', state.tunModeEnabled);
    }
  }

  context.systemIntegration = {
    toggleSystemProxy,
    enableSystemProxy,
    disableSystemProxy,
    updateSystemProxyIfEnabled,
    toggleTunMode
  };

  context.toggleSystemProxy = toggleSystemProxy;
  context.enableSystemProxy = enableSystemProxy;
  context.disableSystemProxy = disableSystemProxy;
  context.updateSystemProxyIfEnabled = updateSystemProxyIfEnabled;
  context.toggleTunMode = toggleTunMode;
};
