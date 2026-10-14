import React, { useState, useEffect, useMemo } from 'react';
import { BarChart3, TrendingUp, TrendingDown, Monitor, Globe, Shield } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { showToast } from '@/components/ui/toast';
import { CardHeading } from './CardHeading';
import { processIconKey, loadProcessIcon, invalidateProcessIcon } from '@/lib/process-icons';

interface Connection {
  id: string;
  metadata: {
    network: string;
    type: string;
    sourceIP: string;
    destinationIP: string;
    sourcePort: string;
    destinationPort: string;
    host: string;
    process: string;
    processPath: string;
  };
  upload: number;
  download: number;
  start: string;
  chains: string[];
  rule: string;
  rulePayload: string;
}

interface TrafficRankingCardProps {
  connections: Connection[];
}

type ViewMode = 'process' | 'domain' | 'rule';

interface RankingItem {
  name: string;
  upload: number;
  download: number;
  total: number;
  count: number;
  processPath?: string;
  processName?: string;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

export function TrafficRankingCard({ connections }: TrafficRankingCardProps) {
  const { t } = useTranslation();
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    try {
      const saved = localStorage.getItem('trafficRankingViewMode');
      return (saved === 'domain' || saved === 'rule' ? saved : 'process') as ViewMode;
    } catch {
      return 'process';
    }
  });
  const [iconMap, setIconMap] = useState<Record<string, string>>({});

  const persistViewMode = (mode: ViewMode) => {
    setViewMode(mode);
    try {
      localStorage.setItem('trafficRankingViewMode', mode);
    } catch (error) {
      console.error('保存视图模式失败:', error);
      showToast({
        message: t('dashboard.viewModeSaveFailed', { error: error instanceof Error ? error.message : String(error || t('common.error')) }),
        type: 'error',
      });
    }
  };

  const rankings = useMemo(() => {
    const map = new Map<string, RankingItem>();

    connections.forEach((conn) => {
      let key: string;
      let processPath: string | undefined;

      switch (viewMode) {
        case 'process':
          key = conn.metadata.process || conn.metadata.sourceIP || t('dashboard.unknownProcess');
          processPath = conn.metadata.processPath;
          break;
        case 'domain':
          key = conn.metadata.host || conn.metadata.destinationIP || t('dashboard.unknownDomain');
          break;
        case 'rule':
          key = conn.rule || t('dashboard.unknownRule');
          break;
        default:
          key = t('dashboard.unknown');
      }

      const existing = map.get(key);
      if (existing) {
        existing.upload += conn.upload;
        existing.download += conn.download;
        existing.total += conn.upload + conn.download;
        existing.count += 1;
        if (!existing.processPath && processPath) existing.processPath = processPath;
        if (!existing.processName && conn.metadata.process) existing.processName = conn.metadata.process;
      } else {
        map.set(key, {
          name: key,
          upload: conn.upload,
          download: conn.download,
          total: conn.upload + conn.download,
          count: 1,
          processPath,
          processName: viewMode === 'process' ? conn.metadata.process : undefined,
        });
      }
    });

    return Array.from(map.values())
      .sort((a, b) => b.total - a.total)
      .slice(0, 10);
  }, [connections, viewMode]);

  // Resolve path or process-name hints without repeated native calls on traffic updates.
  useEffect(() => {
    if (viewMode !== 'process') return;
    let cancelled = false;
    const keys = [...new Set(rankings.map(item => processIconKey(item.processPath, item.processName))
      .filter((key): key is string => !!key && !iconMap[key]))];
    void Promise.all(keys.map(async key => {
      const icon = await loadProcessIcon(key);
      if (icon && !cancelled) setIconMap(previous => ({ ...previous, [key]: icon }));
    }));
    return () => { cancelled = true; };
  }, [rankings, viewMode, iconMap]);

  const maxTotal = rankings[0]?.total || 1;

  return (
    <div className="flex dashboard-large-card flex-col space-y-5 dashboard-card p-card">
      {/* 标题和切换按钮 */}
      <div className="flex flex-shrink-0 items-center justify-between">
        <CardHeading type="traffic-ranking">
          {t('dashboard.trafficRanking')}
        </CardHeading>
        <div className="flex gap-1 rounded-control bg-gray-100 p-1 dark:bg-[#1f1f1f]">
          <button
            onClick={() => {
              persistViewMode('process');
            }}
            className={`flex items-center gap-1 rounded-lg px-3 py-1 text-xs font-medium transition-colors ${
              viewMode === 'process'
                ? 'bg-white text-primary shadow-sm dark:bg-[#222222] dark:text-primary'
                : 'text-gray-600 hover:text-gray-900 dark:bg-[#222222] dark:text-gray-300 dark:hover:bg-[#2a2a2a] dark:hover:text-gray-100'
            }`}
          >
            <Monitor className="h-3 w-3" />
            {t('dashboard.process')}
          </button>
          <button
            onClick={() => {
              persistViewMode('domain');
            }}
            className={`flex items-center gap-1 rounded-lg px-3 py-1 text-xs font-medium transition-colors ${
              viewMode === 'domain'
                ? 'bg-white text-primary shadow-sm dark:bg-[#222222] dark:text-primary'
                : 'text-gray-600 hover:text-gray-900 dark:bg-[#222222] dark:text-gray-300 dark:hover:bg-[#2a2a2a] dark:hover:text-gray-100'
            }`}
          >
            <Globe className="h-3 w-3" />
            {t('dashboard.domain')}
          </button>
          <button
            onClick={() => {
              persistViewMode('rule');
            }}
            className={`flex items-center gap-1 rounded-lg px-3 py-1 text-xs font-medium transition-colors ${
              viewMode === 'rule'
                ? 'bg-white text-primary shadow-sm dark:bg-[#222222] dark:text-primary'
                : 'text-gray-600 hover:text-gray-900 dark:bg-[#222222] dark:text-gray-300 dark:hover:bg-[#2a2a2a] dark:hover:text-gray-100'
            }`}
          >
            <Shield className="h-3 w-3" />
            {t('dashboard.rule')}
          </button>
        </div>
      </div>

      {/* 排行列表 */}
      <div className="flex-1 space-y-3 overflow-x-hidden overflow-y-auto custom-scrollbar">
        {rankings.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            {t('dashboard.noData')}
          </div>
        ) : (
          rankings.map((item, index) => (
            <div key={item.name} className="space-y-2">
              {/* 名称和排名 */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span
                    className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${
                      index === 0
                        ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400'
                        : index === 1
                        ? 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-400'
                        : index === 2
                        ? 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400'
                        : 'bg-gray-50 text-gray-600 dark:bg-gray-800/50 dark:text-gray-500'
                    }`}
                  >
                    {index + 1}
                  </span>
                  {viewMode === 'process' && iconMap[processIconKey(item.processPath, item.processName) || ''] ? (
                    <img
                      src={iconMap[processIconKey(item.processPath, item.processName) || '']}
                      onError={() => { const key = processIconKey(item.processPath, item.processName); if (key) { invalidateProcessIcon(key); setIconMap(previous => { const next = { ...previous }; delete next[key]; return next; }); } }}
                      alt={item.name}
                      className="h-5 w-5 shrink-0 rounded object-contain"
                    />
                  ) : viewMode === 'process' ? (
                    <Monitor aria-hidden className="h-5 w-5 shrink-0 text-muted-foreground/60" />
                  ) : null}
                  <span className="truncate text-sm font-medium text-foreground max-w-[200px]">
                    {item.name}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    ({item.count} {t('dashboard.connections')})
                  </span>
                </div>
                <span className="text-sm font-semibold text-foreground">
                  {formatBytes(item.total)}
                </span>
              </div>

              {/* 进度条 */}
              <div className="relative h-2 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800">
                <div
                  className="absolute left-0 top-0 h-full rounded-full bg-gradient-to-r from-blue-500 to-blue-600 transition-all duration-300"
                  style={{ width: `${(item.total / maxTotal) * 100}%` }}
                />
              </div>

              {/* 上传/下载详情 */}
              <div className="flex items-center gap-4 text-xs text-muted-foreground">
                <div className="flex items-center gap-1">
                  <TrendingUp className="h-3 w-3 text-green-500" />
                  <span>{formatBytes(item.upload)}</span>
                </div>
                <div className="flex items-center gap-1">
                  <TrendingDown className="h-3 w-3 text-blue-500" />
                  <span>{formatBytes(item.download)}</span>
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

