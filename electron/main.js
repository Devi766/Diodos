const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell, nativeTheme, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execSync, exec } = require('child_process');
const crypto = require('crypto');
const isDev = process.env.NODE_ENV === 'development';
const yaml = require('js-yaml');
const WebSocket = require('ws');
const net = require('net');
const http = require('http');
const serveStatic = require('serve-static');
const finalhandler = require('finalhandler');
const security = require('./security');
const { enableAcrylic } = require('./windows/acrylic');
const axios = require('axios');

// 导入媒体检测模块
const { testMediaStreaming } = require('./mediatest');

// 导入图标提取模块
const { getIconDataURL } = require('./icon');

// 应用版本号 - 统一管理所有界面显示的版本
const APP_VERSION = '0.1.4';
const isWindows = process.platform === 'win32';
const isMac = process.platform === 'darwin';

const context = require('./main-process/context');
const state = context.state;

Object.assign(context, {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  dialog,
  shell,
  nativeTheme,
  nativeImage,
  path,
  fs,
  spawn,
  execSync,
  exec,
  isDev,
  yaml,
  WebSocket,
  net,
  http,
  serveStatic,
  finalhandler,
  security,
  APP_VERSION
});
// 修改应用的appName，确保保存在Roaming目录下的文件夹名为flyclash
app.name = 'flyclash';

// 应用数据存储路径
const userDataPath = app.getPath('userData');
const configDir = path.join(userDataPath, 'config');

context.set('userDataPath', userDataPath);
context.set('configDir', configDir);
context.set('testMediaStreaming', testMediaStreaming);

// 初始化数据库
const DatabaseManager = require('./database/db-manager');
const MigrationManager = require('./database/migration');

const dbPath = path.join(configDir, 'flyclash.db');
const dbManager = new DatabaseManager(dbPath);
dbManager.initialize();

context.set('dbManager', dbManager);

// 初始化订阅调度器
const SubscriptionScheduler = require('./core/subscription-scheduler');
const subscriptionScheduler = new SubscriptionScheduler(context);
context.set('subscriptionScheduler', subscriptionScheduler);

// 检查并执行数据迁移
const migrationManager = new MigrationManager(configDir, dbManager);
if (!migrationManager.isMigrated()) {
  console.log('[启动] 检测到未迁移的数据,开始自动迁移...');
  migrationManager.migrate().then(result => {
    if (result.success) {
      console.log('[启动] 数据迁移成功');
    } else {
      console.error('[启动] 数据迁移失败:', result.error);
    }
  });
} else {
  console.log('[启动] 数据已迁移,跳过迁移步骤');
}

let cachedFetchFn = null;

async function resolveFetchFn() {
  if (cachedFetchFn) {
    return cachedFetchFn;
  }

  if (typeof globalThis.fetch === 'function') {
    cachedFetchFn = globalThis.fetch.bind(globalThis);
    return cachedFetchFn;
  }

  const { default: fetchFn } = await import('node-fetch');
  cachedFetchFn = fetchFn;
  return cachedFetchFn;
}

let activeAuthToken = null;
let authTokenExpiry = 0;

function generateAuthToken() {
  activeAuthToken = crypto.randomBytes(32).toString('base64url');
  authTokenExpiry = Date.now() + 5 * 60 * 1000;
  return { token: activeAuthToken, expiry: authTokenExpiry };
}

function ensureAuthToken() {
  if (!activeAuthToken || authTokenExpiry <= Date.now()) {
    return generateAuthToken();
  }
  return { token: activeAuthToken, expiry: authTokenExpiry };
}

function verifyAuthToken(token) {
  if (!token || !activeAuthToken) {
    return false;
  }
  if (authTokenExpiry <= Date.now()) {
    activeAuthToken = null;
    return false;
  }
  return token === activeAuthToken;
}

// 创建 axios 实例用于 socket 通讯
let axiosInstance = null;

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

context.set('getAxiosInstance', getAxiosInstance);
context.set('fetchMihomoAPI', fetchMihomoAPI);
context.set('ensureAuthToken', ensureAuthToken);
context.set('verifyAuthToken', verifyAuthToken);

const kernelPreferenceFile = path.join(userDataPath, 'kernel-config.json');
const DEFAULT_KERNEL_CANDIDATES = [
  'mihomo-windows-amd64-compatible.exe',
  'mihomo-windows-amd64.exe',
  'mihomo.exe',
  'mihomo-darwin-arm64-compatible',
  'mihomo-darwin-amd64-compatible',
  'mihomo-darwin-universal',
  'mihomo-linux-amd64-compatible',
  'mihomo-linux-amd64',
  'mihomo'
];

function unique(array) {
  return Array.from(new Set(array.filter(Boolean)));
}

function resolveDefaultKernelPath() {
  const candidateRoots = unique([
    path.join(app.getAppPath(), 'cores'),
    path.join(process.resourcesPath ?? '', 'cores'),
    path.join(__dirname, '../cores'),
    path.join(process.cwd(), 'cores')
  ]);

  for (const root of candidateRoots) {
    try {
      if (!root || !fs.existsSync(root)) {
        continue;
      }

      for (const candidate of DEFAULT_KERNEL_CANDIDATES) {
        const candidatePath = path.join(root, candidate);
        if (fs.existsSync(candidatePath)) {
          return candidatePath;
        }
      }

      const files = fs.readdirSync(root);
      const fallback = files.find((file) => file.toLowerCase().includes('mihomo')) || files.find((file) => file.endsWith('.exe'));
      if (fallback) {
        return path.join(root, fallback);
      }
    } catch (error) {
      console.warn('搜索默认内核路径失败:', error?.message || error);
    }
  }

  return null;
}

function loadKernelPreference() {
  try {
    if (fs.existsSync(kernelPreferenceFile)) {
      const data = JSON.parse(fs.readFileSync(kernelPreferenceFile, 'utf8'));
      context.kernelPreference = data;
      return data || {};
    }
  } catch (error) {
    console.warn('读取内核配置失败:', error?.message || error);
  }
  context.kernelPreference = {};
  return {};
}

function saveKernelPreference(preference) {
  try {
    fs.writeFileSync(kernelPreferenceFile, JSON.stringify(preference ?? {}, null, 2), 'utf8');
    context.kernelPreference = preference ?? {};
  } catch (error) {
    console.error('保存内核配置失败:', error);
    throw error;
  }
}

function clearKernelPreference() {
  try {
    if (fs.existsSync(kernelPreferenceFile)) {
      fs.unlinkSync(kernelPreferenceFile);
    }
  } catch (error) {
    console.warn('清除内核配置失败:', error?.message || error);
  }
  context.kernelPreference = {};
}

function getKernelExecutablePath() {
  const preference = context.kernelPreference || loadKernelPreference();
  const customPath = preference?.customPath ? String(preference.customPath).trim() : '';
  if (customPath) {
    return customPath;
  }
  return resolveDefaultKernelPath();
}

context.set('kernelPreferenceFile', kernelPreferenceFile);
context.resolveDefaultKernelPath = resolveDefaultKernelPath;
context.loadKernelPreference = loadKernelPreference;
context.saveKernelPreference = saveKernelPreference;
context.clearKernelPreference = clearKernelPreference;
context.getKernelExecutablePath = getKernelExecutablePath;
context.kernelPreference = loadKernelPreference();

// 格式化流量数据 - 需要在注册订阅处理器之前定义
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

context.formatTraffic = formatTraffic;

require('./main-process/user-settings')(context);
require('./main-process/mihomo-service')(context);
require('./main-process/system-integration')(context);
require('./main-process/tray-manager')(context);
require('./ipc-handlers/subscriptions')(context);
require('./ipc-handlers/providers')(context);

// 注册覆写处理器
const { registerOverrideHandlers } = require('./ipc-handlers/overrides');
registerOverrideHandlers(context);

// 注册流量历史处理器
const { registerTrafficHistoryHandlers } = require('./ipc-handlers/traffic-history');
registerTrafficHistoryHandlers(context);

const {
  ensureUserSettingsFile,
  getUserSettings,
  updateUserSettingsRaw
} = context;

