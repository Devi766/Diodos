import React, { useState, useEffect, useCallback } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useTranslation } from 'react-i18next';
import { RefreshCw, Copy, Check } from 'lucide-react';
import { showToast } from '@/components/ui/toast';

interface IpInfo {
  ip: string;
  country?: string;
  countryCode?: string;
  region?: string;
  city?: string;
  isp?: string;
  org?: string;
  asn?: string;
  timezone?: string;
  latitude?: number;
  longitude?: number;
  isLocal?: boolean;
}

interface IpInfoDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function IpInfoDialog({ open, onOpenChange }: IpInfoDialogProps) {
  const { t } = useTranslation();
  const [ipInfo, setIpInfo] = useState<IpInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  const fetchIpInfo = useCallback(async () => {
    setLoading(true);
    setError(null);

    type ServiceConfig = {
      url: string;
      parser: (data: any) => Partial<IpInfo> | null;
    };

    const services: ServiceConfig[] = [
      {
        url: 'http://ip-api.com/json/?fields=status,message,country,countryCode,region,regionName,city,zip,lat,lon,timezone,isp,org,as,query',
        parser: (data: any): Partial<IpInfo> | null => {
          if (data.status !== 'success') return null;
          return {
            ip: data.query,
            country: data.country,
            countryCode: data.countryCode,
            region: data.regionName || data.region,
            city: data.city,
            isp: data.isp,
            org: data.org,
            asn: data.as,
            timezone: data.timezone,
            latitude: data.lat,
            longitude: data.lon,
          };
        },
      },
      {
        url: 'https://ipwho.is/',
        parser: (data: any): Partial<IpInfo> | null => {
          if (!data.success) return null;
          return {
            ip: data.ip,
            country: data.country,
            countryCode: data.country_code,
            region: data.region,
            city: data.city,
            isp: data.connection?.isp,
            org: data.connection?.org,
            asn: data.connection?.asn ? `AS${data.connection.asn}` : undefined,
            timezone: data.timezone?.id,
            latitude: data.latitude,
            longitude: data.longitude,
          };
        },
      },
      {
        url: 'https://api.ip.sb/geoip',
        parser: (data: any): Partial<IpInfo> | null => {
          return {
            ip: data.ip,
            country: data.country,
            countryCode: data.country_code,
            region: data.region,
            city: data.city,
            isp: data.isp,
            org: data.organization || data.org,
            asn: data.asn ? `AS${data.asn}` : undefined,
            timezone: data.timezone,
            latitude: data.latitude,
            longitude: data.longitude,
          };
        },
      },
      {
        url: 'https://ipapi.co/json/',
        parser: (data: any): Partial<IpInfo> | null => {
          if (data.error) return null;
          return {
            ip: data.ip,
            country: data.country_name,
            countryCode: data.country_code,
            region: data.region,
            city: data.city,
            isp: data.org,
            org: data.org,
            asn: data.asn,
            timezone: data.timezone,
            latitude: data.latitude,
            longitude: data.longitude,
          };
        },
      },
    ];

    let aggregatedInfo: Partial<IpInfo> = {};

    for (const service of services) {
      try {
        const response = await fetch(service.url, {
          headers: { 'User-Agent': 'FlyClash/1.0' },
        });

        if (!response.ok) continue;

        const data = await response.json();
        const parsedInfo = service.parser(data);
        if (!parsedInfo) continue;

        // Merge info, preferring non-empty values
        for (const [key, value] of Object.entries(parsedInfo)) {
          if (value && !aggregatedInfo[key as keyof IpInfo]) {
            (aggregatedInfo as any)[key] = value;
          }
        }

        // If we have enough info, stop
        if (aggregatedInfo.ip && aggregatedInfo.country && aggregatedInfo.isp) {
          break;
        }
      } catch (err) {
        console.warn(`Failed to fetch from ${service.url}:`, err);
        continue;
      }
    }

    if (!aggregatedInfo.ip) {
      setError(t('ipInfoDialog.fetchError'));
      setLoading(false);
      return;
    }

    setIpInfo(aggregatedInfo as IpInfo);
    setLoading(false);
  }, [t]);

