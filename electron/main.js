const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell, nativeTheme, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
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

// 新的 helper 服务是独立的 Go 程序，不再需要 service-worker 模式
{

// 导入媒体检测模块
const { testMediaStreaming } = require('./mediatest');

// 导入图标提取模块
const { getIconDataURL } = require('./icon');

// 从 package.json 读取版本号
const packageJson = require('../package.json');
const APP_VERSION = packageJson.version;

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
  console.log('[Startup] Detected unmigrated data, starting auto migration...');
  migrationManager.migrate().then(result => {
    if (result.success) {
      console.log('[Startup] Data migration succeeded');
    } else {
      console.error('[Startup] Data migration failed:', result.error);
    }
  });
} else {
  console.log('[Startup] Data already migrated, skipping migration step');
}

// 性能优化和字体渲染: 启用GPU加速、DirectWrite和Emoji支持
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('disable-gpu-driver-bug-workarounds');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
if (process.platform === 'win32') {
  app.commandLine.appendSwitch('enable-features', 'DirectWriteFontCache,PlatformHEVCDecoderSupport');
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
  app.commandLine.appendSwitch('enable-color-emoji');
  app.commandLine.appendSwitch('disable-features', 'FontCacheScaling');
} else if (process.platform === 'darwin') {
  app.commandLine.appendSwitch('enable-features', 'CoreTextFontCache');
}
app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling');

// =====================================================================
// Module imports (Phase 1+2+3 extracted modules)
// =====================================================================

// 自动更新检查
const { createAutoUpdater } = require('./updater/auto-updater');
const autoUpdater = createAutoUpdater({ app, state, dbManager, APP_VERSION });
const { scheduleStartupUpdateCheck } = autoUpdater;

// 安全令牌
const { ensureAuthToken, verifyAuthToken } = require('./security/auth-token');

// Mihomo API 客户端
const { createMihomoApiClient } = require('./utils/mihomo-api');
const mihomoApiClient = createMihomoApiClient({ state });
const { getAxiosInstance, fetchMihomoAPI } = mihomoApiClient;

context.set('getAxiosInstance', getAxiosInstance);
context.set('fetchMihomoAPI', fetchMihomoAPI);
context.set('ensureAuthToken', ensureAuthToken);
context.set('verifyAuthToken', verifyAuthToken);

// 内核路径管理
const { createKernelPathManager } = require('./utils/kernel-path');
const kernelPathManager = createKernelPathManager({ app, context, userDataPath });
const {
  kernelPreferenceFile,
  resolveDefaultKernelPath,
  loadKernelPreference,
  saveKernelPreference,
  clearKernelPreference,
  getKernelExecutablePath,
} = kernelPathManager;

context.set('kernelPreferenceFile', kernelPreferenceFile);
context.resolveDefaultKernelPath = resolveDefaultKernelPath;
context.loadKernelPreference = loadKernelPreference;
context.saveKernelPreference = saveKernelPreference;
context.clearKernelPreference = clearKernelPreference;
context.getKernelExecutablePath = getKernelExecutablePath;
context.kernelPreference = loadKernelPreference();

// 格式化函数
const { formatTraffic, formatSpeed } = require('./utils/formatters');
context.formatTraffic = formatTraffic;

// =====================================================================
// Main-process modules (context-based)
// =====================================================================

require('./main-process/user-settings')(context);
require('./main-process/core-manager')(context);
require('./main-process/mihomo-service')(context);
require('./main-process/service-manager')(context);
require('./main-process/tun-manager')(context);
require('./main-process/system-integration')(context);
require('./main-process/tray-manager')(context);
require('./main-process/lightweight-mode-manager')(context);
require('./ipc-handlers/subscriptions')(context);
require('./ipc-handlers/providers')(context);

// 注册覆写处理器
const { registerOverrideHandlers } = require('./ipc-handlers/overrides');
registerOverrideHandlers(context);

// 注册流量历史处理器
const { registerTrafficHistoryHandlers } = require('./ipc-handlers/traffic-history');
registerTrafficHistoryHandlers(context);

// 注册备份处理器
const registerBackupHandlers = require('./ipc-handlers/backup');
registerBackupHandlers(context);

// 注册代理图标处理器
const { registerProxyIconHandlers } = require('./ipc-handlers/proxy-icon');
registerProxyIconHandlers();

