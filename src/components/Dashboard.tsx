'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityLogIcon,
  BarChartIcon,
  DownloadIcon,
  GlobeIcon,
  MixerHorizontalIcon,
  PlayIcon,
  ReloadIcon,
  StopIcon,
  UploadIcon,
  ExitIcon
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
import { CustomizableDashboard } from '@/components/CustomizableDashboard';
import { Settings2, Plus, RotateCcw, Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useThemeColor } from '@/hooks/useThemeColor';

type ProxyMode = 'rule' | 'global' | 'direct';

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

const GROUP_PROXY_TYPE_REGEX = /(selector|test|fallback|balance|relay|chain|auto|lazy|switch)/i;
const KNOWN_GROUPS = new Set(['PROXY', 'GLOBAL', 'AUTO']);
const KNOWN_BUILTINS = new Set(['DIRECT', 'REJECT', 'PASS']);
const isLikelyGroupOrBuiltin = (name: string) => {
  const upper = String(name || '').toUpperCase();
  return KNOWN_GROUPS.has(upper) || KNOWN_BUILTINS.has(upper);
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

const loadConfigIcon = async (configPath: string | null): Promise<string | null> => {
  if (!configPath || !window.electronAPI) return null;

  try {
    const subs = await window.electronAPI.getSubscriptions();
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

export default function Dashboard() {
  const { t } = useTranslation();
  const themeColor = useThemeColor();

  // 从sessionStorage初始化运行状态，避免闪烁
  const [isRunning, setIsRunning] = useState(() => {
    if (typeof window === 'undefined') return false;
    try {
      const cached = sessionStorage.getItem('mihomoRunningState');
      return cached === 'true';
    } catch {
      return false;
    }
  });
  const [proxyEnabled, setProxyEnabled] = useState(false);
  const [tunEnabled, setTunEnabled] = useState(false);
  const [proxyMode, setProxyMode] = useState<ProxyMode | null>(null);
  const [isModeUpdating, setIsModeUpdating] = useState(false);
  const [isProxyUpdating, setIsProxyUpdating] = useState(false);
  const [isTunUpdating, setIsTunUpdating] = useState(false);
  const [isServiceBusy, setIsServiceBusy] = useState(false);
  const [activeConfig, setActiveConfig] = useState<string | null>(null);
  const [preferredConfig, setPreferredConfig] = useState<string | null>(null);
  const [activeConfigIcon, setActiveConfigIcon] = useState<string | null>(null);
  const [currentNode, setCurrentNode] = useState<string>('');
  const [primaryProxyGroup, setPrimaryProxyGroup] = useState<string>('PROXY');
  const [connectionCount, setConnectionCount] = useState(0);
  const [totalUpload, setTotalUpload] = useState(0);
  const [totalDownload, setTotalDownload] = useState(0);
  const [upSpeed, setUpSpeed] = useState(0);
  const [downSpeed, setDownSpeed] = useState(0);
  const [trafficSamples, setTrafficSamples] = useState<TrafficSample[]>([]);
  const [banner, setBanner] = useState<BannerState | null>(null);
  const [tunConfirmOpen, setTunConfirmOpen] = useState(false);
  const [hasAdminPermission, setHasAdminPermission] = useState(true);
  const [isEditMode, setIsEditMode] = useState(false);
  const [showAddCardDialog, setShowAddCardDialog] = useState(false);
  const [connections, setConnections] = useState<any[]>([]);
  const [uploadTotal, setUploadTotal] = useState(0);
  const [downloadTotal, setDownloadTotal] = useState(0);

  const electron = useMemo(resolveElectron, []);
  const platformFlags = useMemo(() => {
    if (typeof navigator === 'undefined') {
      return { isWindows: false, isMac: false, isLinux: false };
    }
    const ua = navigator.userAgent || '';
    const platform = (navigator.userAgentData?.platform || navigator.platform || '').toLowerCase();
    const isWindows = /windows/i.test(ua) || /win/.test(platform);
    const isMac = /macintosh|mac os x/i.test(ua) || /mac/.test(platform);
    const isLinux = /linux/i.test(ua) || (!isWindows && /linux/.test(platform));
    return { isWindows, isMac, isLinux };
  }, []);
  const { isWindows: isWindowsPlatform, isMac: isMacPlatform, isLinux: isLinuxPlatform } = platformFlags;

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

  const getProxiesSnapshot = useCallback(
    async (force = false): Promise<Record<string, any>> => {
      if (!electron?.requestMihomoAPI) {
        return {};
      }

      const now = Date.now();
      const snapshot = proxiesSnapshotRef.current;
      if (!force && snapshot.data && now - snapshot.timestamp < 1500) {
        return snapshot.data;
      }

      try {
        const response = await electron.requestMihomoAPI('/proxies');
        const payload: any = response?.data ?? response;
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
    [electron]
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

      if (!electron?.requestMihomoAPI) {
        return start;
      }

      const snapshot = await getProxiesSnapshot(options?.forceRefresh === true);
      const visited = new Set<string>();

      const ensureDetail = async (name: string) => {
        const normalized = name.trim();
        if (!normalized) return null;

        let info = snapshot[normalized];
        if (!info) {
          try {
            const response = await electron.requestMihomoAPI(`/proxies/${encodeURIComponent(normalized)}`);
            const payload: any = response?.data ?? response;
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

      const isGroupInfo = (info: any) => {
        if (!info || typeof info !== 'object') return false;
        const type = typeof info.type === 'string' ? info.type : '';
        if (GROUP_PROXY_TYPE_REGEX.test(type)) return true;
        if (Array.isArray(info.all) || Array.isArray(info.proxies)) return true;
        if (Array.isArray(info.history)) return true;
        return false;
      };

      const traverse = async (name: string): Promise<string> => {
        const normalized = name.trim();
        if (!normalized) return normalized;
        if (visited.has(normalized)) return normalized;
        visited.add(normalized);

        const info = await ensureDetail(normalized);
        if (!info) return normalized;

        const next = typeof info.now === 'string' ? info.now.trim() : '';
        if (next && next !== normalized && isGroupInfo(info)) {
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
    [electron, getProxiesSnapshot]
  );

  const commitCurrentNode = useCallback(
    (value: string) => {
      const trimmed = value.trim();
      setCurrentNode((prev) => {
        if (trimmed && trimmed !== prev) {
          try {
            electron?.notifyNodeChanged?.(trimmed);
          } catch {}
        }
        return trimmed;
      });
    },
    [electron]
  );

  const updateCurrentNodeDisplay = useCallback(
    (rawNodeName?: string | null, fallbackGroup?: string, options?: { forceRefresh?: boolean }) => {
      const base = typeof rawNodeName === 'string' ? rawNodeName.trim() : '';
      const fallback = typeof fallbackGroup === 'string' ? fallbackGroup.trim() : '';

      if (!electron?.requestMihomoAPI) {
        if (base && !isLikelyGroupOrBuiltin(base)) {
          commitCurrentNode(base);
        } else if (fallback && !isLikelyGroupOrBuiltin(fallback)) {
          commitCurrentNode(fallback);
        }
        return;
      }

      if (!base && !fallback) {
        return;
      }

      void (async () => {
        const resolved = await resolveEffectiveNode(base || null, fallback || undefined, options);
        if (resolved && resolved.length > 0) {
          commitCurrentNode(resolved);
        } else if (base && !isLikelyGroupOrBuiltin(base)) {
          commitCurrentNode(base);
        } else if (fallback && !isLikelyGroupOrBuiltin(fallback)) {
          commitCurrentNode(fallback);
        }
      })();
    },
    [commitCurrentNode, electron, resolveEffectiveNode]
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
      icon: <MixerHorizontalIcon className="h-[14px] w-[14px]" />
    },
    {
      key: 'global',
      label: MODE_LABELS.global,
      icon: <GlobeIcon className="h-[14px] w-[14px]" />
    },
    {
      key: 'direct',
      label: MODE_LABELS.direct,
      icon: <ExitIcon className="h-[14px] w-[14px]" />
    }
  ];

  const hydrateConnections = useCallback(
    (snapshot: ConnectionsSnapshot | null | undefined) => {
      if (!snapshot) return;
      if (typeof snapshot.activeConnections === 'number') {
        setConnectionCount(snapshot.activeConnections);
      }
      if (typeof snapshot.downloadTotal === 'number') {
        setTotalDownload(snapshot.downloadTotal);
        setDownloadTotal(snapshot.downloadTotal);
      }
      if (typeof snapshot.uploadTotal === 'number') {
        setTotalUpload(snapshot.uploadTotal);
        setUploadTotal(snapshot.uploadTotal);
      }
      if (snapshot.currentNode) {
        updateCurrentNodeDisplay(snapshot.currentNode, primaryProxyGroup);
      }
    },
    [primaryProxyGroup, updateCurrentNodeDisplay]
  );

  const syncCurrentNode = useCallback(async () => {
    if (!electron || !isRunning) return;
    try {
      await getProxiesSnapshot(true);
      if (!proxiesSnapshotRef.current.data) {
        proxiesSnapshotRef.current.data = {};
      }

      const snapshotCache = proxiesSnapshotRef.current.data;
      // 只使用实际存在的代理组，不使用硬编码的 PROXY 和 GLOBAL
      const allCandidates = [primaryProxyGroup, 'PROXY', 'GLOBAL'].filter(Boolean);
      const candidateGroups = allCandidates.filter(groupName =>
        snapshotCache && typeof snapshotCache[groupName] !== 'undefined'
      );

      // 如果没有找到任何候选组，使用主代理组
      if (candidateGroups.length === 0 && primaryProxyGroup) {
        candidateGroups.push(primaryProxyGroup);
      }

      let resolvedNode: string | null = null;

      if (electron.requestMihomoAPI) {
        for (const groupName of candidateGroups) {
          if (resolvedNode) break;
          try {
            const response = await electron.requestMihomoAPI(`/proxies/${encodeURIComponent(groupName)}`);
            const payload: any = response?.data ?? response;
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
              if (finalNode && finalNode.length > 0) {
                resolvedNode = finalNode;
              }
            }
          } catch {}
        }
      }

      if (!resolvedNode) {
        for (const groupName of candidateGroups) {
          const finalNode = await resolveEffectiveNode(null, groupName);
          if (finalNode && finalNode.length > 0) {
            resolvedNode = finalNode;
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
              if (finalNode && finalNode.length > 0) {
                resolvedNode = finalNode;
              }
            }
          }
        } catch {}
      }

      if (resolvedNode && !isLikelyGroupOrBuiltin(resolvedNode) && !candidateGroups.includes(resolvedNode)) {
        commitCurrentNode(resolvedNode);
      } else {
        // 不提交分组/内置名称，稍后重试一次解析
        setTimeout(() => {
          // 仅当仍在运行时重试
          if (electron && isRunning) {
            syncCurrentNode();
          }
        }, 800);
      }
    } catch (error) {
      console.error('Failed to sync current node:', error);
    }
  }, [commitCurrentNode, electron, getProxiesSnapshot, hydrateConnections, isRunning, primaryProxyGroup, resolveEffectiveNode]);

  const fetchProxyMode = useCallback(async (): Promise<ProxyMode | null> => {
    if (!electron?.requestMihomoAPI) return null;
    try {
      const response = await electron.requestMihomoAPI('/configs');
      const payload: any = response?.data ?? response;
      const modeValue = typeof payload?.mode === 'string' ? payload.mode.toLowerCase() : null;
      if (modeValue === 'rule' || modeValue === 'global' || modeValue === 'direct') {
        return modeValue as ProxyMode;
      }
    } catch {}
    return null;
  }, [electron]);

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
    if (!electron?.onTunStatus) return;
    const unsubscribe = electron.onTunStatus((enabled: boolean) => {
      setTunEnabled(Boolean(enabled));
    });
    return () => {
      if (typeof unsubscribe === 'function') {
        unsubscribe();
      }
    };
  }, [electron]);

  // 保存运行状态到sessionStorage，避免页面刷新时闪烁
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      sessionStorage.setItem('mihomoRunningState', isRunning.toString());
    } catch {}
  }, [isRunning]);

  useEffect(() => {
    if (!electron) return;
    let cancelled = false;
    let retryTimeoutId: NodeJS.Timeout | null = null;

    const bootstrap = async (retryCount = 0) => {
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
        if (!cancelled && typeof config === 'string' && config.length > 0) {
          setActiveConfig(config);
          setPreferredConfig(config);
          const iconPath = await loadConfigIcon(config);
          setActiveConfigIcon(iconPath);
        }

        try {
          const running = await electron.isMihomoRunning?.();
          console.log('[Dashboard bootstrap] isMihomoRunning result:', running);
          if (!cancelled) {
            if (running) {
              console.log('[Dashboard bootstrap] Setting isRunning = true');
              setIsRunning(true);
              await syncCurrentNode();
              await syncProxyMode();
            } else {
              console.log('[Dashboard bootstrap] Setting isRunning = false');
              setIsRunning(false);
            }
          }
        } catch (error) {
          console.log('[Dashboard bootstrap] isMihomoRunning failed, setting isRunning = false', error);
          setIsRunning(false);
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
          const availableGroups = order.data.proxyGroups.filter((g: any) => g?.hidden !== true);
          const groupName = availableGroups[0]?.name;
          if (typeof groupName === 'string' && groupName.length > 0) {
            setPrimaryProxyGroup(groupName);
            // 立刻尝试解析一次，避免初渲染显示组名
            updateCurrentNodeDisplay(undefined, groupName, { forceRefresh: true });
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
        if (data.configPath) {
          setActiveConfig(data.configPath);
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
  }, [electron, fetchProxyMode, hydrateConnections, syncCurrentNode, syncProxyMode]);

  // 周期性同步当前激活配置，避免在配置页面切换后 Dashboard 仍显示旧配置
  useEffect(() => {
    if (!electron?.getActiveConfig) return;
    let disposed = false;

    const syncActiveConfig = async () => {
      try {
        const config = await electron.getActiveConfig?.();
        if (!disposed && typeof config === 'string' && config.length > 0) {
          setActiveConfig(config);
          const iconPath = await loadConfigIcon(config);
          setActiveConfigIcon(iconPath);
        }
      } catch {
        // 忽略同步失败，避免影响其它功能
      }
    };

    // 立即同步一次
    syncActiveConfig();
    const timer = window.setInterval(syncActiveConfig, 5000);

    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [electron]);

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
        updateCurrentNodeDisplay(payload.nodeName, primaryProxyGroup, { forceRefresh: true });
      } else {
        updateCurrentNodeDisplay(undefined, primaryProxyGroup, { forceRefresh: true });
      }
    };

    electron.onNodeChanged(handler);

    return () => {
      electron.removeAllListeners?.('node-changed');
    };
  }, [electron, primaryProxyGroup, updateCurrentNodeDisplay]);

  useEffect(() => {
    if (!electron || !isRunning) return;
    syncCurrentNode();
    syncProxyMode();
  }, [electron, isRunning, activeConfig, primaryProxyGroup, syncCurrentNode, syncProxyMode]);

  // 获取连接列表
  useEffect(() => {
    if (!electron?.requestMihomoAPI || !isRunning) return;
    let disposed = false;

    const fetchConnections = async () => {
      try {
        const response = await electron.requestMihomoAPI('/connections');
        if (!disposed && response?.data) {
          const data = response.data;
          if (data.connections && Array.isArray(data.connections)) {
            setConnections(data.connections);
          }
          if (typeof data.uploadTotal === 'number') {
            setUploadTotal(data.uploadTotal);
          }
          if (typeof data.downloadTotal === 'number') {
            setDownloadTotal(data.downloadTotal);
          }
        }
      } catch (error) {
        console.error('获取连接列表失败:', error);
      }
    };

    fetchConnections();
    const timer = window.setInterval(fetchConnections, 2000);

    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [electron, isRunning]);

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
        showBanner({ type: 'error', message: t('dashboard.noConfigAvailable') });
        return;
      }
      const result = await electron.startMihomo(config);
      const success = typeof result === 'object' ? (result as any).success !== false : Boolean(result);

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
            const availableGroups = order.data.proxyGroups.filter((g: any) => g?.hidden !== true);
            const groupName = availableGroups[0]?.name;
            if (typeof groupName === 'string' && groupName.length > 0) {
              setPrimaryProxyGroup(groupName);
              // 主代理组确定后尝试立即解析一次
              updateCurrentNodeDisplay(undefined, groupName, { forceRefresh: true });
            }
          }
        } catch {}
        const snapshot = await electron.fetchConnectionsInfo?.();
        hydrateConnections(snapshot);
        await syncCurrentNode();
        await syncProxyMode();
      } else {
        showBanner({ type: 'error', message: t('dashboard.startFailed') });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showBanner({ type: 'error', message: t('dashboard.startFailedWithError', { message }) });
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
      const success = typeof result === 'object' ? (result as any).success !== false : Boolean(result);

      if (success) {
        setIsRunning(false);
        commitCurrentNode('');
        setTrafficSamples([]);
        // 停止服务时自动关闭TUN模式
        if (tunEnabled) {
          setTunEnabled(false);
        }
        showBanner({ type: 'info', message: t('dashboard.serviceStopped') });
      } else {
        showBanner({ type: 'error', message: t('dashboard.serviceAlreadyStopped') });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
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
            : t('dashboard.toggleSystemProxyFailed');
        showBanner({ type: 'error', message });
        await refreshProxyStatus();
        return;
      }

      // 立即更新状态
      setProxyEnabled(value);
      showBanner({ type: 'success', message: t('dashboard.systemProxyToggled', { status: value ? t('dashboard.enabled') : t('dashboard.disabled') }) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showBanner({ type: 'error', message: t('dashboard.toggleSystemProxyFailedWithError', { message }) });
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
          : result === undefined
          ? value
          : result === null
          ? value
          : (typeof result === 'object' && 'success' in result) ? Boolean(result.success) : true;

      if (!success) {
        const message =
          typeof result === 'object' && 'error' in result && result.error
            ? result.error
            : t('dashboard.toggleTunModeFailed');
        showBanner({ type: 'error', message });
        await refreshTunStatus();
        return;
      }

      // 立即更新状态
      setTunEnabled(value);
      showBanner({ type: 'success', message: t('dashboard.tunModeToggled', { status: value ? t('dashboard.enabled') : t('dashboard.disabled') }) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showBanner({ type: 'error', message: t('dashboard.toggleTunModeFailedWithError', { message }) });
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
          const serviceStatus = await electron.getTunServiceStatus?.();
          console.log('[Dashboard] Service status:', serviceStatus);

          if (serviceStatus?.running) {
            // 服务正在运行，直接启用 TUN 模式
            console.log('[Dashboard] Service is running, directly enabling TUN mode');
            await runTunToggle(true);
            return;
          } else if (serviceStatus?.installed) {
            // 服务已安装但未运行，提示用户启动服务
            showBanner({ type: 'warning', message: 'TUN 服务未运行，请在 TUN 设置页面启动服务' });
            // 刷新 TUN 状态确保与后端同步
            await refreshTunStatus();
            return;
          } else {
            // 服务未安装，提示用户安装服务
            showBanner({ type: 'warning', message: 'TUN 服务未安装，请在 TUN 设置页面安装服务' });
            // 刷新 TUN 状态确保与后端同步
            await refreshTunStatus();
            return;
          }
        } else {
          // 计划任务模式：检查计划任务
          const hasTask = await electron.checkElevateTask?.() || false;
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
        const hasTask = await electron.checkElevateTask();
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
          showBanner({ type: 'info', message: '正在请求授权，请输入管理员密码...' });

          try {
            const authResult = await electron.grantTunPermissions();
            if (authResult.success) {
              showBanner({ type: 'success', message: 'TUN 模式权限已成功授予，正在启用...' });
              // 授权成功，自动开启 TUN 模式
              await runTunToggle(true);
            } else {
              showBanner({ type: 'error', message: authResult.error || '授权失败' });
            }
          } catch (error) {
            console.error('Failed to grant TUN permissions:', error);
            showBanner({ type: 'error', message: '授权失败，请重试' });
          }
        } else {
          // 已有权限，直接启用 TUN，不显示任何对话框
          console.log('[Dashboard] ✓ Has permission, directly enabling TUN mode (no dialog)');
          await runTunToggle(true);
        }
      } catch (error) {
        console.error('Failed to check core permission:', error);
        showBanner({ type: 'error', message: '权限检查失败' });
      }
      return;
    }

    // 其他平台，直接启用
    console.log('[Dashboard] Other platform, directly enabling TUN mode');
    await runTunToggle(true);
  };

  const handleModeSwitch = useCallback(
    async (nextMode: ProxyMode) => {
      if (!electron?.requestMihomoAPI) {
        showBanner({ type: 'error', message: t('dashboard.proxyModeNotSupported') });
        return;
      }
      if (isModeUpdating || proxyMode === nextMode) {
        return;
      }
      setIsModeUpdating(true);
      showBanner(null);
      try {
        const response = await electron.requestMihomoAPI('/configs', {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ mode: nextMode })
        });

        const success =
          typeof response?.ok === 'boolean'
            ? response.ok
            : typeof response?.status === 'number'
            ? response.status >= 200 && response.status < 300
            : true;

        if (!success) {
          const errorDetail =
            typeof response?.data === 'string'
              ? response.data
              : response?.data?.message || response?.statusText || t('dashboard.toggleTunModeFailed');
          throw new Error(errorDetail);
        }

        setProxyMode(nextMode);
        showBanner({ type: 'success', message: t('dashboard.switchedToMode', { mode: MODE_LABELS[nextMode] }) });
        await syncCurrentNode();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        showBanner({ type: 'error', message: t('dashboard.switchProxyModeFailed', { message }) });
        await syncProxyMode();
      } finally {
        setIsModeUpdating(false);
      }
    },
    [electron, isModeUpdating, proxyMode, showBanner, syncCurrentNode, syncProxyMode]
  );

  const metrics = [
    {
      label: t('dashboard.activeConnections'),
      value: connectionCount.toString(),
      helper: isRunning ? t('dashboard.realtimeConnections') : t('dashboard.serviceNotRunning'),
      icon: <ActivityLogIcon className="h-4 w-4 text-primary" />
    },
    {
      label: t('dashboard.downloadSpeed'),
      value: formatSpeed(downSpeed),
      helper: `${t('dashboard.total')} ${formatBytes(totalDownload, 2)}`,
      icon: <DownloadIcon className="h-4 w-4 text-blue-500" />
    },
    {
      label: t('dashboard.uploadSpeed'),
      value: formatSpeed(upSpeed),
      helper: `${t('dashboard.total')} ${formatBytes(totalUpload, 2)}`,
      icon: <UploadIcon className="h-4 w-4 text-emerald-500" />
    },
    {
      label: t('dashboard.totalTraffic'),
      value: formatBytes(totalUpload + totalDownload, 2),
      helper: `${t('dashboard.currentNode')} ${currentNode || t('dashboard.notSelected')}`,
      icon: <BarChartIcon className="h-4 w-4 text-violet-500" />
    }
  ];

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
                isRunning ? 'bg-emerald-500 text-white' : 'bg-slate-200 text-slate-700'
              )}
            >
              {isRunning ? t('dashboard.running') : t('dashboard.notRunning')}
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
                  disabled={isServiceBusy}
                >
                  {isRunning ? (
                    <>
                      <StopIcon className="mr-1 h-3.5 w-3.5" /> {t('dashboard.stop')}
                    </>
                  ) : (
                    <>
                      <PlayIcon className="mr-1 h-3.5 w-3.5" /> {t('dashboard.start')}
                    </>
                  )}
                </Button>
                <Button size="sm" variant="ghost" onClick={handleRestart} disabled={isServiceBusy || !isRunning}>
                  <ReloadIcon className="mr-1 h-3.5 w-3.5" /> {t('dashboard.restart')}
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
                  onClick={() => {
                    if (confirm(t('dashboard.confirmReset'))) {
                      localStorage.removeItem('flyClash-dashboard-config');
                      window.location.reload();
                    }
                  }}
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
            'rounded-xl border px-4 py-3 text-sm shadow-sm transition-all duration-300 animate-in slide-in-from-top-2',
            banner.type === 'success' && 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-900/20 dark:text-emerald-400',
            banner.type === 'error' && 'border-rose-200 bg-rose-50 text-rose-600 dark:border-rose-800 dark:bg-rose-900/20 dark:text-rose-400',
            banner.type === 'info' && 'border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-800/20 dark:text-slate-300'
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
          if (confirm(t('dashboard.confirmReset'))) {
            localStorage.removeItem('flyClash-dashboard-config');
            window.location.reload();
          }
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
                      if (result.success) {
                        if (result.needRestart) {
                          showBanner({ type: 'info', message: '正在重启应用以获取管理员权限...' });
                        } else {
                          showBanner({ type: 'success', message: 'TUN 模式权限已成功授予，正在启用...' });
                          // 刷新权限状态
                          if (electron.checkElevateTask) {
                            const hasTask = await electron.checkElevateTask();
                            setHasAdminPermission(hasTask);
                          } else if (electron.checkCorePermission) {
                            const check = await electron.checkCorePermission();
                            setHasAdminPermission(!!check?.hasPermission);
                          }
                          // 授权成功后自动启用 TUN 模式
                          await runTunToggle(true);
                        }
                      } else {
                        showBanner({ type: 'error', message: result.error || '授权失败' });
                      }
                    }
                  } catch (error) {
                    console.error('Failed to grant TUN permissions:', error);
                    showBanner({ type: 'error', message: '授权失败，请重试' });
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
                授权
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
