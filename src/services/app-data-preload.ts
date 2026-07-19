'use client';

import {
  APP_DATA_CACHE_KEYS,
  hasAppDataCache,
} from '@/services/app-data-cache';
import {
  writeActiveConfigCache,
  writeConnectionsCache,
  writeLogsCache,
  writeMatchRulesCache,
  writeOverridesCache,
  writeProxyModeCache,
  writeProxyProvidersCache,
  writeRuleProvidersCache,
  writeSubscriptionsCache,
} from '@/services/app-data-hooks';
import { mihomoClient } from '@/services/mihomo-client';
import {
  filterProviderRecord,
  getConfiguredProviderNames,
  providerMap,
} from '@/services/provider-filter';

type PreloadOptions = {
  force?: boolean;
  timeoutMs?: number;
  idle?: boolean;
  idleTimeoutMs?: number;
};

type PreloadTask = {
  id: string;
  keys: string[];
  run: () => Promise<void>;
};

const inFlightTasks = new Map<string, Promise<void>>();

const isRecord = (value: unknown): value is Record<string, any> => {
  return !!value && typeof value === 'object' && !Array.isArray(value);
};

const hasElectronMethod = <K extends string>(
  api: unknown,
  method: K,
): api is Record<K, (...args: any[]) => Promise<any>> => {
  try {
    return !!api && typeof (api as Record<string, unknown>)[method] === 'function';
  } catch {
    return false;
  }
};

const toArray = <T,>(value: unknown): T[] => {
  if (Array.isArray(value)) return value as T[];
  if (isRecord(value)) {
    const nested = value.data ?? value.items ?? value.subscriptions ?? value.overrides;
    if (Array.isArray(nested)) return nested as T[];
  }
  return [];
};

const normalizeProviderList = (providersRecord: Record<string, any>) => {
  return Object.entries(providersRecord).map(([name, provider]) => ({
    ...provider,
    name: provider?.name || name,
    type: provider?.type || 'Proxy',
    vehicleType: provider?.vehicleType || provider?.vehicle_type || '',
    proxies: Array.isArray(provider?.proxies) ? provider.proxies : [],
    updatedAt: provider?.updatedAt ?? provider?.updated_at ?? undefined,
    subscriptionInfo: provider?.subscriptionInfo ?? null,
  }));
};

const requestMihomo = async (endpoint: string) => {
  const response: unknown = await mihomoClient.request(endpoint);
  if (!response) throw new Error(`${endpoint} returned empty response`);
  if (isRecord(response) && response.success === false) {
    throw new Error(String(response.error || response.message || `${endpoint} failed`));
  }
  if (isRecord(response) && 'ok' in response && response.ok === false) {
    throw new Error(String(response.statusText || response.error || `${endpoint} failed`));
  }

  return isRecord(response) && 'data' in response ? response.data : response;
};

const normalizeConnections = (value: any) => {
  return Array.isArray(value?.connections) ? value.connections : [];
};

const normalizeProxyMode = (value: any) => {
  const mode = typeof value?.mode === 'string' ? value.mode.toLowerCase() : '';
  return mode === 'rule' || mode === 'global' || mode === 'direct' ? mode : null;
};

const normalizeRules = (value: any) => {
  const rules = Array.isArray(value?.rules) ? value.rules : [];
  return rules.map((rule: any, index: number) => ({ ...rule, index }));
};

const normalizeOverrides = (value: any) => {
  if (Array.isArray(value)) return value;
  if (isRecord(value)) {
    const nested = value.items ?? value.overrides ?? value.data;
    return Array.isArray(nested) ? nested : [];
  }
  return [];
};

const shouldSkip = (keys: string[], force?: boolean) => {
  return !force && keys.length > 0 && keys.every((key) => hasAppDataCache(key as any));
};

const runTask = async (task: PreloadTask, options: PreloadOptions) => {
  if (shouldSkip(task.keys, options.force)) return;

  const existing = inFlightTasks.get(task.id);
  if (existing) {
    await existing;
    return;
  }

  const promise = task.run().catch((error) => {
    console.debug(`[AppDataPreload] ${task.id} failed:`, error);
  }).finally(() => {
    inFlightTasks.delete(task.id);
  });

  inFlightTasks.set(task.id, promise);
  await promise;
};

