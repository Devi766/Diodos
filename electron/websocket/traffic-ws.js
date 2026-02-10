'use strict';

/**
 * Traffic statistics WebSocket module
 * Manages the WebSocket connection for real-time traffic monitoring.
 */

/**
 * Create a traffic WebSocket manager.
 * @param {object} deps
 * @param {object} deps.state - Shared application state
 * @param {object} deps.context - Shared context object
 * @param {Function} deps.WebSocket - WebSocket constructor
 * @param {Function} deps.formatTraffic - Traffic formatting function
 * @param {Function} deps.fetchConnectionsInfo - Function to fetch connection info
 * @param {number} deps.MAX_TRAFFIC_HISTORY - Max history entries
 */
function createTrafficWsManager({ state, context, WebSocket, formatTraffic, fetchConnectionsInfo, MAX_TRAFFIC_HISTORY }) {

  // 更新流量统计
  function updateTrafficStats() {
    // 避免创建多个连接
    if (state.trafficWebSocket && state.trafficWebSocket.readyState !== WebSocket.CLOSED) {
      return;
    }

    try {
      // 检查是否有解析的API配置
      if (!state.activeApiConfig) {
        console.error('无法连接WebSocket: API配置不可用');
        return;
      }

      // 使用 Unix Socket / Named Pipe 连接
      const { socketPath } = state.activeApiConfig || {};

      if (!socketPath) {
        throw new Error('Socket 路径未初始化');
      }

      const wsUrl = `ws+unix:${socketPath}:/traffic`;
      console.log(`[Socket] 连接到流量统计 WebSocket: ${wsUrl}`);

      state.trafficWebSocket = new WebSocket(wsUrl);

      state.trafficWebSocket.on('open', () => {
        console.log('[调试] 流量统计WebSocket连接已建立');
        state.trafficRetry = 10; // 重置重试计数
      });

      state.trafficWebSocket.on('message', (data) => {
        try {
          const json = JSON.parse(data);

          if (!json || typeof json.up !== 'number' || typeof json.down !== 'number') {
            console.error('[调试] 无效的流量数据格式');
            return;
          }

          const stats = {
            up: json.up,
            down: json.down,
            timestamp: Date.now(),
            upSpeed: json.up,
            downSpeed: json.down
          };

          state.lastTrafficStats = stats;

          state.trafficHistory.push(stats);
          if (state.trafficHistory.length > MAX_TRAFFIC_HISTORY) {
            state.trafficHistory.shift();
          }

          // 累加流量数据用于持久化
          if (!state.trafficAccumulator) {
            state.trafficAccumulator = { upload: 0, download: 0, lastSaveTime: Date.now() };
          }
          state.trafficAccumulator.upload += json.up;
          state.trafficAccumulator.download += json.down;

          // 每10秒保存一次到数据库
          const now = Date.now();
          if (now - state.trafficAccumulator.lastSaveTime >= 10000) {
            try {
              context.dbManager.updateTodayTraffic(
                state.trafficAccumulator.upload,
                state.trafficAccumulator.download
              );
              state.trafficAccumulator = { upload: 0, download: 0, lastSaveTime: now };
            } catch (error) {
              console.error('[流量] 保存流量数据失败:', error);
            }
          }

          if (state.mainWindow) {
            state.mainWindow.webContents.send('traffic-update', stats);
          }

          // 减少连接信息获取频率，例如每5秒一次
          const currentTime = Date.now();
          if (!state.lastConnectionsFetchTime || (currentTime - state.lastConnectionsFetchTime) > 5000) {
            fetchConnectionsInfo();
            state.lastConnectionsFetchTime = currentTime;
          }

          // 只在流量变化较大时输出日志（大于10MB的变化）
          const significantChange = Math.abs(stats.up - state.lastTrafficStats.up) > 10 * 1024 * 1024 ||
                                  Math.abs(stats.down - state.lastTrafficStats.down) > 10 * 1024 * 1024;
          if (significantChange) {
            console.log(`[调试] 流量更新: 上传 ${formatTraffic(stats.up)}, 下载 ${formatTraffic(stats.down)}`);
          }
        } catch (error) {
          console.error('[调试] 处理流量数据时出错:', error);
        }
      });

      state.trafficWebSocket.on('close', () => {
        if (state.trafficRetry === 10) {
          console.log('[调试] 流量统计WebSocket连接已关闭');
        }
        state.trafficWebSocket = null;

        if (state.trafficRetry > 0) {
          state.trafficRetry--;
          if (state.trafficRetry === 9 || state.trafficRetry === 0) {
            console.log(`[调试] 尝试重新连接WebSocket，剩余重试次数: ${state.trafficRetry}`);
          }
          updateTrafficStats();
        } else {
          console.log('[调试] WebSocket重连次数已达上限，停止重试');
        }
      });

      state.trafficWebSocket.on('error', (error) => {
        console.error('[调试] 流量统计WebSocket错误:', error);
        if (state.trafficWebSocket) {
          state.trafficWebSocket.close();
          state.trafficWebSocket = null;
        }
      });
    } catch (error) {
      // ... existing code ...
    }
  }

  function startTrafficStatsUpdate() {
    if (state.trafficStatsInterval) {
      clearInterval(state.trafficStatsInterval);
    }

    updateTrafficStats();

    state.trafficStatsInterval = setInterval(() => {
      if (!state.trafficWebSocket || state.trafficWebSocket.readyState !== 1) {
        updateTrafficStats();
      }
    }, 1000);
  }

  function stopTrafficStatsUpdate() {
    if (state.trafficStatsInterval) {
      clearInterval(state.trafficStatsInterval);
      state.trafficStatsInterval = null;
    }

    if (state.trafficWebSocket) {
      state.trafficWebSocket.close();
      state.trafficWebSocket = null;
    }
  }

  return {
    updateTrafficStats,
    startTrafficStatsUpdate,
    stopTrafficStatsUpdate,
  };
}

module.exports = { createTrafficWsManager };
