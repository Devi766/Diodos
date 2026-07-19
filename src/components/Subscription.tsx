import React, { useState, useEffect, useRef, useCallback } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as Toast from '@radix-ui/react-toast';
import { Cross2Icon, PlusIcon, TrashIcon, GlobeIcon, Pencil1Icon, ReloadIcon, ExternalLinkIcon, UploadIcon, CheckIcon, PlayIcon, DragHandleDots2Icon, MixerHorizontalIcon } from '@radix-ui/react-icons';
import axios from 'axios';
import Link from 'next/link';
import CloudOutlineIcon from '@/components/icons/CloudOutlineIcon';
import { useProviderAvailability } from '@/hooks/use-provider-availability';
import { useTranslation } from 'react-i18next';
import ConfigEditor from '@/components/ConfigEditor';
import {
  hasSubscriptionsCache,
  readActiveConfigCache,
  readSubscriptionsCache,
  toArrayValue,
  useActiveConfigCache,
  useSubscriptionsCache,
  writeActiveConfigCache,
  writeSubscriptionsCache,
} from '@/services/app-data-hooks';

type Subscription = {
  name: string;
  path: string;
  url?: string | null;
  // 配置信息字段
  usedTraffic?: string | null;
  remainingTraffic?: string | null;
  expiryDate?: string | null;
  lastUpdated?: string | number | null;
  // 新增：排序索引
  order?: number;
  // 新增：自定义图标URL (原始URL)
  iconUrl?: string | null;
  // 新增：缓存的图标路径 (data URL)
  cachedIconPath?: string | null;
};

const toArray = <T,>(value: unknown): T[] => toArrayValue<T>(value);

type SaveSubscriptionResultLike =
  | string
  | null
  | undefined
  | {
      success?: boolean;
      filePath?: string | null;
      path?: string | null;
      error?: string;
      message?: string;
      data?: {
        filePath?: string | null;
        path?: string | null;
        error?: string;
        message?: string;
      } | null;
    };

const normalizeSaveSubscriptionResult = (result: SaveSubscriptionResultLike): { success: boolean; filePath?: string; error?: string } => {
  if (typeof result === 'string') {
    const filePath = result.trim();
    return filePath ? { success: true, filePath } : { success: false, error: '保存订阅失败' };
  }

  if (!result || typeof result !== 'object') {
    return { success: false, error: '保存订阅失败' };
  }

  const nested = result.data && typeof result.data === 'object' ? result.data : null;
  const filePath = result.filePath?.trim() || result.path?.trim() || nested?.filePath?.trim() || nested?.path?.trim();
  const error = result.error || result.message || nested?.error || nested?.message || '保存订阅失败';

  if (result.success === false) {
    return { success: false, error };
  }

  return filePath ? { success: true, filePath } : { success: false, error };
};

const TAURI_RUNTIME_UNAVAILABLE = 'Tauri runtime is not available';

const formatSubscriptionError = (error: unknown, fallback = '操作失败') => {
  const message = error instanceof Error ? error.message : (error ? String(error) : fallback);
  return message.includes(TAURI_RUNTIME_UNAVAILABLE) ? '订阅 API 不可用' : message;
};

const formatSubscriptionLastUpdated = (value?: string | number | null): string => {
  if (value === null || value === undefined) return '';
  const raw = String(value).trim();
  if (!raw || raw === '0') return '';

  const numericValue = typeof value === 'number' || /^-?\d+(\.\d+)?$/.test(raw)
    ? Number(raw)
    : Number.NaN;

  let date: Date | null = null;
  if (Number.isFinite(numericValue) && numericValue > 0) {
    let millis = numericValue;
    if (millis < 1_000_000_000_000) {
      millis *= 1000;
    } else if (millis > 1_000_000_000_000_000) {
      millis = Math.floor(millis / 1000);
    }
    date = new Date(millis);
  } else {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) {
      date = parsed;
    }
  }

  if (!date || Number.isNaN(date.getTime())) return raw;

  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
};

const hasElectronMethod = <K extends string>(api: unknown, method: K): api is Record<K, (...args: any[]) => Promise<any>> => {
  try {
    return !!api && typeof (api as Record<string, unknown>)[method] === 'function';
  } catch {
    return false;
  }
};

type CompatResultLike = boolean | {
  success?: boolean;
  error?: string;
  message?: string;
  statusText?: string;
  runtimeReload?: RuntimeReloadResult | null;
  data?: { message?: string; error?: string } | string | null;
} | null | undefined;

type RuntimeReloadResult = {
  reloaded?: boolean;
  skipped?: boolean;
  error?: string;
  result?: CompatResultLike;
} | null | undefined;

type SwitchConfigOptions = {
  startIfStopped?: boolean;
  suppressSuccessToast?: boolean;
};

type SubscriptionProfileUpdateDetail = {
  source?: string;
  action?: string;
  filePath?: string | null;
  activeConfig?: string | null;
  runtimeReload?: RuntimeReloadResult;
  reason?: HighlightReason;
};

const compatSuccess = (result: CompatResultLike) => (
  result && typeof result === 'object'
    ? result.success === true
    : Boolean(result)
);

const compatError = (result: CompatResultLike, fallback: string) => (
  result && typeof result === 'object'
    ? formatSubscriptionError(
      result.error ||
      result.message ||
      result.statusText ||
      (typeof result.data === 'string' ? result.data : result.data?.message || result.data?.error),
      fallback
    )
    : fallback
);

const activeConfigPath = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const path = value.trim();
  return path ? path : null;
};

const activeConfigEventPath = (value: unknown): string | null => {
  if (value && typeof value === 'object' && 'activeConfig' in value) {
    return activeConfigPath((value as { activeConfig?: unknown }).activeConfig);
  }

  return activeConfigPath(value);
};

const runtimeReloadState = (result: { runtimeReload?: RuntimeReloadResult } | null | undefined): boolean | undefined => {
  const runtimeReload = result?.runtimeReload;
  if (!runtimeReload || typeof runtimeReload !== 'object') return undefined;
  if (runtimeReload.reloaded === true) return true;
  if (runtimeReload.skipped === true) return false;
  return undefined;
};

const runtimeReloadFromResult = (result: unknown): RuntimeReloadResult => {
  if (!result || typeof result !== 'object' || !('runtimeReload' in result)) {
    return undefined;
  }
  return (result as { runtimeReload?: RuntimeReloadResult }).runtimeReload;
};

const isRemoteSubscriptionUrl = (url?: string | null): boolean => {
  const value = url?.trim();
  return !!value && !value.toLowerCase().startsWith('local:');
};

const normalizeSubscriptionPath = (value?: string | null): string => {
  return (value || '').trim().replace(/\\/g, '/').toLowerCase();
};

const findSubscriptionByPath = (items: Subscription[] | null | undefined, filePath?: string | null): Subscription | undefined => {
  const normalized = normalizeSubscriptionPath(filePath);
  if (!normalized) return undefined;
  return (items || []).find((item) => normalizeSubscriptionPath(item.path) === normalized);
};

type HighlightReason = 'added' | 'imported' | 'updated' | 'edited' | 'failed';

const highlightLabelKey = (reason: HighlightReason | null) => {
  switch (reason) {
    case 'added':
      return 'subscriptions.justAdded';
    case 'imported':
      return 'subscriptions.justImported';
    case 'edited':
      return 'subscriptions.justEdited';
    case 'failed':
      return 'subscriptions.justFailed';
    case 'updated':
    default:
      return 'subscriptions.justUpdated';
  }
};

const highlightCardClass = (highlighted: boolean, reason: HighlightReason | null) => {
  if (!highlighted) return '';
  return reason === 'failed'
    ? 'ring-2 ring-red-500/45 bg-red-50/70 dark:bg-red-950/20'
    : 'ring-2 ring-primary/45 bg-primary/5 dark:bg-primary/10';
};

const highlightBadgeClass = (reason: HighlightReason | null) => {
  return reason === 'failed'
    ? 'bg-red-600 text-white'
    : 'bg-primary text-primary-foreground';
};

// 计算流量进度百分比
const calculateProgressPercentage = (usedTraffic: string | null, remainingTraffic: string | null): number => {
  if (!usedTraffic || !remainingTraffic) return 0;
  
  try {
    // 提取数字和单位（GB、MB等）
    // 支持多种格式: "10.5GB", "10.5 GB", "10.5 G", "10.5"
    const usedMatch = usedTraffic.match(/^([\d.]+)\s*([KMGT]i?B?)?$/i);
    const remainingMatch = remainingTraffic.match(/^([\d.]+)\s*([KMGT]i?B?)?$/i);
    
    if (!usedMatch || !remainingMatch) {
      console.log('无法解析流量字符串格式:', usedTraffic, remainingTraffic);
      return 50; // 默认值
    }
    
    const used = parseFloat(usedMatch[1]);
    const remaining = parseFloat(remainingMatch[1]);
    
    // 标准化单位
    const normalizeUnit = (unit: string | undefined): string => {
      if (!unit) return 'B';
      // 处理多种写法: G, GB, GiB 转为标准形式
      const match = unit.toUpperCase().match(/([KMGT])/i);
      return match ? match[1] + 'B' : 'B';
    };
    
    const usedUnit = normalizeUnit(usedMatch[2]);
    const remainingUnit = normalizeUnit(remainingMatch[2]);
    
    // 如果单位相同
    if (usedUnit === remainingUnit) {
      const total = used + remaining;
      return total > 0 ? Math.min(100, Math.max(0, (used / total) * 100)) : 0;
    }
    
    // 单位不同时的转换 (按最小单位计算)
    const unitMultiplier: Record<string, number> = {
      'B': 1,
      'KB': 1024,
      'MB': 1024 * 1024,
      'GB': 1024 * 1024 * 1024,
      'TB': 1024 * 1024 * 1024 * 1024
    };
    
    const usedBytes = used * (unitMultiplier[usedUnit] || 1);
    const remainingBytes = remaining * (unitMultiplier[remainingUnit] || 1);
    
    const totalBytes = usedBytes + remainingBytes;
    // 确保返回值在0-100之间
    return totalBytes > 0 ? Math.min(100, Math.max(0, (usedBytes / totalBytes) * 100)) : 0;
  } catch (e) {
    console.error('计算流量进度条出错:', e);
    return 50;
  }
};

