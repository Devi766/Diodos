'use client';

import React, { useEffect, useState, useImperativeHandle, forwardRef } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { showToast } from './ui/toast';

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

const DnsSettings = forwardRef<DnsSettingsRef>((props, ref) => {
  const [config, setConfig] = useState<DnsConfig>({});
  const [hostsConfig, setHostsConfig] = useState<HostsConfig>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadConfig();
  }, []);

  const loadConfig = async () => {
    try {
      setLoading(true);
      if (window.electronAPI?.getDnsConfig) {
        const result = await window.electronAPI.getDnsConfig();
        if (result.success) {
          setConfig(result.config || {});

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
      console.error('Failed to load DNS config:', error);
    } finally {
      setLoading(false);
    }
  };

  const saveConfig = async () => {
    try {
      setSaving(true);
      if (window.electronAPI?.saveDnsConfig) {
        // 创建一个副本，过滤掉数组字段中的空行
        const cleanedConfig = { ...config };
        const arrayFields: (keyof DnsConfig)[] = ['default-nameserver', 'nameserver', 'proxy-server-nameserver', 'direct-nameserver', 'fake-ip-filter'];

        arrayFields.forEach(field => {
          if (Array.isArray(cleanedConfig[field])) {
            cleanedConfig[field] = (cleanedConfig[field] as string[]).filter(item => item.trim());
          }
        });

        const result = await window.electronAPI.saveDnsConfig(cleanedConfig);
        if (result.success) {
          if (config['use-hosts'] && window.electronAPI?.saveHostsConfig) {
            await window.electronAPI.saveHostsConfig(hostsConfig.hosts || []);
          }
          if (result.restarted) {
            showToast({ message: 'DNS配置保存成功，内核已自动重启', type: 'success' });
          } else {
            showToast({ message: result.message || 'DNS配置保存成功，但需要手动重启内核', type: 'warning' });
          }
        } else {
          const errorMsg = 'DNS配置保存失败: ' + result.error;
          showToast({ message: errorMsg, type: 'error' });
          throw new Error(errorMsg);
        }
      }
    } catch (error) {
      console.error('保存 DNS 配置失败:', error);
      const errorMsg = 'DNS配置保存失败: ' + error;
      showToast({ message: errorMsg, type: 'error' });
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
        <div className="text-gray-500 dark:text-gray-400">加载中...</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <label className="text-sm font-medium text-gray-700 dark:text-gray-200">启用 DNS</label>
            <p className="text-xs text-gray-500 dark:text-gray-400">启用内置 DNS 服务器</p>
          </div>
          <label className="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              className="sr-only peer"
              checked={config.enable !== false}
              onChange={(e) => updateConfig('enable', e.target.checked)}
            />
            <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 dark:peer-focus:ring-blue-800 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-blue-600"></div>
          </label>
        </div>

        <div className="flex items-center justify-between">
          <div>
            <label className="text-sm font-medium text-gray-700 dark:text-gray-200">IPv6</label>
            <p className="text-xs text-gray-500 dark:text-gray-400">解析 IPv6 地址</p>
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

        <div className="flex items-center justify-between">
          <div>
            <label className="text-sm font-medium text-gray-700 dark:text-gray-200">增强模式</label>
            <p className="text-xs text-gray-500 dark:text-gray-400">DNS 增强模式</p>
          </div>
          <select
            className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-[#2a2a2a] text-gray-700 dark:text-gray-200"
            value={config['enhanced-mode'] || 'fake-ip'}
            onChange={(e) => updateConfig('enhanced-mode', e.target.value)}
          >
            <option value="normal">普通</option>
            <option value="fake-ip">Fake-IP</option>
            <option value="redir-host">Redir-Host</option>
          </select>
        </div>

        <div>
          <label className="text-sm font-medium text-gray-700 dark:text-gray-200">Fake-IP 范围</label>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">Fake-IP 模式的 IP 范围</p>
          <Input
            type="text"
            className="text-gray-900 dark:text-gray-100"
            placeholder="198.18.0.1/16"
            value={config['fake-ip-range'] || ''}
            onChange={(e) => updateConfig('fake-ip-range', e.target.value)}
          />
        </div>

        <div>
          <label className="text-sm font-medium text-gray-700 dark:text-gray-200">Fake-IP 过滤</label>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">排除在 Fake-IP 之外的域名（每行一个）</p>
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
            <label className="text-sm font-medium text-gray-700 dark:text-gray-200">遵守规则</label>
            <p className="text-xs text-gray-500 dark:text-gray-400">使用基于规则的 DNS 解析</p>
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
            <label className="text-sm font-medium text-gray-700 dark:text-gray-200">使用系统 Hosts</label>
            <p className="text-xs text-gray-500 dark:text-gray-400">使用系统 hosts 文件</p>
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
          <label className="text-sm font-medium text-gray-700 dark:text-gray-200">默认域名服务器</label>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">引导 DNS 服务器（每行一个）</p>
          <textarea
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-[#2a2a2a] text-gray-700 dark:text-gray-200 font-mono text-sm"
            rows={3}
            value={(config['default-nameserver'] || []).join('\n')}
            onChange={(e) => updateArrayConfig('default-nameserver', e.target.value)}
            placeholder="114.114.114.114&#10;8.8.8.8"
          />
        </div>

        <div>
          <label className="text-sm font-medium text-gray-700 dark:text-gray-200">域名服务器</label>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">主 DNS 服务器（每行一个）</p>
          <textarea
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-[#2a2a2a] text-gray-700 dark:text-gray-200 font-mono text-sm"
            rows={4}
            value={(config.nameserver || []).join('\n')}
            onChange={(e) => updateArrayConfig('nameserver', e.target.value)}
            placeholder="https://doh.pub/dns-query&#10;https://dns.alidns.com/dns-query"
          />
        </div>

        <div>
          <label className="text-sm font-medium text-gray-700 dark:text-gray-200">代理服务器域名服务器</label>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">代理服务器的 DNS（每行一个）</p>
          <textarea
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-[#2a2a2a] text-gray-700 dark:text-gray-200 font-mono text-sm"
            rows={3}
            value={(config['proxy-server-nameserver'] || []).join('\n')}
            onChange={(e) => updateArrayConfig('proxy-server-nameserver', e.target.value)}
            placeholder="https://doh.pub/dns-query"
          />
        </div>

        <div>
          <label className="text-sm font-medium text-gray-700 dark:text-gray-200">直连域名服务器</label>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">直连连接的 DNS（每行一个）</p>
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
            <label className="text-sm font-medium text-gray-700 dark:text-gray-200">自定义 Hosts</label>
            <p className="text-xs text-gray-500 dark:text-gray-400">启用自定义 hosts 映射</p>
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
            <label className="text-sm font-medium text-gray-700 dark:text-gray-200">Hosts 映射</label>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">格式：域名=IP（每行一个）</p>
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
  );
});

DnsSettings.displayName = 'DnsSettings';

export default DnsSettings;

