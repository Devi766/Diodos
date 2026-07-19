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

const CONFIG_PATCH_KEY_MAP: Record<string, string> = {
  allowLan: 'allow-lan',
  bindAddress: 'bind-address',
  disableKeepAlive: 'disable-keep-alive',
  findProcessMode: 'find-process-mode',
  geoAutoUpdate: 'geo-auto-update',
  geodataLoader: 'geodata-loader',
  geodataMode: 'geodata-mode',
  geositeMatcher: 'geosite-matcher',
  geoUpdateInterval: 'geo-update-interval',
  geoxUrl: 'geox-url',
  globalUa: 'global-ua',
  inboundMptcp: 'inbound-mptcp',
  inboundTfo: 'inbound-tfo',
  interfaceName: 'interface-name',
  keepAliveIdle: 'keep-alive-idle',
  keepAliveInterval: 'keep-alive-interval',
  lanAllowedIps: 'lan-allowed-ips',
  lanDisallowedIps: 'lan-disallowed-ips',
  logLevel: 'log-level',
  mixedPort: 'mixed-port',
  redirPort: 'redir-port',
  routingMark: 'routing-mark',
  skipAuthPrefixes: 'skip-auth-prefixes',
  socksPort: 'socks-port',
  tcpConcurrent: 'tcp-concurrent',
  tproxyPort: 'tproxy-port',
  unifiedDelay: 'unified-delay',
};

const normalizeGeoxUrlPatch = (value: unknown) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  return {
    'geo-ip': record['geo-ip'] ?? record.geoIp ?? record.geoip,
    'geo-site': record['geo-site'] ?? record.geoSite ?? record.geosite,
    mmdb: record.mmdb,
    asn: record.asn,
  };
};

const normalizeRuntimeConfigPatch = (body: unknown): Record<string, unknown> => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return {};

  return Object.fromEntries(
    Object.entries(body as Record<string, unknown>).map(([key, value]) => {
      const normalizedKey = CONFIG_PATCH_KEY_MAP[key] || key;
      const normalizedValue = normalizedKey === 'geox-url' ? normalizeGeoxUrlPatch(value) : value;
      return [normalizedKey, normalizedValue];
    }),
  );
};

const fromCompatBridgeResponse = async <T>(response: any): Promise<MihomoCompatResponse<T>> => {
  const data =
    typeof response?.json === 'function'
      ? await response.json()
      : response?.data;
  const text =
    typeof response?.text === 'function'
      ? await response.text()
      : typeof response?.text === 'string'
        ? response.text
        : data == null
          ? ''
          : JSON.stringify(data);

  return {
    ok: !!response?.ok,
    status: Number(response?.status ?? (response?.ok ? 200 : 0)),
    statusText: String(response?.statusText ?? ''),
    headers: response?.headers || {},
    data,
    text,
    controllerMode: 'ipc',
    httpFallback: false,
  };
};

