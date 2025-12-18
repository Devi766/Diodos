/**
 * FlyClash 核心服务工作进程
 * 作为 Windows 服务运行，负责管理 Mihomo 核心进程
 */

const net = require('net');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// 服务配置
const PIPE_NAME = '\\\\.\\pipe\\flycast-core-service';
const TCP_PORT = 19091;

// Mihomo 服务模式下使用的固定管道名称（与主应用保持一致）
const MIHOMO_SERVICE_PIPE_NAME = '\\\\.\\pipe\\flycast-mihomo-service';

// 全局状态
let mihomoProcess = null;
let currentConfigPath = null;
let currentCorePath = null;
let serviceConfig = {};

/**
 * 解析服务配置路径
 * 优先使用环境变量 FLYCAST_SERVICE_CONFIG（兼容旧版本），否则从安装目录的 service 子目录读取
 */
function getServiceConfigPath() {
  const envPath = process.env.FLYCAST_SERVICE_CONFIG;
  if (envPath && fs.existsSync(envPath)) {
    return envPath;
  }

  try {
    const baseDir = process.resourcesPath || path.dirname(process.execPath);
    const candidate = path.join(baseDir, 'service', 'service-config.json');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  } catch {
    // 继续回退
  }

  return null;
}

/**
 * 加载服务配置
 */
function loadConfig() {
  const configPath = getServiceConfigPath();
  if (configPath) {
    try {
      serviceConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      console.log('[ServiceWorker] Config loaded from', configPath, ':', serviceConfig);
    } catch (e) {
      console.error('[ServiceWorker] Failed to load config:', e);
    }
  } else {
    console.warn('[ServiceWorker] Config file not found, running with default config');
  }
}

/**
 * 日志函数
 */
