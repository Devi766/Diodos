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

const loadMihomoApi = (): Promise<MihomoApiModule> =>
  import('tauri-plugin-mihomo-api');

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
    return (await loadMihomoApi()).getVersion();
  },

  async getRuntimeConfig() {
    return (await loadMihomoApi()).getBaseConfig();
  },

  async patchRuntimeConfig(data: Record<string, unknown>) {
    return (await loadMihomoApi()).patchBaseConfig(data);
  },

  async getProxies() {
    return (await loadMihomoApi()).getProxies();
  },

  async getProxyByName(name: string) {
    return (await loadMihomoApi()).getProxyByName(name);
  },

  async selectNodeForGroup(groupName: string, node: string) {
    return (await loadMihomoApi()).selectNodeForGroup(groupName, node);
  },

  async getConnections() {
    return (await loadMihomoApi()).getConnections();
  },

  async closeConnection(id: string) {
    return (await loadMihomoApi()).closeConnection(id);
  },

  async closeAllConnections() {
    return (await loadMihomoApi()).closeAllConnections();
  },

  async getProxyProviders() {
    return (await loadMihomoApi()).getProxyProviders();
  },

  async updateProxyProvider(providerName: string) {
    return (await loadMihomoApi()).updateProxyProvider(providerName);
  },

  async getRuleProviders() {
    return (await loadMihomoApi()).getRuleProviders();
  },

  async updateRuleProvider(providerName: string) {
    return (await loadMihomoApi()).updateRuleProvider(providerName);
  },

  async delayProxyByName(proxyName: string, testUrl: string, timeout: number) {
    return (await loadMihomoApi()).delayProxyByName(proxyName, testUrl, timeout);
  },

  async connectTraffic() {
    return (await loadMihomoApi()).MihomoWebSocket.connect_traffic();
  },

  async connectMemory() {
    return (await loadMihomoApi()).MihomoWebSocket.connect_memory();
  },

  async connectConnections() {
    return (await loadMihomoApi()).MihomoWebSocket.connect_connections();
  },

  async connectLogs(level: MihomoLogLevel | Lowercase<MihomoLogLevel>) {
    const api = await loadMihomoApi();
    return api.MihomoWebSocket.connect_logs(level.toUpperCase() as MihomoLogLevel);
  },

  async request<T = unknown>(
    endpoint: string,
    options: RequestLike = {},
  ): Promise<MihomoCompatResponse<T>> {
    if (endpoint.startsWith('http://') || endpoint.startsWith('https://')) {
      return toCompatError('Mihomo controller HTTP fallback is disabled') as MihomoCompatResponse<T>;
    }

    const api = await loadMihomoApi();
    const method = (options.method || 'GET').toUpperCase();
    const { url, segments } = parseEndpoint(endpoint, options.params);
    const body = parseBody(options.body);

    try {
      if (method === 'GET' && segments[0] === 'version') {
        return toCompatResponse(await api.getVersion()) as MihomoCompatResponse<T>;
      }
      if (method === 'GET' && segments[0] === 'configs') {
        return toCompatResponse(await api.getBaseConfig()) as MihomoCompatResponse<T>;
      }
      if (method === 'PATCH' && segments[0] === 'configs') {
        await api.patchBaseConfig(body);
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
      if (method === 'GET' && segments[0] === 'proxies' && segments[2] === 'delay') {
        const timeout = Number(url.searchParams.get('timeout') || 10000);
        const testUrl =
          url.searchParams.get('url') || 'https://www.gstatic.com/generate_204';
        return toCompatResponse(await api.delayProxyByName(segments[1], testUrl, timeout)) as MihomoCompatResponse<T>;
      }
      if (method === 'GET' && segments.join('/') === 'providers/proxies') {
        return toCompatResponse(await api.getProxyProviders()) as MihomoCompatResponse<T>;
      }
      if (method === 'PUT' && segments[0] === 'providers' && segments[1] === 'proxies' && segments[2]) {
        await api.updateProxyProvider(segments[2]);
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
      return toCompatError(
        error instanceof Error ? error.message : String(error),
        0,
      ) as MihomoCompatResponse<T>;
    }
  },
};