function applyWindowsBackdrop(win) {
  if (!isWindows || !win || win.isDestroyed?.()) {
    return;
  }

  const mode = state.appearanceMode || 'dynamic';
  const isDark = nativeTheme.shouldUseDarkColors;

  // 清除所有效果，确保可以正确切换
  try {
    win.setVibrancy(null);
  } catch {}

  try {
    win.setBackgroundMaterial('none');
  } catch {}

  // 清除背景颜色，设置为透明，这样才能正确应用毛玻璃效果
  try {
    win.setBackgroundColor('#00000000');
  } catch {}

  const applyTitleBarOverlay = () => {
    const overlayOptions = win.getTitleBarOverlayHeight ? win.getTitleBarOverlayOptions?.() : undefined;
    if (overlayOptions) {
      try {
        win.setTitleBarOverlay({
          color: '#00000000',
          symbolColor: isDark ? '#f3f4f6' : '#0f172a',
          height: overlayOptions.height ?? 48,
        });
      } catch (error) {
        console.warn('更新透明标题栏失败:', error?.message || error);
      }
    }
  };

  if (mode === 'solid') {
    applyTitleBarOverlay();
    // 纯色背景：浅色模式使用浅灰色，深色模式使用深黑灰色
    win.setBackgroundColor(isDark ? '#1a1a1a' : '#e5e7eb');
    return;
  }

  const backgroundMaterials = mode === 'acrylic'
    ? ['acrylic', 'tabbed', 'mica', 'mica-alt']
    : ['tabbed', 'mica', 'mica-alt'];

  let materialApplied = false;
  for (const material of backgroundMaterials) {
    try {
      win.setBackgroundMaterial(material);
      materialApplied = true;
      console.log(`已启用背景材质: ${material}`);
      break;
    } catch (error) {
      console.warn(`背景材质 ${material} 不可用:`, error?.message || error);
    }
  }

  const vibrancyModes = mode === 'dynamic'
    ? ['appearance-based', 'light', 'medium-light', 'ultra-dark', 'sidebar', 'popover']
    : [];
  let vibrancyApplied = false;
  for (const vMode of vibrancyModes) {
    try {
      win.setVibrancy(vMode);
      vibrancyApplied = true;
      console.log(`已启用 Vibrancy 模式: ${vMode}`);
      break;
    } catch (error) {
      console.warn(`Vibrancy 模式 ${vMode} 不可用:`, error?.message || error);
    }
  }

  applyTitleBarOverlay();

  if (!materialApplied && !vibrancyApplied) {
    win.setBackgroundColor(isDark ? '#e60f172a' : '#fcffffff');
  }

  if (mode === 'acrylic') {
    try {
      const rgba = (alpha, r, g, b) => ((alpha & 0xff) << 24) | ((b & 0xff) << 16) | ((g & 0xff) << 8) | (r & 0xff);
      const tint = isDark
        ? rgba(0xf0, 24, 32, 68)
        : rgba(0x99, 255, 255, 255);
      const success = enableAcrylic(win, { tintColor: tint, accentFlags: 2 });
      if (success) {
        console.log('已启用 Windows Acrylic 透明效果');
      }
    } catch (error) {
      console.warn('启用 Acrylic 效果失败:', error?.message || error);
    }
  }
}

const BACKDROP_REFRESH_DELAYS = [0, 24, 120, 480];

function forceWindowsBackdropRepaint(win) {
  if (!isWindows || !win || win.isDestroyed?.()) {
    return;
  }

  if (state.appearanceMode === 'solid') {
    return;
  }

  const key = Symbol.for('flyclash.backdropNudgeCount');
  win[key] = (win[key] || 0) + 1;
  if (win[key] > 4) {
    return;
  }

  let bounds;
  try {
    bounds = win.getBounds();
  } catch (error) {
    console.warn('获取窗口尺寸失败:', error?.message || error);
    return;
  }

  const { x, y, width, height } = bounds;
  if (typeof width !== 'number' || typeof height !== 'number') {
    return;
  }

  try {
    win.setBounds({ x, y, width: width + 4, height: height + 2 }, false);
    setTimeout(() => {
      if (!win.isDestroyed?.()) {
        win.setBounds({ x, y, width, height }, false);
      }
    }, 40);
  } catch (error) {
    console.warn('触发窗口重绘失败:', error?.message || error);
  }
}

function refreshWindowsBackdrop(win, attempt = 0) {
  if (!isWindows || !win || win.isDestroyed?.()) {
    return;
  }

  const delay = BACKDROP_REFRESH_DELAYS[Math.min(attempt, BACKDROP_REFRESH_DELAYS.length - 1)];
  const timer = setTimeout(() => {
    if (win.isDestroyed?.()) {
      return;
    }

    try {
      applyWindowsBackdrop(win);
    } catch (error) {
      console.warn('刷新 Windows 背景材质失败:', error?.message || error);
    }

    if (attempt + 1 < BACKDROP_REFRESH_DELAYS.length) {
      refreshWindowsBackdrop(win, attempt + 1);
    }

    if (attempt >= 1) {
      forceWindowsBackdropRepaint(win);
    }
  }, delay);

  timer.unref?.();
}

function updateUserSettings(settings) {
  const success = updateUserSettingsRaw(settings);
  if (success && state.mihomoProcess && state.mihomoProcess.pid && state.configFilePath) {
    regenerateAndReloadConfig();
  }
  return success;
}

context.updateUserSettings = updateUserSettings;
const {
  toggleSystemProxy,
  enableSystemProxy,
  disableSystemProxy,
  updateSystemProxyIfEnabled,
  toggleTunMode
} = context.systemIntegration;

// 添加函数用于查找mihomo可执行文件
// 确保配置目录存在
if (!fs.existsSync(configDir)) {
  fs.mkdirSync(configDir, { recursive: true });
}

// 流量统计相关变量
const MAX_TRAFFIC_HISTORY = 50;

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

