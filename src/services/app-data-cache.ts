'use client';

import { useSyncExternalStore } from 'react';

export const APP_DATA_CACHE_UPDATED_EVENT = 'flyclash-cache-updated';

export const APP_DATA_CACHE_KEYS = {
  subscriptions: 'subscriptionsCache',
  proxyGroups: 'proxyGroupsCache',
  mihomoRunning: 'mihomoRunningState',
  connections: 'connectionsCache',
  matchRules: 'matchRulesCache',
  proxyProviders: 'proxyProvidersCache',
  ruleProviders: 'ruleProvidersCache',
  overrides: 'overridesCache',
  logs: 'logsCache',
  activeConfig: 'activeConfigCache',
  proxyMode: 'proxyModeCache',
  ipInfo: 'ipInfoCache',
} as const;

export type AppDataCacheKey =
  (typeof APP_DATA_CACHE_KEYS)[keyof typeof APP_DATA_CACHE_KEYS];

type Listener = () => void;

const memoryCache = new Map<AppDataCacheKey, unknown>();
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

export const writeAppDataCache = <T,>(
  key: AppDataCacheKey,
  value: T,
  options: { persist?: boolean; broadcast?: boolean } = {},
) => {
  const { persist = true, broadcast = true } = options;
  memoryCache.set(key, value);

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
