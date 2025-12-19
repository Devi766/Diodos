/**
 * FlyClash Helper Service IPC Client
 * 与 Go 编写的轻量级 helper 服务通信
 */

const net = require('net');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { execSync, spawn } = require('child_process');

const PIPE_NAME = '\\\\.\\pipe\\flyclash-helper-service';
const SECRET_SEED = 'flyclash-helper-service-secret-key-v1';
const MESSAGE_EXPIRY_SECS = 30;
const SERVICE_NAME = 'FlyClashHelperService';

// 派生密钥
const secretKey = crypto.createHash('sha256').update(SECRET_SEED).digest();

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function queryServiceOutput(command) {
  try {
    return execSync(command, { stdio: 'pipe', encoding: 'utf8' });
  } catch (err) {
    return null;
  }
}

function parseServiceState(output) {
  if (!output) return null;
  const match = output.match(/STATE\s*:\s*(\d+)\s+(\w+)/i);
  if (!match) return null;
  return { code: Number(match[1]), name: match[2].toUpperCase() };
}

function parseServicePid(output) {
  if (!output) return 0;
  const match = output.match(/PID\s*:\s*(\d+)/i);
  return match ? Number(match[1]) : 0;
}

async function waitForServiceStopped(timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const output = queryServiceOutput(`sc queryex "${SERVICE_NAME}"`);
    if (!output) return true;
    const state = parseServiceState(output);
    if (state && state.name === 'STOPPED') return true;
    await delay(300);
  }
  return false;
}

async function waitForServiceDeleted(timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const output = execSync(`sc query "${SERVICE_NAME}"`, { stdio: 'pipe', encoding: 'utf8' });
      if (!output.includes(SERVICE_NAME)) {
        return true;
      }
    } catch (err) {
      const errOutput = `${err?.stderr || ''}${err?.stdout || ''}`;
      if (/does not exist|1060|marked for deletion|1072/i.test(errOutput)) {
        return true;
      }
    }
    await delay(300);
  }
  return false;
}

/**
 * 生成 HMAC-SHA256 签名
 */
function signMessage(data) {
  const hmac = crypto.createHmac('sha256', secretKey);
  hmac.update(data);
  return hmac.digest('hex');
}

/**
 * 生成唯一请求 ID
 */
function generateRequestId() {
  return crypto.randomBytes(8).toString('hex');
}

/**
 * 发送 IPC 请求
 */
async function sendRequest(command, payload = null) {
  return new Promise((resolve, reject) => {
    const client = net.connect(PIPE_NAME, () => {
      const id = generateRequestId();
      const timestamp = Math.floor(Date.now() / 1000);

      // 构建签名数据
      let signData = `${id}:${timestamp}:${command}`;
      if (payload) {
        signData += ':' + JSON.stringify(payload);
      }
      const signature = signMessage(signData);

      const request = {
        id,
        timestamp,
        command,
        payload: payload || undefined,
        signature
      };

      client.write(JSON.stringify(request) + '\n');
    });

    let data = '';
    client.on('data', (chunk) => {
      data += chunk.toString();
      if (data.includes('\n')) {
        try {
          const response = JSON.parse(data.trim());
          client.end();
          if (response.success) {
            resolve(response);
          } else {
            reject(new Error(response.error || 'Unknown error'));
          }
        } catch (e) {
          client.end();
          reject(new Error('Invalid response format'));
        }
      }
    });

    client.on('error', (err) => {
      reject(err);
    });

    client.setTimeout(10000, () => {
      client.destroy();
      reject(new Error('Connection timeout'));
    });
  });
}

/**
 * 检查 helper 服务是否可用
 */
async function isServiceAvailable() {
  try {
    const response = await sendRequest('get_version');
    return response.success;
  } catch {
    return false;
  }
}

/**
 * 获取服务状态
 */
async function getStatus() {
  const response = await sendRequest('get_status');
  return response.data;
}

/**
 * 获取服务版本
 */
async function getVersion() {
  const response = await sendRequest('get_version');
  return response.data;
}

/**
 * 启动内核
 */
async function startCore(binPath, configDir, configFile, logFile = '', extCtlPipe = '') {
  const payload = {
    bin_path: binPath,
    config_dir: configDir,
    config_file: configFile,
    log_file: logFile
  };
  if (extCtlPipe) {
    payload.ext_ctl_pipe = extCtlPipe;
  }
  return await sendRequest('start_core', payload);
}

/**
 * 停止内核
 */
async function stopCore() {
  return await sendRequest('stop_core');
}

/**
 * 获取 helper 可执行文件路径
 */