// 注册配置图标处理器
const { registerConfigIconHandlers } = require('./ipc-handlers/config-icon');
registerConfigIconHandlers(app);

// 注册订阅转换器处理器
const { registerConverterHandlers } = require('./ipc-handlers/converter');
registerConverterHandlers(app, dbManager);

// 注册 UWP 回环豁免管理处理器
const { registerLoopbackIpcHandlers } = require('./ipc-handlers/loopback-ipc');
registerLoopbackIpcHandlers();

// =====================================================================
// Extracted context functions
// =====================================================================

const {
  ensureUserSettingsFile,
  getUserSettings,
  updateUserSettingsRaw
} = context;

// 窗口背景效果管理
const { createBackdropManager } = require('./window/backdrop');
const backdropManager = createBackdropManager({ state, dbManager, enableAcrylic, isWindows, isMac });
const {
  applyMacOSBackdrop,
  applyWindowsBackdrop,
  forceWindowsBackdropRepaint,
  refreshWindowsBackdrop,
  applyCustomBackground,
} = backdropManager;

function updateUserSettings(settings) {
  try {
    const success = updateUserSettingsRaw(settings);
    return success;
  } catch (error) {
    console.error('[updateUserSettings] Error updating user settings:', error);
    return false;
  }
}

context.updateUserSettings = updateUserSettings;
const {
  toggleSystemProxy,
  enableSystemProxy,
  disableSystemProxy,
  updateSystemProxyIfEnabled,
  toggleTunMode
} = context.systemIntegration;

// 确保配置目录存在
if (!fs.existsSync(configDir)) {
  fs.mkdirSync(configDir, { recursive: true });
}

// 流量统计相关变量
const MAX_TRAFFIC_HISTORY = 50;

// =====================================================================
// Mihomo delegate functions
// =====================================================================

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

async function autoStartMihomo() {
  console.log('[main.js] autoStartMihomo called');
  return context.mihomoService.autoStartMihomo();
}

async function ensureMihomoDataFiles() {
  return context.mihomoService.ensureMihomoDataFiles();
}

function getSubscriptionList() {
  return context.mihomoService.getSubscriptionList();
}

function parseConfigFile(filePath) {
  return context.mihomoService.parseConfigFile(filePath);
}

async function getConfig() {
  return context.mihomoService.getConfig();
}

function deepMergeConfig(target, source) {
  return context.mihomoService.deepMergeConfig(target, source);
}

function validateMergedConfig(config) {
  return context.mihomoService.validateMergedConfig(config);
}

function reloadMihomoConfig(configPath) {
  return context.mihomoService.reloadMihomoConfig(configPath);
}

function sendReloadRequest(configPath, port) {
  return context.mihomoService.sendReloadRequest(configPath, port);
}

function regenerateAndReloadConfig() {
  console.log('[main.js] regenerateAndReloadConfig called');
  return context.mihomoService.regenerateAndReloadConfig();
}

async function checkMihomoService() {
  return context.mihomoService.checkMihomoService();
}

// =====================================================================
// WebSocket managers
// =====================================================================

// 获取总连接信息和总流量
async function fetchConnectionsInfo() {
  try {
    if (!state.activeApiConfig) {
      console.error('[Debug] Cannot get connection info: API config unavailable');
      return;
    }

    try {
      const response = await fetchMihomoAPI('/connections');
      if (response.ok) {
        const data = await response.json();

        const activeConnections = data.connections ?
          data.connections.filter(conn => conn.isActive !== false).length : 0;

        state.lastConnectionsInfo = {
          ...data,
          currentNode: state.currentNode,
          activeConnections: activeConnections
        };

        if (state.mainWindow && !state.mainWindow.isDestroyed()) {
          state.mainWindow.webContents.send('connections-update', state.lastConnectionsInfo);
        }
      } else {
        console.error(`[Debug] Connection info request failed: status ${response.status}`);
      }
    } catch (fetchError) {
      console.error('[Debug] Fetch operation failed:', fetchError);
    }
  } catch (error) {
    console.error('[Debug] Failed to get connection info:', error);
  }
}

// 流量统计 WebSocket
const { createTrafficWsManager } = require('./websocket/traffic-ws');
const trafficWs = createTrafficWsManager({
  state,
  context,
  WebSocket,
  formatTraffic,
  fetchConnectionsInfo,
  MAX_TRAFFIC_HISTORY,
});
const { updateTrafficStats, startTrafficStatsUpdate, stopTrafficStatsUpdate } = trafficWs;

