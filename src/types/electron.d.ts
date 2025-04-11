interface IpcRendererEvent extends Event {
  sender: Electron.IpcRenderer;
  senderId: number;
}

interface TrafficStats {
  up: number;
  down: number;
  upSpeed: number;
  downSpeed: number;
  timestamp: number;
}

interface SpeedtestResult {
  download: number;
  upload: number;
  ping: number;
  jitter?: number;
  server: {
    host: string;
    name: string;
    country: string;
  };
}

type LogEntry = {
  id: number;
  type: 'info' | 'error';
  content: string;
  timestamp: Date;
};

interface ElectronAPI {
  // 导航相关
  loadPage: (pageName: string) => Promise<{ success: boolean, error?: string }>;
  
  // 版本号
  getAppVersion: () => Promise<string>;
  
  // Mihomo 管理
  startMihomo: (configPath: string) => Promise<boolean>;
  stopMihomo: () => Promise<boolean>;
  getTrafficStats: () => Promise<TrafficStats>;
  fetchConnectionsInfo: () => Promise<any>;
  restartService: () => Promise<{ success: boolean, message: string }>;
  
  // 用户代理设置
  getProxySettings: () => Promise<{ success: boolean, settings?: any, error?: string }>;
  saveProxySettings: (settings: any) => Promise<{ success: boolean, message?: string, error?: string }>;
  
  // 主题设置
  setTheme: (theme: string) => Promise<{ success: boolean, theme: string, error?: string }>;
  getTheme: () => Promise<{ success: boolean, theme: string, error?: string }>;
  onThemeChanged: (callback: (event: any, theme: string) => void) => void;
  removeThemeListener: () => void;
  
  // 订阅管理
  saveSubscription: (subUrl: string, configData: string, customName: string) => Promise<string>;
  getSubscriptions: () => Promise<Array<{ name: string, path: string }>>;
  deleteSubscription: (filePath: string) => Promise<boolean>;
  fetchSubscription: (subUrl: string) => Promise<string | null>;
  updateSubscription: (filePath: string, configData: string, subUrl: string) => Promise<boolean>;
  refreshSubscription: (filePath: string) => Promise<{ success: boolean, filePath?: string, error?: string }>;
  
  // 节点管理
  selectNode: (nodeName: string, groupName: string) => Promise<{ success: boolean, nodeName: string, groupName: string, error?: string }>;
  selectGroupNode: (nodeName: string, groupName: string, updateGlobal?: boolean) => Promise<{ success: boolean, nodeName: string, groupName: string, error?: string }>;
  getProxies: () => Promise<any>;
  testNodeDelay: (nodeName: string) => Promise<number>;
  getActiveConfig: () => Promise<string | null>;
  getProxyNodes: (configPath?: string) => Promise<any>;
  getConfigOrder: () => Promise<{ success: boolean, data?: any, error?: string }>;
  notifyNodeChanged: (nodeName: string) => Promise<{ success: boolean, error?: string }>;
  
  // 配置管理
  saveLastConfig?: (configPath: string) => Promise<{ success: boolean, error?: string }>;
  
  // 系统代理管理
  toggleSystemProxy: (enabled: boolean) => Promise<boolean>;
  getProxyStatus: () => Promise<boolean>;
  
  // 自动启动设置
  setAutoStart: (enabled: boolean) => Promise<boolean>;
  getAutoStart: () => Promise<boolean>;
  
  // 开机启动设置
  setAutoLaunch: (enabled: boolean) => Promise<boolean>;
  getAutoLaunchState: () => Promise<boolean>;
  
  // 系统操作
  openExternal: (url: string) => Promise<{ success: boolean }>;
  openFile: (filePath: string) => Promise<{ success: boolean, error?: string }>;
  openFileLocation: (filePath: string) => Promise<{ success: boolean, error?: string }>;
  
  // 工具应用
  openToolsApp: (toolName: string) => Promise<{ success: boolean, error?: string }>;
  
  // 媒体服务检测
  testMediaStreaming: (serviceName: string, checkUrl?: string) => Promise<{ 
    available: boolean; 
    fullSupport?: boolean; 
    message?: string; 
    region?: string; 
    checkTime?: number;
  }>;
  
  // 测速工具
  runSpeedtest: () => Promise<{ success: boolean, data?: SpeedtestResult, error?: string }>;
  runSpeedtestDirect: () => Promise<{ success: boolean, data?: SpeedtestResult, error?: string }>;
  onSpeedtestProgress: (callback: (progressData: SpeedtestProgress) => void) => (() => void);
  onSpeedtestOutput: (callback: (outputData: SpeedtestOutput) => void) => (() => void);
  
  // 日志管理
  saveLogs: (logEntries: any[]) => Promise<{ success: boolean, filePath?: string, error?: string }>;
  getLogs: () => Promise<any[]>;
  
  // 节点收藏和组折叠管理
  getFavoriteNodes: () => Promise<{ success: boolean, nodes: string[], error?: string }>;
  saveFavoriteNodes: (nodes: string[]) => Promise<{ success: boolean, error?: string }>;
  saveCollapsedGroups: (groups: string[]) => Promise<{ success: boolean, error?: string }>;
  getCollapsedGroups: () => Promise<{ success: boolean, groups: string[], error?: string }>;
  
  // 事件监听
  onMihomoLog: (callback: (log: string) => void) => void;
  onMihomoError: (callback: (error: string) => void) => void;
  onMihomoStopped: (callback: (code: number) => void) => void;
  onProxyStatus: (callback: (enabled: boolean) => void) => (() => void);
  onMihomoAutostart: (callback: (data: any) => void) => void;
  onNodeChanged: (callback: (data: { nodeName: string }) => void) => void;
  onConnectionsUpdate: (callback: (data: any) => void) => void;
  onTrafficUpdate: (callback: (stats: any) => void) => void;
  onServiceRestarted: (callback: (result: {success: boolean, error?: string}) => void) => () => void;
  onTestAllNodes: (callback: () => void) => () => void;
  onConnectionsClosed: (callback: () => void) => () => void;
  
  // 移除监听器
  removeAllListeners: (prefix?: string) => void;
}

interface Window {
  electronAPI: ElectronAPI;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

// 添加speedtest进度接口
interface SpeedtestProgress {
  phase?: 'preparing' | 'ping' | 'download' | 'upload' | 'error';
  percent?: number;
  downloadSpeed?: number;
  uploadSpeed?: number;
  ping?: number;
  jitter?: number;
  error?: string;
}

// 添加speedtest实时输出接口
interface SpeedtestOutput {
  type: 'stdout' | 'stderr' | 'status' | 'progress';
  message?: string;
  phase?: 'start' | 'ping' | 'download' | 'upload' | 'complete' | 'error';
  progress?: number;
  downloadSpeed?: number;
  uploadSpeed?: number;
  ping?: number;
  jitter?: number;
  exitCode?: number;
  error?: string;
}

export {}; 