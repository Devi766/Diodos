'use client';

import React, { useEffect, useState, useImperativeHandle, forwardRef } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { showToast } from './ui/toast';
import { Badge } from './ui/badge';
import { useTranslation } from 'react-i18next';

export interface OverrideSettingsRef {
  saveConfig: () => Promise<void>;
}

interface KernelConfig {
  ipv6?: boolean;
  'log-level'?: 'silent' | 'error' | 'warning' | 'info' | 'debug';
  'mixed-port'?: number;
  'socks-port'?: number;
  port?: number;
  'redir-port'?: number;
  'tproxy-port'?: number;
  'allow-lan'?: boolean;
  'lan-allowed-ips'?: string[];
  'lan-disallowed-ips'?: string[];
  'external-controller'?: string;
  secret?: string;
  authentication?: string[];
  'skip-auth-prefixes'?: string[];
  'unified-delay'?: boolean;
  'tcp-concurrent'?: boolean;
  'disable-keep-alive'?: boolean;
  'keep-alive-idle'?: number;
  'keep-alive-interval'?: number;
  'global-client-fingerprint'?: string;
  'find-process-mode'?: 'off' | 'strict' | 'always';
  'interface-name'?: string;
  profile?: {
    'store-selected'?: boolean;
    'store-fake-ip'?: boolean;
  };
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

const OverrideSettings = forwardRef<OverrideSettingsRef>((props, ref) => {
  const { t } = useTranslation();
  const [config, setConfig] = useState<KernelConfig>({});
  const [dnsConfig, setDnsConfig] = useState<DnsConfig>({});
  const [hostsConfig, setHostsConfig] = useState<HostsConfig>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<'basic' | 'port' | 'controller' | 'dns' | 'advanced'>('basic');

  // 加载配置
  useEffect(() => {
    loadConfig();
    loadDnsConfig();
  }, []);

  const loadConfig = async () => {
    try {
      setLoading(true);
      if (window.electronAPI?.getKernelConfig) {
        const result = await window.electronAPI.getKernelConfig();
        if (result.success) {
          setConfig(result.config || {});
        }
      }
    } catch (error) {
      console.error(t('overrideSettings.loadKernelConfigFailed'), error);
    } finally {
      setLoading(false);
    }
  };

  const loadDnsConfig = async () => {
    try {
      if (window.electronAPI?.getDnsConfig) {
        const result = await window.electronAPI.getDnsConfig();
        if (result.success) {
          setDnsConfig(result.config || {});

          if (result.hosts) {
            const hostsArray = Object.entries(result.hosts).map(([domain, value]) => ({
              domain,
              value
            }));
            setHostsConfig({ hosts: hostsArray });
          }
        }
      }
    } catch (error) {
      console.error(t('overrideSettings.loadDnsConfigFailed'), error);
    }
  };

  const saveConfig = async () => {
    try {
      setSaving(true);

      // 保存内核配置
      if (window.electronAPI?.saveKernelConfig) {
        const kernelResult = await window.electronAPI.saveKernelConfig(config);
        if (!kernelResult.success) {
          const errorMsg = t('overrideSettings.kernelConfigSaveFailed') + ': ' + kernelResult.error;
          showToast({ message: errorMsg, type: 'error' });
          throw new Error(errorMsg);
        }
      }

      // 保存DNS配置（过滤掉空行）
      if (window.electronAPI?.saveDnsConfig) {
        // 创建一个副本，过滤掉数组字段中的空行
        const cleanedDnsConfig = { ...dnsConfig };
        const arrayFields: (keyof DnsConfig)[] = ['default-nameserver', 'nameserver', 'proxy-server-nameserver', 'direct-nameserver', 'fake-ip-filter'];

        arrayFields.forEach(field => {
          if (Array.isArray(cleanedDnsConfig[field])) {
            cleanedDnsConfig[field] = (cleanedDnsConfig[field] as string[]).filter(item => item.trim());
          }
        });

        const dnsResult = await window.electronAPI.saveDnsConfig(cleanedDnsConfig);
        if (!dnsResult.success) {
          const errorMsg = t('overrideSettings.dnsConfigSaveFailed') + ': ' + dnsResult.error;
          showToast({ message: errorMsg, type: 'error' });
          throw new Error(errorMsg);
        }

        // 保存Hosts配置
        if (dnsConfig['use-hosts'] && window.electronAPI?.saveHostsConfig) {
          await window.electronAPI.saveHostsConfig(hostsConfig.hosts || []);
        }
      }

      showToast({ message: t('overrideSettings.allConfigSaved'), type: 'success' });
    } catch (error) {
      console.error(t('overrideSettings.saveConfigFailed'), error);
      const errorMsg = t('overrideSettings.saveConfigFailed') + ': ' + error;
      showToast({ message: errorMsg, type: 'error' });
      throw error;
    } finally {
      setSaving(false);
    }
  };

  const updateConfig = (key: keyof KernelConfig, value: any) => {
    setConfig(prev => ({ ...prev, [key]: value }));
  };

  const updateProfileConfig = (key: string, value: boolean) => {
    setConfig(prev => ({
      ...prev,
      profile: {
        ...prev.profile,
        [key]: value
      }
    }));
  };

  const updateDnsConfig = (key: keyof DnsConfig, value: any) => {
    setDnsConfig(prev => ({ ...prev, [key]: value }));
  };

  const updateArrayDnsConfig = (key: keyof DnsConfig, value: string) => {
    // 保留用户输入的所有行（包括空行），在保存时才过滤空行
    const items = value.split('\n');
    setDnsConfig(prev => ({ ...prev, [key]: items }));
  };

  // 暴露 saveConfig 方法给父组件
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

  return (
    <div className="space-y-6">
      {/* 标签页 */}
      <div className="flex gap-2 border-b border-gray-200 dark:border-gray-700">
        <button
          className={`px-4 py-2 text-sm font-medium transition-colors ${
            activeTab === 'basic'
              ? 'border-b-2 border-blue-500 text-blue-600 dark:text-blue-400'
              : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
          }`}
          onClick={() => setActiveTab('basic')}
        >
          {t('overrideSettings.basic')}
        </button>
        <button
          className={`px-4 py-2 text-sm font-medium transition-colors ${
            activeTab === 'port'
              ? 'border-b-2 border-blue-500 text-blue-600 dark:text-blue-400'
              : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
          }`}
          onClick={() => setActiveTab('port')}
        >
          {t('overrideSettings.port')}
        </button>
        <button
          className={`px-4 py-2 text-sm font-medium transition-colors ${
            activeTab === 'controller'
              ? 'border-b-2 border-blue-500 text-blue-600 dark:text-blue-400'
              : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
          }`}
          onClick={() => setActiveTab('controller')}
        >
          {t('overrideSettings.controller')}
        </button>
        <button
          className={`px-4 py-2 text-sm font-medium transition-colors ${
            activeTab === 'dns'
              ? 'border-b-2 border-blue-500 text-blue-600 dark:text-blue-400'
              : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
          }`}
          onClick={() => setActiveTab('dns')}
        >
          {t('overrideSettings.dns')}
        </button>
        <button
          className={`px-4 py-2 text-sm font-medium transition-colors ${
            activeTab === 'advanced'
              ? 'border-b-2 border-blue-500 text-blue-600 dark:text-blue-400'
              : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
          }`}
          onClick={() => setActiveTab('advanced')}
        >
          {t('overrideSettings.advanced')}
        </button>
      </div>

      {/* 基础设置 */}
      {activeTab === 'basic' && (
        <div className="space-y-4">
            {/* IPv6 */}
            <div className="flex items-center justify-between">
              <div>
                <label className="text-sm font-medium text-gray-700 dark:text-gray-200">{t('overrideSettings.ipv6')}</label>
                <p className="text-xs text-gray-500 dark:text-gray-400">{t('overrideSettings.ipv6Desc')}</p>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  className="sr-only peer"
                  checked={config.ipv6 || false}
                  onChange={(e) => updateConfig('ipv6', e.target.checked)}
                />
                <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 dark:peer-focus:ring-blue-800 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-blue-600"></div>
              </label>
            </div>

            {/* 日志等级 */}
            <div className="flex items-center justify-between">
              <div>
                <label className="text-sm font-medium text-gray-700 dark:text-gray-200">{t('overrideSettings.logLevel')}</label>
                <p className="text-xs text-gray-500 dark:text-gray-400">{t('overrideSettings.logLevelDesc')}</p>
              </div>
              <select
                className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-[#2a2a2a] text-gray-700 dark:text-gray-200"
                value={config['log-level'] || 'info'}
                onChange={(e) => updateConfig('log-level', e.target.value)}
              >
                <option value="silent">{t('overrideSettings.silent')}</option>
                <option value="error">{t('overrideSettings.error')}</option>
                <option value="warning">{t('overrideSettings.warning')}</option>
                <option value="info">{t('overrideSettings.info')}</option>
                <option value="debug">{t('overrideSettings.debug')}</option>
              </select>
            </div>
        </div>
      )}

      {/* 端口设置 */}
      {activeTab === 'port' && (
        <div className="space-y-4">
            {/* Mixed Port */}
            <div className="flex items-center justify-between">
              <div>
                <label className="text-sm font-medium text-gray-700 dark:text-gray-200">{t('overrideSettings.mixedPort')}</label>
                <p className="text-xs text-gray-500 dark:text-gray-400">{t('overrideSettings.mixedPortDesc')}</p>
              </div>
              <Input
                type="number"
                className="w-32 text-gray-900 dark:text-gray-100"
                value={config['mixed-port'] || 7890}
                onChange={(e) => updateConfig('mixed-port', parseInt(e.target.value))}
              />
            </div>

            {/* Socks Port */}
            <div className="flex items-center justify-between">
              <div>
                <label className="text-sm font-medium text-gray-700 dark:text-gray-200">{t('overrideSettings.socksPort')}</label>
                <p className="text-xs text-gray-500 dark:text-gray-400">{t('overrideSettings.socksPortDesc')}</p>
              </div>
              <Input
                type="number"
                className="w-32 text-gray-900 dark:text-gray-100"
                value={config['socks-port'] || 0}
                onChange={(e) => updateConfig('socks-port', parseInt(e.target.value))}
              />
            </div>

            {/* HTTP Port */}
            <div className="flex items-center justify-between">
              <div>
                <label className="text-sm font-medium text-gray-700 dark:text-gray-200">{t('overrideSettings.httpPort')}</label>
                <p className="text-xs text-gray-500 dark:text-gray-400">{t('overrideSettings.httpPortDesc')}</p>
              </div>
              <Input
                type="number"
                className="w-32 text-gray-900 dark:text-gray-100"
                value={config.port || 0}
                onChange={(e) => updateConfig('port', parseInt(e.target.value))}
              />
            </div>

            {/* Allow LAN */}
            <div className="flex items-center justify-between">
              <div>
                <label className="text-sm font-medium text-gray-700 dark:text-gray-200">{t('overrideSettings.allowLan')}</label>
                <p className="text-xs text-gray-500 dark:text-gray-400">{t('overrideSettings.allowLanDesc')}</p>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  className="sr-only peer"
                  checked={config['allow-lan'] || false}
                  onChange={(e) => updateConfig('allow-lan', e.target.checked)}
                />
                <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 dark:peer-focus:ring-blue-800 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-blue-600"></div>
              </label>
            </div>

            {/* LAN Allowed IPs */}
            {config['allow-lan'] && (
              <>
                <div>
                  <label className="text-sm font-medium text-gray-700 dark:text-gray-200">{t('overrideSettings.lanAllowedIps')}</label>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">{t('overrideSettings.lanAllowedIpsDesc')}</p>
                  <textarea
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-[#2a2a2a] text-gray-700 dark:text-gray-200 font-mono text-sm"
                    rows={3}
                    placeholder="192.168.1.0/24&#10;10.0.0.0/8"
                    value={(config['lan-allowed-ips'] || []).join('\n')}
                    onChange={(e) => {
                      const items = e.target.value.split('\n').filter(item => item.trim());
                      updateConfig('lan-allowed-ips', items);
                    }}
                  />
                </div>

                <div>
                  <label className="text-sm font-medium text-gray-700 dark:text-gray-200">{t('overrideSettings.lanDisallowedIps')}</label>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">{t('overrideSettings.lanDisallowedIpsDesc')}</p>
                  <textarea
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-[#2a2a2a] text-gray-700 dark:text-gray-200 font-mono text-sm"
                    rows={3}
                    placeholder="192.168.1.100/32"
                    value={(config['lan-disallowed-ips'] || []).join('\n')}
                    onChange={(e) => {
                      const items = e.target.value.split('\n').filter(item => item.trim());
                      updateConfig('lan-disallowed-ips', items);
                    }}
                  />
                </div>
              </>
            )}

            {/* Authentication */}
            <div>
              <label className="text-sm font-medium text-gray-700 dark:text-gray-200">{t('overrideSettings.authentication')}</label>
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">{t('overrideSettings.authenticationDesc')}</p>
              <textarea
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-[#2a2a2a] text-gray-700 dark:text-gray-200 font-mono text-sm"
                rows={3}
                placeholder="user1:password1&#10;user2:password2"
                value={(config.authentication || []).join('\n')}
                onChange={(e) => {
                  const items = e.target.value.split('\n').filter(item => item.trim());
                  updateConfig('authentication', items);
                }}
              />
            </div>

            {/* Skip Auth Prefixes */}
            <div>
              <label className="text-sm font-medium text-gray-700 dark:text-gray-200">{t('overrideSettings.skipAuthPrefixes')}</label>
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">{t('overrideSettings.skipAuthPrefixesDesc')}</p>
              <textarea
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-[#2a2a2a] text-gray-700 dark:text-gray-200 font-mono text-sm"
                rows={2}
                placeholder="127.0.0.1/32"
                value={(config['skip-auth-prefixes'] || ['127.0.0.1/32']).join('\n')}
                onChange={(e) => {
                  const items = e.target.value.split('\n').filter(item => item.trim());
                  updateConfig('skip-auth-prefixes', items);
                }}
              />
            </div>
        </div>
      )}

      {/* 控制器设置 */}
      {activeTab === 'controller' && (
        <div className="space-y-4">
            {/* External Controller */}
            <div>
              <label className="text-sm font-medium text-gray-700 dark:text-gray-200">{t('overrideSettings.externalController')}</label>
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">{t('overrideSettings.externalControllerDesc')}</p>
              <Input
                type="text"
                className="text-gray-900 dark:text-gray-100"
                placeholder={t('overrideSettings.externalControllerPlaceholder')}
                value={config['external-controller'] || ''}
                onChange={(e) => updateConfig('external-controller', e.target.value)}
              />
            </div>

            {/* Secret */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <div>
                  <label className="text-sm font-medium text-gray-700 dark:text-gray-200">{t('overrideSettings.secret')}</label>
                  <p className="text-xs text-gray-500 dark:text-gray-400">{t('overrideSettings.secretDesc')}</p>
                </div>
                <Button
                  onClick={() => {
                    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
                    const randomSecret = Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
                    updateConfig('secret', randomSecret);
                  }}
                  className="px-3 py-1 text-xs bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200 rounded transition-colors"
                >
                  {t('overrideSettings.generateSecret')}
                </Button>
              </div>
              <Input
                type="text"
                className="text-gray-900 dark:text-gray-100"
                placeholder={t('overrideSettings.secretPlaceholder')}
                value={config.secret || ''}
                onChange={(e) => updateConfig('secret', e.target.value)}
              />
            </div>
        </div>
      )}

      {/* DNS设置 */}
      {activeTab === 'dns' && (
        <div className="space-y-4">
          {/* 启用 DNS */}
          <div className="flex items-center justify-between">
            <div>
              <label className="text-sm font-medium text-gray-700 dark:text-gray-200">{t('overrideSettings.enableDns')}</label>
              <p className="text-xs text-gray-500 dark:text-gray-400">{t('overrideSettings.enableDnsDesc')}</p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                className="sr-only peer"
                checked={dnsConfig.enable !== false}
                onChange={(e) => updateDnsConfig('enable', e.target.checked)}
              />
              <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 dark:peer-focus:ring-blue-800 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-blue-600"></div>
            </label>
          </div>

          {/* IPv6 */}
          <div className="flex items-center justify-between">
            <div>
              <label className="text-sm font-medium text-gray-700 dark:text-gray-200">{t('overrideSettings.dnsIpv6')}</label>
              <p className="text-xs text-gray-500 dark:text-gray-400">{t('overrideSettings.dnsIpv6Desc')}</p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                className="sr-only peer"
                checked={dnsConfig.ipv6 || false}
                onChange={(e) => updateDnsConfig('ipv6', e.target.checked)}
              />
              <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 dark:peer-focus:ring-blue-800 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-blue-600"></div>
            </label>
          </div>

          {/* 增强模式 */}
          <div className="flex items-center justify-between">
            <div>
              <label className="text-sm font-medium text-gray-700 dark:text-gray-200">{t('overrideSettings.enhancedMode')}</label>
              <p className="text-xs text-gray-500 dark:text-gray-400">{t('overrideSettings.enhancedModeDesc')}</p>
            </div>
            <select
              className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-[#2a2a2a] text-gray-700 dark:text-gray-200"
              value={dnsConfig['enhanced-mode'] || 'fake-ip'}
              onChange={(e) => updateDnsConfig('enhanced-mode', e.target.value)}
            >
              <option value="normal">{t('overrideSettings.normal')}</option>
              <option value="fake-ip">{t('overrideSettings.fakeIp')}</option>
              <option value="redir-host">{t('overrideSettings.redirHost')}</option>
            </select>
          </div>

          {/* Fake-IP 范围 */}
          <div>
            <label className="text-sm font-medium text-gray-700 dark:text-gray-200">{t('overrideSettings.fakeIpRange')}</label>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">{t('overrideSettings.fakeIpRangeDesc')}</p>
            <Input
              type="text"
              className="text-gray-900 dark:text-gray-100"
              placeholder="198.18.0.1/16"
              value={dnsConfig['fake-ip-range'] || ''}
              onChange={(e) => updateDnsConfig('fake-ip-range', e.target.value)}
            />
          </div>

          {/* Fake-IP 过滤 */}
          <div>
            <label className="text-sm font-medium text-gray-700 dark:text-gray-200">{t('overrideSettings.fakeIpFilter')}</label>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">{t('overrideSettings.fakeIpFilterDesc')}</p>
            <textarea
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-[#2a2a2a] text-gray-700 dark:text-gray-200 font-mono text-sm"
              rows={4}
              value={(dnsConfig['fake-ip-filter'] || []).join('\n')}
              onChange={(e) => updateArrayDnsConfig('fake-ip-filter', e.target.value)}
              placeholder="*.lan&#10;localhost.ptlogin2.qq.com"
            />
          </div>

          {/* 遵守规则 */}
          <div className="flex items-center justify-between">
            <div>
              <label className="text-sm font-medium text-gray-700 dark:text-gray-200">{t('overrideSettings.respectRules')}</label>
              <p className="text-xs text-gray-500 dark:text-gray-400">{t('overrideSettings.respectRulesDesc')}</p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                className="sr-only peer"
                checked={dnsConfig['respect-rules'] || false}
                onChange={(e) => updateDnsConfig('respect-rules', e.target.checked)}
              />
              <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 dark:peer-focus:ring-blue-800 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-blue-600"></div>
            </label>
          </div>

          {/* 使用系统 Hosts */}
          <div className="flex items-center justify-between">
            <div>
              <label className="text-sm font-medium text-gray-700 dark:text-gray-200">{t('overrideSettings.useSystemHosts')}</label>
              <p className="text-xs text-gray-500 dark:text-gray-400">{t('overrideSettings.useSystemHostsDesc')}</p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                className="sr-only peer"
                checked={dnsConfig['use-system-hosts'] !== false}
                onChange={(e) => updateDnsConfig('use-system-hosts', e.target.checked)}
              />
              <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 dark:peer-focus:ring-blue-800 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-blue-600"></div>
            </label>
          </div>

          {/* 默认域名服务器 */}
          <div>
            <label className="text-sm font-medium text-gray-700 dark:text-gray-200">{t('overrideSettings.defaultNameserver')}</label>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">{t('overrideSettings.defaultNameserverDesc')}</p>
            <textarea
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-[#2a2a2a] text-gray-700 dark:text-gray-200 font-mono text-sm"
              rows={3}
              value={(dnsConfig['default-nameserver'] || []).join('\n')}
              onChange={(e) => updateArrayDnsConfig('default-nameserver', e.target.value)}
              placeholder="114.114.114.114&#10;8.8.8.8"
            />
          </div>

          {/* 域名服务器 */}
          <div>
            <label className="text-sm font-medium text-gray-700 dark:text-gray-200">{t('overrideSettings.nameserver')}</label>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">{t('overrideSettings.nameserverDesc')}</p>
            <textarea
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-[#2a2a2a] text-gray-700 dark:text-gray-200 font-mono text-sm"
              rows={4}
              value={(dnsConfig.nameserver || []).join('\n')}
              onChange={(e) => updateArrayDnsConfig('nameserver', e.target.value)}
              placeholder="https://doh.pub/dns-query&#10;https://dns.alidns.com/dns-query"
            />
          </div>

          {/* 代理服务器域名服务器 */}
          <div>
            <label className="text-sm font-medium text-gray-700 dark:text-gray-200">{t('overrideSettings.proxyServerNameserver')}</label>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">{t('overrideSettings.proxyServerNameserverDesc')}</p>
            <textarea
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-[#2a2a2a] text-gray-700 dark:text-gray-200 font-mono text-sm"
              rows={3}
              value={(dnsConfig['proxy-server-nameserver'] || []).join('\n')}
              onChange={(e) => updateArrayDnsConfig('proxy-server-nameserver', e.target.value)}
              placeholder="https://doh.pub/dns-query"
            />
          </div>

          {/* 直连域名服务器 */}
          <div>
            <label className="text-sm font-medium text-gray-700 dark:text-gray-200">{t('overrideSettings.directNameserver')}</label>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">{t('overrideSettings.directNameserverDesc')}</p>
            <textarea
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-[#2a2a2a] text-gray-700 dark:text-gray-200 font-mono text-sm"
              rows={3}
              value={(dnsConfig['direct-nameserver'] || []).join('\n')}
              onChange={(e) => updateArrayDnsConfig('direct-nameserver', e.target.value)}
              placeholder="https://doh.pub/dns-query"
            />
          </div>

          {/* 自定义 Hosts */}
          <div className="flex items-center justify-between">
            <div>
              <label className="text-sm font-medium text-gray-700 dark:text-gray-200">{t('overrideSettings.useHosts')}</label>
              <p className="text-xs text-gray-500 dark:text-gray-400">{t('overrideSettings.useHostsDesc')}</p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                className="sr-only peer"
                checked={dnsConfig['use-hosts'] || false}
                onChange={(e) => updateDnsConfig('use-hosts', e.target.checked)}
              />
              <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 dark:peer-focus:ring-blue-800 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-blue-600"></div>
            </label>
          </div>

          {/* Hosts 映射 */}
          {dnsConfig['use-hosts'] && (
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
      )}

      {/* 高级设置 */}
      {activeTab === 'advanced' && (
        <div className="space-y-4">
            {/* 存储选择节点 */}
            <div className="flex items-center justify-between">
              <div>
                <label className="text-sm font-medium text-gray-700 dark:text-gray-200">{t('overrideSettings.storeSelected')}</label>
                <p className="text-xs text-gray-500 dark:text-gray-400">{t('overrideSettings.storeSelectedDesc')}</p>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  className="sr-only peer"
                  checked={config.profile?.['store-selected'] || false}
                  onChange={(e) => updateProfileConfig('store-selected', e.target.checked)}
                />
                <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 dark:peer-focus:ring-blue-800 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-blue-600"></div>
              </label>
            </div>

            {/* 存储 FakeIP */}
            <div className="flex items-center justify-between">
              <div>
                <label className="text-sm font-medium text-gray-700 dark:text-gray-200">{t('overrideSettings.storeFakeIp')}</label>
                <p className="text-xs text-gray-500 dark:text-gray-400">{t('overrideSettings.storeFakeIpDesc')}</p>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  className="sr-only peer"
                  checked={config.profile?.['store-fake-ip'] || false}
                  onChange={(e) => updateProfileConfig('store-fake-ip', e.target.checked)}
                />
                <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 dark:peer-focus:ring-blue-800 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-blue-600"></div>
              </label>
            </div>

            {/* 使用 RTT 延迟测试 */}
            <div className="flex items-center justify-between">
              <div>
                <label className="text-sm font-medium text-gray-700 dark:text-gray-200">{t('overrideSettings.unifiedDelay')}</label>
                <p className="text-xs text-gray-500 dark:text-gray-400">{t('overrideSettings.unifiedDelayDesc')}</p>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  className="sr-only peer"
                  checked={config['unified-delay'] || false}
                  onChange={(e) => updateConfig('unified-delay', e.target.checked)}
                />
                <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 dark:peer-focus:ring-blue-800 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-blue-600"></div>
              </label>
            </div>

            {/* TCP 并发 */}
            <div className="flex items-center justify-between">
              <div>
                <label className="text-sm font-medium text-gray-700 dark:text-gray-200">{t('overrideSettings.tcpConcurrent')}</label>
                <p className="text-xs text-gray-500 dark:text-gray-400">{t('overrideSettings.tcpConcurrentDesc')}</p>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  className="sr-only peer"
                  checked={config['tcp-concurrent'] || false}
                  onChange={(e) => updateConfig('tcp-concurrent', e.target.checked)}
                />
                <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 dark:peer-focus:ring-blue-800 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-blue-600"></div>
              </label>
            </div>

            {/* 禁用 TCP Keep Alive */}
            <div className="flex items-center justify-between">
              <div>
                <label className="text-sm font-medium text-gray-700 dark:text-gray-200">{t('overrideSettings.disableKeepAlive')}</label>
                <p className="text-xs text-gray-500 dark:text-gray-400">{t('overrideSettings.disableKeepAliveDesc')}</p>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  className="sr-only peer"
                  checked={config['disable-keep-alive'] || false}
                  onChange={(e) => updateConfig('disable-keep-alive', e.target.checked)}
                />
                <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 dark:peer-focus:ring-blue-800 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-blue-600"></div>
              </label>
            </div>

            {/* TCP Keep Alive 间隔 */}
            <div className="flex items-center justify-between">
              <div>
                <label className="text-sm font-medium text-gray-700 dark:text-gray-200">{t('overrideSettings.keepAliveInterval')}</label>
                <p className="text-xs text-gray-500 dark:text-gray-400">{t('overrideSettings.keepAliveIntervalDesc')}</p>
              </div>
              <Input
                type="number"
                className="w-32 text-gray-900 dark:text-gray-100"
                value={config['keep-alive-interval'] || 15}
                onChange={(e) => updateConfig('keep-alive-interval', parseInt(e.target.value))}
              />
            </div>

            {/* TCP Keep Alive 空闲 */}
            <div className="flex items-center justify-between">
              <div>
                <label className="text-sm font-medium text-gray-700 dark:text-gray-200">{t('overrideSettings.keepAliveIdle')}</label>
                <p className="text-xs text-gray-500 dark:text-gray-400">{t('overrideSettings.keepAliveIdleDesc')}</p>
              </div>
              <Input
                type="number"
                className="w-32 text-gray-900 dark:text-gray-100"
                value={config['keep-alive-idle'] || 15}
                onChange={(e) => updateConfig('keep-alive-idle', parseInt(e.target.value))}
              />
            </div>

            {/* uTLS 指纹 */}
            <div className="flex items-center justify-between">
              <div>
                <label className="text-sm font-medium text-gray-700 dark:text-gray-200">{t('overrideSettings.globalClientFingerprint')}</label>
                <p className="text-xs text-gray-500 dark:text-gray-400">{t('overrideSettings.globalClientFingerprintDesc')}</p>
              </div>
              <select
                className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-[#2a2a2a] text-gray-700 dark:text-gray-200"
                value={config['global-client-fingerprint'] || ''}
                onChange={(e) => updateConfig('global-client-fingerprint', e.target.value)}
              >
                <option value="">{t('overrideSettings.disabled')}</option>
                <option value="random">{t('overrideSettings.random')}</option>
                <option value="chrome">Chrome</option>
                <option value="firefox">Firefox</option>
                <option value="safari">Safari</option>
                <option value="ios">iOS</option>
                <option value="android">Android</option>
                <option value="edge">Edge</option>
                <option value="360">360</option>
                <option value="qq">QQ</option>
              </select>
            </div>

            {/* 查找进程模式 */}
            <div className="flex items-center justify-between">
              <div>
                <label className="text-sm font-medium text-gray-700 dark:text-gray-200">{t('overrideSettings.findProcessMode')}</label>
                <p className="text-xs text-gray-500 dark:text-gray-400">{t('overrideSettings.findProcessModeDesc')}</p>
              </div>
              <select
                className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-[#2a2a2a] text-gray-700 dark:text-gray-200"
                value={config['find-process-mode'] || 'strict'}
                onChange={(e) => updateConfig('find-process-mode', e.target.value)}
              >
                <option value="off">{t('overrideSettings.off')}</option>
                <option value="strict">{t('overrideSettings.strict')}</option>
                <option value="always">{t('overrideSettings.always')}</option>
              </select>
            </div>

            {/* 指定出站接口 */}
            <div>
              <label className="text-sm font-medium text-gray-700 dark:text-gray-200">{t('overrideSettings.interfaceName')}</label>
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">{t('overrideSettings.interfaceNameDesc')}</p>
              <Input
                type="text"
                className="text-gray-900 dark:text-gray-100"
                placeholder={t('overrideSettings.interfaceNamePlaceholder')}
                value={config['interface-name'] || ''}
                onChange={(e) => updateConfig('interface-name', e.target.value)}
              />
            </div>
        </div>
      )}

    </div>
  );
});

OverrideSettings.displayName = 'OverrideSettings';

export default OverrideSettings;
