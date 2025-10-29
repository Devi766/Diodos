import React, { useState, useEffect } from 'react';
import { Card } from '@/components/ui/card';
import { Eye, EyeOff, RefreshCw, Globe } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface IpInfo {
  ip: string;
  isp?: string;
  country?: string;
  region?: string;
  city?: string;
  isLocal?: boolean;
}

export function IpAddressCard() {
  const { t } = useTranslation();
  const [ipInfo, setIpInfo] = useState<IpInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isVisible, setIsVisible] = useState(true);

  const fetchIpInfo = async () => {
    setLoading(true);
    setError(null);

    try {
      const isIPv4Address = (value?: string) =>
        !!value && /^\d{1,3}(\.\d{1,3}){3}$/.test(value.trim());

      type ServiceConfig = {
        getUrl: (preferredIp?: string) => string | null;
        parser: (data: any) => Partial<IpInfo> | null;
      };

      const services: ServiceConfig[] = [
        {
          getUrl: () => 'https://api4.ipify.org?format=json',
          parser: parseIpify,
        },
        {
          getUrl: (ip) => (ip ? `https://ipwho.is/${ip}` : 'https://ipwho.is/'),
          parser: parseIpwhoIs,
        },
        {
          getUrl: () => 'https://api.ip.sb/geoip',
          parser: parseIpSb,
        },
        {
          getUrl: (ip) => (ip ? `https://ipapi.co/${ip}/json/` : 'https://ipapi.co/json/'),
          parser: parseIpApiCo,
        },
      ];

      let aggregatedInfo: Partial<IpInfo> = {};
      let preferredIp: string | undefined;

      for (const service of services) {
        const url = service.getUrl(preferredIp);
        if (!url) continue;

        try {
          const response = await fetch(url, {
            headers: { 'User-Agent': 'FlyClash/1.0' },
          });

          if (!response.ok) continue;

          const data = await response.json();
          const parsedInfo = service.parser(data);
          if (!parsedInfo) continue;

          if (parsedInfo.ip) {
            const candidate = parsedInfo.ip.trim();
            if (isIPv4Address(candidate)) {
              preferredIp = candidate;
            } else if (preferredIp) {
              delete parsedInfo.ip;
            }
          }

          aggregatedInfo = { ...aggregatedInfo, ...parsedInfo };

          if (preferredIp) {
            aggregatedInfo.ip = preferredIp;
          }

          if (aggregatedInfo.ip && (aggregatedInfo.isp || aggregatedInfo.country)) {
            break;
          }
        } catch (err) {
          console.warn(`Failed to fetch from ${url}:`, err);
          continue;
        }
      }

      const finalIp = preferredIp ?? aggregatedInfo.ip;

      if (!finalIp) {
        throw new Error('All IP services failed');
      }

      const finalInfo: IpInfo = {
        ip: finalIp,
        isp: aggregatedInfo.isp,
        country: aggregatedInfo.country,
        region: aggregatedInfo.region,
        city: aggregatedInfo.city,
        isLocal: aggregatedInfo.isLocal,
      };

      setIpInfo(finalInfo);
      setLoading(false);
    } catch (err) {
      console.error('Failed to fetch IP info:', err);
      setError(t('dashboard.ipFetchError') || '获取失败');
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchIpInfo();
  }, []);

  const parseIpify = (data: any): Partial<IpInfo> | null => {
    if (!data?.ip) return null;
    return {
      ip: data.ip,
    };
  };

  const parseIpwhoIs = (data: any): Partial<IpInfo> | null => {
    if (!data.success) return null;
    return {
      ip: data.ip,
      isp: data.connection?.isp || data.connection?.org,
      country: data.country,
      region: data.region,
      city: data.city,
    };
  };

  const parseIpSb = (data: any): Partial<IpInfo> | null => {
    return {
      ip: data.ip,
      isp: data.isp || data.organization || data.org,
      country: data.country,
      region: data.region,
      city: data.city,
    };
  };

  const parseIpApiCo = (data: any): Partial<IpInfo> | null => {
    return {
      ip: data.ip,
      isp: data.org,
      country: data.country_name,
      region: data.region,
      city: data.city,
    };
  };

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
    ? limitLength(ipInfo?.ip, 15)
    : '•••.•••.•••.•••';
  const displayIsp = truncateText(
    ipInfo?.isp || ipInfo?.country || t('dashboard.unknown'),
    30
  );

  return (
    <Card
      data-hoverable="false"
      className="rounded-3xl bg-white p-5 shadow-sm transition-all hover:shadow-md dark:bg-[#2a2a2a]"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t('dashboard.ipAddress') || 'IP 地址'}
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={toggleVisibility}
            disabled={loading || !!error}
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
            onClick={fetchIpInfo}
            disabled={loading}
            className="rounded-lg p-1 transition-colors hover:bg-muted disabled:opacity-50"
            title={t('dashboard.refresh')}
          >
            <RefreshCw
              className={`h-4 w-4 text-muted-foreground ${loading ? 'animate-spin' : ''}`}
            />
          </button>
          <Globe className="h-4 w-4 text-blue-500 dark:text-blue-400" />
        </div>
      </div>

      <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex-1 min-w-0">
          {loading ? (
            <div className="flex items-center gap-2">
              <RefreshCw className="h-4 w-4 animate-spin text-muted-foreground" />
              <span className="text-sm text-muted-foreground">
                {t('dashboard.loading') || '获取中...'}
              </span>
            </div>
          ) : error ? (
            <div className="text-sm text-destructive">{error}</div>
          ) : (
            <>
              <div className="truncate text-lg font-semibold text-foreground">{displayIp}</div>
              <div className="mt-1 truncate text-xs text-muted-foreground">{displayIsp}</div>
            </>
          )}
        </div>

        <div className="ml-auto hidden shrink-0 items-center gap-0.5 self-end sm:flex" />
      </div>
    </Card>
  );
}
