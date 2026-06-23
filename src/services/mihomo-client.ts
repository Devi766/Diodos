import {
  APP_DATA_CACHE_KEYS,
  writeAppDataCache,
} from './app-data-cache';

type MihomoApiModule = typeof import('tauri-plugin-mihomo-api');

export type MihomoCompatResponse<T = unknown> = {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  data: T;
  text: string;
  controllerMode: 'ipc';
  httpFallback: false;
};

type RequestLike = {
  method?: string;
  body?: unknown;
  params?: Record<string, unknown>;
};

type MihomoLogLevel = 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR' | 'SILENT';

export const MIHOMO_RUNTIME_UNAVAILABLE_EVENT = 'flyclash-mihomo-runtime-unavailable';

const loadMihomoApi = (): Promise<MihomoApiModule> =>
  import('tauri-plugin-mihomo-api');

const errorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (!error || typeof error !== 'object') return String(error ?? '');

  const record = error as {
    error?: unknown;
    message?: unknown;
    statusText?: unknown;
    data?: { message?: unknown; error?: unknown };
  };
  const raw = record.error ?? record.message ?? record.statusText ?? record.data?.message ?? record.data?.error;
  return typeof raw === 'string' ? raw : String(raw ?? '');
};

export const isMihomoRuntimeUnavailableError = (error: unknown): boolean => {
  const message = errorMessage(error);
  const lower = message.toLowerCase();
  return (
    lower.includes('mihomo service unavailable') ||
    lower.includes('mihomo service is not running') ||
    lower.includes('mihomo service not running') ||
    lower.includes('core service is not running') ||
    lower.includes('connection refused') ||
    lower.includes('failed to connect') ||
    lower.includes('connect failed') ||
    lower.includes('broken pipe') ||
    lower.includes('closed pipe') ||
    lower.includes('named pipe') ||
    lower.includes('local socket') ||
    lower.includes('unix socket') ||
    lower.includes('no such file or directory') ||
    lower.includes('cannot find the file specified') ||
    lower.includes('the system cannot find the file specified') ||
    lower.includes('os error 2') ||
    lower.includes('os error 3') ||
    lower.includes('os error 231') ||
    lower.includes('econnrefused') ||
    lower.includes('enoent') ||
    lower.includes('epipe') ||
    message.includes('Mihomo服务未运行') ||
    message.includes('Mihomo 未运行') ||
    message.includes('内核服务未运行') ||
    message.includes('管道') ||
    message.includes('套接字') ||
    message.includes('拒绝连接')
  );
};

const markMihomoUnavailable = (error: unknown) => {
  if (!isMihomoRuntimeUnavailableError(error) || typeof window === 'undefined') return;
  writeAppDataCache(APP_DATA_CACHE_KEYS.mihomoRunning, false);
  window.dispatchEvent(
    new CustomEvent(MIHOMO_RUNTIME_UNAVAILABLE_EVENT, {
      detail: { message: errorMessage(error) },
    }),
  );
};

const callMihomo = async <T>(operation: (api: MihomoApiModule) => Promise<T>): Promise<T> => {
  try {
    const api = await loadMihomoApi();
    return await operation(api);
  } catch (error) {
    markMihomoUnavailable(error);
    throw error;
  }
};

const toCompatResponse = <T>(
  data: T,
  status = 200,
): MihomoCompatResponse<T> => ({
  ok: true,
  status,
  statusText: '',
  headers: {},
  data,
  text: data == null ? '' : JSON.stringify(data),
  controllerMode: 'ipc',
  httpFallback: false,
});

const toCompatError = (message: string, status = 400): MihomoCompatResponse => ({
  ok: false,
  status,
  statusText: message,
  headers: {},
  data: { message },
  text: message,
  controllerMode: 'ipc',
  httpFallback: false,
});

const parseBody = (body: unknown): any => {
  if (typeof body === 'string' && body.trim()) {
    return JSON.parse(body);
  }
  return body ?? {};
};

const withParams = (endpoint: string, params?: Record<string, unknown>) => {
  if (!params) return endpoint;
  const url = new URL(endpoint.startsWith('/') ? endpoint : `/${endpoint}`, 'http://mihomo');
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  });
  return `${url.pathname}${url.search}`;
};

const parseEndpoint = (endpoint: string, params?: Record<string, unknown>) => {
  const url = new URL(
    withParams(endpoint, params).startsWith('/')
      ? withParams(endpoint, params)
      : `/${withParams(endpoint, params)}`,
    'http://mihomo',
  );
  const segments = url.pathname
    .split('/')
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment));
  return { url, segments };
};

