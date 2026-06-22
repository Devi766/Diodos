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
  downloadSpeed?: number;
  upload: number;
  uploadSpeed?: number;
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

// 订阅相关信息类型
interface SubscriptionInfo {
  usedTraffic?: string;
  remainingTraffic?: string;
  expiryDate?: string;
  lastUpdated?: string;
}

interface SubscriptionResult {
  success: boolean;
  content?: string;
  subscriptionInfo?: SubscriptionInfo;
  error?: string;
}

type SaveSubscriptionResult = string | {
  success: boolean;
  filePath?: string;
  error?: string;
  message?: string;
} | null;

interface Subscription {
  name: string;
  path: string;
  usedTraffic?: string;
  remainingTraffic?: string;
  totalTraffic?: string;
  expiryDate?: string;
  lastUpdated?: string;
  iconUrl?: string;
}

interface WebDAVBackupConfig {
  uri: string;
  username: string;
  password: string;
  backupDirectory: string;
  fileName: string;
}

interface BackupFileInfo {
  name: string;
  size: number;
  lastModified: string;
  path?: string;
}

interface BackupRestoreStats {
  restored: number;
  failed: number;
  errors: Array<{ name?: string; message?: string } | any>;
}

interface BackupProgress {
  percentage: number;
  uploaded?: number;
  downloaded?: number;
  loaded?: number;
  total?: number;
}

interface RuntimeReloadResult {
  reloaded?: boolean;
  skipped?: boolean;
  reason?: string;
  error?: string;
  result?: any;
}

type ConfigValidationFailureKind = 'invalid-config' | 'timeout' | 'process-failed';

interface ConfigValidationError {
  kind: ConfigValidationFailureKind;
  message: string;
}

interface BackupRestoreResult {
  success: boolean;
  canceled?: boolean;
  stats?: BackupRestoreStats;
  activeConfig?: string | null;
  runtimeReload?: RuntimeReloadResult;
  error?: string;
}

type CompatBooleanResult = boolean | {
  success?: boolean;
  error?: string;
  message?: string;
  path?: string;
  filePath?: string;
  reloaded?: boolean;
  configError?: boolean;
  errorKind?: string;
  validation?: ConfigValidationError;
  runtimeReload?: RuntimeReloadResult;
};

interface TunRuntimeResult {
  success: boolean;
  enabled?: boolean;
  pending?: boolean;
  restarted?: boolean;
  message?: string;
  error?: string;
}

interface TunServiceStatusResult {
  success: boolean;
  installed?: boolean;
  running?: boolean;
  serviceInstalled?: boolean;
  serviceRunning?: boolean;
  mode?: string;
  ipcAvailable?: boolean;
  coreRunning?: boolean;
  corePid?: number | null;
  version?: string | null;
  error?: string;
}

interface ProtocolClientResult {
  success: boolean;
  protocol?: string;
  registered?: boolean;
  error?: string;
}

interface SystemProxyStatus {
  success: boolean;
  enabled: boolean;
  host?: string | null;
  port?: number | null;
  source?: string;
  error?: string;
}

type TrayActionName =
  | 'restart-core'
  | 'stop-core'
  | 'toggle-system-proxy'
  | 'toggle-tun'
  | 'switch-config'
  | 'close-all-connections'
  | string;

interface TrayActionPayload {
  action: TrayActionName;
  result?: boolean | null | {
    success?: boolean;
    ok?: boolean;
    status?: number;
    statusText?: string;
    enabled?: boolean;
    activeConfig?: string;
    configPath?: string;
    filePath?: string;
    path?: string;
    configName?: string;
    reloaded?: boolean;
    message?: string;
    error?: string;
    [key: string]: any;
  };
}

interface CoreResourceStatusItem {
  available: boolean;
  required?: boolean;
  path?: string | null;
  error?: string;
}

interface CoreDataResourceStatus {
  available: boolean;
  synced: boolean;
  sourceDir?: string | null;
  targetDir?: string | null;
  syncedFiles?: string[];
  missingFiles?: string[];
}

interface CoreResourceStatus {
  core?: CoreResourceStatusItem;
  helper?: CoreResourceStatusItem;
  data?: CoreDataResourceStatus;
}

