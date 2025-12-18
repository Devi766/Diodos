/**
 * Windows 核心服务管理模块
 * 使用 Windows Service 方式运行 Mihomo 核心，实现无 UAC 提示的 TUN 模式
 */

const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const { execSync, spawn } = require('child_process');
const net = require('net');
const crypto = require('crypto');

function escapeXml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// 服务配置
const SERVICE_NAME = 'FlyClashCoreService';
const SERVICE_DISPLAY_NAME = 'FlyClash Core Service';
const SERVICE_DESCRIPTION = 'FlyClash 核心服务，用于 TUN 模式';
const IPC_PIPE_NAME = '\\\\.\\pipe\\flycast-core-service';
const IPC_PORT = 19091; // TCP 备选端口

/**
 * Windows 核心服务管理类
 */
class CoreService {
  constructor() {
    this.serviceName = SERVICE_NAME;
    this.pipeName = IPC_PIPE_NAME;
    this.port = IPC_PORT;
    this.serviceWorkerPath = null;
    this.nodeWindowsService = null;
    this._cachedSecret = null;
  }

  /**
   * 获取服务配置目录和配置文件路径
   */
  getConfigDir() {
    // 打包环境下，将配置放在安装目录的 service 子目录，便于服务账户访问
    try {
      if (app.isPackaged && process.platform === 'win32') {
        const baseDir = process.resourcesPath || path.dirname(process.execPath);
        return path.join(baseDir, 'service');
      }
    } catch {
      // 回退到用户数据目录
    }

    return path.join(app.getPath('userData'), 'service');
  }

  /**
   * 获取服务可执行文件路径（winsw 包装器）
   */
  getServiceExePath() {
    try {
      if (app.isPackaged && process.platform === 'win32') {
        const baseDir = process.resourcesPath || path.dirname(process.execPath);
        return path.join(baseDir, 'service', 'flyclashcoreservice.exe');
      }
    } catch {
      // ignore
    }

    // 开发环境：使用仓库中的 daemon 目录
    return path.join(__dirname, '..', 'daemon', 'flyclashcoreservice.exe');
  }

