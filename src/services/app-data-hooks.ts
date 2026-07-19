'use client';

import {
  APP_DATA_CACHE_KEYS,
  emitAppDataInvalidate,
  hasAppDataCache,
  invalidateAppDataCache,
  readAppDataCache,
  removeAppDataCache,
  subscribeAppDataCache,
  useAppDataCache,
  writeAppDataCache,
  type AppDataCacheKey,
  type AppDataInvalidationScope,
} from '@/services/app-data-cache';

export { APP_DATA_CACHE_KEYS, emitAppDataInvalidate, invalidateAppDataCache };
export type { AppDataCacheKey, AppDataInvalidationScope };

export type ProxyMode = 'rule' | 'global' | 'direct';

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return !!value && typeof value === 'object' && !Array.isArray(value);
};

export const toArrayValue = <T,>(value: unknown): T[] => {
  if (Array.isArray(value)) return value as T[];
  if (!isRecord(value)) return [];

  const nested = value.data ?? value.items ?? value.subscriptions ?? value.overrides;
  if (Array.isArray(nested)) return nested as T[];

  if (isRecord(nested)) {
    const nestedRecord = nested;
    if (Array.isArray(nestedRecord.subscriptions)) {
      return nestedRecord.subscriptions as T[];
    }
    if (Array.isArray(nestedRecord.items)) {
      return nestedRecord.items as T[];
    }
  }

  return [];
};

export const normalizeProxyMode = (
  value: unknown,
  fallback: ProxyMode | null = null,
): ProxyMode | null => {
  if (value === 'rule' || value === 'global' || value === 'direct') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'rule' || normalized === 'global' || normalized === 'direct') {
      return normalized;
    }
  }
  return fallback;
};

export const normalizeActiveConfig = (value: unknown): string | null => {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
};

export const normalizeBooleanCache = (value: unknown): boolean | null => {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return null;
};

export const hasSubscriptionsCache = (): boolean => {
  return hasAppDataCache(APP_DATA_CACHE_KEYS.subscriptions);
};

export const hasActiveConfigCache = (): boolean => {
  return hasAppDataCache(APP_DATA_CACHE_KEYS.activeConfig);
};

export const hasConnectionsCache = (): boolean => {
  return hasAppDataCache(APP_DATA_CACHE_KEYS.connections);
};

export const hasProxyGroupsCache = (): boolean => {
  return hasAppDataCache(APP_DATA_CACHE_KEYS.proxyGroups);
};

export const readSubscriptionsCache = <T = unknown>(): T[] => {
  return toArrayValue<T>(readAppDataCache(APP_DATA_CACHE_KEYS.subscriptions));
};

export const writeSubscriptionsCache = <T = unknown>(
  value: T[],
  options?: { persist?: boolean; broadcast?: boolean },
) => {
  writeAppDataCache(APP_DATA_CACHE_KEYS.subscriptions, value, options);
};

export const readActiveConfigCache = (): string | null => {
  return normalizeActiveConfig(readAppDataCache(APP_DATA_CACHE_KEYS.activeConfig));
};

export const writeActiveConfigCache = (
  value: string | null,
  options?: { persist?: boolean; broadcast?: boolean },
) => {
  writeAppDataCache(APP_DATA_CACHE_KEYS.activeConfig, value, options);
};

export const readProxyModeCache = (
  fallback: ProxyMode | null = null,
): ProxyMode | null => {
  return normalizeProxyMode(readAppDataCache(APP_DATA_CACHE_KEYS.proxyMode), fallback);
};

export const writeProxyModeCache = (
  value: ProxyMode,
  options?: { persist?: boolean; broadcast?: boolean },
) => {
  writeAppDataCache(APP_DATA_CACHE_KEYS.proxyMode, value, options);
};

export const readMihomoRunningCache = (): boolean | null => {
  return normalizeBooleanCache(readAppDataCache(APP_DATA_CACHE_KEYS.mihomoRunning));
};

export const writeMihomoRunningCache = (
  value: boolean,
  options?: { persist?: boolean; broadcast?: boolean },
) => {
  writeAppDataCache(APP_DATA_CACHE_KEYS.mihomoRunning, value, options);
};