interface CoreProductIdentity {
  productName: string;
  binaryFamily: string;
  legacyBinaryFamily: string;
}

interface MihomoApiResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  data: any;
  json: () => Promise<any>;
  text: () => Promise<string>;
}

type ControllerMode = 'ipc' | 'socket' | 'http';

interface ApiConfigResult {
  success: boolean;
  controllerHost?: string | null;
  controllerPort?: string | null;
  secret: string;
  controllerMode?: ControllerMode;
  socketPath?: string | null;
  socketArg?: string | null;
  httpFallback?: boolean;
  'external-controller'?: string | null;
  error?: string;
}

export interface ElectronAPI {
  // Debug log to terminal
  debugLog: (...args: any[]) => void;
  // 导航相关
  loadPage: (pageName: string) => Promise<{ success: boolean, error?: string }>;
  navigateTo?: (url: string) => void | Promise<{ success: boolean; error?: string }>;

  // 版本号
  getAppVersion: () => Promise<string>;

  // 平台信息
  getPlatform?: () => Promise<string>;

  // 协议处理
  setAsDefaultProtocolClient?: (protocol: string) => Promise<ProtocolClientResult>;
  isDefaultProtocolClient?: (protocol: string) => Promise<ProtocolClientResult>;
  removeAsDefaultProtocolClient?: (protocol: string) => Promise<ProtocolClientResult>;
  registerProtocol?: (protocol: string) => Promise<ProtocolClientResult>;
  isProtocolRegistered?: (protocol: string) => Promise<ProtocolClientResult>;
  unregisterProtocol?: (protocol: string) => Promise<ProtocolClientResult>;
  
  // Mihomo API请求
  requestMihomoAPI: (endpoint: string, options?: RequestInit) => Promise<MihomoApiResponse>;
  
  // Mihomo 管理
  startMihomo: (configPath: string) => Promise<CompatBooleanResult>;
  stopMihomo: () => Promise<CompatBooleanResult>;
  reloadMihomoConfig: (configPath: string) => Promise<CompatBooleanResult>;
  getTrafficStats: () => Promise<TrafficStats>;
  getTrafficToday: () => Promise<{ success: boolean; data?: { upload: number; download: number }; error?: string }>;
  getTrafficMonth: (monthPrefix?: string) => Promise<{ success: boolean; data?: Array<{ date: string; upload: number; download: number }>; error?: string }>;
  getTrafficYear?: (year?: string | number) => Promise<{ success: boolean; data?: Array<{ month: string; upload: number; download: number }>; error?: string }>;
  getTrafficByDate?: (date: string) => Promise<{ success: boolean; data?: { upload: number; download: number }; error?: string }>;
  fetchConnectionsInfo: () => Promise<any>;
  closeConnection?: (id: string) => Promise<{ success: boolean; error?: string }>;
  closeAllConnections?: () => Promise<{ success: boolean; error?: string }>;
  restartService: () => Promise<{ success: boolean, message: string }>;
  
  // 获取API配置信息
  getApiConfig: () => Promise<ApiConfigResult>;
  
  // 代理请求相关
  proxyFetch: (url: string, options?: any) => Promise<{ ok: boolean, status: number, statusText: string, headers: Record<string, string>, data: any }>;
  switchNode: (nodeName: string, groupName?: string) => Promise<{ success: boolean, error?: string }>;
  
  // 获取代理配置
  getProxyConfig: () => Promise<{ success: boolean, data: { host: string, port: number }, error?: string }>;
  
  // 通过HTTP代理发送请求
  fetchWithProxy: (options: { 
    url: string, 
    method?: string, 
    headers?: Record<string, string>, 
    body?: any, 
    timeout?: number,
    proxy?: {
      host: string,
      port: number,
      protocol?: string,
      nodeName?: string
    }
  }) => Promise<{ 
    ok: boolean, 
    status: number, 
    statusText: string, 
    headers: Record<string, string>, 
    data: any 
  }>;
  
  // 用户代理设置
  getProxySettings: () => Promise<{ success: boolean, settings?: any, error?: string }>;
  saveProxySettings: (settings: any) => Promise<{ success: boolean, message?: string, error?: string }>;
  saveUASettings: (ua: string) => Promise<{ success: boolean, message?: string, error?: string }>;
  getKernelPath: () => Promise<{ success: boolean, path?: string, isDefault?: boolean, exists?: boolean, error?: string }>;
  selectKernelExecutable: () => Promise<{ success: boolean, path?: string, needsRestart?: boolean, canceled?: boolean, error?: string }>;
  resetKernelPath: () => Promise<{ success: boolean, path?: string, needsRestart?: boolean, error?: string }>;