context.startTrafficStatsUpdate = startTrafficStatsUpdate;
context.stopTrafficStatsUpdate = stopTrafficStatsUpdate;

// 日志 WebSocket
const { createLogsWsManager } = require('./websocket/logs-ws');
const logsWs = createLogsWsManager({ state, WebSocket });
const { startMihomoLogs, stopMihomoLogs } = logsWs;

context.startMihomoLogs = startMihomoLogs;
context.stopMihomoLogs = stopMihomoLogs;

// 立即注册基础IPC，避免渲染进程早期调用时报"handler 未注册"
ipcMain.handle('get-traffic-stats', () => state.lastTrafficStats);
ipcMain.handle('get-auth-token', () => {
  try {
    const { token, expiry } = ensureAuthToken();
    return { success: true, token, expiry };
  } catch (error) {
    console.error('Failed to generate auth token:', error);
    return { success: false, error: error?.message || String(error) };
  }
});

// 连接管理 WebSocket
const { createConnectionsWsManager } = require('./websocket/connections-ws');
const connectionsWs = createConnectionsWsManager({ state });
const { startConnectionsWebSocket, stopConnectionsWebSocket, updateCurrentNodeInfo } = connectionsWs;

context.startConnectionsWebSocket = startConnectionsWebSocket;
context.stopConnectionsWebSocket = stopConnectionsWebSocket;
context.updateCurrentNodeInfo = updateCurrentNodeInfo;

// Mihomo进程意外停止时的处理函数
function handleMihomoProcessExit(code) {
  console.log(`Mihomo process exited, code: ${code}`);
  state.mihomoProcess = null;
  stopTrafficStatsUpdate();
  stopConnectionsWebSocket();
  stopMihomoLogs();
  state.configFilePath = null;

  if (state.mainWindow && !state.mainWindow.isDestroyed()) {
    state.mainWindow.webContents.send('mihomo-stopped', code);
  }
}

context.handleMihomoProcessExit = handleMihomoProcessExit;
context.checkMihomoService = checkMihomoService;

// =====================================================================
// IPC handler modules (Phase 1+2 extracted)
// =====================================================================

// 窗口控制 IPC
const { registerWindowControlHandlers } = require('./ipc-handlers/window-control');
registerWindowControlHandlers({ state });

// 文件操作 IPC
const { registerFileOpsHandlers } = require('./ipc-handlers/file-ops');
registerFileOpsHandlers({ verifyAuthToken });

// 内核路径 IPC
const { registerKernelPathHandlers } = require('./ipc-handlers/kernel-path-ipc');
registerKernelPathHandlers({
  state,
  context,
  isWindows,
  loadKernelPreference,
  resolveDefaultKernelPath,
  saveKernelPreference,
  clearKernelPreference,
});

// 内核管理 IPC
const { registerCoreManagerIpcHandlers } = require('./ipc-handlers/core-manager-ipc');
registerCoreManagerIpcHandlers({ state, context, dbManager });

// 开机启动
const { setAutoLaunch, getAutoLaunchState } = require('./ipc-handlers/auto-launch');

// 测速功能
const { registerSpeedtestHandlers } = require('./ipc-handlers/speedtest');
registerSpeedtestHandlers({ isDev });

// =====================================================================
// Static server (production mode)
// =====================================================================

const { createStaticServer } = require('./window/static-server');
const staticServer = createStaticServer({ state });
const { loadPageWithServer } = staticServer;

// =====================================================================
// Window manager
// =====================================================================

const { createWindowManager } = require('./window/window-manager');
const windowManager = createWindowManager({
  state,
  context,
  dbManager,
  configDir,
  isWindows,
  isMac,
  isDev,
  enableAcrylic,
  applyMacOSBackdrop,
  refreshWindowsBackdrop,
  applyCustomBackground,
  autoStartMihomo,
  scheduleStartupUpdateCheck,
  stopTrafficStatsUpdate,
  startTrafficStatsUpdate,
  updateTrafficStats,
  loadPageWithServer,
});
const { createWindow } = windowManager;

// Windows 权限初始化 - 延迟到 app.whenReady() 后执行
if (process.platform === 'win32') {
  context.needsPermissionInit = true;
}

// =====================================================================
// App ready
// =====================================================================