const withTimeout = async (promise: Promise<void>, timeoutMs?: number) => {
  if (!timeoutMs || timeoutMs <= 0) {
    await promise;
    return;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    promise,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
};

const waitForBackgroundSlot = async (timeoutMs = 800) => {
  if (typeof window === 'undefined') return;
  await new Promise<void>((resolve) => {
    const requestIdle = (window as any).requestIdleCallback as
      | ((callback: () => void, options?: { timeout?: number }) => number)
      | undefined;
    if (typeof requestIdle === 'function') {
      requestIdle(resolve, { timeout: timeoutMs });
    } else {
      window.setTimeout(resolve, Math.min(timeoutMs, 160));
    }
  });
};

const runTasks = async (
  tasks: PreloadTask[],
  options: PreloadOptions,
  concurrency = 2,
) => {
  if (tasks.length === 0) return;
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(concurrency, tasks.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (cursor < tasks.length) {
      const task = tasks[cursor];
      cursor += 1;
      if (options.idle) {
        await waitForBackgroundSlot(options.idleTimeoutMs);
      }
      await runTask(task, options);
    }
  });

  await Promise.allSettled(workers);
};

const preloadSubscriptions: PreloadTask = {
  id: 'subscriptions',
  keys: [APP_DATA_CACHE_KEYS.subscriptions],
  run: async () => {
    const api = window.electronAPI;
    if (!hasElectronMethod(api, 'getSubscriptions')) throw new Error('getSubscriptions unavailable');
    const result: unknown = await api.getSubscriptions();
    if (isRecord(result) && result.success === false) {
      throw new Error(String(result.error || result.message || 'getSubscriptions failed'));
    }
    writeSubscriptionsCache(toArray(result));
  },
};

const preloadActiveConfig: PreloadTask = {
  id: 'active-config',
  keys: [APP_DATA_CACHE_KEYS.activeConfig],
  run: async () => {
    const api = window.electronAPI;
    if (!hasElectronMethod(api, 'getActiveConfig')) throw new Error('getActiveConfig unavailable');
    const result = await api.getActiveConfig();
    const activeConfig = typeof result === 'string' && result.trim() ? result : null;
    writeActiveConfigCache(activeConfig);
  },
};

const preloadProxyMode: PreloadTask = {
  id: 'proxy-mode',
  keys: [APP_DATA_CACHE_KEYS.proxyMode],
  run: async () => {
    const result = await requestMihomo('/configs');
    const mode = normalizeProxyMode(result);
    if (mode === 'rule' || mode === 'global' || mode === 'direct') {
      writeProxyModeCache(mode);
    }
  },
};

const preloadConnections: PreloadTask = {
  id: 'connections',
  keys: [APP_DATA_CACHE_KEYS.connections],
  run: async () => {
    const result = await requestMihomo('/connections');
    writeConnectionsCache(normalizeConnections(result));
  },
};

const preloadRules: PreloadTask = {
  id: 'match-rules',
  keys: [APP_DATA_CACHE_KEYS.matchRules],
  run: async () => {
    const result = await requestMihomo('/rules');
    writeMatchRulesCache(normalizeRules(result));
  },
};

const preloadProxyProviders: PreloadTask = {
  id: 'proxy-providers',
  keys: [APP_DATA_CACHE_KEYS.proxyProviders],
  run: async () => {
    const api = window.electronAPI;
    if (!hasElectronMethod(api, 'getProxyProviders')) throw new Error('getProxyProviders unavailable');
    const result: unknown = await api.getProxyProviders();
    if (!isRecord(result) || result.success !== true) {
      const message = isRecord(result)
        ? String(result.error || result.message || 'getProxyProviders failed')
        : 'getProxyProviders failed';
      throw new Error(message);
    }
    const providersRecord = providerMap(result);
    const configuredNames = await getConfiguredProviderNames('proxyProviders');
    const providers = providersRecord && typeof providersRecord === 'object'
      ? normalizeProviderList(filterProviderRecord(
          providersRecord as Record<string, any>,
          'proxyProviders',
          configuredNames,
        ))
      : [];
    writeProxyProvidersCache(providers);
  },
};

