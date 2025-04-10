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

export const useMihomoAPI = () => {
  const baseURL = 'http://127.0.0.1:9090'

  const request = ofetch.create({
    baseURL,
    headers: {},
  })

  /**
   * 获取Mihomo配置
   */
  const configs = async () => {
    return await request<MihomoConfig>('/configs')
  }

  /**
   * 更新Mihomo配置
   */
  const patchConfigs = async (config: Partial<MihomoConfig>) => {
    return await request<MihomoConfig>('/configs', {
      method: 'PATCH',
      body: config,
    })
  }

  /**
   * 删除指定连接或所有连接
   */
  const deleteConnections = async (id?: string) => {
    const url = id ? `/connections/${id}` : '/connections'
    return await request(url, {
      method: 'DELETE',
    })
  }

  /**
   * 获取版本信息
   */
  const version = async () => {
    return await request<MihomoVersion>('/version')
  }

  /**
   * 获取代理延迟
   */
  const proxiesDelay = async (name: string, options?: MihomoDelayOptions) => {
    return await request<{ delay: number }>(
      `/proxies/${encodeURIComponent(name)}/delay`,
      {
        params: {
          timeout: options?.timeout || 10000,
          url: options?.url || 'http://www.gstatic.com/generate_204',
        },
      },
    )
  }

  /**
   * 获取所有代理信息
   */
  const proxies = async () => {
    return await request<{
      proxies: Record<string, MihomoProxyGroupItem>
    }>('/proxies')
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
    return await request(`/proxies/${encodeURIComponent(group)}`, {
      method: 'PUT',
      body: { name: proxy },
    })
  }

  /**
   * 获取连接信息
   */
  const connections = async () => {
    return await request('/connections')
  }

  return {
    configs,
    patchConfigs,
    deleteConnections,
    version,
    proxiesDelay,
    proxies,
    putProxies,
    connections,
  }
} 