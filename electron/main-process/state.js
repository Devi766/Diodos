module.exports = {
  mainWindow: null,
  tray: null,
  mihomoProcess: null,
  configFilePath: null,
  isQuitting: false,
  autoStartEnabled: true,
  currentNode: null,
  connectionsWebSocket: null,
  connectionsRetry: 10,
  lastConnectionsInfo: {
    downloadTotal: 0,
    uploadTotal: 0,
    connections: [],
    memory: 0,
    currentNode: null,
    activeConnections: 0
  },
  lastTrafficStats: {
    up: 0,
    down: 0,
    upSpeed: 0,
    downSpeed: 0,
    timestamp: Date.now()
  },
  trafficWebSocket: null,
  trafficRetry: 10,
  lastValidStats: null,
  lastConnectionsFetchTime: 0,
  trafficHistory: [],
  systemProxyEnabled: false,
  tunModeEnabled: false,
  trafficStatsInterval: null,
  activeApiConfig: {
    controllerHost: '127.0.0.1',
    controllerPort: '9090',
    secret: ''
  },
  memoryMonitorInterval: null,
  logsWebSocket: null,
  logsRetry: 10,
  appearanceMode: 'acrylic',
  trafficAccumulator: null
};
