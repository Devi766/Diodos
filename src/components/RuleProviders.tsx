import React, { useCallback, useEffect, useRef, useState } from 'react';
import { CheckIcon, ReloadIcon, UpdateIcon } from '@radix-ui/react-icons';
import { useTranslation } from 'react-i18next';
import { showToast } from '@/components/ui/toast';
import {
  hasRuleProvidersCache,
  readRuleProvidersCache,
  subscribeRuleProvidersCache,
  writeRuleProvidersCache,
} from '@/services/app-data-hooks';
import {
  filterProviderRecord,
  getConfiguredProviderNames,
  providerMap,
} from '@/services/provider-filter';

const TAURI_RUNTIME_UNAVAILABLE = 'Tauri runtime is not available';

const hasElectronMethod = <K extends string>(api: unknown, method: K): api is Record<K, (...args: any[]) => Promise<any>> => {
  try {
    return !!api && typeof (api as Record<string, unknown>)[method] === 'function';
  } catch {
    return false;
  }
};

const notifyProfileUpdated = () => {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('profile-updated', { detail: { source: 'rule-providers' } }));
  }
};

interface RuleProvider {
  name: string;
  type: string;
  vehicleType: string;
  behavior: string;
  format: string;
  ruleCount: number;
  updatedAt?: string;
}

const ruleProvidersViewCache: {
  providers: RuleProvider[];
  loaded: boolean;
} = {
  providers: [],
  loaded: false,
};

const readRuleProvidersSessionCache = (): RuleProvider[] | null => {
  const cached = readRuleProvidersCache<RuleProvider>();
  return cached.length > 0 || hasRuleProvidersCache() ? cached : null;
};

const hydrateRuleProvidersFromSession = () => {
  if (ruleProvidersViewCache.loaded) return;
  const cached = readRuleProvidersSessionCache();
  if (!cached) return;
  ruleProvidersViewCache.providers = cached;
  ruleProvidersViewCache.loaded = true;
};

const RuleProviders: React.FC = () => {
  const { t, i18n } = useTranslation();
  const [providers, setProviders] = useState<RuleProvider[]>(() => {
    hydrateRuleProvidersFromSession();
    return ruleProvidersViewCache.providers;
  });
  const [loading, setLoading] = useState(() => !ruleProvidersViewCache.loaded);
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
    ruleProvidersViewCache.providers = providers;
    providersRef.current = providers;
  }, [providers]);

  useEffect(() => {
    if (!loading) {
      ruleProvidersViewCache.loaded = true;
    }
  }, [loading]);

  useEffect(() => {
    return subscribeRuleProvidersCache( () => {
      const cached = readRuleProvidersSessionCache();
      if (!cached) return;
      ruleProvidersViewCache.providers = cached;
      ruleProvidersViewCache.loaded = true;
      setProviders(cached);
      setLoading(false);
    });
  }, []);

  const loadProviders = useCallback(async () => {
    const coldLoad =
      providersRef.current.length === 0 &&
      !ruleProvidersViewCache.loaded &&
      !hasRuleProvidersCache();
    try {
      if (coldLoad) setLoading(true);
      setLoadError(null);
      const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
      if (!hasElectronMethod(api, 'getRuleProviders')) {
        throw new Error(t('providers.apiUnavailable'));
      }

      const result = await api.getRuleProviders();
      if (!result || result.success !== true) {
        throw new Error(formatProviderError(result?.error, t('providers.loadRuleFailedFallback')));
      }

      const providersRecord = providerMap(result);
      if (providersRecord && typeof providersRecord === 'object') {
        const configuredNames = await getConfiguredProviderNames('ruleProviders');
        const filteredRecord = filterProviderRecord(
          providersRecord as Record<string, any>,
          'ruleProviders',
          configuredNames,
        );
        const providerList = Object.values(filteredRecord) as RuleProvider[];
        writeRuleProvidersCache( providerList);
        setProviders(providerList);
      } else {
        writeRuleProvidersCache( []);
        setProviders([]);
      }
    } catch (error) {
      console.error('加载 Rule Providers 失败:', error);
      if (providersRef.current.length === 0 && !ruleProvidersViewCache.loaded) {
        setProviders([]);
      }
      setLoadError(t('providers.loadRuleFailed', { error: formatProviderError(error, t('providers.loadRuleFailedFallback')) }));
    } finally {
      if (coldLoad) setLoading(false);
    }
  }, [formatProviderError, t]);

  const updateProvider = async (providerName: string) => {
    const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
    if (!hasElectronMethod(api, 'updateRuleProvider')) {
      showToast({
        message: t('providers.ruleUpdateFailed', {
          name: providerName,
          error: t('providers.apiUnavailable'),
        }),
        type: 'error',
      });
      return;
    }

    try {
      setUpdating(prev => ({ ...prev, [providerName]: true }));
      const result = await api.updateRuleProvider(providerName);

      if (!result || !result.success) {
        throw new Error(formatProviderError(result?.error));
      }

      showToast({
        message: t('providers.ruleUpdateSuccess', { name: providerName }),
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
        message: t('providers.ruleUpdateFailed', {
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
    if (!hasElectronMethod(api, 'updateRuleProvider')) {
      showToast({
        message: t('providers.ruleUpdateAllFailed', {
          error: t('providers.apiUnavailable'),
        }),
        type: 'error',
      });
      return;
    }

    try {
      setUpdatingAll(true);

      const results = await Promise.allSettled(
        providers.map(provider => api.updateRuleProvider(provider.name))
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
          ? t('providers.ruleUpdateAllSuccess', { count: successCount })
          : t('providers.ruleUpdateAllPartial', { success: successCount, failed: failCount }),
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
        message: t('providers.ruleUpdateAllFailed', {
          error: formatProviderError(error),
        }),
        type: 'error',
      });
    } finally {
      setUpdatingAll(false);
    }
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

  useEffect(() => {
    loadProviders();
  }, [loadProviders]);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const refreshProvidersAfterProfileChange = (event?: Event) => {
      const source = event instanceof CustomEvent ? event.detail?.source : undefined;
      if (source === 'rule-providers') {
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
    !ruleProvidersViewCache.loaded &&
    !hasRuleProvidersCache()
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
            <h2 className="text-base font-semibold">{t('providers.ruleProviders')}</h2>
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
          {t('providers.ruleProviders')}
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
            <div className="flex items-start justify-between">
              <div className="flex-1">
                <div className="flex items-center gap-3">
                  <h3 className="text-base font-medium text-foreground">
                    {provider.name}
                  </h3>
                  <span className="px-2 py-1 bg-green-50 dark:bg-green-900/20 text-green-600 dark:text-green-400 text-xs rounded-md">
                    {t('providers.ruleCount', { count: provider.ruleCount })}
                  </span>
                </div>
                <div className="mt-2 flex items-center gap-4 text-sm text-muted-foreground">
                  <span>{t('providers.updatedAt')}: {formatDate(provider.updatedAt)}</span>
                  <span>{t('providers.format')}: {provider.format}</span>
                  <span>{t('providers.type')}: {provider.vehicleType}::{provider.behavior}</span>
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
          </div>
        ))}
      </div>
    </div>
  );
};

export default RuleProviders;
