import React, { useEffect, useState } from 'react';
import { ReloadIcon, UpdateIcon } from '@radix-ui/react-icons';

interface ProxyProvider {
  name: string;
  type: string;
  vehicleType: string;
  proxies?: any[];
  updatedAt?: string;
  subscriptionInfo?: {
    Upload: number;
    Download: number;
    Total: number;
    Expire: number;
  };
}

const ProxyProviders: React.FC = () => {
  const [providers, setProviders] = useState<ProxyProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState<{ [key: string]: boolean }>({});
  const [updatingAll, setUpdatingAll] = useState(false);

  const loadProviders = async () => {
    try {
      setLoading(true);
      const result = await window.electronAPI?.getProxyProviders();

      if (!result) {
        setProviders([]);
        return;
      }

      if (result.success && result.data && result.data.providers) {
        const providerList = Object.values(result.data.providers) as ProxyProvider[];
        // 仅显示真正的远程代理提供者，排除内联 / 文件型和代理组等配置项
        // Clash 返回的代理组没有 subscriptionInfo 字段，只保留真正的订阅提供者
        const filteredProviders = providerList.filter(p =>
          Object.prototype.hasOwnProperty.call(p, 'subscriptionInfo')
        );
        setProviders(filteredProviders);
      } else {
        setProviders([]);
      }
    } catch (error) {
      console.error('加载 Proxy Providers 失败:', error);
      setProviders([]);
    } finally {
      setLoading(false);
    }
  };

  const updateProvider = async (providerName: string) => {
    try {
      setUpdating(prev => ({ ...prev, [providerName]: true }));
      const result = await window.electronAPI?.updateProxyProvider(providerName);

      if (result && result.success) {
        // 等待一小段时间后重新加载，让 Mihomo 有时间更新
        setTimeout(() => {
          loadProviders();
        }, 500);
      }
    } catch (error) {
      console.error(`更新 ${providerName} 失败:`, error);
    } finally {
      setUpdating(prev => ({ ...prev, [providerName]: false }));
    }
  };

  const updateAllProviders = async () => {
    try {
      setUpdatingAll(true);

      // 并发更新所有 providers
      const updatePromises = providers.map(provider =>
        window.electronAPI?.updateProxyProvider(provider.name)
      );

      await Promise.allSettled(updatePromises);

      // 等待一小段时间后重新加载
      setTimeout(() => {
        loadProviders();
      }, 1000);
    } catch (error) {
      console.error('批量更新失败:', error);
    } finally {
      setUpdatingAll(false);
    }
  };

  const formatBytes = (bytes: number): string => {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
  };

  const formatDate = (dateString: string | undefined): string => {
    if (!dateString) return '未知';

    try {
      const date = new Date(dateString);
      const now = new Date();
      const diffMs = now.getTime() - date.getTime();
      const diffMins = Math.floor(diffMs / 60000);
      const diffHours = Math.floor(diffMs / 3600000);
      const diffDays = Math.floor(diffMs / 86400000);

      if (diffMins < 1) return '刚刚';
      if (diffMins < 60) return `${diffMins} 分钟前`;
      if (diffHours < 24) return `${diffHours} 小时前`;
      if (diffDays < 7) return `${diffDays} 天前`;

      return date.toLocaleDateString('zh-CN');
    } catch (e) {
      return '未知';
    }
  };

  const formatExpireDate = (timestamp: number): string => {
    if (!timestamp) return '永不过期';

    try {
      const date = new Date(timestamp * 1000);
      return date.toLocaleDateString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      });
    } catch (e) {
      return '未知';
    }
  };

  useEffect(() => {
    loadProviders();
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-muted-foreground">加载中...</div>
      </div>
    );
  }

  if (providers.length === 0) {
    return null; // 如果没有 providers，不显示这个部分
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-foreground">
          代理提供者
        </h2>
        <button
          onClick={updateAllProviders}
          disabled={updatingAll}
          className="px-4 py-2 bg-primary hover:bg-primary/90 disabled:bg-muted disabled:text-muted-foreground text-primary-foreground rounded-lg flex items-center gap-2 transition-colors"
        >
          <UpdateIcon className={updatingAll ? 'animate-spin' : ''} />
          {updatingAll ? '更新中...' : '全部更新'}
        </button>
      </div>

      <div className="space-y-3">
        {providers.map((provider) => (
          <div key={provider.name} className="bg-white dark:bg-[#2a2a2a] rounded-xl p-6 shadow-sm hover:shadow-md transition-shadow">
            <div className="flex items-start justify-between mb-4">
              <div className="flex-1">
                <div className="flex items-center gap-3">
                  <h3 className="text-base font-medium text-foreground">
                    {provider.name}
                  </h3>
                  <span className="px-2 py-1 bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 text-xs rounded-md">
                    {provider.proxies?.length || 0} 节点
                  </span>
                </div>
                <div className="mt-2 flex items-center gap-4 text-sm text-muted-foreground">
                  <span>更新时间: {formatDate(provider.updatedAt)}</span>
                  <span>类型: {provider.vehicleType}</span>
                </div>
              </div>

              <button
                onClick={() => updateProvider(provider.name)}
                disabled={updating[provider.name]}
                className="px-3 py-2 bg-muted hover:bg-muted/80 text-foreground rounded-lg flex items-center gap-2 transition-colors disabled:opacity-50"
              >
                <ReloadIcon className={updating[provider.name] ? 'animate-spin' : ''} />
                {updating[provider.name] ? '更新中' : '更新'}
              </button>
            </div>

            {provider.subscriptionInfo && (
              <div className="p-4 bg-muted/30 dark:bg-muted/10 rounded-lg">
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <span className="text-muted-foreground">已用流量: </span>
                    <span className="text-foreground font-medium">
                      {formatBytes(provider.subscriptionInfo.Upload + provider.subscriptionInfo.Download)}
                      {' / '}
                      {formatBytes(provider.subscriptionInfo.Total)}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">过期时间: </span>
                    <span className="text-foreground font-medium">
                      {formatExpireDate(provider.subscriptionInfo.Expire)}
                    </span>
                  </div>
                </div>

                {provider.subscriptionInfo.Total > 0 && (
                  <div className="mt-3">
                    <div className="flex justify-between text-xs text-muted-foreground mb-1">
                      <span>流量使用情况</span>
                      <span>
                        {Math.round(((provider.subscriptionInfo.Upload + provider.subscriptionInfo.Download) / provider.subscriptionInfo.Total) * 100)}%
                      </span>
                    </div>
                    <div className="w-full bg-muted/50 rounded-full h-2">
                      <div
                        className="bg-primary h-2 rounded-full transition-all"
                        style={{
                          width: `${Math.min(((provider.subscriptionInfo.Upload + provider.subscriptionInfo.Download) / provider.subscriptionInfo.Total) * 100, 100)}%`
                        }}
                      />
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

export default ProxyProviders;
