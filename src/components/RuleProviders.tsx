import React, { useEffect, useState } from 'react';
import { ReloadIcon, UpdateIcon } from '@radix-ui/react-icons';

interface RuleProvider {
  name: string;
  type: string;
  vehicleType: string;
  behavior: string;
  format: string;
  ruleCount: number;
  updatedAt?: string;
}

const RuleProviders: React.FC = () => {
  const [providers, setProviders] = useState<RuleProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState<{ [key: string]: boolean }>({});
  const [updatingAll, setUpdatingAll] = useState(false);

  const loadProviders = async () => {
    try {
      setLoading(true);
      const result = await window.electronAPI?.getRuleProviders();

      if (!result) {
        setProviders([]);
        return;
      }

      if (result.success && result.data && result.data.providers) {
        const providerList = Object.values(result.data.providers) as RuleProvider[];
        setProviders(providerList);
      } else {
        setProviders([]);
      }
    } catch (error) {
      console.error('加载 Rule Providers 失败:', error);
      setProviders([]);
    } finally {
      setLoading(false);
    }
  };

  const updateProvider = async (providerName: string) => {
    try {
      setUpdating(prev => ({ ...prev, [providerName]: true }));
      const result = await window.electronAPI?.updateRuleProvider(providerName);

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
        window.electronAPI?.updateRuleProvider(provider.name)
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
          规则提供者
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
            <div className="flex items-start justify-between">
              <div className="flex-1">
                <div className="flex items-center gap-3">
                  <h3 className="text-base font-medium text-foreground">
                    {provider.name}
                  </h3>
                  <span className="px-2 py-1 bg-green-50 dark:bg-green-900/20 text-green-600 dark:text-green-400 text-xs rounded-md">
                    {provider.ruleCount} 规则
                  </span>
                </div>
                <div className="mt-2 flex items-center gap-4 text-sm text-muted-foreground">
                  <span>更新时间: {formatDate(provider.updatedAt)}</span>
                  <span>格式: {provider.format}</span>
                  <span>类型: {provider.vehicleType}::{provider.behavior}</span>
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
          </div>
        ))}
      </div>
    </div>
  );
};

export default RuleProviders;
