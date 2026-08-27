'use client';

import { useSyncExternalStore } from 'react';

export const APP_DATA_CACHE_UPDATED_EVENT = 'flyclash-cache-updated';

export const APP_DATA_CACHE_KEYS = {
  subscriptions: 'subscriptionsCache',
  proxyGroups: 'proxyGroupsCache',
  mihomoRunning: 'mihomoRunningState',
  connections: 'connectionsCache',
  matchRules: 'matchRulesCache',
  proxyProviders: 'proxyProvidersCache:v2',
  ruleProviders: 'ruleProvidersCache:v2',
  overrides: 'overridesCache',
  logs: 'logsCache',
  activeConfig: 'activeConfigCache',
  proxyMode: 'proxyModeCache',
  mihomoConfig: 'mihomoConfigCache',
  systemProxyEnabled: 'systemProxyEnabledCache',
  tunEnabled: 'tunEnabledCache',
  ipInfo: 'ipInfoCache',
  dashboardRuntime: 'dashboardRuntimeCache',
} as const;

export type AppDataCacheKey =
  (typeof APP_DATA_CACHE_KEYS)[keyof typeof APP_DATA_CACHE_KEYS];

type Listener = () => void;

const memoryCache = new Map<AppDataCacheKey, unknown>();
const staleKeys = new Set<AppDataCacheKey>();
const listeners = new Map<AppDataCacheKey, Set<Listener>>();

const canUseSessionStorage = () => {
  return typeof window !== 'undefined' && typeof window.sessionStorage !== 'undefined';
};

const parseStoredValue = (raw: string) => {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
};

const notifyListeners = (key: AppDataCacheKey) => {
  const keyListeners = listeners.get(key);
  keyListeners?.forEach((listener) => listener());
};

export const readAppDataCache = <T,>(
  key: AppDataCacheKey,
  fallback?: T,
): T | undefined => {
  if (memoryCache.has(key)) {
    return memoryCache.get(key) as T;
  }

  if (!canUseSessionStorage()) {
    return fallback;
  }

  try {
    const raw = sessionStorage.getItem(key);
    if (raw === null) return fallback;
    const parsed = parseStoredValue(raw) as T;
    memoryCache.set(key, parsed);
    return parsed;
  } catch (error) {
    console.debug(`[AppDataCache] 读取缓存失败: ${key}`, error);
    return fallback;
  }
};

export const hasAppDataCache = (key: AppDataCacheKey): boolean => {
  if (memoryCache.has(key)) return true;

  if (!canUseSessionStorage()) {
    return false;
  }

  try {
    return sessionStorage.getItem(key) !== null;
  } catch {
    return false;
  }
};

export const isAppDataCacheStale = (key: AppDataCacheKey): boolean => staleKeys.has(key);

export const markAppDataCacheStale = (
  key: AppDataCacheKey,
  options: { broadcast?: boolean } = {},
) => {
  staleKeys.add(key);
  if (options.broadcast !== false && typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent(APP_DATA_CACHE_UPDATED_EVENT, { detail: { key, stale: true } }),
    );
  }
};

export const writeAppDataCache = <T,>(
  key: AppDataCacheKey,
  value: T,
  options: { persist?: boolean; broadcast?: boolean } = {},
) => {
  const { persist = true, broadcast = true } = options;

  // Bail out when value is referentially equal — avoids notify storms that
  // can drive useSyncExternalStore into "Maximum update depth exceeded".
  if (memoryCache.has(key) && Object.is(memoryCache.get(key), value)) {
    return;
  }

  memoryCache.set(key, value);
  staleKeys.delete(key);

  if (persist && canUseSessionStorage()) {
    try {
      sessionStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      console.warn(`[AppDataCache] 写入缓存失败: ${key}`, error);
    }
  }

  notifyListeners(key);

  if (broadcast && typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent(APP_DATA_CACHE_UPDATED_EVENT, { detail: { key } }),
    );
  }
};

export const ensureAppDataCache = <T,>(
  key: AppDataCacheKey,
  value: T,
  options: { persist?: boolean; broadcast?: boolean } = {},
) => {
  if (hasAppDataCache(key)) return;
  writeAppDataCache(key, value, options);
};

export const removeAppDataCache = (
  key: AppDataCacheKey,
  options: { broadcast?: boolean } = {},
) => {
  const { broadcast = true } = options;
  memoryCache.delete(key);
  staleKeys.delete(key);

  if (canUseSessionStorage()) {
    try {
      sessionStorage.removeItem(key);
    } catch (error) {
      console.debug(`[AppDataCache] 删除缓存失败: ${key}`, error);
    }
  }

  notifyListeners(key);

  if (broadcast && typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent(APP_DATA_CACHE_UPDATED_EVENT, { detail: { key } }),
    );
  }
};

