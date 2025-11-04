import React, { useState, useEffect, useMemo } from 'react';
import { BarChart3, TrendingUp, TrendingDown, Monitor, Globe, Shield } from 'lucide-react';
import { useTranslation } from 'react-i18next';

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
  processPath?: string; // 进程路径,用于获取图标
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

function getProcessIcon(processName: string): React.ReactNode {
  const name = processName.toLowerCase();

  // 浏览器
  if (name.includes('chrome')) return '🌐';
  if (name.includes('firefox')) return '🦊';
  if (name.includes('edge')) return '🌊';
  if (name.includes('safari')) return '🧭';
  if (name.includes('opera')) return '🎭';

  // 通讯软件
  if (name.includes('wechat') || name.includes('微信')) return '💬';
  if (name.includes('qq')) return '🐧';
  if (name.includes('telegram')) return '✈️';
  if (name.includes('discord')) return '💬';
  if (name.includes('slack')) return '💼';

  // 开发工具
  if (name.includes('vscode') || name.includes('code')) return '💻';
  if (name.includes('idea') || name.includes('pycharm')) return '🔧';
  if (name.includes('git')) return '📦';

  // 下载工具
  if (name.includes('thunder') || name.includes('迅雷')) return '⚡';
  if (name.includes('aria2')) return '📥';
  if (name.includes('qbittorrent') || name.includes('utorrent')) return '🌊';

  // 游戏平台
  if (name.includes('steam')) return '🎮';
  if (name.includes('epic')) return '🎯';

  // 默认图标
  return '📱';
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
      } else {
        map.set(key, {
          name: key,
          upload: conn.upload,
          download: conn.download,
          total: conn.upload + conn.download,
          count: 1,
          processPath,
        });
      }
    });

    return Array.from(map.values())
      .sort((a, b) => b.total - a.total)
      .slice(0, 10);
  }, [connections, viewMode]);

  // 获取进程图标
  useEffect(() => {
    if (viewMode !== 'process') return;

    const pathsToLoad = rankings
      .filter((item) => item.processPath && !iconMap[item.processPath])
      .map((item) => item.processPath!);

    if (pathsToLoad.length === 0) return;

    const loadIcons = async () => {
      for (const path of pathsToLoad) {
        try {
          // 先检查 localStorage 缓存
          const cached = localStorage.getItem(`icon:${path}`);
          if (cached) {
            setIconMap((prev) => ({ ...prev, [path]: cached }));
            continue;
          }

          // 调用 IPC 获取图标
          const iconDataURL = await (window as any).electronAPI?.getIconDataURL?.(path);
          if (iconDataURL) {
            try {
              localStorage.setItem(`icon:${path}`, iconDataURL);
            } catch (e) {
              // localStorage 可能已满，忽略错误
            }
            setIconMap((prev) => ({ ...prev, [path]: iconDataURL }));
          }
        } catch (error) {
          console.error(`获取图标失败 (${path}):`, error);
        }
      }
    };

    loadIcons();
  }, [rankings, viewMode, iconMap]);

  const maxTotal = rankings[0]?.total || 1;

  return (
    <div className="flex h-[260px] flex-col space-y-5 rounded-3xl bg-white p-6 shadow-sm dark:bg-[#2a2a2a]">
      {/* 标题和切换按钮 */}
      <div className="flex flex-shrink-0 items-center justify-between">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t('dashboard.trafficRanking')}
        </p>
        <div className="flex gap-1 rounded-lg bg-gray-100 p-1 dark:bg-[#1f1f1f]">
          <button
            onClick={() => {
              setViewMode('process');
              try {
                localStorage.setItem('trafficRankingViewMode', 'process');
              } catch (error) {
                console.error('保存视图模式失败:', error);
              }
            }}
            className={`flex items-center gap-1 rounded-md px-3 py-1 text-xs font-medium transition-colors ${
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
              setViewMode('domain');
              try {
                localStorage.setItem('trafficRankingViewMode', 'domain');
              } catch (error) {
                console.error('保存视图模式失败:', error);
              }
            }}
            className={`flex items-center gap-1 rounded-md px-3 py-1 text-xs font-medium transition-colors ${
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
              setViewMode('rule');
              try {
                localStorage.setItem('trafficRankingViewMode', 'rule');
              } catch (error) {
                console.error('保存视图模式失败:', error);
              }
            }}
            className={`flex items-center gap-1 rounded-md px-3 py-1 text-xs font-medium transition-colors ${
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
                  {viewMode === 'process' && item.processPath && iconMap[item.processPath] ? (
                    <img
                      src={iconMap[item.processPath]}
                      alt={item.name}
                      className="h-5 w-5 rounded"
                    />
                  ) : viewMode === 'process' ? (
                    <span className="text-base">{getProcessIcon(item.name)}</span>
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

