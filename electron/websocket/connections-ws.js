'use strict';

/**
 * Connections WebSocket module
 * Manages the WebSocket connection for monitoring active proxy connections.
 */

const WebSocket = require('ws');

/**
 * Create a connections WebSocket manager.
 * @param {object} deps
 * @param {object} deps.state - Shared application state
 */
function createConnectionsWsManager({ state }) {

  async function startConnectionsWebSocket() {
    try {
      if (!state.currentNode) {
        throw new Error('未选择节点');
      }

      if (!state.activeApiConfig) {
        throw new Error('API配置不可用');
      }

      const { socketPath } = state.activeApiConfig || {};

      if (!socketPath) {
        throw new Error('Socket 路径未初始化');
      }

      const wsUrl = `ws+unix:${socketPath}:/connections/${state.currentNode}`;
      console.log(`[Socket] 连接到节点 WebSocket: ${wsUrl}`);

      state.connectionsWebSocket = new WebSocket(wsUrl);

      const connectionTimeout = setTimeout(() => {
        if (state.connectionsWebSocket.readyState !== WebSocket.OPEN) {
          state.connectionsWebSocket.close();
          throw new Error('连接超时');
        }
      }, 5000);

      state.connectionsWebSocket.on('open', () => {
        clearTimeout(connectionTimeout);
        console.log(`已连接到节点 ${state.currentNode}`);
      });

      state.connectionsWebSocket.on('close', () => {
        console.log(`与节点 ${state.currentNode} 的连接已关闭`);
        setTimeout(() => {
          if (state.currentNode) {
            startConnectionsWebSocket().catch(console.error);
          }
        }, 5000);
      });

      state.connectionsWebSocket.on('error', (error) => {
        console.error('WebSocket错误:', error);
        clearTimeout(connectionTimeout);
      });

    } catch (error) {
      console.error('启动WebSocket连接失败:', error);
      throw error;
    }
  }

  // 注意：此函数已废弃，保留只是为了兼容性
  async function updateCurrentNodeInfo() {
    return;
  }

  function stopConnectionsWebSocket() {
    if (state.connectionsWebSocket) {
      state.connectionsWebSocket.close();
      state.connectionsWebSocket = null;
    }
    state.connectionsRetry = 10;
  }

  return {
    startConnectionsWebSocket,
    updateCurrentNodeInfo,
    stopConnectionsWebSocket,
  };
}

module.exports = { createConnectionsWsManager };
