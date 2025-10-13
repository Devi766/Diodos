const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell, nativeTheme, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execSync, exec } = require('child_process');
const isDev = process.env.NODE_ENV === 'development';
const yaml = require('js-yaml');
const WebSocket = require('ws');
const net = require('net');
const http = require('http');
const serveStatic = require('serve-static');
const finalhandler = require('finalhandler');
const crypto = require('crypto'); // 添加加密模块
const security = require('./security'); // 引入安全模块

// ==================== IPC 通信配置 ====================
// 定义 Mihomo IPC 路径（Unix Socket / Named Pipe）
const mihomoIpcPath = process.platform === 'win32'
  ? '\\\\.\\pipe\\FlyClash\\mihomo'  // Windows Named Pipe
  : '/tmp/flyclash-mihomo.sock';     // Linux/macOS Unix Socket

// IPC 控制参数
const mihomoCtlParam = process.platform === 'win32'
  ? '-ext-ctl-pipe'
  : '-ext-ctl-unix';

// WebSocket 连接管理
let mihomoTrafficWs = null;
let mihomoLogsWs = null;
let mihomoConnectionsWs = null;
let mihomoMemoryWs = null;

// WebSocket 重连计数器
let trafficRetry = 10;
let logsRetry = 10;
let connectionsRetry = 10;
let memoryRetry = 10;

// 增强认证安全性 - 生成主密钥
const MASTER_SECRET = crypto.randomBytes(32).toString('hex');

// 创建会话令牌管理器
const sessionTokenManager = {
  tokens: new Map(),
  
  // 创建新令牌，有效期为5分钟
  createToken: function(windowId) {
    const token = crypto.randomBytes(32).toString('hex');
    const expiry = Date.now() + 5 * 60 * 1000; // 5分钟后过期
    
    this.tokens.set(token, {
      windowId,
      expiry,
      createdAt: Date.now()
    });
    
    // 记录令牌创建（不记录令牌本身，只记录时间和窗口ID）
    console.log(`为窗口ID ${windowId} 创建令牌，过期时间: ${new Date(expiry).toISOString()}`);
    
    return token;
  },
  
  // 验证令牌
  validateToken: function(token, windowId, operation) {
    // 检查令牌是否存在
    if (!this.tokens.has(token)) {
      console.error(`令牌验证失败: 令牌不存在 [操作: ${operation}]`);
      return false;
    }
    
    const tokenData = this.tokens.get(token);
    const now = Date.now();
    
    // 检查是否过期
    if (now > tokenData.expiry) {
      console.error(`令牌验证失败: 令牌已过期 [操作: ${operation}]`);
      this.tokens.delete(token); // 删除过期令牌
      return false;
    }
    
    // 检查窗口ID是否匹配
    if (tokenData.windowId !== windowId) {
      console.error(`令牌验证失败: 窗口ID不匹配 [预期: ${tokenData.windowId}, 实际: ${windowId}, 操作: ${operation}]`);
      security.logSecurityEvent('token-window-mismatch', {
        expectedWindow: tokenData.windowId,
        actualWindow: windowId,
        operation
      }, path.join(userDataPath, 'security.log'));
      return false;
    }
    
    // 验证通过，刷新令牌有效期
    tokenData.expiry = now + 5 * 60 * 1000; // 再延长5分钟
    
    return true;
  },
  
  // 获取当前活跃令牌数
  getActiveTokenCount: function() {
    const now = Date.now();
    let count = 0;
    
    for (const [token, data] of this.tokens.entries()) {
      if (now <= data.expiry) {
        count++;
      } else {
        this.tokens.delete(token); // 自动清理过期令牌
      }
    }
    
    return count;
  },
  
  // 清理特定窗口的所有令牌
  clearWindowTokens: function(windowId) {
    for (const [token, data] of this.tokens.entries()) {
      if (data.windowId === windowId) {
        this.tokens.delete(token);
      }
    }
  },
  
  // 清理所有过期令牌
  cleanup: function() {
    const now = Date.now();
    for (const [token, data] of this.tokens.entries()) {
      if (now > data.expiry) {
        this.tokens.delete(token);
      }
    }
  }
};

// 定期清理过期令牌
setInterval(() => {
  sessionTokenManager.cleanup();
}, 60000); // 每分钟清理一次

// 兼容旧代码，但不再直接使用
const ipcSecret = MASTER_SECRET;

// 导入媒体检测模块
const { testMediaStreaming } = require('./mediatest');

// 修改应用的appName，确保保存在Roaming目录下的文件夹名为flyclash
app.name = 'flyclash';

// 应用版本号 - 统一管理所有界面显示的版本
const APP_VERSION = '0.1.6';

// 全局变量
let mainWindow;
let tray;
let mihomoProcess;
let configFilePath;
let isQuitting = false;
let autoStartEnabled = true; // 默认启用自动启动
let currentNode = null;

// 连接管理相关变量（⚠️ connectionsRetry 已移至顶部 IPC 配置区）
let connectionsWebSocket = null;
let lastConnectionsInfo = {
  downloadTotal: 0,
  uploadTotal: 0,
  connections: [],
  memory: 0,
  currentNode: null,
  activeConnections: 0
};

// 设置用户数据路径
const userDataPath = app.getPath('userData');
console.log('用户数据路径:', userDataPath);

// 配置目录
const configDir = path.join(userDataPath, 'config');

// 安全日志
try {
  const securityLogPath = path.join(userDataPath, 'security.log');
  if (!fs.existsSync(securityLogPath)) {
    fs.writeFileSync(securityLogPath, '# 安全日志\n', 'utf8');
  }
} catch (error) {
  console.error('创建安全日志文件失败:', error);
}

// 默认内核路径（可被用户覆盖）
const DEFAULT_KERNEL_RELATIVE_PATH = path.join('cores', 'mihomo-windows-amd64.exe');

function getDefaultKernelPath() {
  const resourceKernel = path.join(process.resourcesPath, DEFAULT_KERNEL_RELATIVE_PATH);
  if (fs.existsSync(resourceKernel)) {
    return resourceKernel;
  }

  const devKernel = path.join(__dirname, '..', DEFAULT_KERNEL_RELATIVE_PATH);
  return devKernel;
}

function getKernelExecutablePath() {
  const settings = getUserSettings();
  const configuredPath = settings.kernelPath;
  if (configuredPath && typeof configuredPath === 'string' && configuredPath.trim().length > 0) {
    return configuredPath;
  }
  return getDefaultKernelPath();
}

function updateKernelExecutablePath(newPath) {
  updateUserSettings({ kernelPath: newPath });
}

// 确保配置目录存在
if (!fs.existsSync(configDir)) {
  fs.mkdirSync(configDir, { recursive: true });
}

// 用户设置配置文件路径
const userSettingsPath = path.join(userDataPath, 'user-settings.yaml');

// 确保用户设置文件存在，如果不存在则创建
function ensureUserSettingsFile() {
  if (!fs.existsSync(userSettingsPath)) {
    // 生成一个强密钥（32位随机字符串）
    const generateSecretKey = () => {
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()-_=+';
      let result = '';
      const length = 32;
      const crypto = require('crypto');
      
      // 使用加密安全的随机数生成器
      const randomBytes = crypto.randomBytes(length);
      for (let i = 0; i < length; i++) {
        result += chars[randomBytes[i] % chars.length];
      }
      
      return result;
    };
    
    // 默认设置
    const defaultSettings = {
      'mixed-port': 7890,
      'allow-lan': false,
      'ipv6': false,
      'subscription-ua': 'MihomoParty',
      'secret': generateSecretKey(), // 自动生成的安全密钥
      'kernelPath': getDefaultKernelPath()
    };
    
    try {
      fs.writeFileSync(userSettingsPath, yaml.dump(defaultSettings), 'utf8');
      console.log('已创建用户设置文件，并生成安全密钥:', userSettingsPath);
    } catch (error) {
      console.error('创建用户设置文件失败:', error);
    }
  }
}

// 读取用户设置
function getUserSettings() {
  try {
    ensureUserSettingsFile();
    const content = fs.readFileSync(userSettingsPath, 'utf8');
    return yaml.load(content) || {};
  } catch (error) {
    console.error('读取用户设置失败:', error);
    return {};
  }
}

// 更新用户设置
function updateUserSettings(settings) {
  try {
    ensureUserSettingsFile();
    const currentSettings = getUserSettings();
    
    // 验证新设置
    if ('mixed-port' in settings) {
      if (typeof settings['mixed-port'] !== 'number' || 
          settings['mixed-port'] < 1 || settings['mixed-port'] > 65535) {
        console.warn('端口号无效，将使用默认值');
        settings['mixed-port'] = 7890;
      }
    }
    
    // 转换布尔型字段
    for (const key of ['allow-lan', 'ipv6']) {
      if (key in settings) {
        settings[key] = Boolean(settings[key]);
      }
    }
    
    const newSettings = { ...currentSettings, ...settings };
    fs.writeFileSync(userSettingsPath, yaml.dump(newSettings), 'utf8');
    console.log('已更新用户设置:', newSettings);
    
    // 如果mihomo正在运行，重新生成并重载配置
    if (mihomoProcess && mihomoProcess.pid && configFilePath) {
      // 重新生成合并配置并热重载
      regenerateAndReloadConfig();
    }
    
    return true;
  } catch (error) {
    console.error('更新用户设置失败:', error);
    return false;
  }
}

// 流量统计相关变量
let lastTrafficStats = {
  up: 0,
  down: 0,
  upSpeed: 0,
  downSpeed: 0,
  timestamp: Date.now()
};

// WebSocket连接（⚠️ trafficRetry 已移至顶部 IPC 配置区）
let trafficWebSocket = null;
let lastValidStats = null;  // 用于存储最后一次有效的流量数据
let lastConnectionsFetchTime = 0; // 用于限制连接信息获取频率

// 限制历史记录数量
const MAX_TRAFFIC_HISTORY = 50;
let trafficHistory = [];

// 格式化流量数据
function formatTraffic(bytes) {
  if (bytes === 0) return '0 B';
  
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let size = bytes;
  
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i++;
  }
  
  return `${size.toFixed(2)} ${units[i]}`;
}

// 格式化速度
function formatSpeed(bytesPerSecond) {
  if (bytesPerSecond === 0) return '0 B/s';
  
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  let i = 0;
  let speed = bytesPerSecond;
  
  while (speed >= 1024 && i < units.length - 1) {
    speed /= 1024;
    i++;
  }
  
  return `${speed.toFixed(2)} ${units[i]}`;
}

// 添加一个统一的mihomo API请求函数，自动添加密钥认证头
// ==================== 基于 IPC 的 Mihomo API 请求函数 ====================
async function fetchMihomoAPI(endpoint, options = {}) {
  return new Promise((resolve, reject) => {
    try {
      // 解析 endpoint
      const url = new URL(endpoint.startsWith('http') ? endpoint : `http://localhost${endpoint.startsWith('/') ? endpoint : '/' + endpoint}`);
      const path = url.pathname + url.search;
      const method = options.method || 'GET';

      // 获取密钥（保持兼容性）
      const userSecret = getUserSettings()['secret'] || '';

      // 准备请求头
      const headers = {
        'Content-Type': 'application/json',
        ...options.headers
      };

      // 如果有密钥，添加认证头
      if (userSecret) {
        headers['Authorization'] = `Bearer ${userSecret}`;
      }

      // 如果有请求体，添加 Content-Length
      let body = null;
      if (options.body) {
        body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
        headers['Content-Length'] = Buffer.byteLength(body);
      }

      // 创建 HTTP 请求选项（通过 Unix Socket）
      const requestOptions = {
        socketPath: mihomoIpcPath,  // 🔑 关键！使用 IPC 路径
        path: path,
        method: method,
        headers: headers,
        timeout: options.timeout || 15000
      };

      console.log(`[IPC] ${method} ${path}`);

      // 发送请求
      const req = http.request(requestOptions, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          // 模拟 fetch Response 对象
          const response = {
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            statusText: res.statusMessage,
            headers: res.headers,
            json: async () => JSON.parse(data),
            text: async () => data
          };

          if (!response.ok) {
            reject(new Error(`请求失败: ${res.statusCode} ${res.statusMessage}`));
          } else {
            resolve(response);
          }
        });
      });

      req.on('error', (error) => {
        console.error('[IPC] 请求失败:', error);
        reject(error);
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('请求超时'));
      });

      // 发送请求体
      if (body) {
        req.write(body);
      }

      req.end();
    } catch (error) {
      console.error('[IPC] Mihomo API请求失败:', error);
      reject(error);
    }
  });
}

// ==================== WebSocket 实时监控功能 ====================

// 启动流量监控 WebSocket
function startTrafficWebSocket() {
  if (mihomoTrafficWs) {
    mihomoTrafficWs.removeAllListeners();
    if (mihomoTrafficWs.readyState === WebSocket.OPEN) {
      mihomoTrafficWs.close();
    }
  }

  try {
    const wsUrl = `ws+unix:${mihomoIpcPath}:/traffic`;
    console.log('[IPC-WS] 连接流量监控:', wsUrl);

    mihomoTrafficWs = new WebSocket(wsUrl);

    mihomoTrafficWs.on('open', () => {
      console.log('[IPC-WS] 流量监控已连接');
      trafficRetry = 10;
    });

    mihomoTrafficWs.on('message', (data) => {
      try {
        const stats = JSON.parse(data.toString());
        if (mainWindow) {
          mainWindow.webContents.send('traffic-update', stats);
        }
      } catch (error) {
        console.error('[IPC-WS] 流量数据解析失败:', error);
      }
    });

    mihomoTrafficWs.on('close', () => {
      console.log('[IPC-WS] 流量监控连接关闭');
      if (trafficRetry > 0) {
        trafficRetry--;
        setTimeout(() => startTrafficWebSocket(), 2000);
      }
    });

    mihomoTrafficWs.on('error', (error) => {
      console.error('[IPC-WS] 流量监控错误:', error.message);
    });
  } catch (error) {
    console.error('[IPC-WS] 创建流量监控失败:', error);
  }
}

// 启动日志监控 WebSocket
function startLogsWebSocket() {
  if (mihomoLogsWs) {
    mihomoLogsWs.removeAllListeners();
    if (mihomoLogsWs.readyState === WebSocket.OPEN) {
      mihomoLogsWs.close();
    }
  }

  try {
    const userSettings = getUserSettings();
    const logLevel = userSettings['log-level'] || 'info';
    const wsUrl = `ws+unix:${mihomoIpcPath}:/logs?level=${logLevel}`;
    console.log('[IPC-WS] 连接日志监控:', wsUrl);

    mihomoLogsWs = new WebSocket(wsUrl);

    mihomoLogsWs.on('open', () => {
      console.log('[IPC-WS] 日志监控已连接');
      logsRetry = 10;
    });

    mihomoLogsWs.on('message', (data) => {
      try {
        const logInfo = JSON.parse(data.toString());
        if (mainWindow) {
          mainWindow.webContents.send('mihomo-log', logInfo);
        }
      } catch (error) {
        console.error('[IPC-WS] 日志数据解析失败:', error);
      }
    });

    mihomoLogsWs.on('close', () => {
      console.log('[IPC-WS] 日志监控连接关闭');
      if (logsRetry > 0) {
        logsRetry--;
        setTimeout(() => startLogsWebSocket(), 2000);
      }
    });

    mihomoLogsWs.on('error', (error) => {
      console.error('[IPC-WS] 日志监控错误:', error.message);
    });
  } catch (error) {
    console.error('[IPC-WS] 创建日志监控失败:', error);
  }
}

// 启动连接监控 WebSocket
function startConnectionsWebSocket() {
  if (mihomoConnectionsWs) {
    mihomoConnectionsWs.removeAllListeners();
    if (mihomoConnectionsWs.readyState === WebSocket.OPEN) {
      mihomoConnectionsWs.close();
    }
  }

  try {
    const wsUrl = `ws+unix:${mihomoIpcPath}:/connections`;
    console.log('[IPC-WS] 连接监控:', wsUrl);

    mihomoConnectionsWs = new WebSocket(wsUrl);

    mihomoConnectionsWs.on('open', () => {
      console.log('[IPC-WS] 连接监控已连接');
      connectionsRetry = 10;
    });

    mihomoConnectionsWs.on('message', (data) => {
      try {
        const connectionsInfo = JSON.parse(data.toString());
        if (mainWindow) {
          mainWindow.webContents.send('connections-update', connectionsInfo);
        }
      } catch (error) {
        console.error('[IPC-WS] 连接数据解析失败:', error);
      }
    });

    mihomoConnectionsWs.on('close', () => {
      console.log('[IPC-WS] 连接监控关闭');
      if (connectionsRetry > 0) {
        connectionsRetry--;
        setTimeout(() => startConnectionsWebSocket(), 2000);
      }
    });

    mihomoConnectionsWs.on('error', (error) => {
      console.error('[IPC-WS] 连接监控错误:', error.message);
    });
  } catch (error) {
    console.error('[IPC-WS] 创建连接监控失败:', error);
  }
}

// 启动内存监控 WebSocket
function startMemoryWebSocket() {
  if (mihomoMemoryWs) {
    mihomoMemoryWs.removeAllListeners();
    if (mihomoMemoryWs.readyState === WebSocket.OPEN) {
      mihomoMemoryWs.close();
    }
  }

  try {
    const wsUrl = `ws+unix:${mihomoIpcPath}:/memory`;
    console.log('[IPC-WS] 连接内存监控:', wsUrl);

    mihomoMemoryWs = new WebSocket(wsUrl);

    mihomoMemoryWs.on('open', () => {
      console.log('[IPC-WS] 内存监控已连接');
      memoryRetry = 10;
    });

    mihomoMemoryWs.on('message', (data) => {
      try {
        const memoryInfo = JSON.parse(data.toString());
        if (mainWindow) {
          mainWindow.webContents.send('memory-update', memoryInfo);
        }
      } catch (error) {
        console.error('[IPC-WS] 内存数据解析失败:', error);
      }
    });

    mihomoMemoryWs.on('close', () => {
      console.log('[IPC-WS] 内存监控连接关闭');
      if (memoryRetry > 0) {
        memoryRetry--;
        setTimeout(() => startMemoryWebSocket(), 2000);
      }
    });

    mihomoMemoryWs.on('error', (error) => {
      console.error('[IPC-WS] 内存监控错误:', error.message);
    });
  } catch (error) {
    console.error('[IPC-WS] 创建内存监控失败:', error);
  }
}

// 启动所有 WebSocket 监控
function startAllWebSockets() {
  console.log('[IPC-WS] 启动所有实时监控...');

  // 延迟启动，确保 Mihomo 已完全启动
  setTimeout(() => {
    startTrafficWebSocket();
    startLogsWebSocket();
    startConnectionsWebSocket();
    startMemoryWebSocket();
  }, 2000);
}

// 停止所有 WebSocket 监控
function stopAllWebSockets() {
  console.log('[IPC-WS] 停止所有实时监控...');

  if (mihomoTrafficWs) {
    mihomoTrafficWs.removeAllListeners();
    mihomoTrafficWs.close();
    mihomoTrafficWs = null;
  }

  if (mihomoLogsWs) {
    mihomoLogsWs.removeAllListeners();
    mihomoLogsWs.close();
    mihomoLogsWs = null;
  }

  if (mihomoConnectionsWs) {
    mihomoConnectionsWs.removeAllListeners();
    mihomoConnectionsWs.close();
    mihomoConnectionsWs = null;
  }

  if (mihomoMemoryWs) {
    mihomoMemoryWs.removeAllListeners();
    mihomoMemoryWs.close();
    mihomoMemoryWs = null;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
    frame: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: nativeTheme.shouldUseDarkColors ? '#1a1a1a' : '#f9f9f9',
      symbolColor: nativeTheme.shouldUseDarkColors ? '#f3f4f6' : '#000000',
      height: 48
    },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1f2937' : '#ffffff'
  });
  
  // 记录主窗口ID，用于令牌验证
  const mainWindowId = mainWindow.id;
  console.log(`主窗口创建，ID: ${mainWindowId}`);

  // 监听系统主题变化
  nativeTheme.on('updated', () => {
    mainWindow.setTitleBarOverlay({
      color: nativeTheme.shouldUseDarkColors ? '#1a1a1a' : '#f9f9f9',
      symbolColor: nativeTheme.shouldUseDarkColors ? '#f3f4f6' : '#000000',
      height: 48
    });
  });

  // 开发环境使用localhost:3000
  if (isDev) {
    const startUrl = 'http://localhost:3000';
  mainWindow.loadURL(startUrl);
  } else {
    // 生产环境使用内部HTTP服务器提供页面
    loadPageWithServer('');
  }

  // 确保CSS加载正确
  mainWindow.webContents.on('did-finish-load', () => {
    if (!isDev) {
      try {
        // 尝试注入正确的CSS路径
        const cssDir = path.join(__dirname, '../out/_next/static/css');
        const cssFiles = fs.readdirSync(cssDir);
        if (cssFiles.length > 0) {
          const cssContent = fs.readFileSync(path.join(cssDir, cssFiles[0]), 'utf8');
          mainWindow.webContents.insertCSS(cssContent)
            .catch(err => console.error('注入CSS内容失败:', err));
        } else {
          console.error('没有找到CSS文件');
        }
      } catch (error) {
        console.error('CSS注入过程中出错:', error);
      }
    }
  });

  // 处理导航请求
  ipcMain.handle('loadPage', async (event, pageName) => {
    try {
      console.log(`切换到页面: ${pageName}`);
      
      // 在开发模式下使用localhost:3000
      if (isDev) {
        await mainWindow.loadURL(`http://localhost:3000/${pageName}`);
        return { success: true };
      }

      // 生产模式 - 使用共享的HTTP服务器函数
      await loadPageWithServer(pageName);
      
      return { success: true };
    } catch (error) {
      console.error('加载页面失败:', error);
      return { success: false, error: error.message };
    }
  });

  if (isDev) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    
    // 通知渲染进程当前主题状态
    try {
      const currentTheme = nativeTheme.themeSource === 'system' 
        ? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
        : nativeTheme.themeSource;
      mainWindow.webContents.send('theme-changed', currentTheme);
      console.log('已通知渲染进程当前主题:', currentTheme);
    } catch (error) {
      console.error('通知主题状态失败:', error);
    }
    
    // 自动启动Mihomo
    if (autoStartEnabled) {
      setTimeout(autoStartMihomo, 1000);
    }
  });

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    } else {
      // 清理窗口相关的所有会话令牌
      sessionTokenManager.clearWindowTokens(mainWindow.id);
    }
  });

  // 添加窗口事件监听器
  mainWindow.on('minimize', () => {
    console.log('[调试] 窗口最小化，降低更新频率');
    // 暂停或减慢更新频率
    stopTrafficStatsUpdate();
    // 改为低频率更新
    trafficStatsInterval = setInterval(() => {
      updateTrafficStats();
    }, 10000); // 每10秒更新一次
  });

  mainWindow.on('restore', () => {
    console.log('[调试] 窗口恢复，恢复正常更新频率');
    // 恢复正常更新频率
    stopTrafficStatsUpdate();
    startTrafficStatsUpdate();
  });
}