  // 内核管理 API
  coreGetCurrentConfig: () => Promise<{ success: boolean; config?: CoreConfig; corePath?: string; version?: string; stableReleaseSeries?: boolean; exists?: boolean; error?: string }>;
  coreGetRuntimeState: () => Promise<{ success: boolean; runningMode?: CoreRunningMode; activeConfig?: string | null; preferredConfig?: string | null; runtimeActiveConfig?: string | null; activeConfigSource?: 'runtime' | 'preferred' | 'none'; pid?: number | null; socketPath?: string | null; socketArg?: string | null; controllerAvailable?: boolean; controllerError?: string | null; controllerStatus?: number | null; coreVersion?: string | null; coreMeta?: boolean | null; corePremium?: boolean | null; coreRunning?: boolean; corePid?: number | null; identity?: CoreProductIdentity; resources?: CoreResourceStatus; error?: string }>;
  coreGetInstalledCores: () => Promise<{ success: boolean; cores?: InstalledCore[]; error?: string }>;
  coreCheckUpdate: (coreType: CoreType) => Promise<{ success: boolean; hasUpdate?: boolean; currentVersion?: string; latestVersion?: string; releaseInfo?: ReleaseInfo; error?: string }>;
  coreDownloadCore: (coreType: CoreType) => Promise<{ success: boolean; version?: string; path?: string; error?: string }>;
  coreGetAvailableVersions: (coreType: CoreType, limit?: number, forceRefresh?: boolean) => Promise<{ success: boolean; versions?: CoreVersion[]; error?: string }>;
  coreClearVersionCache: (coreType?: CoreType) => Promise<{ success: boolean; error?: string }>;
  coreDownloadSpecificVersion: (coreType: CoreType, version: string) => Promise<{ success: boolean; version?: string; path?: string; error?: string }>;
  coreSwitchCore: (coreType: CoreType, specificVersion?: string) => Promise<{ success: boolean; error?: string }>;
  coreDeleteCore: (corePath: string) => Promise<{ success: boolean; error?: string }>;
  coreSetCustomPath: (customPath: string) => Promise<{ success: boolean; error?: string }>;
  onCoreDownloadProgress: (callback: (data: CoreDownloadProgress) => void) => (() => void);

  // 主题设置
  setTheme: (theme: string) => Promise<{ success: boolean, theme: string, error?: string }>;
  getTheme: () => Promise<{ success: boolean, theme: string, error?: string }>;
  onThemeChanged: (callback: (event: any, theme: string) => void) => (() => void);
  removeThemeListener: () => void;
  setAppearanceMode: (mode: 'acrylic' | 'dynamic' | 'solid' | 'custom') => Promise<{ success: boolean; mode?: string; error?: string }>;
  getAppearanceMode: () => Promise<{ success: boolean; mode: string; error?: string }>;
  supportsAdvancedBackdrop: () => Promise<{ success: boolean; supported: boolean }>;
  onAppearanceModeChanged?: (callback: (mode: 'acrylic' | 'dynamic' | 'solid' | 'custom') => void) => (() => void);

  // 自定义背景设置
  selectBackgroundImage: () => Promise<{ success: boolean; path?: string; error?: string; canceled?: boolean }>;
  setCustomBackground: (config: { imagePath: string; opacity: number; blur: number }) => Promise<{ success: boolean; error?: string }>;
  getCustomBackground: () => Promise<{ success: boolean; config?: { imagePath: string; opacity: number; blur: number }; error?: string }>;
  clearCustomBackground: () => Promise<{ success: boolean; error?: string }>;
  onCustomBackgroundApply: (callback: (config: { imageData?: string; imagePath?: string; opacity: number; blur: number }) => void) => (() => void);
  onClearCustomBackground: (callback: () => void) => (() => void);