export const readConnectionsCache = <T = unknown>(): T[] => {
  const cached = readAppDataCache<unknown>(APP_DATA_CACHE_KEYS.connections);
  return Array.isArray(cached) ? (cached as T[]) : [];
};

export const writeConnectionsCache = <T = unknown>(
  value: T[],
  options?: { persist?: boolean; broadcast?: boolean },
) => {
  writeAppDataCache(APP_DATA_CACHE_KEYS.connections, value, options);
};

export type ProxyGroupsCacheEnvelope<T = unknown> = {
  source?: string;
  version?: number;
  mode?: ProxyMode;
  groups: T[];
  configPath?: string | null;
};

export const unpackProxyGroupsCache = <T = unknown>(
  cached: unknown,
): ProxyGroupsCacheEnvelope<T> => {
  if (Array.isArray(cached)) {
    return { groups: cached as T[] };
  }

  if (!isRecord(cached)) {
    return { groups: [] };
  }

  const mode =
    cached.mode === undefined || cached.mode === null
      ? undefined
      : normalizeProxyMode(cached.mode) ?? undefined;
  const groups = Array.isArray(cached.groups) ? (cached.groups as T[]) : [];

  return {
    source: typeof cached.source === 'string' ? cached.source : undefined,
    version: typeof cached.version === 'number' ? cached.version : undefined,
    mode: mode ?? undefined,
    groups,
    configPath: normalizeActiveConfig(cached.configPath),
  };
};

export const readProxyGroupsCache = <T = unknown>(): T[] => {
  return unpackProxyGroupsCache<T>(
    readAppDataCache(APP_DATA_CACHE_KEYS.proxyGroups),
  ).groups;
};

export const readProxyGroupsEnvelope = <T = unknown>(): ProxyGroupsCacheEnvelope<T> => {
  return unpackProxyGroupsCache<T>(
    readAppDataCache(APP_DATA_CACHE_KEYS.proxyGroups),
  );
};

export const writeProxyGroupsCache = <T = unknown>(
  value: ProxyGroupsCacheEnvelope<T> | T[],
  options?: { persist?: boolean; broadcast?: boolean },
) => {
  writeAppDataCache(APP_DATA_CACHE_KEYS.proxyGroups, value, options);
};

export const clearProxyGroupsCache = (
  options?: { broadcast?: boolean },
) => {
  removeAppDataCache(APP_DATA_CACHE_KEYS.proxyGroups, options);
};

export const subscribeProxyGroupsCache = (listener: () => void) => {
  return subscribeAppDataCache(APP_DATA_CACHE_KEYS.proxyGroups, listener);
};

export const readDashboardRuntimeCache = <T extends Record<string, unknown> = Record<string, unknown>>(): T => {
  const cached = readAppDataCache<unknown>(APP_DATA_CACHE_KEYS.dashboardRuntime);
  return (isRecord(cached) ? cached : {}) as T;
};

export const writeDashboardRuntimeCache = (
  value: Record<string, unknown>,
  options?: { persist?: boolean; broadcast?: boolean },
) => {
  writeAppDataCache(APP_DATA_CACHE_KEYS.dashboardRuntime, value, options);
};

export const subscribeDashboardRuntimeCache = (listener: () => void) => {
  return subscribeAppDataCache(APP_DATA_CACHE_KEYS.dashboardRuntime, listener);
};

const readArrayCache = <T,>(key: AppDataCacheKey): T[] => {
  const cached = readAppDataCache<unknown>(key);
  return Array.isArray(cached) ? (cached as T[]) : [];
};

const writeArrayCache = <T,>(
  key: AppDataCacheKey,
  value: T[],
  options?: { persist?: boolean; broadcast?: boolean },
) => {
  writeAppDataCache(key, value, options);
};

export const hasMatchRulesCache = (): boolean => hasAppDataCache(APP_DATA_CACHE_KEYS.matchRules);
export const readMatchRulesCache = <T = unknown>(): T[] =>
  readArrayCache<T>(APP_DATA_CACHE_KEYS.matchRules);
export const writeMatchRulesCache = <T = unknown>(
  value: T[],
  options?: { persist?: boolean; broadcast?: boolean },
) => writeArrayCache(APP_DATA_CACHE_KEYS.matchRules, value, options);
export const subscribeMatchRulesCache = (listener: () => void) =>
  subscribeAppDataCache(APP_DATA_CACHE_KEYS.matchRules, listener);
