import React, { useCallback, useState, useEffect, useRef } from 'react';
import { Card } from '@/components/ui/card';
import { Eye, EyeOff, RefreshCw, Globe } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { IpInfoDialog } from './IpInfoDialog';
import { fetchIpInfo, type IpInfo } from '@/utils/ip-info';
import {
  APP_DATA_CACHE_KEYS,
  hasAppDataCache,
  readAppDataCache,
  writeAppDataCache,
} from '@/services/app-data-cache';

export function IpAddressCard() {
  const { t } = useTranslation();
  const [ipInfo, setIpInfo] = useState<IpInfo | null>(() => {
    return readAppDataCache<IpInfo | null>(APP_DATA_CACHE_KEYS.ipInfo, null) ?? null;
  });
  const [loading, setLoading] = useState(() => !hasAppDataCache(APP_DATA_CACHE_KEYS.ipInfo));
  const [error, setError] = useState<string | null>(null);
  const [isVisible, setIsVisible] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const ipInfoRef = useRef(ipInfo);

  useEffect(() => {
    ipInfoRef.current = ipInfo;
  }, [ipInfo]);

  const loadIpInfo = useCallback(async () => {
    const coldLoad = !ipInfoRef.current && !hasAppDataCache(APP_DATA_CACHE_KEYS.ipInfo);
    if (coldLoad) setLoading(true);
    setError(null);

    try {
      const nextIpInfo = await fetchIpInfo();
      writeAppDataCache(APP_DATA_CACHE_KEYS.ipInfo, nextIpInfo);
      setIpInfo(nextIpInfo);
      setLoading(false);
    } catch (err) {
      if (!ipInfoRef.current) {
        setError(t('dashboard.ipFetchError') || '获取失败');
      }
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    loadIpInfo();
  }, [loadIpInfo]);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const refreshIpInfo = () => {
      void loadIpInfo();
    };

    window.addEventListener('profile-updated', refreshIpInfo);
    window.addEventListener('backup-restored', refreshIpInfo);
    window.addEventListener('subscription-auto-updated', refreshIpInfo);

    const unsubscribeActiveConfig = window.electronAPI?.onActiveConfigChanged?.(() => {
      refreshIpInfo();
    });
    const unsubscribeAutoUpdated = window.electronAPI?.onSubscriptionAutoUpdated?.(() => {
      refreshIpInfo();
    });
    const unsubscribeNodeChanged = window.electronAPI?.onNodeChanged?.(() => {
      refreshIpInfo();
    });

    return () => {
      window.removeEventListener('profile-updated', refreshIpInfo);
      window.removeEventListener('backup-restored', refreshIpInfo);
      window.removeEventListener('subscription-auto-updated', refreshIpInfo);
      unsubscribeActiveConfig?.();
      unsubscribeAutoUpdated?.();
      unsubscribeNodeChanged?.();
    };
  }, [loadIpInfo]);

  const toggleVisibility = () => {
    setIsVisible(!isVisible);
  };

  // 限制显示的最大字符数
  const truncateText = (text: string, maxLength: number) => {
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength) + '...';
  };

  const limitLength = (value: string | undefined, maxLength: number) => {
    if (!value) return '';
    return value.length <= maxLength ? value : value.slice(0, maxLength);
  };

  const displayIp = isVisible
    ? limitLength(ipInfo?.ip, 24)
    : '•••.•••.•••.•••';
  const sourceLabel = ipInfo?.source === 'proxy'
    ? t('dashboard.proxyExit')
    : ipInfo?.source === 'direct'
      ? t('dashboard.directExit')
      : ipInfo?.source === 'browser'
        ? t('dashboard.browserExit')
        : '';
  const displayIsp = truncateText(
    [sourceLabel, ipInfo?.isp || ipInfo?.country || t('dashboard.unknown')]
      .filter(Boolean)
      .join(' · '),
    30
  );

  const handleCardClick = (e: React.MouseEvent) => {
    // Don't open dialog if clicking on buttons
    if ((e.target as HTMLElement).closest('button')) {
      return;
    }
    if (!loading && !error && ipInfo) {
      setDialogOpen(true);
    }
  };

  return (
    <>
    <Card
      data-hoverable="false"
      className="rounded-3xl bg-white p-5 shadow-sm transition-all hover:shadow-md dark:bg-[#2a2a2a] cursor-pointer"
      onClick={handleCardClick}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t('dashboard.ipAddress') || 'IP 地址'}
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={toggleVisibility}
            disabled={!ipInfo || !!error}
            className="rounded-lg p-1 transition-colors hover:bg-muted disabled:opacity-50"
            title={isVisible ? t('dashboard.hideIp') : t('dashboard.showIp')}
          >
            {isVisible ? (
              <Eye className="h-4 w-4 text-muted-foreground" />
            ) : (
              <EyeOff className="h-4 w-4 text-muted-foreground" />
            )}
          </button>
          <button
            onClick={loadIpInfo}
            className="rounded-lg p-1 transition-colors hover:bg-muted"
            title={t('common.refresh')}
          >
            <RefreshCw className="h-4 w-4 text-muted-foreground" />
          </button>
          <Globe className="h-4 w-4 text-blue-500 dark:text-blue-400" />
        </div>
      </div>

      <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex-1 min-w-0">
          {/* 第一行：固定高度，放 IP 或加载/错误信息 */}
          <div className="h-7 flex items-center">
            {loading && !ipInfo ? (
              <span className="sr-only">{t('dashboard.ipAddress') || 'IP 地址'}</span>
            ) : error ? (
              <div className="text-sm text-destructive truncate">
                {error}
              </div>
            ) : (
              <div className="truncate text-lg font-semibold text-foreground">
                {displayIp}
              </div>
            )}
          </div>

          {/* 第二行：固定高度，放 ISP / 说明，占位时透明 */}
          <div className="mt-1 h-4 flex items-center">
            {(loading && !ipInfo) || error ? (
              <span className="text-xs text-muted-foreground opacity-0">
                {displayIsp || t('dashboard.unknown')}
              </span>
            ) : (
              <span className="truncate text-xs text-muted-foreground">
                {displayIsp}
              </span>
            )}
          </div>
        </div>

        <div className="ml-auto hidden shrink-0 items-center gap-0.5 self-end sm:flex" />
      </div>
    </Card>

    <IpInfoDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </>
  );
}
