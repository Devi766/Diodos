'use client';

import React, { useEffect, useState, useImperativeHandle, forwardRef } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { StyledSelect } from './ui/styled-select';
import { showToast } from '@/components/ui/toast';
import { useTranslation } from 'react-i18next';

export interface DnsSettingsRef {
  saveConfig: () => Promise<void>;
}

interface DnsConfig {
  enable?: boolean;
  ipv6?: boolean;
  'enhanced-mode'?: 'normal' | 'fake-ip' | 'redir-host';
  'fake-ip-range'?: string;
  'fake-ip-filter'?: string[];
  'use-hosts'?: boolean;
  'use-system-hosts'?: boolean;
  'respect-rules'?: boolean;
  'default-nameserver'?: string[];
  nameserver?: string[];
  'proxy-server-nameserver'?: string[];
  'direct-nameserver'?: string[];
  'nameserver-policy'?: Record<string, string | string[]>;
}

interface HostsConfig {
  hosts?: Array<{ domain: string; value: string | string[] }>;
}

const TAURI_RUNTIME_UNAVAILABLE = 'Tauri runtime is not available';

const getDnsApi = () => {
  if (typeof window === 'undefined') return undefined;
  return window.electronAPI;
};

const hasMethod = <K extends string>(api: unknown, method: K): api is Record<K, (...args: any[]) => any> => {
  try {
    return !!api && typeof (api as Record<string, unknown>)[method] === 'function';
  } catch {
    return false;
  }
};

const notifyProfileUpdated = () => {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('profile-updated', { detail: { source: 'dns-settings' } }));
  }
};