export const useMatchRulesCache = <T = unknown>(): T[] => {
  const value = useAppDataCache<unknown>(APP_DATA_CACHE_KEYS.matchRules, []);
  return Array.isArray(value) ? (value as T[]) : [];
};

export const hasLogsCache = (): boolean => hasAppDataCache(APP_DATA_CACHE_KEYS.logs);
export const readLogsCache = <T = unknown>(): T[] =>
  readArrayCache<T>(APP_DATA_CACHE_KEYS.logs);
export const writeLogsCache = <T = unknown>(
  value: T[],
  options?: { persist?: boolean; broadcast?: boolean },
) => writeArrayCache(APP_DATA_CACHE_KEYS.logs, value, options);
export const subscribeLogsCache = (listener: () => void) =>
  subscribeAppDataCache(APP_DATA_CACHE_KEYS.logs, listener);
export const useLogsCache = <T = unknown>(): T[] => {
  const value = useAppDataCache<unknown>(APP_DATA_CACHE_KEYS.logs, []);
  return Array.isArray(value) ? (value as T[]) : [];
};

export const hasOverridesCache = (): boolean => hasAppDataCache(APP_DATA_CACHE_KEYS.overrides);
export const readOverridesCache = <T = unknown>(): T[] =>
  toArrayValue<T>(readAppDataCache(APP_DATA_CACHE_KEYS.overrides));
export const writeOverridesCache = <T = unknown>(
  value: T[],
  options?: { persist?: boolean; broadcast?: boolean },
) => writeAppDataCache(APP_DATA_CACHE_KEYS.overrides, value, options);
export const subscribeOverridesCache = (listener: () => void) =>
  subscribeAppDataCache(APP_DATA_CACHE_KEYS.overrides, listener);
export const useOverridesCache = <T = unknown>(): T[] => {
  const value = useAppDataCache<unknown>(APP_DATA_CACHE_KEYS.overrides, []);
  return toArrayValue<T>(value);
};

export const hasProxyProvidersCache = (): boolean =>
  hasAppDataCache(APP_DATA_CACHE_KEYS.proxyProviders);
export const readProxyProvidersCache = <T = unknown>(): T[] =>
  readArrayCache<T>(APP_DATA_CACHE_KEYS.proxyProviders);
export const writeProxyProvidersCache = <T = unknown>(
  value: T[],
  options?: { persist?: boolean; broadcast?: boolean },
) => writeArrayCache(APP_DATA_CACHE_KEYS.proxyProviders, value, options);
export const subscribeProxyProvidersCache = (listener: () => void) =>
  subscribeAppDataCache(APP_DATA_CACHE_KEYS.proxyProviders, listener);
export const useProxyProvidersCache = <T = unknown>(): T[] => {
  const value = useAppDataCache<unknown>(APP_DATA_CACHE_KEYS.proxyProviders, []);
  return Array.isArray(value) ? (value as T[]) : [];
};

export const hasRuleProvidersCache = (): boolean =>
  hasAppDataCache(APP_DATA_CACHE_KEYS.ruleProviders);
export const readRuleProvidersCache = <T = unknown>(): T[] =>
  readArrayCache<T>(APP_DATA_CACHE_KEYS.ruleProviders);
export const writeRuleProvidersCache = <T = unknown>(
  value: T[],
  options?: { persist?: boolean; broadcast?: boolean },
) => writeArrayCache(APP_DATA_CACHE_KEYS.ruleProviders, value, options);
export const subscribeRuleProvidersCache = (listener: () => void) =>
  subscribeAppDataCache(APP_DATA_CACHE_KEYS.ruleProviders, listener);
export const useRuleProvidersCache = <T = unknown>(): T[] => {
  const value = useAppDataCache<unknown>(APP_DATA_CACHE_KEYS.ruleProviders, []);
  return Array.isArray(value) ? (value as T[]) : [];
};

