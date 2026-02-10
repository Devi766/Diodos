'use strict';

/**
 * Logs WebSocket module
 * Manages the WebSocket connection for real-time Mihomo log streaming.
 */

/**
 * Create a logs WebSocket manager.
 * @param {object} deps
 * @param {object} deps.state - Shared application state
 * @param {Function} deps.WebSocket - WebSocket constructor
 */
function createLogsWsManager({ state, WebSocket }) {

  function startMihomoLogs() {
    // 避免创建多个连接
    if (state.logsWebSocket && state.logsWebSocket.readyState !== WebSocket.CLOSED) {
      return;
    }

    try {
      if (!state.activeApiConfig) {
        console.error('无法连接日志WebSocket: API配置不可用');
        return;
      }

      const { socketPath } = state.activeApiConfig || {};

      if (!socketPath) {
        throw new Error('Socket 路径未初始化');
      }

      const logLevel = 'info';
      const wsUrl = `ws+unix:${socketPath}:/logs?level=${logLevel}`;

      console.log(`[Socket] 连接到日志 WebSocket: ${wsUrl}`);

      state.logsWebSocket = new WebSocket(wsUrl);

      state.logsWebSocket.on('open', () => {
        console.log('[调试] 日志WebSocket连接已建立');
        state.logsRetry = 10;
      });

      state.logsWebSocket.on('message', (data) => {
        try {
          const log = JSON.parse(data);
          if (state.mainWindow) {
            state.mainWindow.webContents.send('mihomo-logs', log);
          }
        } catch (error) {
          console.error('[调试] 解析日志数据失败:', error);
        }
      });

      state.logsWebSocket.on('close', () => {
        console.log('[调试] 日志WebSocket连接已关闭');
        state.logsWebSocket = null;

        if (state.logsRetry > 0) {
          state.logsRetry--;
          console.log(`[调试] 尝试重新连接日志WebSocket，剩余重试次数: ${state.logsRetry}`);
          setTimeout(() => startMihomoLogs(), 3000);
        } else {
          console.log('[调试] 日志WebSocket重连次数已达上限，停止重试');
        }
      });

      state.logsWebSocket.on('error', (error) => {
        console.error('[调试] 日志WebSocket错误:', error);
        if (state.logsWebSocket) {
          state.logsWebSocket.close();
          state.logsWebSocket = null;
        }
      });
    } catch (error) {
      console.error('[调试] 启动日志WebSocket失败:', error);
    }
  }

  function stopMihomoLogs() {
    if (state.logsWebSocket) {
      state.logsWebSocket.close();
      state.logsWebSocket = null;
    }
    state.logsRetry = 10;
  }

  return {
    startMihomoLogs,
    stopMihomoLogs,
  };
}

module.exports = { createLogsWsManager };
