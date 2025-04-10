const { contextBridge, ipcRenderer } = require('electron');

// 导航函数不再需要处理DOM事件，直接在NavMenu组件中处理
// 删除旧的handleNavigation函数

contextBridge.exposeInMainWorld('electronAPI', {
  // 导航相关 - 新的页面加载方法
  loadPage: (pageName) => ipcRenderer.invoke('loadPage', pageName),
  
  // 版本号
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  
  // Mihomo 管理
  startMihomo: (configPath) => ipcRenderer.invoke('start-mihomo', configPath),
  stopMihomo: () => ipcRenderer.invoke('stop-mihomo'),
  getTrafficStats: () => ipcRenderer.invoke('get-traffic-stats'),
  fetchConnectionsInfo: () => ipcRenderer.invoke('fetch-connections-info'),
  // 重启Mihomo服务（用于端口更改后）
  restartService: () => ipcRenderer.invoke('restart-service'),
  
  // 用户代理设置相关API
  getProxySettings: () => ipcRenderer.invoke('get-proxy-settings'),
  saveProxySettings: (settings) => ipcRenderer.invoke('save-proxy-settings', settings),
  
  // 添加主题设置相关方法
  setTheme: (theme) => ipcRenderer.invoke('set-theme', theme),
  getTheme: () => ipcRenderer.invoke('get-theme'),
  
  // 订阅管理
  saveSubscription: (subUrl, configData, customName) => {
    console.log('preload.js - 传递订阅参数 - URL:', subUrl); 
    console.log('preload.js - 传递订阅参数 - 自定义名称:', customName);
    return ipcRenderer.invoke('save-subscription', subUrl, configData, customName);
  },
  getSubscriptions: () => ipcRenderer.invoke('get-subscriptions'),
  deleteSubscription: (filePath) => ipcRenderer.invoke('delete-subscription', filePath),
  fetchSubscription: (subUrl) => ipcRenderer.invoke('fetch-subscription', subUrl),
  updateSubscription: (filePath, configData, subUrl) => ipcRenderer.invoke('update-subscription', filePath, configData, subUrl),
  refreshSubscription: (filePath) => ipcRenderer.invoke('refresh-subscription', filePath),
  
  // 节点管理
  selectNode: (nodeName, groupName) => ipcRenderer.invoke('select-node', nodeName, groupName),
  selectGroupNode: (nodeName, groupName, updateGlobal = false) => ipcRenderer.invoke('select-node', nodeName, groupName, updateGlobal),
  getProxies: () => ipcRenderer.invoke('get-proxies'),
  testNodeDelay: (nodeName) => ipcRenderer.invoke('test-node-delay', nodeName),
  getActiveConfig: () => ipcRenderer.invoke('get-active-config'),
  getProxyNodes: (configPath) => ipcRenderer.invoke('get-proxy-nodes', configPath),
  getConfigOrder: () => ipcRenderer.invoke('get-config-order'),
  notifyNodeChanged: (nodeName) => ipcRenderer.invoke('notify-node-changed', nodeName),
  
  // 系统代理管理
  toggleSystemProxy: (enabled) => ipcRenderer.invoke('toggleSystemProxy', enabled),
  getProxyStatus: () => ipcRenderer.invoke('getProxyStatus'),
  
  // 自动启动设置
  setAutoStart: (enabled) => ipcRenderer.invoke('set-auto-start', enabled),
  getAutoStart: () => ipcRenderer.invoke('get-auto-start'),
  
  // 添加新的开机启动API接口
  setAutoLaunch: (enabled) => ipcRenderer.invoke('set-auto-launch', enabled),
  getAutoLaunchState: () => ipcRenderer.invoke('get-auto-launch-state'),
  
  // 系统操作
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  openFile: (filePath) => ipcRenderer.invoke('open-file', filePath),
  openFileLocation: (filePath) => ipcRenderer.invoke('open-file-location', filePath),
  
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
  onTrafficUpdate: (callback) => {
    const handler = (_, stats) => callback(stats);
    ipcRenderer.on('traffic-update', handler);
    return () => ipcRenderer.removeListener('traffic-update', handler);
  },
  // 添加主题变更事件监听器
  onThemeChanged: (callback) => {
    const handler = (event, theme) => callback(event, theme);
    ipcRenderer.on('theme-changed', handler);
    return () => ipcRenderer.removeListener('theme-changed', handler);
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
      ipcRenderer.removeAllListeners('mihomo-autostart');
      ipcRenderer.removeAllListeners('node-changed');
    } else if (prefix === 'proxy-nodes') {
      // 仅移除ProxyNodes组件使用的事件
      ipcRenderer.removeAllListeners('node-changed');
    } else {
      // 移除所有事件
      ipcRenderer.removeAllListeners('mihomo-log');
      ipcRenderer.removeAllListeners('mihomo-error');
      ipcRenderer.removeAllListeners('mihomo-stopped');
      ipcRenderer.removeAllListeners('proxy-status'); 
      ipcRenderer.removeAllListeners('mihomo-autostart');
      ipcRenderer.removeAllListeners('node-changed');
      ipcRenderer.removeAllListeners('theme-changed');
    }
  },
  // 移除主题监听器
  removeThemeListener: () => {
    ipcRenderer.removeAllListeners('theme-changed');
  }
});

// 移除重复的事件监听器
// ipcRenderer.on('node-changed', (event, data) => {
//   event.sender.send('dashboard', { type: 'node-changed', data });
// });

// ipcRenderer.on('connections-update', (event, data) => {
//   event.sender.send('dashboard', { type: 'connections-update', data });
// }); 