function getHelperPath() {
  const { app } = require('electron');

  // 尝试多个可能的路径（按优先级排序）
  const possiblePaths = [
    // 打包后的路径（extraResources）
    path.join(process.resourcesPath || '', 'flyclash-helper.exe'),
    // 开发环境路径
    path.join(app.getAppPath(), 'tools', 'flyclash-helper.exe'),
    path.join(__dirname, '..', '..', 'tools', 'flyclash-helper.exe'),
    path.join(__dirname, '..', '..', 'native', 'helper', 'flyclash-helper.exe'),
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      console.log('[HelperIPC] Found helper at:', p);
      return p;
    }
  }

  console.error('[HelperIPC] Helper not found, searched paths:', possiblePaths);
  return null;
}

/**
 * 检查 Windows 服务是否已安装
 */
function isServiceInstalled() {
  if (process.platform !== 'win32') return false;

  try {
    const output = execSync(`sc query "${SERVICE_NAME}"`, { stdio: 'pipe', encoding: 'utf8' });
    return output.includes(SERVICE_NAME);
  } catch {
    return false;
  }
}

/**
 * 检查 Windows 服务是否正在运行
 */
function isServiceRunning() {
  if (process.platform !== 'win32') return false;

  try {
    const output = execSync(`sc query "${SERVICE_NAME}"`, { stdio: 'pipe', encoding: 'utf8' });
    return output.includes('RUNNING');
  } catch {
    return false;
  }
}

/**
 * 检查是否有管理员权限
 */
function isAdmin() {
  try {
    execSync('net session', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * 安装服务（需要管理员权限）
 */
async function installService() {
  const helperPath = getHelperPath();
  if (!helperPath) {
    return { success: false, error: 'Helper executable not found' };
  }

  // 检查管理员权限
  if (!isAdmin()) {
    return {
      success: false,
      error: '安装服务需要管理员权限，请以管理员身份运行应用程序',
      needsAdmin: true
    };
  }

  return new Promise((resolve, reject) => {
    const child = spawn(helperPath, ['-install'], {
      stdio: 'pipe',
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

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ success: true, message: stdout.trim() || 'Service installed successfully' });
      } else {
        resolve({ success: false, error: stderr.trim() || `Installation failed with exit code: ${code}` });
      }
    });

    child.on('error', (err) => {
      resolve({ success: false, error: err.message });
    });
  });
}

/**
 * 清理所有旧版服务（包括 Electron 版本的服务）
 */
function cleanupLegacyServices() {
  const legacyNames = [
    'FlyClashCoreService',
    'flyclashcoreservice',
    'flyclashcoreservice.exe'
  ];

  for (const name of legacyNames) {
    try {
      execSync(`sc stop "${name}"`, { stdio: 'pipe' });
    } catch {
      // 忽略
    }
    try {
      execSync(`sc delete "${name}"`, { stdio: 'pipe' });
      console.log(`[HelperIPC] Removed legacy service: ${name}`);
    } catch {
      // 忽略
    }
  }
}

/**
 * 卸载服务（需要管理员权限）
 */
async function uninstallService() {
  // 检查管理员权限
  if (!isAdmin()) {
    return {
      success: false,
      error: '卸载服务需要管理员权限，请以管理员身份运行应用程序',
      needsAdmin: true
    };
  }

  // 先清理旧版 Electron 服务
  cleanupLegacyServices();

  if (!isServiceInstalled()) {
    return { success: true, message: 'Service uninstalled successfully' };
  }

  // 使用 sc 命令直接停止和删除新服务（更可靠）
  try {
    execSync(`sc stop "${SERVICE_NAME}"`, { stdio: 'pipe' });
  } catch {
    // 可能未运行，忽略
  }

  const stopped = await waitForServiceStopped(8000);
  if (!stopped) {
    const output = queryServiceOutput(`sc queryex "${SERVICE_NAME}"`);
    const pid = parseServicePid(output);
    if (pid > 0) {
      try {
        execSync(`taskkill /F /PID ${pid}`, { stdio: 'pipe' });
      } catch {
        // 忽略，继续删除
      }
    }
    await waitForServiceStopped(4000);
  }

  // 删除服务
  try {
    execSync(`sc delete "${SERVICE_NAME}"`, { stdio: 'pipe' });
    console.log(`[HelperIPC] Service ${SERVICE_NAME} deleted`);
  } catch (err) {
    // 如果服务不存在也算成功
    try {
      execSync(`sc query "${SERVICE_NAME}"`, { stdio: 'pipe' });
      // 服务还存在，删除失败
      return { success: false, error: `Failed to delete service: ${err.message}` };
    } catch {
      // 服务不存在，算成功
      return { success: true, message: 'Service uninstalled successfully' };
    }
  }

  const deleted = await waitForServiceDeleted(8000);
  if (!deleted) {
    return { success: false, error: '服务删除未完成，请关闭服务管理器后重试或重启系统' };
  }

  return { success: true, message: 'Service uninstalled successfully' };
}

module.exports = {
  isServiceAvailable,
  getStatus,
  getVersion,
  startCore,
  stopCore,
  getHelperPath,
  isServiceInstalled,
  isServiceRunning,
  isAdmin,
  installService,
  uninstallService,
  PIPE_NAME,
  SERVICE_NAME
};