export const hasIpInfoCache = (): boolean => hasAppDataCache(APP_DATA_CACHE_KEYS.ipInfo);
export const readIpInfoCache = <T = unknown>(): T | null => {
  const cached = readAppDataCache<T | null>(APP_DATA_CACHE_KEYS.ipInfo, null);
  return cached ?? null;
};
export const writeIpInfoCache = <T = unknown>(
  value: T | null,
  options?: { persist?: boolean; broadcast?: boolean },
) => {
  writeAppDataCache(APP_DATA_CACHE_KEYS.ipInfo, value, options);
};
export const useIpInfoCache = <T = unknown>(): T | null => {
  return useAppDataCache<T | null>(APP_DATA_CACHE_KEYS.ipInfo, null);
};

export const subscribeMihomoRunningCache = (listener: () => void) =>
  subscribeAppDataCache(APP_DATA_CACHE_KEYS.mihomoRunning, listener);
export const subscribeSystemProxyEnabledCache = (listener: () => void) =>
  subscribeAppDataCache(APP_DATA_CACHE_KEYS.systemProxyEnabled, listener);
export const subscribeTunEnabledCache = (listener: () => void) =>
  subscribeAppDataCache(APP_DATA_CACHE_KEYS.tunEnabled, listener);
export const subscribeConnectionsCache = (listener: () => void) =>
  subscribeAppDataCache(APP_DATA_CACHE_KEYS.connections, listener);

export const writeSystemProxyEnabledCache = (
  value: boolean,
  options?: { persist?: boolean; broadcast?: boolean },
) => {
  writeAppDataCache(APP_DATA_CACHE_KEYS.systemProxyEnabled, value, options);
};

export const writeTunEnabledCache = (
  value: boolean,
  options?: { persist?: boolean; broadcast?: boolean },
) => {
  writeAppDataCache(APP_DATA_CACHE_KEYS.tunEnabled, value, options);
};

export const readSystemProxyEnabledCache = (): boolean | null =>
  normalizeBooleanCache(readAppDataCache(APP_DATA_CACHE_KEYS.systemProxyEnabled));

export const readTunEnabledCache = (): boolean | null =>
  normalizeBooleanCache(readAppDataCache(APP_DATA_CACHE_KEYS.tunEnabled));

export const useSubscriptionsCache = <T = unknown>(): T[] => {
  const value = useAppDataCache<unknown>(APP_DATA_CACHE_KEYS.subscriptions, []);
  return toArrayValue<T>(value);
};

export const useActiveConfigCache = (): string | null => {
  const value = useAppDataCache<string | null>(APP_DATA_CACHE_KEYS.activeConfig, null);
  return normalizeActiveConfig(value);
};

export const useProxyModeCache = (
  fallback: ProxyMode | null = null,
): ProxyMode | null => {
  const value = useAppDataCache<unknown>(APP_DATA_CACHE_KEYS.proxyMode, fallback);
  return normalizeProxyMode(value, fallback);
};

export const useMihomoRunningCache = (fallback = false): boolean => {
  const value = useAppDataCache<unknown>(APP_DATA_CACHE_KEYS.mihomoRunning, fallback);
  return normalizeBooleanCache(value) ?? fallback;
};

export const useSystemProxyEnabledCache = (fallback = false): boolean => {
  const value = useAppDataCache<unknown>(APP_DATA_CACHE_KEYS.systemProxyEnabled, fallback);
  return normalizeBooleanCache(value) ?? fallback;
};

export const useTunEnabledCache = (fallback = false): boolean => {
  const value = useAppDataCache<unknown>(APP_DATA_CACHE_KEYS.tunEnabled, fallback);
  return normalizeBooleanCache(value) ?? fallback;
};

export const useConnectionsCache = <T = unknown>(): T[] => {
  const value = useAppDataCache<unknown>(APP_DATA_CACHE_KEYS.connections, []);
  return Array.isArray(value) ? (value as T[]) : [];
};

export const useProxyGroupsCache = <T = unknown>(): T[] => {
  const value = useAppDataCache<unknown>(APP_DATA_CACHE_KEYS.proxyGroups, null);
  return unpackProxyGroupsCache<T>(value).groups;
};

export const useProxyGroupsEnvelope = <T = unknown>(): ProxyGroupsCacheEnvelope<T> => {
  const value = useAppDataCache<unknown>(APP_DATA_CACHE_KEYS.proxyGroups, null);
  return unpackProxyGroupsCache<T>(value);
};

export const appDataKey = (key: AppDataCacheKey) => key;
