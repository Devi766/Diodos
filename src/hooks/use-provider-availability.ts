import { useCallback, useEffect, useState } from 'react';

type ProviderStatus = 'unknown' | 'present' | 'absent';

type Listener = (status: ProviderStatus) => void;

let cachedStatus: ProviderStatus = 'unknown';
const listeners = new Set<Listener>();
let refreshInFlight: Promise<ProviderStatus> | null = null;

const notifyListeners = (status: ProviderStatus) => {
  cachedStatus = status;
  listeners.forEach((listener) => listener(status));
};

const providerMap = (result: any) => {
  return result?.data?.providers ?? result?.providers ?? result?.data?.data?.providers;
};

const evaluateAvailability = async (): Promise<ProviderStatus> => {
  if (typeof window === 'undefined' || !window.electronAPI) {
    return 'absent';
  }

  try {
    const [proxyResult, ruleResult] = await Promise.allSettled([
      window.electronAPI.getProxyProviders?.(),
      window.electronAPI.getRuleProviders?.(),
    ]);

    const proxyFailed = proxyResult.status === 'rejected' || proxyResult.value?.success === false;
    const ruleFailed = ruleResult.status === 'rejected' || ruleResult.value?.success === false;
    if (proxyFailed || ruleFailed) {
      return 'unknown';
    }

    const proxyProviders = proxyResult.status === 'fulfilled' ? providerMap(proxyResult.value) : undefined;
    const ruleProviders = ruleResult.status === 'fulfilled' ? providerMap(ruleResult.value) : undefined;

    const hasProxyProviders =
      proxyResult.status === 'fulfilled' &&
      proxyResult.value?.success &&
      proxyProviders &&
      Object.keys(proxyProviders).length > 0;

    const hasRuleProviders =
      ruleResult.status === 'fulfilled' &&
      ruleResult.value?.success &&
      ruleProviders &&
      Object.keys(ruleProviders).length > 0;

    return hasProxyProviders || hasRuleProviders ? 'present' : 'absent';
  } catch (error) {
    console.error('检测 Provider 可用性失败:', error);
    return 'unknown';
  }
};

const refreshAvailability = async (options: { preserveKnownOnUnknown?: boolean } = {}) => {
  if (refreshInFlight) {
    return refreshInFlight;
  }

  refreshInFlight = evaluateAvailability()
    .then((status) => {
      const nextStatus =
        status === 'unknown' && options.preserveKnownOnUnknown && cachedStatus !== 'unknown'
          ? cachedStatus
          : status;

      if (nextStatus !== cachedStatus) {
        notifyListeners(nextStatus);
      }

      return nextStatus;
    })
    .finally(() => {
      refreshInFlight = null;
    });

  return refreshInFlight;
};

/**
 * 检测当前运行配置是否包含外部 Provider（代理或规则）
 */
export const useProviderAvailability = () => {
  const [status, setStatus] = useState<ProviderStatus>(cachedStatus);

  useEffect(() => {
    const listener: Listener = (nextStatus) => setStatus(nextStatus);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  useEffect(() => {
    if (cachedStatus === 'unknown') {
      refreshAvailability();
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const timers = new Set<number>();
    const refreshAfterConfigChange = () => {
      void refreshAvailability({ preserveKnownOnUnknown: true });

      const timer = window.setTimeout(() => {
        timers.delete(timer);
        void refreshAvailability({ preserveKnownOnUnknown: true });
      }, 300);
      timers.add(timer);
    };
    const refreshWhenVisible = () => {
      if (!document.hidden) refreshAfterConfigChange();
    };

    window.addEventListener('profile-updated', refreshAfterConfigChange);
    window.addEventListener('backup-restored', refreshAfterConfigChange);
    window.addEventListener('subscription-auto-updated', refreshAfterConfigChange);
    document.addEventListener('visibilitychange', refreshWhenVisible);

    const unsubscribeActiveConfig = window.electronAPI?.onActiveConfigChanged?.(() => {
      refreshAfterConfigChange();
    });
    const unsubscribeAutoUpdated = window.electronAPI?.onSubscriptionAutoUpdated?.(() => {
      refreshAfterConfigChange();
    });

    return () => {
      window.removeEventListener('profile-updated', refreshAfterConfigChange);
      window.removeEventListener('backup-restored', refreshAfterConfigChange);
      window.removeEventListener('subscription-auto-updated', refreshAfterConfigChange);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
      timers.forEach((timer) => window.clearTimeout(timer));
      unsubscribeActiveConfig?.();
      unsubscribeAutoUpdated?.();
    };
  }, []);

  const refresh = useCallback(async () => {
    await refreshAvailability();
  }, []);

  return {
    status,
    hasProviders: status === 'present',
    refreshProvidersAvailability: refresh,
  };
};

export type ProviderAvailabilityStatus = ReturnType<typeof useProviderAvailability>['status'];