const preloadRuleProviders: PreloadTask = {
  id: 'rule-providers',
  keys: [APP_DATA_CACHE_KEYS.ruleProviders],
  run: async () => {
    const api = window.electronAPI;
    if (!hasElectronMethod(api, 'getRuleProviders')) throw new Error('getRuleProviders unavailable');
    const result: unknown = await api.getRuleProviders();
    if (!isRecord(result) || result.success !== true) {
      const message = isRecord(result)
        ? String(result.error || result.message || 'getRuleProviders failed')
        : 'getRuleProviders failed';
      throw new Error(message);
    }
    const providersRecord = providerMap(result);
    const configuredNames = await getConfiguredProviderNames('ruleProviders');
    const providers = providersRecord && typeof providersRecord === 'object'
      ? Object.values(filterProviderRecord(
          providersRecord as Record<string, any>,
          'ruleProviders',
          configuredNames,
        ))
      : [];
    writeRuleProvidersCache(providers);
  },
};

const preloadOverrides: PreloadTask = {
  id: 'overrides',
  keys: [APP_DATA_CACHE_KEYS.overrides],
  run: async () => {
    const api = window.electronAPI;
    if (!hasElectronMethod(api, 'getOverrides')) throw new Error('getOverrides unavailable');
    const result: unknown = await api.getOverrides();
    if (isRecord(result) && result.success === false) {
      throw new Error(String(result.error || result.message || 'getOverrides failed'));
    }
    writeOverridesCache(normalizeOverrides(result));
  },
};

const preloadLogs: PreloadTask = {
  id: 'logs',
  keys: [APP_DATA_CACHE_KEYS.logs],
  run: async () => {
    const api = window.electronAPI;
    if (!hasElectronMethod(api, 'getLogs')) throw new Error('getLogs unavailable');
    const result: unknown = await api.getLogs();
    if (isRecord(result) && result.success === false) {
      throw new Error(String(result.error || result.message || 'getLogs failed'));
    }
    if (Array.isArray(result)) {
      writeLogsCache(result);
    }
  },
};

const commonTasks = [
  preloadSubscriptions,
  preloadActiveConfig,
  preloadProxyMode,
];

const startupTasks = [
  preloadSubscriptions,
  preloadActiveConfig,
  preloadProxyMode,
];

const routeTasks: Array<{ match: (path: string) => boolean; tasks: PreloadTask[] }> = [
  { match: (path) => path === '/', tasks: [preloadSubscriptions, preloadActiveConfig, preloadProxyMode] },
  { match: (path) => path.startsWith('/nodes'), tasks: [preloadProxyMode] },
  { match: (path) => path.startsWith('/subscriptions'), tasks: [preloadSubscriptions, preloadActiveConfig] },
  { match: (path) => path.startsWith('/connections'), tasks: [preloadConnections] },
  { match: (path) => path.startsWith('/match-rules'), tasks: [preloadRules] },
  { match: (path) => path.startsWith('/providers'), tasks: [preloadProxyProviders, preloadRuleProviders] },
  { match: (path) => path.startsWith('/overrides'), tasks: [preloadOverrides] },
  { match: (path) => path.startsWith('/logs'), tasks: [preloadLogs] },
  { match: (path) => path.startsWith('/external-resources'), tasks: [preloadProxyMode] },
];

const routePath = (href: string) => {
  try {
    return new URL(href, 'http://flyclash.local').pathname;
  } catch {
    return href.split('?')[0] || '/';
  }
};

export const preloadCommonAppData = async (options: PreloadOptions = {}) => {
  if (typeof window === 'undefined' || !window.electronAPI) return;
  const tasks = options.force ? commonTasks : startupTasks;
  const promise = runTasks(tasks, options, 1);
  await withTimeout(promise, options.timeoutMs);
};

export const preloadRouteData = async (href: string, options: PreloadOptions = {}) => {
  if (typeof window === 'undefined' || !window.electronAPI) return;
  const path = routePath(href);
  const matched = routeTasks.find((entry) => entry.match(path));
  if (!matched) return;

  const promise = runTasks(matched.tasks, options, 2);
  await withTimeout(promise, options.timeoutMs);
};