const requestViaCompatBridge = async <T>(
  endpoint: string,
  method: string,
  body: unknown,
): Promise<MihomoCompatResponse<T>> => {
  const invoke =
    typeof window !== 'undefined' ? (window as any).__TAURI__?.core?.invoke : undefined;
  if (typeof invoke !== 'function') {
    return toCompatError('Mihomo IPC compat bridge is unavailable') as MihomoCompatResponse<T>;
  }

  return fromCompatBridgeResponse<T>(
    await invoke('tauri_compat_call', {
      request: {
        method: 'requestMihomoAPI',
        args: [
          endpoint,
          {
            method,
            body,
          },
        ],
      },
    }),
  );
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

const requestViaBackendIpc = async <T = any>(
  endpoint: string,
  options: RequestLike = {},
): Promise<MihomoCompatResponse<T>> => {
  if (endpoint.startsWith('http://') || endpoint.startsWith('https://')) {
    return toCompatError('Mihomo controller HTTP fallback is disabled') as MihomoCompatResponse<T>;
  }

  const method = (options.method || 'GET').toUpperCase();
  const body = parseBody(options.body);
  return requestViaCompatBridge<T>(withParams(endpoint, options.params), method, body);
};

const assertOk = <T>(response: MihomoCompatResponse<T>): T => {
  if (response.ok) return response.data;

  const data = response.data as any;
  const message =
    (typeof data === 'string' ? data : data?.message || data?.error) ||
    response.statusText ||
    response.text ||
    'Mihomo IPC request failed';
  const error = new Error(String(message));
  (error as Error & { status?: number }).status = response.status;
  throw error;
};

const bridgeData = async <T = any>(
  endpoint: string,
  options: RequestLike = {},
): Promise<T> => {
  try {
    return assertOk(await requestViaBackendIpc<T>(endpoint, options));
  } catch (error) {
    markMihomoUnavailable(error);
    throw error;
  }
};

const encoded = (value: string) => encodeURIComponent(value);

export const mihomoClient = {
  async getVersion() {
    return bridgeData('/version');
  },

  async flushFakeIp() {
    return bridgeData('/cache/fakeip/flush', { method: 'POST' });
  },

  async flushDNS() {
    return bridgeData('/cache/dns/flush', { method: 'POST' });
  },

  async getRuntimeConfig() {
    return bridgeData('/configs');
  },

  async reloadConfig(force: boolean, configPath: string) {
    return bridgeData(`/configs?force=${force ? 'true' : 'false'}`, {
      method: 'PUT',
      body: { path: configPath },
    });
  },

  async patchRuntimeConfig(data: Record<string, unknown>) {
    return bridgeData('/configs', {
      method: 'PATCH',
      body: normalizeRuntimeConfigPatch(data),
    });
  },

  async updateGeo() {
    return bridgeData('/configs/geo', { method: 'POST' });
  },

  async restart() {
    return bridgeData('/restart', { method: 'POST' });
  },

  async getGroups() {
    return bridgeData('/group');
  },

  async getGroupByName(groupName: string) {
    return bridgeData(`/group/${encoded(groupName)}`);
  },

  async delayGroup(groupName: string, testUrl: string, timeout: number) {
    return bridgeData(`/group/${encoded(groupName)}/delay`, {
      params: { url: testUrl, timeout },
    });
  },

  async getProxies() {
    return bridgeData('/proxies');
  },

  async getProxyByName(name: string) {
    return bridgeData(`/proxies/${encoded(name)}`);
  },

  async selectNodeForGroup(groupName: string, node: string) {
    return bridgeData(`/proxies/${encoded(groupName)}`, {
      method: 'PUT',
      body: { name: node },
    });
  },

  async unfixedProxy(groupName: string) {
    return bridgeData(`/proxies/${encoded(groupName)}`, { method: 'DELETE' });
  },

  async getConnections() {
    return bridgeData('/connections');
  },

  async closeConnection(id: string) {
    return bridgeData(`/connections/${encoded(id)}`, { method: 'DELETE' });
  },

  async closeAllConnections() {
    return bridgeData('/connections', { method: 'DELETE' });
  },

  async getProxyProviders() {
    return bridgeData('/providers/proxies');
  },

  async getProxyProviderByName(providerName: string) {
    return bridgeData(`/providers/proxies/${encoded(providerName)}`);
  },

  async updateProxyProvider(providerName: string) {
    return bridgeData(`/providers/proxies/${encoded(providerName)}`, { method: 'PUT' });
  },

  async healthcheckProxyProvider(providerName: string) {
    return bridgeData(`/providers/proxies/${encoded(providerName)}/healthcheck`);
  },

  async getRules() {
    return bridgeData('/rules');
  },

  async getRuleProviders() {
    return bridgeData('/providers/rules');
  },

  async updateRuleProvider(providerName: string) {
    return bridgeData(`/providers/rules/${encoded(providerName)}`, { method: 'PUT' });
  },

  async delayProxyByName(proxyName: string, testUrl: string, timeout: number) {
    return bridgeData(`/proxies/${encoded(proxyName)}/delay`, {
      params: { url: testUrl, timeout },
    });
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
    try {
      return await requestViaBackendIpc<T>(endpoint, options);
    } catch (error) {
      markMihomoUnavailable(error);
      return toCompatError(
        error instanceof Error ? error.message : String(error),
        0,
      ) as MihomoCompatResponse<T>;
    }
  },
};
