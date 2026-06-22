'use client';

import React, { useCallback, useState, useEffect, useRef } from 'react';
import { ReloadIcon } from '@radix-ui/react-icons';
import { useMihomoAPI } from '../services/mihomo-api';
import { Card } from './ui/card';
import { Button } from './ui/button';
import { Switch } from './ui/switch';
import { Tabs, TabsList, TabsTrigger } from './ui/tabs';
import { useTranslation } from 'react-i18next';
import { showToast } from '@/components/ui/toast';

const TAURI_RUNTIME_UNAVAILABLE = 'Tauri runtime is not available';

type GeoDataConfig = {
  geoip: string;
  geosite: string;
  mmdb: string;
  asn: string;
};

const DEFAULT_GEOX_URL: GeoDataConfig = {
  geoip: 'https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geoip-lite.dat',
  geosite: 'https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geosite.dat',
  mmdb: 'https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geoip.metadb',
  asn: 'https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/GeoLite2-ASN.mmdb'
};

const toMihomoGeoxUrl = (config: GeoDataConfig) => ({
  'geo-ip': config.geoip,
  'geo-site': config.geosite,
  mmdb: config.mmdb,
  asn: config.asn,
});

const notifyProfileUpdated = () => {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('profile-updated', { detail: { source: 'external-resources' } }));
  }
};

