'use client';

import React, { useEffect, useState, useImperativeHandle, forwardRef } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { showToast } from './ui/toast';
import { Badge } from './ui/badge';

export interface KernelSettingsRef {
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

const KernelSettings = forwardRef<KernelSettingsRef>((props, ref) => {
  const [config, setConfig] = useState<KernelConfig>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<'basic' | 'port' | 'controller' | 'advanced'>('basic');

  // 加载配置
  useEffect(() => {
    loadConfig();
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

  const saveConfig = async () => {
    try {
      setSaving(true);
      if (window.electronAPI?.saveKernelConfig) {
        const result = await window.electronAPI.saveKernelConfig(config);
        if (result.success) {
          showToast({ message: '保存成功，需要重启内核才能生效', type: 'success' });
        } else {
          showToast({ message: '保存失败: ' + result.error, type: 'error' });
        }
      }
    } catch (error) {
      console.error('保存内核配置失败:', error);
      showToast({ message: '保存失败: ' + error, type: 'error' });
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
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">RESTful API 监听地址</p>
              <Input
                type="text"
                className="text-gray-900 dark:text-gray-100"
                placeholder="127.0.0.1:9090"
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

KernelSettings.displayName = 'KernelSettings';

export default KernelSettings;
