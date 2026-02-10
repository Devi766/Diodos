'use strict';

/**
 * Application lifecycle module
 * Handles window-all-closed, before-quit, and will-quit events.
 */

const { execSync } = require('child_process');

/**
 * Register application lifecycle event handlers.
 * @param {object} deps
 * @param {object} deps.app - Electron app module
 * @param {object} deps.state - Shared application state
 * @param {object} deps.dbManager - Database manager
 * @param {object} deps.subscriptionScheduler - Subscription scheduler
 * @param {Function} deps.stopConnectionsWebSocket - Stop connections WS
 * @param {Function} deps.stopMihomoLogs - Stop logs WS
 * @param {Function} deps.cleanupWebSockets - Cleanup all WebSockets
 */
function registerAppLifecycle({ app, state, dbManager, subscriptionScheduler, stopConnectionsWebSocket, stopMihomoLogs, cleanupWebSockets }) {

  app.on('window-all-closed', () => {
    stopConnectionsWebSocket();
    stopMihomoLogs();
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  let quitCleanupDone = false;

  app.on('before-quit', async (event) => {
    state.isQuitting = true;

    // 停止 sidecar 模式的内核进程
    if (state.mihomoProcess) {
      state.mihomoProcess.kill();
    }

    // 停止服务模式的内核
    if (!quitCleanupDone) {
      try {
        const { getRunningMode, RunningMode, setRunningMode } = require('../utils/running-mode');
        const currentMode = getRunningMode();
        if (currentMode === RunningMode.SERVICE) {
          event.preventDefault();
          quitCleanupDone = true;

          console.log('[退出] 检测到服务模式，正在停止内核...');
          const { coreService } = require('../main-process/core-service');

          try {
            await Promise.race([
              coreService.stopCore(),
              new Promise((_, reject) => setTimeout(() => reject(new Error('停止内核超时')), 3000))
            ]);
            console.log('[退出] 服务模式内核已停止');
          } catch (err) {
            console.error('[退出] 停止服务模式内核失败或超时:', err.message);
          }

          setRunningMode(RunningMode.NOT_RUNNING);
          app.quit();
          return;
        }
      } catch (error) {
        console.error('[退出] 停止服务模式失败:', error);
      }
    }

    // 关闭静态文件服务器
    if (global.staticServer && global.staticServer.listening) {
      console.log('关闭静态文件服务器');
      global.staticServer.close();
    }

    // 确保退出时关闭系统代理
    try {
      execSync('reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 0 /f');
    } catch (error) {
      console.error('Failed to disable system proxy on exit:', error);
    }
  });

  app.on('will-quit', () => {
    console.log('[调试] 应用即将退出，正在清理资源');
    cleanupWebSockets();
    if (state.memoryMonitorInterval) {
      clearInterval(state.memoryMonitorInterval);
      state.memoryMonitorInterval = null;
    }

    if (subscriptionScheduler) {
      subscriptionScheduler.stop();
    }

    if (dbManager) {
      dbManager.close();
    }
  });
}

module.exports = { registerAppLifecycle };
