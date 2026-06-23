'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityLogIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  ClockIcon,
  Cross1Icon,
  DownloadIcon,
  GlobeIcon,
  MagnifyingGlassIcon,
  ReloadIcon,
  UploadIcon
} from '@radix-ui/react-icons';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { Input } from './ui/input';
import { Progress } from './ui/progress';
import { formatBytes, formatDuration } from '../utils/formatters';
import { Network } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { showToast } from '@/components/ui/toast';
import {
  APP_DATA_CACHE_KEYS,
  hasAppDataCache,
  readAppDataCache,
  subscribeAppDataCache,
  writeAppDataCache,
} from '@/services/app-data-cache';
import { isMihomoRuntimeUnavailableError, mihomoClient } from '@/services/mihomo-client';

interface Connection {
  id: string;
  metadata: {
    network: string;
    type: string;
    sourceIP: string;
    destinationIP: string;
    sourcePort: number;
    destinationPort: number;
    host: string;
    dnsMode?: string;
    processPath?: string;
  };
  upload: number;
  download: number;
  start: string;
  chains: string[];
  rule: string;
  rulePayload?: string;
}

type SortKey = keyof Connection | 'duration';

type Stats = {
  totalConnections: number;
  activeConnections: number;
  totalUpload: number;
  totalDownload: number;
};

const TAURI_RUNTIME_UNAVAILABLE = 'Tauri runtime is not available';

const emptyStats: Stats = {
  totalConnections: 0,
  activeConnections: 0,
  totalUpload: 0,
  totalDownload: 0
};

const calculateStats = (items: Connection[]): Stats => {
  return items.reduce<Stats>((acc, conn) => ({
    totalConnections: acc.totalConnections + 1,
    activeConnections: acc.activeConnections + 1,
    totalUpload: acc.totalUpload + (conn.upload || 0),
    totalDownload: acc.totalDownload + (conn.download || 0)
  }), { ...emptyStats });
};

const connectionViewCache: {
  connections: Connection[];
  stats: Stats;
  loaded: boolean;
} = {
  connections: [],
  stats: emptyStats,
  loaded: false,
};

const CONNECTIONS_CACHE_KEY = APP_DATA_CACHE_KEYS.connections;

const readConnectionsSessionCache = (): Connection[] | null => {
  const cached = readAppDataCache<unknown>(CONNECTIONS_CACHE_KEY);
  return Array.isArray(cached) ? cached as Connection[] : null;
};

const hydrateConnectionsFromSession = () => {
  if (connectionViewCache.loaded) return;
  const cached = readConnectionsSessionCache();
  if (!cached) return;
  connectionViewCache.connections = cached;
  connectionViewCache.stats = calculateStats(cached);
  connectionViewCache.loaded = true;
};

const readErrorMessage = (value: unknown, fallback: string): string => {
  if (value instanceof Error) return value.message || fallback;
  if (typeof value === 'string') return value || fallback;
  if (!value || typeof value !== 'object') return fallback;

  const record = value as {
    error?: unknown;
    statusText?: unknown;
    message?: unknown;
    text?: unknown;
    data?: { message?: unknown; error?: unknown };
  };
  const raw = record.error ?? record.statusText ?? record.message ?? record.data?.error ?? record.data?.message ?? record.text;

  if (typeof raw === 'string') return raw || fallback;
  if (raw != null) return String(raw);
  return fallback;
};

const isFailureResult = (value: unknown): value is { success: false; error?: unknown } => {
  return !!value && typeof value === 'object' && 'success' in value && (value as { success?: boolean }).success === false;
};

const isExplicitSuccess = (value: unknown): boolean => {
  if (typeof value === 'boolean') return value;
  return !!value && typeof value === 'object' && 'success' in value && (value as { success?: boolean }).success === true;
};

const isRuntimeUnavailableMessage = (message: string) => {
  return message.includes(TAURI_RUNTIME_UNAVAILABLE) || message.includes('not implemented in the Tauri runtime');
};