  useEffect(() => {
    if (open) {
      fetchIpInfo();
    }
  }, [open, fetchIpInfo]);

  const copyToClipboard = useCallback(async (text: string, fieldName: string) => {
    if (!text || text === '--') return;

    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(fieldName);
      showToast({
        message: t('ipInfoDialog.copied', { value: text }),
        type: 'success',
        duration: 2000,
      });
      setTimeout(() => setCopiedField(null), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  }, [t]);

  const InfoRow = ({ label, value, fieldName }: { label: string; value?: string; fieldName: string }) => {
    if (!value) return null;

    const isCopied = copiedField === fieldName;

    return (
      <div
        className="flex items-center justify-between py-2 px-2 cursor-pointer hover:bg-muted/50 rounded-lg transition-colors group"
        onClick={() => copyToClipboard(value, fieldName)}
        title={t('ipInfoDialog.clickToCopy')}
      >
        <span className="text-sm text-muted-foreground">{label}</span>
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground">{value}</span>
          {isCopied ? (
            <Check className="h-3.5 w-3.5 text-green-500" />
          ) : (
            <Copy className="h-3.5 w-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
          )}
        </div>
      </div>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between">
            <span>{t('ipInfoDialog.title')}</span>
            <button
              onClick={fetchIpInfo}
              disabled={loading}
              className="rounded-lg p-1.5 transition-colors hover:bg-muted disabled:opacity-50"
              title={t('common.refresh')}
            >
              <RefreshCw className={`h-4 w-4 text-muted-foreground ${loading ? 'animate-spin' : ''}`} />
            </button>
          </DialogTitle>
        </DialogHeader>

        <div className="mt-2">
          {loading ? (
            <div className="flex flex-col items-center justify-center py-8 gap-3">
              <RefreshCw className="h-8 w-8 animate-spin text-primary" />
              <span className="text-sm text-muted-foreground">{t('ipInfoDialog.loading')}</span>
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center py-8 gap-3">
              <span className="text-sm text-destructive">{error}</span>
              <button
                onClick={fetchIpInfo}
                className="text-sm text-primary hover:underline"
              >
                {t('ipInfoDialog.retry')}
              </button>
            </div>
          ) : ipInfo ? (
            <div className="space-y-1">
              {/* Exit IP Section */}
              <div className="mb-4">
                <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2">
                  {t('ipInfoDialog.exitIp')}
                </h3>
                <div className="bg-muted/30 rounded-xl p-2">
                  <InfoRow
                    label={t('ipInfoDialog.ipAddress')}
                    value={ipInfo.ip}
                    fieldName="ip"
                  />
                  <InfoRow
                    label={t('ipInfoDialog.country')}
                    value={ipInfo.country}
                    fieldName="country"
                  />
                  <InfoRow
                    label={t('ipInfoDialog.region')}
                    value={ipInfo.region}
                    fieldName="region"
                  />
                  <InfoRow
                    label={t('ipInfoDialog.city')}
                    value={ipInfo.city}
                    fieldName="city"
                  />
                  <InfoRow
                    label={t('ipInfoDialog.isp')}
                    value={ipInfo.isp}
                    fieldName="isp"
                  />
                  {ipInfo.org && ipInfo.org !== ipInfo.isp && (
                    <InfoRow
                      label={t('ipInfoDialog.org')}
                      value={ipInfo.org}
                      fieldName="org"
                    />
                  )}
                  <InfoRow
                    label={t('ipInfoDialog.asn')}
                    value={ipInfo.asn}
                    fieldName="asn"
                  />
                  <InfoRow
                    label={t('ipInfoDialog.timezone')}
                    value={ipInfo.timezone}
                    fieldName="timezone"
                  />
                </div>
              </div>

              {/* Hint */}
              <p className="text-xs text-muted-foreground text-center pt-2">
                {t('ipInfoDialog.clickToCopyHint')}
              </p>
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
