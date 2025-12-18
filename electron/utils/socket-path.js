const path = require('path');
const os = require('os');
const { app } = require('electron');

// 服务模式下使用固定的管道名称
const SERVICE_MODE_PIPE_NAME = '\\\\.\\pipe\\flycast-mihomo-service';
const SERVICE_MODE_SOCKET_PATH = '/tmp/flyclash-mihomo-service.sock';

// 是否使用服务模式（由外部设置）
let useServiceMode = false;

/**
 * 设置是否使用服务模式
 * @param {boolean} enabled
 */
function setServiceMode(enabled) {
  useServiceMode = enabled;
  console.log(`[Socket] 服务模式: ${enabled ? '启用' : '禁用'}`);
}

/**
 * 获取是否使用服务模式
 */
function isServiceMode() {
  return useServiceMode;
}

/**
 * 获取 Mihomo IPC Socket 路径
 * Windows: 使用 Named Pipe
 * Unix/Linux/Mac: 使用 Unix Domain Socket
 */
function getMihomoSocketPath() {
  if (process.platform === 'win32') {
    // Windows Named Pipe
    if (useServiceMode) {
      return SERVICE_MODE_PIPE_NAME;
    }
    // 非服务模式使用进程特定的管道
    const sessionId = process.env.SESSIONNAME || process.env.USERNAME || 'default';
    const processId = process.pid;
    return `\\\\.\\pipe\\FlyClash\\mihomo-${sessionId}-${processId}`;
  } else {
    // Unix Domain Socket
    if (useServiceMode) {
      return SERVICE_MODE_SOCKET_PATH;
    }
    const uid = process.getuid ? process.getuid() : 'unknown';
    const processId = process.pid;
    return `/tmp/flyclash-mihomo-${uid}-${processId}.sock`;
  }
}

/**
 * 获取服务模式下的固定 Socket 路径
 */
function getServiceModeSocketPath() {
  return process.platform === 'win32' ? SERVICE_MODE_PIPE_NAME : SERVICE_MODE_SOCKET_PATH;
}

/**
 * 获取用于 Mihomo 启动参数的控制器路径
 * Mihomo 使用 -ext-ctl-pipe (Windows) 或 -ext-ctl-unix (Unix) 参数
 */
function getMihomoControllerArg() {
  const socketPath = getMihomoSocketPath();
  return socketPath;
}

/**
 * 获取 Mihomo 控制器参数名称
 * Windows: -ext-ctl-pipe
 * Unix/Linux/Mac: -ext-ctl-unix
 */
function getMihomoControllerParam() {
  return process.platform === 'win32' ? '-ext-ctl-pipe' : '-ext-ctl-unix';
}

/**
 * 清理旧的 socket 文件
 * Unix 系统需要手动删除 socket 文件
 */
async function cleanupSocketFile() {
  if (process.platform === 'win32') {
    // Windows Named Pipe 会自动清理
    return;
  }

  const fs = require('fs').promises;
  const socketPath = getMihomoSocketPath();

  try {
    await fs.unlink(socketPath);
    console.log(`[Socket] 清理旧的 socket 文件: ${socketPath}`);
  } catch (error) {
    // 文件不存在或无法删除,忽略错误
    if (error.code !== 'ENOENT') {
      console.warn(`[Socket] 清理 socket 文件失败:`, error.message);
    }
  }
}

module.exports = {
  getMihomoSocketPath,
  getMihomoControllerArg,
  getMihomoControllerParam,
  cleanupSocketFile,
  setServiceMode,
  isServiceMode,
  getServiceModeSocketPath,
  SERVICE_MODE_PIPE_NAME,
  SERVICE_MODE_SOCKET_PATH
};

