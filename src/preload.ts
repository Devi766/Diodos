interface ElectronAPI {
  // 节点相关
  getSubscriptions: () => Promise<any[]>;
  startMihomo: (configPath: string) => Promise<boolean>;
  stopMihomo: () => Promise<boolean>;
  getProxyNodes: (configPath?: string) => Promise<any>;
  getConfigOrder: () => Promise<any>;
  onNodeChanged: (callback: (data: any) => void) => void;
  notifyNodeChanged: (nodeName: string) => Promise<any>;
  onConnectionsUpdate: (callback: (data: any) => void) => void;
  closeConnection: (id: string) => Promise<any>;
  closeAllConnections: () => Promise<any>;
  testAllNodes: () => Promise<any>;
  onTestAllNodes: (callback: () => void) => void;
  getLastActivity: () => Promise<any>;
  getFavoriteNodes: () => Promise<any>;
  saveFavoriteNodes: (nodes: string[]) => Promise<any>;
  getCollapsedGroups: () => Promise<any>;
  saveCollapsedGroups: (groups: string[]) => Promise<any>;
  removeAllListeners: (channel: string) => void;
  
  // 系统代理相关
  toggleSystemProxy: (enabled: boolean) => Promise<boolean>;
  getProxyStatus: () => Promise<boolean>;
  
  // 订阅相关
  fetchSubscription: (subUrl: string) => Promise<string | null>;
  saveSubscription: (subUrl: string, configData: string, customName?: string) => Promise<string>;
  deleteSubscription: (filePath: string) => Promise<boolean>;
  refreshSubscription: (filePath: string) => Promise<any>;
  getSubscriptionUrl: (filePath: string) => Promise<any>;
  
  // 流量统计相关
  getTrafficStats: () => Promise<any>;
  saveLogs: (logContent: string) => Promise<any>;
  
  // 外部资源相关
  openExternal: (url: string) => Promise<any>;
  openFile: (filePath: string) => Promise<any>;
  openFileLocation: (filePath: string) => Promise<any>;
  
  // 系统相关
  getAutoStart: () => Promise<boolean>;
  setAutoStart: (enabled: boolean) => Promise<boolean>;
  getTheme: () => Promise<any>;
  setTheme: (theme: string) => Promise<any>;
  
  // 新增: 保存最后使用的配置文件
  saveLastConfig: (configPath: string) => Promise<any>;
} 

// 在window对象上定义electronAPI属性
declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

// 使用contextBridge暴露API给渲染进程
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // 节点相关
  getSubscriptions: () => ipcRenderer.invoke('get-subscriptions'),
  startMihomo: (configPath: string) => ipcRenderer.invoke('start-mihomo', configPath),
  stopMihomo: () => ipcRenderer.invoke('stop-mihomo'),
  getProxyNodes: (configPath?: string) => ipcRenderer.invoke('get-proxy-nodes', configPath),
  getConfigOrder: () => ipcRenderer.invoke('get-config-order'),
  onNodeChanged: (callback: (data: any) => void) => ipcRenderer.on('node-changed', (_event, data) => callback(data)),
  notifyNodeChanged: (nodeName: string) => ipcRenderer.invoke('notify-node-changed', nodeName),
  onConnectionsUpdate: (callback: (data: any) => void) => ipcRenderer.on('connections-update', (_event, data) => callback(data)),
  closeConnection: (id: string) => ipcRenderer.invoke('close-connection', id),
  closeAllConnections: () => ipcRenderer.invoke('close-all-connections'),
  testAllNodes: () => ipcRenderer.invoke('test-all-nodes'),
  onTestAllNodes: (callback: () => void) => ipcRenderer.on('test-all-nodes', () => callback()),
  getLastActivity: () => ipcRenderer.invoke('get-last-activity'),
  getFavoriteNodes: () => ipcRenderer.invoke('get-favorite-nodes'),
  saveFavoriteNodes: (nodes: string[]) => ipcRenderer.invoke('save-favorite-nodes', nodes),
  getCollapsedGroups: () => ipcRenderer.invoke('get-collapsed-groups'),
  saveCollapsedGroups: (groups: string[]) => ipcRenderer.invoke('save-collapsed-groups', groups),
  removeAllListeners: (channel: string) => ipcRenderer.removeAllListeners(channel),
  
  // 系统代理相关
  toggleSystemProxy: (enabled: boolean) => ipcRenderer.invoke('toggle-system-proxy', enabled),
  getProxyStatus: () => ipcRenderer.invoke('get-proxy-status'),
  
  // 订阅相关
  fetchSubscription: (subUrl: string) => ipcRenderer.invoke('fetch-subscription', subUrl),
  saveSubscription: (subUrl: string, configData: string, customName?: string) => 
    ipcRenderer.invoke('save-subscription', subUrl, configData, customName),
  deleteSubscription: (filePath: string) => ipcRenderer.invoke('delete-subscription', filePath),
  refreshSubscription: (filePath: string) => ipcRenderer.invoke('refresh-subscription', filePath),
  getSubscriptionUrl: (filePath: string) => ipcRenderer.invoke('get-subscription-url', filePath),
  
  // 流量统计相关
  getTrafficStats: () => ipcRenderer.invoke('get-traffic-stats'),
  saveLogs: (logContent: string) => ipcRenderer.invoke('save-logs', logContent),
  
  // 外部资源相关
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
  openFile: (filePath: string) => ipcRenderer.invoke('open-file', filePath),
  openFileLocation: (filePath: string) => ipcRenderer.invoke('open-file-location', filePath),
  
  // 系统相关
  getAutoStart: () => ipcRenderer.invoke('get-auto-start'),
  setAutoStart: (enabled: boolean) => ipcRenderer.invoke('set-auto-start', enabled),
  getTheme: () => ipcRenderer.invoke('get-theme'),
  setTheme: (theme: string) => ipcRenderer.invoke('set-theme', theme),
  
  // 新增: 保存最后使用的配置文件
  saveLastConfig: (configPath: string) => ipcRenderer.invoke('save-last-config', configPath),
}); 