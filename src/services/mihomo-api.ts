import { ofetch } from 'ofetch'

export interface MihomoConfig {
  port: number
  mode: string
  ipv6: boolean
  'allow-lan': boolean
  'log-level': string
  'mixed-port': number
  'redir-port': number
  'socks-port': number
  'external-controller': string
  secret: string
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

export const useMihomoAPI = (controllerConfig?: { host?: string; port?: string; secret?: string }) => {
  // 使用默认值，如果没有提供自定义配置
  const host = controllerConfig?.host || '127.0.0.1';
  const port = controllerConfig?.port || '9090';
  
  /**
   * 创建统一的请求函数
   * 1. 优先使用electronAPI.requestMihomoAPI (自动添加密钥认证)
   * 2. 如果electronAPI不可用，使用带认证头的ofetch
   */
  const makeRequest = async <T = any>(endpoint: string, options: any = {}) => {
    try {
      // 判断是否在browser环境中有electronAPI
      if (typeof window !== 'undefined' && window.electronAPI?.requestMihomoAPI) {
        // 转换params为URL查询参数
        if (options.params) {
          const url = new URL(endpoint.startsWith('http') ? endpoint : `http://${host}:${port}${endpoint.startsWith('/') ? endpoint : '/' + endpoint}`);
          Object.entries(options.params).forEach(([key, value]) => {
            if (value !== undefined) {
              url.searchParams.append(key, String(value));
            }
          });
          
          // 替换endpoint为带查询参数的URL
          endpoint = endpoint.startsWith('http') ? url.toString() : url.pathname + url.search;
        }
        
        // 准备请求选项
        const requestOptions: RequestInit = {
          method: options.method || 'GET',
          headers: {
            'Content-Type': 'application/json',
            ...(options.headers || {})
          }
        };
        
        // Always try to fetch the secret from electronAPI
        if (requestOptions.headers) {
          try {
            // 先尝试从electronAPI获取最新的密钥
            const apiConfig = await window.electronAPI.getApiConfig();
            if (apiConfig.success && apiConfig.secret) {
              // 确保headers是一个对象并添加Authorization头
              if (typeof requestOptions.headers === 'object') {
                (requestOptions.headers as Record<string, string>)['Authorization'] = `Bearer ${apiConfig.secret}`;
              }
            }
          } catch (error) {
            // 忽略错误
          }
        }
        
        // 添加请求体
        if (options.body) {
          requestOptions.body = JSON.stringify(options.body);
        }
        
        try {
          // 发送请求
          const response = await window.electronAPI.requestMihomoAPI(endpoint, requestOptions);
          
          // 检查响应是否存在
          if (!response) {
            throw new Error('API请求失败: 响应对象为空');
          }
          
          // 返回JSON数据
          if (response.ok) {
            // 对于DELETE请求，可能不返回内容 (或者 response.data 可能为 null/undefined)
            if (options.method === 'DELETE' || response.status === 204) {
              return {} as T; // 或者可以返回 response.data 如果它有意义
            }
            
            return response.data as T;
          }
          
          // 处理错误响应
          const errorStatus = response.status || '未知状态码';
          const errorText = response.statusText || '未知错误';
          // 尝试从 response.data 获取更详细的错误信息
          const detailError = typeof response.data === 'string' ? response.data : (response.data?.message || errorText);
          throw new Error(`API请求失败: ${errorStatus} ${detailError}`);
        } catch (requestError) {
          // 检查是否是mihomo服务未运行
          const errorMsg = requestError instanceof Error ? requestError.message : String(requestError);
          if (errorMsg.includes('ECONNREFUSED') || errorMsg.includes('Failed to fetch')) {
            throw new Error('Mihomo服务未运行或无法访问');
          }
          
          throw requestError;
        }
      }
      
      // 备用方案：使用ofetch
      // 创建带认证头的ofetch实例
      const baseURL = `http://${host}:${port}`;
      const headers: Record<string, string> = {};
      
      // For ofetch fallback, attempt to get secret from electronAPI if possible, 
      // or use controllerConfig.secret if provided directly to useMihomoAPI (less common for UI calls)
      let authorizationHeader = '';
      if (typeof window !== 'undefined' && window.electronAPI?.getApiConfig) {
        try {
          const apiConfig = await window.electronAPI.getApiConfig();
          if (apiConfig.success && apiConfig.secret) {
            authorizationHeader = `Bearer ${apiConfig.secret}`;
          }
        } catch (e) {
          // 忽略错误
        }
      } else if (controllerConfig?.secret) {
        authorizationHeader = `Bearer ${controllerConfig.secret}`;
      }

      if (authorizationHeader) {
        headers['Authorization'] = authorizationHeader;
      }
      
      // 创建ofetch实例
      const request = ofetch.create({
        baseURL,
        headers
      });
      
      try {
        // 使用ofetch发送请求
        return await request<T>(endpoint, options);
      } catch (ofetchError) {
        // 检查是否是mihomo服务未运行
        const errorMsg = ofetchError instanceof Error ? ofetchError.message : String(ofetchError);
        if (errorMsg.includes('ECONNREFUSED') || errorMsg.includes('Failed to fetch')) {
          throw new Error('Mihomo服务未运行或无法访问');
        }
        
        throw ofetchError;
      }
    } catch (error) {
      throw error;
    }
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
        size?: number
        extra?: {
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
    proxyProviders,
    updateProxyProvider,
    ruleProviders,
    updateRuleProvider,
    upgradeGeo,
  }
}