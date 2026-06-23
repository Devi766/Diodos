import { mihomoClient } from './mihomo-client'

export interface MihomoConfig {
  port: number
  mode: string
  ipv6: boolean
  allowLan?: boolean
  'allow-lan': boolean
  logLevel?: string
  'log-level': string
  mixedPort?: number
  'mixed-port': number
  redirPort?: number
  'redir-port': number
  socksPort?: number
  'socks-port': number
  'external-controller': string
  secret: string
  geoxUrl?: {
    geoIp?: string
    geoSite?: string
    geoip?: string
    geosite?: string
    mmdb?: string
    asn?: string
  }
  'geox-url'?: {
    geoip?: string
    geosite?: string
    'geo-ip'?: string
    'geo-site'?: string
    mmdb?: string
    asn?: string
  }
  geodataMode?: boolean
  'geodata-mode'?: boolean
  geoAutoUpdate?: boolean
  'geo-auto-update'?: boolean
  geoUpdateInterval?: number
  'geo-update-interval'?: number
}

export interface MihomoVersion {
  premium?: boolean
  meta?: boolean
  version: string
}

export interface MihomoProxyGroupItem {
  name: string
  type: string
  now?: string
  all?: string[]
  history?: {
    time: string
    delay: number
  }[]
  udp?: boolean
  xudp?: boolean
}

export type MihomoDelayOptions = {
  url?: string
  timeout?: number
}

export const useMihomoAPI = (controllerConfig?: {
  host?: string | null
  port?: string | null
  secret?: string | null
  controllerMode?: 'ipc' | 'socket' | 'http'
  httpFallback?: boolean
}) => {
  void controllerConfig;
  
  /**
   * 创建统一的 IPC 请求函数。
   * 旧 API 仍保留 endpoint 形状，但内部只走 tauri-plugin-mihomo-api。
   */
  const makeRequest = async <T = any>(endpoint: string, options: any = {}) => {
    const response = await mihomoClient.request<T>(endpoint, options);
    if (response.ok) {
      if (options.method === 'DELETE' || response.status === 204) {
        return {} as T;
      }
      return response.data as T;
    }

    const detailError =
      typeof response.data === 'string'
        ? response.data
        : ((response.data as any)?.message ?? response.statusText);
    throw new Error(`API请求失败: ${response.status || '未知状态码'} ${detailError}`);
  };

  /**
   * 获取Mihomo配置
   */
  const configs = async () => {
    return await makeRequest<MihomoConfig>('/configs');
  }

  /**
   * 更新Mihomo配置
   */
  const patchConfigs = async (config: Partial<MihomoConfig>) => {
    return await makeRequest<MihomoConfig>('/configs', {
      method: 'PATCH',
      body: config,
    });
  }

  /**
   * 删除指定连接或所有连接
   */
  const deleteConnections = async (id?: string) => {
    const url = id ? `/connections/${id}` : '/connections';
    return await makeRequest(url, {
      method: 'DELETE',
    });
  }

  /**
   * 获取版本信息
   */
  const version = async () => {
    return await makeRequest<MihomoVersion>('/version');
  }

  /**
   * 获取代理延迟
   */
  const proxiesDelay = async (name: string, options?: MihomoDelayOptions) => {
    return await makeRequest<{ delay: number }>(
      `/proxies/${encodeURIComponent(name)}/delay`,
      {
        params: {
          timeout: options?.timeout || 10000,
          url: options?.url || 'http://www.gstatic.com/generate_204',
        },
      },
    );
  }

  /**
   * 获取代理组延迟（测试组内所有节点）
   */
  const groupDelay = async (group: string, options?: MihomoDelayOptions) => {
    return await makeRequest<Record<string, number>>(
      `/group/${encodeURIComponent(group)}/delay`,
      {
        params: {
          timeout: options?.timeout || 10000,
          url: options?.url || 'http://www.gstatic.com/generate_204',
        },
      },
    );
  }

  /**
   * 获取所有代理信息
   */
  const proxies = async () => {
    return await makeRequest<{
      proxies: Record<string, MihomoProxyGroupItem>
    }>('/proxies');
  }

  /**
   * 切换代理节点
   */
  const putProxies = async ({
    group,
    proxy,
  }: {
    group: string
    proxy: string
  }) => {
    return await makeRequest(`/proxies/${encodeURIComponent(group)}`, {
      method: 'PUT',
      body: { name: proxy },
    });
  }

  /**
   * 获取连接信息
   */
  const connections = async () => {
    return await makeRequest('/connections');
  }

  /**
   * 获取匹配规则列表
   */
  const matchRules = async () => {
    return await makeRequest<{
      rules: Array<{
        type: string
        payload: string
        proxy: string
        index?: number
        size?: number
        extra?: {
          disabled?: boolean
          hitCount?: number
          missCount?: number
          hitAt?: string
          missAt?: string
        }
      }>
    }>('/rules');
  }

  /**
   * 获取代理提供者列表
   */
  const proxyProviders = async () => {
    return await makeRequest<{
      providers: Record<string, {
        name: string
        vehicleType: string
        proxies?: Array<{ name: string; type: string }>
        updatedAt?: string
        subscriptionInfo?: {
          Upload: number
          Download: number
          Total: number
          Expire: number
        }
      }>
    }>('/providers/proxies');
  }

  /**
   * 更新代理提供者
   */
  const updateProxyProvider = async (providerName: string) => {
    return await makeRequest(`/providers/proxies/${encodeURIComponent(providerName)}`, {
      method: 'PUT'
    });
  }

  /**
   * 获取规则提供者列表
   */
  const ruleProviders = async () => {
    return await makeRequest<{
      providers: Record<string, {
        name: string
        vehicleType: string
        ruleCount: number
        updatedAt?: string
        behavior?: string
      }>
    }>('/providers/rules');
  }

  /**
   * 更新规则提供者
   */
  const updateRuleProvider = async (providerName: string) => {
    return await makeRequest(`/providers/rules/${encodeURIComponent(providerName)}`, {
      method: 'PUT'
    });
  }

  /**
   * 更新 GeoData 数据库
   */
  const upgradeGeo = async () => {
    return await makeRequest('/configs/geo', {
      method: 'POST'
    });
  }

  /**
   * 切换规则启用/禁用状态
   * @param data - { [ruleIndex]: boolean } true=禁用, false=启用
   */
  const toggleRuleDisabled = async (data: Record<number, boolean>) => {
    return await makeRequest('/rules/disable', {
      method: 'PATCH',
      body: data,
    });
  }

  return {
    configs,
    patchConfigs,
    deleteConnections,
    version,
    proxiesDelay,
    groupDelay,
    proxies,
    putProxies,
    connections,
    matchRules,
    toggleRuleDisabled,
    proxyProviders,
    updateProxyProvider,
    ruleProviders,
    updateRuleProvider,
    upgradeGeo,
  }
}