  /**
   * 异步运行 winsw 服务包装器，避免阻塞主进程
   * @param {string[]} args - 传递给 exe 的参数，如 ['install']
   */
  runServiceExe(args) {
    return new Promise((resolve, reject) => {
      const exePath = this.getServiceExePath();
      if (!fs.existsSync(exePath)) {
        return reject(new Error('服务可执行文件不存在: ' + exePath));
      }

      const child = spawn(exePath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });
      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('error', (err) => {
        reject(err);
      });

      child.on('close', (code) => {
        if (code === 0) {
          resolve({ code, stdout, stderr });
        } else {
          const msg = stderr || stdout || `服务命令执行失败，退出代码: ${code}`;
          reject(new Error(msg));
        }
      });
    });
  }

  getConfigPath() {
    return path.join(this.getConfigDir(), 'service-config.json');
  }

  /**
   * 读取现有配置中的 secret，或生成新的 secret
   */
  loadOrCreateSecret(configPath) {
    try {
      if (fs.existsSync(configPath)) {
        const existing = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (existing && typeof existing.secret === 'string' && existing.secret.length >= 16) {
          return existing.secret;
        }
      }
    } catch (e) {
      console.warn('[CoreService] Failed to read existing service config for secret:', e.message);
    }

    // 生成新的随机密钥
    return crypto.randomBytes(32).toString('hex');
  }

  /**
   * 从配置文件中读取共享密钥（用于 IPC 认证）
   */
  getSharedSecret() {
    if (this._cachedSecret) {
      return this._cachedSecret;
    }

    const configPath = this.getConfigPath();
    try {
      if (fs.existsSync(configPath)) {
        const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (cfg && typeof cfg.secret === 'string') {
          this._cachedSecret = cfg.secret;
          return this._cachedSecret;
        }
      }
    } catch (e) {
      console.warn('[CoreService] Failed to read shared secret from config:', e.message);
    }

    return null;
  }

  /**
   * 获取服务工作脚本路径
   */
  getServiceWorkerPath() {
    if (this.serviceWorkerPath) {
      return this.serviceWorkerPath;
    }

    // 检查多个可能的位置
    const possiblePaths = [
      path.join(process.resourcesPath || '', 'service-worker.js'),
      path.join(app.getAppPath(), 'electron', 'service-worker.js'),
      path.join(__dirname, '..', 'service-worker.js'),
      path.join(process.cwd(), 'electron', 'service-worker.js')
    ];

    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        this.serviceWorkerPath = p;
        return p;
      }
    }

    return null;
  }

  /**
   * 获取实际的 Windows 服务名称
   * node-windows 使用脚本文件名作为服务名称的一部分
   */
  getActualServiceName() {
    // node-windows 可能使用多种命名方式，我们都检查一下
    return [
      this.serviceName,
      `${this.serviceName}.exe`,
      'flyclashcoreservice',
      'FlyClashCoreService'
    ];
  }

  /**
   * 检查服务是否已安装
   */
  async isInstalled() {
    if (process.platform !== 'win32') {
      return false;
    }

    const serviceNames = this.getActualServiceName();

    for (const name of serviceNames) {
      try {
        const result = execSync(`sc query "${name}"`, {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe']
        });
        if (result.includes('SERVICE_NAME') || result.includes('STATE')) {
          console.log('[CoreService] Found service with name:', name);
          this._foundServiceName = name;
          return true;
        }
      } catch {
        // 继续尝试下一个名称
      }
    }

    // 尝试通过 sc query state= all 查找包含关键字的服务
    try {
      const allServices = execSync('sc query state= all', {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe']
      });

      // 查找包含 FlyClash 或 flyclash 的服务
      const lines = allServices.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.includes('SERVICE_NAME') &&
            (line.toLowerCase().includes('flyclash') || line.toLowerCase().includes('flycast'))) {
          const match = line.match(/SERVICE_NAME:\s*(.+)/i);
          if (match) {
            this._foundServiceName = match[1].trim();
            console.log('[CoreService] Found service via search:', this._foundServiceName);
            return true;
          }
        }
      }
    } catch (e) {
      console.warn('[CoreService] Failed to query all services:', e.message);
    }

    return false;
  }

  /**
   * 检查服务是否正在运行
   */
  async isRunning() {
    if (process.platform !== 'win32') {
      return false;
    }

    // 优先使用已找到的服务名称
    const serviceName = this._foundServiceName || this.serviceName;

    try {
      const result = execSync(`sc query "${serviceName}"`, {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe']
      });
      return result.includes('RUNNING');
    } catch {
      // 如果没有找到缓存的名称，尝试所有可能的名称
      if (!this._foundServiceName) {
        const serviceNames = this.getActualServiceName();
        for (const name of serviceNames) {
          try {
            const result = execSync(`sc query "${name}"`, {
              encoding: 'utf8',
              stdio: ['pipe', 'pipe', 'pipe']
            });
            if (result.includes('RUNNING')) {
              this._foundServiceName = name;
              return true;
            }
          } catch {}
        }
      }
      return false;
    }
  }

  /**
   * 检查是否有管理员权限
   */
  isAdmin() {
    try {
      // 复用 PermissionManager 的管理员检测逻辑，避免重复实现
      const PermissionManager = require('./permission-manager');
      const permissionManager = new PermissionManager();
      if (typeof permissionManager.checkAdminPrivilegesSync === 'function') {
        return permissionManager.checkAdminPrivilegesSync();
      }
    } catch (e) {
      console.warn('[CoreService] Failed to check admin privileges via PermissionManager:', e.message);
    }

    // 回退到简单的 net session 检测
    try {
      execSync('net session', { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 安装服务
   * @param {Object} options - 安装选项
   * @param {string} options.corePath - Mihomo 核心路径
   */
  async install(options = {}) {
    if (process.platform !== 'win32') {
      return { success: false, error: '仅支持 Windows 平台' };
    }

    const { corePath } = options;

    try {
      // 检查管理员权限
      if (!this.isAdmin()) {
        console.log('[CoreService] Not running as admin');
        return {
          success: false,
          error: '安装服务需要管理员权限，请以管理员身份运行应用程序',
          needsAdmin: true
        };
      }

      // 创建服务配置目录（打包环境下位于安装目录的 service 子目录）
      const serviceDir = this.getConfigDir();
      if (!fs.existsSync(serviceDir)) {
        fs.mkdirSync(serviceDir, { recursive: true });
      }

      // 写入服务配置（供 service-worker 使用）
      const configPath = this.getConfigPath();
      const secret = this.loadOrCreateSecret(configPath);
      const config = {
        corePath: corePath || '',
        pipeName: this.pipeName,
        port: this.port,
        userDataPath: app.getPath('userData'),
        secret
      };
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
      console.log('[CoreService] Service config written to:', configPath);

      // 尝试清理旧版本/旧命名的服务，避免残留导致“已安装但不可用”的假状态
      const legacyNames = [
        this.serviceName,
        'flyclashcoreservice',
        'flyclashcoreservice.exe'
      ];

      for (const name of legacyNames) {
        try {
          execSync(`sc stop "${name}"`, { stdio: 'pipe' });
        } catch {
          // 可能本来就没在运行，忽略
        }
        try {
          execSync(`sc delete "${name}"`, { stdio: 'pipe' });
          console.log('[CoreService] Removed legacy service entry:', name);
        } catch {
          // 服务不存在时会报错，忽略
        }
      }

      // 清理本地缓存的服务名
      this._foundServiceName = null;

      // 使用 winsw 包装器注册 Windows 服务，避免直接将 Electron 进程作为服务
      const exePath = process.execPath;
      const baseDir = process.resourcesPath || path.dirname(exePath);
      const workingDir = baseDir;

      // 生成 winsw 配置 XML
      const xmlContent =
        '<?xml version="1.0" encoding="UTF-8"?>\r\n' +
        '<service>\r\n' +
        `\t<id>${escapeXml(this.serviceName)}</id>\r\n` +
        `\t<name>${escapeXml(SERVICE_DISPLAY_NAME)}</name>\r\n` +
        `\t<description>${escapeXml(SERVICE_DESCRIPTION)}</description>\r\n` +
        `\t<executable>${escapeXml(exePath)}</executable>\r\n` +
        `\t<argument>--service-worker</argument>\r\n` +
        '\t<logmode>rotate</logmode>\r\n' +
        '\t<stoptimeout>30sec</stoptimeout>\r\n' +
        `\t<env name="FLYCAST_SERVICE_CONFIG" value="${escapeXml(configPath)}" />\r\n` +
        `\t<workingdirectory>${escapeXml(workingDir)}</workingdirectory>\r\n` +
        '</service>\r\n';

      const xmlPath = path.join(serviceDir, 'flyclashcoreservice.xml');
      fs.writeFileSync(xmlPath, xmlContent, 'utf8');
      console.log('[CoreService] winsw config written to:', xmlPath);

      // 使用 winsw 进行安装（先尝试卸载旧实例）
      try {
        await this.runServiceExe(['stop']);
      } catch {
        // 可能未安装或未运行，忽略
      }
      try {
        await this.runServiceExe(['uninstall']);
      } catch {
        // 可能未安装，忽略
      }

      console.log('[CoreService] Installing service via winsw');
      await this.runServiceExe(['install']);

      // 等待服务在系统中注册
      await new Promise((r) => setTimeout(r, 1500));
      const installed = await this.isInstalled();
      console.log('[CoreService] Post-install check - isInstalled:', installed);

      if (!installed) {
        return {
          success: false,
          error: '服务安装未完成，请以管理员身份重试或检查系统服务管理器'
        };
      }

      // 启动服务
      const startResult = await this.start();
      if (!startResult.success) {
        console.warn('[CoreService] Service installed but failed to start:', startResult.error);
        return {
          success: true,
          message: '服务已安装，但启动失败：' + (startResult.error || '未知错误')
        };
      }

      return {
        success: true,
        message: '服务安装并启动成功'
      };
    } catch (error) {
      console.error('[CoreService] Install failed:', error);
      return { success: false, error: error.message || '服务安装失败' };
    }
  }

  /**
   * 卸载服务
   */
  async uninstall() {
    if (process.platform !== 'win32') {
      return { success: false, error: '仅支持 Windows 平台' };
    }

    try {
      // 检查是否已安装
      if (!(await this.isInstalled())) {
        console.log('[CoreService] Service not installed');
        return { success: true, message: '服务未安装' };
      }

      // 检查管理员权限
      if (!this.isAdmin()) {
        console.log('[CoreService] Not running as admin');
        return {
          success: false,
          error: '卸载服务需要管理员权限，请以管理员身份运行应用程序',
          needsAdmin: true
        };
      }

      // 优先通过 winsw 卸载服务
      const serviceExePath = this.getServiceExePath();
      if (fs.existsSync(serviceExePath)) {
        try {
          await this.runServiceExe(['stop']);
        } catch {
          // 忽略停止失败
        }
        try {
          await this.runServiceExe(['uninstall']);
          console.log('[CoreService] Service uninstalled via winsw');
        } catch (e) {
          console.warn('[CoreService] Failed to uninstall via winsw:', e.message);
        }
      }

      // 作为兜底，使用 sc 删除服务
      const serviceName = this._foundServiceName || this.serviceName;
      try {
        execSync(`sc stop "${serviceName}"`, { stdio: 'pipe' });
      } catch {}
      try {
        execSync(`sc delete "${serviceName}"`, { stdio: 'pipe' });
        console.log('[CoreService] Service deleted via sc:', serviceName);
      } catch (e) {
        console.warn('[CoreService] Failed to delete service via sc:', e.message);
      }

      this._foundServiceName = null;

      return { success: true, message: '服务已卸载' };
    } catch (error) {
      console.error('[CoreService] Uninstall failed:', error);
      return { success: false, error: error.message || '服务卸载失败' };
    }
  }

  /**
   * 启动服务
   */
  async start() {
    if (process.platform !== 'win32') {
      return { success: false, error: '仅支持 Windows 平台' };
    }

    try {
      if (await this.isRunning()) {
        return { success: true, message: '服务已在运行' };
      }

      // 使用已找到的服务名称
      const serviceName = this._foundServiceName || this.serviceName;
      execSync(`sc start "${serviceName}"`, { stdio: 'pipe' });

      // 等待服务启动
      await this.waitForRunning(5000);

      return { success: true, message: '服务已启动' };
    } catch (error) {
      console.error('[CoreService] Start failed:', error);
      return { success: false, error: error.message || '服务启动失败' };
    }
  }

  /**
   * 停止服务
   */
  async stop() {
    if (process.platform !== 'win32') {
      return { success: false, error: '仅支持 Windows 平台' };
    }

    try {
      if (!(await this.isRunning())) {
        return { success: true, message: '服务未在运行' };
      }

      // 使用已找到的服务名称
      const serviceName = this._foundServiceName || this.serviceName;
      execSync(`sc stop "${serviceName}"`, { stdio: 'pipe' });
      return { success: true, message: '服务已停止' };
    } catch (error) {
      console.error('[CoreService] Stop failed:', error);
      return { success: false, error: error.message || '服务停止失败' };
    }
  }

  /**
   * 重启服务
   */
  async restart() {
    await this.stop();
    await new Promise(r => setTimeout(r, 1000));
    return await this.start();
  }

  /**
   * 等待服务运行
   */
  async waitForRunning(timeoutMs = 5000) {
    const start = Date.now();
    const interval = 200;

    while (Date.now() - start < timeoutMs) {
      if (await this.isRunning()) {
        return true;
      }
      await new Promise(r => setTimeout(r, interval));
    }

    return false;
  }

  /**
   * 发送命令到服务
   * @param {string} command - 命令名称
   * @param {Object} payload - 命令参数
   */
  async sendCommand(command, payload = {}) {
    return new Promise((resolve, reject) => {
      const requestId = Date.now().toString(36) + Math.random().toString(36).substring(2);
      const request = {
        id: requestId,
        command,
        payload,
        timestamp: Date.now()
      };

      // 附加共享密钥，用于服务端认证
      const secret = this.getSharedSecret();
      if (secret) {
        request.secret = secret;
      }

      // 优先尝试命名管道
      const client = net.createConnection(this.pipeName, () => {
        client.write(JSON.stringify(request));
      });

      let responseData = '';
      const timeout = setTimeout(() => {
        client.destroy();
        reject(new Error('命令超时'));
      }, 10000);

      client.on('data', (data) => {
        responseData += data.toString();
        try {
          const response = JSON.parse(responseData);
          clearTimeout(timeout);
          client.end();

          if (response.id === requestId) {
            resolve(response);
          } else {
            reject(new Error('响应 ID 不匹配'));
          }
        } catch {
          // 数据未完整，继续等待
        }
      });

      client.on('error', (err) => {
        clearTimeout(timeout);
        // 命名管道失败，尝试 TCP
        this.sendCommandViaTcp(request)
          .then(resolve)
          .catch(() => reject(err));
      });

      client.on('close', () => {
        clearTimeout(timeout);
      });
    });
  }

  /**
   * 通过 TCP 发送命令
   */
  async sendCommandViaTcp(request) {
    return new Promise((resolve, reject) => {
      const client = net.createConnection({ port: this.port, host: '127.0.0.1' }, () => {
        client.write(JSON.stringify(request));
      });

      let responseData = '';
      const timeout = setTimeout(() => {
        client.destroy();
        reject(new Error('TCP 命令超时'));
      }, 10000);

      client.on('data', (data) => {
        responseData += data.toString();
        try {
          const response = JSON.parse(responseData);
          clearTimeout(timeout);
          client.end();
          resolve(response);
        } catch {
          // 数据未完整，继续等待
        }
      });

      client.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  /**
   * 启动 Mihomo 核心
   */
  async startCore(corePath, configPath) {
    try {
      const response = await this.sendCommand('start_core', {
        corePath,
        configPath
      });
      return response.success ? { success: true } : { success: false, error: response.error };
    } catch (error) {
      console.error('[CoreService] startCore failed:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 停止 Mihomo 核心
   */
  async stopCore() {
    try {
      const response = await this.sendCommand('stop_core');
      return response.success ? { success: true } : { success: false, error: response.error };
    } catch (error) {
      console.error('[CoreService] stopCore failed:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 重启 Mihomo 核心
   */
  async restartCore(configPath) {
    try {
      const response = await this.sendCommand('restart_core', { configPath });
      return response.success ? { success: true } : { success: false, error: response.error };
    } catch (error) {
      console.error('[CoreService] restartCore failed:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 获取核心状态
   */
  async getStatus() {
    try {
      const response = await this.sendCommand('get_status');
      return response.success ? { success: true, data: response.data } : { success: false, error: response.error };
    } catch (error) {
      console.error('[CoreService] getStatus failed:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 更新核心配置
   */
  async updateConfig(configPath) {
    try {
      const response = await this.sendCommand('update_config', { configPath });
      return response.success ? { success: true } : { success: false, error: response.error };
    } catch (error) {
      console.error('[CoreService] updateConfig failed:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 检查服务连接
   */
  async checkConnection() {
    try {
      const response = await this.sendCommand('ping');
      return response.success && response.data === 'pong';
    } catch {
      return false;
    }
  }
}

// 创建单例实例
const coreService = new CoreService();

module.exports = {
  CoreService,
  coreService,
  SERVICE_NAME,
  IPC_PIPE_NAME,
  IPC_PORT
};