  // 主题色设置
  setThemeColor: (color: string) => Promise<{ success: boolean; error?: string }>;
  getThemeColor: () => Promise<{ success: boolean; color?: string; error?: string }>;
  onThemeColorChanged: (callback: ((color: string) => void) | ((event: any, color: string) => void)) => (() => void);

  // 静默启动设置
  getSilentStart: () => Promise<{ success: boolean, silentStart: boolean, error?: string }>;
  setSilentStart: (enabled: boolean) => Promise<{ success: boolean, error?: string }>;
  getLightweightModeSettings: () => Promise<{ success: boolean; settings?: { autoEnter: boolean; delay: number; active?: boolean }; error?: string }>;
  setLightweightModeSettings: (settings: { autoEnter?: boolean; delay?: number }) => Promise<{ success: boolean; error?: string }>;
  enterLightweightMode: () => Promise<{ success: boolean; error?: string }>;

  // 通用设置处理器
  getSetting: (key: string, defaultValue?: any) => Promise<{ success: boolean, value: any, error?: string }>;
  setSetting: (key: string, value: any) => Promise<{ success: boolean, error?: string }>;

  // 消息通信
  onMessage: (channel: string, callback: (data: any) => void) => (() => void);

  // 备份与还原
  backupCreateLocal: (backupType?: 'CONFIG_ONLY' | 'FULL_BACKUP' | string) => Promise<{ success: boolean; filePath?: string; canceled?: boolean; error?: string }>;
  backupRestoreLocal: () => Promise<BackupRestoreResult>;
  backupWebDAVGetConfig: () => Promise<{ success: boolean; config?: WebDAVBackupConfig; error?: string }>;
  backupWebDAVSaveConfig: (config: WebDAVBackupConfig) => Promise<{ success: boolean; error?: string }>;
  backupWebDAVTest: (config?: WebDAVBackupConfig) => Promise<{ success: boolean; error?: string }>;
  backupWebDAVUpload: (backupType?: 'CONFIG_ONLY' | 'FULL_BACKUP' | string) => Promise<{ success: boolean; fileName?: string; uploaded?: boolean; error?: string }>;
  backupWebDAVDownload: (fileName?: string) => Promise<BackupRestoreResult>;
  backupWebDAVList: () => Promise<{ success: boolean; backups?: BackupFileInfo[]; error?: string }>;
  backupWebDAVDelete: (fileName: string) => Promise<{ success: boolean; deleted?: boolean; error?: string }>;
  onBackupUploadProgress: (callback: (progress: BackupProgress) => void) => (() => void);
  onBackupDownloadProgress: (callback: (progress: BackupProgress) => void) => (() => void);
  
  // 订阅管理
  saveSubscription: (subUrl: string, configData: string, customName: string, subscriptionInfo?: SubscriptionInfo) => Promise<SaveSubscriptionResult>;
  getSubscriptions: () => Promise<Array<Subscription>>;
  deleteSubscription: (filePath: string) => Promise<boolean | { success: boolean; deleted?: boolean; filePath?: string; error?: string }>;
  editSubscription: (params: { oldPath: string; newName: string; newUrl: string; iconUrl?: string }) => Promise<{ success: boolean; oldPath?: string; newPath: string; error?: string }>;
  getSubscriptionUrl: (filePath: string) => Promise<string | null>;
  fetchSubscription: (subUrl: string) => Promise<SubscriptionResult | null>;
  updateSubscription: (filePath: string, configData: string, subUrl: string, subscriptionInfo?: SubscriptionInfo) => Promise<boolean>;
  refreshSubscription: (filePath: string) => Promise<{ success: boolean, filePath?: string, error?: string, runtimeReload?: { reloaded?: boolean; skipped?: boolean; error?: string; result?: any } }>;
  onImportSubscription: (callback: (url: string) => void) => () => void;
  saveSubscriptionOrder: (orderList: Array<{ path: string; order: number }>) => Promise<{ success: boolean; error?: string }>;
  getSubscriptionUpdateInterval: (filePath: string) => Promise<{ success: boolean; interval?: number; error?: string }>;
  setSubscriptionUpdateInterval: (filePath: string, interval: number) => Promise<{ success: boolean; error?: string }>;
  