// 启动mihomo
async function startMihomo(configPath) {
  try {
    // 验证配置文件路径
    const pathValidation = security.validateFilePath(configPath);
    if (!pathValidation.valid) {
      console.error('配置文件路径验证失败:', pathValidation.error);
      dialog.showErrorBox('安全错误', `配置文件路径无效: ${pathValidation.error}`);
      return false;
    }
    
    // 检查文件是否存在
    if (!fs.existsSync(configPath)) {
      throw new Error(`配置文件不存在: ${configPath}`);
    }

    // 解析配置文件，获取API配置信息
    const configData = parseConfigFile(configPath);
    if (configData) {
      // 获取代理组和代理节点信息
      console.log('已解析配置文件，包含代理组：', configData.proxyGroups.length);
      console.log('已解析配置文件，包含代理节点：', configData.proxies.length);
    }

    // 使用固定的控制器地址和端口，但从用户设置中获取密钥
    const userSettings = getUserSettings();
    // 确保密钥存在，如果不存在则更新设置生成一个新密钥
    if (!userSettings['secret']) {
      const crypto = require('crypto');
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()-_=+';
      let secretKey = '';
      const length = 32;
      
      // 使用加密安全的随机数生成器
      const randomBytes = crypto.randomBytes(length);
      for (let i = 0; i < length; i++) {
        secretKey += chars[randomBytes[i] % chars.length];
      }
      
      // 更新用户设置
      updateUserSettings({ 'secret': secretKey });
      console.log('已生成并设置新的mihomo通信密钥');
    }
    
    activeApiConfig = {
      controllerHost: '127.0.0.1',  // 服务器监听本地接口
      controllerPort: '9090',
      secret: userSettings['secret'] || '' // 从用户设置中获取密钥
    };
    console.log('已设置API配置:', activeApiConfig);

    if (mihomoProcess) {
      mihomoProcess.kill();
    }

    configFilePath = configPath;
    
    // 确保mihomo数据文件准备好
    try {
      await ensureMihomoDataFiles();
    } catch (error) {
      console.error('准备mihomo数据文件失败，但将继续尝试启动:', error);
    }
    
    // 获取当前配置的Mihomo内核路径
    const binPath = getKernelExecutablePath();

    // 验证可执行文件路径
    const binPathValidation = security.validateFilePath(binPath);
    if (!binPathValidation.valid) {
      console.error('内核文件路径验证失败:', binPathValidation.error);
      dialog.showErrorBox('安全错误', `内核文件路径无效: ${binPathValidation.error}`);
      return false;
    }

    if (!fs.existsSync(binPath)) {
      console.error('未找到有效的内核文件:', binPath);
      dialog.showErrorBox('内核文件缺失', `无法找到有效的内核文件\n当前路径: ${binPath}\n请在设置中重新选择或恢复默认内核`);
      return false;
    }
    
    console.log('使用内核文件:', binPath);

    try {
      // 确保配置文件存在
      if (!fs.existsSync(configPath)) {
        dialog.showErrorBox('错误', `配置文件不存在: ${configPath}`);
        return false;
      }

      // 创建mihomo工作目录
      const mihomoDir = path.join(userDataPath, 'mihomo');
      if (!fs.existsSync(mihomoDir)) {
        fs.mkdirSync(mihomoDir, { recursive: true });
      }
      
      // 确认工作目录有写权限
      try {
        const testFile = path.join(mihomoDir, 'test_write_permission.txt');
        fs.writeFileSync(testFile, 'test');
        fs.unlinkSync(testFile);
        console.log('工作目录写权限正常');
      } catch (error) {
        console.error('工作目录写权限不足:', error);
        dialog.showErrorBox('权限错误', `Mihomo工作目录没有写权限: ${error.message}`);
        return false;
      }

      // 读取用户设置
      const userSettings = getUserSettings();
      console.log('已读取用户设置:', userSettings);

      // 读取原始配置
      const configFilename = path.basename(configPath);
      let configContent = fs.readFileSync(configPath, 'utf8');
      
      // 尝试解析配置文件
      let config;
      try {
        config = yaml.load(configContent);
      } catch (error) {
        console.error('配置文件解析失败:', error);
        dialog.showErrorBox('配置文件错误', `配置文件格式无效: ${error.message}`);
        return false;
      }

      // 验证配置
      const configValidation = security.validateProxyConfig(config);
      if (!configValidation.valid) {
        console.error('配置验证失败:', configValidation.error);
        dialog.showErrorBox('配置安全错误', configValidation.error);
        return false;
      }

      // 创建配置文件（IPC 模式下必须命名为 config.yaml）
      // 参考 mihomo-party 实现：IPC 模式不使用 -f 参数，配置文件固定为工作目录下的 config.yaml
      const overrideConfigPath = path.join(mihomoDir, 'config.yaml');
      
      // 使用深度合并替换原来的浅合并
      let mergedConfig, mergedConfigContent;
      
      try {
        // 智能合并配置（用户设置优先级更高）
        mergedConfig = deepMergeConfig(config, userSettings);
        // 验证合并后的配置
        mergedConfig = validateMergedConfig(mergedConfig);
        // 强制覆盖API控制器设置，确保始终可访问，但保留用户设置的密钥
        mergedConfig['external-controller'] = '0.0.0.0:9090';
        // 使用用户设置的密钥（如果存在）
        if (userSettings['secret']) {
          mergedConfig['secret'] = userSettings['secret'];
        }
        mergedConfigContent = yaml.dump(mergedConfig);
      } catch (error) {
        console.error('配置合并失败:', error);
        
        // 使用安全的回退配置
        const safeConfig = {
          ...config,
          'mixed-port': userSettings['mixed-port'] || 7890,
          'allow-lan': !!userSettings['allow-lan'],
          'ipv6': !!userSettings['ipv6'],
          'log-level': userSettings['log-level'] || 'info',
          'external-controller': '0.0.0.0:9090',
          'secret': userSettings['secret'] || '' // 使用用户设置的密钥
        };
        
        mergedConfig = safeConfig;
        mergedConfigContent = yaml.dump(safeConfig);
        console.log('使用安全的回退配置');
      }
      
      // 保存合并后的配置
      fs.writeFileSync(overrideConfigPath, mergedConfigContent, 'utf8');
      console.log(`已创建高优先级配置文件: ${overrideConfigPath}`);

      // 记录启动信息
      console.log(`启动Mihomo: ${binPath} -f ${overrideConfigPath}`);
      console.log(`工作目录: ${mihomoDir}`);

      // 验证配置文件内容
      try {
        // 这些检查已经在validateMergedConfig中处理，这里是额外的安全检查
        if (!mergedConfig.proxies || !Array.isArray(mergedConfig.proxies)) {
          dialog.showErrorBox('配置错误', '配置文件缺少必要的proxies字段');
          return false;
        }

        if (!mergedConfig['proxy-groups'] || !Array.isArray(mergedConfig['proxy-groups'])) {
          dialog.showErrorBox('配置错误', '配置文件缺少必要的proxy-groups字段');
          return false;
        }

        // 检查代理组是否为空
        if (mergedConfig['proxy-groups'].length === 0) {
          console.warn('警告: 配置文件中的代理组为空');
          // 不返回false，允许继续尝试启动
        }

        // 检查代理是否为空
        if (mergedConfig.proxies.length === 0) {
          console.warn('警告: 配置文件中没有代理节点');
          // 不返回false，允许继续尝试启动
        }
      } catch (error) {
        console.error('配置文件验证失败:', error);
        dialog.showErrorBox('配置文件错误', `解析配置文件失败: ${error.message}`);
        return false;
      }

      // 记录启动事件
      security.logSecurityEvent('mihomo-start', {
        binPath,
        configPath: overrideConfigPath,
        workingDir: mihomoDir
      }, path.join(userDataPath, 'security.log'));

      // 清理旧的 IPC 文件（如果存在）
      if (process.platform !== 'win32') {
        try {
          if (fs.existsSync(mihomoIpcPath)) {
            fs.unlinkSync(mihomoIpcPath);
            console.log('[IPC] 已清理旧的 Unix Socket 文件');
          }
        } catch (error) {
          console.warn('[IPC] 清理 Unix Socket 文件失败:', error.message);
        }
      }

      // 安全启动mihomo，使用 IPC 模式
      // 参考 mihomo-party 实现：IPC 模式下不使用 -f 参数，会自动读取工作目录下的 config.yaml
      const args = [
        '-d', mihomoDir,    // 工作目录（包含 config.yaml）
        mihomoCtlParam,     // IPC 控制参数 (-ext-ctl-unix 或 -ext-ctl-pipe)
        mihomoIpcPath       // IPC 路径
      ];

      console.log(`[IPC] 启动参数: ${args.join(' ')}`);

      mihomoProcess = spawn(binPath, args, {
        cwd: mihomoDir,
        env: {
          ...process.env,
          MIHOMO_CORE_PATH: mihomoDir
        },
        windowsHide: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false // 确保不使用shell执行
      });
      
      mihomoProcess.stdout.on('data', (data) => {
        const logContent = data.toString();
        console.log(`mihomo stdout: ${logContent}`);

        // 检查 IPC 是否成功启动（参考 mihomo-party 实现）
        const ipcStartedWindows = logContent.includes('RESTful API pipe listening at');
        const ipcStartedUnix = logContent.includes('RESTful API unix listening at');

        if (ipcStartedWindows || ipcStartedUnix) {
          console.log('[IPC] ✓ Mihomo IPC 模式启动成功！');
          console.log(`[IPC] 监听地址: ${mihomoIpcPath}`);
        }

        // 检查 IPC 启动失败
        const ipcErrorWindows = logContent.includes('External controller pipe listen error');
        const ipcErrorUnix = logContent.includes('External controller unix listen error');

        if (ipcErrorWindows || ipcErrorUnix) {
          console.error('[IPC] ✗ Mihomo IPC 启动失败！');
          console.error('[IPC] 错误信息:', logContent);
        }

        // 检查是否有配置相关日志
        if (logContent.includes('Config') || logContent.includes('allow-lan')) {
          console.log('发现配置相关日志:', logContent);
        }

        if (mainWindow) {
          mainWindow.webContents.send('mihomo-log', logContent);
        }

        // 直接输出到控制台/终端
        process.stdout.write(data);
      });

      mihomoProcess.stderr.on('data', (data) => {
        console.error(`mihomo stderr: ${data}`);
        if (mainWindow) {
          mainWindow.webContents.send('mihomo-error', data.toString());
        }
        
        // 直接输出到控制台/终端
        process.stderr.write(data);
      });

      mihomoProcess.on('close', (code) => {
        console.log(`mihomo process exited with code ${code}`);
        // 使用集中处理函数处理mihomo进程退出
        handleMihomoProcessExit(code);
      });

      // 检查进程是否成功启动
      await new Promise(resolve => setTimeout(resolve, 1000));
      if (mihomoProcess && mihomoProcess.exitCode !== null) {
        console.error(`Mihomo立即退出，退出代码: ${mihomoProcess.exitCode}`);
        dialog.showErrorBox('启动失败', `Mihomo启动后立即退出，退出代码: ${mihomoProcess.exitCode}`);
        return false;
      }

      // 启动成功后保存这个配置文件作为最后使用的配置
      try {
        const lastConfigPath = path.join(userDataPath, 'last-config.json');
        fs.writeFileSync(lastConfigPath, JSON.stringify({ path: configPath }, null, 2), 'utf8');
        console.log('已将此配置设为最后使用的配置:', configPath);
      } catch (saveError) {
        console.error('保存最后使用的配置失败:', saveError);
        // 继续执行，这不是致命错误
      }
      
      if (mihomoProcess) {
        startTrafficStatsUpdate();

        // 启动所有 WebSocket 实时监控
        startAllWebSockets();
      }

      return true;
    } catch (error) {
      console.error('Failed to start mihomo:', error);
      dialog.showErrorBox('启动失败', `无法启动Mihomo: ${error.message}`);
      return false;
    }
  } catch (error) {
    console.error('启动Mihomo时出错:', error);
    return false;
  }
}

function setupTray() {
  // 尝试多个可能的图标路径
  let iconPath = null;
  const possiblePaths = [
    // 开发环境路径
    isDev ? path.join(__dirname, '../public/favicon.ico') : null,
    // 生产环境首选路径
    !isDev ? path.join(process.resourcesPath, 'public/favicon.ico') : null,
    // 备选路径 - 直接在 resources 下
    !isDev ? path.join(process.resourcesPath, 'favicon.ico') : null,
    // 应用程序目录下
    !isDev ? path.join(app.getAppPath(), 'public/favicon.ico') : null,
    // out 目录下
    !isDev ? path.join(app.getAppPath(), 'out/favicon.ico') : null
  ].filter(Boolean); // 过滤掉 null 值
  
  // 尝试每个路径，直到找到存在的图标文件
  for (const tryPath of possiblePaths) {
    if (fs.existsSync(tryPath)) {
      iconPath = tryPath;
      console.log(`找到托盘图标: ${iconPath}`);
      break;
    }
  }
  
  // 如果所有路径都不存在，使用第一个路径作为默认值
  if (!iconPath) {
    iconPath = possiblePaths[0];
    console.warn(`警告: 未找到托盘图标文件，使用默认路径: ${iconPath}`);
  }
  
  try {
    tray = new Tray(iconPath);
    updateTrayMenu();
    tray.on('click', () => {
      mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
    });
  } catch (error) {
    console.error('设置托盘图标失败:', error);
    // 尝试在没有图标的情况下创建托盘
    try {
      console.log('尝试在没有图标的情况下创建托盘...');
      tray = new Tray(nativeImage.createEmpty());
      updateTrayMenu();
    } catch (fallbackError) {
      console.error('无法创建托盘:', fallbackError);
    }
  }
}

// 更新托盘菜单，包括节点列表
async function updateTrayMenu() {
  if (!tray) return;
  
  try {
    // 获取当前代理状态
    let proxyEnabled = systemProxyEnabled;
    
    // 基础菜单项
    const menuItems = [
      { label: '显示主窗口', click: () => mainWindow.show() },
      { type: 'separator' },
      { label: '启用系统代理', type: 'checkbox', checked: proxyEnabled, click: toggleSystemProxy },
      { label: '启用TUN模式', type: 'checkbox', checked: tunModeEnabled, click: toggleTunMode },
      { 
        label: '断开所有连接', 
        click: async () => {
          try {
            if (!activeApiConfig) {
              console.error('无法断开连接: API配置不可用');
              return;
            }

            // 使用Mihomo API断开所有连接
            const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
            
            const apiUrl = `http://${activeApiConfig.controllerHost}:${activeApiConfig.controllerPort}/connections`;
            const headers = {};
            
            // 如果有secret，添加到请求头
            if (activeApiConfig.secret) {
              headers['Authorization'] = `Bearer ${activeApiConfig.secret}`;
            }
            
            const response = await fetch(apiUrl, {
              method: 'DELETE',
              headers
            });
            
            if (response.ok) {
              console.log('成功断开所有连接');
              // 可选：显示通知
              if (mainWindow) {
                mainWindow.webContents.send('connections-closed');
              }
            } else {
              console.error(`断开所有连接失败: ${response.statusText}`);
            }
          } catch (error) {
            console.error('断开所有连接时出错:', error);
          }
        }
      }
    ];
    
    // 尝试获取节点列表
    let nodeMenuItems = [];
    
    try {
      // 检查Mihomo是否运行
      const isServiceRunning = await checkMihomoService();
      if (isServiceRunning) {
        // 使用fetch API获取代理节点信息
        const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
        
        // 获取代理节点信息
        if (!activeApiConfig) {
          console.error('无法获取代理节点: API配置不可用');
          return;
        }
        
        const apiUrl = `http://${activeApiConfig.controllerHost}:${activeApiConfig.controllerPort}/proxies`;
        const headers = {};
        
        // 如果有secret，添加到请求头
        if (activeApiConfig.secret) {
          headers['Authorization'] = `Bearer ${activeApiConfig.secret}`;
        }
        
        const response = await fetch(apiUrl, { headers });
        if (response.ok) {
          const data = await response.json();
          
          // 获取所有代理组
          const proxyGroups = [];
          
          // 查找所有类型为Selector, URLTest, Fallback的代理组
          for (
            const [name, proxy] of Object.entries(data.proxies)) {
            if (proxy.type === 'Selector' || proxy.type === 'URLTest' || proxy.type === 'Fallback') {
              if (proxy.all && proxy.all.length > 0) {
                // 将PROXY或GLOBAL组放在最前面
                if (name === 'PROXY' || name === 'GLOBAL') {
                  proxyGroups.unshift({
                    name: name,
                    type: proxy.type,
                    all: proxy.all,
                    now: proxy.now
                  });
                } else {
                  proxyGroups.push({
                    name: name,
                    type: proxy.type,
                    all: proxy.all,
                    now: proxy.now
                  });
                }
              }
            }
          }
          
          // 创建所有代理组的子菜单
          if (proxyGroups.length > 0) {
            const groupSubmenuItems = [];
            
            // 为每个代理组创建子菜单
            for (const group of proxyGroups) {
              const nodesSubmenu = [];
              
              // 先对节点进行排序 - 将当前选中节点和有延迟信息的节点排在前面
              const sortedNodeNames = [...group.all].sort((a, b) => {
                // 当前选中的节点排在最前面
                if (a === group.now) return -1;
                if (b === group.now) return 1;
                
                const nodeA = data.proxies[a];
                const nodeB = data.proxies[b];
                
                // 有延迟信息的节点优先
                const delayA = nodeA?.history?.[0]?.delay ?? -1;
                const delayB = nodeB?.history?.[0]?.delay ?? -1;
                
                // 都有延迟信息，按延迟从小到大排序
                if (delayA > 0 && delayB > 0) return delayA - delayB;
                
                // 有延迟信息的排在前面
                if (delayA > 0) return -1;
                if (delayB > 0) return 1;
                
                // 都没有延迟信息，按字母顺序排序
                return a.localeCompare(b);
              });
              
              // 为每个节点创建菜单项
              for (const nodeName of sortedNodeNames) {
                const node = data.proxies[nodeName];
                if (node) {
                  // 跳过其他代理组类型（不跳过，部分配置允许代理组嵌套）
                  // if (node.type === 'Selector' || node.type === 'URLTest' || node.type === 'Fallback') {
                  //   continue;
                  // }
                  
                  let label = nodeName;
                  // 添加延迟显示（如果有）
                  if (node.history && node.history.length > 0) {
                    const delay = node.history[0].delay;
                    if (delay > 0) {
                      label = `${nodeName} (${delay}ms)`;
                    } else if (delay === 0) {
                      label = `${nodeName} (超时)`;
                    }
                  }
                  
                  // 如果是代理组，添加标记
                  if (node.type === 'Selector' || node.type === 'URLTest' || node.type === 'Fallback') {
                    label = `${label} [组]`;
                  }
                  
                  nodesSubmenu.push({
                    label: label,
                    type: 'radio',
                    checked: nodeName === group.now,
                    click: async () => {
                      // 调用API切换节点
                      try {
                        if (!activeApiConfig) {
                          console.error('无法切换节点: API配置不可用');
                          return;
                        }
                        
                        const apiUrl = `http://${activeApiConfig.controllerHost}:${activeApiConfig.controllerPort}/proxies/${encodeURIComponent(group.name)}`;
                        const headers = {
                          'Content-Type': 'application/json'
                        };
                        
                        // 如果有secret，添加到请求头
                        if (activeApiConfig.secret) {
                          headers['Authorization'] = `Bearer ${activeApiConfig.secret}`;
                        }
                        
                        // 切换节点
                        const switchResponse = await fetch(apiUrl, {
                          method: 'PUT',
                          headers,
                          body: JSON.stringify({ name: nodeName })
                        });
                        
                        if (switchResponse.ok) {
                          console.log(`成功切换组 ${group.name} 到节点: ${nodeName}`);
                          
                          // 如果是主要组（PROXY或GLOBAL），同时更新当前节点
                          if (group.name === 'PROXY' || group.name === 'GLOBAL') {
                            // 切换成功后更新UI
                            if (mainWindow) {
                              mainWindow.webContents.send('node-changed', { nodeName });
                            }
                            // 更新当前节点
                            currentNode = nodeName;
                            // 更新托盘提示
                            tray.setToolTip(`FlyClash - ${nodeName}`);
                          }
                          
                          // 更新托盘菜单
                          setTimeout(() => updateTrayMenu(), 1000);
                        } else {
                          console.error(`切换节点失败: ${switchResponse.statusText}`);
                        }
                      } catch (error) {
                        console.error('切换节点失败:', error);
                      }
                    }
                  });
                }
              }
              
              // 如果有节点，添加到代理组菜单
              if (nodesSubmenu.length > 0) {
                // 标记当前选中的节点
                const groupLabel = group.name === 'PROXY' || group.name === 'GLOBAL' 
                  ? `${group.name} ★` 
                  : group.name;
                
                groupSubmenuItems.push({
                  label: groupLabel,
                  submenu: nodesSubmenu
                });
              }
            }
            
            // 添加所有代理组菜单
            nodeMenuItems = [
              { type: 'separator' },
              { 
                label: '节点选择', 
                submenu: groupSubmenuItems
              }
            ];
          }
        }
      }
    } catch (error) {
      console.error('获取节点列表失败:', error);
    }
    
    // 组合完整菜单
    const contextMenu = Menu.buildFromTemplate([
      ...menuItems,
      ...nodeMenuItems,
      { type: 'separator' },
      { label: '退出', click: () => {
        isQuitting = true;
        app.quit();
      }}
    ]);
    
    tray.setContextMenu(contextMenu);
    
    // 更新托盘提示，显示当前节点
    if (currentNode) {
      tray.setToolTip(`FlyClash - ${currentNode}`);
    } else {
      tray.setToolTip('FlyClash');
    }
  } catch (error) {
    console.error('更新托盘菜单失败:', error);
    // 创建基本菜单作为后备
    const basicMenu = Menu.buildFromTemplate([
      { label: '显示主窗口', click: () => mainWindow.show() },
      { type: 'separator' },
      { label: '退出', click: () => {
        isQuitting = true;
        app.quit();
      }}
    ]);
    tray.setContextMenu(basicMenu);
  }
}

// 系统代理状态
let systemProxyEnabled = false;

// 切换系统代理
function toggleSystemProxy(menuItem) {
  // 检查mihomo是否运行中
  if (!mihomoProcess) {
    dialog.showErrorBox('错误', '请先启动代理服务');
    return;
  }
  
  try {
    // 读取当前用户设置，获取最新的端口设置
    const userSettings = getUserSettings();
    const port = userSettings['mixed-port'] || 7890;
    
    if (menuItem.checked) {
      // 启用系统代理
      console.log('启用系统代理，端口:', port);
      
      // Windows平台
      if (process.platform === 'win32') {
        // Windows 使用 Internet 设置注册表
        execSync('reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 1 /f');
        execSync(`reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer /t REG_SZ /d "127.0.0.1:${port}" /f`);
        
        // 设置环境变量
        process.env.HTTP_PROXY = `http://127.0.0.1:${port}`;
        process.env.HTTPS_PROXY = `http://127.0.0.1:${port}`;
      } 
      // macOS平台使用networksetup命令
      else if (process.platform === 'darwin') {
        // 获取所有活动网络服务
        const services = execSync('networksetup -listallnetworkservices').toString().split('\n');
        // 跳过第一行(标题行)
        for (let i = 1; i < services.length; i++) {
          const service = services[i].trim();
          if (service && !service.includes('*')) {
            execSync(`networksetup -setwebproxy "${service}" 127.0.0.1 ${port}`);
            execSync(`networksetup -setsecurewebproxy "${service}" 127.0.0.1 ${port}`);
            execSync(`networksetup -setsocksfirewallproxy "${service}" 127.0.0.1 ${port}`);
          }
        }
      }
      
      systemProxyEnabled = true;
      // 保存代理状态到文件
      const proxyConfigPath = path.join(userDataPath, 'proxy-config.json');
      fs.writeFileSync(proxyConfigPath, JSON.stringify({ enabled: true }), 'utf8');
      console.log('已保存代理状态: 启用');
      
      if (mainWindow) {
        mainWindow.webContents.send('proxy-status', true);
      }
    } else {
      // 禁用系统代理
      console.log('禁用系统代理');
      
      // Windows平台
      if (process.platform === 'win32') {
        // Windows 使用 Internet 设置注册表
        execSync('reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 0 /f');
        
        // 清除环境变量
        delete process.env.HTTP_PROXY;
        delete process.env.HTTPS_PROXY;
      } 
      // macOS平台
      else if (process.platform === 'darwin') {
        const services = execSync('networksetup -listallnetworkservices').toString().split('\n');
        for (let i = 1; i < services.length; i++) {
          const service = services[i].trim();
          if (service && !service.includes('*')) {
            execSync(`networksetup -setwebproxystate "${service}" off`);
            execSync(`networksetup -setsecurewebproxystate "${service}" off`);
            execSync(`networksetup -setsocksfirewallproxystate "${service}" off`);
          }
        }
      }
      
      systemProxyEnabled = false;
      // 保存代理状态到文件
      const proxyConfigPath = path.join(userDataPath, 'proxy-config.json');
      fs.writeFileSync(proxyConfigPath, JSON.stringify({ enabled: false }), 'utf8');
      console.log('已保存代理状态: 禁用');
      
      if (mainWindow) {
        mainWindow.webContents.send('proxy-status', false);
      }
    }
  } catch (error) {
    console.error('设置系统代理失败:', error);
    dialog.showErrorBox('系统代理错误', `设置系统代理失败: ${error.message}`);
    
    // 恢复菜单项状态
    menuItem.checked = !menuItem.checked;
    systemProxyEnabled = !menuItem.checked;
    
    // 保存恢复后的代理状态到文件
    try {
      const proxyConfigPath = path.join(userDataPath, 'proxy-config.json');
      fs.writeFileSync(proxyConfigPath, JSON.stringify({ enabled: systemProxyEnabled }), 'utf8');
      console.log(`已保存恢复后的代理状态: ${systemProxyEnabled ? '启用' : '禁用'}`);
    } catch (saveError) {
      console.error('保存代理状态失败:', saveError);
    }
    
    if (mainWindow) {
      mainWindow.webContents.send('proxy-status', systemProxyEnabled);
    }
  }
}