export default function ConnectionTable() {
  const { t } = useTranslation();

  const FILTERS: Array<{ value: 'all' | 'http' | 'https' | 'tcp' | 'udp'; label: string }> = [
    { value: 'all', label: t('connections.all') },
    { value: 'http', label: 'HTTP' },
    { value: 'https', label: 'HTTPS' },
    { value: 'tcp', label: 'TCP' },
    { value: 'udp', label: 'UDP' }
  ];

  const [connections, setConnections] = useState<Connection[]>(() => {
    hydrateConnectionsFromSession();
    return connectionViewCache.connections;
  });
  const [isLoading, setIsLoading] = useState(() => !connectionViewCache.loaded);
  const [error, setError] = useState<string | null>(null);
  const [closingAll, setClosingAll] = useState(false);
  const [closingConnectionIds, setClosingConnectionIds] = useState<Set<string>>(new Set());
  const [searchTerm, setSearchTerm] = useState('');
  const [activeTab, setActiveTab] = useState<'all' | 'http' | 'https' | 'tcp' | 'udp'>('all');
  const [stats, setStats] = useState<Stats>(() => connectionViewCache.stats);
  const [sortConfig, setSortConfig] = useState<{ key: SortKey; direction: 'asc' | 'desc' }>({
    key: 'start',
    direction: 'desc'
  });

  // 图标缓存和加载状态
  const [iconMap, setIconMap] = useState<Record<string, string>>({});
  const iconRequestQueueRef = React.useRef<Set<string>>(new Set());
  const processingIconsRef = React.useRef<Set<string>>(new Set());
  const connectionsRef = React.useRef<Connection[]>(connections);
  const isLoadingRef = React.useRef(isLoading);

  useEffect(() => {
    connectionsRef.current = connections;
    connectionViewCache.connections = connections;
  }, [connections]);

  useEffect(() => {
    isLoadingRef.current = isLoading;
    if (!isLoading) {
      connectionViewCache.loaded = true;
    }
  }, [isLoading]);

  useEffect(() => {
    connectionViewCache.stats = stats;
  }, [stats]);

  useEffect(() => {
    return subscribeAppDataCache(CONNECTIONS_CACHE_KEY, () => {
      const cached = readConnectionsSessionCache();
      if (!cached) return;
      const nextStats = calculateStats(cached);
      connectionViewCache.connections = cached;
      connectionViewCache.stats = nextStats;
      connectionViewCache.loaded = true;
      setConnections(cached);
      setStats(nextStats);
      setIsLoading(false);
    });
  }, []);

  const formatConnectionError = useCallback((error: unknown, fallback?: string) => {
    const message = readErrorMessage(error, fallback || t('connections.disconnectError', { error: '' })).trim();
    const lower = message.toLowerCase();

    if (isRuntimeUnavailableMessage(message)) {
      return t('connections.apiUnavailable');
    }

    if (
      isMihomoRuntimeUnavailableError(message) ||
      lower.includes('mihomo service unavailable') ||
      lower.includes('mihomo service not running') ||
      lower.includes('core service is not running') ||
      message.includes('Mihomo 未运行') ||
      message.includes('内核服务未运行')
    ) {
      return t('connections.mihomoNotRunning');
    }

    return message || fallback || t('connections.disconnectError', { error: '' });
  }, [t]);

  const formatConnectionDuration = (startTimeISO: string) => {
    const startTime = new Date(startTimeISO).getTime();
    const now = Date.now();
    return formatDuration(now - startTime);
  };

  const sortedConnections = useCallback(() => {
    const sortable = [...connections];

    if (sortConfig.key === 'duration') {
      return sortable.sort((a, b) => {
        const durationA = Date.now() - new Date(a.start).getTime();
        const durationB = Date.now() - new Date(b.start).getTime();
        return sortConfig.direction === 'asc' ? durationA - durationB : durationB - durationA;
      });
    }

    return sortable.sort((a, b) => {
      const key = sortConfig.key as Exclude<SortKey, 'duration'>;

      if (key === 'metadata') {
        const hostA = a.metadata?.host ?? '';
        const hostB = b.metadata?.host ?? '';
        return sortConfig.direction === 'asc' ? hostA.localeCompare(hostB) : hostB.localeCompare(hostA);
      }

      const valueA = a[key];
      const valueB = b[key];

      if (valueA === valueB) return 0;
      if (valueA == null) return sortConfig.direction === 'asc' ? -1 : 1;
      if (valueB == null) return sortConfig.direction === 'asc' ? 1 : -1;

      return sortConfig.direction === 'asc'
        ? (valueA as number) < (valueB as number) ? -1 : 1
        : (valueA as number) > (valueB as number) ? -1 : 1;
    });
  }, [connections, sortConfig]);

  const requestSort = (key: SortKey) => {
    setSortConfig((prev) => ({
      key,
      direction: prev.key === key && prev.direction === 'asc' ? 'desc' : 'asc'
    }));
  };

  const filteredConnections = useMemo(() => {
    return sortedConnections().filter((connection) => {
      const term = searchTerm.trim().toLowerCase();
      if (term) {
        const matchesHost = connection.metadata.host?.toLowerCase().includes(term);
        const matchesSource = connection.metadata.sourceIP.includes(term);
        const matchesRule = connection.rule?.toLowerCase().includes(term);
        if (!matchesHost && !matchesSource && !matchesRule) {
          return false;
        }
      }

      if (activeTab === 'http' && connection.metadata.type !== 'HTTP') return false;
      if (activeTab === 'https' && connection.metadata.type !== 'HTTPS') return false;
      if (activeTab === 'tcp' && connection.metadata.network !== 'tcp') return false;
      if (activeTab === 'udp' && connection.metadata.network !== 'udp') return false;

      return true;
    });
  }, [activeTab, searchTerm, sortedConnections]);

  // 图标加载队列处理函数
  const processIconQueue = useCallback(async () => {
    if (processingIconsRef.current.size >= 5 || iconRequestQueueRef.current.size === 0) return;

    const pathsToProcess = Array.from(iconRequestQueueRef.current).slice(0, 5);
    pathsToProcess.forEach((path) => iconRequestQueueRef.current.delete(path));

    const promises = pathsToProcess.map(async (path) => {
      if (processingIconsRef.current.has(path)) return;
      processingIconsRef.current.add(path);

      try {
        // 先检查 localStorage 缓存
        const cached = localStorage.getItem(`icon:${path}`);
        if (cached) {
          setIconMap((prev) => ({ ...prev, [path]: cached }));
          processingIconsRef.current.delete(path);
          return;
        }

        // 调用 IPC 获取图标
        const iconDataURL = await window.electronAPI?.getIconDataURL?.(path);
        if (iconDataURL) {
          // 缓存到 localStorage
          try {
            localStorage.setItem(`icon:${path}`, iconDataURL);
          } catch (e) {
            // localStorage 可能已满，忽略错误
          }
          setIconMap((prev) => ({ ...prev, [path]: iconDataURL }));
        }
      } catch (error) {
        console.error(`获取图标失败 (${path}):`, error);
      } finally {
        processingIconsRef.current.delete(path);
      }
    });

    await Promise.all(promises);

    // 如果队列中还有待处理的图标，继续处理
    if (iconRequestQueueRef.current.size > 0) {
      setTimeout(processIconQueue, 50);
    }
  }, []);

  const fetchConnections = useCallback(async () => {
    let showedLoading = false;
    // 只在初始加载时（connections为空）显示loading
    if (
      connectionsRef.current.length === 0 &&
      !connectionViewCache.loaded &&
      !hasAppDataCache(CONNECTIONS_CACHE_KEY)
    ) {
      setIsLoading(true);
      showedLoading = true;
    }
    setError(null);

    try {
      await mihomoClient.getVersion();
      const data = await mihomoClient.getConnections();

      if (!data?.connections || !Array.isArray(data.connections)) {
        // 只在初始加载或从有数据变为无数据时才更新为空
        setConnections([]);
        setStats(emptyStats);
        writeAppDataCache(CONNECTIONS_CACHE_KEY, []);
        return;
      }

      const nextConnections = data.connections as unknown as Connection[];
      writeAppDataCache(CONNECTIONS_CACHE_KEY, nextConnections);
      setConnections(nextConnections);
      setStats(calculateStats(nextConnections));
    } catch (err) {
      const message = formatConnectionError(err, t('connections.fetchError', { error: '' }));
      if (message === t('connections.mihomoNotRunning')) {
        setConnections([]);
        setStats(emptyStats);
        writeAppDataCache(CONNECTIONS_CACHE_KEY, []);
        return;
      }

      console.error('获取连接数据失败:', err);
      setError(t('connections.fetchError', { error: message }));
    } finally {
      // 只在初始加载时才设置loading为false，避免后续刷新时的闪烁
      if (showedLoading || isLoadingRef.current) {
        setIsLoading(false);
      }
    }
  }, [formatConnectionError, t]);

  const closeAllConnectionsViaBridge = useCallback(async () => {
    await mihomoClient.closeAllConnections();
  }, []);

  const closeConnectionViaBridge = useCallback(async (id: string) => {
    await mihomoClient.closeConnection(id);
  }, []);

  const closeAllConnections = async () => {
    if (closingAll || connections.length === 0) return;

    const previousConnections = connections;
    const previousStats = stats;
    const closingCount = connections.length;
    setClosingAll(true);
    setError(null);
    try {
      await closeAllConnectionsViaBridge();
      setConnections([]);
      setStats(emptyStats);
      showToast({
        message: t('connections.disconnectAllSuccess', { count: closingCount }),
        type: 'success',
      });
      fetchConnections();
    } catch (err) {
      console.error('断开所有连接失败:', err);
      setConnections(previousConnections);
      setStats(previousStats);
      const message = t('connections.disconnectAllError', {
        error: formatConnectionError(err, t('connections.disconnectAllError', { error: '' })),
      });
      setError(message);
      showToast({ message, type: 'error' });
    } finally {
      setClosingAll(false);
    }
  };

  const closeConnection = async (id: string) => {
    if (closingConnectionIds.has(id)) return;

    const target = connections.find((connection) => connection.id === id);
    const label = target?.metadata?.host || target?.metadata?.destinationIP || id;
    setClosingConnectionIds(prev => new Set(prev).add(id));
    setError(null);
    try {
      await closeConnectionViaBridge(id);
      setConnections((prev) => {
        const next = prev.filter((conn) => conn.id !== id);
        setStats(calculateStats(next));
        return next;
      });
      showToast({
        message: t('connections.disconnectSuccess', { target: label }),
        type: 'success',
      });
    } catch (err) {
      console.error(`断开连接 ${id} 失败:`, err);
      const message = t('connections.disconnectError', {
        error: formatConnectionError(err, t('connections.disconnectError', { error: '' })),
      });
      setError(message);
      showToast({ message, type: 'error' });
    } finally {
      setClosingConnectionIds(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  useEffect(() => {
    fetchConnections();
    const intervalId = setInterval(fetchConnections, 5000);
    const refreshAfterProfileChange = () => {
      fetchConnections();
    };
    const unsubscribeClosed = window.electronAPI?.onConnectionsClosed?.(() => {
      setConnections([]);
      setStats(emptyStats);
    });
    const unsubscribeUpdate = window.electronAPI?.onConnectionsUpdate?.(() => {
      fetchConnections();
    });
    const unsubscribeActiveConfig = window.electronAPI?.onActiveConfigChanged?.(() => {
      refreshAfterProfileChange();
    });
    const unsubscribeAutoUpdated = window.electronAPI?.onSubscriptionAutoUpdated?.(() => {
      refreshAfterProfileChange();
    });

    window.addEventListener('profile-updated', refreshAfterProfileChange);
    window.addEventListener('backup-restored', refreshAfterProfileChange);
    window.addEventListener('subscription-auto-updated', refreshAfterProfileChange);

    return () => {
      clearInterval(intervalId);
      window.removeEventListener('profile-updated', refreshAfterProfileChange);
      window.removeEventListener('backup-restored', refreshAfterProfileChange);
      window.removeEventListener('subscription-auto-updated', refreshAfterProfileChange);
      if (typeof unsubscribeClosed === 'function') unsubscribeClosed();
      if (typeof unsubscribeUpdate === 'function') unsubscribeUpdate();
      if (typeof unsubscribeActiveConfig === 'function') unsubscribeActiveConfig();
      if (typeof unsubscribeAutoUpdated === 'function') unsubscribeAutoUpdated();
    };
  }, [fetchConnections]);

  // 图标加载 useEffect
  useEffect(() => {
    // 收集所有需要加载图标的进程路径
    const visibleConnections = filteredConnections.slice(0, 20); // 只加载前20个可见连接的图标
    const pathsToLoad = new Set<string>();

    visibleConnections.forEach((conn) => {
      const path = conn.metadata.processPath;
      if (path && !iconMap[path] && !processingIconsRef.current.has(path)) {
        pathsToLoad.add(path);
      }
    });

    // 将路径添加到队列
    pathsToLoad.forEach((path) => iconRequestQueueRef.current.add(path));

    // 触发队列处理
    if (iconRequestQueueRef.current.size > 0) {
      processIconQueue();
    }
  }, [filteredConnections, iconMap, processIconQueue]);

  const renderTypeBadge = (type: string, network: string) => {
    let badgeClass = '';
    let icon: React.ReactNode = null;

    if (type === 'HTTP') {
      badgeClass = 'bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/30 dark:text-blue-400 dark:border-blue-800/40';
      icon = <GlobeIcon className="mr-1 h-2.5 w-2.5" />;
    } else if (type === 'HTTPS') {
      badgeClass = 'bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-400 dark:border-emerald-800/40';
      icon = <GlobeIcon className="mr-1 h-2.5 w-2.5" />;
    } else if (network === 'tcp') {
      badgeClass = 'bg-purple-100 text-purple-800 border-purple-200 dark:bg-purple-900/30 dark:text-purple-400 dark:border-purple-800/40';
      icon = <Network className="mr-1 h-2.5 w-2.5" />;
    } else if (network === 'udp') {
      badgeClass = 'bg-orange-100 text-orange-800 border-orange-200 dark:bg-orange-900/30 dark:text-orange-400 dark:border-orange-800/40';
      icon = <Network className="mr-1 h-2.5 w-2.5" />;
    }

    return (
      <Badge className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] whitespace-nowrap ${badgeClass}`}>
        {icon}
        {type || network.toUpperCase()}
      </Badge>
    );
  };

  const metrics = [
    {
      label: t('connections.activeConnections'),
      value: stats.activeConnections.toString(),
      helper: t('connections.activeConnectionsHelper'),
      icon: <GlobeIcon className="h-4 w-4 text-primary" />
    },
    {
      label: t('connections.uploadTraffic'),
      value: formatBytes(stats.totalUpload),
      helper: t('connections.uploadTrafficHelper'),
      icon: <UploadIcon className="h-4 w-4 text-emerald-500" />
    },
    {
      label: t('connections.downloadTraffic'),
      value: formatBytes(stats.totalDownload),
      helper: t('connections.downloadTrafficHelper'),
      icon: <DownloadIcon className="h-4 w-4 text-sky-500" />
    },
    {
      label: t('connections.totalTraffic'),
      value: formatBytes(stats.totalUpload + stats.totalDownload),
      helper: t('connections.totalTrafficHelper'),
      icon: <ClockIcon className="h-4 w-4 text-violet-500" />
    }
  ];
  const suppressColdEmptyState =
    isLoading &&
    filteredConnections.length === 0 &&
    !connectionViewCache.loaded &&
    !hasAppDataCache(CONNECTIONS_CACHE_KEY);

  return (
    <div className="space-y-6 min-w-0 w-full">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
        {metrics.map((metric) => (
          <Card
            key={metric.label}
            className="rounded-3xl bg-white p-5 shadow-sm transition hover:shadow-md dark:bg-[#2a2a2a]"
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {metric.label}
              </span>
              {metric.icon}
            </div>
            <div className="mt-3 text-2xl font-semibold text-foreground">{metric.value}</div>
            <div className="mt-1 text-xs text-muted-foreground">{metric.helper}</div>
          </Card>
        ))}
      </div>

      <section className="space-y-4 min-w-0">
        <Card className="space-y-4 rounded-3xl bg-white p-5 shadow-sm dark:bg-[#2a2a2a] min-w-0">
          <div className="flex flex-col items-start gap-4 md:flex-row md:items-center md:justify-between">
            <div className="inline-flex rounded-full bg-white/70 p-1 text-xs shadow-sm dark:bg-[#222222]">
              {FILTERS.map((filter) => (
                <button
                  key={filter.value}
                  type="button"
                  onClick={() => setActiveTab(filter.value)}
                  className={`rounded-full px-3 py-1 transition ${
                    activeTab === filter.value
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {filter.label}
                </button>
              ))}
            </div>

            <div className="relative w-full sm:w-60">
              <Input
                placeholder={t('connections.searchPlaceholder')}
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="h-10 w-full rounded-2xl bg-white/80 pl-10 pr-10 text-sm text-foreground shadow-sm transition focus:outline-none focus:ring-2 focus:ring-primary/30 dark:bg-[#222222] dark:text-slate-100"
              />
              <MagnifyingGlassIcon className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/70" />
            </div>
          </div>

          <div className="flex flex-col gap-3 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
            <div>
              {filteredConnections.length > 0 ? (
                <span dangerouslySetInnerHTML={{ __html: t('connections.showingConnections', { count: filteredConnections.length }) }} />
              ) : suppressColdEmptyState ? (
                <span aria-busy="true">&nbsp;</span>
              ) : (
                <span>{t('connections.noConnections')}</span>
              )}
            </div>

            <div className="flex w-full justify-end gap-2 sm:w-auto">
              <Button
                variant="outline"
                onClick={fetchConnections}
                className="h-8 rounded-full bg-white/70 px-3 text-xs dark:bg-[#222222]"
                size="sm"
              >
                <ReloadIcon className="mr-1.5 h-3.5 w-3.5" />
                {t('connections.refresh')}
              </Button>

              <Button
                variant="destructive"
                onClick={closeAllConnections}
                disabled={connections.length === 0 || closingAll}
                size="sm"
                className="h-8 rounded-full px-3 text-xs"
              >
                {closingAll ? (
                  <ReloadIcon className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Cross1Icon className="mr-1.5 h-3.5 w-3.5" />
                )}
                {t('connections.disconnectAll')}
              </Button>
            </div>
          </div>
        </Card>

        {error && (
          <div className="rounded-3xl bg-rose-50 px-4 py-3 text-xs text-rose-600 shadow-sm dark:bg-rose-500/10 dark:text-rose-200">
            <div className="flex items-center gap-2">
              <Cross1Icon className="h-3.5 w-3.5" />
              {error}
            </div>
          </div>
        )}

        <Card className="flex flex-col overflow-hidden rounded-3xl bg-white shadow-sm dark:bg-[#2a2a2a] min-w-0">
          <div className="connection-table-scroll flex-1 overflow-x-auto overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 z-10 border-b border-white/20 bg-white text-slate-600 dark:border-gray-700 dark:bg-[#2a2a2a] dark:text-slate-200">
                <tr>
                  <th
                    className="cursor-pointer px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground transition hover:text-foreground whitespace-nowrap"
                    onClick={() => requestSort('metadata')}
                  >
                    <div className="flex items-center">
                      {t('connections.hostIP')}
                      {sortConfig.key === 'metadata' && (
                        <span className="ml-1">
                          {sortConfig.direction === 'asc' ? (
                            <ChevronUpIcon className="h-3.5 w-3.5" />
                          ) : (
                            <ChevronDownIcon className="h-3.5 w-3.5" />
                          )}
                        </span>
                      )}
                    </div>
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground whitespace-nowrap">
                    {t('connections.type')}
                  </th>
                  <th
                    className="cursor-pointer px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground transition hover:text-foreground whitespace-nowrap"
                    onClick={() => requestSort('upload')}
                  >
                    <div className="flex items-center">
                      {t('connections.upload')}
                      {sortConfig.key === 'upload' && (
                        <span className="ml-1">
                          {sortConfig.direction === 'asc' ? (
                            <ChevronUpIcon className="h-3.5 w-3.5" />
                          ) : (
                            <ChevronDownIcon className="h-3.5 w-3.5" />
                          )}
                        </span>
                      )}
                    </div>
                  </th>
                  <th
                    className="cursor-pointer px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground transition hover:text-foreground whitespace-nowrap"
                    onClick={() => requestSort('download')}
                  >
                    <div className="flex items-center">
                      {t('connections.download')}
                      {sortConfig.key === 'download' && (
                        <span className="ml-1">
                          {sortConfig.direction === 'asc' ? (
                            <ChevronUpIcon className="h-3.5 w-3.5" />
                          ) : (
                            <ChevronDownIcon className="h-3.5 w-3.5" />
                          )}
                        </span>
                      )}
                    </div>
                  </th>
                  <th
                    className="cursor-pointer px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground transition hover:text-foreground whitespace-nowrap"
                    onClick={() => requestSort('duration')}
                  >
                    <div className="flex items-center">
                      {t('connections.duration')}
                      {sortConfig.key === 'duration' && (
                        <span className="ml-1">
                          {sortConfig.direction === 'asc' ? (
                            <ChevronUpIcon className="h-3.5 w-3.5" />
                          ) : (
                            <ChevronDownIcon className="h-3.5 w-3.5" />
                          )}
                        </span>
                      )}
                    </div>
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground whitespace-nowrap">
                    {t('connections.proxyChain')}
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wide text-muted-foreground whitespace-nowrap">
                    {t('connections.actions')}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/20 dark:divide-white/15">
                {filteredConnections.length > 0 ? (
                  filteredConnections.map((connection) => (
                    <tr key={connection.id} className="transition-colors hover:bg-slate-50 dark:hover:bg-white/10">
                      <td className="px-4 py-3 whitespace-nowrap">
                        <div className="flex items-center gap-3">
                          {/* 进程图标 */}
                          {connection.metadata.processPath && iconMap[connection.metadata.processPath] && (
                            <img
                              src={iconMap[connection.metadata.processPath]}
                              alt={t('connections.processIcon')}
                              className="h-8 w-8 flex-shrink-0 rounded"
                            />
                          )}
                          <div className="flex flex-col">
                            <span className="font-medium text-slate-700 dark:text-slate-100">
                              {connection.metadata.host || connection.metadata.destinationIP}
                            </span>
                            <span className="mt-1 text-[10px] text-slate-400 dark:text-slate-400 whitespace-nowrap">
                              {connection.metadata.sourceIP}:{connection.metadata.sourcePort}
                              <span className="mx-1 inline-block rotate-90">⟶</span>
                              {connection.metadata.destinationIP}:{connection.metadata.destinationPort}
                            </span>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        {renderTypeBadge(connection.metadata.type, connection.metadata.network)}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <div className="flex flex-col">
                          <span className="font-medium text-emerald-500 dark:text-emerald-300">
                            {formatBytes(connection.upload)}
                          </span>
                          {connection.upload > 0 && (
                            <div className="mt-0.5 w-20">
                              <Progress
                                className="h-1"
                                value={(connection.upload / (connection.upload + connection.download || 1)) * 100}
                                indicatorColor="green"
                              />
                            </div>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <div className="flex flex-col">
                          <span className="font-medium text-sky-500 dark:text-sky-300">
                            {formatBytes(connection.download)}
                          </span>
                          {connection.download > 0 && (
                            <div className="mt-0.5 w-20">
                              <Progress
                                className="h-1"
                                value={(connection.download / (connection.upload + connection.download || 1)) * 100}
                                indicatorColor="blue"
                              />
                            </div>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-slate-600 dark:text-slate-200 whitespace-nowrap">
                        {formatConnectionDuration(connection.start)}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <div className="flex flex-col">
                          <span className="font-medium text-slate-700 dark:text-slate-200">
                            {connection.chains?.join(' → ') || '-'}
                          </span>
                          <span className="mt-0.5 inline-flex items-center text-[10px] text-slate-400 dark:text-slate-400">
                            <Badge variant="outline" className="h-4 rounded-full bg-white/70 px-2 text-[10px] text-slate-500 dark:bg-[#222222] dark:text-slate-300">
                              {connection.rule}
                            </Badge>
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right whitespace-nowrap">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => closeConnection(connection.id)}
                          disabled={closingConnectionIds.has(connection.id)}
                          className="h-7 w-7 rounded-full border-transparent bg-white/70 p-0 text-red-500 transition hover:bg-red-50 hover:text-red-600 dark:bg-[#222222] dark:text-red-400 dark:hover:bg-red-900/20"
                        >
                          {closingConnectionIds.has(connection.id) ? (
                            <ReloadIcon className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Cross1Icon className="h-3.5 w-3.5" />
                          )}
                        </Button>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-slate-400 dark:text-slate-400">
                      {suppressColdEmptyState ? (
                        <div className="min-h-[48px]" aria-busy="true" />
                      ) : error ? (
                        <span>{t('connections.errorRefresh')}</span>
                      ) : (
                        <div className="flex flex-col items-center">
                          <ActivityLogIcon className="mb-2 h-8 w-8 text-slate-300 dark:text-slate-600" />
                          <span>{t('connections.noMatchingConnections')}</span>
                        </div>
                      )}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      </section>
    </div>
  );
}