app.whenReady().then(async () => {
  // 初始化逻辑
  const { initializeApp } = require('./startup/app-initializer');
  await initializeApp({
    context,
    state,
    dbManager,
    userDataPath,
    createWindow,
    handleProtocolUrl,
    getTunModeEnabled: context.getTunModeEnabled,
    ensureUserSettingsFile,
    ensureMihomoDataFiles,
    subscriptionScheduler,
  });

  // =====================================================================
  // Phase 3 extracted IPC handler modules
  // =====================================================================

  // 设置相关 IPC (主题、静默启动、通用设置等)
  const { registerSettingsIpcHandlers } = require('./ipc-handlers/settings-ipc');
  registerSettingsIpcHandlers({
    state,
    dbManager,
    security,
    verifyAuthToken,
    updateUserSettingsRaw,
    getUserSettings,
    APP_VERSION,
    app,
    shell,
  });

  // 外观相关 IPC (外观模式、自定义背景、主题色)
  const { registerAppearanceIpcHandlers } = require('./ipc-handlers/appearance-ipc');
  registerAppearanceIpcHandlers({
    state,
    dbManager,
    isWindows,
    isMac,
    applyMacOSBackdrop,
    applyWindowsBackdrop,
    refreshWindowsBackdrop,
    applyCustomBackground,
  });

  // 代理节点相关 IPC
  const { registerProxyNodeIpcHandlers } = require('./ipc-handlers/proxy-node-ipc');
  registerProxyNodeIpcHandlers({
    state,
    context,
    fetchMihomoAPI,
    checkMihomoService,
    parseConfigFile,
    userDataPath,
  });

  // 内核/DNS/Sniffer 配置 IPC
  const { registerConfigIpcHandlers } = require('./ipc-handlers/config-ipc');
  registerConfigIpcHandlers({
    context,
    userDataPath,
  });

  // 杂项 IPC (收藏节点、折叠组、日志、连接管理等)
  const { registerMiscIpcHandlers } = require('./ipc-handlers/misc-ipc');
  registerMiscIpcHandlers({
    state,
    context,
    dbManager,
    security,
    verifyAuthToken,
    userDataPath,
    isDev,
    fetchMihomoAPI,
    toggleSystemProxy,
    updateSystemProxyIfEnabled,
    updateUserSettings,
    startMihomo,
    stopMihomo,
    restartMihomoService,
    reloadMihomoConfig,
    startTrafficStatsUpdate,
    stopTrafficStatsUpdate,
    stopConnectionsWebSocket,
    stopMihomoLogs,
    fetchConnectionsInfo,
    getIconDataURL,
    testMediaStreaming,
    setAutoLaunch,
    getAutoLaunchState,
    shell,
    app,
  });

  // TUN 服务相关 IPC 处理器
  const { registerTunServiceHandlers } = require('./ipc-handlers/tun-service');
  registerTunServiceHandlers({
    context,
    state,
    dbManager,
    security,
    verifyAuthToken,
    toggleTunMode,
    isWindows,
    isMac,
    isDev,
  });
});

// =====================================================================
// WebSocket cleanup (used by lifecycle module)
// =====================================================================

function cleanupWebSockets() {
  console.log('[Debug] Cleaning up all WebSocket connections');
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
  if (state.trafficStatsInterval) {
    clearInterval(state.trafficStatsInterval);
    state.trafficStatsInterval = null;
  }
  state.trafficRetry = 10;
  state.connectionsRetry = 10;
}

// =====================================================================
// App lifecycle (window-all-closed, before-quit, will-quit)
// =====================================================================

const { registerAppLifecycle } = require('./lifecycle/app-lifecycle');
registerAppLifecycle({
  app,
  state,
  dbManager,
  subscriptionScheduler,
  stopConnectionsWebSocket,
  stopMihomoLogs,
  cleanupWebSockets,
});

// =====================================================================
// Memory monitor
// =====================================================================

const { createMemoryMonitor } = require('./monitoring/memory-monitor');
const memoryMonitor = createMemoryMonitor({ state, formatTraffic });
app.on('ready', () => {
  memoryMonitor.startMemoryMonitor();
});

// =====================================================================
// Protocol URL handler
// =====================================================================

const { createProtocolHandler } = require('./protocol/protocol-handler');
const protocolHandler = createProtocolHandler({ state, app });
const { handleProtocolUrl } = protocolHandler;
protocolHandler.registerProtocolEvents();

} // end of !isServiceWorkerMode
