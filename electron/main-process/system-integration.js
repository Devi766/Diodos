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

  // 安全向渲染进程发送消息，避免在窗口销毁后触发异常
  function safeSend(channel, ...args) {
    try {
      const win = state.mainWindow;
      if (!win || win.isDestroyed()) return false;
      const wc = win.webContents;
      if (!wc || wc.isDestroyed()) return false;
      wc.send(channel, ...args);
      return true;
    } catch (e) {
      console.warn('[system-integration] safeSend failed:', e && e.message ? e.message : e);
      return false;
    }
  }

  // macOS: 检查是否存在活跃的 utun 设备（mihomo TUN）
  function isTunActive() {
    try {
      if (process.platform !== 'darwin') return false;
      const { execSync } = require('child_process');
      const out = execSync('/sbin/ifconfig -l', { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      // 只要存在任意 utunX 即认为 TUN 已启动
      return /\butun\d+\b/.test(out);
    } catch {
      return false;
    }
  }

  // 等待 TUN 接口状态到目标值，带超时
  async function waitForTunActive(expected, timeoutMs = 4000) {
    const start = Date.now();
    const interval = 200;
    while (Date.now() - start < timeoutMs) {
      const active = isTunActive();
      if (active === expected) return true;
      await new Promise((r) => setTimeout(r, interval));
    }
    return false;
  }

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
        safeSend('proxy-status', true);
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
        safeSend('proxy-status', false);
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

      safeSend('proxy-status', state.systemProxyEnabled);
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
    const targetEnabled = Boolean(menuItem.checked);
    console.log(`[toggleTunMode] Target state: ${targetEnabled ? 'enabled' : 'disabled'}`);
    try {
      const tun = context.tunManager || require('./tun-manager')(context);
      const res = await tun.toggleTun(targetEnabled);
      if (!res?.success) {
        console.warn('[toggleTunMode] toggle failed:', res?.error);
        menuItem.checked = false;
        state.tunModeEnabled = false;
        const setTunModeEnabled = context.setTunModeEnabled;
        if (setTunModeEnabled) setTunModeEnabled(false);
        safeSend('tun-status', false);
        if (res?.error) dialog.showErrorBox('TUN 模式错误', String(res.error));
        return;
      }
      state.tunModeEnabled = targetEnabled;
      const setTunModeEnabled = context.setTunModeEnabled;
      if (setTunModeEnabled) setTunModeEnabled(targetEnabled);
      safeSend('tun-status', targetEnabled);
    } catch (error) {
      console.error('[toggleTunMode] Failed:', error);
      menuItem.checked = false;
      state.tunModeEnabled = false;
      try { context.setTunModeEnabled?.(false); } catch {}
      safeSend('tun-status', false);
      dialog.showErrorBox('TUN 模式错误', `设置 TUN 模式失败: ${error.message}`);
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
      const tun = context.tunManager || require('./tun-manager')(context);
      return await tun.grantPermissions({ preferCustom: true });
    } catch (error) {
      console.error('[grantCorePermission] Failed:', error);
      return { success: false, error: error.message };
    }
  }

  async function checkCorePermission() {
    try {
      const tun = context.tunManager || require('./tun-manager')(context);
      return await tun.checkPermission();
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
    revokeCorePermission,
    isTunActive
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
  context.isTunActive = isTunActive;
};
