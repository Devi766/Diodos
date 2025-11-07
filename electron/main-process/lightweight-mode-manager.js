/**
 * 轻量模式管理器
 * 负责管理应用的轻量模式功能：
 * - 进入轻量模式（完全退出应用，只保留内核运行）
 * - 清理遗留的轻量模式进程
 * - 自动进入轻量模式的定时器管理
 */

module.exports = function initLightweightModeManager(context) {
  const { app, ipcMain, path, fs, userDataPath, dbManager } = context;

  let lightweightModeTimer = null;

  /**
   * 启动轻量模式
   * 启动独立的内核进程，然后退出主进程
   */
  async function enterLightweightMode() {
    try {
      console.log('[LightweightMode] 准备进入轻量模式...');

      if (!context.mihomoService || !context.mihomoService.startLightweightMode) {
        throw new Error('Mihomo 服务未初始化');
      }

      // 取消自动轻量模式定时器（如果有）
      if (lightweightModeTimer) {
        clearTimeout(lightweightModeTimer);
        lightweightModeTimer = null;
      }

      // 启动轻量模式（由 mihomo-service 处理）
      await context.mihomoService.startLightweightMode();

      console.log('[LightweightMode] 轻量模式启动成功，主进程即将退出');
      return { success: true };
    } catch (error) {
      console.error('[LightweightMode] 进入轻量模式失败:', error);
      throw error;
    }
  }

  /**
   * 清理遗留的轻量模式进程
   * 应用启动时调用
   */
  async function cleanupLightweightProcess() {
    try {
      if (context.mihomoService && context.mihomoService.cleanupLightweightProcess) {
        await context.mihomoService.cleanupLightweightProcess();
        console.log('[LightweightMode] 遗留进程清理完成');
      }
    } catch (error) {
      console.error('[LightweightMode] 清理遗留进程失败:', error);
    }
  }

  /**
   * 启动自动轻量模式定时器
   * 在窗口关闭或隐藏时调用
   */
  function startAutoLightweightTimer() {
    try {
      const autoEnter = dbManager.getSetting('autoEnterLightweightMode', false);
      const delay = dbManager.getSetting('lightweightModeDelay', 60);

      if (!autoEnter) {
        console.log('[LightweightMode] 自动轻量模式未开启');
        return;
      }

      // 取消现有定时器
      if (lightweightModeTimer) {
        clearTimeout(lightweightModeTimer);
      }

      console.log(`[LightweightMode] 启动自动轻量模式定时器，延迟 ${delay} 秒`);

      lightweightModeTimer = setTimeout(async () => {
        console.log('[LightweightMode] 自动轻量模式定时器触发');
        try {
          await enterLightweightMode();
          // 延迟退出，确保进程已启动
          setTimeout(() => {
            app.exit(0);
          }, 500);
        } catch (error) {
          console.error('[LightweightMode] 自动进入轻量模式失败:', error);
        }
      }, delay * 1000);
    } catch (error) {
      console.error('[LightweightMode] 启动自动轻量模式定时器失败:', error);
    }
  }

  /**
   * 取消自动轻量模式定时器
   * 在窗口显示时调用
   */
  function cancelAutoLightweightTimer() {
    if (lightweightModeTimer) {
      console.log('[LightweightMode] 取消自动轻量模式定时器');
      clearTimeout(lightweightModeTimer);
      lightweightModeTimer = null;
    }
  }

  // ==================== IPC 处理器 ====================

  // 进入轻量模式
  ipcMain.handle('enter-lightweight-mode', async () => {
    try {
      console.log('[IPC] 收到进入轻量模式请求');
      await enterLightweightMode();

      // 延迟退出，确保消息发送到渲染进程
      setTimeout(() => {
        console.log('[IPC] 轻量模式启动成功，即将退出应用');
        app.exit(0);
      }, 500);

      return { success: true };
    } catch (error) {
      console.error('[IPC] 进入轻量模式失败:', error);
      return { success: false, error: error.message || '启动轻量模式失败' };
    }
  });

  // 获取轻量模式设置
  ipcMain.handle('get-lightweight-mode-settings', () => {
    try {
      const autoEnter = dbManager.getSetting('autoEnterLightweightMode', false);
      const delay = dbManager.getSetting('lightweightModeDelay', 60);
      return {
        success: true,
        settings: {
          autoEnter: Boolean(autoEnter),
          delay: Number(delay)
        }
      };
    } catch (error) {
      console.error('[LightweightMode] 获取设置失败:', error);
      return { success: false, error: error.message };
    }
  });

  // 设置轻量模式
  ipcMain.handle('set-lightweight-mode-settings', (event, settings) => {
    try {
      if (settings.autoEnter !== undefined) {
        dbManager.setSetting('autoEnterLightweightMode', Boolean(settings.autoEnter));
      }
      if (settings.delay !== undefined) {
        const delay = Math.max(10, Math.min(600, Number(settings.delay)));
        dbManager.setSetting('lightweightModeDelay', delay);
      }
      console.log('[LightweightMode] 设置已更新:', settings);
      return { success: true };
    } catch (error) {
      console.error('[LightweightMode] 设置失败:', error);
      return { success: false, error: error.message };
    }
  });

  // 导出功能
  context.lightweightModeManager = {
    enterLightweightMode,
    cleanupLightweightProcess,
    startAutoLightweightTimer,
    cancelAutoLightweightTimer
  };

  console.log('[LightweightMode] 轻量模式管理器已初始化');
};
