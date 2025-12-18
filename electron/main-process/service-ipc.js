/**
 * 服务 IPC 通信模块
 * 提供与 FlyClash Core Service 的通信接口
 */

const net = require('net');
const EventEmitter = require('events');
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

// IPC 配置
const DEFAULT_PIPE_NAME = '\\\\.\\pipe\\flycast-core-service';
const DEFAULT_TCP_PORT = 19091;
const DEFAULT_TIMEOUT = 10000;

let cachedSecret = null;

function getServiceConfigPath() {
  try {
    // 打包环境下优先从安装目录的 service 子目录读取
    if (app.isPackaged && process.platform === 'win32') {
      const baseDir = process.resourcesPath || path.dirname(process.execPath);
      const packagedPath = path.join(baseDir, 'service', 'service-config.json');
      if (fs.existsSync(packagedPath)) {
        return packagedPath;
      }
    }

    // 开发环境或回退：使用用户数据目录
    const userData = app.getPath('userData');
    return path.join(userData, 'service', 'service-config.json');
  } catch {
    return null;
  }
}

function getServiceSecret() {
  if (cachedSecret) {
    return cachedSecret;
  }

  const configPath = getServiceConfigPath();
  if (!configPath || !fs.existsSync(configPath)) {
    return null;
  }

  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (cfg && typeof cfg.secret === 'string') {
      cachedSecret = cfg.secret;
      return cachedSecret;
    }
  } catch (e) {
    console.warn('[ServiceIpc] Failed to read service config secret:', e.message);
  }

  return null;
}

/**
 * 服务 IPC 客户端类
 */
class ServiceIpc extends EventEmitter {
  constructor(options = {}) {
    super();
    this.pipeName = options.pipeName || DEFAULT_PIPE_NAME;
    this.tcpPort = options.tcpPort || DEFAULT_TCP_PORT;
    this.timeout = options.timeout || DEFAULT_TIMEOUT;
    this.connected = false;
    this.preferPipe = true; // 优先使用命名管道
  }

  /**
   * 生成请求 ID
   */
  generateRequestId() {
    return Date.now().toString(36) + Math.random().toString(36).substring(2);
  }

  /**
   * 通过命名管道发送命令
   */
  sendViaPipe(request) {
    return new Promise((resolve, reject) => {
      const client = net.createConnection(this.pipeName, () => {
        client.write(JSON.stringify(request));
      });

      let responseData = '';
      const timeout = setTimeout(() => {
        client.destroy();
        reject(new Error('Pipe 通信超时'));
      }, this.timeout);

      client.on('data', (data) => {
        responseData += data.toString();
        try {
          const response = JSON.parse(responseData);
          clearTimeout(timeout);
          client.end();

          if (response.id === request.id) {
            resolve(response);
          } else {
            reject(new Error('响应 ID 不匹配'));
          }
        } catch {
          // JSON 未完整，继续等待
        }
      });

      client.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      client.on('close', () => {
        clearTimeout(timeout);
      });
    });
  }

  /**
   * 通过 TCP 发送命令
   */
  sendViaTcp(request) {
    return new Promise((resolve, reject) => {
      const client = net.createConnection({
        port: this.tcpPort,
        host: '127.0.0.1'
      }, () => {
        client.write(JSON.stringify(request));
      });

      let responseData = '';
      const timeout = setTimeout(() => {
        client.destroy();
        reject(new Error('TCP 通信超时'));
      }, this.timeout);

      client.on('data', (data) => {
        responseData += data.toString();
        try {
          const response = JSON.parse(responseData);
          clearTimeout(timeout);
          client.end();
          resolve(response);
        } catch {
          // JSON 未完整，继续等待
        }
      });

      client.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      client.on('close', () => {
        clearTimeout(timeout);
      });
    });
  }

  /**
   * 发送命令到服务
   * @param {string} command - 命令名称
   * @param {Object} payload - 命令参数
   * @returns {Promise<Object>} - 响应结果
   */
  async send(command, payload = {}) {
    const request = {
      id: this.generateRequestId(),
      command,
      payload,
      timestamp: Date.now()
    };

    // 附加共享密钥，用于服务端认证
    const secret = getServiceSecret();
    if (secret) {
      request.secret = secret;
    }

    // 优先尝试命名管道
    if (this.preferPipe) {
      try {
        const response = await this.sendViaPipe(request);
        this.connected = true;
        this.emit('connected', 'pipe');
        return response;
      } catch (pipeError) {
        console.warn('[ServiceIpc] Pipe failed, trying TCP:', pipeError.message);
      }
    }

    // 回退到 TCP
    try {
      const response = await this.sendViaTcp(request);
      this.connected = true;
      this.emit('connected', 'tcp');
      return response;
    } catch (tcpError) {
      this.connected = false;
      this.emit('disconnected');
      throw new Error(`服务通信失败: ${tcpError.message}`);
    }
  }

  /**
   * 检查服务连接
   */
  async ping() {
    try {
      const response = await this.send('ping');
      return response.success && response.data === 'pong';
    } catch {
      return false;
    }
  }

  /**
   * 启动核心
   */
  async startCore(corePath, configPath) {
    const response = await this.send('start_core', { corePath, configPath });
    if (!response.success) {
      throw new Error(response.error || '启动核心失败');
    }
    return response.data;
  }

  /**
   * 停止核心
   */
  async stopCore() {
    const response = await this.send('stop_core');
    if (!response.success) {
      throw new Error(response.error || '停止核心失败');
    }
    return response.data;
  }

  /**
   * 重启核心
   */
  async restartCore(configPath) {
    const response = await this.send('restart_core', { configPath });
    if (!response.success) {
      throw new Error(response.error || '重启核心失败');
    }
    return response.data;
  }

  /**
   * 获取状态
   */
  async getStatus() {
    const response = await this.send('get_status');
    if (!response.success) {
      throw new Error(response.error || '获取状态失败');
    }
    return response.data;
  }

  /**
   * 更新配置
   */
  async updateConfig(configPath) {
    const response = await this.send('update_config', { configPath });
    if (!response.success) {
      throw new Error(response.error || '更新配置失败');
    }
    return response.data;
  }

  /**
   * 检查是否已连接
   */
  isConnected() {
    return this.connected;
  }
}

/**
 * 简化的 IPC 通信函数
 * 用于快速发送单个命令
 */
async function sendServiceCommand(command, payload = {}, options = {}) {
  const ipc = new ServiceIpc(options);
  return await ipc.send(command, payload);
}

/**
 * 检查服务是否可用
 */
async function isServiceAvailable(options = {}) {
  const ipc = new ServiceIpc(options);
  return await ipc.ping();
}

// 创建默认实例
const defaultIpc = new ServiceIpc();

module.exports = {
  ServiceIpc,
  sendServiceCommand,
  isServiceAvailable,
  defaultIpc,
  DEFAULT_PIPE_NAME,
  DEFAULT_TCP_PORT
};
