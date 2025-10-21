'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityLogIcon,
  BarChartIcon,
  DownloadIcon,
  PlayIcon,
  ReloadIcon,
  StopIcon,
  UploadIcon
} from '@radix-ui/react-icons';
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

type BannerState = {
  type: 'success' | 'error' | 'info';
  message: string;
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

const getFileName = (path?: string | null) => {
  if (!path) return '未选择配置';
  const parts = path.split(/[/\\]/);
  const name = parts[parts.length - 1];
  return name || path;
};

const resolveElectron = () => {
  if (typeof window === 'undefined') return undefined;
  return window.electronAPI;
};

export default function Dashboard() {
  const [isRunning, setIsRunning] = useState(false);
  const [proxyEnabled, setProxyEnabled] = useState(false);
  const [tunEnabled, setTunEnabled] = useState(false);
  const [isProxyUpdating, setIsProxyUpdating] = useState(false);
  const [isTunUpdating, setIsTunUpdating] = useState(false);
  const [isServiceBusy, setIsServiceBusy] = useState(false);
  const [activeConfig, setActiveConfig] = useState<string | null>(null);
  const [preferredConfig, setPreferredConfig] = useState<string | null>(null);
  const [currentNode, setCurrentNode] = useState<string>('DIRECT');
  const [primaryProxyGroup, setPrimaryProxyGroup] = useState<string>('PROXY');
  const [connectionCount, setConnectionCount] = useState(0);
  const [totalUpload, setTotalUpload] = useState(0);
  const [totalDownload, setTotalDownload] = useState(0);
  const [upSpeed, setUpSpeed] = useState(0);
  const [downSpeed, setDownSpeed] = useState(0);
  const [trafficSamples, setTrafficSamples] = useState<TrafficSample[]>([]);
  const [banner, setBanner] = useState<BannerState | null>(null);
  const [tunConfirmOpen, setTunConfirmOpen] = useState(false);
  
  const electron = useMemo(resolveElectron, []);

  const hydrateConnections = useCallback((snapshot: ConnectionsSnapshot | null | undefined) => {
    if (!snapshot) return;
    if (typeof snapshot.activeConnections === 'number') {
      setConnectionCount(snapshot.activeConnections);
    }
    if (typeof snapshot.downloadTotal === 'number') {
      setTotalDownload(snapshot.downloadTotal);
    }
    if (typeof snapshot.uploadTotal === 'number') {
      setTotalUpload(snapshot.uploadTotal);
    }
    if (snapshot.currentNode) {
      setCurrentNode(snapshot.currentNode);
    }
  }, []);

  const syncCurrentNode = useCallback(async () => {
    if (!electron) return;
    try {
      let nextNode: string | null = null;

      if (electron.requestMihomoAPI) {
        const candidateGroups = Array.from(new Set([primaryProxyGroup, 'PROXY', 'GLOBAL'].filter(Boolean)));
        for (const groupName of candidateGroups) {
          if (nextNode) break;
          try {
            const response = await electron.requestMihomoAPI(`/proxies/${encodeURIComponent(groupName)}`);
            const payload: any = response?.data ?? response;
            if (payload && typeof payload.now === 'string' && payload.now.length > 0) {
              nextNode = payload.now;
            }
          } catch {}
        }

        if (!nextNode) {
          try {
            const listResponse = await electron.requestMihomoAPI('/proxies');
            const listPayload: any = listResponse?.data ?? listResponse;
            const proxyNow = listPayload?.proxies?.PROXY?.now;
            const globalNow = listPayload?.proxies?.GLOBAL?.now;
            if (typeof proxyNow === 'string' && proxyNow.length > 0) {
              nextNode = proxyNow;
            } else if (typeof globalNow === 'string' && globalNow.length > 0) {
              nextNode = globalNow;
            }
          } catch {}
        }
      }

      if (!nextNode && electron.fetchConnectionsInfo) {
        try {
          const snapshot = await electron.fetchConnectionsInfo();
          if (snapshot?.currentNode && typeof snapshot.currentNode === 'string') {
            nextNode = snapshot.currentNode;
            hydrateConnections(snapshot);
          }
        } catch {}
      }

      if (nextNode) {
        setCurrentNode((prev) => {
          if (nextNode && nextNode !== prev) {
            try {
              electron.notifyNodeChanged?.(nextNode);
            } catch {}
          }
          return nextNode;
        });
      }
    } catch {}
  }, [electron, hydrateConnections, primaryProxyGroup]);

  const showBanner = (payload: BannerState | null) => {
    setBanner(payload);
  };

  const refreshProxyStatus = useCallback(async () => {
    try {
      const latest = await electron?.getProxyStatus?.();
      if (typeof latest === 'boolean') {
        setProxyEnabled(latest);
      }
    } catch {}
  }, [electron]);

  const refreshTunStatus = useCallback(async () => {
    try {
      const latest = await electron?.getTunStatus?.();
      if (typeof latest === 'boolean') {
        setTunEnabled(latest);
      }
    } catch {}
  }, [electron]);

  useEffect(() => {
    if (!electron) return;
    let cancelled = false;

    const bootstrap = async () => {
      try {
        const status = await electron.getProxyStatus?.();
        if (!cancelled && typeof status === 'boolean') {
          setProxyEnabled(status);
        }
      } catch {}

      try {
        const tunStatus = await electron.getTunStatus?.();
        if (!cancelled && typeof tunStatus === 'boolean') {
          setTunEnabled(tunStatus);
        }
      } catch {}

      try {
        const config = await electron.getActiveConfig?.();
        if (!cancelled) {
          if (typeof config === 'string' && config.length > 0) {
            setActiveConfig(config);
            setPreferredConfig(config);
            setIsRunning(true);
            await syncCurrentNode();
          } else {
            setIsRunning(false);
          }
        }
      } catch {}

      try {
        const subs = await electron.getSubscriptions?.();
        if (!cancelled && Array.isArray(subs) && subs.length > 0) {
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
          const groupName = order.data.proxyGroups[0]?.name;
          if (typeof groupName === 'string' && groupName.length > 0) {
            setPrimaryProxyGroup(groupName);
          }
        }
      } catch {}

      try {
        const snapshot = await electron.fetchConnectionsInfo?.();
        if (!cancelled) {
          hydrateConnections(snapshot);
        }
      } catch {}
    };

    bootstrap();

    return () => {
      cancelled = true;
    };
  }, [electron, hydrateConnections, syncCurrentNode]);

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
          setTrafficSamples((prev) => {
            const last = prev[prev.length - 1];
            const sample: TrafficSample = {
              timestamp: sampleTimestamp,
              upSpeed: Number.isFinite(payload.upSpeed) ? payload.upSpeed : last?.upSpeed ?? 0,
              downSpeed: Number.isFinite(payload.downSpeed) ? payload.downSpeed : last?.downSpeed ?? 0
            };
            const next = [...prev, sample];
            return next.length > 120 ? next.slice(next.length - 120) : next;
          });

          try {
            const snapshot = await electron.fetchConnectionsInfo?.();
            if (!disposed) {
              hydrateConnections(snapshot);
            }
          } catch {}
        }
      } catch {}
    };

    run();
    const timer = window.setInterval(run, 1500);

    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [electron, hydrateConnections]);

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

    electron.onConnectionsUpdate(handler);

    return () => {
      electron.removeAllListeners?.('connections-update');
    };
  }, [electron, hydrateConnections]);

  useEffect(() => {
    if (!electron?.onNodeChanged) return;

    const handler = (payload: { nodeName?: string }) => {
      if (payload?.nodeName) {
        setCurrentNode(payload.nodeName);
      }
    };

    electron.onNodeChanged(handler);

    return () => {
      electron.removeAllListeners?.('node-changed');
    };
  }, [electron]);

  useEffect(() => {
    if (!electron || !isRunning) return;
    syncCurrentNode();
  }, [electron, isRunning, activeConfig, syncCurrentNode]);

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
      const subs = await electron?.getSubscriptions?.();
      if (Array.isArray(subs) && subs.length > 0) {
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
    if (!electron?.startMihomo) return;
    if (isServiceBusy) return;
    setIsServiceBusy(true);
    showBanner(null);
    try {
      const config = await resolveConfigForLaunch();
      if (!config) {
        showBanner({ type: 'error', message: '未找到可用的配置文件，请先在订阅管理中导入配置' });
        return;
      }
      const result = await electron.startMihomo(config);
      if (result) {
        setIsRunning(true);
        setActiveConfig(config);
        setPreferredConfig(config);
        showBanner({ type: 'success', message: 'Mihomo 服务已启动' });
        try {
          const order = await electron.getConfigOrder?.();
          if (order?.success && Array.isArray(order.data?.proxyGroups) && order.data.proxyGroups.length > 0) {
            const groupName = order.data.proxyGroups[0]?.name;
            if (typeof groupName === 'string' && groupName.length > 0) {
              setPrimaryProxyGroup(groupName);
            }
          }
        } catch {}
        const snapshot = await electron.fetchConnectionsInfo?.();
        hydrateConnections(snapshot);
        await syncCurrentNode();
      } else {
        showBanner({ type: 'error', message: '启动服务失败' });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showBanner({ type: 'error', message: `启动失败: ${message}` });
    } finally {
      setIsServiceBusy(false);
    }
  };

  const handleStop = async () => {
    if (!electron?.stopMihomo) return;
    if (isServiceBusy) return;
    setIsServiceBusy(true);
    showBanner(null);
    try {
      const result = await electron.stopMihomo();
      if (result) {
        setIsRunning(false);
        setCurrentNode('DIRECT');
        setTrafficSamples([]);
        showBanner({ type: 'info', message: '服务已停止' });
      } else {
        showBanner({ type: 'error', message: '服务已处于停止状态' });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showBanner({ type: 'error', message: `停止失败: ${message}` });
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
    if (!electron?.toggleSystemProxy) return;
    if (isProxyUpdating) return;
    setIsProxyUpdating(true);
    showBanner(null);
    try {
      const result = await electron.toggleSystemProxy(value);
      const success =
        typeof result === 'boolean'
          ? result
          : result === undefined
          ? value
          : result === null
          ? value
          : (typeof result === 'object' && 'success' in result) ? Boolean(result.success) : true;

      if (!success) {
        const message =
          typeof result === 'object' && 'error' in result && result.error
            ? result.error
            : '切换系统代理失败';
        showBanner({ type: 'error', message });
        await refreshProxyStatus();
        return;
      }

      await refreshProxyStatus();
      showBanner({ type: 'success', message: `系统代理已${value ? '启用' : '关闭'}` });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showBanner({ type: 'error', message: `切换系统代理失败: ${message}` });
    } finally {
      setIsProxyUpdating(false);
    }
  };

  const runTunToggle = async (value: boolean) => {
    if (!electron?.toggleTunMode) {
      showBanner({ type: 'error', message: '当前环境不支持 TUN 模式' });
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
          : result === undefined
          ? value
          : result === null
          ? value
          : (typeof result === 'object' && 'success' in result) ? Boolean(result.success) : true;

      if (!success) {
        const message =
          typeof result === 'object' && 'error' in result && result.error
            ? result.error
            : '切换 TUN 模式失败';
        showBanner({ type: 'error', message });
        await refreshTunStatus();
        return;
      }

      await refreshTunStatus();
      showBanner({ type: 'success', message: `TUN 模式已${value ? '启用' : '关闭'}` });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showBanner({ type: 'error', message: `切换 TUN 模式失败: ${message}` });
    } finally {
      setIsTunUpdating(false);
    }
  };

  const handleTunToggle = (value: boolean) => {
    if (!electron?.toggleTunMode) {
      showBanner({ type: 'error', message: '当前环境不支持 TUN 模式' });
      return;
    }
    if (isTunUpdating) return;
    if (value) {
      setTunConfirmOpen(true);
      return;
    }
    runTunToggle(false);
  };

  const metrics = [
    {
      label: '活跃连接',
      value: connectionCount.toString(),
      helper: isRunning ? '实时连接数' : '服务未运行',
      icon: <ActivityLogIcon className="h-4 w-4 text-primary" />
    },
    {
      label: '下载速度',
      value: formatSpeed(downSpeed),
      helper: `总计 ${formatBytes(totalDownload, 2)}`,
      icon: <DownloadIcon className="h-4 w-4 text-blue-500" />
    },
    {
      label: '上传速度',
      value: formatSpeed(upSpeed),
      helper: `总计 ${formatBytes(totalUpload, 2)}`,
      icon: <UploadIcon className="h-4 w-4 text-emerald-500" />
    },
    {
      label: '总流量',
      value: formatBytes(totalUpload + totalDownload, 2),
      helper: `当前节点 ${currentNode || '未选择'}`,
      icon: <BarChartIcon className="h-4 w-4 text-violet-500" />
    }
  ];

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">控制面板</h1>
          <p className="mt-1 text-sm text-muted-foreground">查看内核运行情况并快速调整常用开关</p>
        </div>
        <div className="flex flex-col items-start gap-2 md:items-end">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                'rounded-full px-2.5 py-1 text-xs font-medium',
                isRunning ? 'bg-emerald-500 text-white' : 'bg-slate-200 text-slate-700'
              )}
            >
              {isRunning ? '运行中' : '未运行'}
            </span>
            <span className="rounded-full border border-slate-200 px-2.5 py-1 text-xs text-muted-foreground dark:border-slate-700">
              {getFileName(activeConfig || preferredConfig)}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="primary" onClick={handleStart} disabled={isServiceBusy || isRunning}>
              <PlayIcon className="mr-1 h-3.5 w-3.5" /> 启动
            </Button>
            <Button size="sm" variant="outline" onClick={handleStop} disabled={isServiceBusy || !isRunning}>
              <StopIcon className="mr-1 h-3.5 w-3.5" /> 停止
            </Button>
            <Button size="sm" variant="ghost" onClick={handleRestart} disabled={isServiceBusy || !isRunning}>
              <ReloadIcon className="mr-1 h-3.5 w-3.5" /> 重启
            </Button>
          </div>
        </div>
      </div>

      {banner && (
        <div
          className={cn(
            'rounded-xl border px-4 py-3 text-sm shadow-sm',
            banner.type === 'success' && 'border-emerald-200 bg-emerald-50 text-emerald-700',
            banner.type === 'error' && 'border-rose-200 bg-rose-50 text-rose-600',
            banner.type === 'info' && 'border-slate-200 bg-slate-50 text-slate-600'
          )}
        >
          {banner.message}
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <MetricCardList metrics={metrics} />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card data-hoverable="false" className="flex items-center justify-between rounded-3xl bg-white px-6 py-4 shadow-sm dark:bg-[#2a2a2a]">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">系统代理</p>
            <p className="mt-1 text-sm text-muted-foreground">切换操作系统级代理开关</p>
          </div>
          <Switch
            checked={proxyEnabled}
            disabled={isProxyUpdating}
            onCheckedChange={handleProxyToggle}
          />
        </Card>

        <Card data-hoverable="false" className="flex items-center justify-between rounded-3xl bg-white px-6 py-4 shadow-sm dark:bg-[#2a2a2a]">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">TUN 模式</p>
            <p className="mt-1 text-sm text-muted-foreground">增强路由模式，需管理员权限</p>
          </div>
          <Switch
            checked={tunEnabled}
            disabled={isTunUpdating || !electron?.toggleTunMode}
            onCheckedChange={handleTunToggle}
          />
        </Card>
      </div>

      <div className="space-y-5 rounded-3xl bg-white p-6 shadow-sm dark:bg-[#2a2a2a]">
        <TrafficChart samples={trafficSamples} />
      </div>

      <Dialog open={tunConfirmOpen} onOpenChange={setTunConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>启用 TUN 模式</DialogTitle>
            <DialogDescription>
              TUN 模式需要系统权限并会尝试重启内核，确认继续开启吗？
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setTunConfirmOpen(false)}
            >
              再考虑一下
            </Button>
            <Button
              type="button"
              onClick={async () => {
                setTunConfirmOpen(false);
                await runTunToggle(true);
              }}
            >
              确认启用
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

function TrafficChart({ samples }: { samples: TrafficSample[] }) {
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
        等待流量数据...
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* 图例和峰值 */}
      <div className="flex items-center justify-between px-2">
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-slate-500 dark:text-slate-400">峰值</span>
          <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
            {formatSpeed(chart.peak * 1024)}
          </span>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5">
            <div className="h-2 w-2 rounded-full bg-gradient-to-r from-emerald-400 to-teal-500"></div>
            <span className="text-xs text-slate-600 dark:text-slate-400">上传</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="h-2 w-2 rounded-full bg-gradient-to-r from-indigo-500 to-violet-500"></div>
            <span className="text-xs text-slate-600 dark:text-slate-400">下载</span>
          </div>
        </div>
      </div>

      {/* 图表 */}
      <div className="relative h-48 w-full overflow-hidden rounded-xl bg-gradient-to-b from-white via-slate-50 to-white dark:from-slate-900 dark:via-slate-900/80 dark:to-slate-900">
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