  // 节点管理
  selectNode: (nodeName: string, groupName: string) => Promise<{ success: boolean, nodeName: string, groupName: string, error?: string }>;
  selectGroupNode: (nodeName: string, groupName: string, updateGlobal?: boolean) => Promise<{ success: boolean, nodeName: string, groupName: string, error?: string }>;
  getProxies: () => Promise<any>;
  testNodeDelay: (nodeName: string) => Promise<number>;
  getActiveConfig: () => Promise<string | null>;
  onActiveConfigChanged?: (callback: (configPath: string | null) => void) => (() => void);
  setPreferredConfig: (configPath: string) => Promise<{ success: boolean, error?: string, path?: string, filePath?: string }>;
  isMihomoRunning: () => Promise<boolean>;
  getProxyNodes: (configPath?: string) => Promise<any>;
  getConfigOrder: () => Promise<{ success: boolean, data?: any, error?: string }>;
  notifyNodeChanged: (nodeName: string) => Promise<{ success: boolean, error?: string }>;
  
  // 配置管理
  saveLastConfig?: (configPath: string) => Promise<{ success: boolean, error?: string, path?: string, filePath?: string }>;
  getCurrentConfigName: () => Promise<{ success: boolean, configName?: string, error?: string }>;
  
  // 系统代理管理
  toggleSystemProxy: (enabled: boolean) => Promise<CompatBooleanResult>;
  getProxyStatus: () => Promise<boolean>;
  getSystemProxyStatus?: () => Promise<SystemProxyStatus>;
  
  // TUN模式管理
  toggleTunMode: (enabled: boolean) => Promise<CompatBooleanResult | TunRuntimeResult>;
  getTunStatus: () => Promise<boolean>;
  onTunStatus: (callback: (enabled: boolean) => void) => (() => void);

  checkElevateTask: () => Promise<boolean>;
  deleteElevateTask: () => Promise<{ success: boolean; error?: string }>;
  grantTunPermissions: () => Promise<{ success: boolean; message?: string; error?: string; needRestart?: boolean }>;
  checkCorePermission: () => Promise<{ success: boolean; hasPermission: boolean }>;
  revokeCorePermission: () => Promise<{ success: boolean; error?: string }>;
  serviceIsRunning?: () => Promise<{ success: boolean; running?: boolean; error?: string }>;
  serviceInstall?: () => Promise<{ success: boolean; message?: string; error?: string; needRestart?: boolean }>;
  serviceUninstall?: () => Promise<{ success: boolean; message?: string; error?: string }>;
  getTunConfig: () => Promise<{ success: boolean; config?: TunConfig; error?: string }>;
  saveTunConfig: (config: TunConfig) => Promise<TunRuntimeResult>;

  // TUN 权限提升模式（Windows）
  getTunElevationMode?: () => Promise<{ success: boolean; mode?: 'service' | 'task'; error?: string }>;
  setTunElevationMode?: (mode: 'service' | 'task') => Promise<{ success: boolean; error?: string }>;
  getTunServiceStatus?: () => Promise<TunServiceStatusResult>;
  installTunService?: () => Promise<{ success: boolean; message?: string; error?: string; needRestart?: boolean }>;
  uninstallTunService?: () => Promise<{ success: boolean; message?: string; error?: string }>;
  startTunService?: () => Promise<{ success: boolean; message?: string; error?: string }>;
  stopTunService?: () => Promise<{ success: boolean; message?: string; error?: string }>;
  
  // 自动启动设置
  setAutoStart: (enabled: boolean) => Promise<boolean>;
  getAutoStart: () => Promise<boolean>;
  
  // 开机启动设置
  setAutoLaunch: (enabled: boolean) => Promise<boolean>;
  getAutoLaunchState: () => Promise<boolean>;
  
  // 系统操作
  minimizeWindow: () => Promise<{ success: boolean }>;
  maximizeWindow: () => Promise<{ success: boolean; maximized?: boolean }>;
  closeWindow: () => Promise<{ success: boolean }>;
  getWindowState?: () => Promise<{ success: boolean; maximized: boolean; fullScreen?: boolean }>;
  onWindowStateChanged?: (callback: (state: { maximized: boolean; fullScreen?: boolean }) => void) => (() => void);
  openExternal: (url: string) => Promise<{ success: boolean; error?: string }>;
  openFile: (filePath: string) => Promise<{ success: boolean, error?: string }>;
  openFileLocation: (filePath: string) => Promise<{ success: boolean, error?: string }>;
  getIconDataURL?: (processPath: string) => Promise<string | null>;
  
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
  runProxySpeedtest: (options: { 
    url?: string,
    proxy?: {
      host: string,
      port: number,
      nodeName?: string
    }
  }) => Promise<{ 
    success: boolean, 
    data?: { 
      downloadSpeed: number,
      bytesReceived: number,
      duration: number,
      url: string
    }, 
    error?: string 
  }>;
  