function createWindow() {
  state.mainWindow = new BrowserWindow({
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
    frame: false,
    titleBarStyle: isWindows ? 'hidden' : 'hiddenInset',
    transparent: true,
    backgroundColor: '#00000000',
    backgroundMaterial: isWindows ? 'mica' : undefined,
    vibrancy: isMac ? 'under-window' : undefined,
    visualEffectState: isMac ? 'active' : undefined,
    titleBarOverlay: isMac
      ? {
          color: nativeTheme.shouldUseDarkColors ? '#1a1a1a' : '#f9f9f9',
          symbolColor: nativeTheme.shouldUseDarkColors ? '#f3f4f6' : '#000000',
          height: 48,
        }
      : undefined,
  });

  state.mainWindow.setBackgroundColor('#00000000');
  refreshWindowsBackdrop(state.mainWindow, 0);

  if (!isWindows) {
    try {
      state.mainWindow.setTitleBarOverlay({
        color: nativeTheme.shouldUseDarkColors ? '#1a1a1a' : '#f9f9f9',
        symbolColor: nativeTheme.shouldUseDarkColors ? '#f3f4f6' : '#000000',
        height: 48
      });
    } catch (error) {
      console.warn('初始化标题栏外观失败:', error?.message || error);
    }
  }

  // 监听系统主题变化
  nativeTheme.on('updated', () => {
    if (isWindows) {
      refreshWindowsBackdrop(state.mainWindow, 0);
      try {
        const rgba = (alpha, r, g, b) => ((alpha & 0xff) << 24) | ((b & 0xff) << 16) | ((g & 0xff) << 8) | (r & 0xff);
        const isDark = nativeTheme.shouldUseDarkColors;
        const tint = isDark
          ? rgba(0xdc, 24, 32, 68)
          : rgba(0x66, 255, 255, 255);
        enableAcrylic(state.mainWindow, { tintColor: tint, accentFlags: 2 });
      } catch {}
      return;
    }

    try {
      state.mainWindow.setTitleBarOverlay({
        color: nativeTheme.shouldUseDarkColors ? '#1a1a1a' : '#f9f9f9',
        symbolColor: nativeTheme.shouldUseDarkColors ? '#f3f4f6' : '#000000',
        height: 48
      });
    } catch (error) {
      console.warn('更新标题栏外观失败:', error?.message || error);
    }
  });

  // 开发环境使用localhost:3000
  if (isDev) {
    const startUrl = 'http://localhost:3000';
    state.mainWindow.loadURL(startUrl);
  } else {
    // 生产环境使用内部HTTP服务器提供页面
    loadPageWithServer('');
  }

  state.mainWindow.webContents.on('dom-ready', () => {
    refreshWindowsBackdrop(state.mainWindow, 0);
  });

  // 确保CSS加载正确
  state.mainWindow.webContents.on('did-finish-load', () => {
    refreshWindowsBackdrop(state.mainWindow, 1);
    if (!isDev) {
      try {
        // 尝试注入正确的CSS路径
        const cssDir = path.join(__dirname, '../out/_next/static/css');
        const cssFiles = fs.readdirSync(cssDir);
        if (cssFiles.length > 0) {
          const cssContent = fs.readFileSync(path.join(cssDir, cssFiles[0]), 'utf8');
          state.mainWindow.webContents.insertCSS(cssContent)
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
        await state.mainWindow.loadURL(`http://localhost:3000/${pageName}`);
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
    state.mainWindow.webContents.openDevTools();
  }

  state.mainWindow.once('ready-to-show', () => {
    // 检查是否启用静默启动
    const silentStart = dbManager.getSetting('silentStart', false);
    if (!silentStart) {
      state.mainWindow.show();
      refreshWindowsBackdrop(state.mainWindow, 1);
    } else {
      console.log('静默启动模式: 窗口不显示');
    }

    // 通知渲染进程当前主题状态
    try {
      const currentTheme = nativeTheme.themeSource === 'system'
        ? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
        : nativeTheme.themeSource;
      state.mainWindow.webContents.send('theme-changed', currentTheme);
      console.log('已通知渲染进程当前主题:', currentTheme);
    } catch (error) {
      console.error('通知主题状态失败:', error);
    }

    // 自动启动Mihomo
    console.log('[main.js] ready-to-show: state.autoStartEnabled =', state.autoStartEnabled);
    if (state.autoStartEnabled) {
      console.log('[main.js] ready-to-show: 将在 1 秒后调用 autoStartMihomo');
      setTimeout(autoStartMihomo, 1000);
    } else {
      console.log('[main.js] ready-to-show: 自动启动已禁用');
    }
  });

  state.mainWindow.on('close', (event) => {
    if (!state.isQuitting) {
      event.preventDefault();
      state.mainWindow.hide();
    }
  });

  state.mainWindow.on('show', () => {
    refreshWindowsBackdrop(state.mainWindow, 0);
  });

  state.mainWindow.on('focus', () => {
    refreshWindowsBackdrop(state.mainWindow, 1);
  });

  // 添加窗口事件监听器
  state.mainWindow.on('minimize', () => {
    console.log('[调试] 窗口最小化，降低更新频率');
    // 暂停或减慢更新频率
    stopTrafficStatsUpdate();
    // 改为低频率更新
    state.trafficStatsInterval = setInterval(() => {
      updateTrafficStats();
    }, 10000); // 每10秒更新一次
  });

  state.mainWindow.on('restore', () => {
    console.log('[调试] 窗口恢复，恢复正常更新频率');
    // 恢复正常更新频率
    stopTrafficStatsUpdate();
    startTrafficStatsUpdate();
  });
}

// 启动mihomo
async function startMihomo(configPath) {
  return context.mihomoService.startMihomo(configPath);
}

async function stopMihomo() {
  return context.mihomoService.stopMihomo();
}

async function restartMihomoService() {
  return context.mihomoService.restartMihomoService();
}

context.toggleTunMode = toggleTunMode;

// 更新系统代理设置（当端口变更时调用）
// 自动启动Mihomo功能
async function autoStartMihomo() {
  console.log('[main.js] autoStartMihomo 被调用');
  console.log('[main.js] context.mihomoService:', typeof context.mihomoService);
  console.log('[main.js] context.mihomoService.autoStartMihomo:', typeof context.mihomoService?.autoStartMihomo);
  return context.mihomoService.autoStartMihomo();
}

// 新增函数：确保mihomo所需的数据文件存在
async function ensureMihomoDataFiles() {
  return context.mihomoService.ensureMihomoDataFiles();
}

// 获取订阅列表
function getSubscriptionList() {
  return context.mihomoService.getSubscriptionList();
}

// 解析YAML配置文件
function parseConfigFile(filePath) {
  return context.mihomoService.parseConfigFile(filePath);
}

// 新增: 获取配置文件中的原始代理组顺序
ipcMain.handle('get-config-order', async (event) => {
  try {
    // 如果Mihomo未运行，没有活跃的配置文件
    if (!state.configFilePath) {
      return {
        success: false,
        error: 'Mihomo未运行，没有活跃的配置文件'
      };
    }

    // 使用覆写后的配置文件路径（override-xxx.yaml）
    const path = require('path');
    const configFilename = path.basename(state.configFilePath);
    const overrideConfigFilename = 'override-' + configFilename;
    const mihomoDir = path.join(context.get('userDataPath'), 'mihomo');
    const overrideConfigPath = path.join(mihomoDir, overrideConfigFilename);

    // 检查覆写后的配置文件是否存在
    const fs = require('fs');
    const configPathToUse = fs.existsSync(overrideConfigPath) ? overrideConfigPath : state.configFilePath;

    console.log('[get-config-order] 原始配置路径:', state.configFilePath);
    console.log('[get-config-order] 覆写配置路径:', overrideConfigPath);
    console.log('[get-config-order] 实际使用路径:', configPathToUse);

    // 解析配置文件
    const configData = parseConfigFile(configPathToUse);
    if (!configData) {
      return {
        success: false,
        error: '解析配置文件失败'
      };
    }

    return {
      success: true,
      data: configData
    };
  } catch (error) {
    console.error('获取配置顺序失败:', error);
    return {
      success: false,
      error: `获取配置顺序失败: ${error.message}`
    };
  }
});

// 新增: 获取当前配置
async function getConfig() {
  return context.mihomoService.getConfig();
}

// 更新流量统计
function updateTrafficStats() {
  // 避免创建多个连接
  if (state.trafficWebSocket && state.trafficWebSocket.readyState !== WebSocket.CLOSED) {
    return;
  }
  
  try {
    // 检查是否有解析的API配置
    if (!state.activeApiConfig) {
      console.error('无法连接WebSocket: API配置不可用');
      return;
    }

    // 使用 Unix Socket / Named Pipe 连接
    const { socketPath } = state.activeApiConfig || {};

    if (!socketPath) {
      throw new Error('Socket 路径未初始化');
    }

    // WebSocket over Unix Socket 格式: ws+unix:<socket_path>:<endpoint>
    // 注意: 不要使用 // 因为会被解析为 URL host
    const wsUrl = `ws+unix:${socketPath}:/traffic`;

    console.log(`[Socket] 连接到流量统计 WebSocket: ${wsUrl}`);

    // 创建流量统计WebSocket (不需要密钥认证)
    state.trafficWebSocket = new WebSocket(wsUrl);

    state.trafficWebSocket.on('open', () => {
      console.log('[调试] 流量统计WebSocket连接已建立');
      state.trafficRetry = 10; // 重置重试计数
    });

    state.trafficWebSocket.on('message', (data) => {
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

        state.lastTrafficStats = stats;

        // 添加到历史记录并限制大小
        state.trafficHistory.push(stats);
        if (state.trafficHistory.length > MAX_TRAFFIC_HISTORY) {
          state.trafficHistory.shift(); // 移除最旧的记录
        }

        // 累加流量数据用于持久化
        if (!state.trafficAccumulator) {
          state.trafficAccumulator = { upload: 0, download: 0, lastSaveTime: Date.now() };
        }
        state.trafficAccumulator.upload += json.up;
        state.trafficAccumulator.download += json.down;

        // 每10秒保存一次到数据库
        const now = Date.now();
        if (now - state.trafficAccumulator.lastSaveTime >= 10000) {
          try {
            context.dbManager.updateTodayTraffic(
              state.trafficAccumulator.upload,
              state.trafficAccumulator.download
            );
            // 重置累加器
            state.trafficAccumulator = { upload: 0, download: 0, lastSaveTime: now };
          } catch (error) {
            console.error('[流量] 保存流量数据失败:', error);
          }
        }

        // 发送更新到主窗口
        if (state.mainWindow) {
          state.mainWindow.webContents.send('traffic-update', stats);
        }
        
        // 减少连接信息获取频率，例如每5秒一次
        const currentTime = Date.now();
        if (!state.lastConnectionsFetchTime || (currentTime - state.lastConnectionsFetchTime) > 5000) {
          fetchConnectionsInfo();
          state.lastConnectionsFetchTime = currentTime;
        }
        
        // 只在流量变化较大时输出日志（大于10MB的变化）
        const significantChange = Math.abs(stats.up - state.lastTrafficStats.up) > 10 * 1024 * 1024 || 
                                Math.abs(stats.down - state.lastTrafficStats.down) > 10 * 1024 * 1024;
        if (significantChange) {
          console.log(`[调试] 流量更新: 上传 ${formatTraffic(stats.up)}, 下载 ${formatTraffic(stats.down)}`);
        }
      } catch (error) {
        console.error('[调试] 处理流量数据时出错:', error);
      }
    });

    state.trafficWebSocket.on('close', () => {
      // 只在第一次关闭时输出日志
      if (state.trafficRetry === 10) {
        console.log('[调试] 流量统计WebSocket连接已关闭');
      }
      state.trafficWebSocket = null;

      if (state.trafficRetry > 0) {
        state.trafficRetry--;
        // 只在第一次和最后一次重试时输出日志
        if (state.trafficRetry === 9 || state.trafficRetry === 0) {
          console.log(`[调试] 尝试重新连接WebSocket，剩余重试次数: ${state.trafficRetry}`);
        }
        updateTrafficStats();
      } else {
        console.log('[调试] WebSocket重连次数已达上限，停止重试');
      }
    });

    state.trafficWebSocket.on('error', (error) => {
      console.error('[调试] 流量统计WebSocket错误:', error);
      if (state.trafficWebSocket) {
        state.trafficWebSocket.close();
        state.trafficWebSocket = null;
      }
    });
  } catch (error) {
    // ... existing code ...
  }
}

// 设置定时更新流量统计
// 流量统计定时器在共享状态模块中维护
function startTrafficStatsUpdate() {
  if (state.trafficStatsInterval) {
    clearInterval(state.trafficStatsInterval);
  }
  
  // 初始化WebSocket连接
  updateTrafficStats();
  
  // 设置定时器，每1秒检查一次WebSocket连接状态
  state.trafficStatsInterval = setInterval(() => {
    if (!state.trafficWebSocket || state.trafficWebSocket.readyState !== 1) {
      // 移除重连日志，避免刷屏
      updateTrafficStats();
    }
  }, 1000); // 每1秒检查一次
}

function stopTrafficStatsUpdate() {
  if (state.trafficStatsInterval) {
    clearInterval(state.trafficStatsInterval);
    state.trafficStatsInterval = null;
  }
  
  if (state.trafficWebSocket) {
    state.trafficWebSocket.close();
    state.trafficWebSocket = null;
  }
}

context.startTrafficStatsUpdate = startTrafficStatsUpdate;
context.stopTrafficStatsUpdate = stopTrafficStatsUpdate;

// 日志WebSocket连接
function startMihomoLogs() {
  // 避免创建多个连接
  if (state.logsWebSocket && state.logsWebSocket.readyState !== WebSocket.CLOSED) {
    return;
  }

  try {
    // 检查是否有解析的API配置
    if (!state.activeApiConfig) {
      console.error('无法连接日志WebSocket: API配置不可用');
      return;
    }

    // 使用 Unix Socket / Named Pipe 连接
    const { socketPath } = state.activeApiConfig || {};

    if (!socketPath) {
      throw new Error('Socket 路径未初始化');
    }

    // 获取日志级别，默认为info
    const logLevel = 'info';
    const wsUrl = `ws+unix:${socketPath}:/logs?level=${logLevel}`;

    console.log(`[Socket] 连接到日志 WebSocket: ${wsUrl}`);

    // 创建日志WebSocket (不需要密钥认证)
    state.logsWebSocket = new WebSocket(wsUrl);

    state.logsWebSocket.on('open', () => {
      console.log('[调试] 日志WebSocket连接已建立');
      state.logsRetry = 10; // 重置重试计数
    });

    state.logsWebSocket.on('message', (data) => {
      try {
        const log = JSON.parse(data);
        // 发送日志到渲染进程
        if (state.mainWindow) {
          state.mainWindow.webContents.send('mihomo-logs', log);
        }
      } catch (error) {
        console.error('[调试] 解析日志数据失败:', error);
      }
    });

    state.logsWebSocket.on('close', () => {
      console.log('[调试] 日志WebSocket连接已关闭');
      state.logsWebSocket = null;

      if (state.logsRetry > 0) {
        state.logsRetry--;
        console.log(`[调试] 尝试重新连接日志WebSocket，剩余重试次数: ${state.logsRetry}`);
        setTimeout(() => startMihomoLogs(), 3000);
      } else {
        console.log('[调试] 日志WebSocket重连次数已达上限，停止重试');
      }
    });

    state.logsWebSocket.on('error', (error) => {
      console.error('[调试] 日志WebSocket错误:', error);
      if (state.logsWebSocket) {
        state.logsWebSocket.close();
        state.logsWebSocket = null;
      }
    });
  } catch (error) {
    console.error('[调试] 启动日志WebSocket失败:', error);
  }
}

function stopMihomoLogs() {
  if (state.logsWebSocket) {
    state.logsWebSocket.close();
    state.logsWebSocket = null;
  }
  state.logsRetry = 10;
}

context.startMihomoLogs = startMihomoLogs;
context.stopMihomoLogs = stopMihomoLogs;

// 立即注册基础IPC，避免渲染进程早期调用时报“handler 未注册”
ipcMain.handle('get-traffic-stats', () => state.lastTrafficStats);
ipcMain.handle('get-auth-token', () => {
  try {
    const { token, expiry } = ensureAuthToken();
    return { success: true, token, expiry };
  } catch (error) {
    console.error('生成安全令牌失败:', error);
    return { success: false, error: error?.message || String(error) };
  }
});

// 启动连接管理WebSocket
async function startConnectionsWebSocket() {
  try {
    if (!state.currentNode) {
      throw new Error('未选择节点');
    }

    if (!state.activeApiConfig) {
      throw new Error('API配置不可用');
    }

    // 使用 Unix Socket / Named Pipe 连接
    const { socketPath } = state.activeApiConfig || {};

    if (!socketPath) {
      throw new Error('Socket 路径未初始化');
    }

    // 创建新的WebSocket连接，使用 Unix Socket
    const wsUrl = `ws+unix:${socketPath}:/connections/${state.currentNode}`;
    console.log(`[Socket] 连接到节点 WebSocket: ${wsUrl}`);

    state.connectionsWebSocket = new WebSocket(wsUrl);
    
    // 设置连接超时
    const connectionTimeout = setTimeout(() => {
      if (state.connectionsWebSocket.readyState !== WebSocket.OPEN) {
        state.connectionsWebSocket.close();
        throw new Error('连接超时');
      }
    }, 5000);

    // 连接建立
    state.connectionsWebSocket.on('open', () => {
      clearTimeout(connectionTimeout);
      console.log(`已连接到节点 ${state.currentNode}`);
    });

    // 连接关闭
    state.connectionsWebSocket.on('close', () => {
      console.log(`与节点 ${state.currentNode} 的连接已关闭`);
      // 尝试重新连接
      setTimeout(() => {
        if (state.currentNode) {
          startConnectionsWebSocket().catch(console.error);
        }
      }, 5000);
    });

    // 错误处理
    state.connectionsWebSocket.on('error', (error) => {
      console.error('WebSocket错误:', error);
      clearTimeout(connectionTimeout);
    });

  } catch (error) {
    console.error('启动WebSocket连接失败:', error);
    throw error;
  }
}

// 更新当前节点信息
async function updateCurrentNodeInfo() {
  try {
    if (!state.activeApiConfig) {
      console.error('无法获取节点信息: API配置不可用');
      return;
    }

    // Socket 模式: 使用 fetchMihomoAPI
    console.log(`[调试] 请求节点信息: /proxies/PROXY`);

    const response = await fetchMihomoAPI('/proxies/PROXY');
    if (response.ok) {
      const data = await response.json();
      console.log('[调试] 获取到PROXY组信息:', data);
      
      if (data && data.now) {
        state.currentNode = data.now;
        console.log('[调试] 更新当前节点为:', state.currentNode);
        
        // 更新state.lastConnectionsInfo中的节点信息
    state.lastConnectionsInfo = {
      ...state.lastConnectionsInfo,
      currentNode: state.currentNode
    };
        
        // 通知主窗口节点已更新
        if (state.mainWindow && state.mainWindow.webContents && !state.mainWindow.isDestroyed()) {
          console.log('[调试] 发送节点变更事件:', state.currentNode);
          
          // 立即发送节点更新
          state.mainWindow.webContents.send('node-changed', { nodeName: state.currentNode });
          
          // 添加延迟，确保前端有足够时间处理节点更新
          setTimeout(() => {
            if (state.mainWindow && !state.mainWindow.isDestroyed()) {
              console.log('[调试] 延迟发送连接信息更新:', state.lastConnectionsInfo);
              state.mainWindow.webContents.send('connections-update', state.lastConnectionsInfo);
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
function stopConnectionsWebSocket() {
  if (state.connectionsWebSocket) {
    state.connectionsWebSocket.close();
    state.connectionsWebSocket = null;
  }
  state.connectionsRetry = 10;
}

context.startConnectionsWebSocket = startConnectionsWebSocket;
context.stopConnectionsWebSocket = stopConnectionsWebSocket;
context.updateCurrentNodeInfo = updateCurrentNodeInfo;

// 添加检查Mihomo服务状态的函数
async function checkMihomoService() {
  return context.mihomoService.checkMihomoService();
}

// Mihomo进程意外停止时的处理函数
function handleMihomoProcessExit(code) {
  console.log(`Mihomo进程退出，代码: ${code}`);
  state.mihomoProcess = null;
  stopTrafficStatsUpdate();
  stopConnectionsWebSocket();
  stopMihomoLogs();
  // 清除state.configFilePath确保状态正确更新
  state.configFilePath = null;
  
  // 通知前端Mihomo已停止
  if (state.mainWindow && !state.mainWindow.isDestroyed()) {
    state.mainWindow.webContents.send('mihomo-stopped', code);
  }
}

context.handleMihomoProcessExit = handleMihomoProcessExit;
context.checkMihomoService = checkMihomoService;

ipcMain.handle('window-minimize', () => {
  if (state.mainWindow) {
    state.mainWindow.minimize();
    return { success: true };
  }
  return { success: false };
});

ipcMain.handle('window-toggle-maximize', () => {
  if (!state.mainWindow) {
    return { success: false };
  }

  if (state.mainWindow.isMaximized()) {
    state.mainWindow.restore();
    return { success: true, maximized: false };
  }

  state.mainWindow.maximize();
  return { success: true, maximized: true };
});

ipcMain.handle('window-close', () => {
  if (state.mainWindow) {
    state.mainWindow.close();
    return { success: true };
  }
  return { success: false };
});

ipcMain.handle('open-file', async (event, token, filePath) => {
  try {
    console.log('打开文件请求，token:', token);
    console.log('打开文件请求，原始路径:', filePath);

    // 验证安全令牌
    if (!verifyAuthToken(token)) {
      console.error('安全令牌验证失败');
      return { success: false, error: '安全令牌验证失败' };
    }

    // 规范化路径
    const normalizedPath = path.normalize(filePath);
    console.log('规范化后的路径:', normalizedPath);

    // 检查文件是否存在
    if (!fs.existsSync(normalizedPath)) {
      console.error('文件不存在:', normalizedPath);
      return { success: false, error: `文件不存在: ${normalizedPath}` };
    }

    const errorMessage = await shell.openPath(normalizedPath);
    if (errorMessage) {
      console.error('打开文件失败:', errorMessage);
      return { success: false, error: errorMessage };
    }
    console.log('文件打开成功');
    return { success: true };
  } catch (error) {
    console.error('打开文件失败:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('open-file-location', (event, token, filePath) => {
  try {
    console.log('打开文件位置请求，token:', token);
    console.log('打开文件位置请求，原始路径:', filePath);

    // 验证安全令牌
    if (!verifyAuthToken(token)) {
      console.error('安全令牌验证失败');
      return { success: false, error: '安全令牌验证失败' };
    }

    // 规范化路径
    const normalizedPath = path.normalize(filePath);
    console.log('规范化后的路径:', normalizedPath);

    // 检查文件是否存在
    if (!fs.existsSync(normalizedPath)) {
      console.error('文件不存在:', normalizedPath);
      return { success: false, error: `文件不存在: ${normalizedPath}` };
    }

    shell.showItemInFolder(normalizedPath);
    console.log('文件位置打开成功');
    return { success: true };
  } catch (error) {
    console.error('打开文件所在目录失败:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-kernel-path', async () => {
  try {
    const preference = context.kernelPreference || loadKernelPreference();
    const customPath = preference?.customPath ? String(preference.customPath).trim() : '';
    const defaultPath = resolveDefaultKernelPath();
    const activePath = customPath || defaultPath || '';
    const exists = activePath ? fs.existsSync(activePath) : false;

    return {
      success: true,
      path: activePath,
      isDefault: !customPath,
      exists
    };
  } catch (error) {
    console.error('获取内核路径失败:', error);
    return {
      success: false,
      error: error?.message || String(error)
    };
  }
});

ipcMain.handle('select-kernel-executable', async () => {
  try {
    const result = await dialog.showOpenDialog(state.mainWindow ?? undefined, {
      title: '选择 Mihomo 内核',
      properties: ['openFile'],
      filters: isWindows
        ? [
            {
              name: '可执行文件',
              extensions: ['exe']
            }
          ]
        : [
            {
              name: '可执行文件',
              extensions: ['*']
            }
          ]
    });

    if (result.canceled || !result.filePaths?.length) {
      return { success: false, canceled: true };
    }

    const selectedPath = result.filePaths[0];
    saveKernelPreference({ customPath: selectedPath });

    return {
      success: true,
      path: selectedPath,
      isDefault: false,
      exists: fs.existsSync(selectedPath),
      needsRestart: Boolean(state.mihomoProcess)
    };
  } catch (error) {
    console.error('选择内核文件失败:', error);
    return {
      success: false,
      error: error?.message || String(error)
    };
  }
});

ipcMain.handle('reset-kernel-path', async () => {
  try {
    clearKernelPreference();
    const defaultPath = resolveDefaultKernelPath();
    return {
      success: true,
      path: defaultPath || '',
      isDefault: true,
      exists: defaultPath ? fs.existsSync(defaultPath) : false,
      needsRestart: Boolean(state.mihomoProcess)
    };
  } catch (error) {
    console.error('恢复默认内核失败:', error);
    return {
      success: false,
      error: error?.message || String(error)
    };
  }
});

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
    const theme = dbManager.getSetting('theme', 'system');
    nativeTheme.themeSource = theme;
    console.log('已加载主题设置:', theme);
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
      state.systemProxyEnabled = result.includes('0x1');
      
      if (state.systemProxyEnabled) {
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
  
  // 读取外观设置
  try {
    const storedAppearance = dbManager.getSetting('appearanceMode', 'dynamic');
    if (storedAppearance) {
      state.appearanceMode = storedAppearance;
    }
  } catch (error) {
    console.warn('读取外观设置失败，将使用默认值:', error?.message || error);
    state.appearanceMode = 'dynamic';
  }

  // 检查TUN模式状态
  try {
    // 读取用户设置
    const userSettings = getUserSettings();
    // 检查TUN模式状态
    state.tunModeEnabled = userSettings.tun && userSettings.tun.enable === true;
    console.log('TUN模式状态:', state.tunModeEnabled ? '已启用' : '未启用');

    // 保存TUN状态到数据库
    dbManager.setSetting('tunModeEnabled', state.tunModeEnabled);
  } catch (error) {
    console.error('检查TUN模式状态失败:', error);
  }

  // 创建窗口和其他初始化操作
  context.trayManager.ensureTray()
    .then(() => context.trayManager.updateTrayMenu())
    .catch((error) => {
      console.error('初始化托盘失败:', error);
    });

  // 启动订阅调度器
  subscriptionScheduler.start();

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

  // 添加: 主题设置
  ipcMain.handle('set-theme', (event, theme) => {
    try {
      console.log('设置主题:', theme);
      if (!state.mainWindow || state.mainWindow.isDestroyed()) {
        return { success: false, error: '窗口不存在' };
      }

      // 保存主题设置到数据库
      dbManager.setSetting('theme', theme);
      
      // 根据主题更新窗口
      switch (theme) {
        case 'light':
          nativeTheme.themeSource = 'light';
          state.mainWindow.webContents.send('theme-changed', 'light');
          break;
        case 'dark':
          nativeTheme.themeSource = 'dark';
          state.mainWindow.webContents.send('theme-changed', 'dark');
          break;
        case 'system':
        default:
          nativeTheme.themeSource = 'system';
          state.mainWindow.webContents.send('theme-changed', nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
          break;
      }

      // 更新标题栏颜色
      state.mainWindow.setTitleBarOverlay({
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

  ipcMain.handle('get-appearance-mode', () => {
    return {
      success: true,
      mode: state.appearanceMode || 'acrylic'
    };
  });

  ipcMain.handle('set-appearance-mode', (event, mode) => {
    try {
      const allowedModes = ['acrylic', 'dynamic', 'solid'];
      if (!allowedModes.includes(mode)) {
        return { success: false, error: '不支持的外观模式' };
      }

      state.appearanceMode = mode;
      dbManager.setSetting('appearanceMode', mode);

      if (state.mainWindow && !state.mainWindow.isDestroyed()) {
        state.mainWindow[Symbol.for('flyclash.backdropNudgeCount')] = 0;
        applyWindowsBackdrop(state.mainWindow);
        refreshWindowsBackdrop(state.mainWindow, 0);
        try {
          state.mainWindow.webContents.send('appearance-mode-changed', mode);
        } catch {}
      }

      return { success: true, mode };
    } catch (error) {
      console.error('设置外观模式失败:', error);
      return { success: false, error: error?.message || String(error) };
    }
  });
  
  // 添加: 获取当前主题设置
  ipcMain.handle('get-theme', () => {
    try {
      // 从数据库读取主题设置
      const theme = dbManager.getSetting('theme', 'system');
      return { success: true, theme };
    } catch (error) {
      console.error('获取主题设置失败:', error);
      return { success: false, theme: 'system', error: error.message };
    }
  });

  // 获取静默启动设置
  ipcMain.handle('get-silent-start', () => {
    try {
      const silentStart = dbManager.getSetting('silentStart', false);
      return { success: true, silentStart };
    } catch (error) {
      console.error('获取静默启动设置失败:', error);
      return { success: false, silentStart: false, error: error.message };
    }
  });

  // 设置静默启动
  ipcMain.handle('set-silent-start', (event, enabled) => {
    try {
      dbManager.setSetting('silentStart', Boolean(enabled));
      console.log('静默启动设置已更新:', enabled);
      return { success: true };
    } catch (error) {
      console.error('设置静默启动失败:', error);
      return { success: false, error: error.message };
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
      const response = await fetch(`http://127.0.0.1:9090/proxies/${encodeURIComponent(groupName)}`, {
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
        state.currentNode = nodeName;
        console.log('更新当前节点:', state.currentNode);
        
        // 更新托盘菜单
        context.trayManager.updateTrayMenu();
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
      state.currentNode = nodeName;
      
      // 更新托盘菜单以反映新节点
      context.trayManager.updateTrayMenu();
      
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
      if (!state.activeApiConfig) {
        console.error('无法获取代理节点: API配置不可用');
        return;
      }

      // Socket 模式: 使用 fetchMihomoAPI
      const response = await fetchMihomoAPI('/proxies');
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
    // 通过state.configFilePath判断mihomo是否在运行
    // 如果mihomo已停止，这里应该返回null
    return state.configFilePath || null;
  });
  
  ipcMain.handle('get-proxy-nodes', (event, configPath) => {
    try {
      // 如果指定了配置路径，则使用指定的路径
      // 否则使用当前激活的配置
      const config = configPath || state.configFilePath;
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
    try {
      return typeof app.getVersion === 'function' ? app.getVersion() : APP_VERSION;
    } catch (error) {
      console.warn('获取应用版本失败:', error?.message || error);
      return APP_VERSION;
    }
  });

  // 处理自动启动设置
  ipcMain.handle('set-auto-start', (event, enabled) => {
    state.autoStartEnabled = enabled;
    return true;
  });
  
  // 获取自动启动设置
  ipcMain.handle('get-auto-start', () => {
    return state.autoStartEnabled;
  });

  // 获取进程图标
  ipcMain.handle('get-icon-dataurl', async (event, processPath) => {
    try {
      const iconDataURL = await getIconDataURL(processPath);
      return iconDataURL;
    } catch (error) {
      console.error('获取进程图标失败:', error);
      return '';
    }
  });

  // 获取内核配置
  ipcMain.handle('get-kernel-config', () => {
    try {
      // 从用户设置中读取配置
      const userSettings = context.getUserSettings ? context.getUserSettings() : {};
      console.log('[get-kernel-config] 从用户设置读取配置:', userSettings);

      return {
        success: true,
        config: {
          ipv6: userSettings.ipv6,
          'log-level': userSettings['log-level'],
          'mixed-port': userSettings['mixed-port'],
          'allow-lan': userSettings['allow-lan'],
          'lan-allowed-ips': userSettings['lan-allowed-ips'],
          'lan-disallowed-ips': userSettings['lan-disallowed-ips'],
          'external-controller': userSettings['external-controller'],
          secret: userSettings.secret,
          authentication: userSettings.authentication,
          'skip-auth-prefixes': userSettings['skip-auth-prefixes'],
          'unified-delay': userSettings['unified-delay'],
          'tcp-concurrent': userSettings['tcp-concurrent'],
          'disable-keep-alive': userSettings['disable-keep-alive'],
          'keep-alive-idle': userSettings['keep-alive-idle'],
          'keep-alive-interval': userSettings['keep-alive-interval'],
          'global-client-fingerprint': userSettings['global-client-fingerprint'],
          'find-process-mode': userSettings['find-process-mode'],
          'interface-name': userSettings['interface-name'],
          profile: userSettings.profile
        }
      };
    } catch (error) {
      console.error('获取内核配置失败:', error);
      return { success: false, error: error.message };
    }
  });

  // 保存内核配置
  ipcMain.handle('save-kernel-config', async (event, kernelConfig) => {
    try {
      console.log('[save-kernel-config] ========== 开始保存内核配置 ==========');
      console.log('[save-kernel-config] 接收到配置:', JSON.stringify(kernelConfig, null, 2));

      // 获取当前用户设置
      console.log('[save-kernel-config] 正在获取当前用户设置...');
      const currentSettings = context.getUserSettings ? context.getUserSettings() : {};
      console.log('[save-kernel-config] 当前用户设置:', JSON.stringify(currentSettings, null, 2));

      // 过滤掉空字符串的 external-controller (留空表示不启动外部控制器)
      const filteredConfig = { ...kernelConfig };
      if (filteredConfig['external-controller'] === '') {
        delete filteredConfig['external-controller'];
        console.log('[save-kernel-config] external-controller 为空,已删除');
      }

      // 合并新配置
      const newSettings = { ...currentSettings, ...filteredConfig };
      console.log('[save-kernel-config] 合并后的设置:', JSON.stringify(newSettings, null, 2));

      // 保存到用户设置（会同时保存到数据库和 user-settings.yaml）
      console.log('[save-kernel-config] 正在保存到用户设置...');
      if (context.updateUserSettingsRaw) {
        try {
          await context.updateUserSettingsRaw(newSettings);
          console.log('[save-kernel-config] 用户设置保存成功');
        } catch (saveError) {
          console.error('[save-kernel-config] 保存用户设置失败:', saveError);
          throw new Error('保存用户设置失败: ' + saveError.message);
        }
      } else {
        console.error('[save-kernel-config] updateUserSettingsRaw 函数不可用');
        throw new Error('updateUserSettingsRaw 函数不可用');
      }

      // 保存成功后，重启 Mihomo 服务以应用新配置
      console.log('[save-kernel-config] 配置已保存到用户设置，准备重启服务');
      if (context.mihomoService && typeof context.mihomoService.restartMihomoService === 'function') {
        try {
          console.log('[save-kernel-config] 正在重启服务...');
          const restartResult = await context.mihomoService.restartMihomoService();
          console.log('[save-kernel-config] 服务重启结果:', restartResult);
          console.log('[save-kernel-config] ========== 内核配置保存完成 ==========');
          return {
            success: true,
            restarted: restartResult.success,
            message: restartResult.success ? '配置已保存并应用' : '配置已保存，但重启失败'
          };
        } catch (restartError) {
          console.error('[save-kernel-config] 重启服务失败:', restartError);
          console.error('[save-kernel-config] 错误堆栈:', restartError.stack);
          return {
            success: true,
            restarted: false,
            message: '配置已保存，但重启失败: ' + restartError.message
          };
        }
      } else {
        console.warn('[save-kernel-config] mihomoService 不可用，无法重启');
        console.warn('[save-kernel-config] context.mihomoService:', context.mihomoService);
        return {
          success: true,
          restarted: false,
          message: '配置已保存，但需要手动重启服务'
        };
      }
    } catch (error) {
      console.error('[save-kernel-config] ========== 内核配置保存失败 ==========');
      console.error('[save-kernel-config] 错误:', error);
      console.error('[save-kernel-config] 错误堆栈:', error.stack);
      return { success: false, error: error.message };
    }
  });

  // 获取 DNS 配置
  ipcMain.handle('get-dns-config', () => {
    try {
      // 从用户设置中读取 DNS 配置
      const userSettings = context.getUserSettings ? context.getUserSettings() : {};
      console.log('[get-dns-config] 从用户设置读取DNS配置:', userSettings.dns);

      return {
        success: true,
        config: userSettings.dns || {},
        hosts: userSettings.hosts || {}
      };
    } catch (error) {
      console.error('获取 DNS 配置失败:', error);
      return { success: false, error: error.message };
    }
  });

  // 保存 DNS 配置
  ipcMain.handle('save-dns-config', async (event, dnsConfig) => {
    try {
      console.log('[save-dns-config] ========== 开始保存DNS配置 ==========');
      console.log('[save-dns-config] 接收到DNS配置:', JSON.stringify(dnsConfig, null, 2));

      // 获取当前用户设置
      console.log('[save-dns-config] 正在获取当前用户设置...');
      const currentSettings = context.getUserSettings ? context.getUserSettings() : {};
      console.log('[save-dns-config] 当前用户设置:', JSON.stringify(currentSettings, null, 2));

      // 合并新的 DNS 配置
      const newSettings = { ...currentSettings, dns: dnsConfig };
      console.log('[save-dns-config] 合并后的设置:', JSON.stringify(newSettings, null, 2));

      // 保存到用户设置（会同时保存到数据库和 user-settings.yaml）
      console.log('[save-dns-config] 正在保存到用户设置...');
      if (context.updateUserSettingsRaw) {
        try {
          await context.updateUserSettingsRaw(newSettings);
          console.log('[save-dns-config] 用户设置保存成功');
        } catch (saveError) {
          console.error('[save-dns-config] 保存用户设置失败:', saveError);
          throw new Error('保存用户设置失败: ' + saveError.message);
        }
      } else {
        console.error('[save-dns-config] updateUserSettingsRaw 函数不可用');
        throw new Error('updateUserSettingsRaw 函数不可用');
      }

      // 保存成功后，重启 Mihomo 服务以应用新配置
      console.log('[save-dns-config] DNS配置已保存到用户设置，准备重启服务');
      if (context.mihomoService && typeof context.mihomoService.restartMihomoService === 'function') {
        try {
          console.log('[save-dns-config] 正在重启服务...');
          const restartResult = await context.mihomoService.restartMihomoService();
          console.log('[save-dns-config] 服务重启结果:', restartResult);
          console.log('[save-dns-config] ========== DNS配置保存完成 ==========');
          return {
            success: true,
            restarted: restartResult.success,
            message: restartResult.success ? 'DNS配置已保存并应用' : 'DNS配置已保存，但重启失败'
          };
        } catch (restartError) {
          console.error('[save-dns-config] 重启服务失败:', restartError);
          console.error('[save-dns-config] 错误堆栈:', restartError.stack);
          return {
            success: true,
            restarted: false,
            message: 'DNS配置已保存，但重启失败: ' + restartError.message
          };
        }
      } else {
        console.warn('[save-dns-config] mihomoService 不可用，无法重启');
        console.warn('[save-dns-config] context.mihomoService:', context.mihomoService);
        return {
          success: true,
          restarted: false,
          message: 'DNS配置已保存，但需要手动重启服务'
        };
      }
    } catch (error) {
      console.error('[save-dns-config] ========== DNS配置保存失败 ==========');
      console.error('[save-dns-config] 错误:', error);
      console.error('[save-dns-config] 错误堆栈:', error.stack);
      return { success: false, error: error.message };
    }
  });

  // 保存 Hosts 配置
  ipcMain.handle('save-hosts-config', (event, hosts) => {
    try {
      const configPath = path.join(userDataPath, 'config.yaml');
      let config = {};

      if (fs.existsSync(configPath)) {
        const configContent = fs.readFileSync(configPath, 'utf8');
        config = yaml.load(configContent);
      }

      // 转换 hosts 数组为对象格式
      const hostsObject = {};
      hosts.forEach(({ domain, value }) => {
        hostsObject[domain] = value;
      });

      // 更新 hosts 配置
      config.hosts = hostsObject;

      // 保存配置
      fs.writeFileSync(configPath, yaml.dump(config), 'utf8');

      return { success: true };
    } catch (error) {
      console.error('保存 Hosts 配置失败:', error);
      return { success: false, error: error.message };
    }
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

  // 新增: 切换系统代理
  ipcMain.handle('toggleSystemProxy', async (event, token, enabled) => {
    try {
      if (!verifyAuthToken(token)) {
        security?.logSecurityEvent?.('invalid-token', { action: 'toggleSystemProxy' });
        return { success: false, error: '安全校验失败，请重试' };
      }

      const menuItem = { checked: Boolean(enabled) };
      toggleSystemProxy(menuItem);

      return { success: true, enabled: state.systemProxyEnabled };
    } catch (error) {
      console.error('切换系统代理失败:', error);
      return { success: false, error: error?.message || String(error) };
    }
  });

  // 新增: 获取系统代理状态
  ipcMain.handle('getProxyStatus', async () => {
    return state.systemProxyEnabled;
  });

  // 添加获取连接信息的函数
  ipcMain.handle('get-connections', async () => {
    try {
      const response = await fetch('http://127.0.0.1:9090/connections');
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
      const response = await fetch(`http://127.0.0.1:9090/connections/${connectionId}`, {
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
      const response = await fetch('http://127.0.0.1:9090/connections', {
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
    if (state.mainWindow) {
      console.log('[调试] 处理IPC connections-update事件:', data);
      
      // 确保connections数组存在
      const connections = data.connections || [];
      
      // 计算活跃连接数 - 与fetchConnectionsInfo保持一致
      const activeConnections = connections.filter(conn => conn.isActive !== false).length;
      
      // 使用相同的字段结构发送到前端
      state.mainWindow.webContents.send('connections-update', {
        connections: connections,
        downloadTotal: data.downloadTotal || 0,
        uploadTotal: data.uploadTotal || 0,
        currentNode: state.currentNode,
        activeConnections: activeConnections
      });
      
      console.log(`[调试] 通过IPC发送连接更新，总连接数: ${connections.length}, 活跃连接: ${activeConnections}`);
    }
  });

  // 处理节点变更
  ipcMain.on('node-changed', (event, data) => {
    if (state.mainWindow) {
      console.log('[调试] 处理节点变更事件:', data);
      // 更新当前节点
      if (data && data.nodeName) {
        state.currentNode = data.nodeName;
      }
      
      state.mainWindow.webContents.send('node-changed', {
        nodeName: data && data.nodeName ? data.nodeName : (state.currentNode || '无')
      });
      
      // 同时更新连接信息
      const connections = state.lastConnectionsInfo.connections || [];
      const activeConnections = connections.filter(conn => conn.isActive !== false).length;
      
      const connectionInfo = {
        ...state.lastConnectionsInfo,
        currentNode: state.currentNode,
        activeConnections: activeConnections
      };
      
      console.log(`[调试] 节点变更后发送连接更新，总连接数: ${connections.length}, 活跃连接: ${activeConnections}`);
      state.mainWindow.webContents.send('connections-update', connectionInfo);
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

  // 获取开机启动状态
  ipcMain.handle('get-auto-launch-state', () => {
    return getAutoLaunchState();
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
        const portValue = Number(settings['mixed-port']);
        if (!Number.isInteger(portValue)) {
          console.error('端口字段不是有效的整数:', settings['mixed-port']);
          return {
            success: false,
            error: '端口号必须是数字'
          };
        }

        if (portValue < 1 || portValue > 65535) {
          console.error('端口号超出范围:', settings['mixed-port']);
          return {
            success: false,
            error: '端口号无效，必须是1-65535之间的数字'
          };
        }

        settings['mixed-port'] = portValue;
      }

      if ('allow-lan' in settings) {
        settings['allow-lan'] = Boolean(settings['allow-lan']);
      }

      if ('ipv6' in settings) {
        settings['ipv6'] = Boolean(settings['ipv6']);
      }
      
      // 更新设置
      console.log('验证通过，正在更新用户设置');
      const success = updateUserSettings(settings);

      if (success) {
        try {
          updateSystemProxyIfEnabled();
        } catch (proxyError) {
          console.error('更新系统代理设置失败:', proxyError);
        }
      }
      
      // 获取当前配置路径
      const currentConfig = state.configFilePath;
      
      // 如果Mihomo正在运行，进行完全重启
      if (success && state.mihomoProcess && state.mihomoProcess.pid && currentConfig) {
        console.log('Mihomo正在运行，将重启服务应用新设置');
        try {
          // 停止现有进程
          if (state.mihomoProcess) {
            state.mihomoProcess.kill();
            stopTrafficStatsUpdate();
            stopConnectionsWebSocket();
            stopMihomoLogs();
            // 等待进程完全终止
            setTimeout(async () => {
              state.mihomoProcess = null;
              // 重启Mihomo
              const restarted = await startMihomo(currentConfig);
              console.log('重启结果:', restarted);
              
              if (restarted) {
                // 通知前端重启成功
                if (state.mainWindow) {
                  state.mainWindow.webContents.send('service-restarted', { success: true });
                }
                console.log('服务已重启并应用新设置');
              } else {
                // 通知前端重启失败
                if (state.mainWindow) {
                  state.mainWindow.webContents.send('service-restarted', { 
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
  ipcMain.handle('start-mihomo', (_, configPath) => startMihomo(configPath));
  ipcMain.handle('stop-mihomo', stopMihomo);
  ipcMain.handle('restart-service', restartMihomoService);
  ipcMain.handle('open-tools-app', (_, toolName) => openToolsApp(toolName));

  // 新增: 切换TUN模式
  ipcMain.handle('toggleTunMode', async (event, token, enabled) => {
    try {
      if (!verifyAuthToken(token)) {
        security?.logSecurityEvent?.('invalid-token', { action: 'toggleTunMode' });
        return { success: false, error: '安全校验失败，请重试' };
      }

      const menuItem = { checked: Boolean(enabled) };
      toggleTunMode(menuItem);

      return state.tunModeEnabled;
    } catch (error) {
      console.error('切换TUN模式失败:', error);
      return { success: false, error: error?.message || String(error) };
    }
  });

  // 新增: 获取TUN模式状态
  ipcMain.handle('getTunStatus', async () => {
    return state.tunModeEnabled;
  });
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
  stopConnectionsWebSocket(); // 停止连接管理
  stopMihomoLogs(); // 停止日志
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  state.isQuitting = true;
  if (state.mihomoProcess) {
    state.mihomoProcess.kill();
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

async function switchNode(nodeName) {
  try {
    if (!state.activeApiConfig) {
      console.error('无法切换节点: API配置不可用');
      return;
    }

    // Socket 模式: 使用 fetchMihomoAPI
    const response = await fetchMihomoAPI('/proxies/PROXY', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name: nodeName })
    });

    if (!response.ok) {
      throw new Error(`切换节点请求失败: ${response.status}`);
    }
    
    // 更新当前节点
    state.currentNode = nodeName;
    
    // 关闭现有连接并重新建立
    if (state.connectionsWebSocket) {
      state.connectionsWebSocket.close();
      state.connectionsWebSocket = null;
    }
    
    // 重新建立连接 (可选)
    if (false) { // 暂时不启用，以避免额外复杂性
      await startConnectionsWebSocket();
    }
    
    // 更新UI
    if (state.mainWindow) {
      state.mainWindow.webContents.send('node-switched', { node: nodeName });
    }
    
    // 更新托盘提示和菜单
    if (context.trayManager) {
      context.trayManager.updateTrayMenu();
    }
    
    console.log(`已切换到节点: ${nodeName}`);
    
    // 刷新连接信息
    fetchConnectionsInfo();
  } catch (error) {
    console.error('切换节点失败:', error);
    // 通知前端切换失败
    if (state.mainWindow) {
      state.mainWindow.webContents.send('node-switch-error', { 
        error: error.message,
        node: nodeName 
      });
    }
  }
}

// 获取总连接信息和总流量
async function fetchConnectionsInfo() {
  try {
    if (!state.activeApiConfig) {
      console.error('[调试] 无法获取连接信息: API配置不可用');
      return;
    }

    // Socket 模式: 使用 fetchMihomoAPI
    try {
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
    state.lastConnectionsInfo = {
      ...data,
      currentNode: state.currentNode,
      activeConnections: activeConnections
    };
        
        // 发送到主窗口
        if (state.mainWindow && !state.mainWindow.isDestroyed()) {
          state.mainWindow.webContents.send('connections-update', state.lastConnectionsInfo);
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
    return state.mainWindow.loadURL(pageUrl);
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

// 深度合并配置
function deepMergeConfig(target, source) {
  return context.mihomoService.deepMergeConfig(target, source);
}

// 确保关键配置字段存在且有效
function validateMergedConfig(config) {
  return context.mihomoService.validateMergedConfig(config);
}

// 配置热重载功能
function reloadMihomoConfig(configPath) {
  return context.mihomoService.reloadMihomoConfig(configPath);
}

// 发送重载配置请求
function sendReloadRequest(configPath, port) {
  return context.mihomoService.sendReloadRequest(configPath, port);
}

// 重新生成合并配置并热重载
function regenerateAndReloadConfig() {
  console.log('[main.js] regenerateAndReloadConfig被调用');
  return context.mihomoService.regenerateAndReloadConfig();
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

// 添加新的IPC处理程序 - 获取API配置信息
// Socket 模式下不需要返回 host/port/secret
ipcMain.handle('get-api-config', (event) => {
  try {
    return {
      success: true,
      socketPath: state.activeApiConfig.socketPath,
      // 保留这些字段以兼容旧代码,但设为 null
      controllerHost: null,
      controllerPort: null,
      secret: ''  // socket 模式不需要密钥
    };
  } catch (error) {
    console.error('获取API配置信息失败:', error);
    return {
      success: false,
      error: '获取API配置信息失败: ' + error.message
    };
  }
});

// 添加新的IPC处理程序 - 通过 Socket 发送 Mihomo API 请求
// 前端无法直接访问 Unix Socket / Named Pipe,必须通过 main process
ipcMain.handle('request-mihomo-api', async (event, endpoint, options = {}) => {
  try {
    console.log(`[Socket] IPC handler - 收到API请求: ${endpoint}`);

    // 调用 fetchMihomoAPI 函数
    const response = await fetchMihomoAPI(endpoint, options);

    console.log(`[Socket] IPC handler - API请求成功`);

    // 解析响应数据
    let data = null;
    try {
      data = await response.json();
    } catch (e) {
      try {
        data = await response.text();
      } catch (e2) {
        data = null;
      }
    }

    // 返回可序列化的对象
    return {
      ok: response.ok,
      status: response.status,
      data: data
    };
  } catch (error) {
    console.error(`[Socket] IPC handler - API请求失败:`, error);

    // 返回可序列化的错误响应
    return {
      ok: false,
      status: 500,
      data: { error: error.message || '请求失败' }
    };
  }
});

// 添加清理函数，用于关闭所有WebSocket连接
function cleanupWebSockets() {
  console.log('[调试] 清理所有WebSocket连接');
  if (state.trafficWebSocket) {
    state.trafficWebSocket.close();
    state.trafficWebSocket = null;
  }
  if (state.connectionsWebSocket) {
    state.connectionsWebSocket.close();
    state.connectionsWebSocket = null;
  }
  if (state.logsWebSocket) {
    state.logsWebSocket.close();
    state.logsWebSocket = null;
  }

  // 清理相关资源
  if (state.trafficStatsInterval) {
    clearInterval(state.trafficStatsInterval);
    state.trafficStatsInterval = null;
  }
  
  state.trafficRetry = 10;
  state.connectionsRetry = 10;
}

// 在应用退出前调用清理函数
app.on('will-quit', () => {
  console.log('[调试] 应用即将退出，正在清理资源');
  cleanupWebSockets();
  if (state.memoryMonitorInterval) {
    clearInterval(state.memoryMonitorInterval);
    state.memoryMonitorInterval = null;
  }

  // 停止订阅调度器
  if (subscriptionScheduler) {
    subscriptionScheduler.stop();
  }

  // 关闭数据库连接
  if (dbManager) {
    dbManager.close();
  }
});

// 定期监控和管理内存
function startMemoryMonitor() {
  if (state.memoryMonitorInterval) clearInterval(state.memoryMonitorInterval);
  
  state.memoryMonitorInterval = setInterval(() => {
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
          if (state.mainWindow && !state.mainWindow.isDestroyed()) {
            if (state.mainWindow.isMinimized()) state.mainWindow.restore();
            state.mainWindow.show();
            state.mainWindow.focus();
            
            // 导航到订阅页面
            console.log('向渲染进程发送导入事件');
            state.mainWindow.webContents.send('import-subscription', subscriptionUrl);
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
  if (state.mainWindow) {
    if (state.mainWindow.isMinimized()) state.mainWindow.restore();
    state.mainWindow.show();
    state.mainWindow.focus();
  }
});
