/**
 * Windows 核心服务管理模块
 * 使用轻量级 Go helper 服务运行 Mihomo 内核，实现无 UAC 提示的 TUN 模式
 */

const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const helperIpc = require('./helper-ipc');

/**
 * Windows 核心服务管理类
 */
class CoreService {
  constructor() {
    this.serviceName = helperIpc.SERVICE_NAME;
  }

  /**
   * 检查服务是否已安装
   */
  async isInstalled() {
    if (process.platform !== 'win32') return false;
    return helperIpc.isServiceInstalled();
  }

  /**
   * 检查服务是否正在运行
   */
  async isRunning() {
    if (process.platform !== 'win32') return false;
    return helperIpc.isServiceRunning();
  }

  /**
   * 检查服务是否可用（可以通信）
   */
  async isAvailable() {
    if (process.platform !== 'win32') return false;
    return await helperIpc.isServiceAvailable();
  }

  /**
   * 安装服务（需要管理员权限）
   */
  async install() {
    if (process.platform !== 'win32') {
      return { success: false, error: 'Only supported on Windows' };
    }

    const helperPath = helperIpc.getHelperPath();
    if (!helperPath) {
      return { success: false, error: 'Helper executable not found' };
    }

    // 调用 installService，它会检查管理员权限
    const result = await helperIpc.installService();

    if (result.success) {
      // 等待服务启动
      await this.waitForAvailable(5000);
    }

    return result;
  }

  /**
   * 卸载服务（需要管理员权限）
   */
  async uninstall() {
    if (process.platform !== 'win32') {
      return { success: false, error: 'Only supported on Windows' };
    }

    // 先停止内核
    await this.stopCore().catch(() => {});

    // 调用 uninstallService，它会检查管理员权限
    return await helperIpc.uninstallService();
  }

  /**
   * 启动服务（普通用户无法启动，服务设置为自动启动）
   */
  async start() {
    if (process.platform !== 'win32') {
      return { success: false, error: 'Only supported on Windows' };
    }

    // 检查服务是否已安装
    if (!helperIpc.isServiceInstalled()) {
      return { success: false, error: 'Service not installed' };
    }

    // 检查服务是否已在运行
    if (helperIpc.isServiceRunning()) {
      return { success: true, message: 'Service already running' };
    }

    // 尝试通过 sc 命令启动服务：
    // - 管理员进程会成功启动服务；
    // - 非管理员进程会收到“拒绝访问”等错误，我们再给出提示。
    try {
      execSync(`sc start "${this.serviceName}"`, { stdio: 'pipe' });
    } catch (e) {
      const msg = e && e.message ? e.message : '';
      // 大概率是权限不足
      return {
        success: false,
        error: msg || 'Service not running. Please restart your computer or run as administrator to start the service.'
      };
    }

    // 等待服务变为可用（可接受 IPC 请求）
    const available = await this.waitForAvailable(8000);
    if (available) {
      return { success: true, message: 'Service started successfully' };
    }

    return {
      success: false,
      error: 'Service start command sent, but service is still not available'
    };
  }

  /**
   * 停止服务（普通用户无法停止）
   */
  async stop() {
    // 服务设置为自动启动，不应该被停止
    // 只停止内核进程
    return await this.stopCore();
  }

  /**
   * 等待服务可用
   */
  async waitForAvailable(timeoutMs = 5000) {
    const start = Date.now();
    const interval = 200;

    while (Date.now() - start < timeoutMs) {
      if (await helperIpc.isServiceAvailable()) {
        return true;
      }
      await new Promise(r => setTimeout(r, interval));
    }

    return false;
  }

  /**
   * 通过服务启动内核
   */
  async startCore(binPath, configFile) {
    if (process.platform !== 'win32') {
      return { success: false, error: 'Only supported on Windows' };
    }

    // 检查服务是否可用
    if (!(await helperIpc.isServiceAvailable())) {
      return { success: false, error: 'Helper service not available' };
    }

    try {
      const configDir = path.dirname(configFile);
      const logFile = path.join(app.getPath('userData'), 'logs', 'mihomo.log');
      const { getServiceSocketPath } = require('../utils/running-mode');
      const extCtlPipe = getServiceSocketPath();

      // 确保日志目录存在
      const logDir = path.dirname(logFile);
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }

      await helperIpc.startCore(binPath, configDir, configFile, logFile, extCtlPipe);

      console.log('[CoreService] Core started via helper service');
      return { success: true };
    } catch (error) {
      console.error('[CoreService] Start core failed:', error);
      return { success: false, error: error.message || 'Failed to start core' };
    }
  }

  /**
   * 通过服务停止内核
   */
  async stopCore() {
    if (process.platform !== 'win32') {
      return { success: false, error: 'Only supported on Windows' };
    }

    try {
      // 即使服务不可用也尝试停止
      if (await helperIpc.isServiceAvailable()) {
        await helperIpc.stopCore();
      }

      console.log('[CoreService] Core stopped via helper service');
      return { success: true };
    } catch (error) {
      console.error('[CoreService] Stop core failed:', error);
      return { success: false, error: error.message || 'Failed to stop core' };
    }
  }

  /**
   * 获取内核状态
   */
  async getCoreStatus() {
    if (process.platform !== 'win32') {
      return { running: false, pid: 0 };
    }

    try {
      if (!(await helperIpc.isServiceAvailable())) {
        return { running: false, pid: 0 };
      }

      const status = await helperIpc.getStatus();
      return status;
    } catch {
      return { running: false, pid: 0 };
    }
  }

  /**
   * 获取服务版本
   */
  async getVersion() {
    try {
      if (!(await helperIpc.isServiceAvailable())) {
        return null;
      }

      const version = await helperIpc.getVersion();
      return version;
    } catch {
      return null;
    }
  }

  /**
   * 获取共享密钥（兼容旧接口）
   */
  getSharedSecret() {
    // 新的 helper 服务使用固定的密钥派生，不需要外部密钥
    return null;
  }

  /**
   * 加载或创建密钥（兼容旧接口）
   */
  loadOrCreateSecret() {
    return null;
  }
}

// 导出单例
const coreService = new CoreService();

module.exports = {
  coreService,
  CoreService
};