  // UDP连通性测试
  testUdpConnectivity: (options: {
    proxy: {
      host: string,
      port: number,
      nodeName: string
    },
    testServers?: Array<{
      address: string,
      port: number,
      name: string
    }>
  }) => Promise<{
    success: boolean,
    udpType?: string,
    successCount?: number,
    details?: Array<any>,
    error?: string
  }>;
  onSpeedtestProgress: (callback: (progressData: SpeedtestProgress) => void) => (() => void);
  onSpeedtestOutput: (callback: (outputData: SpeedtestOutput) => void) => (() => void);

  openFileInDefaultApp: (filePath: string) => Promise<{
    success: boolean,
    error?: string
  }>;
  
  // 日志管理
  saveLogs: (logEntries: any[]) => Promise<{ success: boolean, filePath?: string, error?: string }>;
  getLogs: () => Promise<any[]>;
  clearLogs?: () => Promise<{ success: boolean, error?: string }>;
  
  // 节点收藏和组折叠管理
  getFavoriteNodes: () => Promise<{ success: boolean, nodes: string[], error?: string }>;
  saveFavoriteNodes: (nodes: string[]) => Promise<{ success: boolean, error?: string }>;
  saveCollapsedGroups: (groups: string[]) => Promise<{ success: boolean, error?: string }>;
  getCollapsedGroups: () => Promise<{ success: boolean, groups: string[], error?: string }>;
  
  // Provider 资源管理
  getProxyProviders: () => Promise<{ success: boolean, data?: any, error?: string }>;
  updateProxyProvider: (providerName: string) => Promise<{ success: boolean, error?: string }>;
  getRuleProviders: () => Promise<{ success: boolean, data?: any, error?: string }>;
  updateRuleProvider: (providerName: string) => Promise<{ success: boolean, error?: string }>;
  getRuntimeConfig: () => Promise<{ success: boolean, data?: any, error?: string }>;

  // 配置编辑器
  getKernelConfig: (configPath?: string) => Promise<{ success: boolean; config?: any; error?: string }>;
  saveKernelConfig: (config: any, configPath?: string) => Promise<{ success: boolean; restarted?: boolean; message?: string; error?: string }>;
  getDnsConfig: (configPath?: string) => Promise<{ success: boolean; config?: any; hosts?: Record<string, string | string[]>; error?: string }>;
  saveDnsConfig: (config: any, configPath?: string) => Promise<{ success: boolean; restarted?: boolean; message?: string; error?: string }>;
  saveHostsConfig: (hosts: Array<{ domain: string; value: string | string[] }>, configPath?: string) => Promise<{ success: boolean; error?: string }>;
  getSnifferConfig: (configPath?: string) => Promise<{ success: boolean; config?: any; error?: string }>;
  saveSnifferConfig: (config: any, configPath?: string) => Promise<{ success: boolean; restarted?: boolean; message?: string; error?: string }>;

  // 代理组/规则/提供者配置（直接读写订阅 YAML）
  getProxyGroupsConfig: (configPath: string) => Promise<{ success: boolean; groups?: any[]; error?: string }>;
  saveProxyGroupsConfig: (groups: any[], configPath: string) => Promise<{ success: boolean; error?: string }>;
  getRulesConfig: (configPath: string) => Promise<{ success: boolean; rules?: string[]; error?: string }>;
  saveRulesConfig: (rules: string[], configPath: string) => Promise<{ success: boolean; error?: string }>;
  getProvidersConfig: (configPath: string) => Promise<{ success: boolean; proxyProviders?: Record<string, any>; ruleProviders?: Record<string, any>; error?: string }>;
  saveProvidersConfig: (proxyProviders: Record<string, any>, ruleProviders: Record<string, any>, configPath: string) => Promise<{ success: boolean; error?: string }>;
  getProxiesConfig: (configPath: string) => Promise<{ success: boolean; proxies?: any[]; error?: string }>;
  saveProxiesConfig: (proxies: any[], configPath: string) => Promise<{ success: boolean; error?: string }>;