// 更新系统代理设置（当端口变更时调用）
function updateSystemProxyIfEnabled() {
  // 如果系统代理未启用，则不需要更新
  if (!systemProxyEnabled) {
    return;
  }
  
  try {
    // 读取当前用户设置，获取最新的端口设置
    const userSettings = getUserSettings();
    const port = userSettings['mixed-port'] || 7890;
    
    console.log('更新系统代理设置，使用新端口:', port);
    
    // Windows平台
    if (process.platform === 'win32') {
      // Windows 使用 Internet 设置注册表
      execSync('reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 1 /f');
      execSync(`reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer /t REG_SZ /d "127.0.0.1:${port}" /f`);
      
      // 更新环境变量
      process.env.HTTP_PROXY = `http://127.0.0.1:${port}`;
      process.env.HTTPS_PROXY = `http://127.0.0.1:${port}`;
    } 
    // macOS平台
    else if (process.platform === 'darwin') {
      const services = execSync('networksetup -listallnetworkservices').toString().split('\n');
      for (let i = 1; i < services.length; i++) {
        const service = services[i].trim();
        if (service && !service.includes('*')) {
          execSync(`networksetup -setwebproxy "${service}" 127.0.0.1 ${port}`);
          execSync(`networksetup -setsecurewebproxy "${service}" 127.0.0.1 ${port}`);
          execSync(`networksetup -setsocksfirewallproxy "${service}" 127.0.0.1 ${port}`);
        }
      }
    }
    
    console.log('系统代理设置已更新');
  } catch (error) {
    console.error('更新系统代理设置失败:', error);
    dialog.showErrorBox('系统代理错误', `更新系统代理设置失败: ${error.message}`);
  }
}

// 自动启动Mihomo功能
async function autoStartMihomo() {
  try {
    // 首先检查内核是否已经在运行
    console.log('检查内核是否已经在运行...');
    
    // 临时保存原始apiConfig，避免影响后续流程
    const originalApiConfig = { ...activeApiConfig };
    
    // 确保API配置已设置（即使后续要重置）
    if (!activeApiConfig) {
      activeApiConfig = {
        controllerHost: '127.0.0.1',
        controllerPort: '9090',
        secret: getUserSettings()['secret'] || '' // 从用户设置中获取密钥
      };
    }
    
    const isRunning = await checkMihomoService();
    
    if (isRunning) {
      console.log('检测到内核已经在运行，获取内核信息...');
      
      try {
        // 尝试获取当前内核的配置信息
        const host = activeApiConfig.controllerHost === '0.0.0.0' ? '127.0.0.1' : activeApiConfig.controllerHost;
        const port = activeApiConfig.controllerPort;
        const headers = {};
        if (activeApiConfig.secret) {
          headers['Authorization'] = `Bearer ${activeApiConfig.secret}`;
        }
        
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 2000);
        
        const configResponse = await fetch(`http://${host}:${port}/configs`, { 
          headers,
          signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        
        if (configResponse.ok) {
          const configData = await configResponse.json();
          console.log('成功获取现有内核配置信息', configData);
          
          // 保持当前activeApiConfig不变，因为它正常工作
          
          // 更新内核状态
          configFilePath = configData.path || '已连接到现有内核';
          
          // 通知前端更新状态
          if (mainWindow) {
            mainWindow.webContents.send('mihomo-autostart', {
              success: true,
              configPath: configFilePath,
              existing: true,
              configData: configData
            });
          }
          
          // 启动连接管理和流量统计
          startTrafficStatsUpdate();
          startAllWebSockets();

          // 获取当前节点
          updateCurrentNodeInfo();
          
          return;
        } else {
          console.log(`无法获取内核配置信息，状态码: ${configResponse.status}`);
        }
      } catch (error) {
        console.error('获取现有内核配置信息失败:', error);
      }
      
      // 如果无法获取详细信息，则使用基本通知
      if (mainWindow) {
        mainWindow.webContents.send('mihomo-autostart', {
          success: true,
          configPath: '已连接到现有内核',
          existing: true
        });
      }
      
      // 启动连接管理和流量统计
      startTrafficStatsUpdate();
      startAllWebSockets();

      return;
    }
    
    // 恢复原始设置，避免干扰后续启动流程
    activeApiConfig = originalApiConfig;
    
    // 首先确保必要的mihomo数据文件已准备好
    await ensureMihomoDataFiles();
    
    // 获取保存的订阅列表
    const subscriptions = await getSubscriptionList();
    if (subscriptions.length === 0) {
      console.log('没有可用的配置文件，无法自动启动');
      return;
    }
    
    // 尝试从存储中读取上次使用的配置文件路径
    let configPath;
    try {
      const lastConfigPath = path.join(userDataPath, 'last-config.json');
      if (fs.existsSync(lastConfigPath)) {
        const lastConfig = JSON.parse(fs.readFileSync(lastConfigPath, 'utf8'));
        if (lastConfig.path && fs.existsSync(lastConfig.path)) {
          console.log('找到上次使用的配置文件:', lastConfig.path);
          configPath = lastConfig.path;
        }
      }
    } catch (error) {
      console.error('读取上次配置文件失败:', error);
    }
    
    // 如果没有找到上次的配置或文件不存在，使用第一个可用的配置
    if (!configPath) {
      configPath = subscriptions[0].path;
      console.log('没有找到上次的配置，使用第一个配置文件:', configPath);
    }
    
    const success = await startMihomo(configPath);
    
    if (success && mainWindow) {
      // 通知前端更新状态
      mainWindow.webContents.send('mihomo-autostart', {
        success: true,
        configPath: configPath
      });
      
      // 自动应用上次的代理状态
      try {
        const proxyConfigPath = path.join(userDataPath, 'proxy-config.json');
        if (fs.existsSync(proxyConfigPath)) {
          const proxyConfig = JSON.parse(fs.readFileSync(proxyConfigPath, 'utf8'));
          console.log('应用上次保存的代理状态:', proxyConfig.enabled);
          
          if (proxyConfig.enabled) {
            // 启用系统代理
            execSync('reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 1 /f');
            execSync('reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer /t REG_SZ /d "127.0.0.1:7890" /f');
            mainWindow.webContents.send('proxy-status', true);
          } else {
            // 禁用系统代理
            execSync('reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 0 /f');
            mainWindow.webContents.send('proxy-status', false);
          }
        }
      } catch (error) {
        console.error('应用上次代理状态失败:', error);
      }
    }
  } catch (error) {
    console.error('自动启动Mihomo失败:', error);
    if (mainWindow) {
      mainWindow.webContents.send('mihomo-autostart', {
        success: false,
        error: error.message
      });
    }
  }
}

// 新增函数：确保mihomo所需的数据文件存在
async function ensureMihomoDataFiles() {
  try {
    // mihomo默认配置目录
    const homeDir = process.env.USERPROFILE || process.env.HOME;
    const mihomoConfigDir = path.join(homeDir, '.config', 'mihomo');
    
    console.log(`检查mihomo配置目录: ${mihomoConfigDir}`);
    
    // 确保mihomo配置目录存在
    if (!fs.existsSync(mihomoConfigDir)) {
      console.log(`创建mihomo配置目录: ${mihomoConfigDir}`);
      fs.mkdirSync(mihomoConfigDir, { recursive: true });
    }
    
    // 数据文件源目录
    let dataSourceDir;
    if (isDev) {
      // 开发环境
      dataSourceDir = path.join(process.cwd(), 'tools', 'data');
      console.log(`开发环境数据源目录: ${dataSourceDir}`);
    } else {
      // 生产环境
      dataSourceDir = path.join(process.resourcesPath, 'tools', 'data');
      console.log(`生产环境数据源目录: ${dataSourceDir}`);
    }
    
    // 检查源目录是否存在
    if (!fs.existsSync(dataSourceDir)) {
      console.warn(`数据源目录不存在: ${dataSourceDir}`);
      // 尝试备用路径
      if (isDev) {
        dataSourceDir = path.join(process.cwd(), 'flycast-ui', 'tools', 'data');
      } else {
        dataSourceDir = path.join(app.getAppPath(), 'tools', 'data');
      }
      console.log(`尝试备用数据源目录: ${dataSourceDir}`);
      
      if (!fs.existsSync(dataSourceDir)) {
        console.error(`备用数据源目录也不存在: ${dataSourceDir}`);
        return;
      }
    }
    
    console.log(`从 ${dataSourceDir} 复制数据文件到 ${mihomoConfigDir}`);
    
    // 数据文件列表
    const dataFiles = [
      'geoip.metadb',
      'geosite.dat',
      'country.mmdb',
      'geoip.dat',
      'ASN.mmdb'
    ];
    
    // 复制每个数据文件（如果目标文件不存在）
    for (const fileName of dataFiles) {
      const sourceFile = path.join(dataSourceDir, fileName);
      const targetFile = path.join(mihomoConfigDir, fileName);
      
      if (!fs.existsSync(sourceFile)) {
        console.warn(`源文件不存在: ${sourceFile}`);
        continue;
      }
      
      // 如果源文件存在且目标文件不存在，则复制
      if (!fs.existsSync(targetFile)) {
        console.log(`复制文件: ${fileName} (${fs.statSync(sourceFile).size / 1024 / 1024} MB)`);
        fs.copyFileSync(sourceFile, targetFile);
        console.log(`文件复制成功: ${targetFile}`);
      } else {
        console.log(`目标文件已存在，跳过: ${targetFile}`);
      }
    }
    
    console.log('mihomo数据文件检查和复制完成');
  } catch (error) {
    console.error('准备mihomo数据文件时出错:', error);
    throw error;  // 重新抛出错误以便调用者处理
  }
}

// 获取订阅列表
function getSubscriptionList() {
  return new Promise((resolve) => {
    if (!fs.existsSync(configDir)) {
      resolve([]);
      return;
    }
    
    const subscriptions = fs.readdirSync(configDir)
      .filter(file => file.endsWith('.yaml'))
      .map(file => ({
        name: file.replace('.yaml', ''),
        path: path.join(configDir, file)
      }));
    
    resolve(subscriptions);
  });
}

// 解析YAML配置文件
function parseConfigFile(filePath) {
  try {
    const fileContent = fs.readFileSync(filePath, 'utf8');
    
    // 使用js-yaml解析
    let yaml;
    try {
      yaml = require('js-yaml');
    } catch (e) {
      console.error('js-yaml模块未安装，无法解析配置');
      return null;
    }
    
    const config = yaml.load(fileContent);
    if (!config) {
      return null;
    }
    
    // 提取所有代理组和节点，保持原始顺序
    const proxyGroups = [];
    
    if (config["proxy-groups"] && Array.isArray(config["proxy-groups"])) {
      for (const group of config["proxy-groups"]) {
        if (group.name && (group.type === 'select' || group.type === 'url-test' || group.type === 'fallback')) {
          proxyGroups.push({
            name: group.name,
            type: group.type,
            proxies: group.proxies || [],
            icon: typeof group.icon === 'string' ? group.icon : null
          });
        }
      }
    }
    
    // 提取所有代理节点
    const proxies = [];
    if (config.proxies && Array.isArray(config.proxies)) {
      for (const proxy of config.proxies) {
        if (proxy.name) {
          proxies.push({
            name: proxy.name,
            type: proxy.type,
            server: proxy.server || '',
            port: proxy.port || 0
          });
        }
      }
    }

    // 提取API配置信息，强制使用固定的控制器地址和空密钥
    const apiConfig = {
      'external-controller': '0.0.0.0:9090',  // 服务器监听所有接口
      'secret': ''  // 强制使用空密钥
    };

    // 使用127.0.0.1作为客户端连接地址
    const controllerHost = '127.0.0.1';
    const controllerPort = '9090';
    
    apiConfig.controllerHost = controllerHost;
    apiConfig.controllerPort = controllerPort;
      
    return {
      proxyGroups,
      proxies,
      apiConfig
    };
  } catch (error) {
    console.error('解析配置文件失败:', error);
    return null;
  }
}

// 注释掉重复的get-config-order处理程序，保留第5143行的实现
// 获取配置顺序功能已移至第5143行统一实现

// 新增: 获取当前配置
async function getConfig() {
  try {
    if (!configFilePath || !fs.existsSync(configFilePath)) {
      console.log('当前没有活跃的配置文件');
      return null;
    }
    
    // 读取配置文件
    const content = fs.readFileSync(configFilePath, 'utf8');
    
    if (!content || content.trim() === '') {
      console.error('配置文件为空');
      return null;
    }
    
    // 解析YAML
    const config = yaml.load(content);
    
    if (!config) {
      console.error('解析配置文件失败');
      return null;
    }
    
    return config;
  } catch (error) {
    console.error('获取配置失败:', error);
    return null;
  }
}

// 更新流量统计
function updateTrafficStats() {
  // 避免创建多个连接
  if (trafficWebSocket && trafficWebSocket.readyState !== WebSocket.CLOSED) {
    return;
  }
  
  try {
    // 检查是否有解析的API配置
    if (!activeApiConfig) {
      console.error('无法连接WebSocket: API配置不可用');
      return;
    }

    // 确保使用127.0.0.1作为客户端连接地址
    const host = activeApiConfig.controllerHost === '0.0.0.0' ? '127.0.0.1' : activeApiConfig.controllerHost;
    
    // 使用解析的WebSocket地址
    const wsUrl = `ws://${host}:${activeApiConfig.controllerPort}/traffic`;
    
    console.log(`[调试] 连接到流量统计WebSocket: ${wsUrl}`);
    
    // 创建流量统计WebSocket
    // 如果有secret密钥，添加到请求头
    const wsOptions = {};
    if (activeApiConfig.secret) {
      wsOptions.headers = {
        'Authorization': `Bearer ${activeApiConfig.secret}`
      };
      console.log('[调试] 已添加WebSocket认证头');
    }
    
    trafficWebSocket = new WebSocket(wsUrl, wsOptions);

    trafficWebSocket.on('open', () => {
      console.log('[调试] 流量统计WebSocket连接已建立');
      trafficRetry = 10; // 重置重试计数
    });

    trafficWebSocket.on('message', (data) => {
      try {
        const json = JSON.parse(data);
        
        // 确保数据格式正确
        if (!json || typeof json.up !== 'number' || typeof json.down !== 'number') {
          console.error('[调试] 无效的流量数据格式');
          return;
        }

        // 更新统计数据
        const stats = {
          up: json.up,
          down: json.down,
          timestamp: Date.now(),
          upSpeed: json.up,
          downSpeed: json.down
        };

        lastTrafficStats = stats;
        
        // 添加到历史记录并限制大小
        trafficHistory.push(stats);
        if (trafficHistory.length > MAX_TRAFFIC_HISTORY) {
          trafficHistory.shift(); // 移除最旧的记录
        }
        
        // 发送更新到主窗口
        if (mainWindow) {
          mainWindow.webContents.send('traffic-update', stats);
        }
        
        // 减少连接信息获取频率，例如每5秒一次
        const currentTime = Date.now();
        if (!lastConnectionsFetchTime || (currentTime - lastConnectionsFetchTime) > 5000) {
          fetchConnectionsInfo();
          lastConnectionsFetchTime = currentTime;
        }
        
        // 只在流量变化较大时输出日志（大于10MB的变化）
        const significantChange = Math.abs(stats.up - lastTrafficStats.up) > 10 * 1024 * 1024 || 
                                Math.abs(stats.down - lastTrafficStats.down) > 10 * 1024 * 1024;
        if (significantChange) {
          console.log(`[调试] 流量更新: 上传 ${formatTraffic(stats.up)}, 下载 ${formatTraffic(stats.down)}`);
        }
      } catch (error) {
        console.error('[调试] 处理流量数据时出错:', error);
      }
    });

    trafficWebSocket.on('close', () => {
      // 只在第一次关闭时输出日志
      if (trafficRetry === 10) {
        console.log('[调试] 流量统计WebSocket连接已关闭');
      }
      trafficWebSocket = null;

      if (trafficRetry > 0) {
        trafficRetry--;
        // 只在第一次和最后一次重试时输出日志
        if (trafficRetry === 9 || trafficRetry === 0) {
          console.log(`[调试] 尝试重新连接WebSocket，剩余重试次数: ${trafficRetry}`);
        }
        updateTrafficStats();
      } else {
        console.log('[调试] WebSocket重连次数已达上限，停止重试');
      }
    });

    trafficWebSocket.on('error', (error) => {
      console.error('[调试] 流量统计WebSocket错误:', error);
      if (trafficWebSocket) {
        trafficWebSocket.close();
        trafficWebSocket = null;
      }
    });
  } catch (error) {
    // ... existing code ...
  }
}

// 设置定时更新流量统计
let trafficStatsInterval;
function startTrafficStatsUpdate() {
  if (trafficStatsInterval) {
    clearInterval(trafficStatsInterval);
  }
  
  // 初始化WebSocket连接
  updateTrafficStats();
  
  // 设置定时器，每1秒检查一次WebSocket连接状态
  trafficStatsInterval = setInterval(() => {
    if (!trafficWebSocket || trafficWebSocket.readyState !== 1) {
      // 移除重连日志，避免刷屏
      updateTrafficStats();
    }
  }, 1000); // 每1秒检查一次
}

function stopTrafficStatsUpdate() {
  if (trafficStatsInterval) {
    clearInterval(trafficStatsInterval);
    trafficStatsInterval = null;
  }
  
  if (trafficWebSocket) {
    trafficWebSocket.close();
    trafficWebSocket = null;
  }
}

// 旧的 HTTP WebSocket 函数已删除，现在统一使用 IPC WebSocket（第 591 行）

// 更新当前节点信息
async function updateCurrentNodeInfo() {
  try {
    if (!activeApiConfig) {
      console.error('无法获取节点信息: API配置不可用');
      return;
    }

    console.log('[调试] 请求节点信息: /proxies/PROXY');
    
    // 使用统一的API请求函数获取节点信息
    const response = await fetchMihomoAPI('/proxies/PROXY');
    if (response.ok) {
      const data = await response.json();
      console.log('[调试] 获取到PROXY组信息:', data);
      
      if (data && data.now) {
        currentNode = data.now;
        console.log('[调试] 更新当前节点为:', currentNode);
        
        // 更新lastConnectionsInfo中的节点信息
        lastConnectionsInfo = {
          ...lastConnectionsInfo,
          currentNode: currentNode
        };
        
        // 通知主窗口节点已更新
        if (mainWindow && mainWindow.webContents && !mainWindow.isDestroyed()) {
          console.log('[调试] 发送节点变更事件:', currentNode);
          
          // 立即发送节点更新
          mainWindow.webContents.send('node-changed', { nodeName: currentNode });
          
          // 添加延迟，确保前端有足够时间处理节点更新
          setTimeout(() => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              console.log('[调试] 延迟发送连接信息更新:', lastConnectionsInfo);
              mainWindow.webContents.send('connections-update', lastConnectionsInfo);
            }
          }, 500);
        }
      } else {
        console.warn('[调试] 无法获取当前节点信息:', data);
      }
    } else {
      console.error('[调试] 获取节点信息请求失败:', response.status, response.statusText);
    }
  } catch (error) {
    console.error('[调试] 更新节点信息失败:', error);
  }
}

// 停止连接管理WebSocket
// ⚠️ 已废弃：使用新的 stopAllWebSockets() 函数
// function stopConnectionsWebSocket() {
//   if (connectionsWebSocket) {
//     connectionsWebSocket.close();
//     connectionsWebSocket = null;
//   }
//   connectionsRetry = 10;
// }

// 添加检查Mihomo服务状态的函数
async function checkMihomoService() {
  // 定义几个可能的端口和端点组合，按优先级排序
  const possibleEndpoints = [
    { port: '9090', path: '/proxies' },
    { port: '9090', path: '/version' },
    { port: '7890', path: '/proxies' },
    { port: '7890', path: '/version' }
  ];
  
  try {
    if (!activeApiConfig) {
      console.error('[调试] 无法检查Mihomo服务: API配置不可用');
      return false;
    }

    // 使用已配置的端口和路径检查服务状态
    const configuredPort = activeApiConfig.controllerPort;
    
    console.log(`[调试] 检查Mihomo服务(配置端口): ${configuredPort}/proxies`);
    
    try {
      // 添加超时控制
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 1500); // 1.5秒超时
      
      // 使用我们的统一API请求函数
      const response = await fetchMihomoAPI('/proxies', { 
        signal: controller.signal 
      });
      
      clearTimeout(timeoutId);
      
      if (response.ok) {
        console.log('[调试] Mihomo服务检查通过 (使用配置端口)');
        return true;
      }
      console.log(`[调试] 使用配置端口检查失败，状态码: ${response.status}`);
    } catch (error) {
      console.log(`[调试] 使用配置端口检查出错: ${error.message}`);
    }
    
    // 如果使用配置的端口检查失败，则尝试其他可能的组合
    for (const endpoint of possibleEndpoints) {
      // 跳过与配置相同的端口/路径组合
      if (endpoint.port === configuredPort && endpoint.path === '/proxies') {
        continue;
      }
      
      // 构建模拟的host地址用于日志
      const host = activeApiConfig.controllerHost === '0.0.0.0' ? '127.0.0.1' : activeApiConfig.controllerHost;
      const url = `http://${host}:${endpoint.port}${endpoint.path}`;
      console.log(`[调试] 尝试检查Mihomo服务: ${url}`);
      
      try {
        // 添加超时控制
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 1000); // 1秒超时
        
        // 临时修改activeApiConfig以便使用不同端口测试
        const originalPort = activeApiConfig.controllerPort;
        activeApiConfig.controllerPort = endpoint.port;
        
        const response = await fetchMihomoAPI(endpoint.path, {
          signal: controller.signal
        });
        
        // 恢复原始端口设置
        activeApiConfig.controllerPort = originalPort;
        
        clearTimeout(timeoutId);
        
        if (response.ok) {
          console.log(`[调试] Mihomo服务检查通过 (使用端口 ${endpoint.port})`);
          return true;
        }
      } catch (error) {
        console.log(`[调试] 尝试端口 ${endpoint.port} 路径 ${endpoint.path} 失败: ${error.message}`);
      }
    }
    
    console.log('[调试] 所有Mihomo服务检查尝试都失败了');
    return false;
  } catch (error) {
    console.error('[调试] Mihomo服务检查失败:', error);
    return false;
  }
}

// Mihomo进程意外停止时的处理函数
function handleMihomoProcessExit(code) {
  console.log(`Mihomo进程退出，代码: ${code}`);
  mihomoProcess = null;
  stopTrafficStatsUpdate();
  stopAllWebSockets();
  // 清除configFilePath确保状态正确更新
  configFilePath = null;
  
  // 通知前端Mihomo已停止
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('mihomo-stopped', code);
  }
}

