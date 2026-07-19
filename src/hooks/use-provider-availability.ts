import { useCallback, useEffect, useState } from 'react';
import {
  filterProviderRecord,
  getConfiguredProviderNames,
  providerMap,
} from '@/services/provider-filter';

type ProviderStatus = 'unknown' | 'present' | 'absent';

type Listener = (status: ProviderStatus) => void;

let cachedStatus: ProviderStatus = 'unknown';
const listeners = new Set<Listener>();
let refreshInFlight: Promise<ProviderStatus> | null = null;

const notifyListeners = (status: ProviderStatus) => {
  cachedStatus = status;
  listeners.forEach((listener) => listener(status));
};

const waitForIdleSlot = async (timeoutMs = 1200) => {
  if (typeof window === 'undefined') return;

  await new Promise<void>((resolve) => {
    const requestIdle = (window as any).requestIdleCallback as
      | ((callback: () => void, options?: { timeout?: number }) => number)
      | undefined;

    if (typeof requestIdle === 'function') {
      requestIdle(resolve, { timeout: timeoutMs });
    } else {
      window.setTimeout(resolve, Math.min(timeoutMs, 180));
    }
  });
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
    const [configuredProxyProviders, configuredRuleProviders] = await Promise.all([
      getConfiguredProviderNames('proxyProviders'),
      getConfiguredProviderNames('ruleProviders'),
    ]);
    const filteredProxyProviders =
      proxyProviders && typeof proxyProviders === 'object'
        ? filterProviderRecord(proxyProviders as Record<string, any>, 'proxyProviders', configuredProxyProviders)
        : undefined;
    const filteredRuleProviders =
      ruleProviders && typeof ruleProviders === 'object'
        ? filterProviderRecord(ruleProviders as Record<string, any>, 'ruleProviders', configuredRuleProviders)
        : undefined;

    const hasProxyProviders =
      proxyResult.status === 'fulfilled' &&
      proxyResult.value?.success &&
      filteredProxyProviders &&
      Object.keys(filteredProxyProviders).length > 0;

    const hasRuleProviders =
      ruleResult.status === 'fulfilled' &&
      ruleResult.value?.success &&
      filteredRuleProviders &&
      Object.keys(filteredRuleProviders).length > 0;

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
      let canceled = false;
      const timer = window.setTimeout(() => {
        void waitForIdleSlot(1800).then(() => {
          if (!canceled) void refreshAvailability();
        });
      }, 700);

      return () => {
        canceled = true;
        window.clearTimeout(timer);
      };
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const timers = new Set<number>();
    let canceled = false;
    const scheduleRefresh = (delay: number) => {
      const timer = window.setTimeout(() => {
        timers.delete(timer);
        void waitForIdleSlot(1200).then(() => {
          if (!canceled) {
            void refreshAvailability({ preserveKnownOnUnknown: true });
          }
        });
      }, delay);
      timers.add(timer);
    };
    const refreshAfterConfigChange = () => {
      scheduleRefresh(120);
      scheduleRefresh(650);
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
      canceled = true;
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