export const subscribeAppDataCache = (
  key: AppDataCacheKey,
  listener: Listener,
) => {
  const keyListeners = listeners.get(key) ?? new Set<Listener>();
  keyListeners.add(listener);
  listeners.set(key, keyListeners);

  return () => {
    keyListeners.delete(listener);
    if (keyListeners.size === 0) {
      listeners.delete(key);
    }
  };
};

export const useAppDataCache = <T,>(key: AppDataCacheKey, fallback: T): T => {
  return useSyncExternalStore(
    (listener) => subscribeAppDataCache(key, listener),
    () => readAppDataCache<T>(key, fallback) ?? fallback,
    () => fallback,
  );
};

export type AppDataInvalidationScope =
  | 'all'
  | 'profile'
  | 'active-config'
  | 'providers'
  | 'runtime'
  | 'network'
  | 'backup';

const INVALIDATION_MAP: Record<AppDataInvalidationScope, AppDataCacheKey[]> = {
  all: Object.values(APP_DATA_CACHE_KEYS),
  profile: [
    // Keep the subscription list warm during profile/config switches.
    // Clearing it causes a visible empty-state flash on the configs page.
    APP_DATA_CACHE_KEYS.activeConfig,
    APP_DATA_CACHE_KEYS.proxyGroups,
    APP_DATA_CACHE_KEYS.proxyMode,
    APP_DATA_CACHE_KEYS.mihomoConfig,
    APP_DATA_CACHE_KEYS.matchRules,
    APP_DATA_CACHE_KEYS.proxyProviders,
    APP_DATA_CACHE_KEYS.ruleProviders,
    // Keep overrides list warm too — clearing it flashes the overrides page
    // when toggling enabled/global (profile-updated -> invalidate).
    // Override content changes still refresh via explicit page fetches.
    APP_DATA_CACHE_KEYS.connections,
    APP_DATA_CACHE_KEYS.dashboardRuntime,
    APP_DATA_CACHE_KEYS.ipInfo,
  ],
  'active-config': [
    APP_DATA_CACHE_KEYS.activeConfig,
    APP_DATA_CACHE_KEYS.proxyGroups,
    APP_DATA_CACHE_KEYS.proxyMode,
    APP_DATA_CACHE_KEYS.mihomoConfig,
    APP_DATA_CACHE_KEYS.matchRules,
    APP_DATA_CACHE_KEYS.proxyProviders,
    APP_DATA_CACHE_KEYS.ruleProviders,
    APP_DATA_CACHE_KEYS.connections,
    APP_DATA_CACHE_KEYS.dashboardRuntime,
    APP_DATA_CACHE_KEYS.ipInfo,
  ],
  providers: [
    APP_DATA_CACHE_KEYS.proxyProviders,
    APP_DATA_CACHE_KEYS.ruleProviders,
    APP_DATA_CACHE_KEYS.proxyGroups,
  ],
  runtime: [
    APP_DATA_CACHE_KEYS.mihomoRunning,
    APP_DATA_CACHE_KEYS.proxyMode,
    APP_DATA_CACHE_KEYS.mihomoConfig,
    APP_DATA_CACHE_KEYS.systemProxyEnabled,
    APP_DATA_CACHE_KEYS.tunEnabled,
    APP_DATA_CACHE_KEYS.dashboardRuntime,
    APP_DATA_CACHE_KEYS.connections,
  ],
  network: [
    APP_DATA_CACHE_KEYS.connections,
    APP_DATA_CACHE_KEYS.ipInfo,
    APP_DATA_CACHE_KEYS.dashboardRuntime,
  ],
  backup: Object.values(APP_DATA_CACHE_KEYS),
};

export const invalidateAppDataCache = (
  scope: AppDataInvalidationScope | AppDataCacheKey[] = 'profile',
  options: { broadcast?: boolean; hard?: boolean } = {},
) => {
  const keys = Array.isArray(scope) ? scope : INVALIDATION_MAP[scope] || INVALIDATION_MAP.profile;
  const uniqueKeys = Array.from(new Set(keys));
  uniqueKeys.forEach((key) => {
    if (options.hard || !hasAppDataCache(key)) {
      removeAppDataCache(key, { broadcast: options.broadcast ?? true });
    } else {
      markAppDataCacheStale(key, { broadcast: options.broadcast ?? true });
    }
  });
  return uniqueKeys;
};

export const APP_DATA_INVALIDATE_EVENT = 'flyclash-cache-invalidate';

export const emitAppDataInvalidate = (
  scope: AppDataInvalidationScope = 'profile',
  detail: Record<string, unknown> = {},
) => {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent(APP_DATA_INVALIDATE_EVENT, {
      detail: {
        scope,
        ...detail,
      },
    }),
  );
};
