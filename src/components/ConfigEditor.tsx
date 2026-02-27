'use client';

import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { Button } from './ui/button';
import { Switch } from './ui/switch';
import { Input } from './ui/input';
import { showToast } from './ui/toast';
import { useTranslation } from 'react-i18next';
import {
  DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove, SortableContext, useSortable, verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { FixedSizeList } from 'react-window';
import AutoSizer from 'react-virtualized-auto-sizer';
import {
  Settings2, Globe, Save, Loader2,
  Plus, Trash2, Network, Shield, Fingerprint, Cable,
  Server, Lock, ChevronRight, Users, List,
  Database, Search, ChevronDown, GripVertical, Zap, Link2,
} from 'lucide-react';

interface KernelConfig {
  mode?: 'rule' | 'global' | 'direct';
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
  fallback?: string[];
  'fallback-filter'?: {
    geoip?: boolean;
    'geoip-code'?: string;
    ipcidr?: string[];
    domain?: string[];
  };
}

type TabKey = 'general' | 'dns' | 'proxies' | 'proxy-groups' | 'rules' | 'providers';

const TAB_ICONS: Record<TabKey, React.ReactNode> = {
  general: <Settings2 className="w-4 h-4" />,
  dns: <Globe className="w-4 h-4" />,
  proxies: <Zap className="w-4 h-4" />,
  'proxy-groups': <Users className="w-4 h-4" />,
  rules: <List className="w-4 h-4" />,
  providers: <Database className="w-4 h-4" />,
};

// Section card wrapper
function SectionCard({ icon, title, desc, children, action }: { icon: React.ReactNode; title: string; desc?: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="rounded-2xl bg-white px-5 py-4 shadow-sm dark:bg-[#2a2a2a]">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="text-blue-500">{icon}</span>
          <div className="min-w-0">
            <h3 className="text-sm font-medium text-gray-700 dark:text-gray-200">{title}</h3>
            {desc && <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5 truncate">{desc}</p>}
          </div>
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      <div className="space-y-4">{children}</div>
    </div>
  );
}

// Setting row
function SettingRow({ label, desc, children }: { label: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <span className="text-sm font-medium text-gray-700 dark:text-gray-200">{label}</span>
        {desc && <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">{desc}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

// Styled select
function StyledSelect({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (
    <select
      className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-[#2a2a2a] text-gray-700 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500/40 transition-all"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

// Styled textarea
function StyledTextarea({ value, onChange, placeholder, rows = 3 }: { value: string; onChange: (v: string) => void; placeholder?: string; rows?: number }) {
  return (
    <textarea
      className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-[#2a2a2a] text-gray-700 dark:text-gray-200 font-mono placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500/40 transition-all resize-none"
      rows={rows}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
    />
  );
}

// Field label wrapper
function FieldLabel({ label, desc, children }: { label: string; desc?: string; children: React.ReactNode }) {
  return (
    <div>
      <span className="text-xs font-medium text-gray-500 dark:text-gray-400">{label}</span>
      {desc && <p className="text-[11px] text-gray-400 dark:text-gray-500">{desc}</p>}
      <div className="mt-1">{children}</div>
    </div>
  );
}

// Compact switch with label
function MiniSwitch({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 cursor-pointer select-none">
      <Switch checked={checked} onCheckedChange={onChange} />
      <span className="text-xs text-gray-600 dark:text-gray-300">{label}</span>
    </label>
  );
}

// Empty state placeholder
function EmptyState({ text }: { text: string }) {
  return <div className="text-center py-8 text-gray-400 dark:text-gray-500 text-sm">{text}</div>;
}

// Expandable card for providers
function ExpandableCard({ title, badge, expanded, onToggle, onRemove, children }: { title: string; badge: string; expanded: boolean; onToggle: () => void; onRemove: () => void; children: React.ReactNode }) {
  return (
    <div className="rounded-lg bg-gray-50 dark:bg-[#1f1f1f] overflow-hidden transition-colors">
      <div className="flex items-center gap-2 px-3 py-2.5 cursor-pointer select-none" onClick={onToggle}>
        <ChevronDown className={`w-3.5 h-3.5 text-gray-400 transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`} />
        <span className="text-sm font-medium text-gray-700 dark:text-gray-200 truncate flex-1">{title}</span>
        <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">{badge}</span>
        <button onClick={(e) => { e.stopPropagation(); onRemove(); }} className="p-1 rounded hover:bg-red-50 dark:hover:bg-red-900/20 text-gray-300 hover:text-red-500 transition-colors">
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
      {expanded && children}
    </div>
  );
}

interface ConfigEditorProps {
  configPath?: string;
  onSaved?: () => void;
}

export default function ConfigEditor({ configPath, onSaved }: ConfigEditorProps) {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<TabKey>('general');
  const [config, setConfig] = useState<KernelConfig>({});
  const [dnsConfig, setDnsConfig] = useState<DnsConfig>({});
  const [proxyGroups, setProxyGroups] = useState<any[]>([]);
  const [rules, setRules] = useState<string[]>([]);
  const [proxies, setProxies] = useState<any[]>([]);
  const [proxyProviders, setProxyProviders] = useState<Record<string, any>>({});
  const [ruleProviders, setRuleProviders] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const tabs: { key: TabKey; label: string }[] = [
    { key: 'general', label: t('configEditor.general') },
    { key: 'dns', label: t('configEditor.dns') },
    ...(configPath ? [
      { key: 'proxies' as TabKey, label: t('configEditor.proxies') },
      { key: 'proxy-groups' as TabKey, label: t('configEditor.proxyGroups') },
      { key: 'rules' as TabKey, label: t('configEditor.rules') },
      { key: 'providers' as TabKey, label: t('configEditor.providers') },
    ] : []),
  ];

  // Load all configs on mount or when configPath changes
  useEffect(() => {
    loadAllConfigs();
  }, [configPath]);

  const loadAllConfigs = async () => {
    setLoading(true);
    try {
      const api = window.electronAPI;
      if (!api) return;

      const promises: Promise<any>[] = [
        api.getKernelConfig?.(configPath),
        api.getDnsConfig?.(configPath),
      ];

      if (configPath) {
        promises.push(
          api.getProxyGroupsConfig?.(configPath),
          api.getRulesConfig?.(configPath),
          api.getProvidersConfig?.(configPath),
          api.getProxiesConfig?.(configPath),
        );
      }

      const results = await Promise.all(promises);
      const [kernelRes, dnsRes, groupsRes, rulesRes, providersRes, proxiesRes] = results;

      if (kernelRes?.success) setConfig(kernelRes.config || {});
      if (dnsRes?.success) setDnsConfig(dnsRes.config || {});
      if (groupsRes?.success) setProxyGroups(groupsRes.groups || []);
      if (rulesRes?.success) setRules(rulesRes.rules || []);
      if (providersRes?.success) {
        setProxyProviders(providersRes.proxyProviders || {});
        setRuleProviders(providersRes.ruleProviders || {});
      }
      if (proxiesRes?.success) setProxies(proxiesRes.proxies || []);
    } catch (err) {
      console.error('Failed to load configs:', err);
      showToast({ message: t('configEditor.loadFailed'), type: 'error' });
    } finally {
      setLoading(false);
    }
  };

  const handleSaveAll = async () => {
    setSaving(true);
    try {
      const api = window.electronAPI;
      if (!api) return;

      // Clean DNS arrays
      const cleanDns = { ...dnsConfig };
      const arrFields: (keyof DnsConfig)[] = ['default-nameserver', 'nameserver', 'proxy-server-nameserver', 'direct-nameserver', 'fake-ip-filter'];
      arrFields.forEach((f) => {
        if (Array.isArray(cleanDns[f])) {
          (cleanDns as any)[f] = (cleanDns[f] as string[]).filter((s) => s.trim());
        }
      });

      if (configPath) {
        // All sections write to the subscription YAML file
        const cleanGroups = proxyGroups.map((g) => ({
          ...g,
          proxies: (g.proxies || []).filter((s: string) => s.trim()),
          use: (g.use || []).filter((s: string) => s.trim()),
        }));
        const groupsRes = await api.saveProxyGroupsConfig?.(cleanGroups, configPath);
        if (groupsRes && !groupsRes.success) throw new Error(groupsRes.error);

        const rulesRes = await api.saveRulesConfig?.(rules, configPath);
        if (rulesRes && !rulesRes.success) throw new Error(rulesRes.error);

        const providersRes = await api.saveProvidersConfig?.(proxyProviders, ruleProviders, configPath);
        if (providersRes && !providersRes.success) throw new Error(providersRes.error);

        const proxiesRes = await api.saveProxiesConfig?.(proxies, configPath);
        if (proxiesRes && !proxiesRes.success) throw new Error(proxiesRes.error);

        const kernelRes = await api.saveKernelConfig?.(config, configPath);
        if (kernelRes && !kernelRes.success) throw new Error(kernelRes.error);

        const dnsRes = await api.saveDnsConfig?.(cleanDns, configPath);
        if (dnsRes && !dnsRes.success) throw new Error(dnsRes.error);

        // Hot reload to apply changes
        if (api.reloadMihomoConfig) {
          await api.reloadMihomoConfig(configPath);
        }
      } else {
        // No configPath: save kernel & DNS to user settings (triggers restart internally)
        const kernelRes = await api.saveKernelConfig?.(config);
        if (kernelRes && !kernelRes.success) throw new Error(kernelRes.error);

        const dnsRes = await api.saveDnsConfig?.(cleanDns);
        if (dnsRes && !dnsRes.success) throw new Error(dnsRes.error);
      }

      showToast({ message: t('configEditor.saveSuccess'), type: 'success' });
      onSaved?.();
    } catch (err: any) {
      showToast({ message: `${t('configEditor.saveFailed')}: ${err?.message || err}`, type: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const updateConfig = useCallback((key: keyof KernelConfig, value: any) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
  }, []);

  const updateProfileConfig = useCallback((key: string, value: boolean) => {
    setConfig((prev) => ({ ...prev, profile: { ...prev.profile, [key]: value } }));
  }, []);

  const updateDns = useCallback((key: keyof DnsConfig, value: any) => {
    setDnsConfig((prev) => ({ ...prev, [key]: value }));
  }, []);

  const updateDnsArray = useCallback((key: keyof DnsConfig, raw: string) => {
    setDnsConfig((prev) => ({ ...prev, [key]: raw.split('\n') }));
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-6 h-6 animate-spin text-blue-500" />
      </div>
    );
  }

  return (
    <div className="relative">
      {/* Tab navigation */}
      <div className="sticky top-0 z-10 flex border-b border-gray-200 dark:border-gray-600 overflow-x-auto flex-nowrap bg-white dark:bg-[#2a2a2a] -mx-6 px-6">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-all whitespace-nowrap ${
              activeTab === tab.key
                ? 'border-blue-500 text-blue-500'
                : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
            }`}
          >
            {TAB_ICONS[tab.key]}
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="space-y-5 pt-5">
        {activeTab === 'general' && <GeneralTab config={config} updateConfig={updateConfig} updateProfileConfig={updateProfileConfig} t={t} />}
        {activeTab === 'dns' && <DnsTab dnsConfig={dnsConfig} updateDns={updateDns} updateDnsArray={updateDnsArray} t={t} />}
        {activeTab === 'proxies' && <ProxiesTab proxies={proxies} setProxies={setProxies} proxyGroups={proxyGroups} setProxyGroups={setProxyGroups} t={t} />}
        {activeTab === 'proxy-groups' && <ProxyGroupsTab groups={proxyGroups} setGroups={setProxyGroups} t={t} />}
        {activeTab === 'rules' && <RulesTab rules={rules} setRules={setRules} t={t} />}
        {activeTab === 'providers' && <ProvidersTab proxyProviders={proxyProviders} setProxyProviders={setProxyProviders} ruleProviders={ruleProviders} setRuleProviders={setRuleProviders} t={t} />}
      </div>

      {/* Floating save button */}
      <button
        onClick={handleSaveAll}
        disabled={saving}
        className="sticky bottom-4 float-right mr-0 w-12 h-12 rounded-full bg-blue-500 hover:bg-blue-600 active:bg-blue-700 text-white shadow-lg flex items-center justify-center transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        title={saving ? t('configEditor.saving') : t('configEditor.saveAll')}
      >
        {saving ? <Loader2 className="w-5 h-5 animate-spin" /> : <Save className="w-5 h-5" />}
      </button>
    </div>
  );
}

// ==================== General Settings Tab ====================
function GeneralTab({ config, updateConfig, updateProfileConfig, t }: {
  config: KernelConfig;
  updateConfig: (k: keyof KernelConfig, v: any) => void;
  updateProfileConfig: (k: string, v: boolean) => void;
  t: any;
}) {
  return (
    <>
      {/* Basic & Network */}
      <SectionCard icon={<Settings2 className="w-4 h-4" />} title={t('overrideSettings.basic')}>
        <SettingRow label={t('overrideSettings.ipv6')} desc={t('overrideSettings.ipv6Desc')}>
          <Switch checked={config.ipv6 || false} onCheckedChange={(v) => updateConfig('ipv6', v)} />
        </SettingRow>
        <SettingRow label={t('overrideSettings.logLevel')} desc={t('overrideSettings.logLevelDesc')}>
          <StyledSelect
            value={config['log-level'] || 'info'}
            onChange={(v) => updateConfig('log-level', v)}
            options={[
              { value: 'silent', label: t('overrideSettings.silent') },
              { value: 'error', label: t('overrideSettings.error') },
              { value: 'warning', label: t('overrideSettings.warning') },
              { value: 'info', label: t('overrideSettings.info') },
              { value: 'debug', label: t('overrideSettings.debug') },
            ]}
          />
        </SettingRow>
        <SettingRow label={t('overrideSettings.allowLan')} desc={t('overrideSettings.allowLanDesc')}>
          <Switch checked={config['allow-lan'] || false} onCheckedChange={(v) => updateConfig('allow-lan', v)} />
        </SettingRow>
        {config['allow-lan'] && (
          <>
            <div>
              <span className="text-sm font-medium text-gray-700 dark:text-gray-200">{t('overrideSettings.lanAllowedIps')}</span>
              <p className="text-xs text-gray-400 dark:text-gray-500 mb-2">{t('overrideSettings.lanAllowedIpsDesc')}</p>
              <StyledTextarea
                value={(config['lan-allowed-ips'] || []).join('\n')}
                onChange={(v) => updateConfig('lan-allowed-ips', v.split('\n').filter((s) => s.trim()))}
                placeholder="192.168.1.0/24&#10;10.0.0.0/8"
              />
            </div>
            <div>
              <span className="text-sm font-medium text-gray-700 dark:text-gray-200">{t('overrideSettings.lanDisallowedIps')}</span>
              <p className="text-xs text-gray-400 dark:text-gray-500 mb-2">{t('overrideSettings.lanDisallowedIpsDesc')}</p>
              <StyledTextarea
                value={(config['lan-disallowed-ips'] || []).join('\n')}
                onChange={(v) => updateConfig('lan-disallowed-ips', v.split('\n').filter((s) => s.trim()))}
                placeholder="192.168.1.100/32"
              />
            </div>
          </>
        )}
      </SectionCard>

      {/* Port Settings */}
      <SectionCard icon={<Network className="w-4 h-4" />} title={t('overrideSettings.port')}>
        <SettingRow label={t('overrideSettings.mixedPort')} desc={t('overrideSettings.mixedPortDesc')}>
          <Input type="number" className="w-28 text-gray-700 dark:text-gray-200" value={config['mixed-port'] || 7890} onChange={(e) => updateConfig('mixed-port', parseInt(e.target.value))} />
        </SettingRow>
        <SettingRow label={t('overrideSettings.socksPort')} desc={t('overrideSettings.socksPortDesc')}>
          <Input type="number" className="w-28 text-gray-700 dark:text-gray-200" value={config['socks-port'] || 0} onChange={(e) => updateConfig('socks-port', parseInt(e.target.value))} />
        </SettingRow>
        <SettingRow label={t('overrideSettings.httpPort')} desc={t('overrideSettings.httpPortDesc')}>
          <Input type="number" className="w-28 text-gray-700 dark:text-gray-200" value={config.port || 0} onChange={(e) => updateConfig('port', parseInt(e.target.value))} />
        </SettingRow>
      </SectionCard>

      {/* Controller Settings */}
      <SectionCard icon={<Server className="w-4 h-4" />} title={t('overrideSettings.controller')}>
        <div>
          <span className="text-sm font-medium text-gray-700 dark:text-gray-200">{t('overrideSettings.externalController')}</span>
          <p className="text-xs text-gray-400 dark:text-gray-500 mb-2">{t('overrideSettings.externalControllerDesc')}</p>
          <Input type="text" className="text-gray-700 dark:text-gray-200" placeholder={t('overrideSettings.externalControllerPlaceholder')} value={config['external-controller'] || ''} onChange={(e) => updateConfig('external-controller', e.target.value)} />
        </div>
        <div>
          <div className="flex items-center justify-between mb-2">
            <div>
              <span className="text-sm font-medium text-gray-700 dark:text-gray-200">{t('overrideSettings.secret')}</span>
              <p className="text-xs text-gray-400 dark:text-gray-500">{t('overrideSettings.secretDesc')}</p>
            </div>
            <Button variant="ghost" size="sm" onClick={() => {
              const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
              updateConfig('secret', Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join(''));
            }}>
              <Lock className="w-3.5 h-3.5 mr-1" />{t('overrideSettings.generateSecret')}
            </Button>
          </div>
          <Input type="text" className="text-gray-700 dark:text-gray-200" placeholder={t('overrideSettings.secretPlaceholder')} value={config.secret || ''} onChange={(e) => updateConfig('secret', e.target.value)} />
        </div>
        <div>
          <span className="text-sm font-medium text-gray-700 dark:text-gray-200">{t('overrideSettings.authentication')}</span>
          <p className="text-xs text-gray-400 dark:text-gray-500 mb-2">{t('overrideSettings.authenticationDesc')}</p>
          <StyledTextarea
            value={(config.authentication || []).join('\n')}
            onChange={(v) => updateConfig('authentication', v.split('\n').filter((s) => s.trim()))}
            placeholder="user1:password1&#10;user2:password2"
          />
        </div>
        <div>
          <span className="text-sm font-medium text-gray-700 dark:text-gray-200">{t('overrideSettings.skipAuthPrefixes')}</span>
          <p className="text-xs text-gray-400 dark:text-gray-500 mb-2">{t('overrideSettings.skipAuthPrefixesDesc')}</p>
          <StyledTextarea
            rows={2}
            value={(config['skip-auth-prefixes'] || ['127.0.0.1/32']).join('\n')}
            onChange={(v) => updateConfig('skip-auth-prefixes', v.split('\n').filter((s) => s.trim()))}
            placeholder="127.0.0.1/32"
          />
        </div>
      </SectionCard>

      {/* Advanced Settings */}
      <SectionCard icon={<Shield className="w-4 h-4" />} title={t('overrideSettings.advanced')}>
        <SettingRow label={t('overrideSettings.storeSelected')} desc={t('overrideSettings.storeSelectedDesc')}>
          <Switch checked={config.profile?.['store-selected'] || false} onCheckedChange={(v) => updateProfileConfig('store-selected', v)} />
        </SettingRow>
        <SettingRow label={t('overrideSettings.storeFakeIp')} desc={t('overrideSettings.storeFakeIpDesc')}>
          <Switch checked={config.profile?.['store-fake-ip'] || false} onCheckedChange={(v) => updateProfileConfig('store-fake-ip', v)} />
        </SettingRow>
        <SettingRow label={t('overrideSettings.unifiedDelay')} desc={t('overrideSettings.unifiedDelayDesc')}>
          <Switch checked={config['unified-delay'] || false} onCheckedChange={(v) => updateConfig('unified-delay', v)} />
        </SettingRow>
        <SettingRow label={t('overrideSettings.tcpConcurrent')} desc={t('overrideSettings.tcpConcurrentDesc')}>
          <Switch checked={config['tcp-concurrent'] || false} onCheckedChange={(v) => updateConfig('tcp-concurrent', v)} />
        </SettingRow>
        <SettingRow label={t('overrideSettings.disableKeepAlive')} desc={t('overrideSettings.disableKeepAliveDesc')}>
          <Switch checked={config['disable-keep-alive'] || false} onCheckedChange={(v) => updateConfig('disable-keep-alive', v)} />
        </SettingRow>
        <SettingRow label={t('overrideSettings.keepAliveInterval')} desc={t('overrideSettings.keepAliveIntervalDesc')}>
          <Input type="number" className="w-28 text-gray-700 dark:text-gray-200" value={config['keep-alive-interval'] || 15} onChange={(e) => updateConfig('keep-alive-interval', parseInt(e.target.value))} />
        </SettingRow>
        <SettingRow label={t('overrideSettings.keepAliveIdle')} desc={t('overrideSettings.keepAliveIdleDesc')}>
          <Input type="number" className="w-28 text-gray-700 dark:text-gray-200" value={config['keep-alive-idle'] || 15} onChange={(e) => updateConfig('keep-alive-idle', parseInt(e.target.value))} />
        </SettingRow>
        <SettingRow label={t('overrideSettings.globalClientFingerprint')} desc={t('overrideSettings.globalClientFingerprintDesc')}>
          <StyledSelect
            value={config['global-client-fingerprint'] || ''}
            onChange={(v) => updateConfig('global-client-fingerprint', v)}
            options={[
              { value: '', label: t('overrideSettings.disabled') },
              { value: 'random', label: t('overrideSettings.random') },
              { value: 'chrome', label: 'Chrome' },
              { value: 'firefox', label: 'Firefox' },
              { value: 'safari', label: 'Safari' },
              { value: 'ios', label: 'iOS' },
              { value: 'android', label: 'Android' },
              { value: 'edge', label: 'Edge' },
              { value: '360', label: '360' },
              { value: 'qq', label: 'QQ' },
            ]}
          />
        </SettingRow>
        <SettingRow label={t('overrideSettings.findProcessMode')} desc={t('overrideSettings.findProcessModeDesc')}>
          <StyledSelect
            value={config['find-process-mode'] || 'strict'}
            onChange={(v) => updateConfig('find-process-mode', v)}
            options={[
              { value: 'off', label: t('overrideSettings.off') },
              { value: 'strict', label: t('overrideSettings.strict') },
              { value: 'always', label: t('overrideSettings.always') },
            ]}
          />
        </SettingRow>
        <div>
          <span className="text-sm font-medium text-gray-700 dark:text-gray-200">{t('overrideSettings.interfaceName')}</span>
          <p className="text-xs text-gray-400 dark:text-gray-500 mb-2">{t('overrideSettings.interfaceNameDesc')}</p>
          <Input type="text" className="text-gray-700 dark:text-gray-200" placeholder={t('overrideSettings.interfaceNamePlaceholder')} value={config['interface-name'] || ''} onChange={(e) => updateConfig('interface-name', e.target.value)} />
        </div>
      </SectionCard>
    </>
  );
}

// ==================== DNS Settings Tab ====================
function DnsTab({ dnsConfig, updateDns, updateDnsArray, t }: {
  dnsConfig: DnsConfig;
  updateDns: (k: keyof DnsConfig, v: any) => void;
  updateDnsArray: (k: keyof DnsConfig, v: string) => void;
  t: any;
}) {
  return (
    <>
      <SectionCard icon={<Globe className="w-4 h-4" />} title={t('overrideSettings.dns')}>
        <SettingRow label={t('overrideSettings.enableDns')} desc={t('overrideSettings.enableDnsDesc')}>
          <Switch checked={dnsConfig.enable !== false} onCheckedChange={(v) => updateDns('enable', v)} />
        </SettingRow>
        <SettingRow label={t('overrideSettings.dnsIpv6')} desc={t('overrideSettings.dnsIpv6Desc')}>
          <Switch checked={dnsConfig.ipv6 || false} onCheckedChange={(v) => updateDns('ipv6', v)} />
        </SettingRow>
        <SettingRow label={t('overrideSettings.enhancedMode')} desc={t('overrideSettings.enhancedModeDesc')}>
          <StyledSelect
            value={dnsConfig['enhanced-mode'] || 'fake-ip'}
            onChange={(v) => updateDns('enhanced-mode', v)}
            options={[
              { value: 'normal', label: t('overrideSettings.normal') },
              { value: 'fake-ip', label: t('overrideSettings.fakeIp') },
              { value: 'redir-host', label: t('overrideSettings.redirHost') },
            ]}
          />
        </SettingRow>
        <div>
          <span className="text-sm font-medium text-gray-700 dark:text-gray-200">{t('overrideSettings.fakeIpRange')}</span>
          <p className="text-xs text-gray-400 dark:text-gray-500 mb-2">{t('overrideSettings.fakeIpRangeDesc')}</p>
          <Input type="text" className="text-gray-700 dark:text-gray-200" placeholder="198.18.0.1/16" value={dnsConfig['fake-ip-range'] || ''} onChange={(e) => updateDns('fake-ip-range', e.target.value)} />
        </div>
        <div>
          <span className="text-sm font-medium text-gray-700 dark:text-gray-200">{t('overrideSettings.fakeIpFilter')}</span>
          <p className="text-xs text-gray-400 dark:text-gray-500 mb-2">{t('overrideSettings.fakeIpFilterDesc')}</p>
          <StyledTextarea
            rows={4}
            value={(dnsConfig['fake-ip-filter'] || []).join('\n')}
            onChange={(v) => updateDnsArray('fake-ip-filter', v)}
            placeholder="*.lan&#10;localhost.ptlogin2.qq.com"
          />
        </div>
        <SettingRow label={t('overrideSettings.respectRules')} desc={t('overrideSettings.respectRulesDesc')}>
          <Switch checked={dnsConfig['respect-rules'] || false} onCheckedChange={(v) => updateDns('respect-rules', v)} />
        </SettingRow>
        <SettingRow label={t('overrideSettings.useSystemHosts')} desc={t('overrideSettings.useSystemHostsDesc')}>
          <Switch checked={dnsConfig['use-system-hosts'] !== false} onCheckedChange={(v) => updateDns('use-system-hosts', v)} />
        </SettingRow>
      </SectionCard>

      <SectionCard icon={<Cable className="w-4 h-4" />} title={t('overrideSettings.defaultNameserver')} desc={t('overrideSettings.defaultNameserverDesc')}>
        <StyledTextarea
          value={(dnsConfig['default-nameserver'] || []).join('\n')}
          onChange={(v) => updateDnsArray('default-nameserver', v)}
          placeholder="114.114.114.114&#10;8.8.8.8"
        />
      </SectionCard>

      <SectionCard icon={<Globe className="w-4 h-4" />} title={t('overrideSettings.nameserver')} desc={t('overrideSettings.nameserverDesc')}>
        <StyledTextarea
          rows={4}
          value={(dnsConfig.nameserver || []).join('\n')}
          onChange={(v) => updateDnsArray('nameserver', v)}
          placeholder="https://doh.pub/dns-query&#10;https://dns.alidns.com/dns-query"
        />
      </SectionCard>

      <SectionCard icon={<Shield className="w-4 h-4" />} title={t('overrideSettings.proxyServerNameserver')} desc={t('overrideSettings.proxyServerNameserverDesc')}>
        <StyledTextarea
          value={(dnsConfig['proxy-server-nameserver'] || []).join('\n')}
          onChange={(v) => updateDnsArray('proxy-server-nameserver', v)}
          placeholder="https://doh.pub/dns-query"
        />
      </SectionCard>

      <SectionCard icon={<ChevronRight className="w-4 h-4" />} title={t('overrideSettings.directNameserver')} desc={t('overrideSettings.directNameserverDesc')}>
        <StyledTextarea
          value={(dnsConfig['direct-nameserver'] || []).join('\n')}
          onChange={(v) => updateDnsArray('direct-nameserver', v)}
          placeholder="https://doh.pub/dns-query"
        />
      </SectionCard>

      <SectionCard icon={<Fingerprint className="w-4 h-4" />} title={t('configEditor.nameserverPolicy')} desc={t('configEditor.nameserverPolicyDesc')}>
        <StyledTextarea
          rows={4}
          value={
            dnsConfig['nameserver-policy']
              ? Object.entries(dnsConfig['nameserver-policy']).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : v}`).join('\n')
              : ''
          }
          onChange={(raw) => {
            const policy: Record<string, string | string[]> = {};
            raw.split('\n').filter((l) => l.trim()).forEach((line) => {
              const idx = line.indexOf('=');
              if (idx > 0) {
                const key = line.slice(0, idx).trim();
                const val = line.slice(idx + 1).trim();
                policy[key] = val.includes(',') ? val.split(',').map((s) => s.trim()) : val;
              }
            });
            updateDns('nameserver-policy', policy);
          }}
          placeholder={t('configEditor.nameserverPolicyPlaceholder')}
        />
      </SectionCard>
    </>
  );
}

// ==================== Sortable Item Wrapper ====================
function SortableItem({ id, children }: { id: string; children: (props: { dragHandleProps: any; isDragging: boolean }) => React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const style: React.CSSProperties = {
    transform: CSS.Translate.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 50 : undefined,
    position: 'relative',
  };
  return (
    <div ref={setNodeRef} style={style}>
      {children({ dragHandleProps: { ...attributes, ...listeners }, isDragging })}
    </div>
  );
}

// ==================== Proxy Groups Tab ====================
function ProxyGroupsTab({ groups, setGroups, t }: {
  groups: any[];
  setGroups: React.Dispatch<React.SetStateAction<any[]>>;
  t: any;
}) {
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), useSensor(KeyboardSensor));
  const ids = useMemo(() => groups.map((_, i) => `pg-${i}`), [groups.length]);

  const addGroup = () => {
    setGroups((prev) => [{ name: '', type: 'select', proxies: [] }, ...prev]);
    setExpandedIdx(0);
  };
  const removeGroup = (idx: number) => {
    setGroups((prev) => prev.filter((_, i) => i !== idx));
    if (expandedIdx === idx) setExpandedIdx(null);
  };
  const updateGroup = (idx: number, key: string, value: any) => {
    setGroups((prev) => prev.map((g, i) => (i === idx ? { ...g, [key]: value } : g)));
  };
  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      const oldIdx = ids.indexOf(active.id as string);
      const newIdx = ids.indexOf(over.id as string);
      setGroups((prev) => arrayMove(prev, oldIdx, newIdx));
      if (expandedIdx === oldIdx) setExpandedIdx(newIdx);
      else if (expandedIdx !== null) {
        if (oldIdx < expandedIdx && newIdx >= expandedIdx) setExpandedIdx(expandedIdx - 1);
        else if (oldIdx > expandedIdx && newIdx <= expandedIdx) setExpandedIdx(expandedIdx + 1);
      }
    }
  };

  return (
    <SectionCard icon={<Users className="w-4 h-4" />} title={t('configEditor.proxyGroupsTitle')} desc={`${groups.length} ${t('configEditor.proxyGroupsCount')}`}
      action={<Button variant="ghost" size="sm" onClick={addGroup} className="gap-1.5 text-blue-500"><Plus className="w-3.5 h-3.5" />{t('configEditor.addProxyGroup')}</Button>}>
      {groups.length === 0 ? (
        <EmptyState text={t('configEditor.noProxyGroups')} />
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={ids} strategy={verticalListSortingStrategy}>
            <div className="space-y-2">
              {groups.map((group, idx) => (
                <SortableItem key={ids[idx]} id={ids[idx]}>
                  {({ dragHandleProps }) => (
                    <div className="rounded-lg bg-gray-50 dark:bg-[#1f1f1f] overflow-hidden transition-colors">
                      <div className="flex items-center gap-2 px-3 py-2.5 cursor-pointer select-none" onClick={() => setExpandedIdx(expandedIdx === idx ? null : idx)}>
                        <button {...dragHandleProps} className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 cursor-grab active:cursor-grabbing text-gray-300 dark:text-gray-600 hover:text-gray-500 dark:hover:text-gray-400 transition-colors" onClick={(e) => e.stopPropagation()}>
                          <GripVertical className="w-3.5 h-3.5" />
                        </button>
                        <ChevronDown className={`w-3.5 h-3.5 text-gray-400 transition-transform duration-200 ${expandedIdx === idx ? 'rotate-180' : ''}`} />
                        <span className="text-sm font-medium text-gray-700 dark:text-gray-200 truncate flex-1">{group.name || t('configEditor.unnamed')}</span>
                        <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">{group.type || 'select'}</span>
                        <span className="text-xs text-gray-400 tabular-nums">{(group.proxies || []).length}</span>
                        <button onClick={(e) => { e.stopPropagation(); removeGroup(idx); }} className="p-1 rounded hover:bg-red-50 dark:hover:bg-red-900/20 text-gray-300 dark:text-gray-600 hover:text-red-500 transition-colors">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                      {expandedIdx === idx && <ProxyGroupEditForm group={group} idx={idx} updateGroup={updateGroup} t={t} />}
                    </div>
                  )}
                </SortableItem>
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}
    </SectionCard>
  );
}

// Proxy Group inline edit form
function ProxyGroupEditForm({ group, idx, updateGroup, t }: { group: any; idx: number; updateGroup: (i: number, k: string, v: any) => void; t: any }) {
  return (
    <div className="px-4 pb-4 pt-2 space-y-3 border-t border-gray-200 dark:border-gray-700">
      <div className="grid grid-cols-2 gap-3">
        <FieldLabel label={t('configEditor.groupName')}>
          <Input type="text" className="text-gray-700 dark:text-gray-200 text-sm" value={group.name || ''} onChange={(e) => updateGroup(idx, 'name', e.target.value)} placeholder={t('configEditor.groupNamePlaceholder')} />
        </FieldLabel>
        <FieldLabel label={t('configEditor.groupType')}>
          <StyledSelect value={group.type || 'select'} onChange={(v) => updateGroup(idx, 'type', v)} options={[
            { value: 'select', label: 'Select' }, { value: 'url-test', label: 'URL Test' },
            { value: 'fallback', label: 'Fallback' }, { value: 'load-balance', label: 'Load Balance' },
          ]} />
        </FieldLabel>
      </div>
      {(group.type === 'url-test' || group.type === 'fallback' || group.type === 'load-balance') && (
        <div className="grid grid-cols-2 gap-3">
          <FieldLabel label={t('configEditor.groupUrl')}>
            <Input type="text" className="text-gray-700 dark:text-gray-200 text-sm" value={group.url || ''} onChange={(e) => updateGroup(idx, 'url', e.target.value)} placeholder="http://www.gstatic.com/generate_204" />
          </FieldLabel>
          <FieldLabel label={t('configEditor.groupInterval')}>
            <Input type="number" className="text-gray-700 dark:text-gray-200 text-sm" value={group.interval || 300} onChange={(e) => updateGroup(idx, 'interval', parseInt(e.target.value) || 300)} />
          </FieldLabel>
        </div>
      )}
      <div className="grid grid-cols-2 gap-3">
        <FieldLabel label={t('configEditor.groupTimeout')}>
          <Input type="number" className="text-gray-700 dark:text-gray-200 text-sm" value={group.timeout || 5000} onChange={(e) => updateGroup(idx, 'timeout', parseInt(e.target.value) || 5000)} />
        </FieldLabel>
        <FieldLabel label={t('configEditor.groupMaxFailed')}>
          <Input type="number" className="text-gray-700 dark:text-gray-200 text-sm" value={group['max-failed-times'] || 5} onChange={(e) => updateGroup(idx, 'max-failed-times', parseInt(e.target.value) || 5)} />
        </FieldLabel>
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        <MiniSwitch label={t('configEditor.groupLazy')} checked={group.lazy ?? true} onChange={(v) => updateGroup(idx, 'lazy', v)} />
        <MiniSwitch label={t('configEditor.groupDisableUdp')} checked={group['disable-udp'] || false} onChange={(v) => updateGroup(idx, 'disable-udp', v)} />
        <MiniSwitch label={t('configEditor.groupHidden')} checked={group.hidden || false} onChange={(v) => updateGroup(idx, 'hidden', v)} />
        <MiniSwitch label={t('configEditor.groupIncludeAll')} checked={group['include-all'] || false} onChange={(v) => updateGroup(idx, 'include-all', v)} />
        <MiniSwitch label={t('configEditor.groupIncludeAllProxies')} checked={group['include-all-proxies'] || false} onChange={(v) => updateGroup(idx, 'include-all-proxies', v)} />
        <MiniSwitch label={t('configEditor.groupIncludeAllProviders')} checked={group['include-all-providers'] || false} onChange={(v) => updateGroup(idx, 'include-all-providers', v)} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <FieldLabel label={t('configEditor.groupFilter')}>
          <Input type="text" className="text-gray-700 dark:text-gray-200 text-sm" value={group.filter || ''} onChange={(e) => updateGroup(idx, 'filter', e.target.value)} placeholder={t('configEditor.groupFilterPlaceholder')} />
        </FieldLabel>
        <FieldLabel label={t('configEditor.groupExcludeFilter')}>
          <Input type="text" className="text-gray-700 dark:text-gray-200 text-sm" value={group['exclude-filter'] || ''} onChange={(e) => updateGroup(idx, 'exclude-filter', e.target.value)} placeholder={t('configEditor.groupExcludeFilterPlaceholder')} />
        </FieldLabel>
      </div>
      <FieldLabel label={t('configEditor.groupProxies')} desc={t('configEditor.groupProxiesDesc')}>
        <StyledTextarea rows={3} value={(group.proxies || []).join('\n')} onChange={(v) => updateGroup(idx, 'proxies', v.split('\n'))} placeholder={t('configEditor.groupProxiesPlaceholder')} />
      </FieldLabel>
      <FieldLabel label={t('configEditor.groupUseProviders')} desc={t('configEditor.groupUseProvidersDesc')}>
        <StyledTextarea rows={2} value={(group.use || []).join('\n')} onChange={(v) => updateGroup(idx, 'use', v.split('\n'))} placeholder={t('configEditor.groupUseProvidersPlaceholder')} />
      </FieldLabel>
    </div>
  );
}

// ==================== Rules Tab (Virtualized) ====================
function RulesTab({ rules, setRules, t }: {
  rules: string[];
  setRules: React.Dispatch<React.SetStateAction<string[]>>;
  t: any;
}) {
  const [searchQuery, setSearchQuery] = useState('');
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editValue, setEditValue] = useState('');
  const [dragging, setDragging] = useState<{
    fromIdx: number;
    toIdx: number;
    pointerX: number;
    pointerY: number;
    text: string;
  } | null>(null);

  const listRef = useRef<FixedSizeList>(null);
  const listOuterRef = useRef<HTMLDivElement>(null);
  const dragLayerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ fromIdx: number; toIdx: number; text: string } | null>(null);

  const ITEM_HEIGHT = 36;
  const AUTO_SCROLL_EDGE = 36;
  const AUTO_SCROLL_STEP = 14;

  const filteredRules = useMemo(() => {
    const mapped = rules.map((r, i) => ({ rule: r, idx: i }));
    return searchQuery ? mapped.filter(({ rule }) => rule.toLowerCase().includes(searchQuery.toLowerCase())) : mapped;
  }, [rules, searchQuery]);

  const addRule = () => {
    setRules((prev) => ['DOMAIN-SUFFIX,,PROXY', ...prev]);
    setEditingIdx(0);
    setEditValue('DOMAIN-SUFFIX,,PROXY');
    listRef.current?.scrollToItem(0, 'start');
  };
  const removeRule = (idx: number) => {
    setRules((prev) => prev.filter((_, i) => i !== idx));
    if (editingIdx === idx) setEditingIdx(null);
  };
  const startEdit = (idx: number, value: string) => { setEditingIdx(idx); setEditValue(value); };
  const confirmEdit = () => {
    if (editingIdx !== null && editValue.trim()) {
      setRules((prev) => prev.map((r, i) => (i === editingIdx ? editValue.trim() : r)));
    }
    setEditingIdx(null);
  };

  const startDrag = useCallback((originalIdx: number, text: string, e: React.PointerEvent) => {
    if (searchQuery) return;
    e.preventDefault();
    const listEl = listOuterRef.current;
    if (!listEl || filteredRules.length === 0) return;
    dragRef.current = { fromIdx: originalIdx, toIdx: originalIdx, text };
    setDragging({ fromIdx: originalIdx, toIdx: originalIdx, pointerX: e.clientX, pointerY: e.clientY, text });

    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // Ignore pointer capture failures and fallback to document listeners.
    }

    const onMove = (ev: PointerEvent) => {
      const state = dragRef.current;
      if (!state) return;
      const rect = listEl.getBoundingClientRect();
      if (ev.clientY < rect.top + AUTO_SCROLL_EDGE) listEl.scrollTop -= AUTO_SCROLL_STEP;
      else if (ev.clientY > rect.bottom - AUTO_SCROLL_EDGE) listEl.scrollTop += AUTO_SCROLL_STEP;

      const relY = ev.clientY - rect.top + listEl.scrollTop;
      const fIdx = Math.min(Math.max(0, Math.floor(relY / ITEM_HEIGHT)), filteredRules.length - 1);
      const targetIdx = filteredRules[fIdx]?.idx ?? state.fromIdx;
      state.toIdx = targetIdx;

      setDragging({
        fromIdx: state.fromIdx,
        toIdx: state.toIdx,
        pointerX: ev.clientX,
        pointerY: ev.clientY,
        text: state.text,
      });
    };

    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      const state = dragRef.current;
      dragRef.current = null;
      setDragging(null);
      if (!state || state.fromIdx === state.toIdx) return;

      setRules((prev) => {
        const next = [...prev];
        const [item] = next.splice(state.fromIdx, 1);
        next.splice(state.toIdx, 0, item);
        return next;
      });
      setEditingIdx((prev) => {
        if (prev === null) return prev;
        if (prev === state.fromIdx) return state.toIdx;
        if (state.fromIdx < prev && state.toIdx >= prev) return prev - 1;
        if (state.fromIdx > prev && state.toIdx <= prev) return prev + 1;
        return prev;
      });
    };

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }, [searchQuery, filteredRules, setRules]);

  const sourceFilteredIdx = dragging ? filteredRules.findIndex(({ idx }) => idx === dragging.fromIdx) : -1;
  const targetFilteredIdx = dragging ? filteredRules.findIndex(({ idx }) => idx === dragging.toIdx) : -1;
  const insertAfter = sourceFilteredIdx >= 0 && targetFilteredIdx >= 0 && targetFilteredIdx > sourceFilteredIdx;
  const lineTop = targetFilteredIdx >= 0 ? (targetFilteredIdx + (insertAfter ? 1 : 0)) * ITEM_HEIGHT - (listOuterRef.current?.scrollTop || 0) : 0;
  const dragPreviewStyle = useMemo<React.CSSProperties | undefined>(() => {
    if (!dragging) return undefined;
    const layerRect = dragLayerRef.current?.getBoundingClientRect();
    if (!layerRect) return undefined;
    const relativeX = dragging.pointerX - layerRect.left;
    const relativeY = dragging.pointerY - layerRect.top;
    const nearRightEdge = relativeX > layerRect.width - 320;
    const clampedX = Math.min(Math.max(12, relativeX), layerRect.width - 12);
    const clampedY = Math.min(Math.max(12, relativeY), layerRect.height - 12);
    return {
      left: `${clampedX}px`,
      top: `${clampedY}px`,
      transform: nearRightEdge ? 'translate(calc(-100% - 14px), -50%)' : 'translate(14px, -50%)',
    };
  }, [dragging]);

  const RuleRow = useCallback(({ index, style }: { index: number; style: React.CSSProperties }) => {
    const { rule, idx } = filteredRules[index];
    const isEditing = editingIdx === idx;
    const canDrag = !searchQuery;
    const isDraggingSelf = dragging?.fromIdx === idx;
    const isDropTarget = dragging?.toIdx === idx && dragging?.fromIdx !== idx;
    return (
      <div style={style} className="px-1">
        <div className={`flex items-center gap-1 group rounded-md transition-colors h-[32px] ${isDropTarget ? 'bg-blue-50 dark:bg-blue-900/15' : 'hover:bg-gray-50 dark:hover:bg-[#1f1f1f]'} ${isDraggingSelf ? 'opacity-45' : ''}`}>
          <div
            onPointerDown={canDrag ? (e) => startDrag(idx, rule, e) : undefined}
            className={`shrink-0 p-1 rounded text-gray-300 dark:text-gray-600 transition-colors touch-none ${canDrag ? 'cursor-grab active:cursor-grabbing hover:bg-gray-200 dark:hover:bg-gray-700 hover:text-gray-500 dark:hover:text-gray-400' : 'opacity-30 cursor-not-allowed'}`}
          >
            <GripVertical className="w-3 h-3" />
          </div>
          {isEditing ? (
            <input type="text"
              className="flex-1 px-2.5 py-1 text-[13px] border border-blue-400 dark:border-blue-500 rounded-md bg-white dark:bg-[#2a2a2a] text-gray-700 dark:text-gray-200 font-mono focus:outline-none focus:ring-2 focus:ring-blue-500/20"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onBlur={confirmEdit}
              onKeyDown={(e) => { if (e.key === 'Enter') confirmEdit(); if (e.key === 'Escape') setEditingIdx(null); }}
              autoFocus />
          ) : (
            <span className="flex-1 px-2.5 py-1 text-[13px] font-mono text-gray-600 dark:text-gray-300 cursor-pointer rounded-md truncate"
              onClick={() => startEdit(idx, rule)}
              title={rule}>{rule}</span>
          )}
          <button onClick={() => removeRule(idx)}
            className="p-1 rounded hover:bg-red-50 dark:hover:bg-red-900/20 text-transparent group-hover:text-gray-300 dark:group-hover:text-gray-600 hover:!text-red-500 transition-colors shrink-0">
            <Trash2 className="w-3 h-3" />
          </button>
        </div>
      </div>
    );
  }, [filteredRules, editingIdx, editValue, searchQuery, dragging, startDrag]);

  return (
    <SectionCard icon={<List className="w-4 h-4" />} title={t('configEditor.rulesTitle')} desc={`${rules.length} ${t('configEditor.rulesCount')}`}
      action={<Button variant="ghost" size="sm" onClick={addRule} className="gap-1.5 text-blue-500"><Plus className="w-3.5 h-3.5" />{t('configEditor.addRule')}</Button>}>
      <div className="relative -mt-1 mb-2">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 dark:text-gray-500" />
        <input type="text" className="w-full pl-9 pr-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-[#2a2a2a] text-gray-700 dark:text-gray-200 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500/40 transition-all" placeholder={t('configEditor.searchRules')} value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} />
      </div>
      <div ref={dragLayerRef} className="h-[420px] relative">
        {filteredRules.length === 0 ? (
          <EmptyState text={t('configEditor.noRules')} />
        ) : (
          <AutoSizer>
            {({ height, width }: { height: number; width: number }) => (
              <div className="relative">
                <FixedSizeList
                  ref={listRef}
                  outerRef={listOuterRef}
                  height={height}
                  width={width}
                  itemCount={filteredRules.length}
                  itemSize={ITEM_HEIGHT}
                  className="custom-scrollbar"
                  overscanCount={10}
                >
                  {RuleRow}
                </FixedSizeList>
                {dragging && (
                  <div
                    className="absolute left-2 right-2 h-0.5 bg-blue-500 rounded-full pointer-events-none z-40"
                    style={{ top: `${Math.min(Math.max(0, lineTop), height)}px` }}
                  />
                )}
              </div>
            )}
          </AutoSizer>
        )}
        {dragging && (
          <div
            className="absolute pointer-events-none z-[90] max-w-[560px] px-2.5 py-1 rounded-md border border-blue-300/70 dark:border-blue-700/70 bg-white/95 dark:bg-[#2a2a2a]/95 text-[12px] font-mono text-gray-700 dark:text-gray-200 shadow-lg"
            style={dragPreviewStyle}
          >
            {dragging.text}
          </div>
        )}
      </div>
    </SectionCard>
  );
}

// ==================== Proxy URI Parser ====================
function b64Decode(s: string): string {
  try {
    const padded = s.replace(/-/g, '+').replace(/_/g, '/');
    const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
    return atob(padded + pad);
  } catch { return ''; }
}
function parseQS(qs: string): Record<string, string> {
  if (!qs) return {};
  const r: Record<string, string> = {};
  qs.split('&').filter(Boolean).forEach((p) => {
    const [k, ...v] = p.split('=');
    r[k] = v.length ? decodeURIComponent(v.join('=')) : 'true';
  });
  return r;
}
function isTruthy(v?: string) { return v === '1' || v === 'true' || v === 'TRUE'; }

function parseProxyURI(uri: string): any | null {
  uri = uri.trim();
  if (!uri.includes('://')) return null;
  const scheme = uri.substring(0, uri.indexOf('://'));
  const body = uri.substring(uri.indexOf('://') + 3);

  // --- SS ---
  if (scheme === 'ss') {
    const fragIdx = body.indexOf('#');
    const name = fragIdx >= 0 ? decodeURIComponent(body.substring(fragIdx + 1)) : '';
    const noFrag = fragIdx >= 0 ? body.substring(0, fragIdx) : body;
    const qIdx = noFrag.indexOf('?');
    const main = qIdx >= 0 ? noFrag.substring(0, qIdx) : noFrag;
    const qs = parseQS(qIdx >= 0 ? noFrag.substring(qIdx + 1) : '');
    let method = '', password = '', server = '', port = 443;
    const atIdx = main.lastIndexOf('@');
    if (atIdx >= 0) {
      const userInfo = main.substring(0, atIdx);
      const hostPort = main.substring(atIdx + 1);
      const decoded = userInfo.includes(':') ? userInfo : b64Decode(decodeURIComponent(userInfo));
      const ci = decoded.indexOf(':');
      method = ci >= 0 ? decoded.substring(0, ci) : decoded;
      password = ci >= 0 ? decoded.substring(ci + 1) : '';
      const li = hostPort.lastIndexOf(':');
      server = hostPort.substring(0, li);
      port = parseInt(hostPort.substring(li + 1)) || 443;
    } else {
      const decoded = b64Decode(main);
      const atI = decoded.lastIndexOf('@');
      if (atI < 0) return null;
      const ci = decoded.indexOf(':');
      method = decoded.substring(0, ci);
      password = decoded.substring(ci + 1, atI);
      const hp = decoded.substring(atI + 1);
      const li = hp.lastIndexOf(':');
      server = hp.substring(0, li);
      port = parseInt(hp.substring(li + 1)) || 443;
    }
    const proxy: any = { name, type: 'ss', server, port, cipher: method, password };
    if (isTruthy(qs['uot'])) proxy['udp-over-tcp'] = true;
    if (isTruthy(qs['tfo'])) proxy.tfo = true;
    // plugin
    if (qs['plugin']) {
      const parts = qs['plugin'].split(';');
      const pName = parts[0];
      const pOpts: any = {};
      parts.slice(1).forEach((p) => { const [k, ...v] = p.split('='); pOpts[k] = v.join('='); });
      if (pName.includes('obfs')) {
        proxy.plugin = 'obfs';
        proxy['plugin-opts'] = { mode: pOpts['obfs'] || pOpts['mode'] || 'http', host: pOpts['obfs-host'] || pOpts['host'] || '' };
      } else if (pName.includes('v2ray')) {
        proxy.plugin = 'v2ray-plugin';
        proxy['plugin-opts'] = { mode: 'websocket', host: pOpts['host'] || '', path: pOpts['path'] || '/' };
      } else if (pName.includes('shadow-tls')) {
        proxy.plugin = 'shadow-tls';
        proxy['plugin-opts'] = { host: pOpts['host'] || '', password: pOpts['password'] || '', version: parseInt(pOpts['version']) || 3 };
      }
    }
    return proxy;
  }

  // --- VMess ---
  if (scheme === 'vmess') {
    const qIdx = body.indexOf('?');
    const main = qIdx >= 0 ? body.substring(0, qIdx) : body;
    const decoded = b64Decode(main);
    if (!decoded) return null;
    try {
      const j = JSON.parse(decoded);
      const proxy: any = {
        name: j.ps || j.remarks || '', type: 'vmess',
        server: j.add || j.host || '', port: parseInt(j.port) || 443,
        uuid: j.id || '', alterId: parseInt(j.aid) || 0,
        cipher: ['auto','aes-128-gcm','chacha20-poly1305','none'].includes(j.scy) ? j.scy : 'auto',
      };
      const net = j.net || 'tcp';
      if (net !== 'tcp') proxy.network = net;
      if (j.tls === 'tls' || j.tls === true || j.tls === '1') proxy.tls = true;
      if (j.sni) proxy.sni = j.sni;
      if (isTruthy(String(j.allowInsecure))) proxy['skip-cert-verify'] = true;
      if (j.fp) proxy['client-fingerprint'] = j.fp;
      if (j.alpn) proxy.alpn = String(j.alpn).split(',').map((s: string) => s.trim()).filter(Boolean);
      if (net === 'ws') proxy['ws-opts'] = { path: j.path || '/', headers: j.host ? { Host: j.host } : undefined };
      if (net === 'h2') proxy['h2-opts'] = { path: j.path || '/', host: j.host ? j.host.split(',').map((s: string) => s.trim()) : undefined };
      if (net === 'grpc') proxy['grpc-opts'] = { 'grpc-service-name': j.path || '' };
      return proxy;
    } catch {
      // Shadowrocket format: base64(cipher:uuid@server:port)
      const m = decoded.match(/^(.*?):(.*?)@(.*?):(\d+)$/);
      if (!m) return null;
      const qs = parseQS(qIdx >= 0 ? body.substring(qIdx + 1) : '');
      return { name: qs['remarks'] || qs['remark'] || '', type: 'vmess', server: m[3], port: parseInt(m[4]) || 443, uuid: m[2], cipher: m[1] || 'auto', alterId: 0, tls: isTruthy(qs['tls']) || undefined, sni: qs['sni'] || undefined, network: qs['obfs'] || undefined };
    }
  }

  // --- VLESS ---
  if (scheme === 'vless') {
    const m = body.match(/^(.*?)@(.*?):(\d+)\/?(\?(.*?))?(?:#(.*?))?$/);
    if (!m) return null;
    const uuid = decodeURIComponent(m[1]);
    const server = m[2]; const port = parseInt(m[3]) || 443;
    const qs = parseQS(m[5] || '');
    const name = m[6] ? decodeURIComponent(m[6]) : '';
    const net = qs['type'] || 'tcp';
    const security = qs['security'] || '';
    const proxy: any = { name, type: 'vless', server, port, uuid };
    if (net !== 'tcp') proxy.network = net;
    if (qs['flow']) proxy.flow = qs['flow'];
    proxy.tls = security !== '' && security !== 'none';
    if (qs['sni'] || qs['peer']) proxy.sni = qs['sni'] || qs['peer'];
    if (isTruthy(qs['allowInsecure'])) proxy['skip-cert-verify'] = true;
    if (qs['fp']) proxy['client-fingerprint'] = qs['fp'];
    if (qs['alpn']) proxy.alpn = qs['alpn'].split(',').map((s: string) => s.trim()).filter(Boolean);
    if (net === 'ws') proxy['ws-opts'] = { path: qs['path'] || '/', headers: qs['host'] ? { Host: qs['host'] } : undefined };
    if (net === 'grpc') proxy['grpc-opts'] = { 'grpc-service-name': qs['serviceName'] || '' };
    if (security === 'reality') proxy['reality-opts'] = { 'public-key': qs['pbk'] || '', 'short-id': qs['sid'] || '' };
    return proxy;
  }

  // --- Trojan ---
  if (scheme === 'trojan') {
    const m = body.match(/^(.*?)@(.*?):(\d+)\/?(\?(.*?))?(?:#(.*?))?$/);
    if (!m) return null;
    const password = decodeURIComponent(m[1]);
    const server = m[2]; const port = parseInt(m[3]) || 443;
    const qs = parseQS(m[5] || '');
    const name = m[6] ? decodeURIComponent(m[6]) : '';
    const net = qs['type'] || 'tcp';
    const proxy: any = { name, type: 'trojan', server, port, password };
    if (net !== 'tcp') proxy.network = net;
    if (qs['sni'] || qs['peer']) proxy.sni = qs['sni'] || qs['peer'];
    if (isTruthy(qs['allowInsecure'])) proxy['skip-cert-verify'] = true;
    if (qs['fp']) proxy['client-fingerprint'] = qs['fp'];
    if (qs['alpn']) proxy.alpn = qs['alpn'].split(',').map((s: string) => s.trim()).filter(Boolean);
    if (net === 'ws') proxy['ws-opts'] = { path: qs['path'] || '/', headers: qs['host'] ? { Host: qs['host'] } : undefined };
    if (net === 'grpc') proxy['grpc-opts'] = { 'grpc-service-name': qs['serviceName'] || '' };
    return proxy;
  }

  // --- Hysteria2 / hy2 ---
  if (scheme === 'hysteria2' || scheme === 'hy2') {
    const m = body.match(/^(.*?)@(.*?)(?::(\d[\d,;-]*))?\/?\??([^#]*)(?:#(.*))?$/);
    if (!m) return null;
    const password = decodeURIComponent(m[1]);
    const server = m[2];
    const portSection = m[3] || '';
    const qs = parseQS(m[4] || '');
    const name = m[5] ? decodeURIComponent(m[5]) : '';
    let port = 443; let ports: string | undefined;
    if (/^\d+$/.test(portSection)) { port = parseInt(portSection); }
    else if (portSection) { ports = portSection; port = parseInt(portSection.split(/[-,;]/)[0]) || 443; }
    if (qs['mport'] && !ports) ports = qs['mport'];
    const proxy: any = { name, type: 'hysteria2', server, port, password };
    if (ports) proxy.ports = ports;
    if (qs['hop-interval'] || qs['hop_interval']) proxy['hop-interval'] = qs['hop-interval'] || qs['hop_interval'];
    if (qs['obfs'] && qs['obfs'] !== 'none') { proxy.obfs = qs['obfs']; if (qs['obfs-password']) proxy['obfs-password'] = qs['obfs-password']; }
    if (qs['sni'] || qs['peer']) proxy.sni = qs['sni'] || qs['peer'];
    if (isTruthy(qs['insecure'])) proxy['skip-cert-verify'] = true;
    if (qs['alpn']) proxy.alpn = qs['alpn'].split(',').map((s: string) => s.trim()).filter(Boolean);
    if (qs['up']) proxy.up = qs['up'];
    if (qs['down']) proxy.down = qs['down'];
    return proxy;
  }

  // --- Hysteria / hy ---
  if (scheme === 'hysteria' || scheme === 'hy') {
    const m = body.match(/^(.*?)(?::(\d+))?\/?(\?(.*?))?(?:#(.*))?$/);
    if (!m) return null;
    const server = m[1]; const port = parseInt(m[2]) || 443;
    const qs = parseQS(m[4] || '');
    const name = m[5] ? decodeURIComponent(m[5]) : '';
    const proxy: any = { name, type: 'hysteria', server, port };
    proxy.protocol = qs['protocol'] || 'udp';
    proxy.up = qs['upmbps'] || qs['up'] || '';
    proxy.down = qs['downmbps'] || qs['down'] || '';
    if (qs['auth'] || qs['auth-str']) proxy.auth = qs['auth'] || qs['auth-str'];
    if (qs['obfsParam']) proxy.obfs = qs['obfsParam'];
    if (qs['sni'] || qs['peer']) proxy.sni = qs['sni'] || qs['peer'];
    if (isTruthy(qs['insecure'])) proxy['skip-cert-verify'] = true;
    if (qs['alpn']) proxy.alpn = qs['alpn'].split(',').map((s: string) => s.trim()).filter(Boolean);
    return proxy;
  }

  // --- TUIC ---
  if (scheme === 'tuic') {
    const m = body.match(/^(.*?)@(.*?)(?::(\d+))?\/?(?:\?(.*?))?(?:#(.*))?$/);
    if (!m) return null;
    const auth = decodeURIComponent(m[1]);
    const ci = auth.indexOf(':');
    const uuid = ci >= 0 ? auth.substring(0, ci) : auth;
    const password = ci >= 0 ? auth.substring(ci + 1) : '';
    const server = m[2]; const port = parseInt(m[3]) || 443;
    const qs = parseQS(m[4] || '');
    const name = m[5] ? decodeURIComponent(m[5]) : '';
    const proxy: any = { name, type: 'tuic', server, port, uuid, password };
    if (qs['congestion-control'] || qs['congestion_control']) proxy['congestion-controller'] = qs['congestion-control'] || qs['congestion_control'];
    if (qs['udp-relay-mode'] || qs['udp_relay_mode']) proxy['udp-relay-mode'] = qs['udp-relay-mode'] || qs['udp_relay_mode'];
    if (qs['alpn']) proxy.alpn = qs['alpn'].split(',').map((s: string) => s.trim()).filter(Boolean);
    if (qs['sni']) proxy.sni = qs['sni'];
    if (isTruthy(qs['insecure']) || isTruthy(qs['allow-insecure'])) proxy['skip-cert-verify'] = true;
    if (isTruthy(qs['disable-sni'])) proxy['disable-sni'] = true;
    return proxy;
  }

  return null;
}

// ==================== Proxies Tab ====================
function ProxiesTab({ proxies, setProxies, proxyGroups, setProxyGroups, t }: {
  proxies: any[];
  setProxies: React.Dispatch<React.SetStateAction<any[]>>;
  proxyGroups: any[];
  setProxyGroups: React.Dispatch<React.SetStateAction<any[]>>;
  t: any;
}) {
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), useSensor(KeyboardSensor));

  const filtered = useMemo(() => {
    const mapped = proxies.map((p, i) => ({ proxy: p, idx: i }));
    return searchQuery ? mapped.filter(({ proxy }) => (proxy.name || '').toLowerCase().includes(searchQuery.toLowerCase()) || (proxy.type || '').toLowerCase().includes(searchQuery.toLowerCase())) : mapped;
  }, [proxies, searchQuery]);
  const ids = useMemo(() => filtered.map(({ idx }) => `proxy-${idx}`), [filtered]);

  const addProxy = () => {
    setProxies((prev) => [{ name: '', type: 'ss', server: '', port: 443, password: '' }, ...prev]);
    setExpandedIdx(0);
  };
  const importFromLinks = () => {
    const lines = importText.split('\n').map((l) => l.trim()).filter(Boolean);
    const parsed: any[] = [];
    for (const line of lines) {
      const p = parseProxyURI(line);
      if (p) parsed.push(p);
    }
    if (parsed.length > 0) {
      setProxies((prev) => [...parsed, ...prev]);
      setExpandedIdx(0);
      showToast({ message: t('configEditor.importSuccess', { count: parsed.length }), type: 'success' });
    } else {
      showToast({ message: t('configEditor.importFailed'), type: 'error' });
    }
    setImportText('');
    setImportOpen(false);
  };
  const removeProxy = (idx: number) => {
    setProxies((prev) => prev.filter((_, i) => i !== idx));
    if (expandedIdx === idx) setExpandedIdx(null);
  };
  const updateProxy = (idx: number, key: string, value: any) => {
    setProxies((prev) => prev.map((p, i) => (i === idx ? { ...p, [key]: value } : p)));
  };
  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      const oldRealIdx = filtered[ids.indexOf(active.id as string)]?.idx;
      const newRealIdx = filtered[ids.indexOf(over.id as string)]?.idx;
      if (oldRealIdx !== undefined && newRealIdx !== undefined) {
        setProxies((prev) => arrayMove(prev, oldRealIdx, newRealIdx));
      }
    }
  };

  return (
    <SectionCard icon={<Zap className="w-4 h-4" />} title={t('configEditor.proxiesTitle')} desc={`${proxies.length} ${t('configEditor.proxiesNodeCount')}`}
      action={<div className="flex gap-1">
        <Button variant="ghost" size="sm" onClick={() => setImportOpen(true)} className="gap-1.5 text-blue-500"><Link2 className="w-3.5 h-3.5" />{t('configEditor.importFromLink')}</Button>
        <Button variant="ghost" size="sm" onClick={addProxy} className="gap-1.5 text-blue-500"><Plus className="w-3.5 h-3.5" />{t('configEditor.addProxy')}</Button>
      </div>}>
      {/* Import dialog */}
      {importOpen && (
        <div className="mb-3 p-3 rounded-lg bg-gray-50 dark:bg-[#1f1f1f] space-y-2">
          <p className="text-xs text-gray-500 dark:text-gray-400">{t('configEditor.importLinkDesc')}</p>
          <textarea
            className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-[#2a2a2a] text-gray-700 dark:text-gray-200 font-mono placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500/40 transition-all resize-none"
            rows={4}
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            placeholder="ss://...\nvmess://...\nvless://...\ntrojan://..."
            autoFocus
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => { setImportOpen(false); setImportText(''); }}>{t('configEditor.cancel')}</Button>
            <button onClick={importFromLinks} disabled={!importText.trim()} className="px-4 py-1.5 text-sm rounded-lg bg-blue-500 hover:bg-blue-600 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed">{t('configEditor.import')}</button>
          </div>
        </div>
      )}
      <div className="relative -mt-1 mb-2">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 dark:text-gray-500" />
        <input type="text" className="w-full pl-9 pr-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-[#2a2a2a] text-gray-700 dark:text-gray-200 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500/40 transition-all" placeholder={t('configEditor.searchProxies')} value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} />
      </div>
      <div className="max-h-[480px] overflow-y-auto custom-scrollbar -mx-1 px-1">
        {filtered.length === 0 ? (
          <EmptyState text={t('configEditor.noProxies')} />
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={ids} strategy={verticalListSortingStrategy}>
              <div className="space-y-2">
                {filtered.map(({ proxy, idx }, fi) => (
                  <SortableItem key={ids[fi]} id={ids[fi]}>
                    {({ dragHandleProps }) => (
                      <div className="rounded-lg bg-gray-50 dark:bg-[#1f1f1f] overflow-hidden transition-colors">
                        <div className="flex items-center gap-2 px-3 py-2.5 cursor-pointer select-none" onClick={() => setExpandedIdx(expandedIdx === idx ? null : idx)}>
                          <button {...dragHandleProps} className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 cursor-grab active:cursor-grabbing text-gray-300 dark:text-gray-600 hover:text-gray-500 dark:hover:text-gray-400 transition-colors" onClick={(e) => e.stopPropagation()}>
                            <GripVertical className="w-3.5 h-3.5" />
                          </button>
                          <ChevronDown className={`w-3.5 h-3.5 text-gray-400 transition-transform duration-200 ${expandedIdx === idx ? 'rotate-180' : ''}`} />
                          <span className="text-sm font-medium text-gray-700 dark:text-gray-200 truncate flex-1">{proxy.name || t('configEditor.unnamed')}</span>
                          <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">{proxy.type || 'ss'}</span>
                          {proxy.server && <span className="text-xs text-gray-400 truncate max-w-[120px]">{proxy.server}</span>}
                          <button onClick={(e) => { e.stopPropagation(); removeProxy(idx); }} className="p-1 rounded hover:bg-red-50 dark:hover:bg-red-900/20 text-gray-300 dark:text-gray-600 hover:text-red-500 transition-colors">
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                        {expandedIdx === idx && <ProxyEditForm proxy={proxy} idx={idx} updateProxy={updateProxy} proxyGroups={proxyGroups} setProxyGroups={setProxyGroups} t={t} />}
                      </div>
                    )}
                  </SortableItem>
                ))}
              </div>
            </SortableContext>
          </DndContext>
        )}
      </div>
    </SectionCard>
  );
}

// Proxy inline edit form — helper to update nested opts
function ProxyEditForm({ proxy, idx, updateProxy, proxyGroups, setProxyGroups, t }: { proxy: any; idx: number; updateProxy: (i: number, k: string, v: any) => void; proxyGroups: any[]; setProxyGroups: React.Dispatch<React.SetStateAction<any[]>>; t: any }) {
  const up = (k: string, v: any) => updateProxy(idx, k, v);
  const upOpts = (optsKey: string, field: string, v: any) => up(optsKey, { ...(proxy[optsKey] || {}), [field]: v });
  const tp = proxy.type || 'ss';
  const ic = "text-gray-700 dark:text-gray-200 text-sm";
  const proxyTypes = [
    { value: 'ss', label: 'Shadowsocks' }, { value: 'ssr', label: 'ShadowsocksR' },
    { value: 'vmess', label: 'VMess' }, { value: 'vless', label: 'VLESS' },
    { value: 'trojan', label: 'Trojan' }, { value: 'hysteria', label: 'Hysteria' },
    { value: 'hysteria2', label: 'Hysteria2' }, { value: 'tuic', label: 'TUIC' },
    { value: 'wireguard', label: 'WireGuard' }, { value: 'http', label: 'HTTP' },
    { value: 'socks5', label: 'SOCKS5' }, { value: 'snell', label: 'Snell' },
    { value: 'anytls', label: 'AnyTLS' },
  ];
  const networkOpts = [
    { value: 'tcp', label: 'TCP' }, { value: 'ws', label: 'WebSocket' },
    { value: 'grpc', label: 'gRPC' }, { value: 'h2', label: 'HTTP/2' },
    { value: 'http', label: 'HTTP' }, { value: 'httpupgrade', label: 'HTTPUpgrade' },
  ];
  const cipherOpts = [
    { value: 'aes-128-gcm', label: 'aes-128-gcm' }, { value: 'aes-256-gcm', label: 'aes-256-gcm' },
    { value: 'chacha20-ietf-poly1305', label: 'chacha20-ietf-poly1305' },
    { value: '2022-blake3-aes-128-gcm', label: '2022-blake3-aes-128-gcm' },
    { value: '2022-blake3-aes-256-gcm', label: '2022-blake3-aes-256-gcm' },
    { value: '2022-blake3-chacha20-poly1305', label: '2022-blake3-chacha20-poly1305' },
  ];
  const fpOpts = [
    { value: '', label: '-' }, { value: 'random', label: 'Random' },
    { value: 'chrome', label: 'Chrome' }, { value: 'firefox', label: 'Firefox' },
    { value: 'safari', label: 'Safari' }, { value: 'ios', label: 'iOS' },
    { value: 'android', label: 'Android' }, { value: 'edge', label: 'Edge' },
    { value: 'qq', label: 'QQ' }, { value: '360', label: '360' },
  ];
  const hasNetwork = tp === 'vmess' || tp === 'vless' || tp === 'trojan';
  const hasTls = tp === 'vmess' || tp === 'vless' || tp === 'trojan' || tp === 'http' || tp === 'socks5' || tp === 'anytls';
  const net = proxy.network || 'tcp';
  const wsOpts = proxy['ws-opts'] || {};
  const grpcOpts = proxy['grpc-opts'] || {};
  const h2Opts = proxy['h2-opts'] || {};
  const realityOpts = proxy['reality-opts'] || {};
  const pluginOpts = proxy['plugin-opts'] || {};

  return (
    <div className="px-4 pb-4 pt-2 space-y-3 border-t border-gray-200 dark:border-gray-700">
      {/* Common: name, type, server, port */}
      <div className="grid grid-cols-2 gap-3">
        <FieldLabel label={t('configEditor.proxyName')}>
          <Input type="text" className={ic} value={proxy.name || ''} onChange={(e) => up('name', e.target.value)} placeholder={t('configEditor.proxyNamePlaceholder')} />
        </FieldLabel>
        <FieldLabel label={t('configEditor.proxyType')}>
          <StyledSelect value={tp} onChange={(v) => up('type', v)} options={proxyTypes} />
        </FieldLabel>
      </div>
      <div className="grid grid-cols-[1fr_100px] gap-3">
        <FieldLabel label={t('configEditor.proxyServer')}>
          <Input type="text" className={ic} value={proxy.server || ''} onChange={(e) => up('server', e.target.value)} placeholder="example.com" />
        </FieldLabel>
        <FieldLabel label={t('configEditor.proxyPort')}>
          <Input type="number" className={ic} value={proxy.port || 443} onChange={(e) => up('port', parseInt(e.target.value) || 443)} />
        </FieldLabel>
      </div>

      {/* === Shadowsocks / SSR === */}
      {(tp === 'ss' || tp === 'ssr') && (<>
        <div className="grid grid-cols-2 gap-3">
          <FieldLabel label={t('configEditor.proxyPassword')}>
            <Input type="text" className={ic} value={proxy.password || ''} onChange={(e) => up('password', e.target.value)} />
          </FieldLabel>
          <FieldLabel label={t('configEditor.proxyCipher')}>
            <StyledSelect value={proxy.cipher || 'aes-256-gcm'} onChange={(v) => up('cipher', v)} options={cipherOpts} />
          </FieldLabel>
        </div>
        {tp === 'ss' && (<>
          <div className="grid grid-cols-2 gap-3">
            <FieldLabel label={t('configEditor.proxyPlugin')}>
              <StyledSelect value={proxy.plugin || ''} onChange={(v) => up('plugin', v)} options={[
                { value: '', label: t('configEditor.none') }, { value: 'obfs', label: 'obfs' },
                { value: 'v2ray-plugin', label: 'v2ray-plugin' }, { value: 'shadow-tls', label: 'shadow-tls' },
              ]} />
            </FieldLabel>
            <FieldLabel label="Client Fingerprint">
              <StyledSelect value={proxy['client-fingerprint'] || ''} onChange={(v) => up('client-fingerprint', v)} options={fpOpts} />
            </FieldLabel>
          </div>
          {proxy.plugin && (
            <div className="grid grid-cols-2 gap-3">
              <FieldLabel label={t('configEditor.pluginMode')}>
                <StyledSelect value={pluginOpts.mode || ''} onChange={(v) => upOpts('plugin-opts', 'mode', v)} options={[
                  { value: '', label: '-' }, { value: 'http', label: 'HTTP' }, { value: 'tls', label: 'TLS' }, { value: 'websocket', label: 'WebSocket' },
                ]} />
              </FieldLabel>
              <FieldLabel label={t('configEditor.pluginHost')}>
                <Input type="text" className={ic} value={pluginOpts.host || ''} onChange={(e) => upOpts('plugin-opts', 'host', e.target.value)} />
              </FieldLabel>
              {(proxy.plugin === 'v2ray-plugin' || proxy.plugin === 'obfs') && (
                <FieldLabel label="Path">
                  <Input type="text" className={ic} value={pluginOpts.path || ''} onChange={(e) => upOpts('plugin-opts', 'path', e.target.value)} placeholder="/" />
                </FieldLabel>
              )}
              {proxy.plugin === 'shadow-tls' && (<>
                <FieldLabel label="Version">
                  <Input type="number" className={ic} value={pluginOpts.version || 3} onChange={(e) => upOpts('plugin-opts', 'version', parseInt(e.target.value) || 3)} />
                </FieldLabel>
                <FieldLabel label="Password">
                  <Input type="text" className={ic} value={pluginOpts.password || ''} onChange={(e) => upOpts('plugin-opts', 'password', e.target.value)} />
                </FieldLabel>
              </>)}
            </div>
          )}
        </>)}
      </>)}

      {/* === VMess === */}
      {tp === 'vmess' && (<>
        <FieldLabel label="UUID">
          <Input type="text" className={ic} value={proxy.uuid || ''} onChange={(e) => up('uuid', e.target.value)} />
        </FieldLabel>
        <div className="grid grid-cols-3 gap-3">
          <FieldLabel label="Alter ID">
            <Input type="number" className={ic} value={proxy.alterId || 0} onChange={(e) => up('alterId', parseInt(e.target.value) || 0)} />
          </FieldLabel>
          <FieldLabel label={t('configEditor.proxyCipher')}>
            <StyledSelect value={proxy.cipher || 'auto'} onChange={(v) => up('cipher', v)} options={[
              { value: 'auto', label: 'Auto' }, { value: 'aes-128-gcm', label: 'aes-128-gcm' },
              { value: 'chacha20-poly1305', label: 'chacha20-poly1305' }, { value: 'none', label: 'None' },
            ]} />
          </FieldLabel>
          <FieldLabel label={t('configEditor.proxyNetwork')}>
            <StyledSelect value={net} onChange={(v) => up('network', v)} options={networkOpts} />
          </FieldLabel>
        </div>
      </>)}

      {/* === VLESS === */}
      {tp === 'vless' && (<>
        <FieldLabel label="UUID">
          <Input type="text" className={ic} value={proxy.uuid || ''} onChange={(e) => up('uuid', e.target.value)} />
        </FieldLabel>
        <div className="grid grid-cols-2 gap-3">
          <FieldLabel label={t('configEditor.proxyNetwork')}>
            <StyledSelect value={net} onChange={(v) => up('network', v)} options={networkOpts} />
          </FieldLabel>
          <FieldLabel label="Flow">
            <StyledSelect value={proxy.flow || ''} onChange={(v) => up('flow', v)} options={[
              { value: '', label: t('configEditor.none') }, { value: 'xtls-rprx-vision', label: 'xtls-rprx-vision' },
            ]} />
          </FieldLabel>
        </div>
      </>)}

      {/* === Trojan === */}
      {tp === 'trojan' && (<>
        <FieldLabel label={t('configEditor.proxyPassword')}>
          <Input type="text" className={ic} value={proxy.password || ''} onChange={(e) => up('password', e.target.value)} />
        </FieldLabel>
        <FieldLabel label={t('configEditor.proxyNetwork')}>
          <StyledSelect value={net} onChange={(v) => up('network', v)} options={[
            { value: 'tcp', label: 'TCP' }, { value: 'ws', label: 'WebSocket' }, { value: 'grpc', label: 'gRPC' },
          ]} />
        </FieldLabel>
      </>)}
      {/* === Hysteria === */}
      {tp === 'hysteria' && (<>
        <div className="grid grid-cols-2 gap-3">
          <FieldLabel label="Auth">
            <Input type="text" className={ic} value={proxy.auth || ''} onChange={(e) => up('auth', e.target.value)} />
          </FieldLabel>
          <FieldLabel label={t('configEditor.protocol')}>
            <StyledSelect value={proxy.protocol || 'udp'} onChange={(v) => up('protocol', v)} options={[
              { value: 'udp', label: 'UDP' }, { value: 'wechat-video', label: 'WeChat Video' }, { value: 'faketcp', label: 'FakeTCP' },
            ]} />
          </FieldLabel>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <FieldLabel label={t('configEditor.upSpeed')}>
            <Input type="text" className={ic} value={proxy.up || ''} onChange={(e) => up('up', e.target.value)} placeholder="50 Mbps" />
          </FieldLabel>
          <FieldLabel label={t('configEditor.downSpeed')}>
            <Input type="text" className={ic} value={proxy.down || ''} onChange={(e) => up('down', e.target.value)} placeholder="100 Mbps" />
          </FieldLabel>
        </div>
        <FieldLabel label="Obfs">
          <Input type="text" className={ic} value={proxy.obfs || ''} onChange={(e) => up('obfs', e.target.value)} />
        </FieldLabel>
      </>)}

      {/* === Hysteria2 === */}
      {tp === 'hysteria2' && (<>
        <FieldLabel label={t('configEditor.proxyPassword')}>
          <Input type="text" className={ic} value={proxy.password || ''} onChange={(e) => up('password', e.target.value)} />
        </FieldLabel>
        <div className="grid grid-cols-2 gap-3">
          <FieldLabel label={t('configEditor.upSpeed')}>
            <Input type="text" className={ic} value={proxy.up || ''} onChange={(e) => up('up', e.target.value)} placeholder="50 Mbps" />
          </FieldLabel>
          <FieldLabel label={t('configEditor.downSpeed')}>
            <Input type="text" className={ic} value={proxy.down || ''} onChange={(e) => up('down', e.target.value)} placeholder="100 Mbps" />
          </FieldLabel>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <FieldLabel label="Obfs">
            <StyledSelect value={proxy.obfs || ''} onChange={(v) => up('obfs', v)} options={[
              { value: '', label: t('configEditor.none') }, { value: 'salamander', label: 'Salamander' },
            ]} />
          </FieldLabel>
          {proxy.obfs === 'salamander' && (
            <FieldLabel label="Obfs Password">
              <Input type="text" className={ic} value={proxy['obfs-password'] || ''} onChange={(e) => up('obfs-password', e.target.value)} />
            </FieldLabel>
          )}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <FieldLabel label={t('configEditor.portHopping')}>
            <Input type="text" className={ic} value={proxy.ports || ''} onChange={(e) => up('ports', e.target.value)} placeholder="20000-30000" />
          </FieldLabel>
          <FieldLabel label={t('configEditor.hopInterval')}>
            <Input type="text" className={ic} value={proxy['hop-interval'] || ''} onChange={(e) => up('hop-interval', e.target.value)} placeholder="30s" />
          </FieldLabel>
        </div>
      </>)}

      {/* === TUIC === */}
      {tp === 'tuic' && (<>
        <div className="grid grid-cols-2 gap-3">
          <FieldLabel label="UUID">
            <Input type="text" className={ic} value={proxy.uuid || ''} onChange={(e) => up('uuid', e.target.value)} />
          </FieldLabel>
          <FieldLabel label={t('configEditor.proxyPassword')}>
            <Input type="text" className={ic} value={proxy.password || ''} onChange={(e) => up('password', e.target.value)} />
          </FieldLabel>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <FieldLabel label={t('configEditor.congestionCtrl')}>
            <StyledSelect value={proxy['congestion-controller'] || 'bbr'} onChange={(v) => up('congestion-controller', v)} options={[
              { value: 'bbr', label: 'BBR' }, { value: 'cubic', label: 'Cubic' }, { value: 'new_reno', label: 'New Reno' },
            ]} />
          </FieldLabel>
          <FieldLabel label="UDP Relay Mode">
            <StyledSelect value={proxy['udp-relay-mode'] || 'native'} onChange={(v) => up('udp-relay-mode', v)} options={[
              { value: 'native', label: 'Native' }, { value: 'quic', label: 'QUIC' },
            ]} />
          </FieldLabel>
        </div>
        <MiniSwitch label="Disable SNI" checked={proxy['disable-sni'] || false} onChange={(v) => up('disable-sni', v)} />
      </>)}

      {/* === WireGuard === */}
      {tp === 'wireguard' && (<>
        <FieldLabel label="Private Key">
          <Input type="text" className={ic} value={proxy['private-key'] || ''} onChange={(e) => up('private-key', e.target.value)} />
        </FieldLabel>
        <FieldLabel label="Peer Public Key">
          <Input type="text" className={ic} value={proxy['peer-public-key'] || proxy['public-key'] || ''} onChange={(e) => up('peer-public-key', e.target.value)} />
        </FieldLabel>
        <FieldLabel label="Pre-shared Key">
          <Input type="text" className={ic} value={proxy['preshared-key'] || ''} onChange={(e) => up('preshared-key', e.target.value)} />
        </FieldLabel>
        <div className="grid grid-cols-2 gap-3">
          <FieldLabel label="IP">
            <Input type="text" className={ic} value={proxy.ip || ''} onChange={(e) => up('ip', e.target.value)} placeholder="10.0.0.2/32" />
          </FieldLabel>
          <FieldLabel label="IPv6">
            <Input type="text" className={ic} value={proxy.ipv6 || ''} onChange={(e) => up('ipv6', e.target.value)} />
          </FieldLabel>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <FieldLabel label="Reserved">
            <Input type="text" className={ic} value={(proxy.reserved || []).join(',')} onChange={(e) => up('reserved', e.target.value.split(',').map((s: string) => parseInt(s.trim()) || 0))} placeholder="0,0,0" />
          </FieldLabel>
          <FieldLabel label="MTU">
            <Input type="number" className={ic} value={proxy.mtu || 1420} onChange={(e) => up('mtu', parseInt(e.target.value) || 1420)} />
          </FieldLabel>
        </div>
      </>)}

      {/* === HTTP / SOCKS5 === */}
      {(tp === 'http' || tp === 'socks5') && (
        <div className="grid grid-cols-2 gap-3">
          <FieldLabel label={t('configEditor.username')}>
            <Input type="text" className={ic} value={proxy.username || ''} onChange={(e) => up('username', e.target.value)} />
          </FieldLabel>
          <FieldLabel label={t('configEditor.proxyPassword')}>
            <Input type="text" className={ic} value={proxy.password || ''} onChange={(e) => up('password', e.target.value)} />
          </FieldLabel>
        </div>
      )}

      {/* === Snell === */}
      {tp === 'snell' && (<>
        <div className="grid grid-cols-2 gap-3">
          <FieldLabel label="PSK">
            <Input type="text" className={ic} value={proxy.psk || ''} onChange={(e) => up('psk', e.target.value)} />
          </FieldLabel>
          <FieldLabel label="Version">
            <Input type="number" className={ic} value={proxy.version || 3} onChange={(e) => up('version', parseInt(e.target.value) || 3)} />
          </FieldLabel>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <FieldLabel label="Obfs Mode">
            <StyledSelect value={(proxy['obfs-opts'] || {}).mode || ''} onChange={(v) => up('obfs-opts', { ...(proxy['obfs-opts'] || {}), mode: v })} options={[
              { value: '', label: t('configEditor.none') }, { value: 'http', label: 'HTTP' }, { value: 'tls', label: 'TLS' },
            ]} />
          </FieldLabel>
          <FieldLabel label="Obfs Host">
            <Input type="text" className={ic} value={(proxy['obfs-opts'] || {}).host || ''} onChange={(e) => up('obfs-opts', { ...(proxy['obfs-opts'] || {}), host: e.target.value })} placeholder="bing.com" />
          </FieldLabel>
        </div>
      </>)}

      {/* === AnyTLS === */}
      {tp === 'anytls' && (
        <FieldLabel label={t('configEditor.proxyPassword')}>
          <Input type="text" className={ic} value={proxy.password || ''} onChange={(e) => up('password', e.target.value)} />
        </FieldLabel>
      )}

      {/* === Network opts (ws/grpc/h2) for vmess/vless/trojan === */}
      {hasNetwork && net === 'ws' && (
        <div className="grid grid-cols-2 gap-3">
          <FieldLabel label="WS Path">
            <Input type="text" className={ic} value={wsOpts.path || ''} onChange={(e) => upOpts('ws-opts', 'path', e.target.value)} placeholder="/" />
          </FieldLabel>
          <FieldLabel label="WS Host">
            <Input type="text" className={ic} value={(wsOpts.headers || {}).Host || ''} onChange={(e) => upOpts('ws-opts', 'headers', { ...(wsOpts.headers || {}), Host: e.target.value })} />
          </FieldLabel>
          <FieldLabel label="Max Early Data">
            <Input type="number" className={ic} value={wsOpts['max-early-data'] || 0} onChange={(e) => upOpts('ws-opts', 'max-early-data', parseInt(e.target.value) || 0)} />
          </FieldLabel>
          <FieldLabel label="Early Data Header">
            <Input type="text" className={ic} value={wsOpts['early-data-header-name'] || ''} onChange={(e) => upOpts('ws-opts', 'early-data-header-name', e.target.value)} />
          </FieldLabel>
        </div>
      )}
      {hasNetwork && net === 'grpc' && (
        <FieldLabel label="gRPC Service Name">
          <Input type="text" className={ic} value={grpcOpts['grpc-service-name'] || ''} onChange={(e) => upOpts('grpc-opts', 'grpc-service-name', e.target.value)} />
        </FieldLabel>
      )}
      {hasNetwork && net === 'h2' && (
        <div className="grid grid-cols-2 gap-3">
          <FieldLabel label="H2 Host">
            <Input type="text" className={ic} value={(h2Opts.host || []).join(',')} onChange={(e) => upOpts('h2-opts', 'host', e.target.value.split(',').map((s: string) => s.trim()).filter(Boolean))} />
          </FieldLabel>
          <FieldLabel label="H2 Path">
            <Input type="text" className={ic} value={h2Opts.path || ''} onChange={(e) => upOpts('h2-opts', 'path', e.target.value)} placeholder="/" />
          </FieldLabel>
        </div>
      )}

      {/* === TLS settings for applicable types === */}
      {hasTls && (<>
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <MiniSwitch label="TLS" checked={proxy.tls || false} onChange={(v) => up('tls', v)} />
          <MiniSwitch label="Skip Cert Verify" checked={proxy['skip-cert-verify'] || false} onChange={(v) => up('skip-cert-verify', v)} />
        </div>
        {proxy.tls && (
          <div className="grid grid-cols-2 gap-3">
            <FieldLabel label="SNI / Servername">
              <Input type="text" className={ic} value={proxy.sni || proxy.servername || ''} onChange={(e) => { up('sni', e.target.value); up('servername', e.target.value); }} placeholder={proxy.server || ''} />
            </FieldLabel>
            <FieldLabel label="Client Fingerprint">
              <StyledSelect value={proxy['client-fingerprint'] || proxy.fingerprint || ''} onChange={(v) => { up('client-fingerprint', v); up('fingerprint', v); }} options={fpOpts} />
            </FieldLabel>
            <FieldLabel label="ALPN">
              <Input type="text" className={ic} value={(proxy.alpn || []).join(',')} onChange={(e) => up('alpn', e.target.value.split(',').map((s: string) => s.trim()).filter(Boolean))} placeholder="h2,http/1.1" />
            </FieldLabel>
          </div>
        )}
        {/* Reality opts */}
        {proxy.tls && (tp === 'vless' || tp === 'vmess' || tp === 'trojan') && (
          <div className="grid grid-cols-2 gap-3">
            <FieldLabel label="Reality Public Key">
              <Input type="text" className={ic} value={realityOpts['public-key'] || ''} onChange={(e) => upOpts('reality-opts', 'public-key', e.target.value)} />
            </FieldLabel>
            <FieldLabel label="Reality Short ID">
              <Input type="text" className={ic} value={realityOpts['short-id'] || ''} onChange={(e) => upOpts('reality-opts', 'short-id', e.target.value)} />
            </FieldLabel>
          </div>
        )}
      </>)}

      {/* === TLS for hysteria/hysteria2/tuic (always TLS) === */}
      {(tp === 'hysteria' || tp === 'hysteria2' || tp === 'tuic') && (
        <div className="grid grid-cols-2 gap-3">
          <FieldLabel label="SNI">
            <Input type="text" className={ic} value={proxy.sni || ''} onChange={(e) => up('sni', e.target.value)} placeholder={proxy.server || ''} />
          </FieldLabel>
          <FieldLabel label="ALPN">
            <Input type="text" className={ic} value={(proxy.alpn || []).join(',')} onChange={(e) => up('alpn', e.target.value.split(',').map((s: string) => s.trim()).filter(Boolean))} placeholder="h3" />
          </FieldLabel>
          <MiniSwitch label="Skip Cert Verify" checked={proxy['skip-cert-verify'] || false} onChange={(v) => up('skip-cert-verify', v)} />
        </div>
      )}

      {/* === Common switches === */}
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        {tp !== 'wireguard' && <MiniSwitch label="UDP" checked={proxy.udp !== false} onChange={(v) => up('udp', v)} />}
        {(tp === 'ss' || tp === 'vmess' || tp === 'vless' || tp === 'trojan' || tp === 'anytls') && (
          <MiniSwitch label="TFO" checked={proxy.tfo || false} onChange={(v) => up('tfo', v)} />
        )}
        {(tp === 'ss') && (
          <MiniSwitch label="UDP over TCP" checked={proxy['udp-over-tcp'] || false} onChange={(v) => up('udp-over-tcp', v)} />
        )}
      </div>

      {/* Proxy group membership */}
      {proxyGroups.length > 0 && proxy.name && (
        <div>
          <span className="text-xs font-medium text-gray-500 dark:text-gray-400">{t('configEditor.proxyGroupMembership')}</span>
          <div className="flex flex-wrap gap-2 mt-1.5">
            {proxyGroups.map((g, gi) => {
              const pList: string[] = g.proxies || [];
              const isMember = pList.some((p: string) => p === proxy.name);
              return (
                <label key={gi} className="flex items-center gap-1.5 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    className="w-3.5 h-3.5 rounded accent-blue-500"
                    checked={isMember}
                    onChange={(e) => {
                      setProxyGroups((prev) => prev.map((pg, pgi) => {
                        if (pgi !== gi) return pg;
                        const list: string[] = pg.proxies || [];
                        if (e.target.checked) {
                          return { ...pg, proxies: [...list, proxy.name] };
                        } else {
                          return { ...pg, proxies: list.filter((p: string) => p !== proxy.name) };
                        }
                      }));
                    }}
                  />
                  <span className="text-xs text-gray-600 dark:text-gray-300">{g.name || t('configEditor.unnamed')}</span>
                </label>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ==================== Providers Tab ====================
function ProvidersTab({ proxyProviders, setProxyProviders, ruleProviders, setRuleProviders, t }: {
  proxyProviders: Record<string, any>;
  setProxyProviders: React.Dispatch<React.SetStateAction<Record<string, any>>>;
  ruleProviders: Record<string, any>;
  setRuleProviders: React.Dispatch<React.SetStateAction<Record<string, any>>>;
  t: any;
}) {
  const [expandedPP, setExpandedPP] = useState<string | null>(null);
  const [expandedRP, setExpandedRP] = useState<string | null>(null);

  const addPP = () => { const n = `provider-${Date.now()}`; setProxyProviders((p) => ({ ...p, [n]: { type: 'http', url: '', path: '', interval: 3600, 'health-check': { enable: true, url: 'http://www.gstatic.com/generate_204', interval: 300 } } })); setExpandedPP(n); };
  const removePP = (n: string) => { setProxyProviders((p) => { const c = { ...p }; delete c[n]; return c; }); if (expandedPP === n) setExpandedPP(null); };
  const updatePP = (n: string, k: string, v: any) => { setProxyProviders((p) => ({ ...p, [n]: { ...p[n], [k]: v } })); };
  const renamePP = (o: string, n: string) => { if (!n.trim() || n === o) return; setProxyProviders((p) => { const c: Record<string, any> = {}; Object.entries(p).forEach(([k, v]) => { c[k === o ? n : k] = v; }); return c; }); if (expandedPP === o) setExpandedPP(n); };

  const addRP = () => { const n = `rule-provider-${Date.now()}`; setRuleProviders((p) => ({ ...p, [n]: { type: 'http', behavior: 'domain', format: 'yaml', url: '', path: '', interval: 86400 } })); setExpandedRP(n); };
  const removeRP = (n: string) => { setRuleProviders((p) => { const c = { ...p }; delete c[n]; return c; }); if (expandedRP === n) setExpandedRP(null); };
  const updateRP = (n: string, k: string, v: any) => { setRuleProviders((p) => ({ ...p, [n]: { ...p[n], [k]: v } })); };
  const renameRP = (o: string, n: string) => { if (!n.trim() || n === o) return; setRuleProviders((p) => { const c: Record<string, any> = {}; Object.entries(p).forEach(([k, v]) => { c[k === o ? n : k] = v; }); return c; }); if (expandedRP === o) setExpandedRP(n); };

  return (
    <>
      <SectionCard icon={<Server className="w-4 h-4" />} title={t('configEditor.proxyProvidersTitle')} desc={t('configEditor.proxyProvidersDesc')}
        action={<Button variant="ghost" size="sm" onClick={addPP} className="gap-1.5 text-blue-500"><Plus className="w-3.5 h-3.5" />{t('configEditor.addProvider')}</Button>}>
        {Object.keys(proxyProviders).length === 0 ? <EmptyState text={t('configEditor.noProviders')} /> : (
          <div className="space-y-2">
            {Object.entries(proxyProviders).map(([name, pp]) => (
              <ExpandableCard key={name} title={name} badge={pp.type || 'http'} expanded={expandedPP === name} onToggle={() => setExpandedPP(expandedPP === name ? null : name)} onRemove={() => removePP(name)}>
                <ProviderForm name={name} data={pp} update={updatePP} rename={renamePP} t={t} kind="proxy" />
              </ExpandableCard>
            ))}
          </div>
        )}
      </SectionCard>

      <SectionCard icon={<Shield className="w-4 h-4" />} title={t('configEditor.ruleProvidersTitle')} desc={t('configEditor.ruleProvidersDesc')}
        action={<Button variant="ghost" size="sm" onClick={addRP} className="gap-1.5 text-blue-500"><Plus className="w-3.5 h-3.5" />{t('configEditor.addProvider')}</Button>}>
        {Object.keys(ruleProviders).length === 0 ? <EmptyState text={t('configEditor.noProviders')} /> : (
          <div className="space-y-2">
            {Object.entries(ruleProviders).map(([name, rp]) => (
              <ExpandableCard key={name} title={name} badge={rp.behavior || 'domain'} expanded={expandedRP === name} onToggle={() => setExpandedRP(expandedRP === name ? null : name)} onRemove={() => removeRP(name)}>
                <ProviderForm name={name} data={rp} update={updateRP} rename={renameRP} t={t} kind="rule" />
              </ExpandableCard>
            ))}
          </div>
        )}
      </SectionCard>
    </>
  );
}

// Unified Provider form
function ProviderForm({ name, data, update, rename, t, kind }: { name: string; data: any; update: (n: string, k: string, v: any) => void; rename: (o: string, n: string) => void; t: any; kind: 'proxy' | 'rule' }) {
  const [localName, setLocalName] = useState(name);
  return (
    <div className="px-4 pb-4 pt-2 space-y-3 border-t border-gray-200 dark:border-gray-700">
      <div className="grid grid-cols-2 gap-3">
        <FieldLabel label={t('configEditor.providerName')}>
          <Input type="text" className="text-gray-700 dark:text-gray-200 text-sm" value={localName} onChange={(e) => setLocalName(e.target.value)} onBlur={() => rename(name, localName)} />
        </FieldLabel>
        <FieldLabel label={t('configEditor.providerType')}>
          <StyledSelect value={data.type || 'http'} onChange={(v) => update(name, 'type', v)} options={[{ value: 'http', label: 'HTTP' }, { value: 'file', label: 'File' }]} />
        </FieldLabel>
      </div>
      {kind === 'rule' && (
        <div className="grid grid-cols-2 gap-3">
          <FieldLabel label={t('configEditor.rpBehavior')}>
            <StyledSelect value={data.behavior || 'domain'} onChange={(v) => update(name, 'behavior', v)} options={[{ value: 'domain', label: 'Domain' }, { value: 'ipcidr', label: 'IP-CIDR' }, { value: 'classical', label: 'Classical' }]} />
          </FieldLabel>
          <FieldLabel label={t('configEditor.rpFormat')}>
            <StyledSelect value={data.format || 'yaml'} onChange={(v) => update(name, 'format', v)} options={[{ value: 'yaml', label: 'YAML' }, { value: 'text', label: 'Text' }, { value: 'mrs', label: 'MRS' }]} />
          </FieldLabel>
        </div>
      )}
      <FieldLabel label="URL">
        <Input type="text" className="text-gray-700 dark:text-gray-200 text-sm" value={data.url || ''} onChange={(e) => update(name, 'url', e.target.value)} placeholder="https://example.com/..." />
      </FieldLabel>
      <div className="grid grid-cols-2 gap-3">
        <FieldLabel label="Path">
          <Input type="text" className="text-gray-700 dark:text-gray-200 text-sm" value={data.path || ''} onChange={(e) => update(name, 'path', e.target.value)} placeholder={`./providers/${name}.yaml`} />
        </FieldLabel>
        <FieldLabel label={t('configEditor.providerInterval')}>
          <Input type="number" className="text-gray-700 dark:text-gray-200 text-sm" value={data.interval || (kind === 'proxy' ? 3600 : 86400)} onChange={(e) => update(name, 'interval', parseInt(e.target.value) || 3600)} />
        </FieldLabel>
      </div>
      {kind === 'proxy' && (
        <>
          <div className="flex items-center gap-4 pt-1">
            <MiniSwitch label={t('configEditor.healthCheckEnable')} checked={data['health-check']?.enable ?? true} onChange={(v) => update(name, 'health-check', { ...data['health-check'], enable: v })} />
          </div>
          {data['health-check']?.enable !== false && (
            <div className="grid grid-cols-2 gap-3">
              <FieldLabel label={t('configEditor.healthCheckUrl')}>
                <Input type="text" className="text-gray-700 dark:text-gray-200 text-sm" value={data['health-check']?.url || ''} onChange={(e) => update(name, 'health-check', { ...data['health-check'], url: e.target.value })} placeholder="http://www.gstatic.com/generate_204" />
              </FieldLabel>
              <FieldLabel label={t('configEditor.healthCheckInterval')}>
                <Input type="number" className="text-gray-700 dark:text-gray-200 text-sm" value={data['health-check']?.interval || 300} onChange={(e) => update(name, 'health-check', { ...data['health-check'], interval: parseInt(e.target.value) || 300 })} />
              </FieldLabel>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <FieldLabel label={t('configEditor.groupFilter')}>
              <Input type="text" className="text-gray-700 dark:text-gray-200 text-sm" value={data.filter || ''} onChange={(e) => update(name, 'filter', e.target.value)} placeholder={t('configEditor.groupFilterPlaceholder')} />
            </FieldLabel>
            <FieldLabel label={t('configEditor.groupExcludeFilter')}>
              <Input type="text" className="text-gray-700 dark:text-gray-200 text-sm" value={data['exclude-filter'] || ''} onChange={(e) => update(name, 'exclude-filter', e.target.value)} placeholder={t('configEditor.groupExcludeFilterPlaceholder')} />
            </FieldLabel>
          </div>
        </>
      )}
    </div>
  );
}
