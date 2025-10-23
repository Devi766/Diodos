const path = require('path');
const os = require('os');
const { app } = require('electron');

/**
 * 获取 Mihomo IPC Socket 路径
 * Windows: 使用 Named Pipe
 * Unix/Linux/Mac: 使用 Unix Domain Socket
 */
function getMihomoSocketPath() {
  if (process.platform === 'win32') {
    // Windows Named Pipe
    // 格式: \\.\pipe\<name>
    const sessionId = process.env.SESSIONNAME || process.env.USERNAME || 'default';
    const processId = process.pid;
    return `\\\\.\\pipe\\FlyClash\\mihomo-${sessionId}-${processId}`;
  } else {
    // Unix Domain Socket
    // 使用临时目录,确保权限安全
    const uid = process.getuid ? process.getuid() : 'unknown';
    const processId = process.pid;
    return `/tmp/flyclash-mihomo-${uid}-${processId}.sock`;
  }
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
  cleanupSocketFile
};