// 判断是否即将到期（30天内）
const isExpiringSoon = (expiryDate: string | null): boolean => {
  if (!expiryDate) return false;
  
  try {
    // 常见的日期格式
    // 1. 2023/01/01
    // 2. 2023-01-01
    // 3. 01/01/2023
    // 4. 01-01-2023
    // 5. 01.01.2023
    // 6. Jan 1, 2023
    
    let expiry: Date;
    
    // 尝试检测日期格式并解析
    if (/^\d{4}[-/\.]\d{1,2}[-/\.]\d{1,2}$/.test(expiryDate)) {
      // YYYY-MM-DD 或 YYYY/MM/DD 或 YYYY.MM.DD
      expiry = new Date(expiryDate);
    } else if (/^\d{1,2}[-/\.]\d{1,2}[-/\.]\d{4}$/.test(expiryDate)) {
      // DD-MM-YYYY 或 MM-DD-YYYY 格式
      const parts = expiryDate.split(/[-/\.]/);
      // 假设MM-DD-YYYY格式（美式）
      expiry = new Date(`${parts[2]}-${parts[0]}-${parts[1]}`);
      
      // 如果日期无效且第一部分≤12，尝试DD-MM-YYYY格式（欧式）
      if (isNaN(expiry.getTime()) && parseInt(parts[0]) <= 12) {
        expiry = new Date(`${parts[2]}-${parts[1]}-${parts[0]}`);
      }
    } else {
      // 尝试标准解析
      expiry = new Date(expiryDate);
    }
    
    // 验证日期的有效性
    if (isNaN(expiry.getTime())) {
      console.warn('无法解析日期:', expiryDate);
      return false;
    }
    
    const now = new Date();
    
    // 计算距离到期还有多少天
    const daysDiff = Math.floor((expiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    
    return daysDiff >= 0 && daysDiff <= 30;
  } catch (e) {
    console.error('解析到期日期出错:', e);
    return false;
  }
};

// 判断流量是否较少（低于20%）
const isLowTraffic = (usedTraffic: string | null, remainingTraffic: string | null): boolean => {
  const percentage = calculateProgressPercentage(usedTraffic, remainingTraffic);
  return percentage > 80; // 已用超过80%
};

// 获取进度条颜色类
const getProgressColorClass = (usedTraffic: string | null, remainingTraffic: string | null): string => {
  if (!usedTraffic || !remainingTraffic) return 'bg-blue-500';
  
  const isLow = isLowTraffic(usedTraffic, remainingTraffic);
  if (isLow) {
    return 'bg-red-500';
  }
  return 'bg-blue-500';
};

// 格式化流量信息显示（添加图标和颜色）
const getTrafficInfo = (subscription: Subscription) => {
  const { usedTraffic, remainingTraffic } = subscription;
  
  // 确保类型是 string | null
  const usedTrafficValue: string | null = usedTraffic || null;
  const remainingTrafficValue: string | null = remainingTraffic || null;
  
  // 低流量警告
  const isLow = remainingTrafficValue && usedTrafficValue ? 
    isLowTraffic(usedTrafficValue, remainingTrafficValue) : false;
  
  return {
    usedColorClass: 'text-gray-500 dark:text-gray-400 font-medium',
    remainingColorClass: 'text-gray-500 dark:text-gray-400 font-medium',
    progressColorClass: getProgressColorClass(usedTrafficValue, remainingTrafficValue),
    progress: calculateProgressPercentage(usedTrafficValue, remainingTrafficValue),
    isLow
  };
};

export default function SubscriptionManager() {
  const { t } = useTranslation();
  // 初始化时直接从共享缓存加载，避免切页闪烁
  const cachedSubscriptions = useSubscriptionsCache<Subscription>();
  const cachedActiveConfig = useActiveConfigCache();
  const [subscriptions, setSubscriptions] = useState<Subscription[]>(() => {
    const cached = readSubscriptionsCache<Subscription>();
    if (cached.length > 0) {
      console.log('从共享缓存加载了订阅数据:', cached.length);
      return cached;
    }
    return [];
  });
  const [isSubscriptionsLoading, setIsSubscriptionsLoading] = useState(() => {
    if (typeof window === 'undefined') return true;
    return !hasSubscriptionsCache();
  });
  const [subUrl, setSubUrl] = useState('');
  const [subName, setSubName] = useState('');
  const [addSubmitMode, setAddSubmitMode] = useState<'save' | 'activate' | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [selectedSub, setSelectedSub] = useState<Subscription | null>(null);
  const [toastOpen, setToastOpen] = useState(false);
  const [toastTitle, setToastTitle] = useState('');
  const [toastDescription, setToastDescription] = useState('');
  const [toastType, setToastType] = useState<'success' | 'error'>('success');
  const toastTimerRef = useRef<number | null>(null);
  const [updatingSubPath, setUpdatingSubPath] = useState<string | null>(null);
  const [highlightedSubPath, setHighlightedSubPath] = useState<string | null>(null);
  const [highlightedSubPaths, setHighlightedSubPaths] = useState<string[]>([]);
  const [highlightedSubReason, setHighlightedSubReason] = useState<HighlightReason | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // 当前活跃的配置文件路径：优先共享缓存，避免切页闪烁
  const [activeConfig, setActiveConfig] = useState<string | null>(() => readActiveConfigCache());
  // 新增: 是否正在切换配置
  const [switchingConfig, setSwitchingConfig] = useState<string | null>(null);
  // 新增: 服务运行状态
  const [isServiceRunning, setIsServiceRunning] = useState<boolean>(false);
  
  // 拖拽相关状态
  const [draggedItem, setDraggedItem] = useState<Subscription | null>(null);
  const [dragOverItem, setDragOverItem] = useState<Subscription | null>(null);
  const [isDraggingCard, setIsDraggingCard] = useState(false);
  const [longPressTimer, setLongPressTimer] = useState<NodeJS.Timeout | null>(null);
  const [dragStartPos, setDragStartPos] = useState<{ x: number; y: number } | null>(null);
  const [dragPreviewPos, setDragPreviewPos] = useState<{ x: number; y: number } | null>(null);

  // 右键菜单相关状态
  const [contextMenuPosition, setContextMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const [contextMenuSub, setContextMenuSub] = useState<Subscription | null>(null);

  // 编辑对话框相关状态
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [editingSub, setEditingSub] = useState<Subscription | null>(null);
  const [editingName, setEditingName] = useState('');
  const [editingUrl, setEditingUrl] = useState('');
  const [editingIconUrl, setEditingIconUrl] = useState('');
  const [editingOverrides, setEditingOverrides] = useState<string[]>([]);
  const [availableOverrides, setAvailableOverrides] = useState<any[]>([]);
  const [editingUpdateInterval, setEditingUpdateInterval] = useState<number>(0);

  // 可视化编辑对话框相关状态
  const [isVisualEditDialogOpen, setIsVisualEditDialogOpen] = useState(false);
  const [visualEditingSub, setVisualEditingSub] = useState<Subscription | null>(null);

  // 元素引用，用于滚动到视图中
  const draggedItemRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<{ dragged: Subscription | null; target: Subscription | null }>({ dragged: null, target: null });
  const { hasProviders, refreshProvidersAvailability } = useProviderAvailability();

  const updateActiveConfig = useCallback((value: string | null) => {
    setActiveConfig((prev) => (prev === value ? prev : value));
    // Only write when value actually changes to avoid cache notify loops.
    if (readActiveConfigCache() !== value) {
      writeActiveConfigCache(value);
    }
  }, []);

  useEffect(() => {
    setSubscriptions((prev) => (prev === cachedSubscriptions ? prev : cachedSubscriptions));
    if (hasSubscriptionsCache()) {
      setIsSubscriptionsLoading(false);
    }
  }, [cachedSubscriptions]);

  useEffect(() => {
    setActiveConfig((prev) => (prev === cachedActiveConfig ? prev : cachedActiveConfig));
  }, [cachedActiveConfig]);

  const highlightSubscriptions = useCallback((paths: Array<string | null | undefined>, reason: HighlightReason) => {
    const uniquePaths = Array.from(
      new Map(
        paths
          .map((path) => path?.trim())
          .filter((path): path is string => !!path)
          .map((path) => [normalizeSubscriptionPath(path), path])
      ).values()
    );

    setHighlightedSubPaths(uniquePaths);
    setHighlightedSubPath(uniquePaths[0] || null);
    setHighlightedSubReason(uniquePaths.length > 0 ? reason : null);
  }, []);

  const isHighlightedSubscription = useCallback((path: string) => {
    const normalized = normalizeSubscriptionPath(path);
    return highlightedSubPaths.some((highlighted) => normalizeSubscriptionPath(highlighted) === normalized);
  }, [highlightedSubPaths]);

  useEffect(() => {
    loadSubscriptions();
    loadActiveConfig();
    loadAvailableOverrides();

    // 设置定期刷新活跃配置的计时器
    const intervalId = setInterval(loadActiveConfig, 5000);
    let externalRefreshTimer: number | null = null;
    const refreshAfterExternalProfileChange = () => {
      if (externalRefreshTimer !== null) {
        window.clearTimeout(externalRefreshTimer);
      }

      externalRefreshTimer = window.setTimeout(() => {
        externalRefreshTimer = null;
        loadSubscriptions();
        loadActiveConfig();
        loadAvailableOverrides();
      }, 120);
    };
    
    // 监听配置导入事件
    let unsubscribeImport: (() => void) | undefined;
    let unsubscribeAutoUpdated: (() => void) | undefined;
    let unsubscribeAutoUpdateFailed: (() => void) | undefined;
    let unsubscribeActiveConfig: (() => void) | undefined;
    const handleSubscriptionAdded = (event: Event) => {
      const detail = event instanceof CustomEvent ? event.detail : undefined;
      const filePath = detail?.filePath;

      loadSubscriptions().then((items) => {
        const added = findSubscriptionByPath(items, filePath);
        if (added) {
          highlightSubscriptions([added.path], 'added');
          setSelectedSub(added);
        }
      });
      loadActiveConfig();
      loadAvailableOverrides();
      refreshProvidersAvailability();
    };

    if (window.electronAPI?.onImportSubscription) {
      console.log('设置配置导入事件监听器');
      unsubscribeImport = window.electronAPI.onImportSubscription((url: string) => {
        console.log('收到配置导入请求，URL:', url);
        if (url && url.trim() !== '') {
          console.log('准备导入配置，设置URL并打开对话框');
          // 设置配置URL并自动打开配置添加对话框
          setSubUrl(url);
          setIsDialogOpen(true);
        } else {
          console.log('收到的配置URL为空');
        }
      });
    } else {
      console.log('onImportSubscription API不可用');
    }

    if (window.electronAPI?.onSubscriptionAutoUpdated) {
      unsubscribeAutoUpdated = window.electronAPI.onSubscriptionAutoUpdated((data) => {
        const filePath = data?.filePath;
        loadSubscriptions().then((items) => {
          const updated = findSubscriptionByPath(items, filePath);
          if (updated) {
            highlightSubscriptions([updated.path], 'updated');
            setSelectedSub(updated);
          }
        });
        loadActiveConfig();
        notifyProfileUpdated({
          action: 'subscription-auto-updated',
          filePath,
          runtimeReload: data?.result?.runtimeReload,
        });
      });
    }

    if (window.electronAPI?.onSubscriptionAutoUpdateFailed) {
      unsubscribeAutoUpdateFailed = window.electronAPI.onSubscriptionAutoUpdateFailed((data) => {
        const filePath = data?.filePath;
        loadSubscriptions().then((items) => {
          const failed = findSubscriptionByPath(items, filePath);
          if (failed) {
            highlightSubscriptions([failed.path], 'failed');
            setSelectedSub(failed);
          }
        });
        loadActiveConfig();
      });
    }

    if (window.electronAPI?.onActiveConfigChanged) {
      unsubscribeActiveConfig = window.electronAPI.onActiveConfigChanged((configPath) => {
        const nextActiveConfig = activeConfigEventPath(configPath);
        updateActiveConfig(nextActiveConfig);
        refreshProvidersAvailability();
        notifyProfileUpdated({
          action: 'active-config-changed',
          activeConfig: nextActiveConfig,
        });
      });
    }

    window.addEventListener('profile-updated', refreshAfterExternalProfileChange);
    window.addEventListener('backup-restored', refreshAfterExternalProfileChange);
    window.addEventListener('subscription-auto-updated', refreshAfterExternalProfileChange);
    window.addEventListener('subscription-added', handleSubscriptionAdded);

    return () => {
      clearInterval(intervalId);
      if (externalRefreshTimer !== null) window.clearTimeout(externalRefreshTimer);
      window.removeEventListener('profile-updated', refreshAfterExternalProfileChange);
      window.removeEventListener('backup-restored', refreshAfterExternalProfileChange);
      window.removeEventListener('subscription-auto-updated', refreshAfterExternalProfileChange);
      window.removeEventListener('subscription-added', handleSubscriptionAdded);
      if (unsubscribeImport) unsubscribeImport();
      if (unsubscribeAutoUpdated) unsubscribeAutoUpdated();
      if (unsubscribeAutoUpdateFailed) unsubscribeAutoUpdateFailed();
      if (unsubscribeActiveConfig) unsubscribeActiveConfig();
    };
  }, [highlightSubscriptions]);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current !== null) {
        window.clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!highlightedSubPath) return;

    const element = document.querySelector(`[data-subscription-path="${CSS.escape(highlightedSubPath)}"]`);
    element?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    const timer = window.setTimeout(() => {
      setHighlightedSubPath(null);
      setHighlightedSubPaths([]);
      setHighlightedSubReason(null);
    }, 3200);

    return () => window.clearTimeout(timer);
  }, [highlightedSubPath]);

  // 监听点击外部关闭右键菜单
  useEffect(() => {
    const handleClickOutside = () => {
      if (contextMenuPosition) {
        closeContextMenu();
      }
    };

    if (contextMenuPosition) {
      document.addEventListener('click', handleClickOutside);
      return () => document.removeEventListener('click', handleClickOutside);
    }
  }, [contextMenuPosition]);

  // 新增: 加载当前活跃的配置
  const loadActiveConfig = async () => {
    const api = window.electronAPI;
    if (!hasElectronMethod(api, 'getActiveConfig')) {
      updateActiveConfig(null);
      setIsServiceRunning(false);
      return;
    }

    try {
      // 获取用户选择的配置（独立于服务运行状态）
      const config = await api.getActiveConfig();
      const nextActiveConfig = activeConfigPath(config);
      updateActiveConfig(nextActiveConfig);

      // 检查服务实际运行状态
      try {
        const runningResult = hasElectronMethod(api, 'isMihomoRunning')
          ? await api.isMihomoRunning()
          : false;
        const running = typeof runningResult === 'boolean' ? runningResult : false;
        setIsServiceRunning(!!running);
      } catch {
        setIsServiceRunning(false);
      }

      refreshProvidersAvailability();
    } catch (error) {
      console.error('获取当前配置失败:', error);
      showToast('错误', `获取当前配置失败: ${formatSubscriptionError(error)}`, 'error');
    }
  };
  
  // 新增: 切换使用的配置文件
  const switchConfig = async (configPath: string, options: SwitchConfigOptions = {}): Promise<boolean> => {
    const api = window.electronAPI;
    if (!api) {
      showToast('错误', '订阅 API 不可用', 'error');
      return false;
    }

    // 如果当前配置已经是这个，不需要切换
    if (activeConfig === configPath) {
      if (!options.suppressSuccessToast) {
        showToast('提示', '该配置文件已经处于激活状态', 'success');
      }
      return true;
    }

    setSwitchingConfig(configPath);

    try{
      let result;
      let failureNotified = false;

      // 检查服务是否正在运行
      if (isServiceRunning) {
        if (!hasElectronMethod(api, 'reloadMihomoConfig')) {
          showToast('错误', '配置热重载 API 不可用', 'error');
          return false;
        }

        // 如果服务正在运行，使用热重载
        console.log('使用热重载切换配置...');
        result = await api.reloadMihomoConfig(configPath);

        const reloadSuccess = compatSuccess(result);

        if (reloadSuccess) {
          updateActiveConfig(configPath);
        } else {
          // 热重载失败，回退到重启方式
          console.warn('热重载失败，尝试重启服务...');
          if (!hasElectronMethod(api, 'stopMihomo') || !hasElectronMethod(api, 'startMihomo')) {
            showToast('错误', `配置热重载失败: ${compatError(result, '切换配置文件失败')}`, 'error');
            return false;
          }

          const stopResult = await api.stopMihomo();
          const stopSuccess = compatSuccess(stopResult);

          if (!stopSuccess) {
            showToast('错误', `停止当前服务失败，无法切换配置: ${compatError(stopResult, '停止当前服务失败')}`, 'error');
            setSwitchingConfig(null);
            return false;
          }

          await new Promise(resolve => setTimeout(resolve, 500));
          const startResult = await api.startMihomo(configPath);
          const startSuccess = compatSuccess(startResult);

          result = startResult;

          if (startSuccess) {
            updateActiveConfig(configPath);
          }
        }
      } else {
        if (!hasElectronMethod(api, 'setPreferredConfig')) {
          showToast('错误', '设置首选配置 API 不可用', 'error');
          return false;
        }

        // 服务未运行，只设置为首选配置，不自动启动服务
        console.log('服务未运行，设置为首选配置...');
        result = await api.setPreferredConfig(configPath);
        const preferredSuccess = compatSuccess(result);

        if (preferredSuccess) {
          updateActiveConfig(configPath);
          if (options.startIfStopped) {
            if (!hasElectronMethod(api, 'startMihomo')) {
              result = { success: false, error: '启动内核 API 不可用' };
              showToast('错误', '已设置为首选配置，但启动内核 API 不可用', 'error');
              failureNotified = true;
            } else {
              const startResult = await api.startMihomo(configPath);
              const startSuccess = compatSuccess(startResult);
              result = startResult;
              if (startSuccess) {
                setIsServiceRunning(true);
                if (!options.suppressSuccessToast) {
                  showToast(t('common.success'), t('subscriptions.activateAndStartSuccess'), 'success');
                }
              } else {
                showToast(
                  t('common.error'),
                  t('subscriptions.activateStartFailed', {
                    error: compatError(startResult, t('subscriptions.startMihomoFailed'))
                  }),
                  'error'
                );
                failureNotified = true;
              }
            }
          } else if (!options.suppressSuccessToast) {
            showToast('成功', '已设置为首选配置，下次启动服务时将使用此配置', 'success');
          }
        } else {
          showToast('错误', `设置首选配置失败: ${compatError(result, '设置首选配置失败')}`, 'error');
          failureNotified = true;
        }
      }

      const finalSuccess = compatSuccess(result);

      if (finalSuccess) {
        // 通知代理页面刷新
        notifyProfileUpdated({
          action: 'switch-config',
          filePath: configPath,
          activeConfig: configPath,
          runtimeReload: runtimeReloadFromResult(result),
        });

        // 只在服务运行时才需要等待节点信息
        if (isServiceRunning || options.startIfStopped) {
          // 关键修改：等待服务完全启动后获取节点信息
          setTimeout(async () => {
            try {
              // 获取最新节点状态
              if (hasElectronMethod(api, 'getProxies')) {
                // 使用getProxies方法获取节点状态而不是getCurrentNode
                const proxies = await api.getProxies();
                if (proxies && proxies.groups) {
                  // 找到当前选中的节点
                  const selectedNodeName =
                    typeof proxies.selected === 'string' && proxies.selected
                      ? proxies.selected
                      : (proxies.groups as any[])
                          .map((group: any) => group?.now)
                          .find((name: unknown) => typeof name === 'string' && name.length > 0);

                  if (selectedNodeName) {
                    console.log('当前节点已更新为:', selectedNodeName);

                    // 通知其他组件配置已切换 - 使用已有的notifyNodeChanged方法
                    if (hasElectronMethod(api, 'notifyNodeChanged')) {
                      await api.notifyNodeChanged(selectedNodeName);
                    }
                  }
                }
                // 服务就绪后再次通知代理页面刷新
                notifyProfileUpdated({
                  action: 'switch-config-ready',
                  filePath: configPath,
                  activeConfig: configPath,
                });
              }
            } catch (error) {
              console.error('获取节点信息失败:', error);
            }
          }, 2000); // 等待2秒让服务完全启动
        }
      } else if (!failureNotified) {
        showToast('错误', `切换配置文件失败: ${compatError(result, '切换配置文件失败')}`, 'error');
      }

      return finalSuccess;
    } catch (error) {
      console.error('切换配置文件失败:', error);
      showToast('错误', `切换配置文件失败: ${formatSubscriptionError(error)}`, 'error');
      return false;
    } finally {
      setSwitchingConfig(null);
      loadActiveConfig(); // 重新加载当前活跃配置
    }
  };

  const loadSubscriptions = async (): Promise<Subscription[] | null> => {
    const api = window.electronAPI;
    if (!hasElectronMethod(api, 'getSubscriptions')) {
      showToast('错误', '订阅 API 不可用', 'error');
      setIsSubscriptionsLoading(false);
      return null;
    }

    if (!hasSubscriptionsCache()) {
      setIsSubscriptionsLoading(true);
    }
    try {
      const subscriptionsResult = await api.getSubscriptions();
      if (
        subscriptionsResult &&
        typeof subscriptionsResult === 'object' &&
        (subscriptionsResult as { success?: boolean }).success === false
      ) {
        throw new Error(compatError(
          subscriptionsResult as CompatResultLike,
          '加载配置失败'
        ));
      }

      const subs = toArray<Subscription>(subscriptionsResult);
      console.log('[前端] 加载的配置数据:', subs);

      // 下载并缓存图标
      const subsWithIcons = await Promise.all(
        subs.map(async (sub) => {
          if (sub.iconUrl && window.electronAPI?.configIcon) {
            try {
              const result = await window.electronAPI.configIcon.getIcon(sub.iconUrl, sub.path);
              if (result.success && result.iconPath) {
                // 保留原始iconUrl,缓存路径存到cachedIconPath
                return { ...sub, cachedIconPath: result.iconPath };
              }
            } catch (error) {
              console.error(`下载配置图标失败 (${sub.name}):`, error);
            }
          }
          return sub;
        })
      );

      // 后端已经按照 sort_order 排序返回数据，直接使用即可
      // 不再需要从 localStorage 获取排序并重新排序
      setSubscriptions(subsWithIcons);

      // 保存到sessionStorage缓存
      try {
        writeSubscriptionsCache(subsWithIcons);
      } catch (error) {
        console.error('Failed to cache subscriptions:', error);
      }
      return subsWithIcons;
    } catch (error) {
      console.error('加载配置失败:', error);
      showToast('错误', `加载配置失败: ${formatSubscriptionError(error)}`, 'error');
      return null;
    } finally {
      setIsSubscriptionsLoading(false);
    }
  };

  const notifyProfileUpdated = (detail: SubscriptionProfileUpdateDetail = {}) => {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('profile-updated', {
        detail: {
          source: 'subscriptions',
          ...detail,
        },
      }));
    }
  };

  const getLatestActiveConfig = async (): Promise<string | null> => {
    const api = window.electronAPI;
    let currentConfig = activeConfig;

    if (hasElectronMethod(api, 'getActiveConfig')) {
      try {
        const latest = await api.getActiveConfig();
        currentConfig = activeConfigPath(latest);
      } catch {}
    }

    return activeConfigPath(currentConfig);
  };

  const syncActiveConfigAfterPathChange = async (oldPath: string, newPath: string): Promise<boolean> => {
    const api = window.electronAPI;
    const currentConfig = await getLatestActiveConfig();

    if (currentConfig === newPath) {
      updateActiveConfig(newPath);
      notifyProfileUpdated({
        action: 'subscription-path-changed',
        filePath: newPath,
        activeConfig: newPath,
      });
      return false;
    }

    if (currentConfig !== oldPath) {
      return false;
    }

    if (!hasElectronMethod(api, 'setPreferredConfig')) {
      showToast(
        t('common.error'),
        t('subscriptions.savedButActivateFailed', {
          error: t('subscriptions.setPreferredFailed')
        }),
        'error'
      );
      return false;
    }

    try {
      const result = await api.setPreferredConfig(newPath);
      if (compatSuccess(result)) {
        updateActiveConfig(newPath);
        refreshProvidersAvailability();
        notifyProfileUpdated({
          action: 'subscription-path-changed',
          filePath: newPath,
          activeConfig: newPath,
        });
        return oldPath !== newPath;
      }

      showToast(
        t('common.error'),
        t('subscriptions.savedButActivateFailed', {
          error: compatError(result, t('subscriptions.setPreferredFailed'))
        }),
        'error'
      );
    } catch (error) {
      showToast(
        t('common.error'),
        t('subscriptions.savedButActivateFailed', {
          error: formatSubscriptionError(error, t('subscriptions.setPreferredFailed'))
        }),
        'error'
      );
    }

    return false;
  };

  const reloadRuntimeConfigIfNeeded = async (filePath: string): Promise<boolean> => {
    const api = window.electronAPI;
    const currentConfig = await getLatestActiveConfig();

    if (currentConfig !== filePath) {
      return false;
    }

    let running = isServiceRunning;
    if (hasElectronMethod(api, 'isMihomoRunning')) {
      try {
        const runningResult = await api.isMihomoRunning();
        running = typeof runningResult === 'boolean' ? runningResult : false;
        setIsServiceRunning(running);
      } catch {}
    }

    if (!running) {
      return false;
    }

    if (!hasElectronMethod(api, 'reloadMihomoConfig')) {
      showToast(
        t('common.error'),
        t('subscriptions.reloadActiveConfigFailed', {
          error: t('subscriptions.reloadApiUnavailable')
        }),
        'error'
      );
      return false;
    }

    try {
      const result = await api.reloadMihomoConfig(filePath);
      if (compatSuccess(result)) {
        notifyProfileUpdated({
          action: 'reload-active-config',
          filePath,
          activeConfig: filePath,
          runtimeReload: runtimeReloadFromResult(result),
        });
        return true;
      }

      showToast(
        t('common.error'),
        t('subscriptions.reloadActiveConfigFailed', {
          error: compatError(result, t('subscriptions.reloadActiveConfigFailedFallback'))
        }),
        'error'
      );
    } catch (error) {
      showToast(
        t('common.error'),
        t('subscriptions.reloadActiveConfigFailed', {
          error: formatSubscriptionError(error, t('subscriptions.reloadActiveConfigFailedFallback'))
        }),
        'error'
      );
    }

    return false;
  };

  const revealSavedSubscription = async (
    filePath: string,
    reason: HighlightReason = 'added',
    highlightPaths: Array<string | null | undefined> = [filePath]
  ): Promise<boolean> => {
    highlightSubscriptions(highlightPaths.length > 0 ? highlightPaths : [filePath], reason);
    notifyProfileUpdated({
      action: 'subscription-visible',
      filePath,
      reason,
    });

    const api = window.electronAPI;
    if (!hasElectronMethod(api, 'setPreferredConfig')) {
      return false;
    }

    const currentConfig = await getLatestActiveConfig();

    if (currentConfig) {
      return false;
    }

    try {
      const result = await api.setPreferredConfig(filePath);
      if (compatSuccess(result)) {
        updateActiveConfig(filePath);
        refreshProvidersAvailability();
        notifyProfileUpdated({
          action: 'set-preferred-config',
          filePath,
          activeConfig: filePath,
        });
        return true;
      }

      showToast(
        t('common.error'),
        t('subscriptions.savedButActivateFailed', {
          error: compatError(result, t('subscriptions.setPreferredFailed'))
        }),
        'error'
      );
    } catch (error) {
      showToast(
        t('common.error'),
        t('subscriptions.savedButActivateFailed', {
          error: formatSubscriptionError(error, t('subscriptions.setPreferredFailed'))
        }),
        'error'
      );
    }

    return false;
  };

  // 保存排序到数据库
  const saveOrder = useCallback(async (subs: Subscription[]): Promise<boolean> => {
    try {
      const orderList: Array<{ path: string; order: number }> = [];

      subs.forEach((sub, index) => {
        orderList.push({ path: sub.path, order: index });
      });

      // 保存到数据库
      const api = window.electronAPI;
      if (!hasElectronMethod(api, 'saveSubscriptionOrder')) {
        throw new Error('订阅 API 不可用');
      }

      const result = await api.saveSubscriptionOrder(orderList);
      if (compatSuccess(result)) {
        showToast(t('common.success'), t('subscriptions.orderSaved'), 'success');
        return true;
      }

      const message = compatError(result, t('subscriptions.orderSaveFailed'));
      console.error('保存排序到数据库失败:', message);
      showToast(t('common.error'), message, 'error');
      return false;
    } catch (error) {
      console.error('保存排序信息失败:', error);
      showToast(t('common.error'), formatSubscriptionError(error, t('subscriptions.orderSaveFailed')), 'error');
      return false;
    }
  }, [t]);
  
  // 长按开始拖拽
  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>, item: Subscription) => {
    // 如果点击的是按钮,不触发拖拽
    if ((e.target as HTMLElement).closest('button')) {
      return;
    }

    const timer = setTimeout(() => {
      dragStateRef.current.dragged = item;
      dragStateRef.current.target = null;
      setDraggedItem(item);
      setIsDraggingCard(true);
      setDragStartPos({ x: e.clientX, y: e.clientY });
      setDragPreviewPos({ x: e.clientX, y: e.clientY });

      // 创建鼠标移动处理函数
      const handleMove = (moveEvent: MouseEvent) => {
        // 更新拖拽预览位置
        setDragPreviewPos({ x: moveEvent.clientX, y: moveEvent.clientY });

        // 获取鼠标下的元素
        const elementUnderMouse = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY);
        if (!elementUnderMouse) return;

        // 查找最近的配置卡片
        const card = elementUnderMouse.closest('[data-subscription-path]');
        if (card) {
          const path = card.getAttribute('data-subscription-path');
          const targetSub = subscriptions.find(sub => sub.path === path);
          if (targetSub && targetSub.path !== item.path) {
            dragStateRef.current.target = targetSub;
            setDragOverItem(targetSub);
          }
        }
      };

      // 创建鼠标释放处理函数
      const handleUp = async () => {
        // 移除全局监听
        document.removeEventListener('mousemove', handleMove);
        document.removeEventListener('mouseup', handleUp);

        // 使用 ref 中的状态执行排序
        const currentDragged = dragStateRef.current.dragged;
        const currentOver = dragStateRef.current.target;

        if (currentDragged && currentOver && currentDragged.path !== currentOver.path) {
          const previousSubscriptions = subscriptions;
          const newSubscriptions = [...previousSubscriptions];
          const draggedIndex = newSubscriptions.findIndex(sub => sub.path === currentDragged.path);
          const targetIndex = newSubscriptions.findIndex(sub => sub.path === currentOver.path);

          if (draggedIndex !== -1 && targetIndex !== -1) {
            // 移除拖拽的项并在目标位置插入
            const [draggedSub] = newSubscriptions.splice(draggedIndex, 1);
            newSubscriptions.splice(targetIndex, 0, draggedSub);
            setSubscriptions(newSubscriptions);

            // 保存失败时恢复数据库中的真实顺序，避免 UI 显示假成功
            const saved = await saveOrder(newSubscriptions);
            if (!saved) {
              const reloaded = await loadSubscriptions();
              if (!reloaded) {
                setSubscriptions(previousSubscriptions);
              }
            }
          }
        }

        // 清除拖拽状态
        setDraggedItem(null);
        setDragOverItem(null);
        setIsDraggingCard(false);
        setDragStartPos(null);
        setDragPreviewPos(null);
        dragStateRef.current.dragged = null;
        dragStateRef.current.target = null;
      };

      // 添加全局鼠标移动和释放监听
      document.addEventListener('mousemove', handleMove);
      document.addEventListener('mouseup', handleUp);
    }, 300); // 300ms 长按

    setLongPressTimer(timer);

    // 添加鼠标抬起监听,如果在长按完成前抬起,取消拖拽
    const handleMouseUp = () => {
      if (timer) {
        clearTimeout(timer);
        setLongPressTimer(null);
      }
      document.removeEventListener('mouseup', handleMouseUp);
    };
    document.addEventListener('mouseup', handleMouseUp);
  }, [loadSubscriptions, subscriptions, saveOrder]);

  const addSubscription = async (e: React.SyntheticEvent, activateAfterSave = false) => {
    e.preventDefault();
    
    console.log('开始添加订阅，URL:', subUrl);
    
    const api = window.electronAPI;
    if (!hasElectronMethod(api, 'fetchSubscription') || !hasElectronMethod(api, 'saveSubscription')) {
      showToast('错误', '订阅 API 不可用', 'error');
      console.error('订阅API不可用，无法添加订阅');
      return;
    }
    
    if (!subUrl.trim()) {
      showToast('错误', '请输入有效的订阅链接', 'error');
      console.error('订阅URL为空，取消添加');
      return;
    }

    setIsLoading(true);
    setAddSubmitMode(activateAfterSave ? 'activate' : 'save');
    console.log('正在从服务器获取订阅内容...');
    
    try {
      const configData = await api.fetchSubscription(subUrl);
      console.log('获取订阅内容结果:', configData);

      // 检查是否成功获取订阅内容
      if (configData && configData.success && configData.content) {
        const customName = subName.trim() || '';
        console.log('准备保存订阅 - URL:', subUrl);
        console.log('准备保存订阅 - 自定义名称:', customName);
        console.log('准备保存订阅 - 流量信息:', configData.subscriptionInfo);

        // 确保传递订阅信息
        const saveResult = normalizeSaveSubscriptionResult(await api.saveSubscription(
          subUrl,
          configData.content,
          customName,
          configData.subscriptionInfo
        ));

        // 检查保存是否成功
        if (saveResult.success && saveResult.filePath) {
          console.log('订阅保存成功，文件路径:', saveResult.filePath);

          // 重新加载订阅列表以显示最新信息（包括流量信息）
          const reloadedSubscriptions = await loadSubscriptions();
          setSubUrl('');
          setSubName('');
          setIsDialogOpen(false);

          if (reloadedSubscriptions) {
            const savedSubscription = findSubscriptionByPath(reloadedSubscriptions, saveResult.filePath);
            const savedPath = savedSubscription?.path || saveResult.filePath;
            if (savedSubscription) {
              setSelectedSub(savedSubscription);
            }
            if (activateAfterSave) {
              highlightSubscriptions([savedPath], 'added');
              notifyProfileUpdated();
              const activated = await switchConfig(savedPath, {
                startIfStopped: true,
                suppressSuccessToast: true
              });
              showToast(
                activated ? t('common.success') : t('common.error'),
                activated ? t('subscriptions.addAndActivateSuccess') : t('subscriptions.savedButActivateFailed', {
                  error: t('subscriptions.setPreferredFailed')
                }),
                activated ? 'success' : 'error'
              );
            } else {
              const activated = await revealSavedSubscription(savedPath);
              showToast(
                t('common.success'),
                activated ? t('subscriptions.addSuccessActivated') : t('subscriptions.addSuccess'),
                'success'
              );
            }
          } else {
            showToast('错误', '订阅已保存，但刷新列表失败，请稍后刷新页面', 'error');
          }
        } else {
          showToast('错误', saveResult.error || '保存订阅失败', 'error');
          console.error('保存订阅失败:', saveResult.error);
        }
      } else {
        const errorMsg = formatSubscriptionError(configData?.error, '获取订阅内容失败');
        showToast('错误', errorMsg, 'error');
        console.error('获取订阅内容失败:', errorMsg);
      }
    } catch (error) {
      showToast('错误', `添加订阅失败: ${formatSubscriptionError(error)}`, 'error');
      console.error('添加订阅失败:', error);
    } finally {
      setIsLoading(false);
      setAddSubmitMode(null);
    }
  };

  const deleteSubscription = async (filePath: string) => {
    const api = window.electronAPI;
    if (!hasElectronMethod(api, 'deleteSubscription')) {
      showToast('错误', '订阅 API 不可用', 'error');
      return;
    }
    
    try {
      const result = await api.deleteSubscription(filePath);
      const deleteSuccess = result && typeof result === 'object'
        ? (result as { success?: boolean }).success === true
        : Boolean(result);
      
      if (deleteSuccess) {
        showToast('成功', '订阅删除成功', 'success');
        await loadSubscriptions();
        notifyProfileUpdated();
      } else {
        const error = result && typeof result === 'object' ? (result as { error?: string }).error : undefined;
        showToast('错误', formatSubscriptionError(error, '删除订阅失败'), 'error');
      }
    } catch (error) {
      console.error('删除订阅失败:', error);
      showToast('错误', `删除订阅失败: ${formatSubscriptionError(error)}`, 'error');
    }
  };
  
  const refreshSubscription = async (filePath: string) => {
    const api = window.electronAPI;
    if (!hasElectronMethod(api, 'refreshSubscription')) {
      showToast('错误', '订阅 API 不可用', 'error');
      return;
    }

    setUpdatingSubPath(filePath);

    try {
        const result = await api.refreshSubscription(filePath);

      if (result && result.success) {
        const effectivePath = result.filePath || filePath;
        const backendReloaded = runtimeReloadState(result);
        const runtimeReloaded = backendReloaded ?? (await reloadRuntimeConfigIfNeeded(effectivePath));
        const reloadedSubscriptions = await loadSubscriptions();
        const updatedSubscription = findSubscriptionByPath(reloadedSubscriptions, effectivePath);
        if (updatedSubscription) {
          setSelectedSub(updatedSubscription);
        }
        highlightSubscriptions([updatedSubscription?.path || effectivePath], 'updated');
        notifyProfileUpdated();
        showToast(
          t('common.success'),
          runtimeReloaded ? t('subscriptions.updateSuccessReloaded') : t('subscriptions.updateSuccess'),
          'success'
        );
      } else {
        showToast('错误', formatSubscriptionError(result?.error, '更新订阅失败'), 'error');
      }
    } catch (error) {
      console.error('更新订阅失败:', error);
      showToast('错误', `更新订阅失败: ${formatSubscriptionError(error)}`, 'error');
    } finally {
      setUpdatingSubPath(null);
    }
  };

  // 批量更新所有订阅
  const [isUpdatingAll, setIsUpdatingAll] = useState(false);
  const updateAllSubscriptions = async () => {
    const api = window.electronAPI;
    if (!hasElectronMethod(api, 'refreshSubscription')) {
      showToast('错误', '订阅 API 不可用', 'error');
      return;
    }

    const activeBeforeUpdate = await getLatestActiveConfig();
    // 过滤出有URL的订阅(远程订阅)
    const remoteSubscriptions = subscriptions.filter(sub => isRemoteSubscriptionUrl(sub.url));

    if (remoteSubscriptions.length === 0) {
      showToast(t('common.info'), t('subscriptions.noRemoteSubscriptions'), 'success');
      return;
    }

    setIsUpdatingAll(true);
    let successCount = 0;
    let failCount = 0;
    let refreshedActive = false;
    let activeReloadState: boolean | undefined;
    const updatedPaths: string[] = [];

    for (const sub of remoteSubscriptions) {
      try {
        const result = await api.refreshSubscription(sub.path);
        if (result && result.success) {
          successCount++;
          const effectivePath = result.filePath || sub.path;
          updatedPaths.push(effectivePath);
          if (activeBeforeUpdate === effectivePath) {
            refreshedActive = true;
            activeReloadState = runtimeReloadState(result);
          }
        } else {
          failCount++;
        }
      } catch (error) {
        console.error(`更新订阅 ${sub.name} 失败:`, error);
        failCount++;
      }
    }

    setIsUpdatingAll(false);
    let runtimeReloaded = false;
    if (refreshedActive && activeBeforeUpdate) {
      runtimeReloaded = activeReloadState ?? (await reloadRuntimeConfigIfNeeded(activeBeforeUpdate));
    }
    const reloadedSubscriptions = await loadSubscriptions();
    if (reloadedSubscriptions && updatedPaths.length > 0) {
      const refreshedPaths = updatedPaths.map((path) => findSubscriptionByPath(reloadedSubscriptions, path)?.path || path);
      highlightSubscriptions(refreshedPaths, 'updated');
      const firstUpdated = findSubscriptionByPath(reloadedSubscriptions, refreshedPaths[0]);
      if (firstUpdated) {
        setSelectedSub(firstUpdated);
      }
    }
    notifyProfileUpdated();

    // 显示更新结果
    if (failCount === 0) {
      showToast(
        t('common.success'),
        runtimeReloaded
          ? t('subscriptions.updateAllSuccessReloaded', { count: successCount })
          : t('subscriptions.updateAllSuccess', { count: successCount }),
        'success'
      );
    } else if (successCount === 0) {
      showToast(t('common.error'), t('subscriptions.updateAllFailed', { count: failCount }), 'error');
    } else {
      showToast(t('common.success'), t('subscriptions.updateAllPartial', { success: successCount, failed: failCount }), 'success');
    }
  };

  const openConfigFile = async (filePath: string) => {
    const api = window.electronAPI;
    if (!hasElectronMethod(api, 'openFile')) {
      showToast('错误', '文件 API 不可用', 'error');
      return;
    }

    try {
      console.log('[前端] 打开文件，路径:', filePath);
      const result = await api.openFile(filePath);
      if (result?.success === false) {
        showToast('错误', formatSubscriptionError(result.error, '打开文件失败'), 'error');
      }
    } catch (error) {
      console.error('打开文件失败:', error);
      showToast('错误', `打开文件失败: ${formatSubscriptionError(error)}`, 'error');
    }
  };

  const openConfigFolder = async (filePath: string) => {
    const api = window.electronAPI;
    if (!hasElectronMethod(api, 'openFileLocation')) {
      showToast('错误', '文件 API 不可用', 'error');
      return;
    }

    try {
      const result = await api.openFileLocation(filePath);
      if (result?.success === false) {
        showToast('错误', formatSubscriptionError(result.error, '打开目录失败'), 'error');
      }
    } catch (error) {
      console.error('打开目录失败:', error);
      showToast('错误', `打开目录失败: ${formatSubscriptionError(error)}`, 'error');
    }
  };

  // 处理右键菜单
  const handleContextMenu = (e: React.MouseEvent, sub: Subscription) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenuPosition({ x: e.clientX, y: e.clientY });
    setContextMenuSub(sub);
  };

  // 关闭右键菜单
  const closeContextMenu = () => {
    setContextMenuPosition(null);
    setContextMenuSub(null);
  };

  // 加载可用的覆写列表
  const loadAvailableOverrides = async () => {
    if (!window.electronAPI?.getOverrides) return;

    try {
      const result = await window.electronAPI.getOverrides();
      if (result && typeof result === 'object' && !Array.isArray(result) && (result as { success?: boolean }).success === false) {
        throw new Error(formatSubscriptionError((result as { error?: string; message?: string }).error || (result as { message?: string }).message, '加载覆写列表失败'));
      }
      const overrides = toArray<any>(result);
      setAvailableOverrides(overrides);
    } catch (error) {
      console.error('加载覆写列表失败:', error);
      setAvailableOverrides([]);
    }
  };

  // 打开编辑对话框
  const openEditDialog = async (sub: Subscription) => {
    setEditingSub(sub);
    setEditingName(sub.name);
    setEditingIconUrl(sub.iconUrl || '');

    // 如果配置有URL,加载URL
    if (isRemoteSubscriptionUrl(sub.url)) {
      try {
        const url = await window.electronAPI?.getSubscriptionUrl?.(sub.path);
        setEditingUrl(url || '');
      } catch (error) {
        console.error('加载订阅URL失败:', error);
        setEditingUrl('');
      }
    } else {
      setEditingUrl('');
    }

    // 加载订阅的覆写设置
    try {
      const overridesResult: unknown = await window.electronAPI?.getSubscriptionOverrides?.(sub.path);
      const overridesRecord = overridesResult && typeof overridesResult === 'object'
        ? overridesResult as { success?: boolean; error?: unknown }
        : null;
      if (overridesRecord?.success === false) {
        throw new Error(formatSubscriptionError(overridesRecord.error, '加载订阅覆写失败'));
      }
      setEditingOverrides(toArray<any>(overridesResult));
    } catch (error) {
      console.error('加载订阅覆写失败:', error);
      setEditingOverrides([]);
      showToast('错误', formatSubscriptionError(error, '加载订阅覆写失败'), 'error');
    }

    // 加载订阅的自动更新间隔
    try {
      const result = await window.electronAPI?.getSubscriptionUpdateInterval?.(sub.path);
      if (result?.success === false) {
        throw new Error(formatSubscriptionError(result.error, '加载订阅更新间隔失败'));
      }
      setEditingUpdateInterval(result?.interval || 0);
    } catch (error) {
      console.error('加载订阅更新间隔失败:', error);
      setEditingUpdateInterval(0);
      showToast('错误', formatSubscriptionError(error, '加载订阅更新间隔失败'), 'error');
    }

    setIsEditDialogOpen(true);
    closeContextMenu();
  };

  // 保存编辑
  const saveEdit = async () => {
    if (!editingSub) return;

    const api = window.electronAPI;
    if (
      !hasElectronMethod(api, 'editSubscription') ||
      !hasElectronMethod(api, 'setSubscriptionOverrides') ||
      !hasElectronMethod(api, 'setSubscriptionUpdateInterval')
    ) {
      showToast('错误', '订阅 API 不可用', 'error');
      return;
    }

    try {
      setIsLoading(true);

      // 调用后端API保存编辑，获取返回的新路径
      const result = await api.editSubscription({
        oldPath: editingSub.path,
        newName: editingName,
        newUrl: editingUrl,
        iconUrl: editingIconUrl
      });

      if (result?.success === false) {
        throw new Error(formatSubscriptionError((result as { error?: string }).error, '编辑配置失败'));
      }

      // 使用后端返回的正确路径（而不是自己计算）
      const finalPath = result?.newPath || editingSub.path;

      // 保存覆写设置 - 使用后端返回的正确路径
      const overridesResult = await api.setSubscriptionOverrides(
        finalPath,
        editingOverrides
      );
      if (overridesResult?.success === false) {
        throw new Error(formatSubscriptionError((overridesResult as { error?: string }).error, '保存覆写设置失败'));
      }

      // 保存自动更新间隔 - 使用后端返回的正确路径
      const intervalResult = await api.setSubscriptionUpdateInterval(
        finalPath,
        editingUpdateInterval
      );
      if (intervalResult?.success === false) {
        throw new Error(formatSubscriptionError(intervalResult.error, '保存自动更新间隔失败'));
      }

      const activePathSynced = await syncActiveConfigAfterPathChange(editingSub.path, finalPath);
      const runtimeReloaded = await reloadRuntimeConfigIfNeeded(finalPath);
      const reloadedSubscriptions = await loadSubscriptions();
      if (reloadedSubscriptions) {
        const editedSubscription = findSubscriptionByPath(reloadedSubscriptions, finalPath);
        if (editedSubscription) {
          setSelectedSub(editedSubscription);
        }
        highlightSubscriptions([editedSubscription?.path || finalPath], 'edited');
      }
      notifyProfileUpdated();

      showToast(
        t('common.success'),
        runtimeReloaded
          ? t('subscriptions.editSuccessReloaded')
          : activePathSynced
          ? t('subscriptions.editSuccessActivated')
          : t('subscriptions.editSuccess'),
        'success'
      );
      setIsEditDialogOpen(false);
    } catch (error) {
      console.error('编辑配置失败:', error);
      showToast('错误', `编辑配置失败: ${formatSubscriptionError(error)}`, 'error');
    } finally {
      setIsLoading(false);
    }
  };

  const showToast = (title: string, description: string, type: 'success' | 'error') => {
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current);
    }

    setToastTitle(title);
    setToastDescription(description);
    setToastType(type);
    setToastOpen(false);

    toastTimerRef.current = window.setTimeout(() => {
      setToastOpen(true);
      toastTimerRef.current = null;
    }, 20);
  };

  // 拖放文件相关处理函数
  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    
    // 只在拖拽文件时设置isDragging
    if (e.dataTransfer.types.includes('Files')) {
    setIsDragging(true);
    }
  }, []);

  const handleDragEnter = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    
    // 只在拖拽文件时设置isDragging
    if (e.dataTransfer.types.includes('Files')) {
    setIsDragging(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    
    // 检查是否离开了主容器
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX;
    const y = e.clientY;
    
    // 如果鼠标位置在容器外部，则设置isDragging为false
    if (
      x < rect.left ||
      x >= rect.right ||
      y < rect.top ||
      y >= rect.bottom
    ) {
      setIsDragging(false);
    }
  }, []);

  // 文件拖放处理函数
  const handleFileDrop = useCallback(async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const api = window.electronAPI;
    if (!hasElectronMethod(api, 'saveSubscription')) {
      showToast('错误', '订阅 API 不可用', 'error');
      return;
    }
    
    // 如果是卡片拖拽，不处理文件
    if (isDraggingCard) return;

    // 获取拖拽的文件
    const files = Array.from(e.dataTransfer.files);
    
    if (files.length === 0) return;

    // 检查是否为YAML文件
    const validFiles = files.filter(file => 
      file.name.endsWith('.yaml') || 
      file.name.endsWith('.yml') || 
      file.type === 'application/x-yaml' ||
      file.type === 'text/yaml'
    );

    if (validFiles.length === 0) {
      showToast('错误', '请上传有效的YAML配置文件', 'error');
      return;
    }

    const importedPaths: string[] = [];
    let importedCount = 0;

    setIsLoading(true);
    try {
      // 处理每个有效文件
      for (const file of validFiles) {
        try {
          // 读取文件内容
          const content = await readFileAsText(file);
          if (!content.trim()) {
            showToast('错误', `导入配置文件 ${file.name} 失败: 文件内容为空`, 'error');
            continue;
          }

          // 保存为订阅
          const saveResult = normalizeSaveSubscriptionResult(await api.saveSubscription(
            `local:${file.name}`, // 使用本地标识符
            content,
            file.name.replace(/\.(ya?ml)$/, ''), // 使用文件名作为默认名称
            {
              lastUpdated: new Date().toISOString()
            }
          ));

          if (saveResult.success && saveResult.filePath) {
            importedPaths.push(saveResult.filePath);
            importedCount += 1;
          } else {
            showToast('错误', `导入配置文件 ${file.name} 失败: ${saveResult.error || '保存订阅失败'}`, 'error');
          }
        } catch (error) {
          console.error('导入配置文件失败:', error);
          showToast('错误', `导入配置文件 ${file.name} 失败: ${formatSubscriptionError(error)}`, 'error');
        }
      }

      const lastImportedPath = importedPaths[importedPaths.length - 1] || null;
      if (lastImportedPath) {
        const reloadedSubscriptions = await loadSubscriptions();
        if (reloadedSubscriptions) {
          const highlightedPaths = importedPaths.map((path) => findSubscriptionByPath(reloadedSubscriptions, path)?.path || path);
          const importedSubscription = findSubscriptionByPath(reloadedSubscriptions, lastImportedPath);
          const importedPath = importedSubscription?.path || lastImportedPath;
          if (importedSubscription) {
            setSelectedSub(importedSubscription);
          }
          const activated = await revealSavedSubscription(importedPath, 'imported', highlightedPaths);
          showToast(
            t('common.success'),
            activated
              ? t('subscriptions.importSuccessActivated')
              : t('subscriptions.importSuccess', { count: importedCount }),
            'success'
          );
        } else {
          showToast(t('common.error'), t('subscriptions.importSavedRefreshFailed'), 'error');
        }
      }
    } finally {
      setIsLoading(false);
    }
  }, [isDraggingCard]);

  // 处理文件选择
  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const api = window.electronAPI;
    if (!hasElectronMethod(api, 'saveSubscription')) {
      showToast('错误', '订阅 API 不可用', 'error');
      return;
    }
    
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;

    const importedPaths: string[] = [];
    let importedCount = 0;

    setIsLoading(true);
    try {
      for (const file of files) {
        try {
          // 读取文件内容
          const content = await readFileAsText(file);
          if (!content.trim()) {
            showToast('错误', `导入配置文件 ${file.name} 失败: 文件内容为空`, 'error');
            continue;
          }

          // 保存为订阅
          const saveResult = normalizeSaveSubscriptionResult(await api.saveSubscription(
            `local:${file.name}`,
            content,
            file.name.replace(/\.(ya?ml)$/, ''),
            {
              lastUpdated: new Date().toISOString()
            }
          ));

          if (saveResult.success && saveResult.filePath) {
            importedPaths.push(saveResult.filePath);
            importedCount += 1;
          } else {
            showToast('错误', `导入配置文件 ${file.name} 失败: ${saveResult.error || '保存订阅失败'}`, 'error');
          }
        } catch (error) {
          console.error('导入配置文件失败:', error);
          showToast('错误', `导入配置文件 ${file.name} 失败: ${formatSubscriptionError(error)}`, 'error');
        }
      }

      // 清空文件输入，允许再次选择相同的文件
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }

      const lastImportedPath = importedPaths[importedPaths.length - 1] || null;
      if (lastImportedPath) {
        const reloadedSubscriptions = await loadSubscriptions();
        if (reloadedSubscriptions) {
          const highlightedPaths = importedPaths.map((path) => findSubscriptionByPath(reloadedSubscriptions, path)?.path || path);
          const importedSubscription = findSubscriptionByPath(reloadedSubscriptions, lastImportedPath);
          const importedPath = importedSubscription?.path || lastImportedPath;
          if (importedSubscription) {
            setSelectedSub(importedSubscription);
          }
          const activated = await revealSavedSubscription(importedPath, 'imported', highlightedPaths);
          showToast(
            t('common.success'),
            activated
              ? t('subscriptions.importSuccessActivated')
              : t('subscriptions.importSuccess', { count: importedCount }),
            'success'
          );
        } else {
          showToast(t('common.error'), t('subscriptions.importSavedRefreshFailed'), 'error');
        }
      }
    } finally {
      setIsLoading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  // 将文件读取为文本
  const readFileAsText = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = e => resolve(e.target?.result as string);
      reader.onerror = e => reject(e);
      reader.readAsText(file);
    });
  };

  // 打开文件选择对话框
  const triggerFileInput = () => {
    fileInputRef.current?.click();
  };

  return (
    <div 
      className="space-y-5 relative"
      onDragOver={handleDragOver}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDrop={handleFileDrop}
    >
      <Toast.Provider swipeDirection="right">
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold text-foreground">{t('subscriptions.title')}</h1>
            <p className="text-sm text-muted-foreground">{t('subscriptions.subtitle')}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {subscriptions.length > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-3 py-1 text-slate-600 dark:bg-slate-800/60 dark:text-slate-200">
                {t('subscriptions.totalConfigs', { count: subscriptions.length })}
              </span>
            )}
            {isServiceRunning && (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-3 py-1 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-300">
                <CheckIcon className="h-3 w-3" /> {t('subscriptions.serviceRunning')}
              </span>
            )}
            {subscriptions.length > 1 && (
              <span className="inline-flex items-center gap-1 rounded-full bg-indigo-100 px-3 py-1 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-400">
                <DragHandleDots2Icon className="h-3 w-3" /> {t('subscriptions.dragToSort')}
              </span>
            )}
          </div>
        </div>

        <div className="rounded-2xl bg-white px-4 py-4 shadow-sm dark:bg-[#2a2a2a]">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <p className="text-sm text-muted-foreground">{t('subscriptions.dragToImport')}</p>

            <div className="flex flex-wrap items-center gap-2">
              {/* 批量更新按钮 */}
              {subscriptions.some(sub => isRemoteSubscriptionUrl(sub.url)) && (
                <button
                  type="button"
                  onClick={updateAllSubscriptions}
                  disabled={isUpdatingAll}
                  className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 bg-slate-50 text-slate-600 transition hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  title={t('subscriptions.updateAll')}
                >
                  <ReloadIcon className={`h-5 w-5 ${isUpdatingAll ? 'animate-spin' : ''}`} />
                  <span className="sr-only">{t('subscriptions.updateAll')}</span>
                </button>
              )}

              <Link
                href="/providers"
                className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 bg-slate-50 text-slate-600 transition hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
                title={t('subscriptions.externalResources')}
              >
                <CloudOutlineIcon className="h-5 w-5" />
                <span className="sr-only">{t('subscriptions.externalResources')}</span>
              </Link>

              <button
                type="button"
                onClick={triggerFileInput}
                className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 bg-slate-50 text-slate-600 transition hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
                title={t('subscriptions.uploadConfig')}
              >
                <UploadIcon className="h-5 w-5" />
                <span className="sr-only">{t('subscriptions.uploadConfig')}</span>
              </button>
              <input
                type="file"
                ref={fileInputRef}
                className="hidden"
                accept=".yaml,.yml,application/x-yaml,text/yaml"
                onChange={handleFileSelect}
                multiple
              />

              <Dialog.Root open={isDialogOpen} onOpenChange={setIsDialogOpen}>
              <Dialog.Trigger asChild>
                <button
                  type="button"
                  className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 bg-slate-50 text-slate-600 transition hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
                  title={t('subscriptions.addSubscription')}
                >
                  <PlusIcon className="h-5 w-5" />
                  <span className="sr-only">{t('subscriptions.addSubscription')}</span>
                </button>
              </Dialog.Trigger>

                <Dialog.Portal>
                  <Dialog.Overlay className="fixed inset-0 z-[90] bg-slate-900/50 backdrop-blur-sm" />
                  <Dialog.Content className="fixed left-1/2 top-1/2 z-[95] w-[min(420px,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-white/95 p-6 shadow-2xl outline-none transition-all dark:bg-[#2a2a2a] backdrop-blur-xl">
                    <Dialog.Title className="mb-4 flex items-center text-lg font-semibold text-slate-900 dark:text-white">
                      <GlobeIcon className="mr-2 h-5 w-5 text-blue-500" />
                      {t('subscriptions.addSubscription')}
                    </Dialog.Title>
                    <Dialog.Description className="sr-only">
                      输入订阅链接和可选名称以保存配置。
                    </Dialog.Description>
                  
                  <form onSubmit={addSubscription}>
                    <div className="mb-4">
                      <label className="block text-sm font-medium mb-2 text-gray-700 dark:text-gray-300 flex items-center">
                        <GlobeIcon className="w-4 h-4 mr-2 text-blue-500" />
                        {t('subscriptions.subscriptionLink')}
                      </label>
                      <div className="relative">
                        <input
                          type="text"
                          className="w-full py-2 pl-10 pr-3 border border-gray-300 dark:border-gray-700 rounded-md bg-white dark:bg-[#222222] text-gray-700 dark:text-gray-300 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-all"
                          placeholder="https://example.com/subscription"
                          value={subUrl}
                          onChange={(e) => setSubUrl(e.target.value)}
                          required
                        />
                        <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                          <GlobeIcon className="h-5 w-5 text-gray-400" />
                        </div>
                      </div>
                    </div>
                    
                    <div className="mb-4">
                      <label className="block text-sm font-medium mb-2 text-gray-700 dark:text-gray-300 flex items-center">
                        <Pencil1Icon className="w-4 h-4 mr-2 text-blue-500" />
                        {t('subscriptions.customName')}
                      </label>
                      <div className="relative">
                        <input
                          type="text"
                          className="w-full py-2 pl-10 pr-3 border border-gray-300 dark:border-gray-700 rounded-md bg-white dark:bg-[#222222] text-gray-700 dark:text-gray-300 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-all"
                          placeholder={t('subscriptions.configNamePlaceholder')}
                          value={subName}
                          onChange={(e) => setSubName(e.target.value)}
                        />
                        <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                          <Pencil1Icon className="h-5 w-5 text-gray-400" />
                        </div>
                      </div>
                      <p className="mt-1.5 text-xs text-gray-500 dark:text-gray-400 flex items-start">
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-1 text-gray-400 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                        <span>{t('subscriptions.customNameHint')}</span>
                      </p>
                    </div>
                    
                    <div className="flex justify-end gap-2">
                      <Dialog.Close asChild>
                        <button
                          type="button"
                          className="rounded-full border border-slate-200/60 px-4 py-2 text-sm text-slate-600 transition hover:bg-slate-100 dark:border-slate-700/60 dark:text-slate-200 dark:hover:bg-slate-800/60"
                        >
                          {t('subscriptions.cancel')}
                        </button>
                      </Dialog.Close>

                      <div className="flex flex-wrap justify-end gap-2">
                        <button
                          type="submit"
                          className="inline-flex items-center rounded-full bg-slate-900 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-70 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white"
                          disabled={isLoading}
                        >
                          {isLoading && addSubmitMode === 'save' ? t('subscriptions.processing') : t('subscriptions.add')}
                        </button>
                        <button
                          type="button"
                          className="inline-flex items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-70"
                          disabled={isLoading}
                          onClick={(event) => addSubscription(event, true)}
                        >
                          <PlayIcon className="h-4 w-4" />
                          {isLoading && addSubmitMode === 'activate'
                            ? t('subscriptions.addAndActivating')
                            : t('subscriptions.addAndActivate')}
                        </button>
                      </div>
                    </div>
                  </form>
                  
                  <Dialog.Close asChild>
                    <button
                      aria-label="Close"
                      className="absolute right-4 top-4 rounded-full bg-slate-100/70 p-1.5 text-slate-500 transition-colors hover:bg-slate-200 hover:text-slate-700 dark:bg-slate-700/60 dark:text-slate-200 dark:hover:bg-slate-700"
                    >
                      <Cross2Icon />
                    </button>
                  </Dialog.Close>
                </Dialog.Content>
              </Dialog.Portal>
              </Dialog.Root>
            </div>
          </div>
        </div>

        {/* 拖放区域 - 始终存在但只在拖动时可见 */}
        <div 
          className={`fixed inset-0 z-50 flex items-center justify-center bg-black/20 backdrop-blur-sm transition-opacity duration-300 ${
            isDragging ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
          }`}
        >
          <div className={`bg-white dark:bg-[#2a2a2a] rounded-2xl p-8 shadow-xl border-2 border-dashed border-blue-500 mx-4 max-w-lg w-full transition-transform duration-300 transform ${
            isDragging ? 'scale-100' : 'scale-95'
          }`}>
            <div className="flex flex-col items-center justify-center">
              <UploadIcon className="w-16 h-16 mb-4 text-blue-500" />
              <p className="text-lg font-medium text-gray-700 dark:text-gray-300">
                {t('subscriptions.dropToUpload')}
              </p>
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-2">
                {t('subscriptions.supportedFormats')}
              </p>
            </div>
          </div>
        </div>
        
        {/* 卡片网格 */}
        <div>
          <div className="flex justify-between items-center mb-6">
            <h2 className="text-lg font-semibold text-gray-800 dark:text-white flex items-center">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 mr-2 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
              </svg>
              {t('subscriptions.myConfigs')}
            </h2>
          </div>

          {isSubscriptionsLoading && subscriptions.length === 0 ? (
            <div className="min-h-[220px] rounded-2xl bg-white shadow-sm dark:bg-[#2a2a2a]" aria-busy="true" />
          ) : subscriptions.length === 0 ? (
            <div className="rounded-2xl bg-white py-16 text-center shadow-sm dark:bg-[#2a2a2a]">
              <div className="flex flex-col items-center justify-center">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-16 w-16 text-gray-300 dark:text-gray-600 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                <p className="text-lg font-medium text-gray-500 dark:text-gray-400">{t('subscriptions.noSubscriptions')}</p>
                <p className="mt-2 text-sm text-gray-500 dark:text-gray-500">{t('subscriptions.clickToAdd')}</p>
                <button
                  onClick={() => setIsDialogOpen(true)}
                  className="mt-4 inline-flex items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90"
                >
                  <PlusIcon className="h-4 w-4" />
                  {t('subscriptions.addSubscription')}
                </button>
              </div>
            </div>
          ) : (
            <div className="grid auto-rows-[minmax(110px,1fr)] grid-cols-1 gap-2.5 md:grid-cols-2 lg:grid-cols-3">
              {subscriptions.map((sub) => (
                <div
                  key={sub.path}
                  data-subscription-path={sub.path}
                  ref={draggedItem?.path === sub.path ? draggedItemRef : null}
                  className={`relative flex h-full min-h-[140px] flex-col overflow-hidden rounded-2xl border select-none ${
                    activeConfig === sub.path
                      ? 'bg-white dark:bg-[#2a2a2a] border-l-4 border-l-blue-500 dark:border-l-blue-400 border-slate-200 dark:border-slate-700'
                      : 'bg-white dark:bg-[#2a2a2a] border-slate-200 dark:border-slate-700'
                  } p-2.5 shadow-sm transition-all duration-300 group hover:-translate-y-0.5 hover:shadow-md
                    ${draggedItem?.path === sub.path ? 'opacity-70 scale-[1.02] shadow-lg' : 'opacity-100'}
                    ${dragOverItem?.path === sub.path ? 'border-dashed border-blue-500 dark:border-blue-400 translate-y-1 shadow-md' : ''}
                    ${isDraggingCard && draggedItem?.path !== sub.path && dragOverItem?.path !== sub.path ? 'opacity-90' : ''}
                    ${highlightCardClass(isHighlightedSubscription(sub.path), highlightedSubReason)}
                    ${activeConfig !== sub.path ? 'hover:bg-blue-50/50 dark:hover:bg-blue-900/5' : ''}
                    cursor-grab active:cursor-grabbing`}
                  onMouseDown={(e) => handleMouseDown(e, sub)}
                  onClick={(e) => {
                    // 单击激活配置(如果没有在拖拽)
                    if (!isDraggingCard && activeConfig !== sub.path && !switchingConfig) {
                      e.stopPropagation();
                      switchConfig(sub.path);
                    }
                  }}
                  onContextMenu={(e) => handleContextMenu(e, sub)}
                >
                  {/* 活跃标志 - 移除,使用文字标签代替 */}

                  {isHighlightedSubscription(sub.path) && (
                    activeConfig !== sub.path && (highlightedSubReason === 'added' || highlightedSubReason === 'imported') ? (
                      <button
                        type="button"
                        className="absolute bottom-2 right-2 z-20 inline-flex max-w-[calc(100%-1rem)] items-center gap-1.5 rounded-full bg-amber-500 px-2.5 py-1 text-[10px] font-semibold text-white shadow-md transition hover:bg-amber-600 disabled:cursor-not-allowed disabled:opacity-60"
                        onClick={(event) => {
                          event.stopPropagation();
                          if (!switchingConfig) {
                            switchConfig(sub.path);
                          }
                        }}
                        onMouseDown={(event) => event.stopPropagation()}
                        disabled={!!switchingConfig}
                        title={t('subscriptions.savedInactiveAction')}
                        aria-label={t('subscriptions.savedInactiveAction')}
                      >
                        <PlayIcon className="h-3 w-3 flex-shrink-0" />
                        <span className="truncate">{t('subscriptions.savedInactiveAction')}</span>
                      </button>
                    ) : (
                      <div className={`pointer-events-none absolute bottom-2 right-2 z-20 inline-flex max-w-[calc(100%-1rem)] items-center gap-1 rounded-full px-2 py-1 text-[10px] font-medium shadow-md ${highlightBadgeClass(highlightedSubReason)}`}>
                        {highlightedSubReason === 'failed'
                          ? <Cross2Icon className="h-3 w-3 flex-shrink-0" />
                          : <CheckIcon className="h-3 w-3 flex-shrink-0" />}
                        <span className="truncate">{t(highlightLabelKey(highlightedSubReason))}</span>
                      </div>
                    )
                  )}

                  {/* 操作按钮 - 正常状态半透明，悬浮时完全显示 */}
                  <div className="absolute top-2 right-2.5 flex gap-0 opacity-70 group-hover:opacity-100 transition-opacity">
                    {/* 打开文件按钮 */}
                    <button
                      draggable="false"
                      onClick={(e) => {
                        e.stopPropagation(); // 阻止事件冒泡，避免触发卡片点击
                        openConfigFile(sub.path);
                      }}
                      onMouseDown={(e) => e.stopPropagation()}
                      className="text-green-600 hover:text-green-800 dark:text-green-400 dark:hover:text-green-300 p-0.5 rounded-full hover:bg-green-100 dark:hover:bg-green-900/30 transition-colors"
                      title={t('subscriptions.openFile')}
                    >
                      <ExternalLinkIcon className="w-4 h-4" />
                    </button>

                    {/* 打开目录按钮 */}
                    <button
                      draggable="false"
                      onClick={(e) => {
                        e.stopPropagation(); // 阻止事件冒泡，避免触发卡片点击
                        openConfigFolder(sub.path);
                      }}
                      onMouseDown={(e) => e.stopPropagation()}
                      className="text-amber-600 hover:text-amber-800 dark:text-amber-400 dark:hover:text-amber-300 p-0.5 rounded-full hover:bg-amber-100 dark:hover:bg-amber-900/30 transition-colors"
                      title={t('subscriptions.openFolder')}
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                      </svg>
                    </button>

                    {/* 刷新按钮 - 仅远程订阅显示 */}
                    {isRemoteSubscriptionUrl(sub.url) && (
                      <button
                        draggable="false"
                        onClick={(e) => {
                          e.stopPropagation();
                          refreshSubscription(sub.path);
                        }}
                        onMouseDown={(e) => e.stopPropagation()}
                        className="text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 p-0.5 rounded-full hover:bg-blue-100 dark:hover:bg-blue-900/30 transition-colors"
                        title={t('subscriptions.updateSubscription')}
                        disabled={updatingSubPath === sub.path}
                      >
                        {updatingSubPath === sub.path ? (
                          <ReloadIcon className="w-4 h-4 animate-spin" />
                        ) : (
                          <ReloadIcon className="w-4 h-4" />
                        )}
                      </button>
                    )}

                    {/* 删除按钮 - 隐藏当前激活配置的删除按钮 */}
                    {activeConfig !== sub.path && (
                      <button
                        draggable="false"
                        onClick={(e) => {
                          e.stopPropagation(); // 阻止事件冒泡，避免触发卡片点击
                          deleteSubscription(sub.path);
                        }}
                        onMouseDown={(e) => e.stopPropagation()}
                        className="text-red-600 hover:text-red-800 dark:text-red-400 dark:hover:text-red-300 p-0.5 rounded-full hover:bg-red-100 dark:hover:bg-red-900/30 transition-colors"
                        title={t('subscriptions.deleteSubscription')}
                      >
                        <TrashIcon className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                  
                  {/* 订阅标题 - 移除左侧内边距 */}
                  <div className="mb-2 border-b border-gray-100 pb-1.5 dark:border-gray-800">
                    <h3 className="flex items-center truncate pr-14 text-[13px] font-medium text-gray-800 dark:text-white">
                      {/* 自定义图标 */}
                      {sub.cachedIconPath && (
                        <img
                          src={sub.cachedIconPath}
                          alt=""
                          className="w-4 h-4 mr-1.5 rounded object-cover flex-shrink-0"
                          onError={(e) => {
                            e.currentTarget.style.display = 'none';
                          }}
                        />
                      )}
                      {sub.name}
                      {activeConfig === sub.path ? (
                        <span className="ml-1.5 py-0.5 px-1.5 text-[9px] bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 rounded font-normal">
                          {t('subscriptions.current')}
                        </span>
                      ) : (
                        <span className="ml-1.5 py-0.5 px-1.5 text-[9px] bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 rounded font-normal opacity-0 group-hover:opacity-100 transition-opacity">
                          {t('subscriptions.clickActivate')}
                        </span>
                      )}
                    </h3>
                  </div>
                  
                  {/* 显示正在切换状态的加载指示器 */}
                  {switchingConfig === sub.path && (
                    <div className="absolute inset-0 z-10 flex items-center justify-center rounded-2xl bg-white/80 dark:bg-gray-900/80">
                      <div className="flex flex-col items-center">
                        <ReloadIcon className="w-8 h-8 animate-spin text-blue-500 mb-2" />
                        <span className="text-sm text-gray-600 dark:text-gray-300">{t('subscriptions.activating')}</span>
                      </div>
                    </div>
                  )}
                  
                  {/* 内容区域 - 占用主要空间 */}
                  <div className="flex flex-1 flex-col">
                    {/* 订阅流量信息或本地/远程配置信息 */}
                    {(sub.usedTraffic || sub.remainingTraffic || sub.expiryDate) ? (
                      <div className="flex h-full flex-col justify-between p-2 text-[11px]">
                        <div className="flex flex-col space-y-2">
                          {/* 流量信息区域 */}
                          {(sub.usedTraffic || sub.remainingTraffic) && (
                            <div className="space-y-1.5">
                              <div className="flex items-center">
                                <span className="flex items-center text-gray-500 dark:text-gray-400">
                                  <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5 mr-1 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
                                  </svg>
                                  {t('subscriptions.trafficUsage')}
                                </span>
                              </div>

                              <div className="flex items-center justify-between text-[11px]">
                                <div className="flex items-center space-x-1.5">
                                  {sub.usedTraffic && (
                                    <span className={getTrafficInfo(sub).usedColorClass}>{sub.usedTraffic}</span>
                                  )}
                                  {sub.usedTraffic && sub.remainingTraffic && (
                                    <span className="text-gray-400 dark:text-gray-500">/</span>
                                  )}
                                  {sub.remainingTraffic && (
                                    <span className={getTrafficInfo(sub).remainingColorClass}>{sub.remainingTraffic}</span>
                                  )}
                                </div>

                                {/* 流量百分比 */}
                                {sub.usedTraffic && sub.remainingTraffic && (
                                  <span className={`text-[9px] px-1 py-0.5 rounded-full ${
                                    getTrafficInfo(sub).isLow
                                      ? 'bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400'
                                      : 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
                                  }`}>
                                    {Math.round(getTrafficInfo(sub).progress)}%
                                  </span>
                                )}
                              </div>
                              
                              {/* 进度条 */}
                              <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
                                {/* 进度条填充 */}
                                {sub.usedTraffic && sub.remainingTraffic && (
                                  <div 
                                    className={`h-full rounded-full transition-all duration-500 ease-out shadow-inner ${getTrafficInfo(sub).progressColorClass}`}
                                    style={{ 
                                      width: `${getTrafficInfo(sub).progress}%` 
                                    }}
                                    title={`已使用 ${Math.round(getTrafficInfo(sub).progress)}%`}
                                  ></div>
                                )}
                                {(!sub.remainingTraffic && sub.usedTraffic) && (
                                  <div className="h-full bg-red-500 rounded-full w-full shadow-inner"></div>
                                )}
                                {(sub.remainingTraffic && !sub.usedTraffic) && (
                                  <div className="h-full bg-blue-500 rounded-full w-full shadow-inner"></div>
                                )}
                                
                                {/* 流量警告提示 */}
                                {getTrafficInfo(sub).isLow && (
                                  <div className="absolute right-0 top-0 transform translate-x-1/2 -translate-y-1/2">
                                    <div className="bg-red-100 dark:bg-red-900/50 text-red-600 dark:text-red-400 text-[9px] px-1.5 py-0.5 rounded-full whitespace-nowrap shadow-sm">
                                      {t('subscriptions.lowTraffic')}
                                    </div>
                                  </div>
                                )}
                              </div>
                            </div>
                          )}
                          
                          {/* 到期时间 */}
                          {sub.expiryDate && (
                            <div className="flex justify-between items-center">
                              <span className="text-gray-500 dark:text-gray-400 flex items-center">
                                <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5 mr-1 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                                </svg>
                                {t('subscriptions.expiryDate')}
                              </span>
                              <span className={`font-medium ${isExpiringSoon(sub.expiryDate) ? 'text-amber-500 dark:text-amber-400' : 'text-gray-700 dark:text-gray-200'}`}>
                                {sub.expiryDate}
                                {isExpiringSoon(sub.expiryDate) && (
                                  <span className="ml-1.5 py-0.5 px-1.5 text-[9px] bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400 rounded-full">
                                    {t('subscriptions.expiringSoon')}
                                  </span>
                                )}
                              </span>
                            </div>
                          )}
                        </div>

                        {/* 最后更新时间 */}
                        {formatSubscriptionLastUpdated(sub.lastUpdated) && (
                          <div className="mt-1 flex items-center justify-between border-t border-gray-200 pt-1 text-[10px] text-gray-400 dark:border-gray-700 dark:text-gray-500">
                            <span className="flex items-center">
                              <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                              </svg>
                              {t('subscriptions.lastUpdated')}
                            </span>
                            <span>{formatSubscriptionLastUpdated(sub.lastUpdated)}</span>
                          </div>
                        )}
                      </div>
                    ) : (
                      /* 没有流量信息时显示配置类型 */
                      <div className="flex h-full flex-col items-center justify-center p-2 text-[11px]">
                        {isRemoteSubscriptionUrl(sub.url) ? (
                          /* 远程配置 */
                          <div className="flex flex-col items-center justify-center py-3 space-y-1.5">
                            <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8 text-blue-400 dark:text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z" />
                            </svg>
                            <p className="text-[11px] text-gray-500 dark:text-gray-400">{t('subscriptions.remoteConfig')}</p>
                          </div>
                        ) : (
                          /* 本地配置 */
                          <div className="flex flex-col items-center justify-center py-3 space-y-1.5">
                            <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8 text-blue-400 dark:text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                            </svg>
                            <p className="text-[11px] text-gray-500 dark:text-gray-400">{t('subscriptions.localConfig')}</p>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        
        <Toast.Root
          open={toastOpen}
          onOpenChange={setToastOpen}
          duration={3000}
          className="fixed bottom-6 right-6 w-80 rounded-2xl shadow-lg backdrop-blur-sm z-[9999] transition-all bg-white/95 dark:bg-[#2a2a2a]/95"
        >
          <div className="p-4">
            <div className="flex items-start gap-3">
              {/* 图标 */}
              <div className={`flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center ${
                toastType === 'success'
                  ? 'bg-green-500/10 text-green-600 dark:text-green-400'
                  : 'bg-red-500/10 text-red-600 dark:text-red-400'
              }`}>
                {toastType === 'success' ? (
                  <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                  </svg>
                ) : (
                  <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                  </svg>
                )}
              </div>

              {/* 内容 */}
              <div className="flex-1 min-w-0">
                <Toast.Title className="text-sm font-semibold text-foreground mb-1">
                  {toastTitle}
                </Toast.Title>
                <Toast.Description className="text-xs text-muted-foreground">
                  {toastDescription}
                </Toast.Description>
              </div>

              {/* 关闭按钮 */}
              <Toast.Close asChild>
                <button
                  className="flex-shrink-0 text-muted-foreground hover:text-foreground transition-colors"
                  aria-label="Close"
                >
                  <Cross2Icon className="w-4 h-4" />
                </button>
              </Toast.Close>
            </div>
          </div>
        </Toast.Root>

        <Toast.Viewport id="subscription-toast-viewport" />
      </Toast.Provider>

      {/* 右键菜单 */}
      {contextMenuPosition && contextMenuSub && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={closeContextMenu}
          />
          <div
            className="fixed z-50 min-w-[180px] rounded-lg border border-slate-200 bg-white py-1 shadow-lg dark:border-slate-700 dark:bg-[#2a2a2a] backdrop-blur-[40px] backdrop-saturate-[180%]"
            style={{
              left: `${contextMenuPosition.x}px`,
              top: `${contextMenuPosition.y}px`,
            }}
          >
            {/* 更新 - 仅远程订阅显示 */}
            {isRemoteSubscriptionUrl(contextMenuSub.url) && (
              <button
                onClick={() => {
                  refreshSubscription(contextMenuSub.path);
                  closeContextMenu();
                }}
                className="flex w-full items-center px-3 py-2 text-sm text-slate-700 hover:bg-blue-50 dark:text-slate-200 dark:hover:bg-blue-900/20"
              >
                <ReloadIcon className="mr-2 h-4 w-4" />
                {t('subscriptions.update')}
              </button>
            )}

            {/* 编辑 */}
            <button
              onClick={() => openEditDialog(contextMenuSub)}
              className="flex w-full items-center px-3 py-2 text-sm text-slate-700 hover:bg-blue-50 dark:text-slate-200 dark:hover:bg-blue-900/20"
            >
              <Pencil1Icon className="mr-2 h-4 w-4" />
              {t('subscriptions.edit')}
            </button>

            {/* 可视化编辑 */}
            <button
              onClick={() => {
                setVisualEditingSub(contextMenuSub);
                setIsVisualEditDialogOpen(true);
                closeContextMenu();
              }}
              className="flex w-full items-center px-3 py-2 text-sm text-slate-700 hover:bg-blue-50 dark:text-slate-200 dark:hover:bg-blue-900/20"
            >
              <MixerHorizontalIcon className="mr-2 h-4 w-4" />
              {t('subscriptions.visualEdit')}
            </button>

            {/* 打开文件 */}
            <button
              onClick={() => {
                openConfigFile(contextMenuSub.path);
                closeContextMenu();
              }}
              className="flex w-full items-center px-3 py-2 text-sm text-slate-700 hover:bg-blue-50 dark:text-slate-200 dark:hover:bg-blue-900/20"
            >
              <ExternalLinkIcon className="mr-2 h-4 w-4" />
              {t('subscriptions.openFile')}
            </button>

            {/* 打开文件夹 */}
            <button
              onClick={() => {
                openConfigFolder(contextMenuSub.path);
                closeContextMenu();
              }}
              className="flex w-full items-center px-3 py-2 text-sm text-slate-700 hover:bg-blue-50 dark:text-slate-200 dark:hover:bg-blue-900/20"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="mr-2 h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
              </svg>
              {t('subscriptions.openFolder')}
            </button>

            {/* 分隔线 */}
            <div className="my-1 h-px bg-slate-200 dark:bg-slate-700" />

            {/* 删除 */}
            <button
              onClick={() => {
                deleteSubscription(contextMenuSub.path);
                closeContextMenu();
              }}
              disabled={activeConfig === contextMenuSub.path}
              className="flex w-full items-center px-3 py-2 text-sm text-red-600 hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed dark:text-red-400 dark:hover:bg-red-900/20"
            >
              <TrashIcon className="mr-2 h-4 w-4" />
              {t('subscriptions.delete')}
            </button>
          </div>
        </>
      )}

      {/* 编辑对话框 */}
      <Dialog.Root open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-slate-200 bg-white p-6 shadow-lg dark:border-slate-700 dark:bg-[#2a2a2a]">
            <Dialog.Title className="mb-4 text-lg font-semibold text-slate-900 dark:text-white">
              {t('subscriptions.editConfig')}
            </Dialog.Title>

            <div className="space-y-4">
              {/* 配置名称 */}
              <div>
                <label className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">
                  {t('subscriptions.configName')}
                </label>
                <input
                  type="text"
                  value={editingName}
                  onChange={(e) => setEditingName(e.target.value)}
                  className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-slate-600 dark:bg-[#222222] dark:text-white dark:placeholder-slate-500"
                  placeholder={t('subscriptions.configNamePlaceholder')}
                />
              </div>

              {/* 订阅URL - 仅URL类型配置显示 */}
              {editingSub && editingSub.url && editingSub.url.trim() !== '' && (
                <>
                  <div>
                    <label className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">
                      {t('subscriptions.subscriptionUrl')}
                    </label>
                    <input
                      type="text"
                      value={editingUrl}
                      onChange={(e) => setEditingUrl(e.target.value)}
                      className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-slate-600 dark:bg-[#222222] dark:text-white dark:placeholder-slate-500"
                      placeholder={t('subscriptions.subscriptionUrlPlaceholder')}
                    />
                    <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                      {editingUrl ? t('subscriptions.urlLoaded') : t('subscriptions.urlEmpty')}
                    </p>
                  </div>

                  {/* 自动更新间隔 */}
                  <div>
                    <label className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">
                      {t('subscriptions.autoUpdateInterval')}
                    </label>
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <input
                          type="number"
                          min="0"
                          step="1"
                          value={editingUpdateInterval}
                          onChange={(e) => {
                            const value = parseInt(e.target.value) || 0;
                            setEditingUpdateInterval(value < 0 ? 0 : value);
                          }}
                          className="w-32 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-slate-600 dark:bg-[#222222] dark:text-white dark:placeholder-slate-500"
                          placeholder="0"
                        />
                        <span className="text-sm text-slate-600 dark:text-slate-400">{t('subscriptions.minutes')}</span>
                      </div>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => setEditingUpdateInterval(0)}
                          className="rounded-md bg-slate-100 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
                        >
                          {t('subscriptions.disable')}
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditingUpdateInterval(60)}
                          className="rounded-md bg-slate-100 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
                        >
                          {t('subscriptions.hour1')}
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditingUpdateInterval(4320)}
                          className="rounded-md bg-slate-100 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
                        >
                          3天
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditingUpdateInterval(10080)}
                          className="rounded-md bg-slate-100 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
                        >
                          7天
                        </button>
                      </div>
                    </div>
                    <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                      {editingUpdateInterval === 0
                        ? t('subscriptions.disableAutoUpdate')
                        : t('subscriptions.autoUpdateEvery', { interval: editingUpdateInterval })}
                    </p>
                  </div>
                </>
              )}

              {/* 自定义图标URL */}
              <div>
                <label className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">
                  自定义图标 (可选)
                </label>
                <input
                  type="text"
                  value={editingIconUrl}
                  onChange={(e) => setEditingIconUrl(e.target.value)}
                  className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-slate-600 dark:bg-[#222222] dark:text-white dark:placeholder-slate-500"
                  placeholder="支持网站URL或图片链接"
                />
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  输入网站URL自动提取favicon，或直接输入图片链接
                </p>
              </div>

              {/* 覆写选择 */}
              <div>
                <label className="mb-2 block text-sm font-medium text-slate-700 dark:text-slate-300">
                  {t('subscriptions.applyOverrides')}
                </label>
                <div className="max-h-24 overflow-y-auto rounded-md border border-slate-300 bg-white dark:border-slate-600 dark:bg-[#222222] custom-scrollbar">
                  {availableOverrides.length === 0 ? (
                    <div className="p-3 text-center text-sm text-slate-500 dark:text-slate-400">
                      {t('subscriptions.noOverrides')}
                    </div>
                  ) : (
                    <div className="divide-y divide-slate-200 dark:divide-slate-700">
                      {availableOverrides.map((override) => (
                        <label
                          key={override.id}
                          className="flex items-center gap-2 p-2.5 hover:bg-slate-50 dark:hover:bg-slate-800/50 cursor-pointer"
                        >
                          <input
                            type="checkbox"
                            checked={editingOverrides.includes(override.id)}
                            onChange={(e) => {
                              if (e.target.checked) {
                                setEditingOverrides([...editingOverrides, override.id]);
                              } else {
                                setEditingOverrides(editingOverrides.filter(id => id !== override.id));
                              }
                            }}
                            className="h-4 w-4 rounded border-slate-300 text-blue-500 focus:ring-blue-500 dark:border-slate-600"
                          />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium text-slate-900 dark:text-white truncate">
                                {override.name}
                              </span>
                              {override.global && (
                                <span className="inline-flex items-center rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800 dark:bg-blue-900/30 dark:text-blue-300">
                                  {t('subscriptions.global')}
                                </span>
                              )}
                            </div>
                            {override.url && (
                              <p className="text-xs text-slate-500 dark:text-slate-400 truncate">
                                {override.url}
                              </p>
                            )}
                          </div>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  {t('subscriptions.overrideDescription')}
                </p>
              </div>
            </div>

            <div className="mt-6 flex justify-end gap-2">
              <Dialog.Close asChild>
                <button className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-600 dark:bg-[#222222] dark:text-slate-300 dark:hover:bg-slate-800">
                  {t('subscriptions.cancel')}
                </button>
              </Dialog.Close>
              <button
                onClick={saveEdit}
                disabled={isLoading || !editingName}
                className="rounded-md bg-blue-500 px-4 py-2 text-sm font-medium text-white hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isLoading ? t('subscriptions.saving') : t('subscriptions.save')}
              </button>
            </div>

            <Dialog.Close asChild>
              <button className="absolute right-4 top-4 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200">
                <Cross2Icon className="h-4 w-4" />
              </button>
            </Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* 可视化编辑对话框 */}
      <Dialog.Root open={isVisualEditDialogOpen} onOpenChange={setIsVisualEditDialogOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[90] bg-black/50 backdrop-blur-sm" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-[95] w-[min(900px,92vw)] max-h-[85vh] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-[#2a2a2a] flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 dark:border-slate-700 shrink-0">
              <Dialog.Title className="flex items-center text-lg font-semibold text-slate-900 dark:text-white">
                <MixerHorizontalIcon className="mr-2 h-5 w-5 text-blue-500" />
                {t('subscriptions.visualEdit')}
                {visualEditingSub && (
                  <span className="ml-2 text-sm font-normal text-slate-500 dark:text-slate-400">
                    - {visualEditingSub.name}
                  </span>
                )}
              </Dialog.Title>
              <Dialog.Close asChild>
                <button
                  aria-label="Close"
                  className="rounded-full bg-slate-100/70 p-1.5 text-slate-500 transition-colors hover:bg-slate-200 hover:text-slate-700 dark:bg-slate-700/60 dark:text-slate-200 dark:hover:bg-slate-700"
                >
                  <Cross2Icon className="h-4 w-4" />
                </button>
              </Dialog.Close>
            </div>
            <div className="flex-1 overflow-y-auto px-6 pb-4 custom-scrollbar">
              {visualEditingSub && (
                <ConfigEditor
                  configPath={visualEditingSub.path}
                  onSaved={() => {
                    loadSubscriptions();
                  }}
                />
              )}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* 拖拽预览 - 跟随鼠标的卡片 */}
      {isDraggingCard && draggedItem && dragPreviewPos && (
        <div
          className="fixed z-[100] pointer-events-none"
          style={{
            left: `${dragPreviewPos.x}px`,
            top: `${dragPreviewPos.y}px`,
            transform: 'translate(-50%, -50%)',
          }}
        >
          <div className="w-[280px] min-h-[140px] flex flex-col overflow-hidden rounded-2xl border border-blue-500 dark:border-blue-400 bg-white dark:bg-[#2a2a2a] p-2.5 shadow-2xl opacity-90 scale-105">
            {/* 订阅标题 */}
            <div className="mb-2 border-b border-gray-100 pb-1.5 dark:border-gray-800">
              <h3 className="flex items-center truncate text-[13px] font-medium text-gray-800 dark:text-white">
                {draggedItem.name}
              </h3>
            </div>

            {/* 内容区域 */}
            <div className="flex flex-1 flex-col">
              {(draggedItem.usedTraffic || draggedItem.remainingTraffic || draggedItem.expiryDate || draggedItem.lastUpdated) ? (
                <div className="flex h-full flex-col justify-between p-2 text-[11px]">
                  <div className="flex flex-col space-y-2">
                    {/* 本地配置文件标识 - 只有没有URL时才显示 */}
                    {!draggedItem.url && (
                      <div className="flex flex-col items-center justify-center py-4 space-y-2">
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-10 w-10 text-gray-400 dark:text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                        </svg>
                        <p className="text-[11px] text-gray-500 dark:text-gray-400">{t('subscriptions.localConfig')}</p>
                      </div>
                    )}

                    {/* 流量信息 */}
                    {(draggedItem.usedTraffic || draggedItem.remainingTraffic) && (
                      <div className="space-y-1.5">
                        <div className="flex items-center">
                          <span className="flex items-center text-gray-500 dark:text-gray-400">
                            <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5 mr-1 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
                            </svg>
                            {t('subscriptions.trafficUsage')}
                          </span>
                        </div>
                        <div className="flex items-center justify-between text-[11px]">
                          <div className="flex items-center space-x-1.5">
                            {draggedItem.usedTraffic && (
                              <span className={getTrafficInfo(draggedItem).usedColorClass}>{draggedItem.usedTraffic}</span>
                            )}
                            {draggedItem.usedTraffic && draggedItem.remainingTraffic && (
                              <span className="text-gray-400 dark:text-gray-500">/</span>
                            )}
                            {draggedItem.remainingTraffic && (
                              <span className={getTrafficInfo(draggedItem).remainingColorClass}>{draggedItem.remainingTraffic}</span>
                            )}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div className="flex h-full items-center justify-center p-2">
                  <p className="text-[11px] text-gray-500 dark:text-gray-400">{t('subscriptions.localConfig')}</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 拖拽中的全局指示 */}
      {isDraggingCard && (
        <div className="fixed bottom-4 left-1/2 transform -translate-x-1/2 bg-blue-500 text-white py-2 px-4 rounded-md shadow-lg z-50 flex items-center">
          <DragHandleDots2Icon className="mr-2 h-4 w-4" />
          <span>{t('subscriptions.dragCard')}</span>
        </div>
      )}
    </div>
  );
}