  // AI Assistant: raw config file read/write/validate
  readConfigFile: () => Promise<{ success: boolean; content?: string; path?: string; error?: string }>;
  writeConfigFile: (content: string) => Promise<{ success: boolean; path?: string; error?: string }>;
  validateConfig: (content: string) => Promise<{ valid: boolean; error?: string }>;
  editConfigAtomic: (oldString: string, newString: string) => Promise<{ success: boolean; error?: string; matchCount?: number; yamlError?: string; content?: string }>;

  // AI API proxy (bypass CORS)
  aiProxyFetch: (config: { url: string; method?: string; headers?: Record<string, string>; body?: string; timeout?: number }) => Promise<{ ok: boolean; status: number; body: string }>;
  aiProxyStreamStart: (config: { url: string; method?: string; headers?: Record<string, string>; body?: string; requestId: string; timeout?: number }) => Promise<{ ok: boolean; status: number; errorBody?: string }>;
  aiProxyStreamAbort: (requestId: string) => Promise<void>;
  onAiProxyStreamChunk: (callback: (requestId: string, chunk: Uint8Array) => void) => () => void;
  onAiProxyStreamEnd: (callback: (requestId: string) => void) => () => void;
  onAiProxyStreamError: (callback: (requestId: string, error: string) => void) => () => void;

  // 覆写管理
  getOverrides: () => Promise<any[]>;
  addOverride: (item: any) => Promise<any>;
  updateOverride: (id: string, updates: any) => Promise<any>;
  deleteOverride: (id: string) => Promise<{ success?: boolean; error?: string; runtimeReload?: any } | any>;
  getOverrideFileContent: (id: string) => Promise<string>;
  updateOverrideFileContent: (id: string, content: string) => Promise<{ success?: boolean; error?: string; runtimeReload?: any } | any>;
  updateRemoteOverride: (id: string) => Promise<any>;
  reorderOverrides: (itemIds: string[]) => Promise<{ success?: boolean; error?: string; runtimeReload?: any } | any>;
  getSubscriptionOverrides: (filePath: string) => Promise<string[] | { success: boolean; error?: string }>;
  setSubscriptionOverrides: (filePath: string, overrides: string[]) => Promise<{ success: boolean; error?: string; runtimeReload?: any }>;

  // 事件监听
  onMihomoLog: (callback: (log: string) => void) => void;
  onMihomoLogs: (callback: (log: any) => void) => (() => void);
  offMihomoLogs: () => void;
  onMihomoError: (callback: (error: string) => void) => void;
  onMihomoStartFailed: (callback: (data: { error: string; exitCode?: number }) => void) => (() => void);
  onMihomoStopped: (callback: (code: number) => void) => (() => void);
  onTrayAction?: (callback: (data: TrayActionPayload) => void) => (() => void);
  onProxyStatus: (callback: (enabled: boolean) => void) => (() => void);
  onMihomoAutostart: (callback: (data: any) => void) => (() => void);
  onSubscriptionAutoUpdated?: (callback: (data: { name?: string; filePath?: string; result?: any }) => void) => (() => void);
  onSubscriptionAutoUpdateFailed?: (callback: (data: { name?: string; filePath?: string; error?: string }) => void) => (() => void);
  onNodeChanged: (callback: (data: { nodeName: string }) => void) => (() => void);
  onConnectionsUpdate: (callback: (data: any) => void) => (() => void);
  onTrafficUpdate: (callback: (stats: any) => void) => (() => void);
  onServiceRestarted: (callback: (result: {success: boolean, error?: string}) => void) => () => void;
  onTestAllNodes: (callback: () => void) => () => void;
  onConnectionsClosed: (callback: () => void) => () => void;
  testAllNodes?: () => Promise<{ success: boolean; error?: string }>;

  // 移除监听器
  removeAllListeners: (prefix?: string) => void;
  removeTrafficListeners?: () => void;

