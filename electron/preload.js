const { contextBridge, ipcRenderer } = require('electron');

// 导航函数不再需要处理DOM事件，直接在NavMenu组件中处理
// 删除旧的handleNavigation函数

// 增强安全 - 令牌管理
let securityToken = null;
let tokenExpiry = 0;

// 获取新的安全令牌
async function getSecurityToken() {
  try {
    // 检查当前令牌是否有效
    if (securityToken && tokenExpiry > Date.now()) {
      return { success: true, token: securityToken };
    }
    
    // 获取新令牌
    const result = await ipcRenderer.invoke('get-auth-token');
    
    if (result && result.success && result.token) {
      securityToken = result.token;
      tokenExpiry = result.expiry || (Date.now() + 5 * 60 * 1000); // 默认5分钟
      return { success: true, token: securityToken };
    }
    
    console.error('无法获取安全令牌:', result.error || '未知错误');
    return { success: false, error: result.error || '无法获取安全令牌' };
  } catch (error) {
    console.error('令牌获取异常:', error);
    return { success: false, error: `令牌获取异常: ${error.message}` };
  }
}

contextBridge.exposeInMainWorld('electronAPI', {
  // 不直接暴露令牌获取方法
  getAuthToken: null,

  // 导航相关 - 新的页面加载方法
  loadPage: (pageName) => ipcRenderer.invoke('loadPage', pageName),

  // 版本号
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),

  // 平台信息
  getPlatform: () => Promise.resolve(process.platform),
  
  // Mihomo 管理
  startMihomo: (configPath) => ipcRenderer.invoke('start-mihomo', configPath),
  stopMihomo: () => ipcRenderer.invoke('stop-mihomo'),
  reloadMihomoConfig: (configPath) => ipcRenderer.invoke('reload-mihomo-config', configPath),
  getTrafficStats: () => ipcRenderer.invoke('get-traffic-stats'),
  fetchConnectionsInfo: () => ipcRenderer.invoke('fetch-connections-info'),
  // 重启Mihomo服务（用于端口更改后）
  restartService: () => ipcRenderer.invoke('restart-service'),

  // 轻量模式
  enterLightweightMode: () => ipcRenderer.invoke('enter-lightweight-mode'),
  // 获取API配置信息
  getApiConfig: () => ipcRenderer.invoke('get-api-config'),
  
  // 用户代理设置相关API
  getProxySettings: () => ipcRenderer.invoke('get-proxy-settings'),
  saveProxySettings: (settings) => ipcRenderer.invoke('save-proxy-settings', settings),
  saveUASettings: (ua) => ipcRenderer.invoke('save-ua-settings', ua),
  getKernelPath: () => ipcRenderer.invoke('get-kernel-path'),
  selectKernelExecutable: () => ipcRenderer.invoke('select-kernel-executable'),
  resetKernelPath: () => ipcRenderer.invoke('reset-kernel-path'),
  
  // 添加主题设置相关方法
  setTheme: (theme) => ipcRenderer.invoke('set-theme', theme),
  getTheme: () => ipcRenderer.invoke('get-theme'),
  setAppearanceMode: (mode) => ipcRenderer.invoke('set-appearance-mode', mode),
  getAppearanceMode: () => ipcRenderer.invoke('get-appearance-mode'),
  supportsAdvancedBackdrop: () => ipcRenderer.invoke('supports-advanced-backdrop'),

  // 自定义背景设置
  selectBackgroundImage: () => ipcRenderer.invoke('select-background-image'),
  setCustomBackground: (config) => ipcRenderer.invoke('set-custom-background', config),
  getCustomBackground: () => ipcRenderer.invoke('get-custom-background'),
  clearCustomBackground: () => ipcRenderer.invoke('clear-custom-background'),
  onCustomBackgroundApply: (callback) => {
    const handler = (_, config) => callback(config);
    ipcRenderer.on('apply-custom-background', handler);
    return () => ipcRenderer.removeListener('apply-custom-background', handler);
  },
  onClearCustomBackground: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('clear-custom-background', handler);
    return () => ipcRenderer.removeListener('clear-custom-background', handler);
  },

  // 主题色设置
  setThemeColor: (color) => ipcRenderer.invoke('set-theme-color', color),
  getThemeColor: () => ipcRenderer.invoke('get-theme-color'),
  onThemeColorChanged: (callback) => {
    const handler = (_, color) => callback(color);
    ipcRenderer.on('theme-color-changed', handler);
    return () => ipcRenderer.removeListener('theme-color-changed', handler);
  },

  // 静默启动设置
  getSilentStart: () => ipcRenderer.invoke('get-silent-start'),
  setSilentStart: (enabled) => ipcRenderer.invoke('set-silent-start', enabled),

  // 轻量模式设置
  getLightweightModeSettings: () => ipcRenderer.invoke('get-lightweight-mode-settings'),
  setLightweightModeSettings: (settings) => ipcRenderer.invoke('set-lightweight-mode-settings', settings),

  // 通用设置处理器
  getSetting: (key, defaultValue) => ipcRenderer.invoke('get-setting', key, defaultValue),
  setSetting: (key, value) => ipcRenderer.invoke('set-setting', key, value),

  minimizeWindow: () => ipcRenderer.invoke('window-minimize'),
  maximizeWindow: () => ipcRenderer.invoke('window-toggle-maximize'),
  closeWindow: () => ipcRenderer.invoke('window-close'),
  getWindowState: () => ipcRenderer.invoke('window-get-state'),

  // 工具应用
  openToolsApp: (toolName) => ipcRenderer.invoke('open-tools-app', toolName),
  
  // 媒体服务检测
  testMediaStreaming: (serviceName, checkUrl) => ipcRenderer.invoke('test-media-streaming', serviceName, checkUrl),
  
  // Socket 模式: 通过 IPC 调用 main process 的 fetchMihomoAPI
  // 前端无法直接访问 Unix Socket / Named Pipe,必须通过 main process
  requestMihomoAPI: async (endpoint, options = {}) => {
    try {
      console.log(`[Socket] preload.js - 开始发送API请求: ${endpoint}`);

      // 直接通过 IPC 调用 main process 的 API 函数
      // main process 会返回 { ok, status, data } 格式的对象
      const response = await ipcRenderer.invoke('request-mihomo-api', endpoint, options);

      console.log(`[Socket] preload.js - 请求响应:`, response.ok ? '成功' : '失败');

      // 包装成兼容旧代码的格式
      return {
        ok: response.ok,
        status: response.status,
        statusText: response.ok ? 'OK' : 'Error',
        headers: {},
        data: response.data,
        // 兼容旧代码的 json() 和 text() 方法
        json: async () => response.data,
        text: async () => typeof response.data === 'string' ? response.data : JSON.stringify(response.data)
      };
    } catch (error) {
      console.error('[Socket] preload.js - Mihomo API请求失败:', error);
      throw error;
    }
  },
  
  // 测速工具
  runSpeedtest: () => ipcRenderer.invoke('run-speedtest'),
  // 直接运行speedtest并接收实时输出
  runSpeedtestDirect: () => ipcRenderer.invoke('run-speedtest-direct'),
  // 通过代理进行测速
  runProxySpeedtest: (options) => ipcRenderer.invoke('run-proxy-speedtest', options),
  // 测试UDP连通性
  testUdpConnectivity: (options) => ipcRenderer.invoke('test-udp-connectivity', options),
  // 接收speedtest实时输出
  onSpeedtestOutput: (callback) => {
    const handler = (_, data) => callback(data);
    ipcRenderer.on('speedtest-output', handler);
    return () => ipcRenderer.removeListener('speedtest-output', handler);
  },
  
  // 测速报告管理
  saveSpeedtestReport: (reportData) => ipcRenderer.invoke('save-speedtest-report', reportData),
  getSpeedtestReports: () => ipcRenderer.invoke('get-speedtest-reports'),
  getSpeedtestReport: (reportId) => ipcRenderer.invoke('get-speedtest-report', reportId),
  copySpeedtestReportToClipboard: (imageDataUrl) => ipcRenderer.invoke('copy-speedtest-report-to-clipboard', imageDataUrl),
  // 新增puppeteer相关API
  generateSpeedtestReportWithPuppeteer: (reportData) => ipcRenderer.invoke('generate-speedtest-report-with-puppeteer', reportData),
  copySpeedtestReportWithPuppeteer: (reportData) => ipcRenderer.invoke('copy-speedtest-report-with-puppeteer', reportData),
  openFileInDefaultApp: (filePath) => ipcRenderer.invoke('open-file-in-default-app', filePath),
  
  // 订阅管理
  saveSubscription: (subUrl, configData, customName, subscriptionInfo) => {
    console.log('preload.js - 传递订阅参数 - URL:', subUrl);
    console.log('preload.js - 传递订阅参数 - 自定义名称:', customName);
    if (subscriptionInfo) {
      console.log('preload.js - 传递订阅流量信息:', subscriptionInfo);
    }
    return ipcRenderer.invoke('save-subscription', subUrl, configData, customName, subscriptionInfo);
  },
  getSubscriptions: () => ipcRenderer.invoke('get-subscriptions'),
  deleteSubscription: (filePath) => ipcRenderer.invoke('delete-subscription', filePath),
  editSubscription: (params) => ipcRenderer.invoke('edit-subscription', params),
  getSubscriptionUrl: (filePath) => ipcRenderer.invoke('get-subscription-url', filePath),
  fetchSubscription: (subUrl) => ipcRenderer.invoke('fetch-subscription', subUrl),
  updateSubscription: (filePath, configData, subUrl, subscriptionInfo) => ipcRenderer.invoke('update-subscription', filePath, configData, subUrl, subscriptionInfo),
  refreshSubscription: (filePath) => ipcRenderer.invoke('refresh-subscription', filePath),
  saveSubscriptionOrder: (orderList) => ipcRenderer.invoke('save-subscription-order', orderList),

  // 订阅自动更新间隔设置
  setSubscriptionUpdateInterval: (filePath, intervalMinutes) => ipcRenderer.invoke('set-subscription-update-interval', filePath, intervalMinutes),
  getSubscriptionUpdateInterval: (filePath) => ipcRenderer.invoke('get-subscription-update-interval', filePath),

  // 添加订阅导入事件监听
  onImportSubscription: (callback) => {
    const handler = (_, url) => {
      console.log('preload.js - 收到导入订阅事件，URL:', url);
      callback(url);
    };
    ipcRenderer.on('import-subscription', handler);
    return () => ipcRenderer.removeListener('import-subscription', handler);
  },
  
  // 节点管理
  selectNode: (nodeName, groupName) => ipcRenderer.invoke('select-node', nodeName, groupName),
  selectGroupNode: (nodeName, groupName, updateGlobal = false) => ipcRenderer.invoke('select-node', nodeName, groupName, updateGlobal),
  getProxies: () => ipcRenderer.invoke('get-proxies'),
  testNodeDelay: (nodeName) => ipcRenderer.invoke('test-node-delay', nodeName),
  getActiveConfig: () => ipcRenderer.invoke('get-active-config'),
  setPreferredConfig: (configPath) => ipcRenderer.invoke('set-preferred-config', configPath),
  isMihomoRunning: () => ipcRenderer.invoke('is-mihomo-running'),
  getProxyNodes: (configPath) => ipcRenderer.invoke('get-proxy-nodes', configPath),
  getConfigOrder: () => ipcRenderer.invoke('get-config-order'),
  notifyNodeChanged: (nodeName) => ipcRenderer.invoke('notify-node-changed', nodeName),
  // 获取当前配置文件名称
  getCurrentConfigName: () => ipcRenderer.invoke('get-current-config-name'),
  
  // 系统代理管理 - 添加安全令牌
  toggleSystemProxy: async (enabled) => {
    try {
      const tokenResult = await getSecurityToken();
      if (!tokenResult.success) {
        console.error('切换系统代理失败: 无法获取安全令牌');
        return { success: false, error: tokenResult.error };
      }
      
      return await ipcRenderer.invoke('toggleSystemProxy', tokenResult.token, enabled);
    } catch (error) {
      console.error('切换系统代理异常:', error);
      return { success: false, error: `操作异常: ${error.message}` };
    }
  },
  getProxyStatus: () => ipcRenderer.invoke('getProxyStatus'),
  
  // TUN模式管理 - 使用新的令牌验证机制
  toggleTunMode: async (enabled) => {
    try {
      const tokenResult = await getSecurityToken();
      if (!tokenResult.success) {
        console.error('切换TUN模式失败: 无法获取安全令牌');
        return { success: false, error: tokenResult.error };
      }

      return await ipcRenderer.invoke('toggleTunMode', tokenResult.token, enabled);
    } catch (error) {
      console.error('切换TUN模式异常:', error);
      return { success: false, error: `操作异常: ${error.message}` };
    }
  },
  getTunStatus: () => ipcRenderer.invoke('getTunStatus'),

  checkElevateTask: () => ipcRenderer.invoke('check-elevate-task'),
  deleteElevateTask: () => ipcRenderer.invoke('delete-elevate-task'),
  grantTunPermissions: () => ipcRenderer.invoke('grant-tun-permissions'),
  checkCorePermission: () => ipcRenderer.invoke('check-core-permission'),
  revokeCorePermission: () => ipcRenderer.invoke('revoke-core-permission'),
  serviceIsRunning: () => ipcRenderer.invoke('service-is-running'),
  serviceInstall: () => ipcRenderer.invoke('service-install'),
  serviceUninstall: () => ipcRenderer.invoke('service-uninstall'),
  getTunConfig: () => ipcRenderer.invoke('get-tun-config'),
  saveTunConfig: (config) => ipcRenderer.invoke('save-tun-config', config),

  // TUN 权限提升模式（Windows）
  getTunElevationMode: () => ipcRenderer.invoke('get-tun-elevation-mode'),
  setTunElevationMode: (mode) => ipcRenderer.invoke('set-tun-elevation-mode', mode),
  getTunServiceStatus: () => ipcRenderer.invoke('get-tun-service-status'),
  installTunService: () => ipcRenderer.invoke('install-tun-service'),
  uninstallTunService: () => ipcRenderer.invoke('uninstall-tun-service'),
  startTunService: () => ipcRenderer.invoke('start-tun-service'),
  stopTunService: () => ipcRenderer.invoke('stop-tun-service'),
  
  // 自动启动设置
  setAutoStart: (enabled) => ipcRenderer.invoke('set-auto-start', enabled),
  getAutoStart: () => ipcRenderer.invoke('get-auto-start'),
  
  // 添加新的开机启动API接口
  setAutoLaunch: (enabled) => ipcRenderer.invoke('set-auto-launch', enabled),
  getAutoLaunchState: () => ipcRenderer.invoke('get-auto-launch-state'),
  
  // 系统操作 - 添加安全令牌
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  openFile: async (filePath) => {
    try {
      const tokenResult = await getSecurityToken();
      if (!tokenResult.success) {
        console.error('打开文件失败: 无法获取安全令牌');
        return { success: false, error: tokenResult.error };
      }
      
      return await ipcRenderer.invoke('open-file', tokenResult.token, filePath);
    } catch (error) {
      console.error('打开文件异常:', error);
      return { success: false, error: `操作异常: ${error.message}` };
    }
  },
  openFileLocation: async (filePath) => {
    try {
      const tokenResult = await getSecurityToken();
      if (!tokenResult.success) {
        console.error('打开文件位置失败: 无法获取安全令牌');
        return { success: false, error: tokenResult.error };
      }

      return await ipcRenderer.invoke('open-file-location', tokenResult.token, filePath);
    } catch (error) {
      console.error('打开文件位置异常:', error);
      return { success: false, error: `操作异常: ${error.message}` };
    }
  },
  
  // 日志管理
  saveLogs: (logEntries) => ipcRenderer.invoke('save-logs', logEntries),
  getLogs: () => ipcRenderer.invoke('get-logs'),
  
  // 节点收藏和组折叠管理
  getFavoriteNodes: () => ipcRenderer.invoke('get-favorite-nodes'),
  saveFavoriteNodes: (nodes) => ipcRenderer.invoke('save-favorite-nodes', nodes),
  saveCollapsedGroups: (groups) => ipcRenderer.invoke('save-collapsed-groups', groups),
  getCollapsedGroups: () => ipcRenderer.invoke('get-collapsed-groups'),
  
  // 事件监听
  onMihomoLog: (callback) => {
    const subscription = (event, ...args) => callback(...args);
    ipcRenderer.on('mihomo-log', subscription);
    return () => {
      ipcRenderer.removeListener('mihomo-log', subscription);
    };
  },
  onMihomoError: (callback) => {
    const subscription = (event, ...args) => callback(...args);
    ipcRenderer.on('mihomo-error', subscription);
    return () => {
      ipcRenderer.removeListener('mihomo-error', subscription);
    };
  },
  onMihomoStartFailed: (callback) => {
    const subscription = (event, ...args) => callback(...args);
    ipcRenderer.on('mihomo-start-failed', subscription);
    return () => {
      ipcRenderer.removeListener('mihomo-start-failed', subscription);
    };
  },
  onMihomoStopped: (callback) => {
    const subscription = (event, ...args) => callback(...args);
    ipcRenderer.on('mihomo-stopped', subscription);
    return () => {
      ipcRenderer.removeListener('mihomo-stopped', subscription);
    };
  },
  onProxyStatus: (callback) => {
    const subscription = (event, enabled) => callback(enabled);
    ipcRenderer.on('proxy-status', subscription);
    return () => {
      ipcRenderer.removeListener('proxy-status', subscription);
    };
  },
  onTunStatus: (callback) => {
    const subscription = (event, enabled) => callback(enabled);
    ipcRenderer.on('tun-status', subscription);
    return () => {
      ipcRenderer.removeListener('tun-status', subscription);
    };
  },
  onMihomoAutostart: (callback) => {
    const subscription = (event, ...args) => callback(...args);
    ipcRenderer.on('mihomo-autostart', subscription);
    return () => {
      ipcRenderer.removeListener('mihomo-autostart', subscription);
    };
  },
  onNodeChanged: (callback) => {
    const subscription = (event, ...args) => callback(...args);
    ipcRenderer.on('node-changed', subscription);
    return () => {
      ipcRenderer.removeListener('node-changed', subscription);
    };
  },
  onConnectionsUpdate: (callback) => {
    const subscription = (event, ...args) => callback(...args);
    ipcRenderer.on('connections-update', subscription);
    return () => {
      ipcRenderer.removeListener('connections-update', subscription);
    };
  },
  // 优化流量数据传输 - 添加限流功能
  onTrafficUpdate: (callback) => {
    let lastUpdateTime = 0;
    const throttleInterval = 1000; // 1秒限流
    
    const handler = (_, stats) => {
      const now = Date.now();
      if (now - lastUpdateTime >= throttleInterval) {
        callback(stats);
        lastUpdateTime = now;
      }
    };
    
    ipcRenderer.on('traffic-update', handler);
    return () => ipcRenderer.removeListener('traffic-update', handler);
  },
  
  // 添加主题变更事件监听器
  onThemeChanged: (callback) => {
    const handler = (event, theme) => callback(event, theme);
    ipcRenderer.on('theme-changed', handler);
    return () => ipcRenderer.removeListener('theme-changed', handler);
  },

  // 窗口状态变更事件监听器（最大化 / 全屏）
  onWindowStateChanged: (callback) => {
    const handler = (_event, state) => callback(state);
    ipcRenderer.on('window-state-changed', handler);
    return () => ipcRenderer.removeListener('window-state-changed', handler);
  },

  onAppearanceModeChanged: (callback) => {
    const handler = (_event, mode) => callback(mode);
    ipcRenderer.on('appearance-mode-changed', handler);
    return () => ipcRenderer.removeListener('appearance-mode-changed', handler);
  },
  
  // 添加服务重启事件监听器
  onServiceRestarted: (callback) => {
    const handler = (_, result) => callback(result);
    ipcRenderer.on('service-restarted', handler);
    return () => ipcRenderer.removeListener('service-restarted', handler);
  },
  
  // 添加测试所有节点事件监听器
  onTestAllNodes: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('test-all-nodes', handler);
    return () => ipcRenderer.removeListener('test-all-nodes', handler);
  },
  
  // 添加断开所有连接事件监听器
  onConnectionsClosed: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('connections-closed', handler);
    return () => ipcRenderer.removeListener('connections-closed', handler);
  },
  
  // 移除事件监听
  removeAllListeners: (prefix = '') => {
    if (prefix === 'dashboard') {
      // 仅移除Dashboard组件使用的事件
      ipcRenderer.removeAllListeners('mihomo-log');
      ipcRenderer.removeAllListeners('mihomo-error');
      ipcRenderer.removeAllListeners('mihomo-stopped');
      ipcRenderer.removeAllListeners('proxy-status');
      ipcRenderer.removeAllListeners('tun-status');
      ipcRenderer.removeAllListeners('mihomo-autostart');
      ipcRenderer.removeAllListeners('node-changed');
      // 添加流量相关监听器的移除
      ipcRenderer.removeAllListeners('traffic-update');
      ipcRenderer.removeAllListeners('connections-update');
    } else if (prefix === 'proxy-nodes') {
      // 仅移除ProxyNodes组件使用的事件
      ipcRenderer.removeAllListeners('node-changed');
    } else {
      // 移除所有事件
      ipcRenderer.removeAllListeners('mihomo-log');
      ipcRenderer.removeAllListeners('mihomo-error');
      ipcRenderer.removeAllListeners('mihomo-stopped');
      ipcRenderer.removeAllListeners('proxy-status'); 
      ipcRenderer.removeAllListeners('tun-status');
      ipcRenderer.removeAllListeners('mihomo-autostart');
      ipcRenderer.removeAllListeners('node-changed');
      ipcRenderer.removeAllListeners('theme-changed');
      ipcRenderer.removeAllListeners('traffic-update');
      ipcRenderer.removeAllListeners('connections-update');
      ipcRenderer.removeAllListeners('speedtest-output');
      ipcRenderer.removeAllListeners('service-restarted');
      ipcRenderer.removeAllListeners('test-all-nodes');
      ipcRenderer.removeAllListeners('connections-closed');
      ipcRenderer.removeAllListeners('import-subscription');
    }
  },
  // 移除主题监听器
  removeThemeListener: () => {
    ipcRenderer.removeAllListeners('theme-changed');
  },
  // 移除流量监听器
  removeTrafficListeners: () => {
    ipcRenderer.removeAllListeners('traffic-update');
    ipcRenderer.removeAllListeners('connections-update');
  },
  
  // 节点和代理组管理
  getProxies: () => ipcRenderer.invoke('get-proxies'),
  // 切换节点
  switchNode: (nodeName) => ipcRenderer.invoke('switch-node', nodeName),
  // 通过代理进行网络请求测试
  proxyFetch: (url, options) => ipcRenderer.invoke('proxy-fetch', url, options),
  // 获取配置顺序
  getConfigOrder: () => ipcRenderer.invoke('get-config-order'),
  
  // 添加获取代理配置的方法
  getProxyConfig: () => ipcRenderer.invoke('get-proxy-config'),
  
  // 添加通过HTTP代理发送请求的方法，支持指定节点
  fetchWithProxy: (options) => ipcRenderer.invoke('fetch-with-proxy', options),
  // 添加取消批量测速的API
  cancelBatchSpeedtest: () => ipcRenderer.invoke('cancel-batch-speedtest'),
  // 监听测速进度

  // Provider 资源管理
  getProxyProviders: () => ipcRenderer.invoke('get-proxy-providers'),
  updateProxyProvider: (providerName) => ipcRenderer.invoke('update-proxy-provider', providerName),
  getRuleProviders: () => ipcRenderer.invoke('get-rule-providers'),
  updateRuleProvider: (providerName) => ipcRenderer.invoke('update-rule-provider', providerName),
  getRuntimeConfig: () => ipcRenderer.invoke('get-runtime-config'),

  // 覆写管理
  getOverrides: () => ipcRenderer.invoke('override:getItems'),
  addOverride: (item) => ipcRenderer.invoke('override:addItem', item),
  updateOverride: (id, updates) => ipcRenderer.invoke('override:updateItem', id, updates),
  deleteOverride: (id) => ipcRenderer.invoke('override:deleteItem', id),
  getOverrideFileContent: (id) => ipcRenderer.invoke('override:getFileContent', id),
  updateOverrideFileContent: (id, content) => ipcRenderer.invoke('override:updateFileContent', id, content),
  updateRemoteOverride: (id) => ipcRenderer.invoke('override:updateRemoteItem', id),
  reorderOverrides: (itemIds) => ipcRenderer.invoke('override:reorderItems', itemIds),
  getSubscriptionOverrides: (filePath) => ipcRenderer.invoke('get-subscription-overrides', filePath),
  setSubscriptionOverrides: (filePath, overrides) => ipcRenderer.invoke('set-subscription-overrides', filePath, overrides),

  // 日志监听
  onMihomoLogs: (callback) => {
    const listener = (event, log) => callback(log);
    ipcRenderer.on('mihomo-logs', listener);
    return () => ipcRenderer.removeListener('mihomo-logs', listener);
  },
  offMihomoLogs: () => ipcRenderer.removeAllListeners('mihomo-logs'),

  // 进程图标获取
  getIconDataURL: (processPath) => ipcRenderer.invoke('get-icon-dataurl', processPath),

  // 内核配置
  getKernelConfig: () => ipcRenderer.invoke('get-kernel-config'),
  saveKernelConfig: (config) => ipcRenderer.invoke('save-kernel-config', config),

  // DNS 配置
  getDnsConfig: () => ipcRenderer.invoke('get-dns-config'),
  saveDnsConfig: (config) => ipcRenderer.invoke('save-dns-config', config),

  // Hosts 配置
  saveHostsConfig: (hosts) => ipcRenderer.invoke('save-hosts-config', hosts),

  // Sniffer 配置
  getSnifferConfig: () => ipcRenderer.invoke('get-sniffer-config'),
  saveSnifferConfig: (config) => ipcRenderer.invoke('save-sniffer-config', config),

  // 流量历史
  getTrafficToday: () => ipcRenderer.invoke('traffic-history:get-today'),
  getTrafficMonth: (yearMonth) => ipcRenderer.invoke('traffic-history:get-month', yearMonth),
  getTrafficYear: (year) => ipcRenderer.invoke('traffic-history:get-year', year),
  getTrafficByDate: (date) => ipcRenderer.invoke('traffic-history:get-by-date', date),

  // 备份与还原
  backupCreateLocal: (backupType) => ipcRenderer.invoke('backup-create-local', backupType),
  backupRestoreLocal: () => ipcRenderer.invoke('backup-restore-local'),
  backupWebDAVTest: (config) => ipcRenderer.invoke('backup-webdav-test', config),
  backupWebDAVUpload: (backupType) => ipcRenderer.invoke('backup-webdav-upload', backupType),
  backupWebDAVDownload: (fileName = null) => ipcRenderer.invoke('backup-webdav-download', fileName),
  backupWebDAVList: () => ipcRenderer.invoke('backup-webdav-list'),
  backupWebDAVDelete: (fileName) => ipcRenderer.invoke('backup-webdav-delete', fileName),
  backupWebDAVSaveConfig: (config) => ipcRenderer.invoke('backup-webdav-save-config', config),
  backupWebDAVGetConfig: () => ipcRenderer.invoke('backup-webdav-get-config'),
  onBackupUploadProgress: (callback) => {
    const listener = (event, progress) => callback(progress);
    ipcRenderer.on('backup-upload-progress', listener);
    return () => ipcRenderer.removeListener('backup-upload-progress', listener);
  },
  onBackupDownloadProgress: (callback) => {
    const listener = (event, progress) => callback(progress);
    ipcRenderer.on('backup-download-progress', listener);
    return () => ipcRenderer.removeListener('backup-download-progress', listener);
  },

  // 订阅转换器
  converter: {
    convert: (params) => ipcRenderer.invoke('converter:convert', params),
    convertWithTemplate: (params) => ipcRenderer.invoke('converter:convert-with-template', params),
    fetchUrl: (url) => ipcRenderer.invoke('converter:fetch-url', url),
    startServer: (params) => ipcRenderer.invoke('converter:start-server', params),
    stopServer: () => ipcRenderer.invoke('converter:stop-server'),
    createSubscription: (params) => ipcRenderer.invoke('converter:create-subscription', params),
    deleteSubscription: (id) => ipcRenderer.invoke('converter:delete-subscription', id),
    listSubscriptions: () => ipcRenderer.invoke('converter:list-subscriptions'),
    serverStatus: () => ipcRenderer.invoke('converter:server-status'),
    parseProxies: (input) => ipcRenderer.invoke('converter:parse-proxies', input),
    getTemplates: () => ipcRenderer.invoke('converter:get-templates'),
    getTemplate: (templateId) => ipcRenderer.invoke('converter:get-template', templateId),
    addToConfig: (params) => ipcRenderer.invoke('converter:add-to-config', params),
    getSettings: () => ipcRenderer.invoke('converter:get-settings'),
    saveSettings: (settings) => ipcRenderer.invoke('converter:save-settings', settings),
  },

  // 代理组图标
  proxyIcon: {
    getConfig: () => ipcRenderer.invoke('proxy-icon:get-config'),
    saveConfig: (config) => ipcRenderer.invoke('proxy-icon:save-config', config),
    addRule: (rule) => ipcRenderer.invoke('proxy-icon:add-rule', rule),
    updateRule: (ruleId, updates) => ipcRenderer.invoke('proxy-icon:update-rule', ruleId, updates),
    deleteRule: (ruleId) => ipcRenderer.invoke('proxy-icon:delete-rule', ruleId),
    toggleRule: (ruleId, enabled) => ipcRenderer.invoke('proxy-icon:toggle-rule', ruleId, enabled),
    getGroupIcon: (groupName, configIcon) => ipcRenderer.invoke('proxy-icon:get-group-icon', groupName, configIcon),
  },

  // 配置图标
  configIcon: {
    getIcon: (iconUrl, configPath) => ipcRenderer.invoke('config-icon:get-icon', iconUrl, configPath),
    clearCache: () => ipcRenderer.invoke('config-icon:clear-cache'),
    getCacheSize: () => ipcRenderer.invoke('config-icon:get-cache-size'),
  },
});

// 移除重复的事件监听器
// ipcRenderer.on('node-changed', (event, data) => {
//   event.sender.send('dashboard', { type: 'node-changed', data });
// });

// ipcRenderer.on('connections-update', (event, data) => {
//   event.sender.send('dashboard', { type: 'connections-update', data });
// }); 

const UPDATE_AVAILABLE_EVENT = 'flyclash-update-available';

ipcRenderer.on('auto-update-available', (_event, payload) => {
  try {
    if (typeof window !== 'undefined') {
      window.__flyclashPendingUpdate = payload;
      window.dispatchEvent(new CustomEvent(UPDATE_AVAILABLE_EVENT, { detail: payload }));
    }
  } catch (error) {
    console.error('[AutoUpdate] 派发更新事件失败:', error);
  }
});