export const mihomoClient = {
  async getVersion() {
    return callMihomo((api) => api.getVersion());
  },

  async flushFakeIp() {
    return callMihomo((api) => api.flushFakeIp());
  },

  async flushDNS() {
    return callMihomo((api) => api.flushDNS());
  },

  async getRuntimeConfig() {
    return callMihomo((api) => api.getBaseConfig());
  },

  async reloadConfig(force: boolean, configPath: string) {
    return callMihomo((api) => api.reloadConfig(force, configPath));
  },

  async patchRuntimeConfig(data: Record<string, unknown>) {
    return callMihomo((api) => api.patchBaseConfig(data));
  },

  async updateGeo() {
    return callMihomo((api) => api.updateGeo());
  },

  async restart() {
    return callMihomo((api) => api.restart());
  },

  async getGroups() {
    return callMihomo((api) => api.getGroups());
  },

  async getGroupByName(groupName: string) {
    return callMihomo((api) => api.getGroupByName(groupName));
  },

  async delayGroup(groupName: string, testUrl: string, timeout: number) {
    return callMihomo((api) => api.delayGroup(groupName, testUrl, timeout));
  },

  async getProxies() {
    return callMihomo((api) => api.getProxies());
  },

  async getProxyByName(name: string) {
    return callMihomo((api) => api.getProxyByName(name));
  },

  async selectNodeForGroup(groupName: string, node: string) {
    return callMihomo((api) => api.selectNodeForGroup(groupName, node));
  },

  async unfixedProxy(groupName: string) {
    return callMihomo((api) => api.unfixedProxy(groupName));
  },

  async getConnections() {
    return callMihomo((api) => api.getConnections());
  },

  async closeConnection(id: string) {
    return callMihomo((api) => api.closeConnection(id));
  },

  async closeAllConnections() {
    return callMihomo((api) => api.closeAllConnections());
  },

  async getProxyProviders() {
    return callMihomo((api) => api.getProxyProviders());
  },

  async getProxyProviderByName(providerName: string) {
    return callMihomo((api) => api.getProxyProviderByName(providerName));
  },

  async updateProxyProvider(providerName: string) {
    return callMihomo((api) => api.updateProxyProvider(providerName));
  },

  async healthcheckProxyProvider(providerName: string) {
    return callMihomo((api) => api.healthcheckProxyProvider(providerName));
  },

  async getRules() {
    return callMihomo((api) => api.getRules());
  },

  async getRuleProviders() {
    return callMihomo((api) => api.getRuleProviders());
  },

  async updateRuleProvider(providerName: string) {
    return callMihomo((api) => api.updateRuleProvider(providerName));
  },

  async delayProxyByName(proxyName: string, testUrl: string, timeout: number) {
    return callMihomo((api) => api.delayProxyByName(proxyName, testUrl, timeout));
  },

  async connectTraffic() {
    return callMihomo((api) => api.MihomoWebSocket.connect_traffic());
  },

  async connectMemory() {
    return callMihomo((api) => api.MihomoWebSocket.connect_memory());
  },

  async connectConnections() {
    return callMihomo((api) => api.MihomoWebSocket.connect_connections());
  },

  async connectLogs(level: MihomoLogLevel | Lowercase<MihomoLogLevel>) {
    return callMihomo((api) => api.MihomoWebSocket.connect_logs(level.toUpperCase() as MihomoLogLevel));
  },

  async request<T = unknown>(
    endpoint: string,
    options: RequestLike = {},
  ): Promise<MihomoCompatResponse<T>> {
    if (endpoint.startsWith('http://') || endpoint.startsWith('https://')) {
      return toCompatError('Mihomo controller HTTP fallback is disabled') as MihomoCompatResponse<T>;
    }

    const method = (options.method || 'GET').toUpperCase();
    const { url, segments } = parseEndpoint(endpoint, options.params);
    const body = parseBody(options.body);

    try {
      const api = await loadMihomoApi();
      if (method === 'GET' && segments[0] === 'version') {
        return toCompatResponse(await api.getVersion()) as MihomoCompatResponse<T>;
      }
      if (method === 'POST' && segments.join('/') === 'cache/fakeip/flush') {
        await api.flushFakeIp();
        return toCompatResponse(null, 204) as MihomoCompatResponse<T>;
      }
      if (method === 'POST' && segments.join('/') === 'cache/dns/flush') {
        await api.flushDNS();
        return toCompatResponse(null, 204) as MihomoCompatResponse<T>;
      }
      if (method === 'GET' && segments[0] === 'configs') {
        return toCompatResponse(await api.getBaseConfig()) as MihomoCompatResponse<T>;
      }
      if (method === 'PATCH' && segments[0] === 'configs') {
        await api.patchBaseConfig(body);
        return toCompatResponse(null, 204) as MihomoCompatResponse<T>;
      }
      if (method === 'PUT' && segments[0] === 'configs') {
        if (!body?.path) return toCompatError('Missing config path') as MihomoCompatResponse<T>;
        await api.reloadConfig(url.searchParams.get('force') === 'true', String(body.path));
        return toCompatResponse(null, 204) as MihomoCompatResponse<T>;
      }
      if (method === 'POST' && segments.join('/') === 'configs/geo') {
        await api.updateGeo();
        return toCompatResponse(null, 204) as MihomoCompatResponse<T>;
      }
      if (method === 'POST' && segments[0] === 'restart') {
        await api.restart();
        return toCompatResponse(null, 204) as MihomoCompatResponse<T>;
      }
      if (method === 'GET' && segments[0] === 'connections') {
        return toCompatResponse(await api.getConnections()) as MihomoCompatResponse<T>;
      }
      if (method === 'DELETE' && segments[0] === 'connections' && !segments[1]) {
        await api.closeAllConnections();
        return toCompatResponse(null, 204) as MihomoCompatResponse<T>;
      }
      if (method === 'DELETE' && segments[0] === 'connections' && segments[1]) {
        await api.closeConnection(segments[1]);
        return toCompatResponse(null, 204) as MihomoCompatResponse<T>;
      }
      if (method === 'GET' && segments[0] === 'group' && !segments[1]) {
        return toCompatResponse(await api.getGroups()) as MihomoCompatResponse<T>;
      }
      if (method === 'GET' && segments[0] === 'group' && segments[1] && !segments[2]) {
        return toCompatResponse(await api.getGroupByName(segments[1])) as MihomoCompatResponse<T>;
      }
      if (method === 'GET' && segments[0] === 'group' && segments[1] && segments[2] === 'delay') {
        const timeout = Number(url.searchParams.get('timeout') || 10000);
        const testUrl =
          url.searchParams.get('url') || 'https://www.gstatic.com/generate_204';
        return toCompatResponse(await api.delayGroup(segments[1], testUrl, timeout)) as MihomoCompatResponse<T>;
      }
      if (method === 'GET' && segments[0] === 'proxies' && !segments[1]) {
        return toCompatResponse(await api.getProxies()) as MihomoCompatResponse<T>;
      }
      if (method === 'GET' && segments[0] === 'proxies' && segments[1] && !segments[2]) {
        return toCompatResponse(await api.getProxyByName(segments[1])) as MihomoCompatResponse<T>;
      }
      if (method === 'PUT' && segments[0] === 'proxies' && segments[1]) {
        if (!body?.name) return toCompatError('Missing proxy node name') as MihomoCompatResponse<T>;
        await api.selectNodeForGroup(segments[1], String(body.name));
        return toCompatResponse(null, 204) as MihomoCompatResponse<T>;
      }
      if (method === 'DELETE' && segments[0] === 'proxies' && segments[1]) {
        await api.unfixedProxy(segments[1]);
        return toCompatResponse(null, 204) as MihomoCompatResponse<T>;
      }
      if (method === 'GET' && segments[0] === 'proxies' && segments[2] === 'delay') {
        const timeout = Number(url.searchParams.get('timeout') || 10000);
        const testUrl =
          url.searchParams.get('url') || 'https://www.gstatic.com/generate_204';
        return toCompatResponse(await api.delayProxyByName(segments[1], testUrl, timeout)) as MihomoCompatResponse<T>;
      }
      if (method === 'GET' && segments[0] === 'rules' && !segments[1]) {
        return toCompatResponse(await api.getRules()) as MihomoCompatResponse<T>;
      }
      if (method === 'GET' && segments.join('/') === 'providers/proxies') {
        return toCompatResponse(await api.getProxyProviders()) as MihomoCompatResponse<T>;
      }
      if (method === 'GET' && segments[0] === 'providers' && segments[1] === 'proxies' && segments[2] && !segments[3]) {
        return toCompatResponse(await api.getProxyProviderByName(segments[2])) as MihomoCompatResponse<T>;
      }
      if (method === 'PUT' && segments[0] === 'providers' && segments[1] === 'proxies' && segments[2]) {
        await api.updateProxyProvider(segments[2]);
        return toCompatResponse(null, 204) as MihomoCompatResponse<T>;
      }
      if (method === 'GET' && segments[0] === 'providers' && segments[1] === 'proxies' && segments[2] && segments[3] === 'healthcheck') {
        await api.healthcheckProxyProvider(segments[2]);
        return toCompatResponse(null, 204) as MihomoCompatResponse<T>;
      }
      if (method === 'GET' && segments.join('/') === 'providers/rules') {
        return toCompatResponse(await api.getRuleProviders()) as MihomoCompatResponse<T>;
      }
      if (method === 'PUT' && segments[0] === 'providers' && segments[1] === 'rules' && segments[2]) {
        await api.updateRuleProvider(segments[2]);
        return toCompatResponse(null, 204) as MihomoCompatResponse<T>;
      }

      return toCompatError(`Unsupported Mihomo IPC endpoint: ${method} ${endpoint}`) as MihomoCompatResponse<T>;
    } catch (error) {
      markMihomoUnavailable(error);
      return toCompatError(
        error instanceof Error ? error.message : String(error),
        0,
      ) as MihomoCompatResponse<T>;
    }
  },
};
