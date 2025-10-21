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

const FILTERS: Array<{ value: 'all' | 'http' | 'https' | 'tcp' | 'udp'; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'http', label: 'HTTP' },
  { value: 'https', label: 'HTTPS' },
  { value: 'tcp', label: 'TCP' },
  { value: 'udp', label: 'UDP' }
];

export default function ConnectionTable() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [activeTab, setActiveTab] = useState<'all' | 'http' | 'https' | 'tcp' | 'udp'>('all');
  const [stats, setStats] = useState<Stats>({
    totalConnections: 0,
    activeConnections: 0,
    totalUpload: 0,
    totalDownload: 0
  });
  const [sortConfig, setSortConfig] = useState<{ key: SortKey; direction: 'asc' | 'desc' }>({
    key: 'start',
    direction: 'desc'
  });

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

  const fetchConnections = async () => {
    setIsLoading(true);
    setError(null);

    try {
      let apiHost = '127.0.0.1';
      let apiPort = '9090';
      let apiSecret = '';

      if (window.electronAPI) {
        try {
          const apiConfigResult = await window.electronAPI.getApiConfig();
          if (apiConfigResult?.success) {
            apiHost = apiConfigResult.controllerHost || apiHost;
            apiPort = apiConfigResult.controllerPort || apiPort;
            apiSecret = apiConfigResult.secret || apiSecret;
          }
        } catch (apiError) {
          console.error('获取 API 配置失败:', apiError);
        }
      }

      const versionResponse = await window.electronAPI?.requestMihomoAPI?.('/version');
      if (versionResponse && !versionResponse.ok) {
        throw new Error('Mihomo 未运行');
      }

      const connectionsResponse = await window.electronAPI?.requestMihomoAPI?.('/connections');
      const data = connectionsResponse?.data ?? connectionsResponse;

      if (!data?.connections || !Array.isArray(data.connections)) {
        setConnections([]);
        setStats({ totalConnections: 0, activeConnections: 0, totalUpload: 0, totalDownload: 0 });
        return;
      }

      let totalUpload = 0;
      let totalDownload = 0;
      data.connections.forEach((conn: Connection) => {
        totalUpload += conn.upload;
        totalDownload += conn.download;
      });

      setStats({
        totalConnections: data.connections.length,
        activeConnections: data.connections.length,
        totalUpload,
        totalDownload
      });
      setConnections(data.connections);
    } catch (err) {
      console.error('获取连接数据失败:', err);
      setError(`获取连接数据失败: ${String(err)}`);
    } finally {
      setIsLoading(false);
    }
  };

  const closeAllConnections = async () => {
    try {
      const response = await window.electronAPI?.requestMihomoAPI?.('/connections', { method: 'DELETE' });
      if (response && !response.ok) {
        throw new Error(response.statusText || '断开失败');
      }
      fetchConnections();
    } catch (err) {
      console.error('断开所有连接失败:', err);
      setError(`断开所有连接失败: ${String(err)}`);
    }
  };

  const closeConnection = async (id: string) => {
    try {
      const response = await window.electronAPI?.requestMihomoAPI?.(`/connections/${id}`, { method: 'DELETE' });
      if (response && !response.ok) {
        throw new Error(response.statusText || '断开失败');
      }
      setConnections((prev) => prev.filter((conn) => conn.id !== id));
      setStats((prev) => ({
        ...prev,
        activeConnections: Math.max(prev.activeConnections - 1, 0)
      }));
    } catch (err) {
      console.error(`断开连接 ${id} 失败:`, err);
      setError(`断开连接失败: ${String(err)}`);
    }
  };

  useEffect(() => {
    fetchConnections();
    const intervalId = setInterval(fetchConnections, 5000);
    return () => clearInterval(intervalId);
  }, []);

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
      <Badge className={`flex items-center rounded-full border px-1.5 py-0.5 text-[10px] ${badgeClass}`}>
        {icon}
        {type || network.toUpperCase()}
      </Badge>
    );
  };

  const metrics = [
    {
      label: '活跃连接',
      value: stats.activeConnections.toString(),
      helper: '当前活跃连接数',
      icon: <GlobeIcon className="h-4 w-4 text-primary" />
    },
    {
      label: '上传流量',
      value: formatBytes(stats.totalUpload),
      helper: '会话累计上传',
      icon: <UploadIcon className="h-4 w-4 text-emerald-500" />
    },
    {
      label: '下载流量',
      value: formatBytes(stats.totalDownload),
      helper: '会话累计下载',
      icon: <DownloadIcon className="h-4 w-4 text-sky-500" />
    },
    {
      label: '总流量',
      value: formatBytes(stats.totalUpload + stats.totalDownload),
      helper: '上传 + 下载',
      icon: <ClockIcon className="h-4 w-4 text-violet-500" />
    }
  ];

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
                placeholder="搜索连接..."
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
                <span>共显示 <strong>{filteredConnections.length}</strong> 个连接</span>
              ) : (
                <span>没有连接</span>
              )}
            </div>

            <div className="flex w-full justify-end gap-2 sm:w-auto">
              <Button
                variant="outline"
                onClick={fetchConnections}
                className="h-8 rounded-full bg-white/70 px-3 text-xs dark:bg-[#222222]"
                disabled={isLoading}
                size="sm"
              >
                {isLoading ? (
                  <ReloadIcon className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <ReloadIcon className="mr-1.5 h-3.5 w-3.5" />
                )}
                刷新
              </Button>

              <Button
                variant="destructive"
                onClick={closeAllConnections}
                disabled={connections.length === 0 || isLoading}
                size="sm"
                className="h-8 rounded-full px-3 text-xs"
              >
                <Cross1Icon className="mr-1.5 h-3.5 w-3.5" />
                断开所有连接
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
          <div className="connection-table-scroll border-b border-white/20 bg-white text-slate-600 dark:border-gray-700 dark:bg-[#2a2a2a] dark:text-slate-200 overflow-x-auto">
            <table className="w-full min-w-[560px] md:min-w-[720px] text-xs">
              <thead>
                <tr>
                  <th
                    className="sticky top-0 cursor-pointer px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground transition hover:text-foreground"
                    onClick={() => requestSort('metadata')}
                    style={{ width: '25%' }}
                  >
                    <div className="flex items-center">
                      主机/IP
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
                  <th className="sticky top-0 px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground" style={{ width: '10%' }}>
                    类型
                  </th>
                  <th
                    className="sticky top-0 cursor-pointer px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground transition hover:text-foreground"
                    onClick={() => requestSort('upload')}
                    style={{ width: '12%' }}
                  >
                    <div className="flex items-center">
                      上传
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
                    className="sticky top-0 cursor-pointer px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground transition hover:text-foreground"
                    onClick={() => requestSort('download')}
                    style={{ width: '12%' }}
                  >
                    <div className="flex items-center">
                      下载
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
                    className="sticky top-0 cursor-pointer px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground transition hover:text-foreground"
                    onClick={() => requestSort('duration')}
                    style={{ width: '12%' }}
                  >
                    <div className="flex items-center">
                      连接时长
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
                  <th className="sticky top-0 px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground" style={{ width: '20%' }}>
                    代理链
                  </th>
                  <th className="sticky top-0 px-4 py-3 text-right text-xs font-medium uppercase tracking-wide text-muted-foreground" style={{ width: '9%' }}>
                    操作
                  </th>
                </tr>
              </thead>
            </table>
          </div>

          <div className="connection-table-scroll flex-1 overflow-x-auto overflow-y-auto">
            <table className="w-full min-w-[560px] md:min-w-[720px] text-xs">
              <tbody className="divide-y divide-white/20 dark:divide-white/15">
                {filteredConnections.length > 0 ? (
                  filteredConnections.map((connection) => (
                    <tr key={connection.id} className="transition-colors hover:bg-slate-50 dark:hover:bg-white/10">
                      <td className="px-4 py-3" style={{ width: '25%' }}>
                        <div className="flex flex-col">
                          <span className="max-w-[220px] truncate font-medium text-slate-700 dark:text-slate-100">
                            {connection.metadata.host || connection.metadata.destinationIP}
                          </span>
                          <span className="mt-1 text-[10px] text-slate-400 dark:text-slate-400">
                            {connection.metadata.sourceIP}:{connection.metadata.sourcePort}
                            <span className="mx-1 inline-block rotate-90">⟶</span>
                            {connection.metadata.destinationIP}:{connection.metadata.destinationPort}
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-3" style={{ width: '10%' }}>
                        {renderTypeBadge(connection.metadata.type, connection.metadata.network)}
                      </td>
                      <td className="px-4 py-3" style={{ width: '12%' }}>
                        <div className="flex flex-col">
                          <span className="font-medium text-emerald-500 dark:text-emerald-300">
                            {formatBytes(connection.upload)}
                          </span>
                          {connection.upload > 0 && (
                            <div className="mt-0.5 w-full">
                              <Progress
                                className="h-1"
                                value={(connection.upload / (connection.upload + connection.download || 1)) * 100}
                                indicatorColor="green"
                              />
                            </div>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3" style={{ width: '12%' }}>
                        <div className="flex flex-col">
                          <span className="font-medium text-sky-500 dark:text-sky-300">
                            {formatBytes(connection.download)}
                          </span>
                          {connection.download > 0 && (
                            <div className="mt-0.5 w-full">
                              <Progress
                                className="h-1"
                                value={(connection.download / (connection.upload + connection.download || 1)) * 100}
                                indicatorColor="blue"
                              />
                            </div>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-slate-600 dark:text-slate-200" style={{ width: '12%' }}>
                        {formatConnectionDuration(connection.start)}
                      </td>
                      <td className="px-4 py-3" style={{ width: '20%' }}>
                        <div className="flex flex-col">
                          <span className="truncate font-medium text-slate-700 dark:text-slate-200">
                            {connection.chains?.join(' → ') || '-'}
                          </span>
                          <span className="mt-0.5 inline-flex items-center text-[10px] text-slate-400 dark:text-slate-400">
                            <Badge variant="outline" className="h-4 rounded-full bg-white/70 px-2 text-[10px] text-slate-500 dark:bg-[#222222] dark:text-slate-300">
                              {connection.rule}
                            </Badge>
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right" style={{ width: '9%' }}>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => closeConnection(connection.id)}
                          className="h-7 w-7 rounded-full border-transparent bg-white/70 p-0 text-red-500 transition hover:bg-red-50 hover:text-red-600 dark:bg-[#222222] dark:text-red-400 dark:hover:bg-red-900/20"
                        >
                          <Cross1Icon className="h-3.5 w-3.5" />
                        </Button>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-slate-400 dark:text-slate-400">
                      {isLoading ? (
                        <div className="flex items-center justify-center">
                          <ReloadIcon className="mr-2 h-4 w-4 animate-spin" />
                          加载中...
                        </div>
                      ) : error ? (
                        <span>出错了，请尝试刷新</span>
                      ) : (
                        <div className="flex flex-col items-center">
                          <ActivityLogIcon className="mb-2 h-8 w-8 text-slate-300 dark:text-slate-600" />
                          <span>没有找到符合条件的连接</span>
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
