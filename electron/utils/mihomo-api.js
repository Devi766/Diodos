'use strict';

/**
 * Mihomo API client module
 * Provides axios-based HTTP client for communicating with the Mihomo core
 * via Unix Socket / Named Pipe.
 */

const axios = require('axios');

let axiosInstance = null;

/**
 * Create a Mihomo API client bound to the given state.
 * @param {object} deps
 * @param {object} deps.state - Shared application state (must have activeApiConfig)
 * @returns {{ getAxiosInstance: Function, fetchMihomoAPI: Function }}
 */
function createMihomoApiClient({ state }) {

  async function getAxiosInstance(force = false) {
    const { socketPath } = state.activeApiConfig || {};

    if (!socketPath) {
      throw new Error('Mihomo Socket 路径未初始化');
    }

    // 如果 socket 路径改变,强制重新创建实例
    if (axiosInstance && axiosInstance.defaults.socketPath !== socketPath) {
      force = true;
    }

    if (axiosInstance && !force) {
      return axiosInstance;
    }

    console.log('[Socket] 创建 axios 实例,socket 路径:', socketPath);

    axiosInstance = axios.create({
      baseURL: 'http://localhost',
      socketPath: socketPath,
      timeout: 15000
    });

    // 响应拦截器
    axiosInstance.interceptors.response.use(
      (response) => {
        return response.data;
      },
      (error) => {
        if (error.response && error.response.data) {
          return Promise.reject(error.response.data);
        }
        return Promise.reject(error);
      }
    );

    return axiosInstance;
  }

  async function fetchMihomoAPI(endpoint, options = {}) {
    try {
      const instance = await getAxiosInstance();

      // 标准化路径
      const normalizedPath = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;

      // 构建 axios 请求配置
      const axiosConfig = {
        method: options.method || 'GET',
        url: normalizedPath,
        headers: options.headers || {},
        ...options
      };

      // 如果有 body,设置为 data
      if (options.body) {
        axiosConfig.data = options.body;
      }

      console.log('[Socket] 发送 API 请求:', normalizedPath);
      const response = await instance.request(axiosConfig);

      return {
        ok: true,
        status: 200,
        json: async () => response,
        text: async () => JSON.stringify(response)
      };
    } catch (error) {
      console.error('[Socket] API 请求失败:', error.message);
      throw error;
    }
  }

  return {
    getAxiosInstance,
    fetchMihomoAPI,
  };
}

module.exports = { createMihomoApiClient };
