'use client';

import React, { useEffect, useState, useImperativeHandle, forwardRef } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { showToast } from './ui/toast';
import { Badge } from './ui/badge';

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
      console.error('加载内核配置失败:', error);
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
      console.error('加载DNS配置失败:', error);
    }
  };

  const saveConfig = async () => {
    try {
      setSaving(true);

      // 保存内核配置
      if (window.electronAPI?.saveKernelConfig) {
        const kernelResult = await window.electronAPI.saveKernelConfig(config);
        if (!kernelResult.success) {
          const errorMsg = '内核配置保存失败: ' + kernelResult.error;
          showToast({ message: errorMsg, type: 'error' });
          throw new Error(errorMsg);
        }
      }

      // 保存DNS配置
      if (window.electronAPI?.saveDnsConfig) {
        const dnsResult = await window.electronAPI.saveDnsConfig(dnsConfig);
        if (!dnsResult.success) {
          const errorMsg = 'DNS配置保存失败: ' + dnsResult.error;
          showToast({ message: errorMsg, type: 'error' });
          throw new Error(errorMsg);
        }

        // 保存Hosts配置
        if (dnsConfig['use-hosts'] && window.electronAPI?.saveHostsConfig) {
          await window.electronAPI.saveHostsConfig(hostsConfig.hosts || []);
        }
      }

      showToast({ message: '所有配置保存成功，内核已自动重启', type: 'success' });
    } catch (error) {
      console.error('保存配置失败:', error);
      const errorMsg = '保存配置失败: ' + error;
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
    const items = value.split('\n').filter(item => item.trim());
    setDnsConfig(prev => ({ ...prev, [key]: items }));
  };

  // 暴露 saveConfig 方法给父组件
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
          基础设置
        </button>
        <button
          className={`px-4 py-2 text-sm font-medium transition-colors ${
            activeTab === 'port'
              ? 'border-b-2 border-blue-500 text-blue-600 dark:text-blue-400'
              : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
          }`}
          onClick={() => setActiveTab('port')}
        >
          端口设置
        </button>
        <button
          className={`px-4 py-2 text-sm font-medium transition-colors ${
            activeTab === 'controller'
              ? 'border-b-2 border-blue-500 text-blue-600 dark:text-blue-400'
              : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
          }`}
          onClick={() => setActiveTab('controller')}
        >
          控制器设置
        </button>
        <button
          className={`px-4 py-2 text-sm font-medium transition-colors ${
            activeTab === 'dns'
              ? 'border-b-2 border-blue-500 text-blue-600 dark:text-blue-400'
              : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
          }`}
          onClick={() => setActiveTab('dns')}
        >
          DNS设置
        </button>
        <button
          className={`px-4 py-2 text-sm font-medium transition-colors ${
            activeTab === 'advanced'
              ? 'border-b-2 border-blue-500 text-blue-600 dark:text-blue-400'
              : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
          }`}
          onClick={() => setActiveTab('advanced')}
        >
          高级设置
        </button>
      </div>

      {/* 基础设置 */}
      {activeTab === 'basic' && (
        <div className="space-y-4">
            {/* IPv6 */}
            <div className="flex items-center justify-between">
              <div>
                <label className="text-sm font-medium text-gray-700 dark:text-gray-200">IPv6</label>
                <p className="text-xs text-gray-500 dark:text-gray-400">启用 IPv6 支持</p>
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
                <label className="text-sm font-medium text-gray-700 dark:text-gray-200">日志等级</label>
                <p className="text-xs text-gray-500 dark:text-gray-400">设置日志输出级别</p>
              </div>
              <select
                className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-[#2a2a2a] text-gray-700 dark:text-gray-200"
                value={config['log-level'] || 'info'}
                onChange={(e) => updateConfig('log-level', e.target.value)}
              >
                <option value="silent">静默</option>
                <option value="error">错误</option>
                <option value="warning">警告</option>
                <option value="info">信息</option>
                <option value="debug">调试</option>
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
                <label className="text-sm font-medium text-gray-700 dark:text-gray-200">混合端口</label>
                <p className="text-xs text-gray-500 dark:text-gray-400">HTTP(S) 和 SOCKS5 混合端口</p>
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
                <label className="text-sm font-medium text-gray-700 dark:text-gray-200">Socks 端口</label>
                <p className="text-xs text-gray-500 dark:text-gray-400">SOCKS5 代理端口（0 表示禁用）</p>
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
                <label className="text-sm font-medium text-gray-700 dark:text-gray-200">HTTP 端口</label>
                <p className="text-xs text-gray-500 dark:text-gray-400">HTTP 代理端口（0 表示禁用）</p>
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
                <label className="text-sm font-medium text-gray-700 dark:text-gray-200">允许局域网连接</label>
                <p className="text-xs text-gray-500 dark:text-gray-400">允许其他设备通过局域网连接</p>
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
                  <label className="text-sm font-medium text-gray-700 dark:text-gray-200">允许连接的 IP 段</label>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">每行一个 IP 段（如 192.168.1.0/24）</p>
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
                  <label className="text-sm font-medium text-gray-700 dark:text-gray-200">禁止连接的 IP 段</label>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">每行一个 IP 段（如 192.168.1.0/24）</p>
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
              <label className="text-sm font-medium text-gray-700 dark:text-gray-200">用户验证</label>
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">每行一个用户（格式：用户名:密码）</p>
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
              <label className="text-sm font-medium text-gray-700 dark:text-gray-200">允许跳过验证的 IP 段</label>
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">每行一个 IP 段</p>
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
              <label className="text-sm font-medium text-gray-700 dark:text-gray-200">外部控制器地址</label>
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">RESTful API 监听地址 (留空则不启动外部控制器)</p>
              <Input
                type="text"
                className="text-gray-900 dark:text-gray-100"
                placeholder="留空不启动,例如: 127.0.0.1:9090"
                value={config['external-controller'] || ''}
                onChange={(e) => updateConfig('external-controller', e.target.value)}
              />
            </div>

            {/* Secret */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <div>
                  <label className="text-sm font-medium text-gray-700 dark:text-gray-200">访问密钥</label>
                  <p className="text-xs text-gray-500 dark:text-gray-400">RESTful API 访问密钥</p>
                </div>
                <Button
                  onClick={() => {
                    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
                    const randomSecret = Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
                    updateConfig('secret', randomSecret);
                  }}
                  className="px-3 py-1 text-xs bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200 rounded transition-colors"
                >
                  生成密钥
                </Button>
              </div>
              <Input
                type="text"
                className="text-gray-900 dark:text-gray-100"
                placeholder="留空表示不设置密钥"
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
              <label className="text-sm font-medium text-gray-700 dark:text-gray-200">启用 DNS</label>
              <p className="text-xs text-gray-500 dark:text-gray-400">启用内置 DNS 服务器</p>
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
              <label className="text-sm font-medium text-gray-700 dark:text-gray-200">IPv6</label>
              <p className="text-xs text-gray-500 dark:text-gray-400">解析 IPv6 地址</p>
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
              <label className="text-sm font-medium text-gray-700 dark:text-gray-200">增强模式</label>
              <p className="text-xs text-gray-500 dark:text-gray-400">DNS 增强模式</p>
            </div>
            <select
              className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-[#2a2a2a] text-gray-700 dark:text-gray-200"
              value={dnsConfig['enhanced-mode'] || 'fake-ip'}
              onChange={(e) => updateDnsConfig('enhanced-mode', e.target.value)}
            >
              <option value="normal">普通</option>
              <option value="fake-ip">Fake-IP</option>
              <option value="redir-host">Redir-Host</option>
            </select>
          </div>

          {/* Fake-IP 范围 */}
          <div>
            <label className="text-sm font-medium text-gray-700 dark:text-gray-200">Fake-IP 范围</label>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">Fake-IP 模式的 IP 范围</p>
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
            <label className="text-sm font-medium text-gray-700 dark:text-gray-200">Fake-IP 过滤</label>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">排除在 Fake-IP 之外的域名（每行一个）</p>
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
              <label className="text-sm font-medium text-gray-700 dark:text-gray-200">遵守规则</label>
              <p className="text-xs text-gray-500 dark:text-gray-400">使用基于规则的 DNS 解析</p>
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
              <label className="text-sm font-medium text-gray-700 dark:text-gray-200">使用系统 Hosts</label>
              <p className="text-xs text-gray-500 dark:text-gray-400">使用系统 hosts 文件</p>
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
            <label className="text-sm font-medium text-gray-700 dark:text-gray-200">默认域名服务器</label>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">引导 DNS 服务器（每行一个）</p>
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
            <label className="text-sm font-medium text-gray-700 dark:text-gray-200">域名服务器</label>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">主 DNS 服务器（每行一个）</p>
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
            <label className="text-sm font-medium text-gray-700 dark:text-gray-200">代理服务器域名服务器</label>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">代理服务器的 DNS（每行一个）</p>
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
            <label className="text-sm font-medium text-gray-700 dark:text-gray-200">直连域名服务器</label>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">直连连接的 DNS（每行一个）</p>
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
              <label className="text-sm font-medium text-gray-700 dark:text-gray-200">自定义 Hosts</label>
              <p className="text-xs text-gray-500 dark:text-gray-400">启用自定义 hosts 映射</p>
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
      )}

      {/* 高级设置 */}
      {activeTab === 'advanced' && (
        <div className="space-y-4">
            {/* 存储选择节点 */}
            <div className="flex items-center justify-between">
              <div>
                <label className="text-sm font-medium text-gray-700 dark:text-gray-200">存储选择节点</label>
                <p className="text-xs text-gray-500 dark:text-gray-400">记住手动选择的节点</p>
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
                <label className="text-sm font-medium text-gray-700 dark:text-gray-200">存储 FakeIP</label>
                <p className="text-xs text-gray-500 dark:text-gray-400">持久化 FakeIP 映射</p>
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
                <label className="text-sm font-medium text-gray-700 dark:text-gray-200">使用 RTT 延迟测试</label>
                <p className="text-xs text-gray-500 dark:text-gray-400">使用统一延迟测试消除握手时间影响</p>
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
                <label className="text-sm font-medium text-gray-700 dark:text-gray-200">TCP 并发</label>
                <p className="text-xs text-gray-500 dark:text-gray-400">对多个 IP 地址进行 TCP 并发连接</p>
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
                <label className="text-sm font-medium text-gray-700 dark:text-gray-200">禁用 TCP Keep Alive</label>
                <p className="text-xs text-gray-500 dark:text-gray-400">禁用 TCP 保活机制</p>
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
                <label className="text-sm font-medium text-gray-700 dark:text-gray-200">TCP Keep Alive 间隔</label>
                <p className="text-xs text-gray-500 dark:text-gray-400">保活探测间隔时间（秒）</p>
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
                <label className="text-sm font-medium text-gray-700 dark:text-gray-200">TCP Keep Alive 空闲</label>
                <p className="text-xs text-gray-500 dark:text-gray-400">开始保活探测前的空闲时间（秒）</p>
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
                <label className="text-sm font-medium text-gray-700 dark:text-gray-200">uTLS 指纹</label>
                <p className="text-xs text-gray-500 dark:text-gray-400">TLS 客户端指纹伪装</p>
              </div>
              <select
                className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-[#2a2a2a] text-gray-700 dark:text-gray-200"
                value={config['global-client-fingerprint'] || ''}
                onChange={(e) => updateConfig('global-client-fingerprint', e.target.value)}
              >
                <option value="">禁用</option>
                <option value="random">随机</option>
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
                <label className="text-sm font-medium text-gray-700 dark:text-gray-200">查找进程模式</label>
                <p className="text-xs text-gray-500 dark:text-gray-400">追踪连接的进程信息</p>
              </div>
              <select
                className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-[#2a2a2a] text-gray-700 dark:text-gray-200"
                value={config['find-process-mode'] || 'strict'}
                onChange={(e) => updateConfig('find-process-mode', e.target.value)}
              >
                <option value="off">关闭</option>
                <option value="strict">自动</option>
                <option value="always">开启</option>
              </select>
            </div>

            {/* 指定出站接口 */}
            <div>
              <label className="text-sm font-medium text-gray-700 dark:text-gray-200">指定出站接口</label>
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">指定出站网络接口名称</p>
              <Input
                type="text"
                className="text-gray-900 dark:text-gray-100"
                placeholder="留空表示自动选择"
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
