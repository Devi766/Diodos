'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  BarChart3,
  Download,
  Globe,
  SlidersHorizontal,
  Play,
  RefreshCw,
  Square,
  Upload,
  LogOut,
  Settings2,
  Plus,
  RotateCcw,
  Check,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { CustomizableDashboard } from '@/components/CustomizableDashboard';
import { useTranslation } from 'react-i18next';
import { useThemeColor } from '@/hooks/useThemeColor';
import { DASHBOARD_CONFIG_KEY, DEFAULT_DASHBOARD_CARDS } from '@/types/dashboard';
import { getBrowserPlatform, getRuntimePlatform, RuntimePlatform } from '@/utils/platform';
import {
  APP_DATA_CACHE_KEYS,
  readActiveConfigCache,
  readConnectionsCache,
  readDashboardRuntimeCache,
  readMihomoRunningCache,
  readProxyModeCache,
  readSystemProxyEnabledCache,
  readTunEnabledCache,
  subscribeConnectionsCache,
  subscribeDashboardRuntimeCache,
  subscribeMihomoRunningCache,
  subscribeSystemProxyEnabledCache,
  subscribeTunEnabledCache,
  writeActiveConfigCache,
  writeDashboardRuntimeCache,
  writeMihomoRunningCache,
  writeProxyModeCache,
  writeSystemProxyEnabledCache,
  writeTunEnabledCache,
  type ProxyMode,
} from '@/services/app-data-hooks';
import { mihomoClient } from '@/services/mihomo-client';

const readCachedBoolean = (key: typeof APP_DATA_CACHE_KEYS[keyof typeof APP_DATA_CACHE_KEYS]) => {
  if (key === APP_DATA_CACHE_KEYS.mihomoRunning) return readMihomoRunningCache() ?? false;
  if (key === APP_DATA_CACHE_KEYS.systemProxyEnabled) return readSystemProxyEnabledCache() ?? false;
  if (key === APP_DATA_CACHE_KEYS.tunEnabled) return readTunEnabledCache() ?? false;
  return false;
};

const readCachedBooleanMaybe = (
  key: typeof APP_DATA_CACHE_KEYS[keyof typeof APP_DATA_CACHE_KEYS],
): boolean | null => {
  if (key === APP_DATA_CACHE_KEYS.mihomoRunning) return readMihomoRunningCache();
  if (key === APP_DATA_CACHE_KEYS.systemProxyEnabled) return readSystemProxyEnabledCache();
  if (key === APP_DATA_CACHE_KEYS.tunEnabled) return readTunEnabledCache();
  return null;
};

const writeCachedBoolean = (
  key: typeof APP_DATA_CACHE_KEYS[keyof typeof APP_DATA_CACHE_KEYS],
  value: boolean,
) => {
  if (key === APP_DATA_CACHE_KEYS.mihomoRunning) {
    writeMihomoRunningCache(value);
    return;
  }
  if (key === APP_DATA_CACHE_KEYS.systemProxyEnabled) {
    writeSystemProxyEnabledCache(value);
    return;
  }
  if (key === APP_DATA_CACHE_KEYS.tunEnabled) {
    writeTunEnabledCache(value);
  }
};

const hasDesktopRuntime = () => {
  if (typeof window === 'undefined') return false;
  const runtimeWindow = window as any;
  const tauriCore = runtimeWindow.__TAURI__?.core;
  const tauriInternals = runtimeWindow.__TAURI_INTERNALS__;
  return (
    (!!tauriCore && typeof tauriCore.invoke === 'function') ||
    (!!tauriInternals && typeof tauriInternals.invoke === 'function') ||
    typeof runtimeWindow.__TAURI_IPC__ === 'function' ||
    /Electron/i.test(window.navigator.userAgent || '')
  );
};

const isWindowsTunServiceReady = (status: any) => {
  if (!status || status.success === false) return false;
  if (typeof status.serviceReady === 'boolean') {
    return status.serviceReady;
  }
  if (status.readiness === 'ready') return true;
  if (status.readiness === 'running-no-ipc') return false;
  // Back-compat for older helper payloads that only expose running/ipcAvailable.
  return Boolean(status.running && status.ipcAvailable !== false);
};

const tunServiceStatusError = (status: any) => {
  if (!status || typeof status !== 'object') return '';
  if (status.readiness === 'running-no-ipc') {
    return String(
      status.error ||
        status.helperStatusError ||
        status.helperVersionError ||
        'Helper 服务运行中但 IPC 不可用，请在 TUN 设置中点击“修复 IPC”',
    );
  }
  return String(
    status.error ||
      status.helperStatusError ||
      status.helperVersionError ||
      status.status?.error ||
      '',
  );
};

type TrafficStats = {
  up: number;
  down: number;
  upSpeed: number;
  downSpeed: number;
  timestamp?: number;
};

type TrafficSample = {
  timestamp: number;
  upSpeed: number;
  downSpeed: number;
};

type ConnectionsSnapshot = {
  activeConnections?: number;
  currentNode?: string;
  downloadTotal?: number;
  uploadTotal?: number;
};

type DashboardRuntimeSnapshot = {
  connectionCount: number;
  totalUpload: number;
  totalDownload: number;
  upSpeed: number;
  downSpeed: number;
  uploadTotal: number;
  downloadTotal: number;
  trafficSamples: TrafficSample[];
  connections: any[];
  currentNode: string;
  updatedAt: number;
};

type BannerState = {
  type: 'success' | 'error' | 'info' | 'warning';
  message: string;
};

const TAURI_RUNTIME_UNAVAILABLE = 'Tauri runtime is not available';

const GROUP_PROXY_TYPE_REGEX = /(selector|test|fallback|balance|relay|chain|auto|lazy|switch|smart)/i;
const KNOWN_GROUPS = new Set(['PROXY', 'GLOBAL', 'AUTO']);
const KNOWN_BUILTINS = new Set(['DIRECT', 'REJECT', 'PASS']);
const CURRENT_NODE_SELECTION_GRACE_MS = 2500;
const MAX_DASHBOARD_CONNECTIONS = 80;
const DASHBOARD_CONNECTION_POLL_MS = 5000;
const isKnownBuiltinName = (name: string) => KNOWN_BUILTINS.has(String(name || '').toUpperCase());
const isLikelyGroupOrBuiltin = (name: string) => {
  const upper = String(name || '').toUpperCase();
  return KNOWN_GROUPS.has(upper) || KNOWN_BUILTINS.has(upper);
};

const isProxyGroupInfo = (info: any) => {
  if (!info || typeof info !== 'object') return false;
  const type = typeof info.type === 'string' ? info.type : '';
  if (GROUP_PROXY_TYPE_REGEX.test(type)) return true;
  if (Array.isArray(info.all) || Array.isArray(info.proxies)) return true;
  return false;
};

