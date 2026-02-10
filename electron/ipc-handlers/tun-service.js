const { ipcMain } = require('electron');

/**
 * 注册 TUN 服务相关的 IPC 处理器
 *
 * 包含：TUN 模式切换、权限管理、服务安装/卸载/启停、TUN 配置等
 *
 * @param {Object} deps - 依赖注入
 * @param {Object} deps.context        - 应用上下文
 * @param {Object} deps.state          - 共享状态
 * @param {Object} deps.dbManager      - 数据库管理器
 * @param {Object} deps.security       - 安全模块
 * @param {Function} deps.verifyAuthToken - 令牌验证函数
 * @param {Function} deps.toggleTunMode   - TUN 模式切换函数
 * @param {boolean} deps.isWindows     - 是否 Windows 平台
 * @param {boolean} deps.isMac         - 是否 macOS 平台
 * @param {boolean} deps.isDev         - 是否开发环境
 */
function registerTunServiceHandlers(deps) {
  const {
    context,
    state,
    dbManager,
    security,
    verifyAuthToken,
    toggleTunMode,
    isWindows,
    isMac,
    isDev,
  } = deps;

  // ---- TUN 模式切换 ----

  ipcMain.handle('toggleTunMode', async (event, token, enabled) => {
    try {
      if (!verifyAuthToken(token)) {
        security?.logSecurityEvent?.('invalid-token', { action: 'toggleTunMode' });
        return { success: false, error: '安全校验失败，请重试' };
      }

      console.log('[IPC toggleTunMode] 收到请求，目标状态:', enabled);
      const menuItem = { checked: Boolean(enabled) };

      const res = await toggleTunMode(menuItem);
      console.log('[IPC toggleTunMode] 操作完成，当前状态:', state.tunModeEnabled, 'result:', res);

      if (!res || !res.success) {
        return { success: false, error: res && res.error ? String(res.error) : '切换 TUN 模式失败' };
      }

      return { success: true, enabled: state.tunModeEnabled };
    } catch (error) {
      console.error('[IPC toggleTunMode] 切换TUN模式失败:', error);
      console.error('[IPC toggleTunMode] 错误堆栈:', error.stack);
      return { success: false, error: error?.message || String(error) };
    }
  });

  // ---- TUN 状态查询 ----

  ipcMain.handle('getTunStatus', async () => {
    try {
      const persisted = typeof context.getTunModeEnabled === 'function'
        ? context.getTunModeEnabled()
        : undefined;
      if (typeof persisted === 'boolean') {
        if (persisted !== state.tunModeEnabled) {
          state.tunModeEnabled = persisted;
        }
        return persisted;
      }
    } catch (error) {
      console.warn('[IPC getTunStatus] 读取持久化状态失败:', error?.message || error);
    }
    return state.tunModeEnabled;
  });

  // ---- 计划任务管理 ----

  ipcMain.handle('check-elevate-task', async () => {
    try {
      if (context.checkElevateTask) {
        return await context.checkElevateTask();
      }
      return false;
    } catch (error) {
      console.error('[check-elevate-task] Error:', error);
      return false;
    }
  });

  ipcMain.handle('delete-elevate-task', async () => {
    try {
      if (context.deleteElevateTask) {
        await context.deleteElevateTask();
        return { success: true };
      }
      return { success: false, error: 'Function not available' };
    } catch (error) {
      console.error('[delete-elevate-task] Error:', error);
      return { success: false, error: error.message };
    }
  });

  // ---- TUN 权限授予 ----

  ipcMain.handle('grant-tun-permissions', async () => {
    try {
      // Windows 平台：创建任务并重启
      if (isWindows) {
        console.log('[TUN] Windows: Processing permission grant request');

        // 开发环境下的特殊处理
        if (isDev) {
          console.log('[TUN] Development mode detected');
          const { dialog } = require('electron');
          dialog.showMessageBoxSync(state.mainWindow, {
            type: 'warning',
            title: 'TUN 模式授权 - 开发环境',
            message: '开发环境下无法自动重启',
            detail: '在开发环境下，请手动以管理员权限运行 npm run electron:dev。\n\n或者使用打包后的应用进行 TUN 模式测试。',
            buttons: ['我知道了'],
            defaultId: 0,
            noLink: true
          });
          return { success: false, error: '开发环境下请手动以管理员权限运行' };
        }

        console.log('[TUN] Creating elevated task and restarting...');

        const permissionManager = context.permissionManager;
        if (!permissionManager) {
          throw new Error('PermissionManager not initialized');
        }

        const { spawn } = require('child_process');
        const path = require('path');
        const fs = require('fs');
        const { app } = require('electron');

        const taskDir = permissionManager.taskDir;
        const taskName = permissionManager.taskName;
        const exePath = permissionManager.getExePath();

        permissionManager.ensureTaskDir();

        try {
          dbManager.setSetting('pendingTunEnable', true);
        } catch (error) {
          console.warn('[TUN] Failed to set pendingTunEnable flag:', error);
        }
        // 生成任务 XML
        const taskFilePath = path.join(taskDir, 'flycast-task.xml');
        const xmlContent = permissionManager.getElevateTaskXml();
        const xmlBuffer = Buffer.concat([
          Buffer.from([0xFF, 0xFE]),
          Buffer.from(xmlContent, 'utf16le')
        ]);
        fs.writeFileSync(taskFilePath, xmlBuffer);

        console.log('[TUN] Task XML created at:', taskFilePath);
        console.log('[TUN] Task name:', taskName);
        console.log('[TUN] Executable path:', exePath);

        const successMarkerPath = path.join(taskDir, 'grant-success.marker');
        if (fs.existsSync(successMarkerPath)) {
          fs.unlinkSync(successMarkerPath);
        }

        const batScriptPath = path.join(taskDir, 'create-task.bat');
        const batScript = `@echo off
chcp 65001 >nul
setlocal enableextensions

echo [TUN] Creating scheduled task...
schtasks.exe /create /tn "${taskName}" /xml "${taskFilePath}" /f
if %errorlevel% neq 0 goto _error

echo [TUN] Starting application with elevated privileges...
schtasks.exe /run /tn "${taskName}"
if %errorlevel% neq 0 goto _error

echo success > "${successMarkerPath.replace(/\\/g, '\\\\')}"
exit /b 0

:_error
exit /b %errorlevel%
`;

        fs.writeFileSync(batScriptPath, batScript, 'utf8');
        console.log('[TUN] Batch script created at:', batScriptPath);
        console.log('[TUN] Requesting admin privileges...');
        // 释放单实例锁
        if (typeof app.hasSingleInstanceLock === 'function' && app.hasSingleInstanceLock()) {
          app.releaseSingleInstanceLock();
          console.log('[TUN] Released single instance lock before elevated restart');
        }

        const escapedBatPathForCmd = batScriptPath.replace(/"/g, '""');
        const psCommand = `Start-Process -FilePath "cmd.exe" -ArgumentList '/c', '"${escapedBatPathForCmd}"' -Verb RunAs -Wait -WindowStyle Normal`;

        const child = spawn('powershell.exe', [
          '-NoProfile',
          '-ExecutionPolicy', 'Bypass',
          '-Command',
          psCommand
        ], {
          detached: false,
          stdio: 'pipe',
          windowsHide: false
        });

        child.on('exit', (code) => {
          console.log('[TUN] PowerShell process exited with code:', code);

          const hasSuccessMarker = fs.existsSync(successMarkerPath);
          if (!hasSuccessMarker && code === 0) {
            console.log('[TUN] Success marker missing but exit code indicates success, proceeding to quit');
          }

          if (hasSuccessMarker || code === 0) {
            console.log('[TUN] Success detected, quitting current instance...');
            setTimeout(() => {
              app.quit();
            }, 1000);
          } else {
            console.log('[TUN] Success marker not found and exit code is non-zero; user may have cancelled UAC or script failed');
          }
        });

        child.on('error', (error) => {
          console.error('[TUN] PowerShell process error:', error);
        });

        console.log('[TUN] PowerShell process spawned, waiting for completion...');

        return { success: true, message: '正在请求管理员权限创建任务并重启应用...', needRestart: true };
      }
      // macOS 和 Linux 统一委托给 tunManager（grantCorePermission）
      if (context.grantCorePermission) {
        return await context.grantCorePermission();
      }

      if (isMac) {
        throw new Error('无法完成授权: grantCorePermission 未初始化');
      } else if (process.platform === 'linux') {
        const { promisify } = require('util');
        const execFile = promisify(require('child_process').execFile);
        const fs = require('fs');

        const kernelPath = context.mihomoService?.getKernelPath?.();
        if (!kernelPath) {
          throw new Error('无法获取 Mihomo 内核路径');
        }

        if (!fs.existsSync(kernelPath)) {
          throw new Error(`内核文件不存在: ${kernelPath}`);
        }

        await execFile('pkexec', ['chown', 'root:root', kernelPath]);
        await execFile('pkexec', ['chmod', '+sx', kernelPath]);

        console.log('[TUN] Linux 权限授予成功');
        return { success: true, message: 'TUN 模式权限已成功授予' };
      }
    } catch (error) {
      console.error('[TUN] 授予权限失败:', error);
      return { success: false, error: error.message || String(error) };
    }
  });

  // ---- 权限检查 ----

  ipcMain.handle('check-core-permission', async () => {
    try {
      // Windows: 使用 tunManager.checkPermission 综合判断服务/管理员权限
      if (isWindows) {
        if (context.tunManager && typeof context.tunManager.checkPermission === 'function') {
          const result = await context.tunManager.checkPermission();
          if (result && result.success) {
            return {
              success: true,
              hasPermission: !!result.hasPermission,
              details: result.details || {}
            };
          }
        }

        // 回退：仅根据启动时记录的管理员状态
        const hasAdmin = !!context.hasAdminPrivileges;
        return {
          success: true,
          hasPermission: hasAdmin,
          details: { mode: hasAdmin ? 'admin' : 'none' }
        };
      }

      // 非 Windows 平台：委托给 system-integration 暴露的 checkCorePermission
      if (context.checkCorePermission) {
        const result = await context.checkCorePermission();
        if (result && typeof result.hasPermission === 'boolean') {
          return {
            success: true,
            hasPermission: !!result.hasPermission,
            details: result.details || {}
          };
        }
        return {
          success: !!result,
          hasPermission: !!result
        };
      }

      return { success: false, hasPermission: false };
    } catch (error) {
      console.error('[check-core-permission] Error:', error);
      return { success: false, hasPermission: false };
    }
  });

  ipcMain.handle('revoke-core-permission', async () => {
    try {
      if (context.revokeCorePermission) {
        return await context.revokeCorePermission();
      }
      return { success: false, error: 'Function not available' };
    } catch (error) {
      console.error('[revoke-core-permission] Error:', error);
      return { success: false, error: error.message };
    }
  });

  // ---- 服务管理 ----

  ipcMain.handle('service-is-running', async () => {
    try {
      if (context.serviceManager) {
        const running = await context.serviceManager.isServiceRunning();
        return { success: true, running };
      }
      return { success: true, running: false };
    } catch (error) {
      console.error('[service-is-running] Error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('service-install', async () => {
    try {
      if (context.serviceManager) {
        return await context.serviceManager.installService();
      }
      return { success: false, error: 'Service manager not available' };
    } catch (error) {
      console.error('[service-install] Error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('service-uninstall', async () => {
    try {
      if (context.serviceManager) {
        return await context.serviceManager.uninstallService();
      }
      return { success: false, error: 'Service manager not available' };
    } catch (error) {
      console.error('[service-uninstall] Error:', error);
      return { success: false, error: error.message };
    }
  });

  // ---- TUN 配置 ----

  ipcMain.handle('get-tun-config', async () => {
    try {
      const config = dbManager.getSetting('tunConfig', {
        device: isMac ? 'utun' : 'mihomo',
        stack: 'system',
        autoRoute: true,
        autoRedirect: false,
        autoDetectInterface: true,
        dnsHijack: ['any:53'],
        strictRoute: false,
        routeExcludeAddress: [],
        mtu: 1500,
        autoSetDNS: isMac ? true : false
      });
      return { success: true, config };
    } catch (error) {
      console.error('[TUN] 获取配置失败:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('save-tun-config', async (event, config) => {
    try {
      dbManager.setSetting('tunConfig', config);
      console.log('[TUN] 配置已保存:', config);
      return { success: true };
    } catch (error) {
      console.error('[TUN] 保存配置失败:', error);
      return { success: false, error: error.message };
    }
  });

  // ---- TUN 权限提升模式 ----

  ipcMain.handle('get-tun-elevation-mode', async () => {
    try {
      if (context.tunManager && context.tunManager.getTunElevationMode) {
        return { success: true, mode: context.tunManager.getTunElevationMode() };
      }
      return { success: true, mode: 'service' };
    } catch (error) {
      console.error('[TUN] 获取提升模式失败:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('set-tun-elevation-mode', async (event, mode) => {
    try {
      if (context.tunManager && context.tunManager.setTunElevationMode) {
        context.tunManager.setTunElevationMode(mode);
        console.log('[TUN] 提升模式已设置为:', mode);

        // 切换到服务模式时，删除已存在的计划任务（避免冲突）
        if (mode === 'service' && context.permissionManager) {
          try {
            const taskExists = await context.permissionManager.checkElevateTask();
            if (taskExists) {
              await context.permissionManager.deleteElevateTask();
              console.log('[TUN] 已删除计划任务（切换到服务模式）');
            }
          } catch (deleteError) {
            console.warn('[TUN] 删除计划任务失败:', deleteError.message);
          }
        }

        return { success: true };
      }
      return { success: false, error: 'TUN manager not available' };
    } catch (error) {
      console.error('[TUN] 设置提升模式失败:', error);
      return { success: false, error: error.message };
    }
  });

  // ---- TUN 服务状态与操作 ----

  ipcMain.handle('get-tun-service-status', async () => {
    try {
      if (context.tunManager && context.tunManager.getServiceStatus) {
        const status = await context.tunManager.getServiceStatus();
        return { success: true, ...status };
      }
      return { success: true, installed: false, running: false, mode: 'task' };
    } catch (error) {
      console.error('[TUN] 获取服务状态失败:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('install-tun-service', async () => {
    try {
      if (context.tunManager && context.tunManager.installService) {
        const result = await context.tunManager.installService();

        if (isWindows && result && result.needsAdmin) {
          return {
            success: false,
            error:
              '安装服务需要管理员权限，请先退出 FlyClash，然后右键以管理员身份运行后再尝试安装服务。'
          };
        }

        return result;
      }
      return { success: false, error: 'TUN manager not available' };
    } catch (error) {
      console.error('[TUN] 安装服务失败:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('uninstall-tun-service', async () => {
    try {
      if (context.tunManager && context.tunManager.uninstallService) {
        const result = await context.tunManager.uninstallService();

        if (isWindows && result && result.needsAdmin) {
          return {
            success: false,
            error:
              '卸载服务需要管理员权限，请先退出 FlyClash，然后右键以管理员身份运行后再尝试卸载服务。'
          };
        }

        return result;
      }
      return { success: false, error: 'TUN manager not available' };
    } catch (error) {
      console.error('[TUN] 卸载服务失败:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('start-tun-service', async () => {
    try {
      if (context.tunManager && context.tunManager.startService) {
        return await context.tunManager.startService();
      }
      return { success: false, error: 'TUN manager not available' };
    } catch (error) {
      console.error('[TUN] 启动服务失败:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('stop-tun-service', async () => {
    try {
      if (context.tunManager && context.tunManager.stopService) {
        return await context.tunManager.stopService();
      }
      return { success: false, error: 'TUN manager not available' };
    } catch (error) {
      console.error('[TUN] 停止服务失败:', error);
      return { success: false, error: error.message };
    }
  });
}

module.exports = { registerTunServiceHandlers };
