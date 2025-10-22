'use client';

import React, { useState, useEffect } from 'react';
import { ReloadIcon } from '@radix-ui/react-icons';
import { useMihomoAPI } from '../services/mihomo-api';
import { Card } from './ui/card';
import { Button } from './ui/button';
import { Switch } from './ui/switch';
import { Tabs, TabsList, TabsTrigger } from './ui/tabs';

type GeoDataConfig = {
  geoip: string;
  geosite: string;
  mmdb: string;
  asn: string;
};

export default function ExternalResources() {
  const mihomoAPI = useMihomoAPI();
  const [isLoading, setIsLoading] = useState(true);
  const [isUpdating, setIsUpdating] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // GeoData配置
  const [geoxUrl, setGeoxUrl] = useState<GeoDataConfig>({
    geoip: 'https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geoip-lite.dat',
    geosite: 'https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geosite.dat',
    mmdb: 'https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geoip.metadb',
    asn: 'https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/GeoLite2-ASN.mmdb'
  });

  const [geoipInput, setGeoipInput] = useState(geoxUrl.geoip);
  const [geositeInput, setGeositeInput] = useState(geoxUrl.geosite);
  const [mmdbInput, setMmdbInput] = useState(geoxUrl.mmdb);
  const [asnInput, setAsnInput] = useState(geoxUrl.asn);

  const [geoMode, setGeoMode] = useState<'dat' | 'db'>('db');
  const [geoAutoUpdate, setGeoAutoUpdate] = useState(false);
  const [geoUpdateInterval, setGeoUpdateInterval] = useState(24);

  const fetchConfig = async () => {
    setIsLoading(true);
    setErrorMessage(null);

    try {
      const config = await mihomoAPI.configs();
      const geoxUrlConfig = (config as any)['geox-url'] || geoxUrl;
      setGeoxUrl(geoxUrlConfig);
      setGeoipInput(geoxUrlConfig.geoip);
      setGeositeInput(geoxUrlConfig.geosite);
      setMmdbInput(geoxUrlConfig.mmdb);
      setAsnInput(geoxUrlConfig.asn);

      setGeoMode((config as any)['geodata-mode'] ? 'dat' : 'db');
      setGeoAutoUpdate((config as any)['geo-auto-update'] || false);
      setGeoUpdateInterval((config as any)['geo-update-interval'] || 24);
    } catch (error: any) {
      console.error('获取配置失败:', error);
      setErrorMessage(`获取配置失败: ${error.message || '未知错误'}`);
    } finally {
      setIsLoading(false);
    }
  };

  const handleUpdateGeoData = async () => {
    setIsUpdating(true);
    try {
      // 这里需要调用更新GeoData的API
      // 暂时使用alert提示
      alert('GeoData更新功能需要后端API支持');
    } catch (error: any) {
      console.error('更新GeoData失败:', error);
      alert(`更新失败: ${error.message || '未知错误'}`);
    } finally {
      setIsUpdating(false);
    }
  };

  const handleSaveGeoUrl = async (field: keyof GeoDataConfig, value: string) => {
    try {
      await mihomoAPI.patchConfigs({
        'geox-url': {
          ...geoxUrl,
          [field]: value
        }
      });
      setGeoxUrl(prev => ({ ...prev, [field]: value }));
    } catch (error: any) {
      console.error('保存配置失败:', error);
      alert(`保存失败: ${error.message || '未知错误'}`);
    }
  };

  const handleSaveGeoMode = async (mode: 'dat' | 'db') => {
    try {
      await mihomoAPI.patchConfigs({
        'geodata-mode': mode === 'dat'
      });
      setGeoMode(mode);
    } catch (error: any) {
      console.error('保存配置失败:', error);
      alert(`保存失败: ${error.message || '未知错误'}`);
    }
  };

  const handleSaveAutoUpdate = async (enabled: boolean) => {
    try {
      await mihomoAPI.patchConfigs({
        'geo-auto-update': enabled
      });
      setGeoAutoUpdate(enabled);
    } catch (error: any) {
      console.error('保存配置失败:', error);
      alert(`保存失败: ${error.message || '未知错误'}`);
    }
  };

  const handleSaveUpdateInterval = async (interval: number) => {
    try {
      await mihomoAPI.patchConfigs({
        'geo-update-interval': interval
      });
      setGeoUpdateInterval(interval);
    } catch (error: any) {
      console.error('保存配置失败:', error);
      alert(`保存失败: ${error.message || '未知错误'}`);
    }
  };

  useEffect(() => {
    fetchConfig();
  }, []);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <ReloadIcon className="w-8 h-8 animate-spin text-primary" />
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
            <h3 className="text-lg font-semibold text-foreground">地理数据库</h3>
            <Button
              size="sm"
              variant="solid"
              onClick={handleUpdateGeoData}
              disabled={isUpdating}
            >
              <ReloadIcon className={`w-4 h-4 mr-2 ${isUpdating ? 'animate-spin' : ''}`} />
              更新数据库
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
                  确认
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
                  确认
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
                  确认
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
                  确认
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
            <label className="text-sm font-medium text-foreground">数据模式</label>
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
            <label className="text-sm font-medium text-foreground">自动更新</label>
            <Switch
              checked={geoAutoUpdate}
              onCheckedChange={handleSaveAutoUpdate}
            />
          </div>

          {/* 更新间隔 */}
          {geoAutoUpdate && (
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">更新间隔（小时）</label>
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

