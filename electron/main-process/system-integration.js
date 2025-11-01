const PermissionManager = require('./permission-manager');

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

  const permissionManager = new PermissionManager();

  function ensureUpdateSettingsFn() {
    return context.updateUserSettings || context.updateUserSettingsRaw;
  }

  function toggleSystemProxy(menuItem) {
    if (!state.mihomoProcess) {
      console.warn('[toggleSystemProxy] Mihomo 服务未运行');
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

  async function checkAdminPrivileges() {
    return await permissionManager.checkAdminPrivileges();
  }

  async function checkElevateTask() {
    return await permissionManager.checkElevateTask();
  }

  async function createElevateTask() {
    try {
      return permissionManager.createElevateTask();
    } catch (error) {
      console.error('[createElevateTask] Failed:', error);
      return false;
    }
  }

  async function deleteElevateTask() {
    await permissionManager.deleteElevateTask();
  }

  async function restartWithElevatedTask() {
    return await restartAsAdmin();
  }

  async function restartAsAdmin() {
    if (process.platform !== 'win32') {
      return;
    }

    const { app } = require('electron');
    const { spawn } = require('child_process');

    const exePath = process.execPath;
    const args = process.argv.slice(1).filter(arg => !arg.startsWith('--inspect'));

    console.log('[restartAsAdmin] Preparing to restart as admin');
    console.log('[restartAsAdmin] exePath:', exePath);
    console.log('[restartAsAdmin] args:', args);

    const psCommand = args.length > 0
      ? `Start-Process -FilePath "${exePath}" -ArgumentList "${args.join(' ')}" -Verb RunAs`
      : `Start-Process -FilePath "${exePath}" -Verb RunAs`;

    const child = spawn('powershell.exe', ['-Command', psCommand], {
      detached: true,
      stdio: 'ignore'
    });

    child.unref();

    setTimeout(() => {
      app.quit();
    }, 500);
  }

  async function toggleTunMode(menuItem) {
    const targetEnabled = menuItem.checked;
    console.log(`[toggleTunMode] Target state: ${targetEnabled ? 'enabled' : 'disabled'}`);

    try {
      const tunConfig = buildTunConfig(targetEnabled, dbManager);

      const updateUserSettingsRaw = context.updateUserSettingsRaw;
      if (!updateUserSettingsRaw) {
        throw new Error('Update settings function not available');
      }

      console.log('[toggleTunMode] Saving TUN config...');
      updateUserSettingsRaw({ tun: tunConfig });

      const setTunModeEnabled = context.setTunModeEnabled;
      if (setTunModeEnabled) {
        setTunModeEnabled(targetEnabled);
      }
      state.tunModeEnabled = targetEnabled;

      if (!state.mihomoProcess || !state.configFilePath) {
        console.warn('[toggleTunMode] Mihomo not running, config saved only');
        state.mainWindow?.webContents.send('tun-status', state.tunModeEnabled);
        return;
      }

      console.log('[toggleTunMode] Restarting Mihomo to apply TUN config...');
      const restartMihomo = context.mihomoService?.restartMihomo;
      if (!restartMihomo) {
        throw new Error('Restart function not available');
      }

      const success = await restartMihomo(state.configFilePath);

      if (success) {
        console.log('[toggleTunMode] Mihomo restarted successfully');
        state.mainWindow?.webContents.send('tun-status', state.tunModeEnabled);
      } else {
        console.warn('[toggleTunMode] Mihomo restart failed, but config was saved');
        state.mainWindow?.webContents.send('tun-status', state.tunModeEnabled);
      }
    } catch (error) {
      console.error('[toggleTunMode] Failed to toggle TUN mode:', error);

      dialog.showErrorBox('TUN 模式错误', `设置 TUN 模式失败: ${error.message}`);

      menuItem.checked = !menuItem.checked;
      state.tunModeEnabled = !menuItem.checked;

      try {
        const setTunModeEnabled = context.setTunModeEnabled;
        if (setTunModeEnabled) {
          setTunModeEnabled(state.tunModeEnabled);
        }
      } catch (saveError) {
        console.error('[toggleTunMode] Failed to save TUN mode state:', saveError);
      }

      state.mainWindow?.webContents.send('tun-status', state.tunModeEnabled);
    }
  }

  function buildTunConfig(enabled, dbManager) {
    if (!enabled) {
      return { enable: false };
    }

    const savedTunConfig = dbManager.getSetting('tunConfig', null);

    if (savedTunConfig) {
      const config = {
        enable: true,
        device: savedTunConfig.device,
        stack: savedTunConfig.stack,
        'auto-route': savedTunConfig.autoRoute,
        'auto-redirect': savedTunConfig.autoRedirect,
        'auto-detect-interface': savedTunConfig.autoDetectInterface,
        'dns-hijack': savedTunConfig.dnsHijack,
        'strict-route': savedTunConfig.strictRoute,
        'route-exclude-address': savedTunConfig.routeExcludeAddress,
        mtu: savedTunConfig.mtu
      };

      if (process.platform === 'darwin' && savedTunConfig.autoSetDNS !== undefined) {
        config['auto-set-dns'] = savedTunConfig.autoSetDNS;
      }

      return config;
    } else {
      const config = {
        enable: true,
        device: process.platform === 'darwin' ? 'utun' : 'mihomo',
        stack: 'system',
        'auto-route': true,
        'auto-redirect': false,
        'auto-detect-interface': true,
        'dns-hijack': ['any:53'],
        'strict-route': false,
        'route-exclude-address': [],
        mtu: 1500
      };

      if (process.platform === 'darwin') {
        config['auto-set-dns'] = true;
      }

      return config;
    }
  }

  async function grantCorePermission() {
    try {
      const fsExists = (p) => {
        try { return fs.existsSync(p); } catch { return false; }
      };

      let corePath = null;
      // 1) 优先使用“系统设置 → 内核”里配置的路径
      try {
        if (typeof context.getKernelExecutablePath === 'function') {
          const preferred = context.getKernelExecutablePath();
          if (preferred && fsExists(preferred)) corePath = preferred;
        }
      } catch {}

      // 2) 再尝试 PermissionManager 推断的路径
      if (!corePath) {
        try {
          const guessed = permissionManager.getCorePath();
          if (guessed && fsExists(guessed)) corePath = guessed;
        } catch {}
      }

      // 3) 最后使用运行时实际使用的内核路径
      if (!corePath) {
        const runtime = context.mihomoService?.getKernelPath?.();
        if (runtime && fsExists(runtime)) corePath = runtime;
      }

      if (!corePath || !fsExists(corePath)) {
        const msg = `无法定位内核文件。请在 系统设置 → 内核 中确认路径存在。尝试路径: ${corePath || '未知'}`;
        console.error('[grantCorePermission] Kernel path not found:', corePath);
        return { success: false, error: msg };
      }

      if (process.platform === 'darwin') {
        const { promisify } = require('util');
        const execPromise = promisify(require('child_process').exec);
        const esc = (p) => p.replace(/ /g, '\\ ');
        const shell = `chown root:admin ${esc(corePath)}\nchmod +sx ${esc(corePath)}`;
        const command = `do shell script "${shell}" with administrator privileges`;
        await execPromise(`osascript -e '${command}'`);
        return { success: true };
      }

      if (process.platform === 'linux') {
        const { promisify } = require('util');
        const execFile = promisify(require('child_process').execFile);
        try {
          await execFile('pkexec', ['setcap', 'cap_net_admin,cap_net_bind_service=+eip', corePath]);
        } catch (e) {
          await execFile('pkexec', ['chown', 'root:root', corePath]);
          await execFile('pkexec', ['chmod', '+sx', corePath]);
        }
        return { success: true };
      }

      // Windows 不需要
      return { success: true };
    } catch (error) {
      console.error('[grantCorePermission] Failed:', error);
      return { success: false, error: error.message };
    }
  }

  async function checkCorePermission() {
    try {
      const hasPermission = await permissionManager.checkCorePermission();
      return { success: true, hasPermission };
    } catch (error) {
      console.error('[checkCorePermission] Failed:', error);
      return { success: false, hasPermission: false };
    }
  }

  async function revokeCorePermission() {
    try {
      await permissionManager.revokeCorePermission();
      return { success: true };
    } catch (error) {
      console.error('[revokeCorePermission] Failed:', error);
      return { success: false, error: error.message };
    }
  }

  context.systemIntegration = {
    toggleSystemProxy,
    enableSystemProxy,
    disableSystemProxy,
    updateSystemProxyIfEnabled,
    toggleTunMode,
    checkElevateTask,
    deleteElevateTask,
    grantCorePermission,
    checkCorePermission,
    revokeCorePermission
  };

  context.toggleSystemProxy = toggleSystemProxy;
  context.enableSystemProxy = enableSystemProxy;
  context.disableSystemProxy = disableSystemProxy;
  context.updateSystemProxyIfEnabled = updateSystemProxyIfEnabled;
  context.toggleTunMode = toggleTunMode;
  context.checkElevateTask = checkElevateTask;
  context.deleteElevateTask = deleteElevateTask;
  context.grantCorePermission = grantCorePermission;
  context.checkCorePermission = checkCorePermission;
  context.revokeCorePermission = revokeCorePermission;
};
