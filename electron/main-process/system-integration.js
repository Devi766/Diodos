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
    const targetEnabled = menuItem.checked;
    console.log(`[toggleTunMode] Target state: ${targetEnabled ? 'enabled' : 'disabled'}`);

    try {
      const tunConfig = buildTunConfig(targetEnabled, dbManager);

      const updateUserSettingsRaw = context.updateUserSettingsRaw;
      if (!updateUserSettingsRaw) {
        throw new Error('Update settings function not available');
      }

      console.log('[toggleTunMode] Saving TUN config...');
      // 先保存配置，但不要急于更新状态，待重启结果确认
      updateUserSettingsRaw({ tun: tunConfig });

      if (!state.mihomoProcess || !state.configFilePath) {
        console.warn('[toggleTunMode] Mihomo not running, config saved only');
        // 仅在未运行时，直接反映目标状态（下次启动生效）
        safeSend('tun-status', targetEnabled);
        return;
      }

      console.log('[toggleTunMode] Restarting Mihomo to apply TUN config...');
      const restartMihomo = context.mihomoService?.restartMihomo;
      if (!restartMihomo) {
        throw new Error('Restart function not available');
      }

      // 在 macOS/Linux 上，启用前再次确认权限
      if (targetEnabled && process.platform !== 'win32') {
        try {
          const perm = await permissionManager.checkCorePermission();
          if (!perm) {
            console.warn('[toggleTunMode] Permission missing on Unix, abort enabling');
            dialog.showErrorBox('TUN 模式错误', '缺少内核权限，请在 TUN 设置页面先授权。');
            // 回滚配置为禁用
            updateUserSettingsRaw({ tun: { enable: false } });
            safeSend('tun-status', false);
            return;
          }
        } catch {}
      }

      const success = await restartMihomo(state.configFilePath);

      if (success) {
        console.log('[toggleTunMode] Mihomo restarted successfully');
        // 重启成功后再更新状态，但需确认内核未回退禁用 TUN
        // 并检测实际 utun 接口是否就绪
        try {
          const getSettings = context.getUserSettings || (() => ({}));
          const current = getSettings() || {};
          const actuallyEnabled = !!current?.tun?.enable;
          if (!actuallyEnabled && targetEnabled) {
            console.warn('[toggleTunMode] Kernel reported TUN disabled after restart');
            state.tunModeEnabled = false;
            const setTunModeEnabled = context.setTunModeEnabled;
            if (setTunModeEnabled) setTunModeEnabled(false);
            safeSend('tun-status', false);
            return;
          }
          if (process.platform === 'darwin') {
            const ok = await waitForTunActive(targetEnabled, 5000);
            if (!ok) {
              console.warn('[toggleTunMode] utun did not reach expected state, rolling back');
              updateUserSettingsRaw({ tun: { enable: false } });
              const setTunModeEnabled = context.setTunModeEnabled;
              if (setTunModeEnabled) setTunModeEnabled(false);
              state.tunModeEnabled = false;
              safeSend('tun-status', false);
              dialog.showErrorBox('TUN 模式未生效', '未检测到 utun 接口，请确认权限已正确授予（或在设置页重新授权）。');
              return;
            }
          }
        } catch {}

        const setTunModeEnabled = context.setTunModeEnabled;
        if (setTunModeEnabled) {
          setTunModeEnabled(targetEnabled);
        }
        state.tunModeEnabled = targetEnabled;
        safeSend('tun-status', state.tunModeEnabled);
      } else {
        console.warn('[toggleTunMode] Mihomo restart failed, rolling back tun flag');
        // 回滚配置为禁用，避免前端误判
        updateUserSettingsRaw({ tun: { enable: false } });
        const setTunModeEnabled = context.setTunModeEnabled;
        if (setTunModeEnabled) {
          setTunModeEnabled(false);
        }
        state.tunModeEnabled = false;
        safeSend('tun-status', false);
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

      safeSend('tun-status', state.tunModeEnabled);
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
        const { execFile, exec } = require('child_process');
        const execFilePromise = promisify(execFile);
        const execPromise = promisify(exec);
        const shEscape = (s) => String(s).replace(/([\\`"$])/g, '\\$1').replace(/ /g, '\\ ');

        // 将内核安装到系统位置，避免每次更新或 App Translocation 造成路径变化
        const targetDir = '/Library/Application Support/FlyClash';
        const targetPath = `${targetDir}/mihomo`;
        const escSrc = shEscape(corePath);
        const escDir = shEscape(targetDir);
        const escDst = shEscape(targetPath);

        // 使用 AppleScript 申请管理员权限后执行安装与授权，并去除隔离标记
        const script = `do shell script "mkdir -p ${escDir} && cp -f ${escSrc} ${escDst} && xattr -d com.apple.quarantine ${escDst} || true && chown root:wheel ${escDst} && chmod u+s ${escDst}" with administrator privileges`;
        await execFilePromise('osascript', ['-e', script]);

        // 将内核路径固定为系统路径，避免后续再次授权
        try {
          if (typeof context.saveKernelPreference === 'function') {
            context.saveKernelPreference({ customPath: targetPath });
          }
        } catch (e) {
          console.warn('[grantCorePermission] Failed to save kernel preference:', e?.message || e);
        }

        // 验证权限是否生效
        try {
          const { stdout } = await execPromise(`ls -l "${targetPath}"`);
          const perm = stdout.trim().split(/\s+/)[0] || '';
          if (!/[sS]/.test(perm)) {
            return { success: false, error: '权限设置未生效，请重试或手动运行命令：\n\n' +
              `sudo mkdir -p \"${targetDir}\" && sudo cp -f \"${corePath}\" \"${targetPath}\" && sudo chown root:wheel \"${targetPath}\" && sudo chmod u+s \"${targetPath}\"` };
          }
        } catch {}
        return { success: true, message: '已安装到系统路径并授权' };
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