const formatBytes = (value: number, fractionDigits = 1) => {
  if (!Number.isFinite(value)) return '0 B';
  if (value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let index = 0;
  let size = value;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(fractionDigits)} ${units[index]}`;
};

const formatSpeed = (value: number) => {
  if (!Number.isFinite(value)) return '0 B/s';
  if (value <= 0) return '0 B/s';
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  let index = 0;
  let speed = value;
  while (speed >= 1024 && index < units.length - 1) {
    speed /= 1024;
    index += 1;
  }
  const decimals = speed >= 100 ? 0 : 2;
  return `${speed.toFixed(decimals)} ${units[index]}`;
};

const getFileName = (path?: string | null, t?: any) => {
  if (!path) return t ? t('dashboard.noConfigSelected') : 'No config';
  const parts = path.split(/[/\\]/);
  const name = parts[parts.length - 1];
  return name || path;
};

const emptyDashboardRuntimeSnapshot = (): DashboardRuntimeSnapshot => ({
  connectionCount: 0,
  totalUpload: 0,
  totalDownload: 0,
  upSpeed: 0,
  downSpeed: 0,
  uploadTotal: 0,
  downloadTotal: 0,
  trafficSamples: [],
  connections: [],
  currentNode: '',
  updatedAt: 0,
});

const finiteNumber = (value: unknown, fallback = 0) => {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
};

const sanitizeTrafficSamples = (value: unknown): TrafficSample[] => {
  if (!Array.isArray(value)) return [];
  return value
    .filter((sample): sample is TrafficSample => (
      !!sample &&
      typeof sample === 'object' &&
      Number.isFinite((sample as TrafficSample).timestamp)
    ))
    .map((sample) => ({
      timestamp: finiteNumber(sample.timestamp, Date.now()),
      upSpeed: finiteNumber(sample.upSpeed),
      downSpeed: finiteNumber(sample.downSpeed),
    }))
    .slice(-120);
};

const sanitizeDashboardRuntimeSnapshot = (value: unknown): DashboardRuntimeSnapshot => {
  const fallback = emptyDashboardRuntimeSnapshot();
  if (!value || typeof value !== 'object') return fallback;

  const record = value as Partial<DashboardRuntimeSnapshot>;
  const connections = Array.isArray(record.connections) ? record.connections.slice(0, MAX_DASHBOARD_CONNECTIONS) : [];
  return {
    connectionCount: finiteNumber(record.connectionCount, connections.length),
    totalUpload: finiteNumber(record.totalUpload, finiteNumber(record.uploadTotal)),
    totalDownload: finiteNumber(record.totalDownload, finiteNumber(record.downloadTotal)),
    upSpeed: finiteNumber(record.upSpeed),
    downSpeed: finiteNumber(record.downSpeed),
    uploadTotal: finiteNumber(record.uploadTotal, finiteNumber(record.totalUpload)),
    downloadTotal: finiteNumber(record.downloadTotal, finiteNumber(record.totalDownload)),
    trafficSamples: sanitizeTrafficSamples(record.trafficSamples),
    connections,
    currentNode: typeof record.currentNode === 'string' ? record.currentNode : '',
    updatedAt: finiteNumber(record.updatedAt),
  };
};

const readCachedDashboardRuntimeSnapshot = () => {
  return sanitizeDashboardRuntimeSnapshot(
    readDashboardRuntimeCache<Partial<DashboardRuntimeSnapshot>>(),
  );
};

const toSubscriptionArray = (value: unknown): any[] => {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];

  const record = value as Record<string, unknown>;
  const nested = record.data ?? record.subscriptions ?? record.items;
  if (Array.isArray(nested)) return nested;

  if (nested && typeof nested === 'object') {
    const nestedRecord = nested as Record<string, unknown>;
    if (Array.isArray(nestedRecord.subscriptions)) return nestedRecord.subscriptions;
    if (Array.isArray(nestedRecord.items)) return nestedRecord.items;
  }

  return [];
};

const loadConfigIcon = async (configPath: string | null): Promise<string | null> => {
  if (!configPath || !window.electronAPI) return null;

  try {
    const subs = toSubscriptionArray(await window.electronAPI.getSubscriptions());
    if (subs.length === 0) return null;

    const sub = subs.find((s: any) => s.path === configPath);

    if (sub?.iconUrl && window.electronAPI.configIcon) {
      const result = await window.electronAPI.configIcon.getIcon(sub.iconUrl, configPath);
      if (result.success && result.iconPath) {
        return result.iconPath;
      }
    }
  } catch (error) {
    console.error('加载配置图标失败:', error);
  }

  return null;
};

const resolveElectron = () => {
  if (typeof window === 'undefined') return undefined;
  return window.electronAPI;
};

const notifyDashboardProfileUpdated = (detail: Record<string, unknown> = {}) => {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('profile-updated', {
    detail: { source: 'dashboard', ...detail },
  }));
};

const pickPrimaryProxyGroupName = (groups: any[] | undefined | null): string | null => {
  const availableGroups = Array.isArray(groups)
    ? groups.filter((group) => {
        const name = typeof group?.name === 'string' ? group.name.trim() : '';
        return name.length > 0 && group?.hidden !== true;
      })
    : [];
  if (availableGroups.length === 0) return null;

  const proxyGroup = availableGroups.find((group) => group.name === 'PROXY');
  if (proxyGroup?.name) return proxyGroup.name;

  const firstNonGlobal = availableGroups.find((group) => group.name !== 'GLOBAL');
  if (firstNonGlobal?.name) return firstNonGlobal.name;

  return availableGroups[0]?.name ?? null;
};

export default function Dashboard() {
  const { t } = useTranslation();
  const themeColor = useThemeColor();

  const initialRunningCache = readCachedBooleanMaybe(APP_DATA_CACHE_KEYS.mihomoRunning);
  const initialRuntimeSnapshotRef = useRef(readCachedDashboardRuntimeSnapshot());
  const [isRunning, setIsRunning] = useState(() => initialRunningCache === true);
  const [runningStatusHydrated, setRunningStatusHydrated] = useState(() => initialRunningCache === true);
  const [proxyEnabled, setProxyEnabled] = useState(() => readCachedBoolean(APP_DATA_CACHE_KEYS.systemProxyEnabled));
  const [tunEnabled, setTunEnabled] = useState(() => readCachedBoolean(APP_DATA_CACHE_KEYS.tunEnabled));
  const [proxyMode, setProxyMode] = useState<ProxyMode | null>(() => readProxyModeCache());
  const [isModeUpdating, setIsModeUpdating] = useState(false);
  const [isProxyUpdating, setIsProxyUpdating] = useState(false);
  const [isTunUpdating, setIsTunUpdating] = useState(false);
  const [isServiceBusy, setIsServiceBusy] = useState(false);
  const [activeConfig, setActiveConfig] = useState<string | null>(() => readActiveConfigCache());
  const [preferredConfig, setPreferredConfig] = useState<string | null>(() => readActiveConfigCache());
  const [activeConfigIcon, setActiveConfigIcon] = useState<string | null>(null);
  const [currentNode, setCurrentNode] = useState<string>(() => initialRuntimeSnapshotRef.current.currentNode);
  const [primaryProxyGroup, setPrimaryProxyGroup] = useState<string>('PROXY');
  const [connectionCount, setConnectionCount] = useState(() => initialRuntimeSnapshotRef.current.connectionCount);
  const [totalUpload, setTotalUpload] = useState(() => initialRuntimeSnapshotRef.current.totalUpload);
  const [totalDownload, setTotalDownload] = useState(() => initialRuntimeSnapshotRef.current.totalDownload);
  const [upSpeed, setUpSpeed] = useState(() => initialRuntimeSnapshotRef.current.upSpeed);
  const [downSpeed, setDownSpeed] = useState(() => initialRuntimeSnapshotRef.current.downSpeed);
  const [trafficSamples, setTrafficSamples] = useState<TrafficSample[]>(() => initialRuntimeSnapshotRef.current.trafficSamples);
  const [banner, setBanner] = useState<BannerState | null>(null);
  const [tunConfirmOpen, setTunConfirmOpen] = useState(false);
  const [hasAdminPermission, setHasAdminPermission] = useState(true);
  const [isEditMode, setIsEditMode] = useState(false);
  const [showAddCardDialog, setShowAddCardDialog] = useState(false);
  const [startErrorMsg, setStartErrorMsg] = useState<string | null>(null);
  const [connections, setConnections] = useState<any[]>(() => initialRuntimeSnapshotRef.current.connections);
  const [uploadTotal, setUploadTotal] = useState(() => initialRuntimeSnapshotRef.current.uploadTotal);
  const [downloadTotal, setDownloadTotal] = useState(() => initialRuntimeSnapshotRef.current.downloadTotal);
  const runtimeSnapshotRef = useRef<DashboardRuntimeSnapshot>(initialRuntimeSnapshotRef.current);
  const currentNodeRequestRef = useRef(0);
  const lastNodeSelectionRef = useRef<{ nodeName: string; groupName: string; timestamp: number } | null>(null);

  const electron = useMemo(resolveElectron, []);
  const [runtimePlatform, setRuntimePlatform] = useState<RuntimePlatform>(() => getBrowserPlatform());
  const isWindowsPlatform = runtimePlatform === 'win32';
  const isMacPlatform = runtimePlatform === 'darwin';
  const isLinuxPlatform = runtimePlatform === 'linux';

  useEffect(() => {
    let disposed = false;

    void getRuntimePlatform().then((platform) => {
      if (!disposed) {
        setRuntimePlatform(platform);
      }
    });

    return () => {
      disposed = true;
    };
  }, []);

  const formatDashboardError = useCallback((error: unknown, fallback = t('dashboard.operationFailed')) => {
    const message = error instanceof Error ? error.message : (error ? String(error) : fallback);
    if (
      message.includes(TAURI_RUNTIME_UNAVAILABLE) ||
      message.includes('not implemented in the Tauri runtime')
    ) {
      return t('dashboard.apiUnavailable');
    }
    return message;
  }, [t]);

  const resultError = useCallback((result: any, fallback = t('dashboard.operationFailed')) => {
    return formatDashboardError(result?.error || result?.message || result?.errorMessage, fallback);
  }, [formatDashboardError, t]);

  const normalizeConfigPath = useCallback((value: unknown): string | null => {
    if (typeof value !== 'string') return null;
    const path = value.trim();
    return path ? path : null;
  }, []);

  const tunDialogDescription = useMemo(() => {
    if (electron?.checkElevateTask) {
      return !hasAdminPermission
        ? t('dashboard.tunModeWindowsAuthorizePrompt')
        : t('dashboard.tunModeWindowsConfirmPrompt');
    }
    if (isWindowsPlatform) {
      return t('dashboard.tunModeWindowsConfirmPrompt');
    }
    if (isMacPlatform) {
      return t('dashboard.tunModeMacWarning');
    }
    if (isLinuxPlatform) {
      return t('dashboard.tunModeLinuxWarning');
    }
    return t('dashboard.tunModeWarning');
  }, [electron, hasAdminPermission, isWindowsPlatform, isMacPlatform, isLinuxPlatform, t]);

  const proxiesSnapshotRef = useRef<{ timestamp: number; data: Record<string, any> | null }>(
    {
      timestamp: 0,
      data: null
    }
  );

  const rememberNodeSelection = useCallback((nodeName?: string | null, groupName?: string | null) => {
    const normalizedNode = typeof nodeName === 'string' ? nodeName.trim() : '';
    const normalizedGroup = typeof groupName === 'string' ? groupName.trim() : '';
    if (!normalizedNode || !normalizedGroup) return;

    lastNodeSelectionRef.current = {
      nodeName: normalizedNode,
      groupName: normalizedGroup,
      timestamp: Date.now(),
    };

    const snapshot = proxiesSnapshotRef.current.data;
    if (snapshot) {
      snapshot[normalizedGroup] = {
        ...(snapshot[normalizedGroup] || {}),
        name: normalizedGroup,
        type: snapshot[normalizedGroup]?.type || 'Selector',
        now: normalizedNode,
      };
    }
  }, []);

  const isWithinNodeSelectionGrace = useCallback(() => {
    const lastSelection = lastNodeSelectionRef.current;
    return !!lastSelection && Date.now() - lastSelection.timestamp < CURRENT_NODE_SELECTION_GRACE_MS;
  }, []);

  const writeRuntimeSnapshot = useCallback((patch: Partial<DashboardRuntimeSnapshot>) => {
    const next = sanitizeDashboardRuntimeSnapshot({
      ...runtimeSnapshotRef.current,
      ...patch,
      updatedAt: Date.now(),
    });
    runtimeSnapshotRef.current = next;
    writeDashboardRuntimeCache(next as Record<string, unknown>);
    return next;
  }, []);

  const clearRuntimeSnapshot = useCallback(() => {
    const next = emptyDashboardRuntimeSnapshot();
    runtimeSnapshotRef.current = next;
    setCurrentNode('');
    setConnectionCount(0);
    setTotalUpload(0);
    setTotalDownload(0);
    setUpSpeed(0);
    setDownSpeed(0);
    setTrafficSamples([]);
    setConnections([]);
    setUploadTotal(0);
    setDownloadTotal(0);
    writeDashboardRuntimeCache(next as Record<string, unknown>);
  }, []);

  const getProxiesSnapshot = useCallback(
    async (force = false): Promise<Record<string, any>> => {
      const now = Date.now();
      const snapshot = proxiesSnapshotRef.current;
      if (!force && snapshot.data && now - snapshot.timestamp < 1500) {
        return snapshot.data;
      }

      try {
        const payload: any = await mihomoClient.getProxies();
        const proxies = payload?.proxies ?? payload;
        const normalized =
          proxies && typeof proxies === 'object' && !Array.isArray(proxies) ? { ...proxies } : {};
        proxiesSnapshotRef.current = { timestamp: now, data: normalized };
        return normalized;
      } catch {
        if (!snapshot.data) {
          proxiesSnapshotRef.current = { timestamp: now, data: {} };
        } else {
          proxiesSnapshotRef.current = { timestamp: now, data: snapshot.data };
        }
        return proxiesSnapshotRef.current.data ?? {};
      }
    },
    []
  );

  const resolveEffectiveNode = useCallback(
    async (
      rawName?: string | null,
      fallbackGroup?: string,
      options?: { forceRefresh?: boolean }
    ): Promise<string | null> => {
      const base = typeof rawName === 'string' ? rawName.trim() : '';
      const fallback = typeof fallbackGroup === 'string' ? fallbackGroup.trim() : '';
      const start = base || fallback;

      if (!start) {
        return null;
      }

      const snapshot = await getProxiesSnapshot(options?.forceRefresh === true);
      const visited = new Set<string>();

      const ensureDetail = async (name: string) => {
        const normalized = name.trim();
        if (!normalized) return null;

        let info = snapshot[normalized];
        if (!info) {
          try {
            const payload: any = await mihomoClient.getProxyByName(normalized);
            if (payload && typeof payload === 'object') {
              const merged = { ...(snapshot[normalized] || {}), ...payload };
              snapshot[normalized] = merged;
              if (proxiesSnapshotRef.current.data) {
                proxiesSnapshotRef.current.data[normalized] = merged;
              }
              info = merged;
            }
          } catch {
            info = snapshot[normalized];
          }
        }
        return info;
      };

      const traverse = async (name: string): Promise<string> => {
        const normalized = name.trim();
        if (!normalized) return normalized;
        if (visited.has(normalized)) return normalized;
        visited.add(normalized);

        const info = await ensureDetail(normalized);
        if (!info) return normalized;

        const next = typeof info.now === 'string' ? info.now.trim() : '';
        if (next && next !== normalized && isProxyGroupInfo(info)) {
          return traverse(next);
        }

        return normalized;
      };

      try {
        const result = await traverse(start);
        return result || start;
      } catch {
        return start;
      }
    },
    [getProxiesSnapshot]
  );

  const commitCurrentNode = useCallback(
    (value: string) => {
      const trimmed = value.trim();
      writeRuntimeSnapshot({ currentNode: trimmed });
      setCurrentNode(trimmed);
    },
    [writeRuntimeSnapshot]
  );

  const isRuntimeProxyGroupName = useCallback((name?: string | null) => {
    const normalized = typeof name === 'string' ? name.trim() : '';
    if (!normalized) return false;
    const info = proxiesSnapshotRef.current.data?.[normalized];
    return isProxyGroupInfo(info);
  }, []);

  const isDisplayableCurrentNode = useCallback(
    (
      name?: string | null,
      modeOverride?: ProxyMode | null,
      options?: { allowBuiltin?: boolean }
    ) => {
      const normalized = typeof name === 'string' ? name.trim() : '';
      if (!normalized) return false;
      const effectiveMode = modeOverride ?? proxyMode;
      if (isKnownBuiltinName(normalized)) {
        return options?.allowBuiltin === true || effectiveMode === 'direct' || effectiveMode === 'global';
      }
      return !isLikelyGroupOrBuiltin(normalized) && !isRuntimeProxyGroupName(normalized);
    },
    [isRuntimeProxyGroupName, proxyMode]
  );

  const updateCurrentNodeDisplay = useCallback(
    (
      rawNodeName?: string | null,
      fallbackGroup?: string,
      options?: { forceRefresh?: boolean; mode?: ProxyMode | null; source?: 'selection' | 'sync' | 'connections' | 'bootstrap' }
    ) => {
      const base = typeof rawNodeName === 'string' ? rawNodeName.trim() : '';
      const fallback = typeof fallbackGroup === 'string' ? fallbackGroup.trim() : '';

      if (!base && !fallback) {
        return;
      }

      const requestId = ++currentNodeRequestRef.current;
      void (async () => {
        const shouldPreferFallback = !!fallback && (!base || isLikelyGroupOrBuiltin(base) || isRuntimeProxyGroupName(base));
        const resolved = shouldPreferFallback
          ? await resolveEffectiveNode(null, fallback, options)
          : await resolveEffectiveNode(base || null, fallback || undefined, options);
        if (requestId !== currentNodeRequestRef.current) return;

        if (
          resolved &&
          isDisplayableCurrentNode(resolved, options?.mode, {
            allowBuiltin: shouldPreferFallback || !!fallback,
          })
        ) {
          commitCurrentNode(resolved);
        } else if (base && isDisplayableCurrentNode(base, options?.mode)) {
          commitCurrentNode(base);
        } else if (fallback && isDisplayableCurrentNode(fallback, options?.mode)) {
          commitCurrentNode(fallback);
        }
      })();
    },
    [commitCurrentNode, isDisplayableCurrentNode, isRuntimeProxyGroupName, resolveEffectiveNode]
  );

  const MODE_LABELS: Record<ProxyMode, string> = {
    rule: t('dashboard.ruleMode'),
    global: t('dashboard.globalMode'),
    direct: t('dashboard.directMode')
  };

  const MODE_OPTIONS: Array<{ key: ProxyMode; label: string; icon: React.ReactNode }> = [
    {
      key: 'rule',
      label: MODE_LABELS.rule,
      icon: <SlidersHorizontal className="h-[14px] w-[14px]" />
    },
    {
      key: 'global',
      label: MODE_LABELS.global,
      icon: <Globe className="h-[14px] w-[14px]" />
    },
    {
      key: 'direct',
      label: MODE_LABELS.direct,
      icon: <LogOut className="h-[14px] w-[14px]" />
    }
  ];

  const hydrateConnections = useCallback(
    (snapshot: ConnectionsSnapshot | null | undefined) => {
      if (!snapshot) return;
      const patch: Partial<DashboardRuntimeSnapshot> = {};
      if (typeof snapshot.activeConnections === 'number') {
        setConnectionCount(snapshot.activeConnections);
        patch.connectionCount = snapshot.activeConnections;
      }
      if (typeof snapshot.downloadTotal === 'number') {
        setTotalDownload(snapshot.downloadTotal);
        setDownloadTotal(snapshot.downloadTotal);
        patch.totalDownload = snapshot.downloadTotal;
        patch.downloadTotal = snapshot.downloadTotal;
      }
      if (typeof snapshot.uploadTotal === 'number') {
        setTotalUpload(snapshot.uploadTotal);
        setUploadTotal(snapshot.uploadTotal);
        patch.totalUpload = snapshot.uploadTotal;
        patch.uploadTotal = snapshot.uploadTotal;
      }
      if (Object.keys(patch).length > 0) {
        writeRuntimeSnapshot(patch);
      }
      if (snapshot.currentNode) {
        const modeForDisplay = proxyMode ?? readProxyModeCache();
        if (modeForDisplay === 'direct') {
          commitCurrentNode('DIRECT');
        } else if (!isWithinNodeSelectionGrace()) {
          const displayGroup = modeForDisplay === 'global' ? 'GLOBAL' : primaryProxyGroup;
          updateCurrentNodeDisplay(undefined, displayGroup, {
            mode: modeForDisplay,
            source: 'connections',
          });
        }
      }
    },
    [commitCurrentNode, isWithinNodeSelectionGrace, primaryProxyGroup, proxyMode, updateCurrentNodeDisplay, writeRuntimeSnapshot]
  );

  const syncCurrentNode = useCallback(async (overrideMode?: ProxyMode | null) => {
    if (!electron || !isRunning) return;
    const requestId = ++currentNodeRequestRef.current;
    try {
      await getProxiesSnapshot(true);
      if (requestId !== currentNodeRequestRef.current) return;
      if (!proxiesSnapshotRef.current.data) {
        proxiesSnapshotRef.current.data = {};
      }

      const snapshotCache = proxiesSnapshotRef.current.data;
      // 根据代理模式决定候选组的优先级
      // 全局模式使用 GLOBAL 组，规则模式使用配置里的主策略组，避免两种模式互相污染显示。
      // 使用传入的 overrideMode 或当前的 proxyMode；未知时按 rule 处理。
      const effectiveMode: ProxyMode = overrideMode ?? proxyMode ?? 'rule';
      let allCandidates: string[];
      if (effectiveMode === 'global') {
        allCandidates = ['GLOBAL'];
      } else if (effectiveMode === 'direct') {
        commitCurrentNode('DIRECT');
        return;
      } else {
        allCandidates = [primaryProxyGroup, 'PROXY'].filter(Boolean);
      }
      const candidateGroups = Array.from(new Set(allCandidates)).filter(groupName =>
        snapshotCache && typeof snapshotCache[groupName] !== 'undefined'
      );

      // 如果没有找到任何候选组，使用主代理组
      if (candidateGroups.length === 0 && primaryProxyGroup) {
        candidateGroups.push(primaryProxyGroup);
      }

      let resolvedNode: string | null = null;
      let resolvedFromGroup: string | null = null;

      for (const groupName of candidateGroups) {
        if (resolvedNode) break;
        try {
          const payload: any = await mihomoClient.getProxyByName(groupName);
          if (payload && typeof payload === 'object') {
            const merged = { ...(snapshotCache[groupName] || {}), ...payload };
            snapshotCache[groupName] = merged;
            if (proxiesSnapshotRef.current.data) {
              proxiesSnapshotRef.current.data[groupName] = merged;
            }

            const finalNode = await resolveEffectiveNode(
              typeof payload.now === 'string' && payload.now.length > 0 ? payload.now : null,
              groupName
            );
            if (requestId !== currentNodeRequestRef.current) return;
            if (finalNode && finalNode.length > 0) {
              resolvedNode = finalNode;
              resolvedFromGroup = groupName;
            }
          }
        } catch {}
      }

      if (!resolvedNode) {
        for (const groupName of candidateGroups) {
          const finalNode = await resolveEffectiveNode(null, groupName);
          if (requestId !== currentNodeRequestRef.current) return;
          if (finalNode && finalNode.length > 0) {
            resolvedNode = finalNode;
            resolvedFromGroup = groupName;
            break;
          }
        }
      }

      if (!resolvedNode && electron.fetchConnectionsInfo) {
        try {
          const snapshot = await electron.fetchConnectionsInfo();
          if (snapshot) {
            hydrateConnections(snapshot);
            if (snapshot.currentNode) {
              const finalNode = await resolveEffectiveNode(snapshot.currentNode);
              if (requestId !== currentNodeRequestRef.current) return;
              if (finalNode && finalNode.length > 0) {
                resolvedNode = finalNode;
                resolvedFromGroup = null;
              }
            }
          }
        } catch {}
      }

      const allowBuiltin =
        effectiveMode === 'global' ||
        (!!resolvedFromGroup && resolvedFromGroup !== 'GLOBAL');
      if (
        resolvedNode &&
        isDisplayableCurrentNode(resolvedNode, effectiveMode, { allowBuiltin }) &&
        !candidateGroups.includes(resolvedNode)
      ) {
        if (requestId !== currentNodeRequestRef.current) return;
        commitCurrentNode(resolvedNode);
      } else {
        // 不提交分组/内置名称，稍后重试一次解析
        const retryRequestId = requestId;
        setTimeout(() => {
          // 仅当仍在运行时重试
          if (electron && isRunning && currentNodeRequestRef.current === retryRequestId) {
            syncCurrentNode(effectiveMode);
          }
        }, 800);
      }
    } catch (error) {
      console.error('Failed to sync current node:', error);
    }
  }, [commitCurrentNode, electron, getProxiesSnapshot, hydrateConnections, isDisplayableCurrentNode, isRunning, primaryProxyGroup, proxyMode, resolveEffectiveNode]);

  const fetchProxyMode = useCallback(async (): Promise<ProxyMode | null> => {
    try {
      const payload: any = await mihomoClient.getRuntimeConfig();
      const modeValue = typeof payload?.mode === 'string' ? payload.mode.toLowerCase() : null;
      if (modeValue === 'rule' || modeValue === 'global' || modeValue === 'direct') {
        return modeValue as ProxyMode;
      }
    } catch {}
    return null;
  }, []);

  const syncProxyMode = useCallback(async () => {
    const mode = await fetchProxyMode();
    if (mode) {
      setProxyMode(mode);
    }
  }, [fetchProxyMode]);

  const showBanner = (payload: BannerState | null) => {
    setBanner(payload);
    // 3秒后自动关闭
    if (payload) {
      setTimeout(() => {
        setBanner(null);
      }, 3000);
    }
  };

  const refreshProxyStatus = useCallback(async () => {
    if (!hasDesktopRuntime()) return;
    try {
      const latest = await electron?.getProxyStatus?.();
      if (typeof latest === 'boolean') {
        setProxyEnabled(latest);
        writeCachedBoolean(APP_DATA_CACHE_KEYS.systemProxyEnabled, latest);
      }
    } catch {}
  }, [electron]);

  const refreshTunStatus = useCallback(async () => {
    if (!hasDesktopRuntime()) return;
    try {
      const latest = await electron?.getTunStatus?.();
      if (typeof latest === 'boolean') {
        setTunEnabled(latest);
        writeCachedBoolean(APP_DATA_CACHE_KEYS.tunEnabled, latest);
      }
    } catch {}
  }, [electron]);

  useEffect(() => {
    if (!electron?.onTunStatus) return;
    const unsubscribe = electron.onTunStatus((enabled: boolean) => {
      const nextEnabled = Boolean(enabled);
      setTunEnabled(nextEnabled);
      writeCachedBoolean(APP_DATA_CACHE_KEYS.tunEnabled, nextEnabled);
    });
    return () => {
      if (typeof unsubscribe === 'function') {
        unsubscribe();
      }
    };
  }, [electron]);

  useEffect(() => {
    if (!electron?.onProxyStatus) return;
    const unsubscribe = electron.onProxyStatus((enabled: boolean) => {
      const nextEnabled = Boolean(enabled);
      setProxyEnabled(nextEnabled);
      writeCachedBoolean(APP_DATA_CACHE_KEYS.systemProxyEnabled, nextEnabled);
    });
    return () => {
      if (typeof unsubscribe === 'function') {
        unsubscribe();
      }
    };
  }, [electron]);

  useEffect(() => {
    if (!electron?.onMihomoStopped) return;
    const unsubscribe = electron.onMihomoStopped(() => {
      setIsRunning(false);
      setRunningStatusHydrated(true);
      clearRuntimeSnapshot();
      refreshProxyStatus();
      refreshTunStatus();
      notifyDashboardProfileUpdated({ action: 'service-stopped' });
    });
    return () => {
      if (typeof unsubscribe === 'function') {
        unsubscribe();
      }
    };
  }, [electron, clearRuntimeSnapshot, refreshProxyStatus, refreshTunStatus]);

  useEffect(() => {
    const applyCachedRuntimeSnapshot = () => {
      const snapshot = readCachedDashboardRuntimeSnapshot();
      runtimeSnapshotRef.current = snapshot;
      setCurrentNode(snapshot.currentNode);
      setConnectionCount(snapshot.connectionCount);
      setTotalUpload(snapshot.totalUpload);
      setTotalDownload(snapshot.totalDownload);
      setUpSpeed(snapshot.upSpeed);
      setDownSpeed(snapshot.downSpeed);
      setTrafficSamples(snapshot.trafficSamples);
      setConnections(snapshot.connections);
      setUploadTotal(snapshot.uploadTotal);
      setDownloadTotal(snapshot.downloadTotal);
    };

    return subscribeDashboardRuntimeCache(applyCachedRuntimeSnapshot);
  }, []);

  useEffect(() => {
    const applyCachedConnections = () => {
      const cached = readConnectionsCache<unknown>();
      if (!Array.isArray(cached)) return;
      const nextConnections = cached.slice(0, MAX_DASHBOARD_CONNECTIONS);
      setConnections(nextConnections);
      setConnectionCount((prev) => (prev > 0 ? prev : nextConnections.length));
      writeRuntimeSnapshot({
        connections: nextConnections,
        connectionCount: runtimeSnapshotRef.current.connectionCount > 0
          ? runtimeSnapshotRef.current.connectionCount
          : nextConnections.length,
      });
    };

    applyCachedConnections();
    return subscribeConnectionsCache(applyCachedConnections);
  }, [writeRuntimeSnapshot]);

  useEffect(() => {
    if (!electron?.onServiceRestarted) return;
    const unsubscribe = electron.onServiceRestarted((result: { success?: boolean }) => {
      if (result?.success) {
        setIsRunning(true);
        setRunningStatusHydrated(true);
        syncCurrentNode();
        syncProxyMode();
      } else {
        electron.isMihomoRunning?.().then((running) => {
          setIsRunning(Boolean(running));
          setRunningStatusHydrated(true);
        }).catch(() => {});
      }
      refreshProxyStatus();
      refreshTunStatus();
      notifyDashboardProfileUpdated({
        action: result?.success ? 'service-restarted' : 'service-restart-status-changed',
      });
    });
    return () => {
      if (typeof unsubscribe === 'function') {
        unsubscribe();
      }
    };
  }, [electron, refreshProxyStatus, refreshTunStatus, syncCurrentNode, syncProxyMode]);

  useEffect(() => {
    const applyCachedRunningState = (allowStopped: boolean) => {
      const cached = readMihomoRunningCache();
      if (cached === true) {
        setIsRunning(true);
        setRunningStatusHydrated(true);
      } else if (cached === false) {
        if (!allowStopped) return;
        setIsRunning(false);
        setRunningStatusHydrated(true);
      }
    };

    applyCachedRunningState(false);
    return subscribeMihomoRunningCache(() => applyCachedRunningState(true));
  }, []);

  useEffect(() => {
    const applyCachedProxyState = () => {
      setProxyEnabled(readCachedBoolean(APP_DATA_CACHE_KEYS.systemProxyEnabled));
    };

    applyCachedProxyState();
    return subscribeSystemProxyEnabledCache(applyCachedProxyState);
  }, []);

  useEffect(() => {
    const applyCachedTunState = () => {
      setTunEnabled(readCachedBoolean(APP_DATA_CACHE_KEYS.tunEnabled));
    };

    applyCachedTunState();
    return subscribeTunEnabledCache(applyCachedTunState);
  }, []);

  // 保存运行状态到共享缓存，避免页面刷新/切换时丢失状态
  useEffect(() => {
    if (!runningStatusHydrated) return;
    writeMihomoRunningCache(isRunning);
  }, [isRunning, runningStatusHydrated]);

  useEffect(() => {
    if (proxyMode) {
      writeProxyModeCache(proxyMode);
    }
  }, [proxyMode]);

  useEffect(() => {
    writeCachedBoolean(APP_DATA_CACHE_KEYS.systemProxyEnabled, proxyEnabled);
  }, [proxyEnabled]);

  useEffect(() => {
    writeCachedBoolean(APP_DATA_CACHE_KEYS.tunEnabled, tunEnabled);
  }, [tunEnabled]);

  useEffect(() => {
    if (activeConfig) {
      writeActiveConfigCache(activeConfig);
    }
  }, [activeConfig]);

  useEffect(() => {
    if (!electron) return;
    let cancelled = false;
    let retryTimeoutId: NodeJS.Timeout | null = null;

    const bootstrap = async (retryCount = 0) => {
      if (hasDesktopRuntime()) {
        try {
          const status = await electron.getProxyStatus?.();
          if (!cancelled && typeof status === 'boolean') {
            setProxyEnabled(status);
            writeCachedBoolean(APP_DATA_CACHE_KEYS.systemProxyEnabled, status);
          }
        } catch {}

        try {
          const tunStatus = await electron.getTunStatus?.();
          if (!cancelled && typeof tunStatus === 'boolean') {
            setTunEnabled(tunStatus);
            writeCachedBoolean(APP_DATA_CACHE_KEYS.tunEnabled, tunStatus);
          }
        } catch {}
      }

      try {
        const config = await electron.getActiveConfig?.();
        const configPath = normalizeConfigPath(config);
        if (!cancelled && configPath) {
          setActiveConfig(configPath);
          setPreferredConfig(configPath);
          const iconPath = await loadConfigIcon(configPath);
          setActiveConfigIcon(iconPath);
        }

        try {
          let running: boolean | null = null;
          const runtimeState = await electron.coreGetRuntimeState?.();
          if (runtimeState && runtimeState.success !== false) {
            if (typeof runtimeState.coreRunning === 'boolean') {
              running = runtimeState.coreRunning;
            } else if (typeof runtimeState.runningMode === 'string') {
              running = runtimeState.runningMode !== 'notRunning';
            }
          }

          if (running === null) {
            const legacyRunning = await electron.isMihomoRunning?.();
            if (typeof legacyRunning === 'boolean') {
              running = legacyRunning;
            }
          }

          if (!cancelled && running !== null) {
            setIsRunning(running);
            setRunningStatusHydrated(true);
            writeMihomoRunningCache(running);
            if (running) {
              await syncCurrentNode();
              await syncProxyMode();
            }
          }
        } catch (error) {
          console.debug('[Dashboard bootstrap] running state sync skipped:', error);
        }
      } catch {}

      try {
        const subs = toSubscriptionArray(await electron.getSubscriptions?.());
        if (!cancelled && subs.length > 0) {
          const first = subs[0];
          const path = typeof first === 'string' ? first : first?.path;
          if (path) {
            setPreferredConfig(path);
          }
        }
      } catch {}

      try {
        const order = await electron.getConfigOrder?.();
        if (!cancelled && order?.success && Array.isArray(order.data?.proxyGroups) && order.data.proxyGroups.length > 0) {
          const groupName = pickPrimaryProxyGroupName(order.data.proxyGroups);
          if (typeof groupName === 'string' && groupName.length > 0) {
            setPrimaryProxyGroup(groupName);
            // 立刻尝试解析一次，避免初渲染显示组名
            updateCurrentNodeDisplay(undefined, groupName, { forceRefresh: true, mode: proxyMode, source: 'bootstrap' });
          }
        }
      } catch {}

      try {
        const snapshot = await electron.fetchConnectionsInfo?.();
        if (!cancelled) {
          hydrateConnections(snapshot);
        }
      } catch {}

      if (retryCount === 0) {
        try {
          const mode = await fetchProxyMode();
          if (!cancelled && mode) {
            setProxyMode(mode);
          }
        } catch {}
      }
    };

    bootstrap();

    const unsubAutostart = electron.onMihomoAutostart?.((data: any) => {
      console.log('[Dashboard] Received mihomo-autostart event:', data);
      if (data?.success) {
        console.log('[Dashboard] Setting isRunning = true from autostart event');
        setIsRunning(true);
        const configPath = normalizeConfigPath(data.configPath);
        if (configPath) {
          setActiveConfig(configPath);
        }
        syncCurrentNode();
        syncProxyMode();
      }
    });

    return () => {
      cancelled = true;
      if (retryTimeoutId) {
        clearTimeout(retryTimeoutId);
      }
      if (unsubAutostart) {
        unsubAutostart();
      }
    };
  }, [electron, fetchProxyMode, hydrateConnections, normalizeConfigPath, proxyMode, syncCurrentNode, syncProxyMode, updateCurrentNodeDisplay]);

  // 周期性同步当前激活配置，避免在配置页面切换后 Dashboard 仍显示旧配置
  useEffect(() => {
    if (!electron?.getActiveConfig) return;
    let disposed = false;

    const syncActiveConfig = async () => {
      try {
        const config = await electron.getActiveConfig?.();
        if (disposed) return;

        const configPath = normalizeConfigPath(config);
        if (configPath) {
          setActiveConfig(configPath);
          setPreferredConfig(configPath);
          const iconPath = await loadConfigIcon(configPath);
          setActiveConfigIcon(iconPath);
        } else {
          setActiveConfig(null);
          setActiveConfigIcon(null);
        }
      } catch {
        // 忽略同步失败，避免影响其它功能
      }
    };

    // 立即同步一次
    syncActiveConfig();
    window.addEventListener('profile-updated', syncActiveConfig);
    window.addEventListener('backup-restored', syncActiveConfig);
    window.addEventListener('subscription-auto-updated', syncActiveConfig);
    const unsubscribeActiveConfig = electron.onActiveConfigChanged?.(() => {
      syncActiveConfig();
    });
    const unsubscribeAutoUpdated = electron.onSubscriptionAutoUpdated?.(() => {
      syncActiveConfig();
    });
    const timer = window.setInterval(syncActiveConfig, 5000);

    return () => {
      disposed = true;
      window.removeEventListener('profile-updated', syncActiveConfig);
      window.removeEventListener('backup-restored', syncActiveConfig);
      window.removeEventListener('subscription-auto-updated', syncActiveConfig);
      unsubscribeActiveConfig?.();
      unsubscribeAutoUpdated?.();
      window.clearInterval(timer);
    };
  }, [electron, normalizeConfigPath]);

  useEffect(() => {
    if (!electron?.getTrafficStats) return;
    let disposed = false;

    const run = async () => {
      try {
        const stats = await electron.getTrafficStats();
        if (!disposed && stats) {
          const payload = stats as TrafficStats;
          if (Number.isFinite(payload.upSpeed)) {
            setUpSpeed(payload.upSpeed);
          }
          if (Number.isFinite(payload.downSpeed)) {
            setDownSpeed(payload.downSpeed);
          }
          const sampleTimestamp = typeof payload.timestamp === 'number' ? payload.timestamp : Date.now();
          const previousSamples = runtimeSnapshotRef.current.trafficSamples;
          const last = previousSamples[previousSamples.length - 1];
          const sample: TrafficSample = {
            timestamp: sampleTimestamp,
            upSpeed: Number.isFinite(payload.upSpeed) ? payload.upSpeed : last?.upSpeed ?? 0,
            downSpeed: Number.isFinite(payload.downSpeed) ? payload.downSpeed : last?.downSpeed ?? 0
          };
          const nextSamples = [...previousSamples, sample];
          const boundedSamples = nextSamples.length > 120
            ? nextSamples.slice(nextSamples.length - 120)
            : nextSamples;
          setTrafficSamples(boundedSamples);
          writeRuntimeSnapshot({
            upSpeed: sample.upSpeed,
            downSpeed: sample.downSpeed,
            trafficSamples: boundedSamples,
          });

        }
      } catch {}
    };

    run();
    const timer = window.setInterval(run, 1500);

    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [electron, hydrateConnections, writeRuntimeSnapshot]);

  useEffect(() => {
    if (!electron?.fetchConnectionsInfo) return;
    let disposed = false;

    const poll = async () => {
      try {
        const snapshot = await electron.fetchConnectionsInfo();
        if (!disposed) {
          hydrateConnections(snapshot);
          if (!snapshot?.currentNode) {
            syncCurrentNode();
          }
        }
      } catch {}
    };

    poll();
    const timer = window.setInterval(poll, 5000);

    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [electron, hydrateConnections, syncCurrentNode]);

  useEffect(() => {
    if (!electron?.onConnectionsUpdate) return;

    const handler = (payload: ConnectionsSnapshot) => {
      hydrateConnections(payload);
    };

    const unsubscribe = electron.onConnectionsUpdate(handler);

    return () => {
      if (typeof unsubscribe === 'function') {
        unsubscribe();
      }
    };
  }, [electron, hydrateConnections, writeRuntimeSnapshot]);

  useEffect(() => {
    if (!electron?.onNodeChanged) return;

    const handler = (payload: { nodeName?: string; groupName?: string }) => {
      const incomingGroup =
        typeof payload?.groupName === 'string' && payload.groupName.trim()
          ? payload.groupName
          : primaryProxyGroup;
      // 全局模式只认 GLOBAL 上的选择
      if (proxyMode === 'global' && incomingGroup !== 'GLOBAL') {
        return;
      }
      const groupName = proxyMode === 'global' ? 'GLOBAL' : incomingGroup;
      rememberNodeSelection(payload?.nodeName, groupName);
      if (payload?.nodeName) {
        updateCurrentNodeDisplay(undefined, groupName, {
          forceRefresh: true,
          mode: proxyMode,
          source: 'selection',
        });
      } else {
        updateCurrentNodeDisplay(undefined, groupName, {
          forceRefresh: true,
          mode: proxyMode,
          source: 'selection',
        });
      }
    };

    const unsubscribe = electron.onNodeChanged(handler);

    return () => {
      if (typeof unsubscribe === 'function') {
        unsubscribe();
      }
    };
  }, [electron, primaryProxyGroup, proxyMode, rememberNodeSelection, updateCurrentNodeDisplay]);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const handleProfileUpdated = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail?.source !== 'proxy-nodes' || detail?.action !== 'node-changed') {
        return;
      }

      const groupName = typeof detail.groupName === 'string' && detail.groupName.trim()
        ? detail.groupName
        : primaryProxyGroup;
      rememberNodeSelection(
        typeof detail.nodeName === 'string' ? detail.nodeName : undefined,
        groupName,
      );
      updateCurrentNodeDisplay(undefined, groupName, {
        forceRefresh: true,
        mode: proxyMode,
        source: 'selection',
      });
    };

    window.addEventListener('profile-updated', handleProfileUpdated);
    return () => window.removeEventListener('profile-updated', handleProfileUpdated);
  }, [primaryProxyGroup, proxyMode, rememberNodeSelection, updateCurrentNodeDisplay]);

  useEffect(() => {
    if (!electron || !isRunning) return;
    syncCurrentNode();
    syncProxyMode();
  }, [electron, isRunning, activeConfig, primaryProxyGroup, syncCurrentNode, syncProxyMode]);

  // 获取连接列表
  useEffect(() => {
    if (!isRunning) return;
    let disposed = false;

    const fetchConnections = async () => {
      try {
        const data = await mihomoClient.getConnections();
        if (!disposed && data) {
          if (data.connections && Array.isArray(data.connections)) {
            // 截断只作用于要渲染的列表；连接数用未截断的真实长度，
            // 否则连接 > 80 时活跃连接指标会被截断/来回跳变
            const totalConnections = data.connections.length;
            const nextConnections = data.connections.slice(0, MAX_DASHBOARD_CONNECTIONS);
            setConnections(nextConnections);
            setConnectionCount(totalConnections);
            writeRuntimeSnapshot({
              connections: nextConnections,
              connectionCount: totalConnections,
            });
          }
          const patch: Partial<DashboardRuntimeSnapshot> = {};
          if (typeof data.uploadTotal === 'number') {
            setUploadTotal(data.uploadTotal);
            setTotalUpload(data.uploadTotal);
            patch.uploadTotal = data.uploadTotal;
            patch.totalUpload = data.uploadTotal;
          }
          if (typeof data.downloadTotal === 'number') {
            setDownloadTotal(data.downloadTotal);
            setTotalDownload(data.downloadTotal);
            patch.downloadTotal = data.downloadTotal;
            patch.totalDownload = data.downloadTotal;
          }
          if (Object.keys(patch).length > 0) {
            writeRuntimeSnapshot(patch);
          }
        }
      } catch (error) {
        console.error('获取连接列表失败:', error);
      }
    };

    fetchConnections();
    const timer = window.setInterval(fetchConnections, DASHBOARD_CONNECTION_POLL_MS);

    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [electron, isRunning, writeRuntimeSnapshot]);

  const resolveConfigForLaunch = async () => {
    if (!electron) return null;
    try {
      const active = await electron.getActiveConfig?.();
      if (typeof active === 'string' && active.length > 0) {
        return active;
      }
    } catch {}
    if (preferredConfig) {
      return preferredConfig;
    }
    try {
      const subs = toSubscriptionArray(await electron?.getSubscriptions?.());
      if (subs.length > 0) {
        const entry = subs[0];
        const path = typeof entry === 'string' ? entry : entry?.path;
        if (path) {
          setPreferredConfig(path);
          return path;
        }
      }
    } catch {}
    return null;
  };

  const handleStart = async () => {
    if (!electron?.startMihomo) {
      showBanner({ type: 'error', message: t('dashboard.apiUnavailable') });
      return;
    }
    if (isServiceBusy) return;
    setIsServiceBusy(true);
    showBanner(null);
    try {
      const config = await resolveConfigForLaunch();
      if (!config) {
        showBanner({ type: 'error', message: t('dashboard.noConfigAvailable') });
        return;
      }
      const result = await electron.startMihomo(config);
      const success =
        typeof result === 'boolean'
          ? result
          : result && typeof result === 'object' && 'success' in result
          ? Boolean((result as any).success)
          : false;

      if (success) {
        setIsRunning(true);
        setActiveConfig(config);
        setPreferredConfig(config);
        // 加载配置图标
        const iconPath = await loadConfigIcon(config);
        setActiveConfigIcon(iconPath);
        showBanner({ type: 'success', message: t('dashboard.serviceStarted') });
        try {
          const order = await electron.getConfigOrder?.();
          if (order?.success && Array.isArray(order.data?.proxyGroups) && order.data.proxyGroups.length > 0) {
            const groupName = pickPrimaryProxyGroupName(order.data.proxyGroups);
            if (typeof groupName === 'string' && groupName.length > 0) {
              setPrimaryProxyGroup(groupName);
              // 主代理组确定后尝试立即解析一次
              updateCurrentNodeDisplay(undefined, groupName, { forceRefresh: true, mode: proxyMode, source: 'bootstrap' });
            }
          }
        } catch {}
        const snapshot = await electron.fetchConnectionsInfo?.();
        hydrateConnections(snapshot);
        await syncCurrentNode();
        await syncProxyMode();
        notifyDashboardProfileUpdated({ action: 'service-started', filePath: config });
      } else {
        const errDetail = typeof result === 'object'
          ? resultError(result, t('dashboard.startFailed'))
          : t('dashboard.startFailed');
        setStartErrorMsg(errDetail);
        showBanner({ type: 'error', message: t('dashboard.startFailedWithError', { message: errDetail }) });
      }
    } catch (error) {
      const message = formatDashboardError(error, t('dashboard.startFailed'));
      setStartErrorMsg(message);
      showBanner({ type: 'error', message: t('dashboard.startFailedWithError', { message }) });
    } finally {
      setIsServiceBusy(false);
    }
  };

  const handleStop = async () => {
    if (!electron?.stopMihomo) {
      showBanner({ type: 'error', message: t('dashboard.apiUnavailable') });
      return;
    }
    if (isServiceBusy) return;
    setIsServiceBusy(true);
    showBanner(null);
    try {
      const result = await electron.stopMihomo();
      const success =
        typeof result === 'boolean'
          ? result
          : result && typeof result === 'object' && 'success' in result
          ? Boolean((result as any).success)
          : false;

      if (success) {
        setIsRunning(false);
        clearRuntimeSnapshot();
        // 停止服务时自动关闭TUN模式
        if (tunEnabled) {
          setTunEnabled(false);
          writeCachedBoolean(APP_DATA_CACHE_KEYS.tunEnabled, false);
        }
        showBanner({ type: 'info', message: t('dashboard.serviceStopped') });
        notifyDashboardProfileUpdated({ action: 'service-stopped' });
      } else {
        const message = typeof result === 'object'
          ? resultError(result, t('dashboard.serviceAlreadyStopped'))
          : t('dashboard.serviceAlreadyStopped');
        showBanner({ type: 'error', message });
      }
    } catch (error) {
      const message = formatDashboardError(error, t('dashboard.serviceAlreadyStopped'));
      showBanner({ type: 'error', message: t('dashboard.stopFailed', { message }) });
    } finally {
      setIsServiceBusy(false);
    }
  };

  const handleRestart = async () => {
    if (isServiceBusy) return;
    await handleStop();
    await handleStart();
  };

  const handleProxyToggle = async (value: boolean) => {
    if (!electron?.toggleSystemProxy) {
      showBanner({ type: 'error', message: t('dashboard.apiUnavailable') });
      return;
    }
    if (isProxyUpdating) return;
    setIsProxyUpdating(true);
    showBanner(null);
    try {
      const result = await electron.toggleSystemProxy(value);
      const success =
        typeof result === 'boolean'
          ? result
          : result && typeof result === 'object' && 'success' in result
          ? Boolean(result.success)
          : false;

      if (!success) {
        const message =
          typeof result === 'object' && 'error' in result && result.error
            ? formatDashboardError(result.error, t('dashboard.toggleSystemProxyFailed'))
            : t('dashboard.toggleSystemProxyFailed');
        showBanner({ type: 'error', message });
        await refreshProxyStatus();
        return;
      }

      const actualEnabled =
        result && typeof result === 'object' && 'enabled' in result && typeof result.enabled === 'boolean'
          ? result.enabled
          : value;
      setProxyEnabled(actualEnabled);
      writeCachedBoolean(APP_DATA_CACHE_KEYS.systemProxyEnabled, actualEnabled);
      showBanner({ type: 'success', message: t('dashboard.systemProxyToggled', { status: actualEnabled ? t('dashboard.enabled') : t('dashboard.disabled') }) });
    } catch (error) {
      const message = formatDashboardError(error, t('dashboard.toggleSystemProxyFailed'));
      showBanner({ type: 'error', message: t('dashboard.toggleSystemProxyFailedWithError', { message }) });
      await refreshProxyStatus();
    } finally {
      setIsProxyUpdating(false);
    }
  };

  const runTunToggle = async (value: boolean) => {
    if (!electron?.toggleTunMode) {
      showBanner({ type: 'error', message: t('dashboard.tunModeNotSupported') });
      return;
    }
    if (isTunUpdating) return;
    setIsTunUpdating(true);
    showBanner(null);
    try {
      const result = await electron.toggleTunMode(value);
      const success =
        typeof result === 'boolean'
          ? result
          : result && typeof result === 'object' && 'success' in result
          ? Boolean(result.success)
          : false;

      if (!success) {
        const message =
          typeof result === 'object' && 'error' in result && result.error
            ? formatDashboardError(result.error, t('dashboard.toggleTunModeFailed'))
            : t('dashboard.toggleTunModeFailed');
        showBanner({ type: 'error', message });
        await refreshTunStatus();
        return;
      }

      const actualEnabled =
        result && typeof result === 'object' && 'enabled' in result && typeof result.enabled === 'boolean'
          ? result.enabled
          : value;
      setTunEnabled(actualEnabled);
      writeCachedBoolean(APP_DATA_CACHE_KEYS.tunEnabled, actualEnabled);
      showBanner({ type: 'success', message: t('dashboard.tunModeToggled', { status: actualEnabled ? t('dashboard.enabled') : t('dashboard.disabled') }) });
    } catch (error) {
      const message = formatDashboardError(error, t('dashboard.toggleTunModeFailed'));
      showBanner({ type: 'error', message: t('dashboard.toggleTunModeFailedWithError', { message }) });
      await refreshTunStatus();
    } finally {
      setIsTunUpdating(false);
    }
  };

  const handleTunToggle = async (value: boolean) => {
    if (!electron?.toggleTunMode) {
      showBanner({ type: 'error', message: t('dashboard.tunModeNotSupported') });
      return;
    }
    if (isTunUpdating) return;

    // 关闭 TUN 模式，直接执行
    if (!value) {
      await runTunToggle(false);
      return;
    }

    // 开启 TUN 模式
    // Windows: 检查服务状态或计划任务，根据模式决定是否需要显示确认对话框
    if (isWindowsPlatform && electron?.getTunElevationMode) {
      console.log('[Dashboard] Windows platform detected, checking elevation mode');
      try {
        const modeResult = await electron.getTunElevationMode();
        const elevationMode = modeResult?.mode || 'service';
        console.log('[Dashboard] Windows elevation mode:', elevationMode);

        if (elevationMode === 'service') {
          // 服务模式：检查服务状态
          let serviceStatus = await electron.getTunServiceStatus?.();
          console.log('[Dashboard] Service status:', serviceStatus);

          if (!isWindowsTunServiceReady(serviceStatus)) {
            console.log('[Dashboard] Service is not ready, preparing TUN helper service');
            showBanner({ type: 'info', message: t('dashboard.requestingTunAuthorization') });

            const prepareResult = electron.grantTunPermissions
              ? await electron.grantTunPermissions()
              : await electron.startTunService?.();

            if (!prepareResult?.success) {
              const fallbackMessage = serviceStatus?.installed
                ? t('dashboard.tunServiceNotRunning')
                : t('dashboard.tunServiceNotInstalled');
              const message = formatDashboardError(
                prepareResult?.error || tunServiceStatusError(serviceStatus),
                fallbackMessage,
              );
              showBanner({ type: 'error', message });
              await refreshTunStatus();
              return;
            }

            serviceStatus = await electron.getTunServiceStatus?.();
            console.log('[Dashboard] Service status after preparation:', serviceStatus);

            if (!isWindowsTunServiceReady(serviceStatus)) {
              const fallbackMessage = serviceStatus?.installed
                ? t('dashboard.tunServiceNotRunning')
                : t('dashboard.tunServiceNotInstalled');
              const message = formatDashboardError(
                tunServiceStatusError(serviceStatus) || prepareResult?.message,
                fallbackMessage,
              );
              showBanner({ type: 'error', message });
              await refreshTunStatus();
              return;
            }
          }

          // 服务可用，直接启用 TUN 模式
          console.log('[Dashboard] Service is ready, enabling TUN mode');
          await runTunToggle(true);
          return;
        } else {
          // 计划任务模式：检查计划任务
          const taskResult = await electron.checkElevateTask?.();
          const hasTask = typeof taskResult === 'boolean' ? taskResult : false;
          console.log('[Dashboard] Windows checkElevateTask result:', hasTask);
          setHasAdminPermission(hasTask);
          setTunConfirmOpen(true);
          return;
        }
      } catch (error) {
        console.error('Failed to check TUN permission:', error);
        setHasAdminPermission(false);
        setTunConfirmOpen(true);
      }
      return;
    } else if (isWindowsPlatform && electron?.checkElevateTask) {
      // 兼容旧版本：只有 checkElevateTask
      console.log('[Dashboard] Windows platform detected (legacy), showing confirmation dialog');
      try {
        const taskResult = await electron.checkElevateTask();
        const hasTask = typeof taskResult === 'boolean' ? taskResult : false;
        console.log('[Dashboard] Windows checkElevateTask result:', hasTask);
        setHasAdminPermission(hasTask);
        setTunConfirmOpen(true);
      } catch (error) {
        console.error('Failed to check admin permission:', error);
        setHasAdminPermission(false);
        setTunConfirmOpen(true);
      }
      return;
    }

    // macOS/Linux: 检查权限后直接处理，不显示确认对话框
    if (electron?.checkCorePermission) {
      console.log('[Dashboard] macOS/Linux platform detected, checking permission');
      try {
        const result = await electron.checkCorePermission();
        console.log('[Dashboard] checkCorePermission result:', result);
        const hasPermission = !!result?.hasPermission;

        if (!hasPermission) {
          // 没有权限，直接弹出系统密码框授权（无自定义对话框）
          console.log('[Dashboard] No permission, requesting authorization via system dialog...');
          showBanner({ type: 'info', message: t('dashboard.requestingTunAuthorization') });

          try {
            const authResult = await electron.grantTunPermissions();
            if (authResult.success) {
              showBanner({ type: 'success', message: t('dashboard.tunPermissionGranted') });
              // 授权成功，自动开启 TUN 模式
              await runTunToggle(true);
            } else {
              showBanner({ type: 'error', message: formatDashboardError(authResult.error, t('dashboard.tunAuthorizationFailed')) });
            }
          } catch (error) {
            console.error('Failed to grant TUN permissions:', error);
            showBanner({ type: 'error', message: formatDashboardError(error, t('dashboard.tunAuthorizationFailed')) });
          }
        } else {
          // 已有权限，直接启用 TUN，不显示任何对话框
          console.log('[Dashboard] ✓ Has permission, directly enabling TUN mode (no dialog)');
          await runTunToggle(true);
        }
      } catch (error) {
        console.error('Failed to check core permission:', error);
        showBanner({ type: 'error', message: formatDashboardError(error, t('dashboard.tunPermissionCheckFailed')) });
      }
      return;
    }

    // 其他平台，直接启用
    console.log('[Dashboard] Other platform, directly enabling TUN mode');
    await runTunToggle(true);
  };

  const handleModeSwitch = useCallback(
    async (nextMode: ProxyMode) => {
      if (isModeUpdating || proxyMode === nextMode) {
        return;
      }
      const previousMode = proxyMode;
      setIsModeUpdating(true);
      setProxyMode(nextMode);
      writeProxyModeCache(nextMode);
      if (nextMode === 'direct') {
        commitCurrentNode('DIRECT');
      }
      showBanner(null);
      try {
        // 切入全局时先同步 GLOBAL 出口，避免 GLOBAL.now 与规则模式当前节点不一致
        if (nextMode === 'global') {
          try {
            const proxiesPayload: any = await mihomoClient.getProxies();
            const proxies = proxiesPayload?.proxies || proxiesPayload || {};
            const preferred = [primaryProxyGroup, 'PROXY', 'Auto', 'AUTO'].filter(Boolean);
            let candidate: string | null = null;
            const globalProxy = proxies['GLOBAL'];
            const globalMembers = new Set(
              Array.isArray(globalProxy?.all)
                ? globalProxy.all
                    .map((item: unknown) =>
                      typeof item === 'string' ? item : (item as any)?.name,
                    )
                    .filter((name: unknown): name is string => typeof name === 'string' && name.length > 0)
                : [],
            );
            for (const groupName of preferred) {
              const now = typeof proxies[groupName]?.now === 'string' ? proxies[groupName].now.trim() : '';
              if (!now || now.toUpperCase() === 'DIRECT' || now.toUpperCase() === 'REJECT') continue;
              if (globalMembers.size > 0 && !globalMembers.has(now)) continue;
              candidate = now;
              break;
            }
            if (candidate && globalProxy?.now !== candidate) {
              await mihomoClient.selectNodeForGroup('GLOBAL', candidate);
              commitCurrentNode(candidate);
            }
          } catch (error) {
            console.warn('同步 GLOBAL 出口失败:', error);
          }
        }

        await mihomoClient.patchRuntimeConfig({ mode: nextMode });

        // 持久化代理模式，重启后由 runtime 合并恢复
        try {
          if (electron?.saveProxySettings) {
            await electron.saveProxySettings({ mode: nextMode });
          }
        } catch (error) {
          console.warn('持久化代理模式失败:', error);
        }

        // 断开旧连接，避免继续按原模式路由
        try {
          await mihomoClient.closeAllConnections();
        } catch (error) {
          console.warn('切换模式后清除连接失败:', error);
        }

        showBanner({ type: 'success', message: t('dashboard.switchedToMode', { mode: MODE_LABELS[nextMode] }) });
        window.setTimeout(() => {
          void syncCurrentNode(nextMode);
        }, 120);
      } catch (error) {
        setProxyMode(previousMode);
        if (previousMode) {
          writeProxyModeCache(previousMode);
        }
        const message = formatDashboardError(error, t('dashboard.switchProxyModeFailedTitle'));
        showBanner({ type: 'error', message: t('dashboard.switchProxyModeFailed', { message }) });
        await syncProxyMode();
      } finally {
        setIsModeUpdating(false);
      }
    },
    [commitCurrentNode, formatDashboardError, isModeUpdating, primaryProxyGroup, proxyMode, showBanner, syncCurrentNode, syncProxyMode, t]
  );

  const handleResetDashboardLayout = useCallback(async () => {
    if (!confirm(t('dashboard.confirmReset'))) {
      return;
    }

    try {
      if (electron?.setSetting) {
        const result = await electron.setSetting(DASHBOARD_CONFIG_KEY, DEFAULT_DASHBOARD_CARDS);
        if (result?.success === false) {
          throw new Error(resultError(result, t('dashboard.layoutResetFailed')));
        }
      } else if (typeof window !== 'undefined') {
        localStorage.setItem(DASHBOARD_CONFIG_KEY, JSON.stringify(DEFAULT_DASHBOARD_CARDS));
      }

      window.location.reload();
    } catch (error) {
      const message = formatDashboardError(error, t('dashboard.layoutResetFailed'));
      showBanner({ type: 'error', message });
    }
  }, [electron, formatDashboardError, resultError, showBanner, t]);

  const metrics = [
    {
      label: t('dashboard.activeConnections'),
      value: connectionCount.toString(),
      helper: isRunning
        ? t('dashboard.realtimeConnections')
        : runningStatusHydrated
          ? t('dashboard.serviceNotRunning')
          : t('common.loading'),
      icon: <Activity className="h-4 w-4 text-primary" />
    },
    {
      label: t('dashboard.downloadSpeed'),
      value: formatSpeed(downSpeed),
      helper: `${t('dashboard.total')} ${formatBytes(totalDownload, 2)}`,
      icon: <Download className="h-4 w-4 text-blue-500" />
    },
    {
      label: t('dashboard.uploadSpeed'),
      value: formatSpeed(upSpeed),
      helper: `${t('dashboard.total')} ${formatBytes(totalUpload, 2)}`,
      icon: <Upload className="h-4 w-4 text-emerald-500" />
    },
    {
      label: t('dashboard.totalTraffic'),
      value: formatBytes(totalUpload + totalDownload, 2),
      helper: currentNode || t('dashboard.notSelected'),
      icon: <BarChart3 className="h-4 w-4 text-violet-500" />
    }
  ];

  const runningStatusLabel = runningStatusHydrated
    ? isRunning
      ? t('dashboard.running')
      : t('dashboard.notRunning')
    : t('common.loading');

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">{t('dashboard.title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('dashboard.subtitle')}</p>
        </div>
        <div className="flex flex-col items-start gap-2 md:items-end">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                'rounded-full px-2.5 py-1 text-xs font-medium',
                !runningStatusHydrated
                  ? 'bg-slate-100 text-slate-500'
                  : isRunning
                    ? 'bg-emerald-500 text-white'
                    : 'bg-slate-200 text-slate-700'
              )}
            >
              {runningStatusLabel}
            </span>
            <span className="rounded-full border border-slate-200 px-2.5 py-1 text-xs text-muted-foreground dark:border-slate-700">
              {getFileName(activeConfig || preferredConfig, t)}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {!isEditMode ? (
              <>
                <Button
                  size="sm"
                  variant={isRunning ? "outline" : "primary"}
                  onClick={isRunning ? handleStop : handleStart}
                  disabled={isServiceBusy || !runningStatusHydrated}
                >
                  {isRunning ? (
                    <>
                      <Square className="mr-1 h-3.5 w-3.5" /> {t('dashboard.stop')}
                    </>
                  ) : (
                    <>
                      <Play className="mr-1 h-3.5 w-3.5" /> {t('dashboard.start')}
                    </>
                  )}
                </Button>
                <Button size="sm" variant="ghost" onClick={handleRestart} disabled={isServiceBusy || !runningStatusHydrated || !isRunning}>
                  <RefreshCw className="mr-1 h-3.5 w-3.5" /> {t('dashboard.restart')}
                </Button>
                <Button size="sm" variant="outline" onClick={() => setIsEditMode(true)}>
                  <Settings2 className="mr-1 h-3.5 w-3.5" /> {t('dashboard.customizeLayout')}
                </Button>
              </>
            ) : (
              <>
                <Button size="sm" variant="outline" onClick={() => setShowAddCardDialog(true)}>
                  <Plus className="mr-1 h-3.5 w-3.5" /> {t('dashboard.addCard')}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleResetDashboardLayout}
                >
                  <RotateCcw className="mr-1 h-3.5 w-3.5" /> {t('dashboard.reset')}
                </Button>
                <Button size="sm" variant="primary" onClick={() => setIsEditMode(false)}>
                  <Check className="mr-1 h-3.5 w-3.5" /> {t('dashboard.done')}
                </Button>
              </>
            )}
          </div>
        </div>
      </div>

      {banner && (
        <div
          className={cn(
            'max-h-32 overflow-y-auto rounded-xl border px-4 py-3 text-sm leading-relaxed shadow-sm transition-all duration-300 animate-in slide-in-from-top-2 break-words [overflow-wrap:anywhere]',
            banner.type === 'success' && 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-900/20 dark:text-emerald-400',
            banner.type === 'error' && 'border-rose-200 bg-rose-50 text-rose-600 dark:border-rose-800 dark:bg-rose-900/20 dark:text-rose-400',
            banner.type === 'info' && 'border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-800/20 dark:text-slate-300',
            banner.type === 'warning' && 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-300'
          )}
        >
          {banner.message}
        </div>
      )}

      {/* 可自定义的卡片布局 */}
      <CustomizableDashboard
        metrics={metrics}
        proxyEnabled={proxyEnabled}
        isProxyUpdating={isProxyUpdating}
        onProxyToggle={handleProxyToggle}
        tunEnabled={tunEnabled}
        isTunUpdating={isTunUpdating}
        tunAvailable={!!electron?.toggleTunMode}
        isRunning={isRunning}
        onTunToggle={handleTunToggle}
        proxyMode={proxyMode}
        isModeUpdating={isModeUpdating}
        onModeSwitch={handleModeSwitch}
        trafficSamples={trafficSamples}
        connections={connections}
        uploadTotal={uploadTotal}
        downloadTotal={downloadTotal}
        isEditMode={isEditMode}
        onEditModeChange={setIsEditMode}
        onAddCard={() => setShowAddCardDialog(true)}
        onReset={() => {
          void handleResetDashboardLayout();
        }}
        showAddDialog={showAddCardDialog}
        onShowAddDialogChange={setShowAddCardDialog}
        TrafficChart={(props: any) => <TrafficChart {...props} t={t} />}
      />

      <Dialog open={tunConfirmOpen} onOpenChange={setTunConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('dashboard.enableTunMode')}</DialogTitle>
            <DialogDescription>{tunDialogDescription}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setTunConfirmOpen(false)}
            >
              {t('dashboard.reconsider')}
            </Button>
            {!hasAdminPermission ? (
              <button
                type="button"
                onClick={async () => {
                  setTunConfirmOpen(false);
                  try {
                    if (electron?.grantTunPermissions) {
                      const result = await electron.grantTunPermissions();
                      if (result?.success) {
                        if (result.needRestart) {
                          showBanner({ type: 'info', message: t('dashboard.restartingForAdminPermission') });
                        } else {
                          showBanner({ type: 'success', message: t('dashboard.tunPermissionGranted') });
                          // 刷新权限状态
                          if (electron.checkElevateTask) {
                            const taskResult = await electron.checkElevateTask();
                            setHasAdminPermission(typeof taskResult === 'boolean' ? taskResult : false);
                          } else if (electron.checkCorePermission) {
                            const check = await electron.checkCorePermission();
                            setHasAdminPermission(!!check?.hasPermission);
                          }
                          // 授权成功后自动启用 TUN 模式
                          await runTunToggle(true);
                        }
                      } else {
                        showBanner({ type: 'error', message: formatDashboardError(result?.error, t('dashboard.tunAuthorizationFailed')) });
                      }
                    } else {
                      showBanner({ type: 'error', message: t('dashboard.apiUnavailable') });
                    }
                  } catch (error) {
                    console.error('Failed to grant TUN permissions:', error);
                    showBanner({ type: 'error', message: formatDashboardError(error, t('dashboard.tunAuthorizationFailed')) });
                  }
                }}
                className="relative inline-flex items-center justify-center whitespace-nowrap rounded-xl text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-60 overflow-hidden text-white h-11 px-5 transition-all hover:brightness-110"
                style={{
                  backgroundColor: themeColor,
                  boxShadow: `0 20px 42px -22px ${themeColor}70`
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.boxShadow = `0 24px 52px -20px ${themeColor}90`;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.boxShadow = `0 20px 42px -22px ${themeColor}70`;
                }}
              >
                {t('dashboard.authorize')}
              </button>
            ) : (
              <button
                type="button"
                onClick={async () => {
                  setTunConfirmOpen(false);
                  await runTunToggle(true);
                }}
                className="relative inline-flex items-center justify-center whitespace-nowrap rounded-xl text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-60 overflow-hidden text-white h-11 px-5 transition-all hover:brightness-110"
                style={{
                  backgroundColor: themeColor,
                  boxShadow: `0 20px 42px -22px ${themeColor}70`
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.boxShadow = `0 24px 52px -20px ${themeColor}90`;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.boxShadow = `0 20px 42px -22px ${themeColor}70`;
                }}
              >
                {t('dashboard.confirmEnable')}
              </button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!startErrorMsg} onOpenChange={(open) => { if (!open) setStartErrorMsg(null); }}>
        <DialogContent className="max-h-[70vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>{t('dashboard.startFailed')}</DialogTitle>
          </DialogHeader>
          <pre className="whitespace-pre-wrap break-words text-sm text-red-600 dark:text-red-400 font-mono bg-red-50 dark:bg-red-900/20 rounded-lg p-4 overflow-y-auto flex-1 min-h-0">
            {startErrorMsg}
          </pre>
          <DialogFooter>
            <Button variant="outline" onClick={() => setStartErrorMsg(null)}>
              {t('common.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

type MetricCard = {
  label: string;
  value: string;
  helper: string;
  icon: React.ReactNode;
};

function MetricCardList({ metrics }: { metrics: MetricCard[] }) {
  return (
    <>
      {metrics.map((metric) => (
        <Card
          key={metric.label}
          data-hoverable="false"
          className="rounded-3xl bg-white p-5 shadow-sm transition-all hover:shadow-md dark:bg-[#2a2a2a]"
        >
          <div className="flex items-center justify-between">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {metric.label}
            </div>
            {metric.icon}
          </div>
          <div className="mt-3 text-2xl font-semibold text-foreground">{metric.value}</div>
          <div className="mt-1 text-xs text-muted-foreground">{metric.helper}</div>
        </Card>
      ))}
    </>
  );
}

function TrafficChart({ samples, t }: { samples: TrafficSample[]; t: any }) {
  const chart = useMemo(() => {
    if (!samples || samples.length < 2) {
      return null;
    }

    const maxPoints = 80;
    const step = Math.max(1, Math.floor(samples.length / maxPoints));
    const reduced: TrafficSample[] = samples.filter((_, index) => index % step === 0);
    const lastSample = samples[samples.length - 1];
    if (reduced[reduced.length - 1] !== lastSample) {
      reduced.push(lastSample);
    }

    if (reduced.length < 2) {
      return null;
    }

    const data = reduced.map((entry) => ({
      timestamp: entry.timestamp,
      up: Math.max(0, entry.upSpeed) / 1024,
      down: Math.max(0, entry.downSpeed) / 1024
    }));

    const upPeak = data.reduce((acc, item) => Math.max(acc, item.up), 0);
    const downPeak = data.reduce((acc, item) => Math.max(acc, item.down), 0);
    const peak = Math.max(upPeak, downPeak);
    const safeMax = peak > 0 ? peak : 1;

    const paddingTop = 8;
    const paddingBottom = 14;
    const chartHeight = 100 - paddingTop - paddingBottom;
    const baseLine = paddingTop + chartHeight;

    const getPoint = (index: number, key: 'up' | 'down') => {
      const x = (index / (data.length - 1)) * 100;
      const capped = Math.min(data[index][key], safeMax);
      const y = baseLine - (capped / safeMax) * chartHeight;
      return { x, y };
    };

    const buildSmoothPath = (key: 'up' | 'down') => {
      const points = data.map((_, index) => getPoint(index, key));
      if (points.length < 2) {
        return { line: '', fill: '' };
      }

      const smoothing = 0.18;
      let d = `M ${points[0].x},${points[0].y}`;

      for (let i = 0; i < points.length - 1; i += 1) {
        const current = points[i];
        const next = points[i + 1];
        const previous = points[i - 1] ?? current;
        const nextPoint = points[i + 2] ?? next;

        const controlPoint = (currentPoint: { x: number; y: number }, previousPoint: { x: number; y: number }, nextPointInner: { x: number; y: number }, reverse = false) => {
          const p = previousPoint;
          const n = nextPointInner;
          const dx = n.x - p.x;
          const dy = n.y - p.y;
          const angle = Math.atan2(dy, dx) + (reverse ? Math.PI : 0);
          const length = Math.hypot(dx, dy) * smoothing;
          return {
            x: currentPoint.x + Math.cos(angle) * length,
            y: currentPoint.y + Math.sin(angle) * length
          };
        };

        const controlPointStart = controlPoint(current, previous, next);
        const controlPointEnd = controlPoint(next, current, nextPoint, true);
        d += ` C ${controlPointStart.x},${controlPointStart.y} ${controlPointEnd.x},${controlPointEnd.y} ${next.x},${next.y}`;
      }

      const area = `${d} L 100,${baseLine} L 0,${baseLine} Z`;
      return { line: d, fill: area, points };
    };

    const upShape = buildSmoothPath('up');
    const downShape = buildSmoothPath('down');

    const labelCount = Math.min(6, data.length);
    const timeTicks = [] as Array<{ x: number }>;
    if (labelCount > 1) {
      for (let i = 0; i < labelCount; i += 1) {
        const index = Math.round(((data.length - 1) * i) / (labelCount - 1));
        const point = getPoint(index, 'down');
        timeTicks.push({ x: point.x });
      }
    }

    const yTickCount = 4;
    const yTicks = Array.from({ length: yTickCount + 1 }, (_, index) => {
      const y = baseLine - (chartHeight / yTickCount) * index;
      return { y };
    });

    return {
      baseLine,
      yTicks,
      timeTicks,
      upShape,
      downShape,
      peak
    };
  }, [samples]);

  if (!chart) {
    return (
      <div className="flex h-48 items-center justify-center rounded-lg border border-dashed border-slate-200 text-xs text-muted-foreground">
        {t('dashboard.waitingForTraffic')}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* 图例和峰值 */}
      <div className="flex items-center justify-between px-2">
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-slate-500 dark:text-slate-400">{t('dashboard.peak')}</span>
          <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
            {formatSpeed(chart.peak * 1024)}
          </span>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5">
            <div className="h-2 w-2 rounded-full bg-gradient-to-r from-emerald-400 to-teal-500"></div>
            <span className="text-xs text-slate-600 dark:text-slate-400">{t('dashboard.upload')}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="h-2 w-2 rounded-full bg-gradient-to-r from-indigo-500 to-violet-500"></div>
            <span className="text-xs text-slate-600 dark:text-slate-400">{t('dashboard.download')}</span>
          </div>
        </div>
      </div>

      {/* 图表 */}
      <div className="relative h-48 w-full overflow-hidden rounded-xl bg-gradient-to-b from-white via-slate-50 to-white dark:bg-gradient-to-b dark:from-slate-800/40 dark:via-slate-800/20 dark:to-slate-800/40">
        <svg className="h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none">
        <defs>
          <linearGradient id="traffic-download-fill" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="rgba(99, 102, 241, 0.32)" />
            <stop offset="100%" stopColor="rgba(99, 102, 241, 0.04)" />
          </linearGradient>
          <linearGradient id="traffic-upload-fill" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="rgba(34, 197, 94, 0.3)" />
            <stop offset="100%" stopColor="rgba(34, 197, 94, 0.04)" />
          </linearGradient>
          <linearGradient id="traffic-download-line" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#6366f1" />
            <stop offset="100%" stopColor="#8b5cf6" />
          </linearGradient>
          <linearGradient id="traffic-upload-line" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#34d399" />
            <stop offset="100%" stopColor="#14b8a6" />
          </linearGradient>
        </defs>

        {chart.yTicks.map((tick, index) => (
          <line
            key={`yt-${index}`}
            x1="0"
            y1={tick.y}
            x2="100"
            y2={tick.y}
            stroke={index === 0 ? 'rgba(148, 163, 184, 0.3)' : 'rgba(148, 163, 184, 0.15)'}
            strokeDasharray={index === 0 ? undefined : '1.5 3'}
            strokeWidth={index === 0 ? 0.45 : 0.35}
          />
        ))}

        {chart.timeTicks.map((tick, index) => (
          <line
            key={`xt-${index}`}
            x1={tick.x}
            y1={chart.baseLine}
            x2={tick.x}
            y2={chart.baseLine + 0.8}
            stroke="rgba(148, 163, 184, 0.2)"
            strokeWidth="0.3"
          />
        ))}

        <line x1="0" y1={chart.baseLine} x2="100" y2={chart.baseLine} stroke="rgba(148, 163, 184, 0.25)" strokeWidth="0.45" />

        <path d={chart.downShape.fill} fill="url(#traffic-download-fill)" opacity="0.55" />
        <path d={chart.upShape.fill} fill="url(#traffic-upload-fill)" opacity="0.5" />

        <path d={chart.downShape.line} fill="none" stroke="url(#traffic-download-line)" strokeWidth="0.5" />
        <path d={chart.upShape.line} fill="none" stroke="url(#traffic-upload-line)" strokeWidth="0.5" />
      </svg>
      </div>
    </div>
  );
}
