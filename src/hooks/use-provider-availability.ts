import { useCallback, useEffect, useState } from 'react';

type ProviderStatus = 'unknown' | 'present' | 'absent';

type Listener = (status: ProviderStatus) => void;

let cachedStatus: ProviderStatus = 'unknown';
const listeners = new Set<Listener>();

const notifyListeners = (status: ProviderStatus) => {
  cachedStatus = status;
  listeners.forEach((listener) => listener(status));
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

    const hasProxyProviders =
      proxyResult.status === 'fulfilled' &&
      proxyResult.value?.success &&
      proxyResult.value?.data?.providers &&
      Object.values(proxyResult.value.data.providers).some((provider: any) =>
        provider && Object.prototype.hasOwnProperty.call(provider, 'subscriptionInfo')
      );

    const hasRuleProviders =
      ruleResult.status === 'fulfilled' &&
      ruleResult.value?.success &&
      ruleResult.value?.data?.providers &&
      Object.keys(ruleResult.value.data.providers).length > 0;

    return hasProxyProviders || hasRuleProviders ? 'present' : 'absent';
  } catch (error) {
    console.error('检测 Provider 可用性失败:', error);
    return 'absent';
  }
};

const refreshAvailability = async () => {
  const status = await evaluateAvailability();
  notifyListeners(status);
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
