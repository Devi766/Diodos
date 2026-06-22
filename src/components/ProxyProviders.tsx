import React, { useCallback, useEffect, useRef, useState } from 'react';
import { CheckIcon, ReloadIcon, UpdateIcon } from '@radix-ui/react-icons';
import { useTranslation } from 'react-i18next';
import { showToast } from '@/components/ui/toast';
import {
  APP_DATA_CACHE_KEYS,
  hasAppDataCache,
  readAppDataCache,
  subscribeAppDataCache,
  writeAppDataCache,
} from '@/services/app-data-cache';

const TAURI_RUNTIME_UNAVAILABLE = 'Tauri runtime is not available';

const hasElectronMethod = <K extends string>(api: unknown, method: K): api is Record<K, (...args: any[]) => Promise<any>> => {
  try {
    return !!api && typeof (api as Record<string, unknown>)[method] === 'function';
  } catch {
    return false;
  }
};

const providerMap = (result: any) => {
  return result?.data?.providers ?? result?.providers ?? result?.data?.data?.providers;
};

const notifyProfileUpdated = () => {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('profile-updated', { detail: { source: 'proxy-providers' } }));
  }
};

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

const proxyProvidersViewCache: {
  providers: ProxyProvider[];
  loaded: boolean;
} = {
  providers: [],
  loaded: false,
};

const PROXY_PROVIDERS_CACHE_KEY = APP_DATA_CACHE_KEYS.proxyProviders;

const readProxyProvidersSessionCache = (): ProxyProvider[] | null => {
  const cached = readAppDataCache<unknown>(PROXY_PROVIDERS_CACHE_KEY);
  return Array.isArray(cached) ? cached as ProxyProvider[] : null;
};

const hydrateProxyProvidersFromSession = () => {
  if (proxyProvidersViewCache.loaded) return;
  const cached = readProxyProvidersSessionCache();
  if (!cached) return;
  proxyProvidersViewCache.providers = cached;
  proxyProvidersViewCache.loaded = true;
};

