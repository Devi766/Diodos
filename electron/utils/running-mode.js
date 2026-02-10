/**
 * 运行模式管理模块
 * 统一管理内核的运行模式
 */

// 运行模式枚举
const RunningMode = {
  SERVICE: 'service',     // 通过 Windows 服务运行
  SIDECAR: 'sidecar',     // 直接启动（sidecar 模式）
  NOT_RUNNING: 'not_running'  // 未运行
};

// 当前运行模式
let currentMode = RunningMode.NOT_RUNNING;

// 服务模式下的固定 pipe 名称
const SERVICE_PIPE_NAME = '\\\\.\\pipe\\flycast-mihomo-service';

/**
 * 获取当前运行模式
 */
function getRunningMode() {
  return currentMode;
}

/**
 * 设置运行模式
 * @param {string} mode - RunningMode 枚举值
 */
function setRunningMode(mode) {
  if (!Object.values(RunningMode).includes(mode)) {
    console.error('[RunningMode] Invalid mode:', mode);
    return;
  }
  const oldMode = currentMode;
  currentMode = mode;
  console.log(`[RunningMode] Mode changed: ${oldMode} -> ${currentMode}`);
}

/**
 * 检查是否正在运行
 */
function isRunning() {
  return currentMode !== RunningMode.NOT_RUNNING;
}

/**
 * 检查是否是服务模式
 */
function isServiceMode() {
  return currentMode === RunningMode.SERVICE;
}

/**
 * 检查是否是 sidecar 模式
 */
function isSidecarMode() {
  return currentMode === RunningMode.SIDECAR;
}

/**
 * 获取当前模式对应的 socket 路径
 */
function getSocketPath() {
  if (currentMode === RunningMode.SERVICE) {
    return SERVICE_PIPE_NAME;
  }

  // Sidecar 模式使用动态路径
  if (process.platform === 'win32') {
    const sessionId = process.env.SESSIONNAME || process.env.USERNAME || 'default';
    const processId = process.pid;
    return `\\\\.\\pipe\\FlyClash\\mihomo-${sessionId}-${processId}`;
  } else {
    const uid = process.getuid ? process.getuid() : 'unknown';
    const processId = process.pid;
    return `/tmp/flyclash-mihomo-${uid}-${processId}.sock`;
  }
}

/**
 * 获取服务模式的固定 socket 路径
 */
function getServiceSocketPath() {
  return SERVICE_PIPE_NAME;
}

/**
 * 获取 sidecar 模式的动态 socket 路径
 */
function getSidecarSocketPath() {
  if (process.platform === 'win32') {
    const sessionId = process.env.SESSIONNAME || process.env.USERNAME || 'default';
    const processId = process.pid;
    return `\\\\.\\pipe\\FlyClash\\mihomo-${sessionId}-${processId}`;
  } else {
    const uid = process.getuid ? process.getuid() : 'unknown';
    const processId = process.pid;
    return `/tmp/flyclash-mihomo-${uid}-${processId}.sock`;
  }
}

module.exports = {
  RunningMode,
  getRunningMode,
  setRunningMode,
  isRunning,
  isServiceMode,
  isSidecarMode,
  getSocketPath,
  getServiceSocketPath,
  getSidecarSocketPath,
  SERVICE_PIPE_NAME
};