// 应用启动时执行
app.whenReady().then(() => {
  // 注册协议处理器
  if (process.platform === 'win32') {
    app.setAsDefaultProtocolClient('clash');
    app.setAsDefaultProtocolClient('flyclash');
    
    console.log('已注册协议处理器: clash://, flyclash://');
    console.log('启动参数:', process.argv);
    
    // 处理启动时传入的命令行参数
    const gotTheLock = app.requestSingleInstanceLock();
    if (!gotTheLock) {
      console.log('已有实例运行，退出当前实例');
      app.quit();
      return;
    }
    
    // 检查启动参数是否包含协议URL
    let foundProtocolArg = false;
    for (const arg of process.argv) {
      if (arg.includes('clash://') || 
          arg.includes('flyclash://') ||
          arg.includes('?url=')) {
        console.log('检测到可能的协议URL参数:', arg);
        foundProtocolArg = true;
        handleProtocolUrl(arg);
      }
    }
    
    if (!foundProtocolArg) {
      console.log('启动参数中未找到协议URL');
    }
  }
  
  createWindow();
  
  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // 加载主题设置
  try {
    const themeConfigPath = path.join(userDataPath, 'theme-config.json');
    if (fs.existsSync(themeConfigPath)) {
      const themeConfig = JSON.parse(fs.readFileSync(themeConfigPath, 'utf8'));
      nativeTheme.themeSource = themeConfig.theme || 'system';
      console.log('已加载主题设置:', themeConfig.theme);
    }
  } catch (error) {
    console.error('加载主题设置失败:', error);
  }

  // 确保用户设置文件存在
  ensureUserSettingsFile();
  
  // 确保mihomo所需的数据文件存在
  ensureMihomoDataFiles().then(() => {
    console.log('mihomo数据文件初始化完成');
  }).catch(error => {
    console.error('mihomo数据文件初始化失败:', error);
  });
  
  // 检查系统是否已经启用代理
  try {
    if (process.platform === 'win32') {
      const result = execSync('reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable').toString();
      systemProxyEnabled = result.includes('0x1');
      
      if (systemProxyEnabled) {
        // 检查是否是我们的代理设置
        const serverResult = execSync('reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer').toString();
        if (serverResult.includes('127.0.0.1:')) {
          console.log('系统代理已启用:', serverResult);
        } else {
          console.log('系统代理已启用，但使用的不是我们的设置:', serverResult);
        }
      } else {
        console.log('系统代理未启用');
      }
    }
  } catch (error) {
    console.error('检查系统代理状态失败:', error);
  }
  
  // 检查TUN模式状态
  try {
    // 读取用户设置
    const userSettings = getUserSettings();
    // 检查TUN模式状态
    tunModeEnabled = userSettings.tun && userSettings.tun.enable === true;
    console.log('TUN模式状态:', tunModeEnabled ? '已启用' : '未启用');
    
    // 保存TUN状态到文件，方便重启应用后恢复
    const tunConfigPath = path.join(userDataPath, 'tun-config.json');
    fs.writeFileSync(tunConfigPath, JSON.stringify({ enabled: tunModeEnabled }), 'utf8');
  } catch (error) {
    console.error('检查TUN模式状态失败:', error);
  }
  
  // 创建窗口和其他初始化操作
  setupTray();
  
  // 注册工具应用处理程序
  ipcMain.handle('open-tools-app', (_, toolName) => openToolsApp(toolName));
  
  // 注册API: 保存代理设置
  ipcMain.handle('save-proxy-settings', async (event, settings) => {
    try {
      console.log('保存代理设置:', settings);
      
      // 验证设置
      if (settings['mixed-port']) {
        const port = parseInt(settings['mixed-port'], 10);
        if (isNaN(port) || port < 1024 || port > 65535) {
          return { success: false, error: '端口号必须是1024-65535之间的有效数字' };
        }
        settings['mixed-port'] = port;
      }
      
      if ('allow-lan' in settings) {
        settings['allow-lan'] = Boolean(settings['allow-lan']);
      }
      
      if ('ipv6' in settings) {
        settings['ipv6'] = Boolean(settings['ipv6']);
      }
      
      // 更新用户设置文件
      if (updateUserSettings(settings)) {
        // 如果系统代理已启用，则更新系统代理设置
        updateSystemProxyIfEnabled();
        
        // 如果服务正在运行，则需要重启服务
        if (mihomoProcess) {
          // 存储当前配置路径
          const currentConfig = configFilePath;
          // 停止服务
          mihomoProcess.kill();
          mihomoProcess = null;
          // 重启服务
          await startMihomo(currentConfig);
          
          return { success: true, message: '设置已保存，服务已重启' };
        }
        
        return { success: true, message: '设置已保存' };
      } else {
        return { success: false, error: '保存设置失败' };
      }
    } catch (error) {
      console.error('保存代理设置失败:', error);
      return { success: false, error: error.message };
    }
  });

  // 注册API: 获取当前代理设置
  ipcMain.handle('get-proxy-settings', async () => {
    try {
      const settings = getUserSettings();
      return { success: true, settings };
    } catch (error) {
      console.error('获取代理设置失败:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('get-kernel-path', async () => {
    try {
      const kernelPath = getKernelExecutablePath();
      return {
        success: true,
        path: kernelPath,
        isDefault: kernelPath === getDefaultKernelPath(),
        exists: fs.existsSync(kernelPath)
      };
    } catch (error) {
      console.error('获取内核路径失败:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('select-kernel-executable', async () => {
    try {
      const window = BrowserWindow.getFocusedWindow() || mainWindow;
      const result = await dialog.showOpenDialog(window, {
        title: '选择 Mihomo 内核文件',
        filters: [
          { name: '可执行文件', extensions: process.platform === 'win32' ? ['exe'] : ['exe', 'bin'] },
          { name: '所有文件', extensions: ['*'] }
        ],
        properties: ['openFile']
      });

      if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
        return { success: false, canceled: true };
      }

      const selectedPath = result.filePaths[0];
      const validation = security.validateFilePath(selectedPath);
      if (!validation.valid) {
        console.error('内核文件路径验证失败:', validation.error);
        return { success: false, error: validation.error };
      }

      if (!fs.existsSync(validation.path)) {
        console.error('选定的内核文件不存在:', validation.path);
        return { success: false, error: '选定的内核文件不存在' };
      }

      updateKernelExecutablePath(validation.path);

      const needsRestart = Boolean(mihomoProcess);
      return {
        success: true,
        path: validation.path,
        needsRestart
      };
    } catch (error) {
      console.error('选择内核文件失败:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('reset-kernel-path', async () => {
    try {
      const defaultPath = getDefaultKernelPath();
      updateKernelExecutablePath(defaultPath);
      const needsRestart = Boolean(mihomoProcess);
      return { success: true, path: defaultPath, needsRestart };
    } catch (error) {
      console.error('重置内核路径失败:', error);
      return { success: false, error: error.message };
    }
  });

  // 仅保存UA设置（不重启服务）
  ipcMain.handle('save-ua-settings', async (event, ua) => {
    try {
      console.log('仅保存UA设置:', ua);
      
      // 读取当前设置
      const currentSettings = getUserSettings();
      
      // 只更新UA设置
      currentSettings['subscription-ua'] = ua;
      
      // 保存到用户设置文件，但不重启mihomo
      const userSettingsPath = path.join(userDataPath, 'user-settings.yaml');
      fs.writeFileSync(userSettingsPath, yaml.dump(currentSettings), 'utf8');
      
      return { success: true, message: 'UA设置已保存' };
    } catch (error) {
      console.error('保存UA设置失败:', error);
      return { success: false, error: error.message };
    }
  });

  // 添加: 主题设置
  ipcMain.handle('set-theme', (event, theme) => {
    try {
      console.log('设置主题:', theme);
      if (!mainWindow || mainWindow.isDestroyed()) {
        return { success: false, error: '窗口不存在' };
      }

      // 保存主题设置到配置文件
      const themeConfigPath = path.join(userDataPath, 'theme-config.json');
      fs.writeFileSync(themeConfigPath, JSON.stringify({ theme }), 'utf8');
      
      // 根据主题更新窗口
      switch (theme) {
        case 'light':
          nativeTheme.themeSource = 'light';
          mainWindow.webContents.send('theme-changed', 'light');
          break;
        case 'dark':
          nativeTheme.themeSource = 'dark';
          mainWindow.webContents.send('theme-changed', 'dark');
          break;
        case 'system':
        default:
          nativeTheme.themeSource = 'system';
          mainWindow.webContents.send('theme-changed', nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
          break;
      }

      // 更新标题栏颜色
      mainWindow.setTitleBarOverlay({
        color: nativeTheme.shouldUseDarkColors ? '#1a1a1a' : '#f9f9f9',
        symbolColor: nativeTheme.shouldUseDarkColors ? '#f3f4f6' : '#000000',
        height: 48
      });

      return { success: true, theme };
    } catch (error) {
      console.error('设置主题失败:', error);
      return { success: false, error: error.message };
    }
  });
  
  // 添加: 获取当前主题设置
  ipcMain.handle('get-theme', () => {
    try {
      // 从配置文件读取主题设置
      const themeConfigPath = path.join(userDataPath, 'theme-config.json');
      if (fs.existsSync(themeConfigPath)) {
        const themeConfig = JSON.parse(fs.readFileSync(themeConfigPath, 'utf8'));
        return { success: true, theme: themeConfig.theme || 'system' };
      }
      
      // 默认返回系统设置
      return { success: true, theme: 'system' };
    } catch (error) {
      console.error('获取主题设置失败:', error);
      return { success: false, theme: 'system', error: error.message };
    }
  });

  // 保存订阅
  ipcMain.handle('save-subscription', async (event, url, content, customName, subscriptionInfo) => {
    try {
      console.log('接收到添加订阅请求 - URL:', url);
      console.log('接收到添加订阅请求 - 自定义名称:', customName);
      
      // 确保配置目录存在
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }
      
      // 检查是否为本地文件导入
      const isLocalFile = url && typeof url === 'string' && url.startsWith('local:');
      console.log('是否为本地文件导入:', isLocalFile);
      
      // 验证URL (只对非本地文件进行验证)
      let validUrl = url;
      if (!isLocalFile) {
        if (!url || typeof url !== 'string') {
          throw new Error('无效的订阅URL: URL不能为空');
        }
        
        // 规范化URL - 确保去除前后空格
        validUrl = url.trim();
        
        // 尝试添加协议前缀（如果缺少）
        if (!validUrl.match(/^https?:\/\//i)) {
          console.log('URL缺少协议前缀，自动添加https://');
          validUrl = 'https://' + validUrl;
        }
        
        try {
          // 验证URL格式
          new URL(validUrl);
        } catch (urlError) {
          console.error('URL格式无效:', urlError);
          throw new Error(`无效的订阅URL: ${urlError.message}`);
        }
      }
      
      // 如果内容为空，则从URL获取内容 (本地文件导入时不应该出现内容为空的情况)
      if (!content && !isLocalFile) {
        const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
        
        console.log('内容为空，正在从URL获取订阅内容...');
        
        // 获取User-Agent设置
        const userSettings = getUserSettings();
        let userAgent = `FlyClash/${APP_VERSION}`;
        
        // 根据设置选择不同的User-Agent
        if (userSettings['subscription-ua']) {
          switch(userSettings['subscription-ua']) {
            case 'Clash':
              userAgent = 'Clash/2.0.0';
              break;
            case 'Mihomo':
              userAgent = 'Mihomo/1.14.0';
              break;
            case 'MihomoParty':
              userAgent = 'clash.meta';
              break;
            case 'Chrome':
              userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36';
              break;
            default:
              userAgent = `FlyClash/${APP_VERSION}`; // 使用应用版本号
          }
        }
        
        console.log(`使用User-Agent: ${userAgent}`);
        console.log(`开始请求订阅内容: ${validUrl}`);
        
        // 记录安全事件
        security.logSecurityEvent('subscription-save', { 
          url: validUrl,
          userAgent
        }, path.join(userDataPath, 'security.log'));
        
        try {
          const response = await fetch(validUrl, {
            headers: {
              'User-Agent': userAgent
            }
          });
          
          if (!response.ok) {
            throw new Error(`获取订阅失败: ${response.status} ${response.statusText}`);
          }
          
          content = await response.text();
          
          if (!content || content.trim() === '') {
            throw new Error('获取的订阅内容为空');
          }
          
          console.log('成功获取订阅内容，长度:', content.length);
        } catch (fetchError) {
          console.error('获取订阅内容失败:', fetchError);
          throw new Error(`无法获取订阅内容: ${fetchError.message}`);
        }
        
        // 检查获取的内容是否是有效的YAML或JSON
        try {
          yaml.load(content);
        } catch (yamlError) {
          try {
            JSON.parse(content);
          } catch (jsonError) {
            console.error('YAML解析失败:', yamlError);
            console.error('JSON解析失败:', jsonError);
            throw new Error('订阅内容格式无效，不是有效的YAML或JSON');
          }
        }
        
        console.log('从URL获取订阅内容成功');
      }
      
      // 生成文件名
      let fileName;
      if (customName && customName.trim() !== '') {
        fileName = `${customName.trim()}.yaml`;
      } else if (isLocalFile) {
        // 如果是本地文件导入且没有自定义名称，使用文件名
        fileName = url.replace('local:', '').replace(/\.(ya?ml)$/, '') + '.yaml';
      } else {
        // 如果没有提供自定义名称，使用URL的一部分作为名称
        try {
          const parsed = new URL(validUrl);
          fileName = `${parsed.hostname.replace(/\./g, '_')}.yaml`;
        } catch (e) {
          // 如果URL解析失败，使用时间戳
          fileName = `subscription_${Date.now()}.yaml`;
        }
      }
      
      // 确保文件名是安全的，允许中文字符
      fileName = fileName.replace(/[^a-zA-Z0-9_\-\.\u4e00-\u9fa5]/g, '_');
      
      // 构建文件路径
      const filePath = path.join(configDir, fileName);
      
      // 写入内容
      fs.writeFileSync(filePath, content);
      
      // 保存订阅URL，用于未来更新
      try {
        // 获取或创建订阅URL记录文件
        const urlsPath = path.join(configDir, 'subscription_urls.json');
        let urlsData = {};
        
        if (fs.existsSync(urlsPath)) {
          urlsData = JSON.parse(fs.readFileSync(urlsPath, 'utf8'));
        }
        
        // 将新的订阅URL添加到记录中
        urlsData[fileName] = validUrl;
        
        // 保存更新的记录
        fs.writeFileSync(urlsPath, JSON.stringify(urlsData, null, 2));
      } catch (error) {
        console.warn('保存订阅URL记录失败，但配置文件已保存:', error);
      }
      
      // 保存订阅信息（流量、到期时间等）
      if (subscriptionInfo) {
        try {
          // 获取或创建订阅信息记录文件
          const infoPath = path.join(configDir, 'subscription_info.json');
          let infoData = {};
          
          if (fs.existsSync(infoPath)) {
            infoData = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
          }
          
          // 将新的订阅信息添加到记录中
          infoData[fileName] = {
            ...subscriptionInfo,
            lastUpdated: new Date().toISOString()
          };
          
          // 保存更新的记录 - 确保将对象转换为JSON字符串
          const infoContent = JSON.stringify(infoData, null, 2);
          fs.writeFileSync(infoPath, infoContent);
          
          // 同时也保存到subscriptions_info.json（兼容性考虑）
          try {
            const infoPathPlural = path.join(configDir, 'subscriptions_info.json');
            fs.writeFileSync(infoPathPlural, infoContent);
          } catch (e) {
            console.warn('保存subscriptions_info.json失败:', e);
          }
        } catch (error) {
          console.warn('保存订阅信息记录失败，但配置文件已保存:', error);
        }
      }
      
      return filePath;
    } catch (error) {
      console.error('保存订阅失败:', error);
      throw error;
    }
  });

  ipcMain.handle('get-subscriptions', (event) => {
    try {
      return getSubscriptionList();
    } catch (error) {
      console.error('获取订阅列表失败:', error);
      return [];
    }
  });
  
  // 辅助函数：获取订阅列表
  function getSubscriptionList() {
    try {
      // 确保配置目录存在
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
        return [];
      }
      
      // 读取目录中的.yaml文件
      const files = fs.readdirSync(configDir).filter(file => file.endsWith('.yaml'));
      
      // 读取订阅信息记录
      let subscriptionInfoData = {};
      const infoPath = path.join(configDir, 'subscription_info.json');
      if (fs.existsSync(infoPath)) {
        try {
          subscriptionInfoData = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
        } catch (e) {
          console.error('读取订阅信息记录失败:', e);
        }
      }
      
      // 转换为订阅对象列表
      return files.map(file => {
        const filePath = path.join(configDir, file);
        
        // 获取各个订阅的信息数据
        const info = subscriptionInfoData[file] || {};
        
        return {
          name: file.replace(/\.yaml$/, ''),
          path: filePath,
          usedTraffic: info.usedTraffic || null,
          remainingTraffic: info.remainingTraffic || null,
          expiryDate: info.expiryDate || null,
          lastUpdated: info.lastUpdated ? new Date(info.lastUpdated).toLocaleString() : null
        };
      });
    } catch (error) {
      console.error('获取订阅列表失败:', error);
      return [];
    }
  }

  ipcMain.handle('delete-subscription', (event, filePath) => {
    try {
      fs.unlinkSync(filePath);
      return true;
    } catch (error) {
      console.error(`Failed to delete ${filePath}:`, error);
      return false;
    }
  });

  ipcMain.handle('get-traffic-stats', () => {
    return lastTrafficStats;
  });

  // 新增：从主进程获取订阅内容
  ipcMain.handle('fetch-subscription', async (event, subUrl) => {
    try {
      console.log('接收到获取订阅内容请求 - URL:', subUrl);
      
      // 检查是否为本地文件导入
      const isLocalFile = subUrl && typeof subUrl === 'string' && subUrl.startsWith('local:');
      console.log('是否为本地文件导入:', isLocalFile);
      
      // 如果是本地文件导入，不需要进行URL验证和内容获取
      if (isLocalFile) {
        console.log('本地文件导入无需远程获取内容');
        return { content: '', isLocalFile: true };
      }
      
      const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
      
      // 验证URL
      let validUrl = subUrl;
      if (!subUrl || typeof subUrl !== 'string') {
        throw new Error('无效的订阅URL: URL不能为空');
      }
      
      // 规范化URL - 确保去除前后空格
      validUrl = subUrl.trim();
      
      // 尝试添加协议前缀（如果缺少）
      if (!validUrl.match(/^https?:\/\//i)) {
        console.log('URL缺少协议前缀，自动添加https://');
        validUrl = 'https://' + validUrl;
      }
      
      try {
        // 验证URL格式
        new URL(validUrl);
      } catch (urlError) {
        console.error('URL格式无效:', urlError);
        throw new Error(`无效的订阅URL: ${urlError.message}`);
      }
      
      console.log('正在获取订阅内容...');
      
      // 获取User-Agent设置
      const userSettings = getUserSettings();
      
      // 使用安全模块获取User-Agent
      const userAgent = security.getSafeUserAgent(userSettings['subscription-ua'], APP_VERSION);
      
      console.log(`使用User-Agent: ${userAgent}`);
      console.log(`开始请求订阅内容: ${validUrl}`);
      
      // 记录安全事件
      security.logSecurityEvent('subscription-fetch', { 
        url: validUrl,
        userAgent
      }, path.join(userDataPath, 'security.log'));
      
      try {
        const response = await fetch(validUrl, {
          headers: {
            'User-Agent': userAgent
          }
        });
        
        if (!response.ok) {
          throw new Error(`获取订阅失败: ${response.status} ${response.statusText}`);
        }
        
        // 解析响应头的订阅信息
        const subscriptionInfo = {
          usedTraffic: response.headers.get('subscription-userinfo-upload') ? formatTraffic(parseInt(response.headers.get('subscription-userinfo-upload') || '0')) : null,
          remainingTraffic: response.headers.get('subscription-userinfo-total') ? formatTraffic(parseInt(response.headers.get('subscription-userinfo-total') || '0') - parseInt(response.headers.get('subscription-userinfo-download') || '0') - parseInt(response.headers.get('subscription-userinfo-upload') || '0')) : null,
          expiryDate: response.headers.get('subscription-userinfo-expire') ? new Date(parseInt(response.headers.get('subscription-userinfo-expire') || '0') * 1000).toLocaleDateString() : null,
        };
        
        // 尝试解析完整的Subscription-Userinfo头
        const subUserInfo = response.headers.get('subscription-userinfo');
        if (subUserInfo) {
          // 格式示例：upload=1; download=1; total=100; expire=1640995200
          const parts = subUserInfo.split(';').map(part => part.trim());
          for (const part of parts) {
            const [key, value] = part.split('=').map(item => item.trim());
            if (key === 'upload' && !subscriptionInfo.usedTraffic) {
              const upload = parseInt(value) || 0;
              const download = parseInt(parts.find(p => p.startsWith('download='))?.split('=')[1] || '0');
              subscriptionInfo.usedTraffic = formatTraffic(upload + download);
            }
            if (key === 'total' && !subscriptionInfo.remainingTraffic) {
              const total = parseInt(value) || 0;
              const upload = parseInt(parts.find(p => p.startsWith('upload='))?.split('=')[1] || '0');
              const download = parseInt(parts.find(p => p.startsWith('download='))?.split('=')[1] || '0');
              if (total > 0) {
                subscriptionInfo.remainingTraffic = formatTraffic(Math.max(0, total - upload - download));
              }
            }
            if (key === 'expire' && !subscriptionInfo.expiryDate) {
              const expire = parseInt(value) || 0;
              if (expire > 0) {
                subscriptionInfo.expiryDate = new Date(expire * 1000).toLocaleDateString();
              }
            }
          }
        }
        
        console.log('订阅流量信息:', subscriptionInfo);
        
        const content = await response.text();
        
        if (!content || content.trim() === '') {
          throw new Error('订阅内容为空');
        }
        
        // 检查获取的内容是否是有效的YAML或JSON
        try {
          yaml.load(content);
        } catch (yamlError) {
          try {
            JSON.parse(content);
          } catch (jsonError) {
            console.error('YAML解析失败:', yamlError);
            console.error('JSON解析失败:', jsonError);
            throw new Error('订阅内容格式无效，不是有效的YAML或JSON');
          }
        }
        
        console.log('订阅内容获取成功，长度:', content.length);
        return {
          content,
          subscriptionInfo
        };
      } catch (fetchError) {
        console.error('获取订阅内容失败:', fetchError);
        throw new Error(`无法获取订阅内容: ${fetchError.message}`);
      }
    } catch (error) {
      console.error('获取订阅失败:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('open-external', (event, url) => {
    shell.openExternal(url);
    return { success: true };
  });

  // 增强安全 - 打开文件，添加令牌验证
  ipcMain.handle('open-file', async (event, token, filePath) => {
    try {
      // 获取请求来源窗口
      const webContents = event.sender;
      const win = BrowserWindow.fromWebContents(webContents);
      
      if (!win) {
        console.error('文件操作验证失败: 无法确定请求窗口');
        return { success: false, error: '安全验证失败: 无法确定请求窗口' };
      }
      
      // 完整的令牌验证
      if (!sessionTokenManager.validateToken(token, win.id, 'open-file')) {
        console.error('文件操作验证失败: 令牌无效');
        security.logSecurityEvent('invalid-token-file', {
          windowId: win.id,
          url: webContents.getURL(),
          filePath
        }, path.join(userDataPath, 'security.log'));
        return { success: false, error: '安全验证失败: 令牌无效' };
      }
      
      // 验证文件路径
      const pathValidation = security.validateFilePath(filePath);
      if (!pathValidation.valid) {
        console.error('文件路径验证失败:', pathValidation.error);
        return { success: false, error: pathValidation.error };
      }
      
      // 验证通过，记录安全事件
      security.logSecurityEvent('open-file', { 
        path: filePath,
        windowId: win.id,
        url: webContents.getURL()
      }, path.join(userDataPath, 'security.log'));
      
      // 在Windows上，使用shell.openPath打开文件
      console.log(`文件操作请求已授权 [窗口ID: ${win.id}, 文件: ${filePath}]`);
      shell.openPath(filePath);
      return { success: true };
    } catch (error) {
      console.error('打开文件失败:', error);
      return { success: false, error: error.message };
    }
  });

  // 新增：打开文件所在目录
  ipcMain.handle('open-file-location', (event, filePath) => {
    try {
      // 验证文件路径
      const pathValidation = security.validateFilePath(filePath);
      if (!pathValidation.valid) {
        console.error('文件路径验证失败:', pathValidation.error);
        return { success: false, error: pathValidation.error };
      }
      
      // 记录安全事件
      security.logSecurityEvent('open-file-location', { 
        path: filePath 
      }, path.join(userDataPath, 'security.log'));
      
      // 在Windows上，使用shell.showItemInFolder打开文件所在目录
      shell.showItemInFolder(filePath);
      return { success: true };
    } catch (error) {
      console.error('打开文件所在目录失败:', error);
      return { success: false, error: error.message };
    }
  });

  // 新增：更新指定的订阅
  ipcMain.handle('refresh-subscription', async (event, filePath) => {
    try {
      // 获取订阅URL
      // 直接调用get-subscription-url处理程序函数
      const getSubscriptionUrlHandler = async (filePath) => {
        try {
          // 获取文件名
          const fileName = path.basename(filePath);
          
          // 读取订阅URL记录
          const urlsPath = path.join(configDir, 'subscription_urls.json');
          if (!fs.existsSync(urlsPath)) {
            console.log('订阅URL记录文件不存在，尝试创建新记录');
            
            // 创建一个空的记录文件
            fs.writeFileSync(urlsPath, JSON.stringify({}, null, 2), 'utf8');
            
            // 对于旧版本添加的订阅，我们可以提示用户重新添加
            return { success: false, error: '未找到订阅URL记录。这可能是因为此订阅是在旧版本添加的，请尝试删除并重新添加订阅。' };
          }
          
          // 解析记录文件
          const urlsData = JSON.parse(fs.readFileSync(urlsPath, 'utf8'));
          
          // 首先尝试使用完整文件名查找
          let url = urlsData[fileName];
          
          // 如果找不到，尝试只使用文件名部分（不包含路径）
          if (!url) {
            const fileNameOnly = fileName.replace(/\.yaml$/, '');
            for (const [key, value] of Object.entries(urlsData)) {
              const keyWithoutExt = key.replace(/\.yaml$/, '');
              if (keyWithoutExt === fileNameOnly) {
                url = value;
                
                // 更新记录以使用正确的文件名
                urlsData[fileName] = value;
                fs.writeFileSync(urlsPath, JSON.stringify(urlsData, null, 2), 'utf8');
                break;
              }
            }
          }
          
          if (!url) {
            console.log(`未找到文件 ${fileName} 对应的订阅URL`);
            return { success: false, error: '未找到对应的订阅URL。请尝试删除并重新添加订阅。' };
          }
          
          console.log(`找到文件 ${fileName} 对应的订阅URL: ${url}`);
          return { success: true, url };
        } catch (error) {
          console.error('获取订阅URL失败:', error);
          return { success: false, error: error.message };
        }
      };
      
      const urlResult = await getSubscriptionUrlHandler(filePath);
      
      if (!urlResult.success || !urlResult.url) {
        return { success: false, error: urlResult.error || '无法获取订阅URL' };
      }
      
      const subUrl = urlResult.url;
      console.log(`准备刷新订阅: ${filePath}, URL: ${subUrl}`);
      
      // 检查是否为本地文件导入
      const isLocalFile = subUrl && typeof subUrl === 'string' && subUrl.startsWith('local:');
      console.log('是否为本地文件导入:', isLocalFile);
      
      // 验证URL (只对非本地文件进行验证)
      let validUrl = subUrl;
      if (!isLocalFile) {
        if (!subUrl || typeof subUrl !== 'string') {
          throw new Error('无效的订阅URL: URL不能为空');
        }
        
        // 规范化URL - 确保去除前后空格
        validUrl = subUrl.trim();
        
        // 尝试添加协议前缀（如果缺少）
        if (!validUrl.match(/^https?:\/\//i)) {
          console.log('URL缺少协议前缀，自动添加https://');
          validUrl = 'https://' + validUrl;
        }
        
        try {
          // 验证URL格式
          new URL(validUrl);
        } catch (urlError) {
          console.error('URL格式无效:', urlError);
          throw new Error(`无效的订阅URL: ${urlError.message}`);
        }
      } else {
        // 对于本地文件导入，直接返回成功，不需要再次下载内容
        console.log('本地导入的配置文件不需要刷新');
        return { success: true, message: '本地导入的配置文件不需要刷新' };
      }
      
      // 获取订阅内容
      const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
      
      console.log('正在获取订阅内容...');
      
      // 获取User-Agent设置
      const userSettings = getUserSettings();
      
      // 使用安全模块获取User-Agent
      const userAgent = security.getSafeUserAgent(userSettings['subscription-ua'], APP_VERSION);
      
      console.log(`使用User-Agent: ${userAgent}`);
      console.log(`开始请求订阅内容: ${validUrl}`);
      
      // 记录安全事件
      security.logSecurityEvent('subscription-refresh', { 
        url: validUrl,
        filePath,
        userAgent
      }, path.join(userDataPath, 'security.log'));
      
      const response = await fetch(validUrl, {
        headers: {
          'User-Agent': userAgent
        }
      });
      
      if (!response.ok) {
        throw new Error(`获取订阅失败: ${response.statusText}`);
      }
      
      // 解析响应头的订阅信息
      const subscriptionInfo = {
        usedTraffic: response.headers.get('subscription-userinfo-upload') ? formatTraffic(parseInt(response.headers.get('subscription-userinfo-upload') || '0')) : null,
        remainingTraffic: response.headers.get('subscription-userinfo-total') ? formatTraffic(parseInt(response.headers.get('subscription-userinfo-total') || '0') - parseInt(response.headers.get('subscription-userinfo-download') || '0') - parseInt(response.headers.get('subscription-userinfo-upload') || '0')) : null,
        expiryDate: response.headers.get('subscription-userinfo-expire') ? new Date(parseInt(response.headers.get('subscription-userinfo-expire') || '0') * 1000).toLocaleDateString() : null,
      };
      
      // 尝试解析完整的Subscription-Userinfo头
      const subUserInfo = response.headers.get('subscription-userinfo');
      if (subUserInfo) {
        // 格式示例：upload=1; download=1; total=100; expire=1640995200
        const parts = subUserInfo.split(';').map(part => part.trim());
        for (const part of parts) {
          const [key, value] = part.split('=').map(item => item.trim());
          if (key === 'upload' && !subscriptionInfo.usedTraffic) {
            const upload = parseInt(value) || 0;
            const download = parseInt(parts.find(p => p.startsWith('download='))?.split('=')[1] || '0');
            subscriptionInfo.usedTraffic = formatTraffic(upload + download);
          }
          if (key === 'total' && !subscriptionInfo.remainingTraffic) {
            const total = parseInt(value) || 0;
            const upload = parseInt(parts.find(p => p.startsWith('upload='))?.split('=')[1] || '0');
            const download = parseInt(parts.find(p => p.startsWith('download='))?.split('=')[1] || '0');
            if (total > 0) {
              subscriptionInfo.remainingTraffic = formatTraffic(Math.max(0, total - upload - download));
            }
          }
          if (key === 'expire' && !subscriptionInfo.expiryDate) {
            const expire = parseInt(value) || 0;
            if (expire > 0) {
              subscriptionInfo.expiryDate = new Date(expire * 1000).toLocaleDateString();
            }
          }
        }
      }
      
      console.log('订阅流量信息:', subscriptionInfo);
      
      const configData = await response.text();
      
      if (!configData || configData.trim() === '') {
        throw new Error('订阅内容为空');
      }
      
      // 检查获取的内容是否是有效的YAML或JSON
      try {
        yaml.load(configData);
      } catch (yamlError) {
        try {
          JSON.parse(configData);
        } catch (jsonError) {
          throw new Error('订阅内容格式无效，不是有效的YAML或JSON');
        }
      }
      
      // 直接实现更新订阅文件的功能
      try {
        // 确保文件路径和配置数据有效
        if (!filePath || !configData) {
          throw new Error('无效的文件路径或配置数据');
        }
        
        console.log('正在更新订阅文件:', filePath);
        
        // 备份原始文件
        const backupPath = `${filePath}.bak`;
        if (fs.existsSync(filePath)) {
          fs.copyFileSync(filePath, backupPath);
        }
        
        // 写入新的配置内容
        fs.writeFileSync(filePath, configData, 'utf8');
        
        // 更新订阅URL的记录（如果有记录系统）
        if (subUrl) {
          try {
            // 读取订阅URL记录文件（如果存在）
            const urlsPath = path.join(configDir, 'subscription_urls.json');
            let urlsData = {};
            if (fs.existsSync(urlsPath)) {
              urlsData = JSON.parse(fs.readFileSync(urlsPath, 'utf8'));
            }
            
            // 更新URL记录
            urlsData[path.basename(filePath)] = subUrl;
            
            // 保存更新后的记录
            fs.writeFileSync(urlsPath, JSON.stringify(urlsData, null, 2));
          } catch (error) {
            console.warn('更新订阅URL记录失败，但配置文件已更新:', error);
          }
        }
        
        // 保存订阅信息（流量、到期时间等）
        if (subscriptionInfo) {
          try {
            // 获取或创建订阅信息记录文件
            const infoPath = path.join(configDir, 'subscription_info.json');
            let infoData = {};
            
            if (fs.existsSync(infoPath)) {
              infoData = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
            }
            
            // 将新的订阅信息添加到记录中
            infoData[path.basename(filePath)] = {
              ...subscriptionInfo,
              lastUpdated: new Date().toISOString()
            };
            
            // 保存更新的记录
            fs.writeFileSync(infoPath, JSON.stringify(infoData, null, 2));
          } catch (error) {
            console.warn('保存订阅信息记录失败，但配置文件已更新:', error);
          }
        }
        
        console.log('订阅更新成功');
        return { success: true, filePath };
      } catch (error) {
        console.error('更新订阅失败:', error);
        // 如果有备份，尝试恢复
        const backupPath = `${filePath}.bak`;
        if (fs.existsSync(backupPath)) {
          try {
            fs.copyFileSync(backupPath, filePath);
            console.log('已从备份恢复原始文件');
          } catch (restoreError) {
            console.error('从备份恢复失败:', restoreError);
          }
        }
        return { success: false, error: error.message };
      }
    } catch (error) {
      console.error('刷新订阅失败:', error);
      return { 
        success: false, 
        error: error.message || '刷新订阅时发生未知错误'
      };
    }
  });

  // 切换节点
  ipcMain.handle('select-node', async (event, nodeName, groupName, updateGlobal = false) => {
    try {
      console.log(`切换节点: ${nodeName} 在组 ${groupName}`);
      
      if (!groupName) {
        groupName = 'PROXY'; // 默认使用PROXY组
      }
      
      // 切换指定组的节点
      const response = await fetchMihomoAPI(`/proxies/${encodeURIComponent(groupName)}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ name: nodeName })
        });

      if (!response.ok) {
        throw new Error(`切换节点失败: ${response.statusText}`);
      }
      
      console.log(`成功切换到节点: ${nodeName} 在组 ${groupName}`);
      
      // 如果是PROXY或GLOBAL组，或者要求更新全局节点，更新当前节点变量
      if (groupName === 'PROXY' || groupName === 'GLOBAL' || updateGlobal) {
        currentNode = nodeName;
        console.log('更新当前节点:', currentNode);
        
        // 更新托盘菜单
        updateTrayMenu();
      }
      
      return { success: true };
    } catch (error) {
      console.error('选择节点失败:', error);
      return { success: false, error: error.message };
    }
  });

  // 新增：接收节点变更通知
  ipcMain.handle('notify-node-changed', async (event, nodeName) => {
    try {
      console.log(`接收到节点变更通知: ${nodeName}`);
      
      // 更新当前节点
      currentNode = nodeName;
      
      // 更新托盘菜单以反映新节点
      updateTrayMenu();
      
      return { success: true };
    } catch (error) {
      console.error('处理节点变更通知失败:', error);
      return { success: false, error: error.message };
    }
  });

  // 新增：获取代理节点信息
  ipcMain.handle('get-proxies', async (event) => {
    try {
      console.log(`[DEBUG] 开始获取代理节点信息`);
      
      // 检查Mihomo服务状态
      const isServiceRunning = await checkMihomoService();
      if (!isServiceRunning) {
        console.error('[DEBUG] Mihomo服务未运行');
        throw new Error('Mihomo服务未运行，请先启动Mihomo');
      }
      
      // 使用fetch API获取代理节点信息
      const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
      
      // 获取代理节点信息
      if (!activeApiConfig) {
        console.error('无法获取代理节点: API配置不可用');
        return;
      }
      
      const apiUrl = `http://${activeApiConfig.controllerHost}:${activeApiConfig.controllerPort}/proxies`;
      const headers = {};
      
      // 如果有secret，添加到请求头
      if (activeApiConfig.secret) {
        headers['Authorization'] = `Bearer ${activeApiConfig.secret}`;
      }
      
      const response = await fetch(apiUrl, { headers });
      if (response.ok) {
        const data = await response.json();
        
        console.log(`[DEBUG] 获取代理节点信息成功`);
        
        // 处理数据，提取节点组和当前选中的节点
        const groups = [];
        let selected = null;
        
        // 首先查找PROXY组
        if (data.proxies && data.proxies['PROXY']) {
          const proxyGroup = data.proxies['PROXY'];
          selected = proxyGroup.now;
          
          // 提取节点组
          if (proxyGroup.all && proxyGroup.all.length > 0) {
            const nodes = [];
            for (const nodeName of proxyGroup.all) {
              if (data.proxies[nodeName]) {
                const node = data.proxies[nodeName];
                nodes.push({
                  name: nodeName,
                  type: node.type,
                  server: node.server || '',
                  port: node.port || 0,
                  delay: node.delay || undefined
                });
              }
            }
            
            groups.push({
              name: 'PROXY',
              type: proxyGroup.type,
              nodes: nodes
            });
          }
        }
        // 如果PROXY组不存在，则查找GLOBAL组作为备选
        else if (data.proxies && data.proxies['GLOBAL']) {
          const globalGroup = data.proxies['GLOBAL'];
          selected = globalGroup.now;
          
          // 提取节点组
          if (globalGroup.all && globalGroup.all.length > 0) {
            const nodes = [];
            for (const nodeName of globalGroup.all) {
              if (data.proxies[nodeName]) {
                const node = data.proxies[nodeName];
                nodes.push({
                  name: nodeName,
                  type: node.type,
                  server: node.server || '',
                  port: node.port || 0,
                  delay: node.delay || undefined
                });
              }
            }
            
            groups.push({
              name: 'GLOBAL',
              type: globalGroup.type,
              nodes: nodes
            });
          }
        }
        
        // 提取其他节点组
        for (const [name, proxy] of Object.entries(data.proxies)) {
          if (proxy.type === 'Selector' || proxy.type === 'URLTest' || proxy.type === 'Fallback' || proxy.type === 'LoadBalance') {
            if (name !== 'GLOBAL' && name !== 'PROXY' && proxy.all && proxy.all.length > 0) {
              const nodes = [];
              for (const nodeName of proxy.all) {
                if (data.proxies[nodeName]) {
                  const node = data.proxies[nodeName];
                  nodes.push({
                    name: nodeName,
                    type: node.type,
                    server: node.server || '',
                    port: node.port || 0,
                    delay: node.delay || undefined
                  });
                }
              }
              
              groups.push({
                name: name,
                type: proxy.type,
                nodes: nodes
              });
            }
          }
        }
        
        return {
          groups: groups,
          selected: selected
        };
      }
    } catch (error) {
      console.error(`[DEBUG] 获取代理节点信息失败:`, error);
      return { groups: [], selected: null };
    }
  });

  // 测试节点延迟
  ipcMain.handle('test-node-delay', async (event, nodeName) => {
    try {
      console.log(`[DEBUG] 开始测试节点延迟: ${nodeName}`);
      
      // 检查Mihomo服务状态
      const isServiceRunning = await checkMihomoService();
      if (!isServiceRunning) {
        console.error('[DEBUG] Mihomo服务未运行，无法测试节点延迟');
        throw new Error('Mihomo服务未运行，无法测试节点延迟');
      }
      
      // 使用fetch API测试节点延迟
          const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
      
      // 设置URL和参数
      const url = new URL(`http://127.0.0.1:9090/proxies/${encodeURIComponent(nodeName)}/delay`);
      url.searchParams.append('url', 'http://www.gstatic.com/generate_204');
      url.searchParams.append('timeout', '5000');
      
      // 发送请求
      console.log(`[DEBUG] 发送测试延迟请求: ${url.toString()}`);
      const response = await fetch(url.toString());
      
      // 处理响应
          if (response.ok) {
            const data = await response.json();
        console.log(`[DEBUG] 节点 ${nodeName} 延迟测试结果: ${data.delay}ms`);
        
        // 返回延迟结果 - 0ms表示超时或不可用，所以直接返回0
        return data.delay;
          } else {
        const errorText = await response.text();
        console.error(`[DEBUG] 测试节点延迟失败: ${response.status} ${response.statusText} - ${errorText}`);
        
        // API调用失败也表示不可用，返回0
        return 0;
          }
        } catch (error) {
      console.error(`[DEBUG] 测试节点延迟过程中出错:`, error);
      
      // 返回0表示测试失败/超时
      return 0;
    }
  });

  ipcMain.handle('get-active-config', () => {
    // 通过configFilePath判断mihomo是否在运行
    // 如果mihomo已停止，这里应该返回null
    return configFilePath || null;
  });
  
  ipcMain.handle('get-proxy-nodes', (event, configPath) => {
    try {
      // 如果指定了配置路径，则使用指定的路径
      // 否则使用当前激活的配置
      const config = configPath || configFilePath;
      if (!config) {
        return null;
      }
      
      return parseConfigFile(config);
    } catch (error) {
      console.error('获取代理节点失败:', error);
      return null;
    }
  });
  
  // 处理获取应用版本号
  ipcMain.handle('get-app-version', () => {
    return APP_VERSION;
  });

  // 处理自动启动设置
  ipcMain.handle('set-auto-start', (event, enabled) => {
    autoStartEnabled = enabled;
    return true;
  });
  
  // 获取自动启动设置
  ipcMain.handle('get-auto-start', () => {
    return autoStartEnabled;
  });
  
  // 节点收藏管理
  ipcMain.handle('get-favorite-nodes', () => {
    try {
      const favoritesPath = path.join(userDataPath, 'favorites.json');
      if (!fs.existsSync(favoritesPath)) {
        console.log('收藏节点文件不存在');
        return { success: true, nodes: [] };
      }
      
      const favoritesData = JSON.parse(fs.readFileSync(favoritesPath, 'utf8'));
      console.log('成功加载收藏节点:', favoritesData);
      return { success: true, nodes: favoritesData };
    } catch (error) {
      console.error('获取收藏节点失败:', error);
      return { success: false, nodes: [], error: error.message };
    }
  });
  
  ipcMain.handle('save-favorite-nodes', (event, nodes) => {
    try {
      if (!Array.isArray(nodes)) {
        throw new Error('无效的节点数据格式');
      }
      
      const favoritesPath = path.join(userDataPath, 'favorites.json');
      fs.writeFileSync(favoritesPath, JSON.stringify(nodes), 'utf8');
      console.log('收藏节点保存成功:', nodes);
      return { success: true };
    } catch (error) {
      console.error('保存收藏节点失败:', error);
      return { success: false, error: error.message };
    }
  });
  
  // 节点组折叠管理
  ipcMain.handle('get-collapsed-groups', () => {
    try {
      const collapsedPath = path.join(userDataPath, 'collapsed-groups.json');
      if (!fs.existsSync(collapsedPath)) {
        console.log('折叠组文件不存在');
        return { success: true, groups: [] };
      }
      
      const collapsedData = JSON.parse(fs.readFileSync(collapsedPath, 'utf8'));
      console.log('成功加载折叠组:', collapsedData);
      return { success: true, groups: collapsedData };
    } catch (error) {
      console.error('获取折叠组失败:', error);
      return { success: false, groups: [], error: error.message };
    }
  });
  
  ipcMain.handle('save-collapsed-groups', (event, groups) => {
    try {
      if (!Array.isArray(groups)) {
        throw new Error('无效的组数据格式');
      }
      
      const collapsedPath = path.join(userDataPath, 'collapsed-groups.json');
      fs.writeFileSync(collapsedPath, JSON.stringify(groups), 'utf8');
      console.log('折叠组保存成功:', groups);
      return { success: true };
    } catch (error) {
      console.error('保存折叠组失败:', error);
      return { success: false, error: error.message };
    }
  });
  
  // 保存日志到文件
  ipcMain.handle('save-logs', (event, logEntries) => {
    try {
      const logsDir = path.join(userDataPath, 'logs');
      if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
      }
      
      const date = new Date();
      const fileName = `mihomo-logs-${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}-${String(date.getHours()).padStart(2, '0')}-${String(date.getMinutes()).padStart(2, '0')}.txt`;
      const filePath = path.join(logsDir, fileName);
      
      // 格式化日志内容
      const logContent = logEntries.map(entry => {
        const timestamp = new Date(entry.timestamp).toLocaleString();
        const type = entry.type === 'error' ? '[错误]' : '[信息]';
        return `${timestamp} ${type} ${entry.content}`;
      }).join('\n');
      
      fs.writeFileSync(filePath, logContent, 'utf8');
      console.log(`日志已保存到: ${filePath}`);
      
      return { success: true, filePath };
    } catch (error) {
      console.error('保存日志失败:', error);
      return { success: false, error: error.message };
    }
  });

  // 修改: 切换系统代理，添加令牌验证
  ipcMain.handle('toggleSystemProxy', async (event, token, enabled) => {
    try {
      // 获取请求来源窗口
      const webContents = event.sender;
      const win = BrowserWindow.fromWebContents(webContents);
      
      if (!win) {
        console.error('系统代理切换验证失败: 无法确定请求窗口');
        return { success: false, error: '安全验证失败: 无法确定请求窗口' };
      }
      
      // 完整的令牌验证
      if (!sessionTokenManager.validateToken(token, win.id, 'toggleSystemProxy')) {
        console.error('系统代理切换验证失败: 令牌无效');
        security.logSecurityEvent('invalid-token-proxy', {
          windowId: win.id,
          url: webContents.getURL()
        }, path.join(userDataPath, 'security.log'));
        return { success: false, error: '安全验证失败: 令牌无效' };
      }
      
      // 验证通过，执行实际操作
      console.log(`系统代理切换请求已授权 [窗口ID: ${win.id}, 启用: ${enabled}]`);
      // 创建一个模拟的菜单项对象
      const menuItem = { checked: enabled };
      
      // 调用现有的toggleSystemProxy函数
      toggleSystemProxy(menuItem);
      
      // 返回当前的系统代理状态
      return { success: true, status: systemProxyEnabled };
    } catch (error) {
      console.error('切换系统代理失败:', error);
      return { success: false, error: `操作失败: ${error.message}` };
    }
  });

  // 新增: 获取系统代理状态
  ipcMain.handle('getProxyStatus', async () => {
    return systemProxyEnabled;
  });

  // 添加获取连接信息的函数
  ipcMain.handle('get-connections', async () => {
    try {
      const response = await fetchMihomoAPI('/connections');
      if (response.ok) {
        const data = await response.json();
        console.log('获取到连接信息:', data); // 添加日志
        return data;
      } else {
        console.error('获取连接信息失败:', response.status, response.statusText);
        return null;
      }
    } catch (error) {
      console.error('获取连接信息失败:', error);
      return null;
    }
  });

  // 添加关闭特定连接的函数
  ipcMain.handle('close-connection', async (event, connectionId) => {
    try {
      console.log(`尝试关闭连接: ${connectionId}`); // 添加日志
      const response = await fetchMihomoAPI(`/connections/${connectionId}`, {
          method: 'DELETE'
        });
      const success = response.ok;
      console.log(`关闭连接结果: ${success ? '成功' : '失败'}`); // 添加日志
      return success;
    } catch (error) {
      console.error('关闭连接失败:', error);
      return false;
    }
  });

  // 添加关闭所有连接的函数
  ipcMain.handle('close-all-connections', async () => {
    try {
      console.log('尝试关闭所有连接'); // 添加日志
      const response = await fetchMihomoAPI('/connections', {
          method: 'DELETE'
        });
      const success = response.ok;
      console.log(`关闭所有连接结果: ${success ? '成功' : '失败'}`); // 添加日志
      return success;
    } catch (error) {
      console.error('关闭所有连接失败:', error);
      return false;
    }
  });

  // 处理连接信息更新
  ipcMain.on('connections-update', (event, data) => {
    if (mainWindow) {
      console.log('[调试] 处理IPC connections-update事件:', data);
      
      // 确保connections数组存在
      const connections = data.connections || [];
      
      // 计算活跃连接数 - 与fetchConnectionsInfo保持一致
      const activeConnections = connections.filter(conn => conn.isActive !== false).length;
      
      // 使用相同的字段结构发送到前端
      mainWindow.webContents.send('connections-update', {
        connections: connections,
        downloadTotal: data.downloadTotal || 0,
        uploadTotal: data.uploadTotal || 0,
        currentNode: currentNode,
        activeConnections: activeConnections
      });
      
      console.log(`[调试] 通过IPC发送连接更新，总连接数: ${connections.length}, 活跃连接: ${activeConnections}`);
    }
  });

  // 处理节点变更
  ipcMain.on('node-changed', (event, data) => {
    if (mainWindow) {
      console.log('[调试] 处理节点变更事件:', data);
      // 更新当前节点
      if (data && data.nodeName) {
        currentNode = data.nodeName;
      }
      
      mainWindow.webContents.send('node-changed', {
        nodeName: data && data.nodeName ? data.nodeName : (currentNode || '无')
      });
      
      // 同时更新连接信息
      const connections = lastConnectionsInfo.connections || [];
      const activeConnections = connections.filter(conn => conn.isActive !== false).length;
      
      const connectionInfo = {
        ...lastConnectionsInfo,
        currentNode: currentNode,
        activeConnections: activeConnections
      };
      
      console.log(`[调试] 节点变更后发送连接更新，总连接数: ${connections.length}, 活跃连接: ${activeConnections}`);
      mainWindow.webContents.send('connections-update', connectionInfo);
    }
  });

  // 新增：获取总连接信息和总流量
  ipcMain.handle('fetch-connections-info', async () => {
    return fetchConnectionsInfo();
  });

  // 添加API保存最后一次使用的配置文件
  ipcMain.handle('save-last-config', (event, configPath) => {
    try {
      if (!configPath) {
        console.log('无效的配置路径，无法保存');
        return { success: false, error: '无效的配置路径' };
      }
      
      // 保存配置路径到用户数据目录
      const lastConfigPath = path.join(userDataPath, 'last-config.json');
      fs.writeFileSync(lastConfigPath, JSON.stringify({ path: configPath }, null, 2), 'utf8');
      console.log('已保存最后使用的配置文件:', configPath);
      
      return { success: true };
    } catch (error) {
      console.error('保存最后使用的配置文件失败:', error);
      return { success: false, error: error.message };
    }
  });

  // 添加重启Mihomo服务的函数（用于配置修改后）
  ipcMain.handle('restart-service', async () => {
    try {
      // 保存当前的配置路径
      const currentConfig = configFilePath;
      
      // 先停止服务
      if (mihomoProcess) {
        mihomoProcess.kill();
        mihomoProcess = null;
        stopTrafficStatsUpdate();
        stopAllWebSockets();
        
        // 等待进程完全关闭
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      
      // 然后使用相同的配置重启
      if (currentConfig) {
        const success = await startMihomo(currentConfig);
        return { success, message: success ? '服务已重启' : '重启失败' };
      } else {
        return { success: false, message: '没有活动的配置文件' };
      }
    } catch (error) {
      console.error('重启服务失败:', error);
      return { success: false, message: `重启失败: ${error.message}` };
    }
  });

  // 添加: 启动Mihomo
  ipcMain.handle('start-mihomo', async (event, configPath) => {
    try {
      if (!configPath) {
        console.error('启动Mihomo失败: 未提供配置路径');
        return false;
      }
      return await startMihomo(configPath);
    } catch (error) {
      console.error('启动Mihomo处理程序出错:', error);
      return false;
    }
  });

  // 添加: 停止Mihomo
  ipcMain.handle('stop-mihomo', async () => {
    try {
      if (mihomoProcess) {
        mihomoProcess.kill();
        mihomoProcess = null;
        stopTrafficStatsUpdate();

        // 停止所有 WebSocket 监控
        stopAllWebSockets();

        // 清除configFilePath，这样get-active-config将返回null
        configFilePath = null;
        console.log('Mihomo已停止');
        return true;
      }
      return false;
    } catch (error) {
      console.error('停止Mihomo失败:', error);
      return false;
    }
  });

  // 设置开机启动
  ipcMain.handle('set-auto-launch', (event, enabled) => {
    setAutoLaunch(enabled);
    return true;
  });

  // 获取开机启动状态
  ipcMain.handle('get-auto-launch-state', () => {
    return getAutoLaunchState();
  });

  // 获取代理设置
  ipcMain.handle('get-proxy-settings', () => {
    try {
      const settings = getUserSettings();
      return { success: true, settings };
    } catch (error) {
      console.error('获取代理设置失败:', error);
      return { success: false, error: error.message };
    }
  });

  // 保存代理设置
  ipcMain.handle('save-proxy-settings', (event, settings) => {
    try {
      console.log('正在保存代理设置:', settings);
      
      // 验证设置对象
      if (!settings || typeof settings !== 'object') {
        console.error('接收到无效的设置对象');
        return { 
          success: false, 
          error: '无效的设置对象' 
        };
      }
      
      // 验证设置字段
      if ('mixed-port' in settings) {
        if (typeof settings['mixed-port'] !== 'number') {
          console.error('端口字段不是数字:', settings['mixed-port']);
          return { 
            success: false, 
            error: '端口号必须是数字' 
          };
        }
        
        if (settings['mixed-port'] < 1 || settings['mixed-port'] > 65535) {
          console.error('端口号超出范围:', settings['mixed-port']);
          return { 
            success: false, 
            error: '端口号无效，必须是1-65535之间的数字' 
          };
        }
      }
      
      // 更新设置
      console.log('验证通过，正在更新用户设置');
      const success = updateUserSettings(settings);
      
      // 获取当前配置路径
      const currentConfig = configFilePath;
      
      // 如果Mihomo正在运行，进行完全重启
      if (success && mihomoProcess && mihomoProcess.pid && currentConfig) {
        console.log('Mihomo正在运行，将重启服务应用新设置');
        try {
          // 停止现有进程
          if (mihomoProcess) {
            mihomoProcess.kill();
            stopTrafficStatsUpdate();
            stopAllWebSockets();
            // 等待进程完全终止
            setTimeout(async () => {
              mihomoProcess = null;
              // 重启Mihomo
              const restarted = await startMihomo(currentConfig);
              console.log('重启结果:', restarted);
              
              if (restarted) {
                // 通知前端重启成功
                if (mainWindow) {
                  mainWindow.webContents.send('service-restarted', { success: true });
                }
                console.log('服务已重启并应用新设置');
              } else {
                // 通知前端重启失败
                if (mainWindow) {
                  mainWindow.webContents.send('service-restarted', { 
                    success: false, 
                    error: '重启服务失败' 
                  });
                }
                console.error('重启服务失败');
              }
            }, 1000);
          }
          
          return { 
            success: true, 
            message: '设置已保存，正在重启服务应用新设置...' 
          };
        } catch (restartError) {
          console.error('重启服务过程中出错:', restartError);
          return { 
            success: true, 
            message: '设置已保存，但重启失败: ' + restartError.message
          };
        }
      }
      
      return { 
        success, 
        message: success ? '设置已保存' : '保存设置失败' 
      };
    } catch (error) {
      console.error('保存代理设置失败:', error);
      return { 
        success: false, 
        error: `保存设置时发生错误: ${error.message}` 
      };
    }
  });

  // 设置开机启动
  ipcMain.handle('set-auto-launch', (event, enabled) => {
    setAutoLaunch(enabled);
    return true;
  });

  // 添加工具相关的功能
  async function openToolsApp(toolName) {
    try {
      let toolsPath;
      
      if (isDev) {
        // 开发环境下，tools目录在项目根目录下
        toolsPath = path.join(process.cwd(), 'tools', toolName);
      } else {
        // 生产环境，tools目录在resources下
        toolsPath = path.join(process.resourcesPath, 'tools', toolName);
      }
      
      // 检查工具是否存在
      if (!fs.existsSync(toolsPath)) {
        console.error(`工具文件不存在: ${toolsPath}`);
        return { success: false, error: '工具文件不存在' };
      }
      
      // 在Windows上使用shell.openPath启动工具
      await shell.openPath(toolsPath);
      console.log(`工具已启动: ${toolsPath}`);
      return { success: true };
    } catch (error) {
      console.error('启动工具出错:', error);
      return { success: false, error: error.message || '未知错误' };
    }
  }

  // 设置IPC通信处理器
  ipcMain.handle('get-app-version', () => appVersion);
  ipcMain.handle('start-mihomo', (_, configPath) => startMihomo(configPath));
  ipcMain.handle('stop-mihomo', stopMihomo);
  ipcMain.handle('get-traffic-stats', () => lastTrafficStats);
  ipcMain.handle('restart-service', restartMihomoService);
  ipcMain.handle('open-tools-app', (_, toolName) => openToolsApp(toolName));
});

// 媒体服务检测 - 将其移到闭包外以确保正常注册
ipcMain.handle('test-media-streaming', async (event, serviceName, checkUrl) => {
  try {
    console.log(`收到媒体检测请求: ${serviceName}, URL: ${checkUrl}`);
    console.log(`请确认mediatest.js模块已正确加载，testMediaStreaming函数是否存在:`, testMediaStreaming ? '存在' : '不存在');
    
    // 记录所有可能的服务名变体，方便调试
    const nameVariants = {
      'AbemaTV': ['Abema TV', 'AbemaTV', 'Abema'],
      'myTVSuper': ['MyTVSuper', 'myTVSuper', 'mytvsuper', 'My TV Super']
    };
    
    // 检查是否是已知服务的变体名称，如果是则显示相关信息
    for (const [standardName, variants] of Object.entries(nameVariants)) {
      if (variants.includes(serviceName)) {
        console.log(`服务名称"${serviceName}"是"${standardName}"的变体，将使用标准名称处理`);
      }
    }
    
    const result = await testMediaStreaming(serviceName, checkUrl);
    console.log(`媒体检测完成，返回结果:`, result);
    return result;
  } catch (error) {
    console.error('处理媒体检测请求出错:', error);
    return {
      available: false,
      message: '内部错误: ' + error.message,
      checkTime: 0
    };
  }
});

app.on('window-all-closed', () => {
  stopAllWebSockets(); // 停止连接管理
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  if (mihomoProcess) {
    mihomoProcess.kill();
  }
  
  // 关闭静态文件服务器
  if (global.staticServer && global.staticServer.listening) {
    console.log('关闭静态文件服务器');
    global.staticServer.close();
  }
  
  // 确保退出时关闭系统代理
  try {
    execSync('reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 0 /f');
  } catch (error) {
    console.error('Failed to disable system proxy on exit:', error);
  }
});

// 辅助函数：查找包含特定节点的代理组
function findProxyGroupForNode(proxies, nodeName) {
  if (!proxies || typeof proxies !== 'object') {
    return null;
  }
  
  // 遍历所有代理组
  for (const groupName in proxies) {
    const group = proxies[groupName];
    
    // 只检查选择器类型的代理组
    if (group.type === 'Selector' && Array.isArray(group.all)) {
      // 检查该组中是否包含目标节点
      if (group.all.includes(nodeName)) {
        console.log(`找到节点 ${nodeName} 所在的代理组: ${groupName}`);
        return groupName;
      }
    }
  }
  
  return null;
} 

async function switchNode(nodeName, proxyGroup = null) {
  try {
    if (!activeApiConfig) {
      console.error('无法切换节点: API配置不可用');
      return;
    }

    // 如果没有提供代理组名称，先尝试查找代理组
    let targetProxyGroup = proxyGroup;
    if (!targetProxyGroup) {
      try {
        // 先尝试获取所有代理组
        const proxiesResponse = await fetchMihomoAPI('/proxies');
        if (proxiesResponse.ok) {
          const proxiesData = await proxiesResponse.json();
          
          // 查找可能包含该节点的代理组
          targetProxyGroup = findProxyGroupForNode(proxiesData.proxies, nodeName);
          
          if (!targetProxyGroup) {
            // 如果找不到，使用默认的顺序尝试常见代理组名称
            const commonGroups = ['PROXY', 'Proxy', 'GLOBAL', 'Global', 'SelectGroup', 'Auto'];
            for (const group of commonGroups) {
              if (proxiesData.proxies && proxiesData.proxies[group] && 
                  proxiesData.proxies[group].type === 'Selector') {
                console.log(`找到可能的代理组: ${group}`);
                targetProxyGroup = group;
                break;
              }
            }
          }
        }
      } catch (err) {
        console.error('获取代理组信息失败:', err);
      }
      
      // 如果仍然找不到代理组，使用默认的 'PROXY'
      if (!targetProxyGroup) {
        console.warn('无法确定节点所在的代理组，使用默认值 PROXY');
        targetProxyGroup = 'PROXY';
      }
    }
    
    console.log(`正在将节点 ${nodeName} 设置到代理组 ${targetProxyGroup}`);
    
    // 使用统一API函数切换节点
    const response = await fetchMihomoAPI(`/proxies/${encodeURIComponent(targetProxyGroup)}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name: nodeName })
    });
    
    if (!response.ok) {
      throw new Error(`切换节点请求失败: ${response.status} ${response.statusText}`);
    }
    
    // 更新当前节点
    currentNode = nodeName;
    
    // 关闭现有连接并重新建立
    if (connectionsWebSocket) {
      connectionsWebSocket.close();
      connectionsWebSocket = null;
    }
    
    // 重新建立连接 (可选)
    if (false) { // 暂时不启用，以避免额外复杂性
      await startConnectionsWebSocket();
    }
    
    // 更新UI
    if (mainWindow) {
      mainWindow.webContents.send('node-switched', { node: nodeName });
    }
    
    // 更新托盘提示和菜单
    if (tray) {
      tray.setToolTip(`FlyClash - ${nodeName}`);
      // 更新托盘菜单以反映当前节点
      updateTrayMenu();
    }
    
    console.log(`已切换到节点: ${nodeName}`);
    
    // 刷新连接信息
    fetchConnectionsInfo();
  } catch (error) {
    console.error('切换节点失败:', error);
    // 通知前端切换失败
    if (mainWindow) {
      mainWindow.webContents.send('node-switch-error', { 
        error: error.message,
        node: nodeName 
      });
    }
  }
}

// 获取总连接信息和总流量
async function fetchConnectionsInfo() {
  try {
    if (!activeApiConfig) {
      console.error('[调试] 无法获取连接信息: API配置不可用');
      return;
    }

    try {
      // 使用统一API函数获取连接信息
      const response = await fetchMihomoAPI('/connections');
      if (response.ok) {
        const data = await response.json();
        
        // 为了减少日志太多，仅在详细模式下输出
        if (process.env.DEBUG_CONNECTIONS) {
          console.log('获取到连接信息:', JSON.stringify(data));
        }
        
        // 计算活跃连接数
        const activeConnections = data.connections ? 
          data.connections.filter(conn => conn.isActive !== false).length : 0;
        
        // 更新最后获取的连接信息
        lastConnectionsInfo = {
          ...data,
          currentNode,
          activeConnections: activeConnections
        };
        
        // 发送到主窗口
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('connections-update', lastConnectionsInfo);
        }
      } else {
        console.error(`[调试] 获取连接信息请求失败: 状态码 ${response.status}, 文本: ${response.statusText}`);
        try {
          const errorText = await response.text();
          console.error('[调试] 错误详情:', errorText);
        } catch (e) {
          console.error('[调试] 无法读取错误详情');
        }
      }
    } catch (fetchError) {
      console.error('[调试] Fetch操作失败:', fetchError);
    }
  } catch (error) {
    console.error('[调试] 获取连接信息失败:', error);
  }
}

// 共享函数：使用HTTP服务器加载页面
async function loadPageWithServer(pageName) {
  try {
    // 如果已经有一个服务器在运行，关闭它
    if (global.staticServer && global.staticServer.listening) {
      global.staticServer.close();
    }
    
    // 创建静态文件服务
    const serve = serveStatic(path.join(__dirname, '../out'), { 
      index: ['index.html'], 
      extensions: ['html'],
      fallthrough: false // 添加此选项以返回404错误
    });
    
    // 创建服务器
    const server = http.createServer((req, res) => {
      // 记录请求
      console.log(`[静态服务器] ${req.method} ${req.url}`);
      
      // 处理静态文件请求
      serve(req, res, (err) => {
        if (err) {
          console.error('[静态服务器] 错误:', err);
          res.statusCode = err.status || 500;
          res.end(err.message);
          return;
        }
        finalhandler(req, res)(err);
      });
    });
    
    // 在随机端口上启动服务器
    const port = await new Promise((resolve) => {
      server.listen(0, () => {
        const address = server.address();
        console.log(`静态文件服务器运行在 http://localhost:${address.port}`);
        resolve(address.port);
      });
    });
    
    // 保存服务器引用，以便以后可以关闭它
    global.staticServer = server;
    
    // 确定要加载的URL路径
    let urlPath;
    switch (pageName) {
      case 'nodes':
        urlPath = '/nodes/';
        break;
      case 'settings':
        urlPath = '/settings/';
        break;
      case 'subscriptions':
        urlPath = '/subscriptions/';
        break;
      default:
        urlPath = '/';
        break;
    }
    
    // 加载URL
    const pageUrl = `http://localhost:${port}${urlPath}`;
    console.log(`加载页面URL: ${pageUrl}`);
    return mainWindow.loadURL(pageUrl);
  } catch (error) {
    console.error('加载页面失败:', error);
    throw error;
  }
}

// 设置开机启动
function setAutoLaunch(enabled) {
  try {
    if (process.platform === 'win32') {
      // 使用Electron的内置方法设置开机启动
      app.setLoginItemSettings({
        openAtLogin: enabled,
        // 在Windows中，path参数是可选的，但如果指定，
        // 它将覆盖Windows注册表项中注册的可执行文件路径
        path: process.execPath,
        args: []
      });
      
      console.log(`开机启动状态已${enabled ? '启用' : '禁用'}`);
      return true;
    } else if (process.platform === 'darwin') {
      // macOS系统
      app.setLoginItemSettings({
        openAtLogin: enabled,
        openAsHidden: false // 是否在启动时隐藏窗口
      });
      
      console.log(`macOS开机启动状态已${enabled ? '启用' : '禁用'}`);
      return true;
    } else {
      console.warn('当前平台不支持设置开机启动');
      return false;
    }
  } catch (error) {
    console.error('设置开机启动失败:', error);
    return false;
  }
}

// 获取开机启动状态
function getAutoLaunchState() {
  try {
    // 对于Windows和macOS，使用Electron API获取当前设置
    const settings = app.getLoginItemSettings();
    return settings.openAtLogin;
  } catch (error) {
    console.error('获取开机启动状态失败:', error);
    return false;
  }
}

// 辅助函数：判断是否为对象
function isObject(item) {
  return item && typeof item === 'object' && !Array.isArray(item);
}

// 深度合并配置
function deepMergeConfig(target, source) {
  // 处理非对象类型的直接覆盖
  if (!isObject(target) || !isObject(source)) {
    return source;
  }
  
  const result = { ...target };
  
  for (const key in source) {
    // 用户配置的这些关键字段必须覆盖原始配置
    const mustOverrideFields = ['mixed-port', 'allow-lan', 'ipv6', 'log-level', 'external-controller', 'secret'];
    
    if (mustOverrideFields.includes(key)) {
      // 直接覆盖关键字段
      result[key] = source[key];
    } else if (isObject(source[key])) {
      // 递归合并对象
      if (key in result) {
        result[key] = deepMergeConfig(result[key], source[key]);
      } else {
        result[key] = source[key];
      }
    } else if (Array.isArray(source[key])) {
      // 处理数组
      // 对于这些特定字段，保留原有配置的数组
      const preserveArrayFields = ['proxies', 'proxy-groups', 'rules'];
      if (preserveArrayFields.includes(key) && Array.isArray(result[key])) {
        // 保留原有数组内容，不覆盖
        // 这些字段不应被用户配置覆盖
      } else {
        // 其他数组直接覆盖
        result[key] = source[key];
      }
    } else {
      // 其他类型直接覆盖
      result[key] = source[key];
    }
  }
  
  return result;
}

// 确保关键配置字段存在且有效
function validateMergedConfig(config) {
  const validatedConfig = { ...config };
  
  // 确保端口是有效的
  if (!validatedConfig['mixed-port'] || typeof validatedConfig['mixed-port'] !== 'number' || 
      validatedConfig['mixed-port'] < 1 || validatedConfig['mixed-port'] > 65535) {
    validatedConfig['mixed-port'] = 7890; // 使用默认端口
    console.log('端口号无效，使用默认端口7890');
  }
  
  // 确保布尔类型的字段是布尔值
  const booleanFields = ['allow-lan', 'ipv6']; // 移除'tun'，因为tun是一个对象
  for (const field of booleanFields) {
    if (field in validatedConfig && typeof validatedConfig[field] !== 'boolean') {
      validatedConfig[field] = Boolean(validatedConfig[field]);
      console.log(`将字段 ${field} 转换为布尔值: ${validatedConfig[field]}`);
    }
  }
  
  // 特殊处理TUN配置
  if (validatedConfig.tun) {
    // 如果tun是布尔值而不是对象，则纠正它
    if (typeof validatedConfig.tun !== 'object') {
      console.log('TUN配置不是对象，重置为默认TUN配置');
      const enableTun = Boolean(validatedConfig.tun);
      validatedConfig.tun = {
        enable: enableTun,
        stack: 'system',  // 'gvisor', 'system' 或 'mixed'
        'auto-route': true,
        'auto-detect-interface': true,
        device: 'FlyClash' // 设置TUN网卡名称为FlyClash
      };
      
      // 仅当enable为true时添加dns-hijack字段
      if (enableTun) {
        validatedConfig.tun['dns-hijack'] = ['any:53'];
      }
    } else {
      // 确保tun.enable是布尔值
      if (typeof validatedConfig.tun.enable !== 'boolean') {
        validatedConfig.tun.enable = Boolean(validatedConfig.tun.enable);
        console.log(`将字段 tun.enable 转换为布尔值: ${validatedConfig.tun.enable}`);
      }
      
      // 确保其他TUN字段格式正确
      if (validatedConfig.tun.enable) {
        // 确保stack字段正确
        if (!validatedConfig.tun.stack) {
          validatedConfig.tun.stack = 'system';
        }
        
        // 确保auto-route是布尔值
        if (typeof validatedConfig.tun['auto-route'] !== 'boolean') {
          validatedConfig.tun['auto-route'] = true;
        }
        
        // 确保auto-detect-interface是布尔值
        if (typeof validatedConfig.tun['auto-detect-interface'] !== 'boolean') {
          validatedConfig.tun['auto-detect-interface'] = true;
        }
        
        // 确保dns-hijack是数组
        if (!Array.isArray(validatedConfig.tun['dns-hijack'])) {
          validatedConfig.tun['dns-hijack'] = ['any:53'];
        }
      }
    }
    console.log('验证后的TUN配置:', JSON.stringify(validatedConfig.tun, null, 2));
  }
  
  // 强制设置API控制器，确保始终可访问，但保留用户设置的密钥
  validatedConfig['external-controller'] = '0.0.0.0:9090';
  // 不再强制覆盖密钥，保留用户的密钥设置
  console.log('已强制设置API控制器为0.0.0.0:9090，密钥', validatedConfig['secret'] ? '已设置' : '未设置');
  
  // 确保必要的数组字段存在
  const requiredArrayFields = ['proxies', 'proxy-groups'];
  for (const field of requiredArrayFields) {
    if (!validatedConfig[field] || !Array.isArray(validatedConfig[field])) {
      if (field === 'proxies' && (!validatedConfig.proxies || !Array.isArray(validatedConfig.proxies))) {
        throw new Error(`无效的配置：缺少 ${field} 数组`);
      }
      // 如果字段完全不存在，我们可以创建一个空数组作为默认值
      if (!validatedConfig[field]) {
        validatedConfig[field] = [];
        console.log(`创建空的 ${field} 数组作为默认值`);
      }
    }
  }
  
  return validatedConfig;
}

// 配置热重载功能
function reloadMihomoConfig(configPath) {
  try {
    // 确保配置文件路径存在
    if (!configPath || !fs.existsSync(configPath)) {
      console.error('配置文件路径无效，无法重新加载配置');
      return false;
    }

    // 确保mihomo进程正在运行
    if (!mihomoProcess || !mihomoProcess.pid) {
      console.error('Mihomo进程不在运行状态，无法重新加载配置');
      return false;
    }

    // 确保端口在监听中
    const port = 9090; // Mihomo API 端口
    try {
      // 先测试与API的连接
      const testReq = http.request({
        hostname: '127.0.0.1',
        port: port,
        path: '/version',
        method: 'GET',
        timeout: 1000 // 1秒超时
      }, (res) => {
        if (res.statusCode !== 200) {
          console.warn(`版本API返回非200状态码: ${res.statusCode}`);
        }
        // 连接成功，继续重载配置
        sendReloadRequest(configPath, port);
      });
      
      testReq.on('error', (err) => {
        console.error('测试Mihomo API连接失败:', err);
        return false;
      });
      
      testReq.on('timeout', () => {
        testReq.destroy();
        console.error('测试Mihomo API连接超时');
        return false;
      });
      
      testReq.end();
      return true; // 返回true表示请求已发送
    } catch (error) {
      console.error('尝试连接Mihomo API时出错:', error);
      return false;
    }
  } catch (error) {
    console.error('配置热重载失败:', error);
    return false;
  }
}

// 发送重载配置请求
async function sendReloadRequest(configPath, port) {
  try {
    const configData = JSON.stringify({ path: configPath });
    
    // 临时保存原端口
    const originalPort = activeApiConfig.controllerPort;
    
    // 临时修改activeApiConfig使用传入的端口
    activeApiConfig.controllerPort = port;
    
    try {
      // 使用统一的API请求函数
      const response = await fetchMihomoAPI('/configs', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json'
        },
        body: configData
      });
      
      // 解析响应
      let responseText = '';
      try {
        responseText = await response.text();
      } catch (e) {
        responseText = '无响应内容';
      }
      
      if (response.ok) {
        console.log('配置重载成功:', responseText);
      } else {
        console.error(`配置重载失败，状态码: ${response.status}，响应: ${responseText}`);
      }
    } finally {
      // 恢复原端口
      activeApiConfig.controllerPort = originalPort;
    }
    
    console.log('已请求Mihomo重新加载配置:', configPath);
  } catch (error) {
    console.error('发送配置重载请求失败:', error);
  }
}

// 重新生成合并配置并热重载
function regenerateAndReloadConfig() {
  try {
    if (!configFilePath || !fs.existsSync(configFilePath)) {
      console.error('原始配置文件不可用，无法重新生成配置');
      return false;
    }

    // 读取原始配置与用户设置
    const configContent = fs.readFileSync(configFilePath, 'utf8');
    let config;
    try {
      config = yaml.load(configContent);
      if (!config || typeof config !== 'object') {
        throw new Error('原始配置格式无效');
      }
    } catch (parseError) {
      console.error('解析原始配置文件失败:', parseError);
      return false;
    }
    const userSettings = getUserSettings();

    // 创建工作目录
    const mihomoDir = path.join(userDataPath, 'mihomo');
    if (!fs.existsSync(mihomoDir)) {
      try {
        fs.mkdirSync(mihomoDir, { recursive: true });
      } catch (dirError) {
        console.error('创建工作目录失败:', dirError);
        return false;
      }
    }

    // 生成新的合并配置
    const configFilename = path.basename(configFilePath);
    const overrideConfigFilename = 'override-' + configFilename;
    const overrideConfigPath = path.join(mihomoDir, overrideConfigFilename);

    try {
      // 使用深度合并生成配置
      const mergedConfig = deepMergeConfig(config, userSettings);
      const validatedConfig = validateMergedConfig(mergedConfig);
      // 强制覆盖API控制器设置，确保始终可访问，但保留用户设置的密钥
      validatedConfig['external-controller'] = '0.0.0.0:9090';
      // 使用用户设置的密钥，不强制覆盖
      const mergedConfigContent = yaml.dump(validatedConfig);
      
      try {
        fs.writeFileSync(overrideConfigPath, mergedConfigContent, 'utf8');
        console.log(`已重新生成配置文件: ${overrideConfigPath}`);
      } catch (writeError) {
        console.error('保存生成的配置文件失败:', writeError);
        return false;
      }
      
      // 检查Mihomo是否在运行
      if (!mihomoProcess || !mihomoProcess.pid) {
        console.warn('Mihomo进程不在运行状态，无法热重载');
        return false;
      }
      
      // 热重载配置
      return reloadMihomoConfig(overrideConfigPath);
    } catch (error) {
      console.error('合并配置失败:', error);
      return false;
    }
  } catch (error) {
    console.error('重新生成配置失败:', error);
    return false;
  }
}

// =============================
// SpeedTest相关功能
// =============================

// 执行网络测速
async function runSpeedtest() {
  try {
    console.log('执行网络测速...');
    
    // 更精确地确定tools目录位置
    let toolsDir;
    
    if (isDev) {
      // 开发环境 - 查找项目根目录
      toolsDir = path.join(process.cwd(), 'tools');
      
      // 如果找不到，尝试查找上一级目录
      if (!fs.existsSync(path.join(toolsDir, 'speedtest.exe'))) {
        toolsDir = path.join(process.cwd(), '..', 'tools');
      }
      
      console.log('开发环境测试工具目录:', toolsDir);
    } else {
      // 生产环境
      toolsDir = path.join(process.resourcesPath, 'tools');
      console.log('生产环境测试工具目录:', toolsDir);
    }
    
    // 直接尝试查找tools目录下的speedtest.exe
    let speedtestPath = path.join(toolsDir, 'speedtest.exe');
    
    // 如果找不到，尝试在speedtest-cli子目录查找
    if (!fs.existsSync(speedtestPath)) {
      speedtestPath = path.join(toolsDir, 'speedtest-cli', 'speedtest.exe');
      console.log('尝试在speedtest-cli子目录查找:', speedtestPath);
    }
    
    // 确认文件存在
    if (!fs.existsSync(speedtestPath)) {
      console.error('未找到speedtest.exe，请确保文件已放置在正确位置');
      return {
        success: false, 
        error: `未找到speedtest.exe。已检查目录: ${toolsDir}`
      };
    }
    
    console.log('找到speedtest.exe路径:', speedtestPath);
    
    return new Promise((resolve) => {
      console.log('开始执行测速命令...');
      
      // 创建执行进程，使用--format=json获取结构化输出
      const speedtestProcess = spawn(speedtestPath, ['--format=json', '--accept-license', '--accept-gdpr']);
      
      let output = '';
      let errorOutput = '';
      
      speedtestProcess.stdout.on('data', (data) => {
        const chunk = data.toString();
        output += chunk;
        console.log('Speedtest输出:', chunk);
      });
      
      speedtestProcess.stderr.on('data', (data) => {
        const chunk = data.toString();
        errorOutput += chunk;
        console.error('Speedtest错误:', chunk);
      });
      
      speedtestProcess.on('close', (code) => {
        console.log(`Speedtest进程退出，退出码 ${code}`);
        
        // 发送完成消息
        if (event?.sender) {
          // 退出码为0或2都视为成功
          const isSuccess = code === 0 || code === 2;
          event.sender.send('speedtest-output', {
            type: 'status',
            message: isSuccess ? '测速完成' : '测速失败',
            phase: isSuccess ? 'complete' : 'error',
            progress: 100,
            exitCode: code
          });
        }
        
        // 当speedtest.exe退出时，如果退出码为0或2，视为成功
        if (code === 0 || code === 2) {
          resolve({ 
            success: true, 
            data: finalResult
          });
        } else {
          resolve({ 
            success: false, 
            error: `测速失败，退出码: ${code}`
          });
        }
      });
      
      speedtestProcess.on('error', (error) => {
        console.error('启动Speedtest失败:', error);
        resolve({ 
          success: false, 
          error: `启动测速工具失败: ${error.message}`
        });
      });
    });
  } catch (error) {
    console.error('执行Speedtest时出错:', error);
    return { success: false, error: error.message };
  }
}

// 在IPC处理程序注册部分添加
ipcMain.handle('run-speedtest', async (event) => {
  return await runSpeedtest(event);
});

// 批量测速功能已移至单独模块
const batchSpeedtest = require('./batchspeedtest');
// 标记模块是否已初始化
let batchSpeedtestInitialized = false;

// 添加通过代理进行测速的处理程序
ipcMain.handle('run-proxy-speedtest', async (event, options) => {
  // 确保batchspeedtest模块已初始化
  if (!batchSpeedtestInitialized) {
    batchSpeedtest.initBatchSpeedtest({
      switchNode,
      fetchMihomoAPI,
      activeApiConfig
    });
    batchSpeedtestInitialized = true;
  }
  return await batchSpeedtest.runProxySpeedtest(options);
});

// 添加UDP测试的处理程序
ipcMain.handle('test-udp-connectivity', async (event, options) => {
  // 确保batchspeedtest模块已初始化
  if (!batchSpeedtestInitialized) {
    batchSpeedtest.initBatchSpeedtest({
      switchNode,
      fetchMihomoAPI,
      activeApiConfig
    });
    batchSpeedtestInitialized = true;
  }
  return await batchSpeedtest.testUdpConnectivity(options);
});

// 用于保存测速报告的处理程序
ipcMain.handle('save-speedtest-report', async (event, reportData) => {
  // 确保batchspeedtest模块已初始化
  if (!batchSpeedtestInitialized) {
    batchSpeedtest.initBatchSpeedtest({
      switchNode,
      fetchMihomoAPI,
      activeApiConfig
    });
    batchSpeedtestInitialized = true;
  }
  return await batchSpeedtest.saveSpeedtestReport(reportData, userDataPath);
});

// 获取历史测速报告列表
ipcMain.handle('get-speedtest-reports', async (event) => {
  // 确保batchspeedtest模块已初始化
  if (!batchSpeedtestInitialized) {
    batchSpeedtest.initBatchSpeedtest({
      switchNode,
      fetchMihomoAPI,
      activeApiConfig
    });
    batchSpeedtestInitialized = true;
  }
  return await batchSpeedtest.getSpeedtestReports(userDataPath);
});

// 获取特定测速报告的内容
ipcMain.handle('get-speedtest-report', async (event, reportId) => {
  // 确保batchspeedtest模块已初始化
  if (!batchSpeedtestInitialized) {
    batchSpeedtest.initBatchSpeedtest({
      switchNode,
      fetchMihomoAPI,
      activeApiConfig
    });
    batchSpeedtestInitialized = true;
  }
  return await batchSpeedtest.getSpeedtestReport(reportId, userDataPath);
});

// 复制测速报告到剪贴板
ipcMain.handle('copy-speedtest-report-to-clipboard', async (event, imageDataUrl) => {
  // 确保batchspeedtest模块已初始化
  if (!batchSpeedtestInitialized) {
    batchSpeedtest.initBatchSpeedtest({
      switchNode,
      fetchMihomoAPI,
      activeApiConfig
    });
    batchSpeedtestInitialized = true;
  }
  return await batchSpeedtest.copySpeedtestReportToClipboard(
    imageDataUrl, 
    nativeImage, 
    require('electron').clipboard
  );
});

// 使用puppeteer生成测速报告
ipcMain.handle('generate-speedtest-report-with-puppeteer', async (event, reportData) => {
  // 确保batchspeedtest模块已初始化
  if (!batchSpeedtestInitialized) {
    batchSpeedtest.initBatchSpeedtest({
      switchNode,
      fetchMihomoAPI,
      activeApiConfig
    });
    batchSpeedtestInitialized = true;
  }
  
  // 弹出保存对话框让用户选择保存位置
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: '保存测速报告',
    defaultPath: path.join(app.getPath('downloads'), `测速报告_${new Date().toISOString().slice(0,10)}.png`),
    buttonLabel: '保存',
    filters: [
      { name: '图像文件', extensions: ['png'] },
      { name: '所有文件', extensions: ['*'] }
    ],
    properties: ['createDirectory', 'showOverwriteConfirmation']
  });
  
  if (canceled) {
    return { success: false, canceled: true };
  }
  
  // 使用用户选择的路径生成报告
  return await batchSpeedtest.generateSpeedtestReportWithPuppeteer(reportData, userDataPath, filePath);
});

// 使用puppeteer生成报告并复制到剪贴板
ipcMain.handle('copy-speedtest-report-with-puppeteer', async (event, reportData) => {
  // 确保batchspeedtest模块已初始化
  if (!batchSpeedtestInitialized) {
    batchSpeedtest.initBatchSpeedtest({
      switchNode,
      fetchMihomoAPI,
      activeApiConfig
    });
    batchSpeedtestInitialized = true;
  }
  return await batchSpeedtest.copySpeedtestReportWithPuppeteer(
    reportData, 
    require('electron').clipboard,
    require('electron').nativeImage,
    userDataPath
  );
});

// 在默认应用中打开文件
ipcMain.handle('open-file-in-default-app', async (event, filePath) => {
  try {
    // 检查文件是否存在
    try {
      await fs.promises.access(filePath, fs.constants.F_OK);
    } catch (err) {
      return { success: false, error: '文件不存在' };
    }
    
    // 使用shell.openPath打开文件
    const { shell } = require('electron');
    await shell.openPath(filePath);
    
    return { success: true };
  } catch (error) {
    console.error('打开文件失败:', error);
    return { success: false, error: `打开文件失败: ${error.message}` };
  }
});

// 添加取消批量测速的处理程序
ipcMain.handle('cancel-batch-speedtest', async (event) => {
  try {
    console.log('正在取消批量测速...');
    // 确保batchspeedtest模块已初始化
    if (!batchSpeedtestInitialized) {
      console.log('批量测速模块未初始化，无法取消');
      return { success: false, error: '批量测速模块未初始化' };
    }
    const result = batchSpeedtest.cancelBatchSpeedtest();
    return { success: result, error: result ? null : '取消测速失败' };
  } catch (error) {
    console.error('取消测速失败:', error);
    return { success: false, error: String(error) };
  }
});

// 直接执行speedtest并将输出实时发送到前端
ipcMain.handle('run-speedtest-direct', async (event) => {
  try {
    console.log('开始执行直接测速...');
    
    // 更精确地确定tools目录位置
    let toolsDir;
    
    if (isDev) {
      // 开发环境 - 查找项目根目录
      toolsDir = path.join(process.cwd(), 'tools');
      
      // 如果找不到，尝试查找上一级目录
      if (!fs.existsSync(path.join(toolsDir, 'speedtest.exe'))) {
        toolsDir = path.join(process.cwd(), '..', 'tools');
      }
      
      console.log('开发环境测试工具目录:', toolsDir);
    } else {
      // 生产环境
      toolsDir = path.join(process.resourcesPath, 'tools');
      console.log('生产环境测试工具目录:', toolsDir);
    }
    
    // 查找speedtest.exe
    let speedtestPath = path.join(toolsDir, 'speedtest.exe');
    
    // 如果找不到，尝试在speedtest-cli子目录查找
    if (!fs.existsSync(speedtestPath)) {
      speedtestPath = path.join(toolsDir, 'ookla-speedtest-1.2.0-win64', 'speedtest.exe');
      console.log('尝试在ookla子目录查找:', speedtestPath);
    }
    
    // 确认文件存在
    if (!fs.existsSync(speedtestPath)) {
      console.error('未找到speedtest.exe，请确保文件已放置在正确位置');
      return {
        success: false, 
        error: `未找到speedtest.exe。已检查目录: ${toolsDir}`
      };
    }
    
    console.log('找到speedtest.exe路径:', speedtestPath);
    
    return new Promise((resolve) => {
      // 设置解析结果的变量
      let finalResult = {
        download: 0,
        upload: 0,
        ping: 0,
        jitter: 0,
        server: {
          host: "",
          name: "",
          country: ""
        }
      };
      
      // 告诉前端测速开始
      if (event?.sender) {
        event.sender.send('speedtest-output', {
          type: 'status',
          message: '测速开始',
          phase: 'start',
          progress: 0
        });
      }
      
      // 执行命令 - 这里使用简单的文本输出方式而不是JSON格式
      const speedtestProcess = spawn(speedtestPath, [
        '--accept-license', 
        '--accept-gdpr', 
        '--progress=yes',
        '--format=human-readable', // 使用人类可读格式，便于解析
        '--unit=Mbps',  // 强制使用Mbps单位
        '--precision=2'  // 设置精度为2位小数
      ]);
      
      speedtestProcess.stdout.on('data', (data) => {
        const output = data.toString().trim();
        console.log('Speedtest输出:', output);
        
        // 发送原始输出到前端
        if (event?.sender) {
          event.sender.send('speedtest-output', {
            type: 'stdout',
            message: output
          });
        }
        
        // 尝试解析常见的输出格式
        // 解析下载速度
        if (output.includes('Download:')) {
          const match = output.match(/Download:\s+([\d\.]+)\s*Mbps/i);
          if (match) {
            const speed = parseFloat(match[1]);
            finalResult.download = speed;
            
            if (event?.sender) {
              event.sender.send('speedtest-output', {
                type: 'progress',
                phase: 'download',
                downloadSpeed: speed,
                progress: 60
              });
            }
          }
        }
        
        // 解析上传速度
        if (output.includes('Upload:')) {
          const match = output.match(/Upload:\s+([\d\.]+)\s*Mbps/i);
          if (match) {
            const speed = parseFloat(match[1]);
            finalResult.upload = speed;
            
            if (event?.sender) {
              event.sender.send('speedtest-output', {
                type: 'progress',
                phase: 'upload',
                uploadSpeed: speed,
                progress: 90
              });
            }
          }
        }
        
        // 解析延迟和抖动
        if (output.includes('Latency')) {
          // 处理 "Idle Latency: 38.37 ms (jitter: 6.42ms, low: 34.72ms, high: 48.31ms)" 这种格式
          const latencyMatch = output.match(/(?:Idle\s+)?Latency:\s+([\d\.]+)\s+ms/i);
          const jitterMatch = output.match(/jitter:\s+([\d\.]+)ms/i);
          
          if (latencyMatch) {
            const ping = parseFloat(latencyMatch[1]);
            finalResult.ping = ping;
            
            if (event?.sender) {
              event.sender.send('speedtest-output', {
                type: 'progress',
                phase: 'ping',
                ping: ping,
                progress: 30
              });
            }
          }
          
          // 单独提取并更新抖动值
          if (jitterMatch) {
            const jitter = parseFloat(jitterMatch[1]);
            finalResult.jitter = jitter;
            
            if (event?.sender) {
              event.sender.send('speedtest-output', {
                type: 'progress',
                phase: 'ping',
                jitter: jitter,
                progress: 35
              });
            }
            
            console.log('解析到的抖动值:', jitter);
          }
        }
        
        // 尝试更灵活的抖动解析方式
        if (!finalResult.jitter && output.toLowerCase().includes('jitter')) {
          // 查找包含jitter的行
          const jitterLine = output.split('\n')
            .find(line => line.toLowerCase().includes('jitter'));
          
          if (jitterLine) {
            // 通用的jitter模式匹配尝试 - 查找jitter后面的数字
            const jitterMatch = jitterLine.match(/jitter:\s*([\d\.]+)\s*ms/i) || 
                           jitterLine.match(/jitter[^:]*:\s*([\d\.]+)\s*ms/i) ||
                           jitterLine.match(/jitter[^\d]+([\d\.]+)\s*ms/i);
            if (jitterMatch) {
              const jitter = parseFloat(jitterMatch[1]);
              finalResult.jitter = jitter;
              
              if (event?.sender) {
                event.sender.send('speedtest-output', {
                  type: 'progress',
                  phase: 'ping',
                  jitter: jitter,
                  progress: 35
                });
              }
              
              console.log('备用方式解析到的抖动值:', jitter);
            }
          }
        }
        
        // 如果前面的方法都没找到jitter值，尝试从整个输出中查找
        if (!finalResult.jitter) {
          // 尝试各种可能的jitter格式
          const jitterPatterns = [
            /jitter:\s*([\d\.]+)\s*ms/i,
            /jitter[^:]*:\s*([\d\.]+)\s*ms/i,
            /jitter[^\d]+([\d\.]+)\s*ms/i,
            /jitter\s*[=:]\s*([\d\.]+)/i
          ];
          
          for (const pattern of jitterPatterns) {
            const match = output.match(pattern);
            if (match) {
              const jitter = parseFloat(match[1]);
              finalResult.jitter = jitter;
              
              if (event?.sender) {
                event.sender.send('speedtest-output', {
                  type: 'progress',
                  phase: 'ping',
                  jitter: jitter,
                  progress: 35
                });
              }
              
              console.log('全文匹配解析到的抖动值:', jitter);
              break;
            }
          }
        }
        
        // 解析服务器信息
        if (output.includes('Server:')) {
          const serverMatch = output.match(/Server:\s+(.+?)(?:\s+Location|\(|$)/i);
          const locationMatch = output.match(/Location:\s+(.+?)(?:\s+|$)/i);
          
          if (serverMatch) {
            finalResult.server.name = serverMatch[1].trim();
            finalResult.server.host = serverMatch[1].trim();
          }
          
          if (locationMatch) {
            finalResult.server.country = locationMatch[1].trim();
          }
        }
      });
      
      speedtestProcess.stderr.on('data', (data) => {
        const output = data.toString().trim();
        console.error('Speedtest错误:', output);
        
        // 发送错误输出到前端
        if (event?.sender) {
          event.sender.send('speedtest-output', {
            type: 'stderr',
            message: output
          });
        }
      });
      
      speedtestProcess.on('close', (code) => {
        console.log(`Speedtest进程退出，退出码 ${code}`);
        
        // 发送完成消息
        if (event?.sender) {
          // 退出码为0或2都视为成功
          const isSuccess = code === 0 || code === 2;
          event.sender.send('speedtest-output', {
            type: 'status',
            message: isSuccess ? '测速完成' : '测速失败',
            phase: isSuccess ? 'complete' : 'error',
            progress: 100,
            exitCode: code
          });
        }
        
        // 当speedtest.exe退出时，如果退出码为0或2，视为成功
        if (code === 0 || code === 2) {
          resolve({ 
            success: true, 
            data: finalResult
          });
        } else {
          resolve({ 
            success: false, 
            error: `测速失败，退出码: ${code}`
          });
        }
      });
      
      speedtestProcess.on('error', (error) => {
        console.error('启动Speedtest失败:', error);
        
        // 发送错误消息
        if (event?.sender) {
          event.sender.send('speedtest-output', {
            type: 'status',
            message: `启动测速失败: ${error.message}`,
            phase: 'error',
            error: error.message
          });
        }
        
        resolve({ 
          success: false, 
          error: `启动测速工具失败: ${error.message}`
        });
      });
    });
  } catch (error) {
    console.error('执行直接测速时出错:', error);
    return { success: false, error: error.message };
  }
});

// 当前API配置
let activeApiConfig = {
  controllerHost: '127.0.0.1',
  controllerPort: '9090',
  secret: getUserSettings()['secret'] || '' // 从用户设置中获取密钥，如果未设置则为空字符串
};

// 添加新的IPC处理程序 - 获取API配置信息
ipcMain.handle('get-api-config', (event) => {
  try {
    // 获取最新的用户设置，确保使用最新的密钥
    const userSecret = getUserSettings()['secret'] || '';
    
    // 更新activeApiConfig中的密钥
    activeApiConfig.secret = userSecret;
    
    return {
      success: true,
      controllerHost: activeApiConfig.controllerHost,
      controllerPort: activeApiConfig.controllerPort,
      secret: userSecret // 使用最新的密钥
    };
  } catch (error) {
    console.error('获取API配置信息失败:', error);
    return {
      success: false,
      error: '获取API配置信息失败: ' + error.message
    };
  }
});

// 添加新的IPC处理程序 - 获取当前配置文件名
ipcMain.handle('get-current-config-name', (event) => {
  try {
    if (!configFilePath) {
      return { success: false, error: '当前没有活跃的配置文件' };
    }
    
    // 从路径中提取文件名 - 移除.yaml扩展名
    const configFileName = path.basename(configFilePath).replace(/\.yaml$/, '');
    
    return { 
      success: true, 
      configName: configFileName 
    };
  } catch (error) {
    console.error('获取当前配置文件名失败:', error);
    return { 
      success: false, 
      error: `获取当前配置文件名失败: ${error.message}` 
    };
  }
});

// 添加节点切换功能
ipcMain.handle('switch-node', async (event, nodeName) => {
  try {
    console.log(`[调试] 开始切换节点到: ${nodeName}`);
    
    // 检查Mihomo服务状态
    const isServiceRunning = await checkMihomoService();
    if (!isServiceRunning) {
      console.error('[调试] Mihomo服务未运行，无法切换节点');
      return { success: false, error: 'Mihomo服务未运行，无法切换节点' };
    }
    
    // 获取配置文件中的第一个代理组名
    let firstProxyGroup = "PROXY"; // 默认尝试PROXY组
    
    try {
      const config = await getConfig();
      if (config && config.proxies) {
        // 查找第一个代理组
        for (const [name, info] of Object.entries(config.proxies)) {
          if (info.type === 'Selector' && name !== 'GLOBAL' && info.now) {
            firstProxyGroup = name;
            break;
          }
        }
      }
    } catch (error) {
      console.error('获取配置信息出错:', error);
    }
    
    // 准备切换节点的请求
    const url = `http://127.0.0.1:9090/proxies/${encodeURIComponent(firstProxyGroup)}`;
    const data = { name: nodeName };
    
    // 使用node-fetch发送请求
    const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': activeApiConfig.secret ? `Bearer ${activeApiConfig.secret}` : ''
      },
      body: JSON.stringify(data)
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[调试] 切换节点失败: ${response.status} ${response.statusText} - ${errorText}`);
      
      // 尝试使用默认的PROXY组
      if (firstProxyGroup !== "PROXY") {
        console.log(`[调试] 尝试使用默认PROXY组切换节点`);
        
        const proxyUrl = `http://127.0.0.1:9090/proxies/PROXY`;
        const proxyResponse = await fetch(proxyUrl, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': activeApiConfig.secret ? `Bearer ${activeApiConfig.secret}` : ''
          },
          body: JSON.stringify(data)
        });
        
        if (!proxyResponse.ok) {
          const proxyErrorText = await proxyResponse.text();
          console.error(`[调试] 使用PROXY组切换节点失败: ${proxyResponse.status} ${proxyResponse.statusText} - ${proxyErrorText}`);
          return { success: false, error: `切换节点失败: ${proxyErrorText}` };
        }
        
        console.log(`[调试] 成功使用PROXY组切换到节点: ${nodeName}`);
        return { success: true };
      }
      
      return { success: false, error: `切换节点失败: ${errorText}` };
    }
    
    console.log(`[调试] 成功切换到节点: ${nodeName}`);
    return { success: true };
  } catch (error) {
    console.error(`[调试] 切换节点过程中出错:`, error);
    return { success: false, error: `切换节点失败: ${error.message}` };
  }
});

