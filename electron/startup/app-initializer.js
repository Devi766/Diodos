const { app, BrowserWindow, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

/**
 * 应用初始化模块
 *
 * 封装 app.whenReady() 中的初始化逻辑，包括：
 * - Windows 权限初始化
 * - 协议处理器注册
 * - 主题/外观/TUN 状态恢复
 * - 托盘/订阅调度器/转换器启动
 *
 * @param {Object} deps - 依赖注入
 */
async function initializeApp(deps) {
  const {
    context,
    state,
    dbManager,
    userDataPath,
    createWindow,
    handleProtocolUrl,
    getTunModeEnabled,
    ensureUserSettingsFile,
    ensureMihomoDataFiles,
    subscriptionScheduler,
  } = deps;

  // ---- 1. Windows 权限初始化 ----
  if (context.needsPermissionInit && process.platform === 'win32') {
    const PermissionManager = require('../main-process/permission-manager');
    const permissionManager = new PermissionManager();

    context.checkElevateTask = permissionManager.checkElevateTask.bind(permissionManager);
    context.deleteElevateTask = permissionManager.deleteElevateTask.bind(permissionManager);
    context.permissionManager = permissionManager;

    const tunElevationMode = context.dbManager?.getSetting('tun_elevation_mode', 'service') || 'service';
    console.log('[Startup] TUN elevation mode:', tunElevationMode);
    console.log('[Startup] Checking admin privileges...');

    const hasAdminPrivileges =
      typeof permissionManager.checkAdminPrivilegesSync === 'function'
        ? permissionManager.checkAdminPrivilegesSync()
        : false;

    context.hasAdminPrivileges = hasAdminPrivileges;
    if (hasAdminPrivileges) {
      console.log('[Startup] Current process has admin privileges');
      if (tunElevationMode === 'task') {
        try {
          permissionManager.createElevateTaskSync();
          console.log('[Startup] Elevated task created/updated successfully');
        } catch (error) {
          console.error('[Startup] Task creation failed:', error.message);
        }
      } else {
        console.log('[Startup] Service mode enabled, skipping task creation');
      }
    } else {
      console.log('[Startup] Current process does NOT have admin privileges');
      const taskExists = permissionManager.checkElevateTaskSync();
      if (taskExists) {
        console.log('[Startup] Found existing elevated task');
      } else {
        console.log('[Startup] No elevated task found');
        console.log('[Startup] User needs to grant TUN permissions manually');
      }
    }

    console.log('[Startup] Permission init complete, admin status:', hasAdminPrivileges ? 'YES' : 'NO');
  }

  // ---- 2. 清理轻量模式遗留进程 ----
  if (context.lightweightModeManager) {
    try {
      await context.lightweightModeManager.cleanupLightweightProcess();
      console.log('[Startup] Lightweight mode cleanup complete');
    } catch (error) {
      console.error('[Startup] Lightweight mode cleanup failed:', error);
    }
  }

  // ---- 3. 注册协议处理器 (Windows) ----
  if (process.platform === 'win32') {
    app.setAsDefaultProtocolClient('clash');
    app.setAsDefaultProtocolClient('flyclash');
    console.log('已注册协议处理器: clash://, flyclash://');
    console.log('启动参数:', process.argv);

    const gotTheLock = app.requestSingleInstanceLock();
    if (!gotTheLock) {
      console.log('已有实例运行，退出当前实例');
      app.quit();
      return;
    }

    let foundProtocolArg = false;
    for (const arg of process.argv) {
      if (arg.includes('clash://') ||
          arg.includes('flyclash://') ||
          arg.includes('?url=')) {
        console.log('检测到可能的协议URL参数:', arg);
        foundProtocolArg = true;
        handleProtocolUrl(arg);
      }
    }
    if (!foundProtocolArg) {
      console.log('启动参数中未找到协议URL');
    }
  }
  // ---- 4. 创建窗口 ----
  createWindow();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // ---- 5. 加载主题设置 ----
  try {
    const theme = dbManager.getSetting('theme', 'system');
    nativeTheme.themeSource = theme;
    console.log('已加载主题设置:', theme);
  } catch (error) {
    console.error('加载主题设置失败:', error);
  }

  // ---- 6. 确保用户设置文件存在 ----
  ensureUserSettingsFile();

  // ---- 7. 确保 mihomo 数据文件存在 ----
  ensureMihomoDataFiles().then(() => {
    console.log('mihomo数据文件初始化完成');
  }).catch(error => {
    console.error('mihomo数据文件初始化失败:', error);
  });

  // ---- 8. 加载上次使用的配置 ----
  try {
    const lastConfigPath = path.join(userDataPath, 'last-config.json');
    if (fs.existsSync(lastConfigPath)) {
      const lastConfigData = JSON.parse(fs.readFileSync(lastConfigPath, 'utf8'));
      if (lastConfigData && lastConfigData.path) {
        state.preferredConfig = lastConfigData.path;
        console.log('已加载上次使用的配置:', state.preferredConfig);
      }
    }
  } catch (error) {
    console.error('加载上次使用的配置失败:', error);
  }

  // ---- 9. 检查系统代理状态 ----
  try {
    if (process.platform === 'win32') {
      const result = execSync('reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable').toString();
      state.systemProxyEnabled = result.includes('0x1');

      if (state.systemProxyEnabled) {
        const serverResult = execSync('reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer').toString();
        if (serverResult.includes('127.0.0.1:')) {
          console.log('系统代理已启用:', serverResult);
        } else {
          console.log('系统代理已启用，但使用的不是我们的设置:', serverResult);
        }
      } else {
        console.log('系统代理未启用');
      }
    }
  } catch (error) {
    console.error('检查系统代理状态失败:', error);
  }
  // ---- 10. 读取外观设置 ----
  try {
    const storedAppearance = dbManager.getSetting('appearanceMode', 'dynamic');
    if (storedAppearance) {
      state.appearanceMode = storedAppearance;
    }
  } catch (error) {
    console.warn('读取外观设置失败，将使用默认值:', error?.message || error);
    state.appearanceMode = 'dynamic';
  }

  // ---- 11. 检查 TUN 模式状态 ----
  try {
    const savedState = getTunModeEnabled();
    console.log('[TUN] 数据库保存的状态:', savedState ? '已启用' : '未启用');
    state.tunModeEnabled = savedState;
    console.log('[TUN] 启动状态:', state.tunModeEnabled ? '已启用' : '未启用');

    // 检查待处理的 TUN 启用请求
    const pendingTunEnable = dbManager.getSetting('pendingTunEnable', false);
    if (pendingTunEnable) {
      console.log('[TUN] 检测到待处理的 TUN 启用请求');
      dbManager.deleteSetting('pendingTunEnable');
      try {
        const PermissionManager = require('../main-process/permission-manager');
        const pm = new PermissionManager();
        const isAdmin = typeof pm.checkAdminPrivilegesSync === 'function'
          ? pm.checkAdminPrivilegesSync()
          : false;
        if (isAdmin) {
          console.log('[TUN] 当前进程已具备管理员权限，请在界面中重新开启 TUN 模式');
        } else {
          console.warn('[TUN] 当前进程仍未获得管理员权限，TUN 模式无法自动启用');
        }
      } catch (e) {
        console.warn('[TUN] 检查管理员权限失败:', e?.message || e);
      }
    }

    // 检查待处理的服务安装请求
    const pendingServiceInstall = dbManager.getSetting('pendingServiceInstall', false);
    if (pendingServiceInstall) {
      console.log('[Service] 检测到待处理的服务安装请求');
      dbManager.deleteSetting('pendingServiceInstall');
      try {
        const PermissionManager = require('../main-process/permission-manager');
        const pm = new PermissionManager();
        const isAdmin = typeof pm.checkAdminPrivilegesSync === 'function'
          ? pm.checkAdminPrivilegesSync()
          : false;
        if (isAdmin && context.tunManager && typeof context.tunManager.installService === 'function') {
          console.log('[Service] 当前为管理员环境，尝试自动安装 TUN 服务');
          const result = await context.tunManager.installService();
          console.log('[Service] 自动安装服务结果:', result);
        } else if (!isAdmin) {
          console.warn('[Service] 当前进程仍未获得管理员权限，无法自动安装服务');
        } else {
          console.warn('[Service] TUN 管理器不可用，无法自动安装服务');
        }
      } catch (e) {
        console.error('[Service] 自动安装服务失败:', e?.message || e);
      }
    }
    // 检查待处理的服务卸载请求
    const pendingServiceUninstall = dbManager.getSetting('pendingServiceUninstall', false);
    if (pendingServiceUninstall) {
      console.log('[Service] 检测到待处理的服务卸载请求');
      dbManager.deleteSetting('pendingServiceUninstall');
      try {
        const PermissionManager = require('../main-process/permission-manager');
        const pm = new PermissionManager();
        const isAdmin = typeof pm.checkAdminPrivilegesSync === 'function'
          ? pm.checkAdminPrivilegesSync()
          : false;
        if (isAdmin && context.tunManager && typeof context.tunManager.uninstallService === 'function') {
          console.log('[Service] 当前为管理员环境，尝试自动卸载 TUN 服务');
          const result = await context.tunManager.uninstallService();
          console.log('[Service] 自动卸载服务结果:', result);
        } else if (!isAdmin) {
          console.warn('[Service] 当前进程仍未获得管理员权限，无法自动卸载服务');
        } else {
          console.warn('[Service] TUN 管理器不可用，无法自动卸载服务');
        }
      } catch (e) {
        console.error('[Service] 自动卸载服务失败:', e?.message || e);
      }
    }
  } catch (error) {
    console.error('检查TUN模式状态失败:', error);
  }

  // ---- 12. 广播 TUN 状态 ----
  try {
    if (state.mainWindow && !state.mainWindow.isDestroyed()) {
      state.mainWindow.webContents.send('tun-status', state.tunModeEnabled);
    }
  } catch (broadcastError) {
    console.warn('[TUN] 初始化状态广播失败:', broadcastError?.message || broadcastError);
  }

  // ---- 13. 初始化托盘 ----
  context.trayManager.ensureTray()
    .then(() => context.trayManager.updateTrayMenu())
    .catch((error) => {
      console.error('初始化托盘失败:', error);
    });

  // ---- 14. 启动订阅调度器 ----
  subscriptionScheduler.start();

  // ---- 15. 自动启动转换器服务器 ----
  setTimeout(async () => {
    try {
      const settingsFile = path.join(app.getPath('userData'), 'converter-settings.json');
      if (fs.existsSync(settingsFile)) {
        const data = fs.readFileSync(settingsFile, 'utf-8');
        const settings = JSON.parse(data);
        if (settings.autoStart) {
          console.log('[Startup] 自动启动转换器服务器...');
          const { getServer } = require('../ipc-handlers/converter');
          const server = getServer(app);
          try {
            await server.start();
            console.log('[Startup] 转换器服务器自动启动成功');
          } catch (error) {
            console.error('[Startup] 转换器服务器自动启动失败:', error);
          }
        }
      }
    } catch (error) {
      console.error('[Startup] 检查转换器自动启动设置失败:', error);
    }
  }, 1000);
}

module.exports = { initializeApp };