  // 订阅转换器
  converter?: {
    convert: (params: any) => Promise<any>;
    convertWithTemplate: (params: any) => Promise<any>;
    fetchUrl: (url: string) => Promise<any>;
    startServer: (params?: any) => Promise<any>;
    stopServer: () => Promise<any>;
    createSubscription: (params: any) => Promise<any>;
    deleteSubscription: (id: string) => Promise<any>;
    listSubscriptions: () => Promise<any>;
    serverStatus: () => Promise<any>;
    parseProxies: (input: string) => Promise<any>;
    getTemplates: () => Promise<any>;
    getTemplate: (templateId: string) => Promise<any>;
    addToConfig: (params: { name: string; url: string }) => Promise<{ success: boolean; id?: string; filePath?: string; error?: string }>;
    getSettings: () => Promise<any>;
    saveSettings: (settings: any) => Promise<any>;
  };

  // 代理组图标
  proxyIcon?: {
    getConfig: () => Promise<{ success: boolean; config?: any; error?: string }>;
    saveConfig: (config: any) => Promise<{ success: boolean; error?: string }>;
    addRule: (rule: any) => Promise<{ success: boolean; error?: string }>;
    updateRule: (ruleId: string, rule: any) => Promise<{ success: boolean; error?: string }>;
    deleteRule: (ruleId: string) => Promise<{ success: boolean; error?: string }>;
    toggleRule: (ruleId: string, enabled: boolean) => Promise<{ success: boolean; error?: string }>;
    getGroupIcon: (groupName: string, configIcon?: string | null) => Promise<{ success: boolean; iconPath?: string; error?: string }>;
    clearCache: () => Promise<{ success: boolean; error?: string }>;
  };

  // 配置图标
  configIcon?: {
    getIcon: (iconUrl: string, configPath: string) => Promise<{ success: boolean; iconPath?: string; error?: string }>;
    clearCache: () => Promise<{ success: boolean; error?: string }>;
    getCacheSize: () => Promise<{ success: boolean; size?: number; error?: string }>;
  };

  // UWP 回环豁免管理
  loopback?: {
    getApps: () => Promise<LoopbackAppsResult>;
    saveConfig: (exemptSids: string[]) => Promise<{ success: boolean; error?: string; count?: number; added?: number; failed?: number }>;
    addExemption: (sid: string) => Promise<{ success: boolean; error?: string; count?: number }>;
    removeExemption: (sid: string) => Promise<{ success: boolean; error?: string; count?: number }>;
  };
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

// UWP 回环豁免应用信息
interface LoopbackApp {
  appContainerName: string;
  displayName: string;
  packageFamilyName: string;
  sid: string;
  workingDir: string;
  isExempt: boolean;
}

// UWP 回环豁免查询结果
interface LoopbackAppsResult {
  success: boolean;
  apps?: LoopbackApp[];
  isAdmin: boolean;
  error?: string;
}

// TUN 配置接口
interface TunConfig {
  device: string;
  stack: 'gvisor' | 'mixed' | 'system';
  autoRoute: boolean;
  autoRedirect: boolean;
  autoDetectInterface: boolean;
  dnsHijack: string[];
  strictRoute: boolean;
  routeExcludeAddress: string[];
  mtu: number;
  autoSetDNS?: boolean;
}

// 内核类型
type CoreType = 'mihomo' | 'mihomo-alpha' | 'mihomo-smart' | 'mihomo-specific';

// 内核运行模式
type CoreRunningMode = 'service' | 'sidecar' | 'notRunning';

// 内核配置
interface CoreConfig {
  coreType: CoreType;
  specificVersion?: string | null;
  customPath?: string | null;
}

// 已安装的内核
interface InstalledCore {
  type: CoreType;
  version?: string | null;
  path: string;
  size: number;
  modifiedAt: Date;
  managed?: boolean;
  source?: 'managed' | 'bundled' | string;
}

// Release 信息
interface ReleaseInfo {
  name: string;
  body: string;
  publishedAt: string;
}

// 内核下载进度
interface CoreDownloadProgress {
  coreType: CoreType;
  version?: string;
  progress: number;
  downloaded: number;
  total: number;
}

// 内核版本信息
interface CoreVersion {
  version: string;
  tagName: string;
  name: string;
  publishedAt: string;
  prerelease: boolean;
  body: string;
}

// 已将ElectronAPI导出