const ProxyProviders: React.FC = () => {
  const { t, i18n } = useTranslation();
  const [providers, setProviders] = useState<ProxyProvider[]>(() => {
    hydrateProxyProvidersFromSession();
    return proxyProvidersViewCache.providers;
  });
  const [loading, setLoading] = useState(() => !proxyProvidersViewCache.loaded);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [updating, setUpdating] = useState<{ [key: string]: boolean }>({});
  const [updatingAll, setUpdatingAll] = useState(false);
  const [updatedProviderNames, setUpdatedProviderNames] = useState<string[]>([]);
  const providersRef = useRef(providers);

  const formatProviderError = useCallback((error: unknown, fallback = t('providers.updateFailed')) => {
    const message = error instanceof Error ? error.message : (error ? String(error) : fallback);
    return message.includes(TAURI_RUNTIME_UNAVAILABLE) ? t('providers.apiUnavailable') : message;
  }, [t]);

  useEffect(() => {
    proxyProvidersViewCache.providers = providers;
    providersRef.current = providers;
  }, [providers]);

  useEffect(() => {
    if (!loading) {
      proxyProvidersViewCache.loaded = true;
    }
  }, [loading]);

  useEffect(() => {
    return subscribeAppDataCache(PROXY_PROVIDERS_CACHE_KEY, () => {
      const cached = readProxyProvidersSessionCache();
      if (!cached) return;
      proxyProvidersViewCache.providers = cached;
      proxyProvidersViewCache.loaded = true;
      setProviders(cached);
      setLoading(false);
    });
  }, []);

  const loadProviders = useCallback(async () => {
    const coldLoad =
      providersRef.current.length === 0 &&
      !proxyProvidersViewCache.loaded &&
      !hasAppDataCache(PROXY_PROVIDERS_CACHE_KEY);
    try {
      if (coldLoad) setLoading(true);
      setLoadError(null);
      const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
      if (!hasElectronMethod(api, 'getProxyProviders')) {
        throw new Error(t('providers.apiUnavailable'));
      }

      const result = await api.getProxyProviders();
      if (!result || result.success !== true) {
        throw new Error(formatProviderError(result?.error, t('providers.loadProxyFailedFallback')));
      }

      const providersRecord = providerMap(result);
      if (providersRecord && typeof providersRecord === 'object') {
        const providerList = Object.values(providersRecord) as ProxyProvider[];
        // 仅显示真正的远程代理提供者，排除内联 / 文件型和代理组等配置项
        // Clash 返回的代理组没有 subscriptionInfo 字段，只保留真正的订阅提供者
        const filteredProviders = providerList.filter(p =>
          Object.prototype.hasOwnProperty.call(p, 'subscriptionInfo')
        );
        writeAppDataCache(PROXY_PROVIDERS_CACHE_KEY, filteredProviders);
        setProviders(filteredProviders);
      } else {
        writeAppDataCache(PROXY_PROVIDERS_CACHE_KEY, []);
        setProviders([]);
      }
    } catch (error) {
      console.error('加载 Proxy Providers 失败:', error);
      if (providersRef.current.length === 0 && !proxyProvidersViewCache.loaded) {
        setProviders([]);
      }
      setLoadError(t('providers.loadProxyFailed', { error: formatProviderError(error, t('providers.loadProxyFailedFallback')) }));
    } finally {
      if (coldLoad) setLoading(false);
    }
  }, [formatProviderError, t]);

  const updateProvider = async (providerName: string) => {
    const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
    if (!hasElectronMethod(api, 'updateProxyProvider')) {
      showToast({
        message: t('providers.proxyUpdateFailed', {
          name: providerName,
          error: t('providers.apiUnavailable'),
        }),
        type: 'error',
      });
      return;
    }

    try {
      setUpdating(prev => ({ ...prev, [providerName]: true }));
      const result = await api.updateProxyProvider(providerName);

      if (!result || !result.success) {
        throw new Error(formatProviderError(result?.error));
      }

      showToast({
        message: t('providers.proxyUpdateSuccess', { name: providerName }),
        type: 'success',
      });
      setUpdatedProviderNames([providerName]);
      notifyProfileUpdated();

      // 等待一小段时间后重新加载，让 Mihomo 有时间更新
      setTimeout(() => {
        loadProviders();
      }, 500);
    } catch (error) {
      console.error(`更新 ${providerName} 失败:`, error);
      showToast({
        message: t('providers.proxyUpdateFailed', {
          name: providerName,
          error: formatProviderError(error),
        }),
        type: 'error',
      });
    } finally {
      setUpdating(prev => ({ ...prev, [providerName]: false }));
    }
  };

  const updateAllProviders = async () => {
    const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
    if (!hasElectronMethod(api, 'updateProxyProvider')) {
      showToast({
        message: t('providers.proxyUpdateAllFailed', {
          error: t('providers.apiUnavailable'),
        }),
        type: 'error',
      });
      return;
    }

    try {
      setUpdatingAll(true);

      const results = await Promise.allSettled(
        providers.map(provider => api.updateProxyProvider(provider.name))
      );
      const successCount = results.filter(result =>
        result.status === 'fulfilled' && result.value?.success
      ).length;
      const failCount = providers.length - successCount;
      const firstFailure = results.find(result =>
        result.status === 'rejected' || result.value?.success === false
      );
      const successfulNames = results
        .map((result, index) => result.status === 'fulfilled' && result.value?.success ? providers[index]?.name : null)
        .filter((name): name is string => !!name);

      if (failCount > 0 && successCount === 0) {
        const reason = firstFailure?.status === 'rejected'
          ? firstFailure.reason
          : firstFailure?.value?.error;
        throw new Error(formatProviderError(reason));
      }

      showToast({
        message: failCount === 0
          ? t('providers.proxyUpdateAllSuccess', { count: successCount })
          : t('providers.proxyUpdateAllPartial', { success: successCount, failed: failCount }),
        type: failCount === 0 ? 'success' : 'warning',
      });
      setUpdatedProviderNames(successfulNames);
      notifyProfileUpdated();

      // 等待一小段时间后重新加载
      setTimeout(() => {
        loadProviders();
      }, 1000);
    } catch (error) {
      console.error('批量更新失败:', error);
      showToast({
        message: t('providers.proxyUpdateAllFailed', {
          error: formatProviderError(error),
        }),
        type: 'error',
      });
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
    if (!dateString) return t('providers.unknown');

    try {
      const date = new Date(dateString);
      const now = new Date();
      const diffMs = now.getTime() - date.getTime();
      const diffMins = Math.floor(diffMs / 60000);
      const diffHours = Math.floor(diffMs / 3600000);
      const diffDays = Math.floor(diffMs / 86400000);

      if (diffMins < 1) return t('providers.justNow');
      if (diffMins < 60) return t('providers.minutesAgo', { minutes: diffMins });
      if (diffHours < 24) return t('providers.hoursAgo', { hours: diffHours });
      if (diffDays < 7) return t('providers.daysAgo', { days: diffDays });

      return date.toLocaleDateString(i18n.language);
    } catch (e) {
      return t('providers.unknown');
    }
  };

  const formatExpireDate = (timestamp: number): string => {
    if (!timestamp) return t('providers.neverExpire');

    try {
      const date = new Date(timestamp * 1000);
      return date.toLocaleDateString(i18n.language, {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      });
    } catch (e) {
      return t('providers.unknown');
    }
  };

  useEffect(() => {
    loadProviders();
  }, [loadProviders]);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const refreshProvidersAfterProfileChange = (event?: Event) => {
      const source = event instanceof CustomEvent ? event.detail?.source : undefined;
      if (source === 'proxy-providers') {
        return;
      }
      void loadProviders();
    };

    window.addEventListener('profile-updated', refreshProvidersAfterProfileChange);
    window.addEventListener('backup-restored', refreshProvidersAfterProfileChange);
    window.addEventListener('subscription-auto-updated', refreshProvidersAfterProfileChange);

    const unsubscribeActiveConfig = window.electronAPI?.onActiveConfigChanged?.(() => {
      refreshProvidersAfterProfileChange();
    });
    const unsubscribeAutoUpdated = window.electronAPI?.onSubscriptionAutoUpdated?.(() => {
      refreshProvidersAfterProfileChange();
    });

    return () => {
      window.removeEventListener('profile-updated', refreshProvidersAfterProfileChange);
      window.removeEventListener('backup-restored', refreshProvidersAfterProfileChange);
      window.removeEventListener('subscription-auto-updated', refreshProvidersAfterProfileChange);
      unsubscribeActiveConfig?.();
      unsubscribeAutoUpdated?.();
    };
  }, [loadProviders]);

  useEffect(() => {
    if (updatedProviderNames.length === 0) return;
    const timer = window.setTimeout(() => {
      setUpdatedProviderNames([]);
    }, 3200);
    return () => window.clearTimeout(timer);
  }, [updatedProviderNames]);

  if (
    loading &&
    providers.length === 0 &&
    !proxyProvidersViewCache.loaded &&
    !hasAppDataCache(PROXY_PROVIDERS_CACHE_KEY)
  ) {
    return (
      <div className="min-h-[120px]" aria-busy="true" />
    );
  }

  if (loadError) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 p-5 text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-base font-semibold">{t('providers.proxyProviders')}</h2>
            <p className="mt-1 text-sm">{loadError}</p>
          </div>
          <button
            type="button"
            onClick={loadProviders}
            className="inline-flex items-center justify-center rounded-lg bg-red-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-red-700"
          >
            <ReloadIcon className="mr-2 h-4 w-4" />
            {t('providers.retry')}
          </button>
        </div>
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
          {t('providers.proxyProviders')}
        </h2>
        <button
          onClick={updateAllProviders}
          disabled={updatingAll}
          className="px-4 py-2 bg-primary hover:bg-primary/90 disabled:bg-muted disabled:text-muted-foreground text-primary-foreground rounded-lg flex items-center gap-2 transition-colors"
        >
          <UpdateIcon className={updatingAll ? 'animate-spin' : ''} />
          {updatingAll ? t('providers.updating') : t('providers.updateAll')}
        </button>
      </div>

      <div className="space-y-3">
        {providers.map((provider) => (
          <div
            key={provider.name}
            className={`relative bg-white dark:bg-[#2a2a2a] rounded-xl p-6 shadow-sm hover:shadow-md transition-shadow ${
              updatedProviderNames.includes(provider.name) ? 'ring-2 ring-primary/45 bg-primary/5 dark:bg-primary/10' : ''
            }`}
          >
            {updatedProviderNames.includes(provider.name) && (
              <div className="pointer-events-none absolute bottom-3 right-3 inline-flex max-w-[calc(100%-1.5rem)] items-center gap-1 rounded-full bg-primary px-2 py-1 text-[10px] font-medium text-primary-foreground shadow-md">
                <CheckIcon className="h-3 w-3 flex-shrink-0" />
                <span className="truncate">{t('providers.justUpdated')}</span>
              </div>
            )}
            <div className="flex items-start justify-between mb-4">
              <div className="flex-1">
                <div className="flex items-center gap-3">
                  <h3 className="text-base font-medium text-foreground">
                    {provider.name}
                  </h3>
                  <span className="px-2 py-1 bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 text-xs rounded-md">
                    {t('providers.nodeCount', { count: provider.proxies?.length || 0 })}
                  </span>
                </div>
                <div className="mt-2 flex items-center gap-4 text-sm text-muted-foreground">
                  <span>{t('providers.updatedAt')}: {formatDate(provider.updatedAt)}</span>
                  <span>{t('providers.type')}: {provider.vehicleType}</span>
                </div>
              </div>

              <button
                onClick={() => updateProvider(provider.name)}
                disabled={updating[provider.name]}
                className="px-3 py-2 bg-muted hover:bg-muted/80 text-foreground rounded-lg flex items-center gap-2 transition-colors disabled:opacity-50"
              >
                <ReloadIcon className={updating[provider.name] ? 'animate-spin' : ''} />
                {updating[provider.name] ? t('providers.updatingShort') : t('common.update')}
              </button>
            </div>

            {provider.subscriptionInfo && (
              <div className="p-4 bg-muted/30 dark:bg-muted/10 rounded-lg">
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <span className="text-muted-foreground">{t('providers.usedTraffic')}: </span>
                    <span className="text-foreground font-medium">
                      {formatBytes(provider.subscriptionInfo.Upload + provider.subscriptionInfo.Download)}
                      {' / '}
                      {formatBytes(provider.subscriptionInfo.Total)}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">{t('providers.expireDate')}: </span>
                    <span className="text-foreground font-medium">
                      {formatExpireDate(provider.subscriptionInfo.Expire)}
                    </span>
                  </div>
                </div>

                {provider.subscriptionInfo.Total > 0 && (
                  <div className="mt-3">
                    <div className="flex justify-between text-xs text-muted-foreground mb-1">
                      <span>{t('providers.trafficUsage')}</span>
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