const DnsSettings = forwardRef<DnsSettingsRef>((props, ref) => {
  const { t } = useTranslation();
  const [config, setConfig] = useState<DnsConfig>({});
  const [hostsConfig, setHostsConfig] = useState<HostsConfig>({});
  // DNS 覆写总开关：默认关闭，关闭时不把设置页 DNS 合并进运行配置
  const [overrideEnabled, setOverrideEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const errorToMessage = (error: unknown, fallback = t('common.error')) => {
    if (!error) return fallback;
    return error instanceof Error ? error.message : String(error);
  };

  const displayError = (message?: string) => {
    if (!message) return t('common.error');
    return message.includes(TAURI_RUNTIME_UNAVAILABLE) ? t('overrideSettings.dnsApiUnavailable') : message;
  };

  useEffect(() => {
    loadConfig();
  }, []);

  const loadConfig = async () => {
    try {
      setLoading(true);
      setLoadError(null);
      const api = getDnsApi();
      if (!hasMethod(api, 'getDnsConfig')) {
        const message = t('overrideSettings.dnsApiUnavailable');
        setLoadError(message);
        showToast({ message, type: 'error' });
        return;
      }

      const result = await api.getDnsConfig();
      if (result.success) {
        setConfig(result.config || {});
        // 默认关闭：仅当后端明确返回 true 时开启
        setOverrideEnabled(result.overrideEnabled === true);

        if (result.hosts) {
          const hostsArray = Object.entries(result.hosts).map(([domain, value]) => ({
            domain,
            value
          }));
          setHostsConfig({ hosts: hostsArray });
        }
      } else {
        const message = `${t('overrideSettings.loadDnsConfigFailed')}: ${displayError(result.error)}`;
        setLoadError(message);
        showToast({ message, type: 'error' });
      }
    } catch (error) {
      console.error('Failed to load DNS config:', error);
      const message = `${t('overrideSettings.loadDnsConfigFailed')}: ${displayError(errorToMessage(error))}`;
      setLoadError(message);
      showToast({ message, type: 'error' });
    } finally {
      setLoading(false);
    }
  };

  const saveConfig = async () => {
    let errorNotified = false;
    const fail = (message: string): never => {
      errorNotified = true;
      showToast({ message, type: 'error' });
      throw new Error(message);
    };

    try {
      setSaving(true);
      const api = getDnsApi();
      if (!hasMethod(api, 'saveDnsConfig')) {
        return fail(t('overrideSettings.dnsApiUnavailable'));
      }

      // 创建一个副本，过滤掉数组字段中的空行
      const cleanedConfig = { ...config };
      const arrayFields: (keyof DnsConfig)[] = ['default-nameserver', 'nameserver', 'proxy-server-nameserver', 'direct-nameserver', 'fake-ip-filter'];

      arrayFields.forEach(field => {
        const value = cleanedConfig[field];
        if (Array.isArray(value)) {
          (cleanedConfig as Record<string, unknown>)[field] = value.filter(item => item.trim());
        }
      });

      // 开启覆写时确保内核 DNS 模块启用；关闭覆写时仍保存草稿配置，但不合并进运行配置
      if (overrideEnabled && cleanedConfig.enable === undefined) {
        cleanedConfig.enable = true;
      }

      const result = await api.saveDnsConfig(cleanedConfig, { overrideEnabled });
      if (result.success) {
        // hosts 仅在覆写开启且 use-hosts 时写入（关闭覆写时 hosts 也不会被合并）
        if (overrideEnabled && config['use-hosts']) {
          if (!hasMethod(api, 'saveHostsConfig')) {
            return fail(t('overrideSettings.hostsApiUnavailable'));
          }

          const hostsResult = await api.saveHostsConfig(hostsConfig.hosts || []);
          if (!hostsResult || hostsResult.success !== true) {
            return fail(`${t('overrideSettings.hostsConfigSaveFailed')}: ${displayError(hostsResult?.error)}`);
          }
        }

        if (result.restarted) {
          notifyProfileUpdated();
          showToast({ message: t('overrideSettings.dnsConfigSavedReloaded'), type: 'success' });
        } else {
          notifyProfileUpdated();
          showToast({ message: result.message || t('overrideSettings.dnsConfigSavedManualRestart'), type: 'warning' });
        }
      } else {
        return fail(`${t('overrideSettings.dnsConfigSaveFailed')}: ${displayError(result.error)}`);
      }
    } catch (error) {
      console.error('保存 DNS 配置失败:', error);
      if (!errorNotified) {
        const errorMsg = `${t('overrideSettings.dnsConfigSaveFailed')}: ${displayError(errorToMessage(error))}`;
        showToast({ message: errorMsg, type: 'error' });
      }
      throw error;
    } finally {
      setSaving(false);
    }
  };

  const updateConfig = (key: keyof DnsConfig, value: any) => {
    setConfig(prev => ({ ...prev, [key]: value }));
  };

  const updateArrayConfig = (key: keyof DnsConfig, value: string) => {
    // 保留用户输入的所有行（包括空行），在保存时才过滤空行
    const items = value.split('\n');
    setConfig(prev => ({ ...prev, [key]: items }));
  };

  useImperativeHandle(ref, () => ({
    saveConfig
  }));

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="text-gray-500 dark:text-gray-400">{t('overrideSettings.loading')}</div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 p-5 text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="text-base font-semibold">{t('overrideSettings.dns')}</h3>
            <p className="mt-1 text-sm">{loadError}</p>
          </div>
          <Button type="button" size="sm" variant="outline" onClick={loadConfig}>
            {t('common.refresh')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <label className="text-sm font-medium text-gray-700 dark:text-gray-200">{t('overrideSettings.dnsOverride')}</label>
            <p className="text-xs text-gray-500 dark:text-gray-400">{t('overrideSettings.dnsOverrideDesc')}</p>
          </div>
          <label className="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              className="sr-only peer"
              checked={overrideEnabled}
              onChange={(e) => {
                const enabled = e.target.checked;
                setOverrideEnabled(enabled);
                // 开启覆写时同步打开内核 DNS 模块
                if (enabled) {
                  updateConfig('enable', true);
                }
              }}
            />
            <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 dark:peer-focus:ring-blue-800 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-blue-600"></div>
          </label>
        </div>

        {!overrideEnabled && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200">
            {t('overrideSettings.dnsOverrideOffHint')}
          </div>
        )}

        <div className={`space-y-4 ${overrideEnabled ? '' : 'opacity-50 pointer-events-none'}`}>
        <div className="flex items-center justify-between">
          <div>
            <label className="text-sm font-medium text-gray-700 dark:text-gray-200">{t('overrideSettings.dnsIpv6')}</label>
            <p className="text-xs text-gray-500 dark:text-gray-400">{t('overrideSettings.dnsIpv6Desc')}</p>
          </div>
          <label className="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              className="sr-only peer"
              checked={config.ipv6 || false}
              onChange={(e) => updateConfig('ipv6', e.target.checked)}
              disabled={!overrideEnabled}
            />
            <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 dark:peer-focus:ring-blue-800 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-blue-600"></div>
          </label>
        </div>

        <div className="flex items-center justify-between">
          <div>
            <label className="text-sm font-medium text-gray-700 dark:text-gray-200">{t('overrideSettings.enhancedMode')}</label>
            <p className="text-xs text-gray-500 dark:text-gray-400">{t('overrideSettings.enhancedModeDesc')}</p>
          </div>
          <StyledSelect
            className="w-40"
            value={config['enhanced-mode'] || 'fake-ip'}
            onChange={(v) => updateConfig('enhanced-mode', v)}
            options={[
              { value: 'normal', label: t('overrideSettings.normal') },
              { value: 'fake-ip', label: t('overrideSettings.fakeIp') },
              { value: 'redir-host', label: t('overrideSettings.redirHost') },
            ]}
          />
        </div>

        <div>
          <label className="text-sm font-medium text-gray-700 dark:text-gray-200">{t('overrideSettings.fakeIpRange')}</label>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">{t('overrideSettings.fakeIpRangeDesc')}</p>
          <Input
            type="text"
            className="text-gray-900 dark:text-gray-100"
            placeholder="198.18.0.1/16"
            value={config['fake-ip-range'] || ''}
            onChange={(e) => updateConfig('fake-ip-range', e.target.value)}
          />
        </div>

        <div>
          <label className="text-sm font-medium text-gray-700 dark:text-gray-200">{t('overrideSettings.fakeIpFilter')}</label>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">{t('overrideSettings.fakeIpFilterDesc')}</p>
          <textarea
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-[#2a2a2a] text-gray-700 dark:text-gray-200 font-mono text-sm"
            rows={4}
            value={(config['fake-ip-filter'] || []).join('\n')}
            onChange={(e) => updateArrayConfig('fake-ip-filter', e.target.value)}
            placeholder="*.lan&#10;localhost.ptlogin2.qq.com"
          />
        </div>

        <div className="flex items-center justify-between">
          <div>
            <label className="text-sm font-medium text-gray-700 dark:text-gray-200">{t('overrideSettings.respectRules')}</label>
            <p className="text-xs text-gray-500 dark:text-gray-400">{t('overrideSettings.respectRulesDesc')}</p>
          </div>
          <label className="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              className="sr-only peer"
              checked={config['respect-rules'] || false}
              onChange={(e) => updateConfig('respect-rules', e.target.checked)}
            />
            <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 dark:peer-focus:ring-blue-800 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-blue-600"></div>
          </label>
        </div>

        <div className="flex items-center justify-between">
          <div>
            <label className="text-sm font-medium text-gray-700 dark:text-gray-200">{t('overrideSettings.useSystemHosts')}</label>
            <p className="text-xs text-gray-500 dark:text-gray-400">{t('overrideSettings.useSystemHostsDesc')}</p>
          </div>
          <label className="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              className="sr-only peer"
              checked={config['use-system-hosts'] !== false}
              onChange={(e) => updateConfig('use-system-hosts', e.target.checked)}
            />
            <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 dark:peer-focus:ring-blue-800 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-blue-600"></div>
          </label>
        </div>

        <div>
          <label className="text-sm font-medium text-gray-700 dark:text-gray-200">{t('overrideSettings.defaultNameserver')}</label>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">{t('overrideSettings.defaultNameserverDesc')}</p>
          <textarea
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-[#2a2a2a] text-gray-700 dark:text-gray-200 font-mono text-sm"
            rows={3}
            value={(config['default-nameserver'] || []).join('\n')}
            onChange={(e) => updateArrayConfig('default-nameserver', e.target.value)}
            placeholder="114.114.114.114&#10;8.8.8.8"
          />
        </div>

        <div>
          <label className="text-sm font-medium text-gray-700 dark:text-gray-200">{t('overrideSettings.nameserver')}</label>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">{t('overrideSettings.nameserverDesc')}</p>
          <textarea
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-[#2a2a2a] text-gray-700 dark:text-gray-200 font-mono text-sm"
            rows={4}
            value={(config.nameserver || []).join('\n')}
            onChange={(e) => updateArrayConfig('nameserver', e.target.value)}
            placeholder="https://doh.pub/dns-query&#10;https://dns.alidns.com/dns-query"
          />
        </div>

        <div>
          <label className="text-sm font-medium text-gray-700 dark:text-gray-200">{t('overrideSettings.proxyServerNameserver')}</label>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">{t('overrideSettings.proxyServerNameserverDesc')}</p>
          <textarea
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-[#2a2a2a] text-gray-700 dark:text-gray-200 font-mono text-sm"
            rows={3}
            value={(config['proxy-server-nameserver'] || []).join('\n')}
            onChange={(e) => updateArrayConfig('proxy-server-nameserver', e.target.value)}
            placeholder="https://doh.pub/dns-query"
          />
        </div>

        <div>
          <label className="text-sm font-medium text-gray-700 dark:text-gray-200">{t('overrideSettings.directNameserver')}</label>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">{t('overrideSettings.directNameserverDesc')}</p>
          <textarea
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-[#2a2a2a] text-gray-700 dark:text-gray-200 font-mono text-sm"
            rows={3}
            value={(config['direct-nameserver'] || []).join('\n')}
            onChange={(e) => updateArrayConfig('direct-nameserver', e.target.value)}
            placeholder="https://doh.pub/dns-query"
          />
        </div>

        <div className="flex items-center justify-between">
          <div>
            <label className="text-sm font-medium text-gray-700 dark:text-gray-200">{t('overrideSettings.useHosts')}</label>
            <p className="text-xs text-gray-500 dark:text-gray-400">{t('overrideSettings.useHostsDesc')}</p>
          </div>
          <label className="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              className="sr-only peer"
              checked={config['use-hosts'] || false}
              onChange={(e) => updateConfig('use-hosts', e.target.checked)}
            />
            <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 dark:peer-focus:ring-blue-800 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-blue-600"></div>
          </label>
        </div>

        {config['use-hosts'] && (
          <div>
            <label className="text-sm font-medium text-gray-700 dark:text-gray-200">{t('overrideSettings.hostsMapping')}</label>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">{t('overrideSettings.hostsMappingDesc')}</p>
            <textarea
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-[#2a2a2a] text-gray-700 dark:text-gray-200 font-mono text-sm"
              rows={6}
              value={(hostsConfig.hosts || []).map(h => `${h.domain}=${Array.isArray(h.value) ? h.value.join(',') : h.value}`).join('\n')}
              onChange={(e) => {
                const lines = e.target.value.split('\n').filter(line => line.trim());
                const hosts = lines.map(line => {
                  const [domain, value] = line.split('=');
                  return {
                    domain: domain?.trim() || '',
                    value: value?.includes(',') ? value.split(',').map(v => v.trim()) : value?.trim() || ''
                  };
                }).filter(h => h.domain && h.value);
                setHostsConfig({ hosts });
              }}
              placeholder="example.com=127.0.0.1&#10;*.example.com=192.168.1.1"
            />
          </div>
        )}
        </div>
      </div>
    </div>
  );
});

DnsSettings.displayName = 'DnsSettings';

export default DnsSettings;