export default function ExternalResources() {
  const { t } = useTranslation();
  const mihomoAPI = useMihomoAPI();
  const mihomoAPIRef = useRef(mihomoAPI);
  const [isLoading, setIsLoading] = useState(true);
  const [isUpdating, setIsUpdating] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [hasLoadedConfig, setHasLoadedConfig] = useState(false);

  // GeoData配置
  const [geoxUrl, setGeoxUrl] = useState<GeoDataConfig>(DEFAULT_GEOX_URL);

  const [geoipInput, setGeoipInput] = useState(geoxUrl.geoip);
  const [geositeInput, setGeositeInput] = useState(geoxUrl.geosite);
  const [mmdbInput, setMmdbInput] = useState(geoxUrl.mmdb);
  const [asnInput, setAsnInput] = useState(geoxUrl.asn);

  const [geoMode, setGeoMode] = useState<'dat' | 'db'>('db');
  const [geoAutoUpdate, setGeoAutoUpdate] = useState(false);
  const [geoUpdateInterval, setGeoUpdateInterval] = useState(24);

  useEffect(() => {
    mihomoAPIRef.current = mihomoAPI;
  }, [mihomoAPI]);

  const errorToMessage = useCallback((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error || t('externalResources.unknownError'));
    if (message.includes(TAURI_RUNTIME_UNAVAILABLE)) {
      return t('externalResources.apiUnavailable');
    }
    if (
      message.includes('Mihomo service unavailable') ||
      message.includes('Mihomo服务未运行') ||
      message.includes('Mihomo服务未运行或无法访问')
    ) {
      return t('externalResources.serviceUnavailable');
    }
    return message;
  }, [t]);

  const fetchConfig = useCallback(async () => {
    setIsLoading(true);
    setErrorMessage(null);

    try {
      const config = await mihomoAPIRef.current.configs();
      const geoxUrlConfig = (config as any)['geox-url'] || {};

      // 确保每个字段都有默认值
      const mergedGeoxUrl = {
        geoip: geoxUrlConfig['geo-ip'] || geoxUrlConfig.geoip || DEFAULT_GEOX_URL.geoip,
        geosite: geoxUrlConfig['geo-site'] || geoxUrlConfig.geosite || DEFAULT_GEOX_URL.geosite,
        mmdb: geoxUrlConfig.mmdb || DEFAULT_GEOX_URL.mmdb,
        asn: geoxUrlConfig.asn || DEFAULT_GEOX_URL.asn
      };

      setGeoxUrl(mergedGeoxUrl);
      setGeoipInput(mergedGeoxUrl.geoip);
      setGeositeInput(mergedGeoxUrl.geosite);
      setMmdbInput(mergedGeoxUrl.mmdb);
      setAsnInput(mergedGeoxUrl.asn);

      setGeoMode((config as any)['geodata-mode'] ? 'dat' : 'db');
      setGeoAutoUpdate((config as any)['geo-auto-update'] || false);
      setGeoUpdateInterval((config as any)['geo-update-interval'] || 24);
      setHasLoadedConfig(true);
    } catch (error: any) {
      const message = errorToMessage(error);
      console.error('获取配置失败:', error);
      setErrorMessage(t('externalResources.fetchError', { error: message }));
      setHasLoadedConfig(false);
    } finally {
      setIsLoading(false);
    }
  }, [errorToMessage, t]);

  const handleUpdateGeoData = async () => {
    setIsUpdating(true);
    setErrorMessage(null);
    try {
      await mihomoAPIRef.current.upgradeGeo();
      notifyProfileUpdated();
      showToast({ message: t('externalResources.updateSuccess'), type: 'success' });
    } catch (error: any) {
      console.error('更新GeoData失败:', error);
      const message = t('externalResources.updateError', { error: errorToMessage(error) });
      setErrorMessage(message);
      showToast({ message, type: 'error' });
    } finally {
      setIsUpdating(false);
    }
  };

  const handleSaveGeoUrl = async (field: keyof GeoDataConfig, value: string) => {
    setErrorMessage(null);
    try {
      const nextGeoxUrl = { ...geoxUrl, [field]: value };
      await mihomoAPIRef.current.patchConfigs({
        'geox-url': toMihomoGeoxUrl(nextGeoxUrl)
      });
      setGeoxUrl(nextGeoxUrl);
      notifyProfileUpdated();
      showToast({
        message: t('externalResources.saveGeoUrlSuccess', { name: field.toUpperCase() }),
        type: 'success',
      });
    } catch (error: any) {
      console.error('保存配置失败:', error);
      const message = t('externalResources.saveError', { error: errorToMessage(error) });
      setErrorMessage(message);
      showToast({ message, type: 'error' });
    }
  };

  const handleSaveGeoMode = async (mode: 'dat' | 'db') => {
    setErrorMessage(null);
    const previousMode = geoMode;
    setGeoMode(mode);
    try {
      await mihomoAPIRef.current.patchConfigs({
        'geodata-mode': mode === 'dat'
      });
      notifyProfileUpdated();
      showToast({
        message: t('externalResources.modeSaved', { mode: mode.toUpperCase() }),
        type: 'success',
      });
    } catch (error: any) {
      console.error('保存配置失败:', error);
      setGeoMode(previousMode);
      const message = t('externalResources.saveError', { error: errorToMessage(error) });
      setErrorMessage(message);
      showToast({ message, type: 'error' });
    }
  };

  const handleSaveAutoUpdate = async (enabled: boolean) => {
    setErrorMessage(null);
    const previousValue = geoAutoUpdate;
    setGeoAutoUpdate(enabled);
    try {
      await mihomoAPIRef.current.patchConfigs({
        'geo-auto-update': enabled
      });
      notifyProfileUpdated();
      showToast({
        message: enabled
          ? t('externalResources.autoUpdateEnabled')
          : t('externalResources.autoUpdateDisabled'),
        type: 'success',
      });
    } catch (error: any) {
      console.error('保存配置失败:', error);
      setGeoAutoUpdate(previousValue);
      const message = t('externalResources.saveError', { error: errorToMessage(error) });
      setErrorMessage(message);
      showToast({ message, type: 'error' });
    }
  };

  const handleSaveUpdateInterval = async (interval: number) => {
    setErrorMessage(null);
    const previousInterval = geoUpdateInterval;
    setGeoUpdateInterval(interval);
    try {
      await mihomoAPIRef.current.patchConfigs({
        'geo-update-interval': interval
      });
      notifyProfileUpdated();
      showToast({
        message: t('externalResources.intervalSaved', { interval }),
        type: 'success',
      });
    } catch (error: any) {
      console.error('保存配置失败:', error);
      setGeoUpdateInterval(previousInterval);
      const message = t('externalResources.saveError', { error: errorToMessage(error) });
      setErrorMessage(message);
      showToast({ message, type: 'error' });
    }
  };

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const refreshAfterProfileChange = () => {
      void fetchConfig();
    };

    window.addEventListener('profile-updated', refreshAfterProfileChange);
    window.addEventListener('backup-restored', refreshAfterProfileChange);
    window.addEventListener('subscription-auto-updated', refreshAfterProfileChange);

    const unsubscribeActiveConfig = window.electronAPI?.onActiveConfigChanged?.(() => {
      refreshAfterProfileChange();
    });
    const unsubscribeAutoUpdated = window.electronAPI?.onSubscriptionAutoUpdated?.(() => {
      refreshAfterProfileChange();
    });

    return () => {
      window.removeEventListener('profile-updated', refreshAfterProfileChange);
      window.removeEventListener('backup-restored', refreshAfterProfileChange);
      window.removeEventListener('subscription-auto-updated', refreshAfterProfileChange);
      unsubscribeActiveConfig?.();
      unsubscribeAutoUpdated?.();
    };
  }, [fetchConfig]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <ReloadIcon className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!hasLoadedConfig) {
    return (
      <div className="space-y-6">
        <Card className="p-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-1">
              <h3 className="text-base font-semibold text-foreground">{t('externalResources.configUnavailableTitle')}</h3>
              <p className="text-sm text-muted-foreground">
                {errorMessage || t('externalResources.serviceUnavailable')}
              </p>
            </div>
            <Button size="sm" variant="solid" onClick={fetchConfig}>
              <ReloadIcon className="w-4 h-4 mr-2" />
              {t('externalResources.retry')}
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* 错误提示 */}
      {errorMessage && (
        <div className="p-3 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 rounded-lg text-sm">
          {errorMessage}
        </div>
      )}

      {/* GeoIP配置 */}
      <Card className="p-6">
        <div className="space-y-5">
          <div className="flex items-center justify-between pb-4 border-b border-slate-200 dark:border-slate-700">
            <h3 className="text-lg font-semibold text-foreground">{t('externalResources.geoDatabase')}</h3>
            <Button
              size="sm"
              variant="solid"
              onClick={handleUpdateGeoData}
              disabled={isUpdating}
            >
              <ReloadIcon className={`w-4 h-4 mr-2 ${isUpdating ? 'animate-spin' : ''}`} />
              {t('externalResources.updateDatabase')}
            </Button>
          </div>

          {/* GeoIP URL */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">GeoIP</label>
            <div className="flex gap-2">
              {geoipInput !== geoxUrl.geoip && (
                <Button
                  size="sm"
                  onClick={() => handleSaveGeoUrl('geoip', geoipInput)}
                >
                  {t('externalResources.confirm')}
                </Button>
              )}
              <input
                type="text"
                value={geoipInput}
                onChange={(e) => setGeoipInput(e.target.value)}
                className="flex-1 h-9 px-3 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#2a2a2a] text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
            </div>
          </div>

          {/* GeoSite URL */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">GeoSite</label>
            <div className="flex gap-2">
              {geositeInput !== geoxUrl.geosite && (
                <Button
                  size="sm"
                  onClick={() => handleSaveGeoUrl('geosite', geositeInput)}
                >
                  {t('externalResources.confirm')}
                </Button>
              )}
              <input
                type="text"
                value={geositeInput}
                onChange={(e) => setGeositeInput(e.target.value)}
                className="flex-1 h-9 px-3 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#2a2a2a] text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
            </div>
          </div>

          {/* MMDB URL */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">MMDB</label>
            <div className="flex gap-2">
              {mmdbInput !== geoxUrl.mmdb && (
                <Button
                  size="sm"
                  onClick={() => handleSaveGeoUrl('mmdb', mmdbInput)}
                >
                  {t('externalResources.confirm')}
                </Button>
              )}
              <input
                type="text"
                value={mmdbInput}
                onChange={(e) => setMmdbInput(e.target.value)}
                className="flex-1 h-9 px-3 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#2a2a2a] text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
            </div>
          </div>

          {/* ASN URL */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">ASN</label>
            <div className="flex gap-2">
              {asnInput !== geoxUrl.asn && (
                <Button
                  size="sm"
                  onClick={() => handleSaveGeoUrl('asn', asnInput)}
                >
                  {t('externalResources.confirm')}
                </Button>
              )}
              <input
                type="text"
                value={asnInput}
                onChange={(e) => setAsnInput(e.target.value)}
                className="flex-1 h-9 px-3 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#2a2a2a] text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
            </div>
          </div>

          {/* GeoData模式 */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">{t('externalResources.dataMode')}</label>
            <Tabs value={geoMode} onValueChange={(v) => handleSaveGeoMode(v as 'dat' | 'db')} className="w-fit">
              <TabsList className="bg-slate-100 dark:bg-slate-800">
                <TabsTrigger
                  value="db"
                  className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
                >
                  DB
                </TabsTrigger>
                <TabsTrigger
                  value="dat"
                  className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
                >
                  DAT
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </div>

          {/* 自动更新 */}
          <div className="flex items-center justify-between pt-4 border-t border-slate-200 dark:border-slate-700">
            <label className="text-sm font-medium text-foreground">{t('externalResources.autoUpdate')}</label>
            <Switch
              checked={geoAutoUpdate}
              onCheckedChange={handleSaveAutoUpdate}
            />
          </div>

          {/* 更新间隔 */}
          {geoAutoUpdate && (
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">{t('externalResources.updateInterval')}</label>
              <input
                type="number"
                value={geoUpdateInterval}
                onChange={(e) => {
                  const val = parseInt(e.target.value);
                  if (!isNaN(val) && val > 0) {
                    handleSaveUpdateInterval(val);
                  }
                }}
                className="w-32 h-9 px-3 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#2a2a2a] text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}

