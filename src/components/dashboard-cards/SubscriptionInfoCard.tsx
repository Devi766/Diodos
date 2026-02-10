import React, { useState, useEffect, useMemo } from 'react';
import { CloudDownload, Clock } from 'lucide-react';
import { useTranslation } from 'react-i18next';

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

export function SubscriptionInfoCard() {
  const { t } = useTranslation();
  const [subData, setSubData] = useState<SubscriptionData | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = async () => {
    try {
      if (typeof window === 'undefined' || !window.electronAPI) return;
      const configPath = await window.electronAPI.getActiveConfig();
      if (!configPath) {
        setSubData(null);
        setLoading(false);
        return;
      }
      const subs = await window.electronAPI.getSubscriptions();
      if (!Array.isArray(subs) || subs.length === 0) {
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
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 60000);
    return () => clearInterval(interval);
  }, []);

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

  if (loading) {
    return (
      <div className="flex h-[260px] flex-col items-center justify-center rounded-3xl bg-white p-6 shadow-sm dark:bg-[#2a2a2a]">
        <p className="text-sm text-muted-foreground">{t('dashboard.loading')}</p>
      </div>
    );
  }

  if (!subData) {
    return (
      <div className="flex h-[260px] flex-col items-center justify-center rounded-3xl bg-white p-6 shadow-sm dark:bg-[#2a2a2a]">
        <CloudDownload className="h-8 w-8 text-muted-foreground/40 mb-2" />
        <p className="text-sm text-muted-foreground">{t('dashboard.noSubscription')}</p>
      </div>
    );
  }

  const pct = trafficInfo?.percentage ?? 0;
  const strokeColor = getStrokeColor(pct);
  const radius = 70;
  const stroke = 10;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference - (circumference * Math.min(100, pct)) / 100;
  const gradientId = 'sub-ring-grad';

  return (
    <div className="flex h-[260px] flex-col rounded-3xl bg-white p-6 shadow-sm dark:bg-[#2a2a2a]">
      {/* 标题行 */}
      <div className="flex flex-shrink-0 items-center justify-between">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t('dashboard.subscriptionInfo')}
        </p>
        <CloudDownload className="h-4 w-4 text-muted-foreground" />
      </div>

      {/* 主体：左圆环 + 右信息 */}
      <div className="flex flex-1 items-center gap-6 mt-2">
        {/* 圆环进度 */}
        <div className="relative flex-shrink-0">
          <svg width="160" height="160" viewBox="0 0 160 160">
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
                <span className="text-2xl font-bold text-foreground">{Math.round(pct)}%</span>
                <span className="text-[10px] text-muted-foreground mt-0.5">{t('dashboard.usedTraffic')}</span>
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
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-foreground">{expiryInfo.date.toLocaleDateString()}</span>
                  <span className={`text-[10px] font-medium ${getExpiryColor(expiryInfo.daysLeft)}`}>
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
