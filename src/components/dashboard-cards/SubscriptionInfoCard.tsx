import React, { useCallback, useState, useEffect, useMemo, useId } from 'react';
import { Clock } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { SubscriptionImmersiveCard } from './SubscriptionImmersiveCard';
import { CardHeading } from './CardHeading';
import {
  hasActiveConfigCache,
  hasSubscriptionsCache,
  readActiveConfigCache,
  readSubscriptionsCache,
  toArrayValue,
  useActiveConfigCache,
  useSubscriptionsCache,
  writeActiveConfigCache,
  writeSubscriptionsCache,
} from '@/services/app-data-hooks';

interface SubscriptionData {
  name: string;
  usedTraffic: string | null;
  remainingTraffic: string | null;
  totalTraffic: string | null;
  expiryDate: string | null;
}

function parseTrafficToBytes(traffic: string | null): number {
  if (!traffic) return 0;
  const match = traffic.match(/^([\d.]+)\s*([KMGT]i?B?)?$/i);
  if (!match) return 0;
  const value = parseFloat(match[1]);
  const unit = match[2]?.toUpperCase().replace(/I?B?$/, '') || '';
  const multipliers: Record<string, number> = { '': 1, 'K': 1024, 'M': 1024 ** 2, 'G': 1024 ** 3, 'T': 1024 ** 4 };
  return value * (multipliers[unit] || 1);
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

const findSubscriptionData = (activeConfig: string | null, subs: any[]): SubscriptionData | null => {
  if (!activeConfig || subs.length === 0) return null;
  const activeSub = subs.find((s: any) => s.path === activeConfig);
  if (!activeSub) return null;
  return {
    name: activeSub.name,
    usedTraffic: activeSub.usedTraffic || null,
    remainingTraffic: activeSub.remainingTraffic || null,
    totalTraffic: activeSub.totalTraffic || null,
    expiryDate: activeSub.expiryDate || null,
  };
};

const PREVIEW_SUBSCRIPTION: SubscriptionData = {
  name: 'FlyClash', usedTraffic: '32 GB', remainingTraffic: '468 GB', totalTraffic: '500 GB', expiryDate: '2027-05-12',
};

export function SubscriptionInfoCard({ variant = 'standard', preview = false }: { variant?: string; preview?: boolean }) {
  const compact = variant !== 'large';
  const heightClass = compact ? 'dashboard-standard-full-card' : 'dashboard-large-card';
  const gradientId = useId();
  const { t } = useTranslation();
  const activeConfig = useActiveConfigCache();
  const subscriptions = useSubscriptionsCache<any>();
  const [storedSubData, setSubData] = useState<SubscriptionData | null>(() => {
    return findSubscriptionData(readActiveConfigCache(), readSubscriptionsCache());
  });
  const subData = preview ? PREVIEW_SUBSCRIPTION : storedSubData;
  const [loading, setLoading] = useState(() => {
    const hasActiveConfig = hasActiveConfigCache();
    const cachedActiveConfig = readActiveConfigCache();
    return !hasActiveConfig ||
      (cachedActiveConfig !== null && !hasSubscriptionsCache());
  });

  useEffect(() => {
    setSubData(findSubscriptionData(activeConfig, subscriptions));
    if (
      hasActiveConfigCache() &&
      (activeConfig === null || hasSubscriptionsCache())
    ) {
      setLoading(false);
    }
  }, [activeConfig, subscriptions]);

  const fetchData = useCallback(async () => {
    try {
      if (typeof window === 'undefined' || !window.electronAPI) return;
      const activeConfigResult = await window.electronAPI.getActiveConfig();
      const configPath = typeof activeConfigResult === 'string' && activeConfigResult.trim()
        ? activeConfigResult
        : null;
      writeActiveConfigCache(configPath);
      if (!configPath) {
        setSubData(null);
        setLoading(false);
        return;
      }
      const subs = toArrayValue<any>(await window.electronAPI.getSubscriptions());
      writeSubscriptionsCache(subs);
      if (subs.length === 0) {
        setSubData(null);
        setLoading(false);
        return;
      }
      const activeSub = subs.find(
        (s: any) => s.path === configPath
      );
      if (activeSub) {
        setSubData({
          name: activeSub.name,
          usedTraffic: activeSub.usedTraffic || null,
          remainingTraffic: activeSub.remainingTraffic || null,
          totalTraffic: activeSub.totalTraffic || null,
          expiryDate: activeSub.expiryDate || null,
        });
      } else {
        setSubData(null);
      }
    } catch (error) {
      console.error('获取订阅信息失败:', error);
      setSubData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const applyCachedSnapshot = () => {
      const hasActiveConfig = hasActiveConfigCache();
      const nextActiveConfig = readActiveConfigCache();
      if (!hasActiveConfig) {
        return;
      }
      if (nextActiveConfig !== null && !hasSubscriptionsCache()) {
        return;
      }
      setSubData(findSubscriptionData(nextActiveConfig, readSubscriptionsCache()));
      setLoading(false);
    };

    applyCachedSnapshot();
  }, [activeConfig, subscriptions]);

  useEffect(() => {
    if (preview) return;
    fetchData();
    const interval = setInterval(fetchData, 60000);

    if (typeof window === 'undefined') {
      return () => clearInterval(interval);
    }

    const refresh = () => {
      void fetchData();
    };

    window.addEventListener('profile-updated', refresh);
    window.addEventListener('backup-restored', refresh);
    window.addEventListener('subscription-auto-updated', refresh);

    const unsubscribeActiveConfig = window.electronAPI?.onActiveConfigChanged?.(() => {
      refresh();
    });
    const unsubscribeAutoUpdated = window.electronAPI?.onSubscriptionAutoUpdated?.(() => {
      refresh();
    });

    return () => {
      clearInterval(interval);
      window.removeEventListener('profile-updated', refresh);
      window.removeEventListener('backup-restored', refresh);
      window.removeEventListener('subscription-auto-updated', refresh);
      unsubscribeActiveConfig?.();
      unsubscribeAutoUpdated?.();
    };
  }, [fetchData, preview]);

  const trafficInfo = useMemo(() => {
    if (!subData) return null;
    const usedBytes = parseTrafficToBytes(subData.usedTraffic);
    const totalFromField = parseTrafficToBytes(subData.totalTraffic);
    const remainingBytes = parseTrafficToBytes(subData.remainingTraffic);
    // 优先用后端的 totalTraffic，否则用 used + remaining 推算
    const totalBytes = totalFromField > 0 ? totalFromField : usedBytes + remainingBytes;
    if (totalBytes === 0 && usedBytes === 0) return null;
    const percentage = totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0;
    const actualRemaining = totalFromField > 0 ? Math.max(0, totalFromField - usedBytes) : remainingBytes;
    return { usedBytes, remainingBytes: actualRemaining, totalBytes, percentage };
  }, [subData]);

  const expiryInfo = useMemo(() => {
    if (!subData?.expiryDate) return null;
    const expiry = new Date(subData.expiryDate);
    if (isNaN(expiry.getTime())) return null;
    const now = new Date();
    const diffMs = expiry.getTime() - now.getTime();
    const daysLeft = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
    return { date: expiry, daysLeft };
  }, [subData]);

  const getStrokeColor = (pct: number) => {
    if (pct >= 90) return { start: '#ef4444', end: '#dc2626' };
    if (pct >= 70) return { start: '#f97316', end: '#ea580c' };
    return { start: '#3b82f6', end: '#2563eb' };
  };

  const getExpiryColor = (days: number) => {
    if (days <= 0) return 'text-red-500 dark:text-red-400';
    if (days <= 7) return 'text-orange-500 dark:text-orange-400';
    if (days <= 30) return 'text-yellow-500 dark:text-yellow-400';
    return 'text-green-500 dark:text-green-400';
  };

  if (variant === 'immersive') {
    return <SubscriptionImmersiveCard name={subData?.name}
      remaining={trafficInfo ? formatBytes(trafficInfo.remainingBytes) : null}
      fraction={trafficInfo && trafficInfo.totalBytes > 0 ? trafficInfo.remainingBytes / trafficInfo.totalBytes : null}
      expiry={expiryInfo?.date ?? null} daysLeft={expiryInfo?.daysLeft ?? null} loading={loading && !preview} />;
  }

  if (loading && !preview) {
    return (
      <div className={`flex ${heightClass} flex-col dashboard-card p-card`}>
        <CardHeading type="subscription-info">{t('dashboard.subscriptionInfo')}</CardHeading>
        <div className="flex min-h-0 flex-1 flex-col justify-center gap-2 animate-pulse" aria-hidden>
          <div className="h-5 w-2/3 rounded bg-muted/40" />
          <div className="h-3 w-1/3 rounded bg-muted/40" />
        </div>
      </div>
    );
  }

  if (!subData) {
    return (
      <div className={`flex ${heightClass} flex-col dashboard-card p-card`}>
        <CardHeading type="subscription-info">{t('dashboard.subscriptionInfo')}</CardHeading>
        <div className="flex min-h-0 flex-1 items-center justify-center"><p className="text-center text-xs text-muted-foreground">{t('dashboard.noSubscription')}</p></div>
      </div>
    );
  }

  const pct = trafficInfo?.percentage ?? 0;
  const strokeColor = getStrokeColor(pct);
  const radius = 70;
  const stroke = 10;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference - (circumference * Math.min(100, pct)) / 100;

  if (compact) {
    const stats = [
      { label: t('dashboard.usedTraffic'), value: trafficInfo ? formatBytes(trafficInfo.usedBytes) : '--' },
      { label: t('dashboard.remainingTraffic'), value: trafficInfo ? formatBytes(trafficInfo.remainingBytes) : '--' },
      { label: t('dashboard.totalTrafficLabel'), value: trafficInfo ? formatBytes(trafficInfo.totalBytes) : '--' },
    ];
    return (
      <div className="dashboard-card dashboard-standard-full-card flex flex-col p-card">
        <div className="flex h-4 shrink-0 items-center justify-between gap-2">
          <CardHeading type="subscription-info">{t('dashboard.subscriptionInfo')}</CardHeading>
        </div>
        <div className="mt-2 flex min-h-0 flex-1 items-center gap-4">
          <div className="relative size-[72px] shrink-0">
            <svg className="size-full" viewBox="0 0 160 160" aria-hidden>
              <defs>
                <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor={strokeColor.start} />
                  <stop offset="100%" stopColor={strokeColor.end} />
                </linearGradient>
              </defs>
              <circle cx="80" cy="80" r={radius} fill="none" className="stroke-gray-100 dark:stroke-gray-800" strokeWidth={stroke} />
              {trafficInfo && <circle cx="80" cy="80" r={radius} fill="none" stroke={`url(#${gradientId})`} strokeWidth={stroke}
                strokeLinecap="round" strokeDasharray={circumference} strokeDashoffset={dashOffset} transform="rotate(-90 80 80)" className="transition-all duration-700" />}
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <span className="text-base font-semibold tabular-nums text-foreground">{trafficInfo ? `${Math.round(pct)}%` : '--'}</span>
              <span className="text-[9px] text-muted-foreground">{t('dashboard.usedTraffic')}</span>
            </div>
          </div>
          <div className="flex min-w-0 flex-1 flex-col justify-center gap-1.5">
            <div className="truncate text-xs font-semibold leading-4 text-foreground" title={subData.name}>{subData.name}</div>
            <div className="grid grid-cols-3 gap-2">
              {stats.map(stat => (
                <div key={stat.label} className="min-w-0">
                  <div className="truncate text-[10px] leading-4 text-muted-foreground">{stat.label}</div>
                  <div className="truncate text-xs font-medium leading-4 tabular-nums text-foreground" title={stat.value}>{stat.value}</div>
                </div>
              ))}
            </div>
            {expiryInfo && (
              <div className="flex min-w-0 items-center gap-1.5 text-[10px] leading-3">
                <Clock aria-hidden className="size-3 shrink-0 text-muted-foreground" />
                <span className="shrink-0 text-muted-foreground">{expiryInfo.date.toLocaleDateString()}</span>
                <span className={`truncate ${getExpiryColor(expiryInfo.daysLeft)}`}>
                  {expiryInfo.daysLeft > 0 ? t('dashboard.daysRemaining', { days: expiryInfo.daysLeft }) : t('dashboard.expired')}
                </span>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex dashboard-large-card flex-col dashboard-card p-card">
      {/* 标题行 */}
      <div className="flex flex-shrink-0 items-center justify-between">
        <CardHeading type="subscription-info">
          {t('dashboard.subscriptionInfo')}
        </CardHeading>
      </div>

      {/* 主体：左圆环 + 右信息 */}
      <div className="flex flex-1 items-center gap-4 lg:gap-6 mt-2">
        {/* 圆环进度 */}
        <div className="relative flex-shrink-0 w-[110px] h-[110px] lg:w-[160px] lg:h-[160px]">
          <svg className="w-full h-full" viewBox="0 0 160 160">
            <defs>
              <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor={strokeColor.start} />
                <stop offset="100%" stopColor={strokeColor.end} />
              </linearGradient>
            </defs>
            {/* 背景圆环 */}
            <circle cx="80" cy="80" r={radius} fill="none"
              className="stroke-gray-100 dark:stroke-gray-800" strokeWidth={stroke} />
            {/* 进度圆环 */}
            {trafficInfo && (
              <circle cx="80" cy="80" r={radius} fill="none"
                stroke={`url(#${gradientId})`} strokeWidth={stroke}
                strokeLinecap="round"
                strokeDasharray={circumference} strokeDashoffset={dashOffset}
                transform="rotate(-90 80 80)"
                className="transition-all duration-700" />
            )}
          </svg>
          {/* 圆环中心文字 */}
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            {trafficInfo ? (
              <>
                <span className="text-lg lg:text-2xl font-bold text-foreground">{Math.round(pct)}%</span>
                <span className="text-[9px] lg:text-[10px] text-muted-foreground mt-0.5">{t('dashboard.usedTraffic')}</span>
              </>
            ) : (
              <span className="text-xs text-muted-foreground">--</span>
            )}
          </div>
        </div>
        {/* 右侧信息列表 */}
        <div className="flex flex-1 flex-col justify-center gap-3 min-w-0">
          {/* 配置名称 */}
          <div className="truncate text-sm font-semibold text-foreground">{subData.name}</div>

          {/* 信息条目 */}
          <div className="space-y-2.5">
            {trafficInfo && (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">{t('dashboard.usedTraffic')}</span>
                  <span className="text-xs font-medium text-foreground">{formatBytes(trafficInfo.usedBytes)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">{t('dashboard.remainingTraffic')}</span>
                  <span className="text-xs font-medium text-foreground">{formatBytes(trafficInfo.remainingBytes)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">{t('dashboard.totalTrafficLabel')}</span>
                  <span className="text-xs font-medium text-foreground">{formatBytes(trafficInfo.totalBytes)}</span>
                </div>
              </>
            )}
            {expiryInfo && (
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <Clock className="h-3 w-3 text-muted-foreground" />
                  <span className="text-xs text-muted-foreground">{t('dashboard.expiryDate')}</span>
                </div>
                <div className="flex flex-col items-end leading-tight">
                  <span className="text-xs text-foreground">{expiryInfo.date.toLocaleDateString()}</span>
                  <span className={`mt-0.5 text-[10px] font-medium ${getExpiryColor(expiryInfo.daysLeft)}`}>
                    {expiryInfo.daysLeft > 0
                      ? t('dashboard.daysRemaining', { days: expiryInfo.daysLeft })
                      : t('dashboard.expired')}
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