// 通过代理进行网络请求
ipcMain.handle('proxy-fetch', async (event, url, options = {}) => {
  try {
    console.log(`[调试] 开始通过代理请求URL: ${url}`);
    
    // 检查Mihomo服务状态
    const isServiceRunning = await checkMihomoService();
    if (!isServiceRunning) {
      console.error('[调试] Mihomo服务未运行，无法使用代理');
      return { 
        ok: false, 
        status: 0, 
        statusText: 'Mihomo服务未运行，无法使用代理',
        data: null
      };
    }
    
    // 获取当前代理设置
    let proxyPort = 7890; // 默认HTTP代理端口
    
    try {
      const settings = getUserSettings();
      if (settings && settings.httpPort) {
        proxyPort = parseInt(settings.httpPort, 10);
      }
    } catch (e) {
      console.warn('[调试] 获取HTTP代理端口出错，使用默认端口7890:', e);
    }
    
    // 使用简单的HTTP客户端通过代理请求
    const { ProxyAgent } = await import('proxy-agent');
    const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
    
    const proxyUri = `http://127.0.0.1:${proxyPort}`;
    const agent = new ProxyAgent(proxyUri);
    
    // 设置超时
    const timeout = options.timeout || 30000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    
    const response = await fetch(url, {
      ...options,
      agent,
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    // 处理响应
    const result = {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      headers: {},
      data: null
    };
    
    // 复制响应头
    response.headers.forEach((value, key) => {
      result.headers[key] = value;
    });
    
    // 获取响应体
    if (response.ok) {
      const buffer = await response.arrayBuffer();
      result.data = buffer;
    } else {
      result.data = await response.text();
    }
    
    return result;
  } catch (error) {
    console.error(`[调试] 代理请求过程中出错:`, error);
    
    // 根据错误类型返回不同的结果
    if (error.name === 'AbortError') {
      return { 
        ok: false, 
        status: 408, 
        statusText: '请求超时',
        data: null
      };
    }
    
    return { 
      ok: false, 
      status: 0, 
      statusText: error.message || '请求失败',
      data: null
    };
  }
});

// 获取配置文件顺序 - 直接从用户配置文件读取，而不是依赖mihomo API
ipcMain.handle('get-config-order', async (event) => {
  try {
    console.log('[调试] 获取配置文件中的原始代理组顺序');
    
    // 检查是否有活跃的配置文件
    if (!configFilePath || !fs.existsSync(configFilePath)) {
      console.error('[调试] 没有活跃的配置文件');
      return { success: false, error: '没有活跃的配置文件' };
    }
    
    // 使用parseConfigFile函数解析配置文件
    const configData = parseConfigFile(configFilePath);
    if (!configData) {
      console.error('[调试] 解析配置文件失败');
      return { success: false, error: '解析配置文件失败' };
    }
    
    console.log('[调试] 成功解析配置文件, 发现代理组:', 
      configData.proxyGroups.map(g => g.name).join(', '));
    
    // 直接返回配置文件中的代理组信息
    return { 
      success: true, 
      data: configData 
    };
  } catch (error) {
    console.error('[调试] 获取配置顺序出错:', error);
    return { success: false, error: error.message };
  }
});

// 添加清理函数，用于关闭所有WebSocket连接
function cleanupWebSockets() {
  console.log('[调试] 清理所有WebSocket连接');
  if (trafficWebSocket) {
    trafficWebSocket.close();
    trafficWebSocket = null;
  }
  if (connectionsWebSocket) {
    connectionsWebSocket.close();
    connectionsWebSocket = null;
  }
  
  // 清理相关资源
  if (trafficStatsInterval) {
    clearInterval(trafficStatsInterval);
    trafficStatsInterval = null;
  }
  
  trafficRetry = 10;
  connectionsRetry = 10;
}

// 在应用退出前调用清理函数
app.on('will-quit', () => {
  console.log('[调试] 应用即将退出，正在清理资源');
  cleanupWebSockets();
  if (memoryMonitorInterval) {
    clearInterval(memoryMonitorInterval);
    memoryMonitorInterval = null;
  }
});

// 定期监控和管理内存
let memoryMonitorInterval;
function startMemoryMonitor() {
  if (memoryMonitorInterval) clearInterval(memoryMonitorInterval);
  
  memoryMonitorInterval = setInterval(() => {
    const memoryUsage = process.memoryUsage();
    console.log(`内存使用: RSS ${formatTraffic(memoryUsage.rss)}, Heap ${formatTraffic(memoryUsage.heapUsed)}/${formatTraffic(memoryUsage.heapTotal)}`);
    
    // 如果堆内存使用超过阈值，建议进行垃圾回收
    if (memoryUsage.heapUsed > 300 * 1024 * 1024) { // 300MB
      try {
        if (global.gc) {
          global.gc();
          console.log('[调试] 手动触发垃圾回收');
        }
      } catch (e) {
        console.log('[调试] 无法手动触发垃圾回收，请使用 --expose-gc 启动参数');
      }
    }
  }, 60000); // 每分钟检查一次
}

// 在应用准备就绪时启动内存监控
app.on('ready', () => {
  // ... existing code ...
  startMemoryMonitor();
});

// 获取代理配置
ipcMain.handle('get-proxy-config', async (event) => {
  try {
    console.log('[调试] 获取代理配置');
    
    // 获取用户设置中的代理配置
    const settings = getUserSettings();
    
    if (!settings) {
      console.error('[调试] 无法获取用户设置');
      return { success: false, error: '无法获取用户设置' };
    }
    
    // 返回代理配置信息
    return { 
      success: true, 
      data: {
        host: '127.0.0.1',  // 本地代理主机
        port: parseInt(settings.httpPort || 7890, 10)  // 用户配置的HTTP代理端口
      }
    };
  } catch (error) {
    console.error('[调试] 获取代理配置出错:', error);
    return { 
      success: false, 
      error: error.message,
      data: {
        host: '127.0.0.1',
        port: 7890  // 默认端口
      }
    };
  }
});

// 通过指定HTTP代理和节点发送请求
ipcMain.handle('fetch-with-proxy', async (event, options) => {
  try {
    if (!options || !options.url) {
      throw new Error('请求URL不能为空');
    }
    
    console.log(`[调试] 开始通过HTTP代理请求URL: ${options.url}`);
    
    // 获取代理配置
    const proxyHost = options.proxy?.host || '127.0.0.1';
    const proxyPort = options.proxy?.port || 7890;
    const nodeName = options.proxy?.nodeName || '';
    
    console.log(`[调试] 使用代理 ${proxyHost}:${proxyPort}, 节点: ${nodeName}`);
    
    // 如果指定了节点，先切换到该节点
    if (nodeName) {
      try {
        // 调用API切换节点
        await switchNode(nodeName);
        // 等待节点切换生效
        await new Promise(resolve => setTimeout(resolve, 1000));
        console.log(`[调试] 已切换到节点: ${nodeName}`);
      } catch (error) {
        console.error(`[调试] 切换节点失败: ${error.message}`);
        // 继续使用当前节点
      }
    }
    
    // 使用node-fetch和proxy-agent (这些都是已经安装好的包)
    const { ProxyAgent } = await import('proxy-agent');
    const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
    
    // 构建代理URL
    const proxyUrl = `http://${proxyHost}:${proxyPort}`;
    
    // 创建代理代理
    const agent = new ProxyAgent(proxyUrl);
    
    console.log(`[调试] 使用代理: ${proxyUrl} 访问URL: ${options.url}`);
    
    // 设置超时
    const timeout = options.timeout || 30000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    
    // 使用用户提供的请求头，不添加自定义头
    const headers = options.headers || {};
    
    // 创建请求选项
    const fetchOptions = {
      method: options.method || 'GET',
      headers: headers,
      agent: agent, // 直接使用HTTP/HTTPS代理代理
      signal: controller.signal
    };
    
    // 添加请求体（如果有）
    if (options.body) {
      fetchOptions.body = options.body;
    }
    
    // 输出详细日志以便调试
    console.log(`[调试] 发送${fetchOptions.method}请求到: ${options.url}`);
    console.log(`[调试] 请求头:`, JSON.stringify(headers));
    
    // 发送请求
    const response = await fetch(options.url, fetchOptions);
    
    clearTimeout(timeoutId);
    
    // 记录响应信息
    console.log(`[调试] 收到响应，状态码: ${response.status}`);
    
    // 处理响应
    const result = {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      headers: {},
      data: null
    };
    
    // 复制响应头
    response.headers.forEach((value, key) => {
      result.headers[key] = value;
    });
    
    // 获取响应体
    if (response.status !== 204) { // 非空响应
      try {
        if (response.headers.get('content-type')?.includes('application/json')) {
          result.data = await response.json();
        } else {
          // 对于二进制数据，返回ArrayBuffer
          const buffer = await response.arrayBuffer();
          result.data = buffer;
          console.log(`[调试] 接收到数据大小: ${buffer.byteLength} 字节`);
        }
      } catch (error) {
        console.error(`[调试] 解析响应内容失败:`, error);
        // 如果解析失败，尝试作为文本获取
        result.data = await response.text();
      }
    }
    
    return result;
  } catch (error) {
    console.error(`[调试] 代理请求过程中出错:`, error);
    
    // 根据错误类型返回不同的结果
    if (error.name === 'AbortError') {
      return { 
        ok: false, 
        status: 408, 
        statusText: '请求超时',
        data: null
      };
    }
    
    return { 
      ok: false, 
      status: 0, 
      statusText: error.message || '请求失败',
      data: null
    };
  }
});

// 处理协议URL启动
function handleProtocolUrl(url) {
  try {
    console.log('收到原始协议URL:', url);
    
    // 特殊处理Windows系统的URL格式
    let subscriptionUrl = null;
    
    // 情况1: 标准协议URL格式: clash://install-config?url=https://example.com
    if (url.startsWith('clash://') || url.startsWith('flyclash://')) {
      const queryStartIndex = url.indexOf('?url=');
      if (queryStartIndex > 0) {
        subscriptionUrl = url.substring(queryStartIndex + 5);
        // 如果URL中有其他参数，截取到下一个&符号
        const ampIndex = subscriptionUrl.indexOf('&');
        if (ampIndex > 0) {
          subscriptionUrl = subscriptionUrl.substring(0, ampIndex);
        }
      }
    } 
    // 情况2: Windows特殊格式: C:\...?url=https%3A%2F%2Fexample.com
    else if (url.includes('?url=')) {
      const urlParam = url.substring(url.indexOf('?url=') + 5);
      // 如果URL中有其他参数，截取到下一个&符号
      const ampIndex = urlParam.indexOf('&');
      subscriptionUrl = ampIndex > 0 ? urlParam.substring(0, ampIndex) : urlParam;
    }

    // 确保对URL进行解码
    if (subscriptionUrl) {
      try {
        subscriptionUrl = decodeURIComponent(subscriptionUrl);
        console.log('成功提取到订阅URL:', subscriptionUrl);
        
        // 只有在URL有效时才打开窗口和发送事件
        if (subscriptionUrl.startsWith('http')) {
          // 显示窗口（如果最小化或隐藏）
          if (mainWindow && !mainWindow.isDestroyed()) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.show();
            mainWindow.focus();
            
            // 导航到订阅页面
            console.log('向渲染进程发送导入事件');
            mainWindow.webContents.send('import-subscription', subscriptionUrl);
            return true;
          }
        } else {
          console.log('提取的URL不是有效的HTTP(S)地址:', subscriptionUrl);
        }
      } catch (decodeError) {
        console.error('URL解码失败:', decodeError);
      }
    } else {
      console.log('未能从协议URL中提取订阅地址');
    }

    return false;
  } catch (error) {
    console.error('处理协议URL时出错:', error);
    return false;
  }
}

// 注册 protocol handler events
// 在 macOS 和 Linux 上，open-url 事件在 app 模块发出 ready 事件之前就会被触发
// 在 Windows 上，我们需要监听 second-instance 事件
app.on('open-url', (event, url) => {
  event.preventDefault();
  console.log('收到open-url事件，URL:', url);
  handleProtocolUrl(url);
});

app.on('second-instance', (event, commandLine, workingDirectory) => {
  // 当运行第二个实例时，这里将执行
  console.log('检测到第二个实例启动，命令行参数:', commandLine);
  
  if (process.platform === 'win32') {
    // 在 Windows 上，协议 URL 作为 command line 参数传递
    let foundProtocolArg = false;
    for (const arg of commandLine) {
      if (arg.includes('clash://') || 
          arg.includes('flyclash://') ||
          arg.includes('?url=')) {
        console.log('第二个实例中检测到可能的协议URL参数:', arg);
        foundProtocolArg = true;
        handleProtocolUrl(arg);
      }
    }
    
    if (!foundProtocolArg) {
      console.log('第二个实例的命令行参数中未找到协议URL');
    }
  }
  
  // 聚焦到主窗口
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

// 代理状态
// let systemProxyEnabled = false;

// TUN模式状态
// let tunModeEnabled = false;

// 切换TUN模式
function toggleTunMode(menuItem) {
  // 检查mihomo是否运行中
  if (!mihomoProcess) {
    dialog.showErrorBox('错误', '请先启动代理服务');
    return false;
  }
  
  try {
    // 读取当前用户设置
    const userSettings = getUserSettings();
    
    // 如果menuItem是布尔值或undefined，就直接使用它
    // 如果是对象，就使用其checked属性
    const enableTun = typeof menuItem === 'boolean' ? menuItem : 
                     (menuItem === undefined ? !tunModeEnabled : menuItem.checked);
    
    // 确保tun字段存在且是正确的对象
    if (!userSettings.tun || typeof userSettings.tun !== 'object') {
      userSettings.tun = {};
    }
    
    // 设置TUN模式状态
    userSettings.tun.enable = enableTun;
    
    // 如果启用TUN模式，添加TUN基本配置
    if (enableTun) {
      // Mihomo TUN配置，确保格式正确
      userSettings.tun = {
        enable: true,
        stack: 'system',  // 'gvisor', 'system' 或 'mixed'
        'auto-route': true,
        'auto-detect-interface': true,
        device: 'FlyClash' // 设置TUN网卡名称为FlyClash
      };
      
      // 添加dns-hijack字段
      userSettings.tun['dns-hijack'] = ['any:53'];
      
      console.log('启用TUN模式，配置:', JSON.stringify(userSettings.tun, null, 2));
      
      // 删除这部分原生Windows弹窗代码
      // 前端已经处理了确认逻辑
    } else {
      // 禁用TUN模式，只需要设置enable为false
      userSettings.tun.enable = false;
      console.log('禁用TUN模式');
    }
    
    // 更新用户设置
    if (updateUserSettings(userSettings)) {
      tunModeEnabled = enableTun;
      
      // 保存TUN状态到文件
      const tunConfigPath = path.join(userDataPath, 'tun-config.json');
      fs.writeFileSync(tunConfigPath, JSON.stringify({ enabled: tunModeEnabled }), 'utf8');
      console.log('已保存TUN模式状态:', tunModeEnabled ? '启用' : '禁用');
      
      // 通知前端
      if (mainWindow) {
        mainWindow.webContents.send('tun-status', tunModeEnabled);
      }
      
      // 更新托盘菜单，确保托盘图标状态同步
      updateTrayMenu();
      
      // 如果服务正在运行，则需要重启服务以应用TUN模式设置
      if (mihomoProcess) {
        const currentConfig = configFilePath;
        
        // 移除原生弹窗，改为通过IPC发送重启通知
        if (mainWindow) {
          mainWindow.webContents.send('service-restarting', {
            reason: 'tun-mode-change',
            tunEnabled: tunModeEnabled
          });
        }
        
        // 停止服务
        mihomoProcess.kill();
        mihomoProcess = null;
        
        // 延迟一会儿再重启服务
        setTimeout(async () => {
          // 尝试启动服务
          const result = await startMihomo(currentConfig);
          
          if (result) {
            console.log('TUN模式设置已应用，服务重启成功');
            
            // 移除原生弹窗，通过IPC发送重启成功通知
            if (mainWindow) {
              mainWindow.webContents.send('service-restarted', {
                success: true,
                tunEnabled: tunModeEnabled
              });
            }
            
            // 再次发送TUN状态通知和更新托盘菜单，确保UI状态同步
            if (mainWindow) {
              mainWindow.webContents.send('tun-status', tunModeEnabled);
            }
            updateTrayMenu();
          } else {
            console.error('TUN模式设置后服务重启失败');
            
            // 移除原生弹窗，通过IPC发送重启失败通知
            if (mainWindow) {
              mainWindow.webContents.send('service-restarted', {
                success: false,
                error: `TUN模式${tunModeEnabled ? '启用' : '禁用'}后服务重启失败，可能是配置问题或权限不足`
              });
            }
            
            // 恢复TUN状态
            tunModeEnabled = !tunModeEnabled;
            
            // 更新用户设置，恢复原始TUN配置
            userSettings.tun.enable = !enableTun;
            updateUserSettings(userSettings);
            
            // 通知前端
            if (mainWindow) {
              mainWindow.webContents.send('tun-status', tunModeEnabled);
            }
            
            // 更新托盘菜单以反映恢复后的状态
            updateTrayMenu();
          }
        }, 1000);
      }
      
      return true;
    }
  } catch (error) {
    console.error('设置TUN模式失败:', error);
    
    // 移除原生弹窗，改为通过IPC发送错误通知
    if (mainWindow) {
      mainWindow.webContents.send('tun-mode-error', {
        message: `设置TUN模式失败: ${error.message}`
      });
    }
    
    // 恢复菜单项状态
    if (typeof menuItem === 'object' && menuItem !== null) {
      menuItem.checked = !menuItem.checked;
    }
    tunModeEnabled = typeof menuItem === 'object' && menuItem !== null ? !menuItem.checked : !tunModeEnabled;
    
    // 保存恢复后的TUN状态到文件
    try {
      const tunConfigPath = path.join(userDataPath, 'tun-config.json');
      fs.writeFileSync(tunConfigPath, JSON.stringify({ enabled: tunModeEnabled }), 'utf8');
      console.log(`已保存恢复后的TUN模式状态: ${tunModeEnabled ? '启用' : '禁用'}`);
    } catch (saveError) {
      console.error('保存TUN模式状态失败:', saveError);
    }
    
    if (mainWindow) {
      mainWindow.webContents.send('tun-status', tunModeEnabled);
    }
    
    return false;
  }
}

// ... existing code ...

// 替换原有的令牌获取处理程序，改为创建短期会话令牌
ipcMain.handle('get-auth-token', (event) => {
  try {
    // 确保请求来自于受信任的渲染进程
    const webContents = event.sender;
    const win = BrowserWindow.fromWebContents(webContents);
    
    if (!win) {
      console.error('令牌请求验证失败: 无法确定请求窗口');
      return { success: false, error: '安全验证失败' };
    }
    
    // 记录令牌请求
    const requestInfo = {
      windowId: win.id,
      url: webContents.getURL(),
      timestamp: new Date().toISOString()
    };
    
    console.log('收到令牌请求:', requestInfo);
    
    // 创建会话令牌
    const token = sessionTokenManager.createToken(win.id);
    
    return { 
      success: true, 
      token,
      expiry: Date.now() + 5 * 60 * 1000 // 返回过期时间，便于前端管理
    };
  } catch (error) {
    console.error('创建认证令牌失败:', error);
    return { success: false, error: '内部错误' };
  }
});

// 获取TUN模式状态
ipcMain.handle('getTunStatus', async () => {
  // 首先从用户设置中读取状态，确保获取最新值
  try {
    const userSettings = getUserSettings();
    if (userSettings.tun && typeof userSettings.tun === 'object') {
      tunModeEnabled = !!userSettings.tun.enable;
    } else if (typeof userSettings.tun !== 'undefined') {
      tunModeEnabled = !!userSettings.tun;
    }
  } catch (error) {
    // 静默处理错误
  }
  
  return tunModeEnabled;
});

// 修改TUN模式切换处理程序，增强令牌验证
ipcMain.handle('toggleTunMode', async (event, token, enabled) => {
  try {
    // 获取请求来源窗口
    const webContents = event.sender;
    const win = BrowserWindow.fromWebContents(webContents);

    if (!win) {
      console.error('TUN模式切换验证失败: 无法确定请求窗口');
      return { success: false, error: '安全验证失败: 无法确定请求窗口' };
    }

    // 完整的令牌验证
    if (!sessionTokenManager.validateToken(token, win.id, 'toggleTunMode')) {
      console.error('TUN模式切换验证失败: 令牌无效');
      security.logSecurityEvent('invalid-token-tun', {
        windowId: win.id,
        url: webContents.getURL()
      }, path.join(userDataPath, 'security.log'));
      return { success: false, error: '安全验证失败: 令牌无效' };
    }

    // 验证通过，执行实际操作
    console.log(`TUN模式切换请求已授权 [窗口ID: ${win.id}, 启用: ${enabled}]`);
    const menuItem = { checked: enabled };
    toggleTunMode(menuItem);
    return { success: true, status: tunModeEnabled };
  } catch (error) {
    console.error('切换TUN模式失败:', error);
    return { success: false, error: `操作失败: ${error.message}` };
  }
});

// ==================== Provider 管理相关的 IPC Handlers ====================

// 获取 Proxy Providers
ipcMain.handle('get-proxy-providers', async () => {
  try {
    const response = await fetchMihomoAPI('/providers/proxies');
    const data = await response.json();
    return { success: true, data };
  } catch (error) {
    console.error('获取 Proxy Providers 失败:', error);
    return { success: false, error: error.message };
  }
});

// 更新单个 Proxy Provider
ipcMain.handle('update-proxy-provider', async (event, providerName) => {
  try {
    const response = await fetchMihomoAPI(`/providers/proxies/${encodeURIComponent(providerName)}`, {
      method: 'PUT'
    });
    return { success: true };
  } catch (error) {
    console.error(`更新 Proxy Provider ${providerName} 失败:`, error);
    return { success: false, error: error.message };
  }
});

// 获取 Rule Providers
ipcMain.handle('get-rule-providers', async () => {
  try {
    const response = await fetchMihomoAPI('/providers/rules');
    const data = await response.json();
    return { success: true, data };
  } catch (error) {
    console.error('获取 Rule Providers 失败:', error);
    return { success: false, error: error.message };
  }
});

// 更新单个 Rule Provider
ipcMain.handle('update-rule-provider', async (event, providerName) => {
  try {
    const response = await fetchMihomoAPI(`/providers/rules/${encodeURIComponent(providerName)}`, {
      method: 'PUT'
    });
    return { success: true };
  } catch (error) {
    console.error(`更新 Rule Provider ${providerName} 失败:`, error);
    return { success: false, error: error.message };
  }
});

// 获取运行时配置（用于获取 provider 详细信息）
ipcMain.handle('get-runtime-config', async () => {
  try {
    const response = await fetchMihomoAPI('/configs');
    const data = await response.json();
    return { success: true, data };
  } catch (error) {
    console.error('获取运行时配置失败:', error);
    return { success: false, error: error.message };
  }
});

// ... existing code ...