function log(level, message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] [${level}] ${message}`;
  console.log(logMessage);

  // 写入日志文件
  try {
    const logDir = serviceConfig.userDataPath || process.cwd();
    const logFile = path.join(logDir, 'service-worker.log');
    fs.appendFileSync(logFile, logMessage + '\n');
  } catch {}
}

/**
 * 启动 Mihomo 核心
 */
function startCore(corePath, configPath) {
  return new Promise((resolve, reject) => {
    (async () => {
      if (mihomoProcess) {
        log('WARN', 'Mihomo is already running, stopping first...');
        try {
          await stopCore();
          log('INFO', 'Previous Mihomo instance stopped, starting new one...');
        } catch (e) {
          log('ERROR', `Failed to stop existing Mihomo before restart: ${e.message}`);
        }
      }

      if (!corePath || !fs.existsSync(corePath)) {
        reject(new Error('核心文件不存在: ' + corePath));
        return;
      }

      if (!configPath || !fs.existsSync(configPath)) {
        reject(new Error('配置文件不存在: ' + configPath));
        return;
      }

      const configDir = path.dirname(configPath);

      log('INFO', `Starting Mihomo: ${corePath}`);
      log('INFO', `Config dir: ${configDir}`);
      log('INFO', `Config file: ${configPath}`);

      try {
        // 使用命名管道作为 API 通信方式（与主进程一致）
        const args = ['-d', configDir, '-f', configPath, '-ext-ctl-pipe', MIHOMO_SERVICE_PIPE_NAME];

        log('INFO', `Mihomo args: ${args.join(' ')}`);

        mihomoProcess = spawn(corePath, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: false,
          windowsHide: true
        });

        currentCorePath = corePath;
        currentConfigPath = configPath;

        mihomoProcess.stdout.on('data', (data) => {
          log('CORE', data.toString().trim());
        });

        mihomoProcess.stderr.on('data', (data) => {
          log('CORE-ERR', data.toString().trim());
        });

        mihomoProcess.on('error', (err) => {
          log('ERROR', `Mihomo process error: ${err.message}`);
          mihomoProcess = null;
        });

        mihomoProcess.on('exit', (code, signal) => {
          log('INFO', `Mihomo exited with code ${code}, signal ${signal}`);
          mihomoProcess = null;
        });

        // 等待一小段时间确认进程启动
        setTimeout(() => {
          if (mihomoProcess && !mihomoProcess.killed) {
            log('INFO', 'Mihomo started successfully');
            resolve({ success: true, pid: mihomoProcess.pid });
          } else {
            reject(new Error('Mihomo 启动失败'));
          }
        }, 1000);
      } catch (err) {
        log('ERROR', `Failed to start Mihomo: ${err.message}`);
        reject(err);
      }
    })();
  });
}

/**
 * 停止 Mihomo 核心
 */
function stopCore() {
  return new Promise((resolve) => {
    if (!mihomoProcess) {
      log('INFO', 'Mihomo is not running');
      resolve({ success: true });
      return;
    }

    log('INFO', 'Stopping Mihomo...');

    try {
      // Windows 上使用 taskkill 强制终止进程树
      if (process.platform === 'win32') {
        try {
          execSync(`taskkill /pid ${mihomoProcess.pid} /T /F`, { stdio: 'pipe' });
        } catch {}
      } else {
        mihomoProcess.kill('SIGTERM');
      }

      // 等待进程退出
      setTimeout(() => {
        if (mihomoProcess && !mihomoProcess.killed) {
          try {
            mihomoProcess.kill('SIGKILL');
          } catch {}
        }
        mihomoProcess = null;
        currentConfigPath = null;
        log('INFO', 'Mihomo stopped');
        resolve({ success: true });
      }, 1000);
    } catch (err) {
      log('ERROR', `Failed to stop Mihomo: ${err.message}`);
      mihomoProcess = null;
      resolve({ success: false, error: err.message });
    }
  });
}

/**
 * 重启 Mihomo 核心
 */
async function restartCore(configPath) {
  await stopCore();
  await new Promise(r => setTimeout(r, 500));

  const corePath = currentCorePath || serviceConfig.corePath;
  const config = configPath || currentConfigPath;

  if (!corePath) {
    throw new Error('未设置核心路径');
  }

  return await startCore(corePath, config);
}

/**
 * 获取状态
 */
function getStatus() {
  return {
    running: mihomoProcess !== null && !mihomoProcess.killed,
    pid: mihomoProcess?.pid || null,
    corePath: currentCorePath,
    configPath: currentConfigPath
  };
}

/**
 * 处理命令
 */
async function handleCommand(request) {
  const { id, command, payload, secret } = request || {};

  // 如果配置中存在共享密钥，则所有请求必须携带正确的 secret
  if (serviceConfig && serviceConfig.secret) {
    if (!secret || secret !== serviceConfig.secret) {
      log('WARN', `Rejected command ${command || 'unknown'}: invalid auth secret`);
      return {
        id,
        success: false,
        data: null,
        error: 'Unauthorized'
      };
    }
  }

  log('INFO', `Received command: ${command}`);

  try {
    let result;

    switch (command) {
      case 'ping':
        result = { success: true, data: 'pong' };
        break;

      case 'start_core':
        result = await startCore(payload.corePath, payload.configPath);
        break;

      case 'stop_core':
        result = await stopCore();
        break;

      case 'restart_core':
        result = await restartCore(payload?.configPath);
        break;

      case 'get_status':
        result = { success: true, data: getStatus() };
        break;

      case 'update_config':
        if (mihomoProcess && payload?.configPath) {
          currentConfigPath = payload.configPath;
          result = await restartCore(payload.configPath);
        } else {
          result = { success: false, error: '核心未运行或未提供配置路径' };
        }
        break;

      default:
        result = { success: false, error: `未知命令: ${command}` };
    }

    return {
      id,
      success: result.success !== false,
      data: result.data || result,
      error: result.error || null
    };
  } catch (err) {
    log('ERROR', `Command ${command} failed: ${err.message}`);
    return {
      id,
      success: false,
      data: null,
      error: err.message
    };
  }
}

/**
 * 创建 IPC 服务器（命名管道）
 */
function createPipeServer() {
  const server = net.createServer((socket) => {
    log('INFO', 'Client connected to pipe');

    let buffer = '';

    socket.on('data', async (data) => {
      buffer += data.toString();

      // 尝试解析 JSON
      try {
        const request = JSON.parse(buffer);
        buffer = '';

        const response = await handleCommand(request);
        socket.write(JSON.stringify(response));
      } catch (e) {
        // JSON 未完整，继续等待
        if (e instanceof SyntaxError) {
          return;
        }
        log('ERROR', `Pipe data error: ${e.message}`);
      }
    });

    socket.on('error', (err) => {
      log('WARN', `Pipe socket error: ${err.message}`);
    });

    socket.on('close', () => {
      log('INFO', 'Pipe client disconnected');
    });
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      log('WARN', 'Pipe already in use, will retry...');
      setTimeout(() => {
        server.close();
        server.listen(PIPE_NAME);
      }, 1000);
    } else {
      log('ERROR', `Pipe server error: ${err.message}`);
    }
  });

  server.listen(PIPE_NAME, () => {
    log('INFO', `Pipe server listening on ${PIPE_NAME}`);
  });

  return server;
}

/**
 * 创建 TCP 服务器（备选）
 */
function createTcpServer() {
  const server = net.createServer((socket) => {
    log('INFO', 'Client connected to TCP');

    let buffer = '';

    socket.on('data', async (data) => {
      buffer += data.toString();

      try {
        const request = JSON.parse(buffer);
        buffer = '';

        const response = await handleCommand(request);
        socket.write(JSON.stringify(response));
      } catch (e) {
        if (e instanceof SyntaxError) {
          return;
        }
        log('ERROR', `TCP data error: ${e.message}`);
      }
    });

    socket.on('error', (err) => {
      log('WARN', `TCP socket error: ${err.message}`);
    });

    socket.on('close', () => {
      log('INFO', 'TCP client disconnected');
    });
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      log('WARN', `TCP port ${TCP_PORT} already in use`);
    } else {
      log('ERROR', `TCP server error: ${err.message}`);
    }
  });

  server.listen(TCP_PORT, '127.0.0.1', () => {
    log('INFO', `TCP server listening on 127.0.0.1:${TCP_PORT}`);
  });

  return server;
}

/**
 * 清理函数
 */
function cleanup() {
  log('INFO', 'Service worker shutting down...');

  if (mihomoProcess) {
    try {
      if (process.platform === 'win32') {
        execSync(`taskkill /pid ${mihomoProcess.pid} /T /F`, { stdio: 'pipe' });
      } else {
        mihomoProcess.kill('SIGKILL');
      }
    } catch {}
    mihomoProcess = null;
  }

  log('INFO', 'Service worker cleanup complete');
}

/**
 * 主函数
 */
function main() {
  log('INFO', 'FlyClash Core Service Worker starting...');

  // 加载配置
  loadConfig();

  // 创建 IPC 服务器
  const pipeServer = createPipeServer();
  const tcpServer = createTcpServer();

  // 处理进程信号
  process.on('SIGINT', () => {
    cleanup();
    pipeServer.close();
    tcpServer.close();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    cleanup();
    pipeServer.close();
    tcpServer.close();
    process.exit(0);
  });

  process.on('uncaughtException', (err) => {
    log('ERROR', `Uncaught exception: ${err.message}`);
    log('ERROR', err.stack);
  });

  process.on('unhandledRejection', (reason) => {
    log('ERROR', `Unhandled rejection: ${reason}`);
  });

  log('INFO', 'FlyClash Core Service Worker started');
}

// 启动服务
main();
