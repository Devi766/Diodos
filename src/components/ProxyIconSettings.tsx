import React, { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { PlusIcon, TrashIcon, Pencil1Icon, CheckIcon, ReloadIcon } from '@radix-ui/react-icons';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from './ui/dialog';
import { Button } from './ui/button';
import { useThemeColor } from '../hooks/useThemeColor';
import { showToast } from '@/components/ui/toast';

interface ProxyIconRule {
  id: string;
  name: string;
  regex: string;
  iconType: 'BASE64' | 'URL';
  iconData: string;
  enabled: boolean;
  priority: number;
}

interface ProxyIconConfig {
  enabled: boolean;
  rules: ProxyIconRule[];
}

const getProxyIconApi = () => {
  if (typeof window === 'undefined') return undefined;
  return window.electronAPI?.proxyIcon;
};

const TAURI_RUNTIME_UNAVAILABLE = 'Tauri runtime is not available';

const errorToMessage = (error: unknown) => {
  return error instanceof Error ? error.message : String(error || 'Unknown error');
};

const normalizeProxyIconConfig = (config: Partial<ProxyIconConfig> | undefined): ProxyIconConfig => ({
  enabled: config?.enabled ?? true,
  rules: Array.isArray(config?.rules) ? config.rules : [],
});

const notifyProxyIconChanged = () => {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('proxy-icon-changed', { detail: { source: 'proxy-icon-settings' } }));
  }
};

const ProxyIconSettings: React.FC = () => {
  const { t } = useTranslation();
  const themeColor = useThemeColor();
  const [config, setConfig] = useState<ProxyIconConfig>({ enabled: true, rules: [] });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editingRule, setEditingRule] = useState<ProxyIconRule | null>(null);
  const [showRuleDialog, setShowRuleDialog] = useState(false);

  const resolvedThemeColor = useMemo(() => {
    if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(themeColor)) {
      if (themeColor.length === 4) {
        const r = themeColor[1];
        const g = themeColor[2];
        const b = themeColor[3];
        return `#${r}${r}${g}${g}${b}${b}`;
      }
      return themeColor;
    }
    return '#3b82f6';
  }, [themeColor]);

  const semiTransparentThemeColor = useMemo(() => {
    if (/^#([0-9a-fA-F]{6})$/.test(resolvedThemeColor)) {
      const r = parseInt(resolvedThemeColor.slice(1, 3), 16);
      const g = parseInt(resolvedThemeColor.slice(3, 5), 16);
      const b = parseInt(resolvedThemeColor.slice(5, 7), 16);
      return `rgba(${r}, ${g}, ${b}, 0.16)`;
    }
    return 'rgba(59, 130, 246, 0.16)';
  }, [resolvedThemeColor]);

  const subtleBorderColor = useMemo(() => {
    if (/^#([0-9a-fA-F]{6})$/.test(resolvedThemeColor)) {
      return `${resolvedThemeColor}33`;
    }
    return 'rgba(59, 130, 246, 0.3)';
  }, [resolvedThemeColor]);

  const allRulesEnabled = useMemo(
    () => config.rules.length > 0 && config.rules.every((rule) => rule.enabled),
    [config.rules],
  );

  const formatProxyIconError = (error: unknown, fallback = t('proxyIcon.unknownError')) => {
    const message = errorToMessage(error || fallback);
    return message.includes(TAURI_RUNTIME_UNAVAILABLE) ? t('proxyIcon.apiUnavailable') : message;
  };

  const resultError = (result: { error?: string } | undefined) =>
    result?.error ? formatProxyIconError(result.error) : t('proxyIcon.unknownError');

  const notifyApiUnavailable = () => {
    showToast({ message: t('proxyIcon.apiUnavailable'), type: 'error' });
  };

  // 加载配置
  useEffect(() => {
    loadConfig();

    const refreshConfig = (event?: Event) => {
      const source = event instanceof CustomEvent ? event.detail?.source : undefined;
      if (source === 'proxy-icon-settings') {
        return;
      }
      loadConfig();
    };
    window.addEventListener('backup-restored', refreshConfig);
    window.addEventListener('proxy-icon-changed', refreshConfig);

    return () => {
      window.removeEventListener('backup-restored', refreshConfig);
      window.removeEventListener('proxy-icon-changed', refreshConfig);
    };
  }, []);

  const loadConfig = async () => {
    try {
      setLoading(true);
      setLoadError(null);
      const proxyIcon = getProxyIconApi();
      if (!proxyIcon) {
        setLoadError(t('proxyIcon.apiUnavailable'));
        notifyApiUnavailable();
        return;
      }
      const result = await proxyIcon.getConfig();
      if (result.success && result.config) {
        setConfig(normalizeProxyIconConfig(result.config));
      } else {
        const message = t('proxyIcon.loadFailed', { error: resultError(result) });
        setLoadError(message);
        showToast({
          message,
          type: 'error',
        });
      }
    } catch (error) {
      console.error('加载代理图标配置失败:', error);
      const message = t('proxyIcon.loadFailed', { error: formatProxyIconError(error) });
      setLoadError(message);
      showToast({
        message,
        type: 'error',
      });
    } finally {
      setLoading(false);
    }
  };

  const saveConfig = async (newConfig: ProxyIconConfig, showSuccess = true) => {
    try {
      const proxyIcon = getProxyIconApi();
      if (!proxyIcon) {
        notifyApiUnavailable();
        return false;
      }
      const result = await proxyIcon.saveConfig(newConfig);
      if (result.success) {
        setConfig(newConfig);
        setLoadError(null);
        notifyProxyIconChanged();
        if (showSuccess) {
          showToast({ message: t('proxyIcon.configSaved'), type: 'success' });
        }
        return true;
      }
      showToast({
        message: t('proxyIcon.configSaveFailed', { error: resultError(result) }),
        type: 'error',
      });
    } catch (error) {
      console.error('保存代理图标配置失败:', error);
      showToast({
        message: t('proxyIcon.configSaveFailed', { error: errorToMessage(error) }),
        type: 'error',
      });
    }
    return false;
  };

  const handleToggleEnabled = () => {
    const newConfig = { ...config, enabled: !config.enabled };
    saveConfig(newConfig);
  };

  const handleAddRule = () => {
    setEditingRule({
      id: '',
      name: '',
      regex: '',
      iconType: 'URL',
      iconData: '',
      enabled: true,
      priority: 0
    });
    setShowRuleDialog(true);
  };

  const handleEditRule = (rule: ProxyIconRule) => {
    setEditingRule({ ...rule });
    setShowRuleDialog(true);
  };

  const handleDeleteRule = async (ruleId: string) => {
    try {
      const proxyIcon = getProxyIconApi();
      if (!proxyIcon) {
        notifyApiUnavailable();
        return;
      }
      const result = await proxyIcon.deleteRule(ruleId);
      if (result.success) {
        await loadConfig();
        notifyProxyIconChanged();
        showToast({ message: t('proxyIcon.ruleDeletedSuccess'), type: 'success' });
      } else {
        showToast({
          message: t('proxyIcon.ruleDeleteFailed', { error: resultError(result) }),
          type: 'error',
        });
      }
    } catch (error) {
      console.error('删除规则失败:', error);
      showToast({
        message: t('proxyIcon.ruleDeleteFailed', { error: errorToMessage(error) }),
        type: 'error',
      });
    }
  };

  const handleToggleRule = async (ruleId: string, enabled: boolean) => {
    try {
      const proxyIcon = getProxyIconApi();
      if (!proxyIcon) {
        notifyApiUnavailable();
        return;
      }
      const result = await proxyIcon.toggleRule(ruleId, enabled);
      if (result.success) {
        await loadConfig();
        notifyProxyIconChanged();
        showToast({ message: t('proxyIcon.ruleToggleSuccess'), type: 'success' });
      } else {
        showToast({
          message: t('proxyIcon.ruleToggleFailed', { error: resultError(result) }),
          type: 'error',
        });
      }
    } catch (error) {
      console.error('切换规则状态失败:', error);
      showToast({
        message: t('proxyIcon.ruleToggleFailed', { error: errorToMessage(error) }),
        type: 'error',
      });
    }
  };

  const handleToggleAllRules = async () => {
    if (config.rules.length === 0) return;

    const updatedConfig: ProxyIconConfig = {
      ...config,
      rules: config.rules.map((rule) => ({ ...rule, enabled: allRulesEnabled ? false : true })),
    };

    await saveConfig(updatedConfig);
  };

  const handleSaveRule = async () => {
    if (!editingRule) return;

    try {
      const proxyIcon = getProxyIconApi();
      if (!proxyIcon) {
        notifyApiUnavailable();
        return;
      }

      if (editingRule.id) {
        // 更新现有规则
        const result = await proxyIcon.updateRule(editingRule.id, editingRule);
        if (result.success) {
          await loadConfig();
          setShowRuleDialog(false);
          notifyProxyIconChanged();
          showToast({ message: t('proxyIcon.ruleUpdatedSuccess'), type: 'success' });
        } else {
          showToast({
            message: t('proxyIcon.ruleSaveFailed', { error: resultError(result) }),
            type: 'error',
          });
        }
      } else {
        // 添加新规则
        const result = await proxyIcon.addRule(editingRule);
        if (result.success) {
          await loadConfig();
          setShowRuleDialog(false);
          notifyProxyIconChanged();
          showToast({ message: t('proxyIcon.ruleAddedSuccess'), type: 'success' });
        } else {
          showToast({
            message: t('proxyIcon.ruleSaveFailed', { error: resultError(result) }),
            type: 'error',
          });
        }
      }
    } catch (error) {
      console.error('保存规则失败:', error);
      showToast({
        message: t('proxyIcon.ruleSaveFailed', { error: errorToMessage(error) }),
        type: 'error',
      });
    }
  };

  const handleClearCache = async () => {
    try {
      const proxyIcon = getProxyIconApi();
      if (!proxyIcon) {
        notifyApiUnavailable();
        return;
      }
      const result = await proxyIcon.clearCache();
      if (result.success) {
        notifyProxyIconChanged();
        showToast({ message: t('proxyIcon.cacheClearedSuccess'), type: 'success' });
      } else {
        showToast({
          message: t('proxyIcon.cacheClearFailed', { error: result.error || t('proxyIcon.unknownError') }),
          type: 'error',
        });
      }
    } catch (error) {
      console.error('清除缓存失败:', error);
      showToast({
        message: t('proxyIcon.cacheClearFailed', { error: errorToMessage(error) }),
        type: 'error',
      });
    }
  };

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-muted-foreground">{t('common.loading')}</div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 p-5 text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="text-base font-semibold">{t('proxyIcon.title')}</h3>
            <p className="mt-1 text-sm">{loadError}</p>
          </div>
          <button
            type="button"
            onClick={loadConfig}
            className="inline-flex items-center justify-center rounded-lg bg-red-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-red-700"
          >
            <ReloadIcon className="mr-2 h-4 w-4" />
            {t('proxyIcon.retry')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* 启用开关 */}
      <div className="rounded-2xl bg-white px-4 py-4 shadow-sm dark:bg-[#2a2a2a]">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-medium text-gray-700 dark:text-gray-200">
              {t('proxyIcon.enableIcons')}
            </h3>
            <p className="text-xs text-gray-500 dark:text-gray-300 mt-1">
              {t('proxyIcon.enableIconsDesc')}
            </p>
          </div>
          <button
            onClick={handleToggleEnabled}
            className={`relative h-8 w-14 rounded-full transition ${
              config.enabled ? 'bg-primary' : 'bg-muted'
            }`}
          >
            <div
              className={`absolute top-1 h-6 w-6 rounded-full bg-white shadow-md transition ${
                config.enabled ? 'left-7' : 'left-1'
              }`}
            />
          </button>
        </div>
      </div>

      {/* 规则列表标题 */}
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-base font-medium text-gray-700 dark:text-gray-200">
          {t('proxyIcon.rules')}
        </h3>
        <div className="flex items-center gap-2">
          <button
            onClick={handleToggleAllRules}
            disabled={config.rules.length === 0}
            className="inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-primary/50 disabled:cursor-not-allowed disabled:opacity-60 hover:opacity-90"
            style={{
              backgroundColor: semiTransparentThemeColor,
              color: resolvedThemeColor,
              boxShadow: `inset 0 0 0 1px ${subtleBorderColor}`,
            }}
          >
            <CheckIcon className="h-3 w-3" />
            {allRulesEnabled
              ? t('proxyIcon.selectNone', { defaultValue: '反选' })
              : t('proxyIcon.selectAll', { defaultValue: '全选' })}
          </button>
          <button
            onClick={handleAddRule}
            className="flex items-center gap-2 rounded-lg bg-blue-500 hover:bg-blue-600 px-4 py-2 text-sm font-medium text-white transition"
          >
            <PlusIcon className="h-4 w-4" />
            {t('proxyIcon.addRule')}
          </button>
        </div>
      </div>

      {/* 规则列表 */}
      {config.rules.length === 0 ? (
        <div className="rounded-2xl bg-white px-4 py-8 shadow-sm dark:bg-[#2a2a2a]">
          <p className="text-sm text-gray-500 dark:text-gray-400 text-center">
            {t('proxyIcon.noRules')}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {config.rules
            .sort((a, b) => b.priority - a.priority)
            .map((rule) => (
              <div
                key={rule.id}
                className="flex items-center justify-between p-4 rounded-2xl bg-white shadow-sm dark:bg-[#2a2a2a]"
              >
                <div className="flex items-center gap-4 flex-1">
                  {/* 启用开关 - 自定义checkbox */}
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      checked={rule.enabled}
                      onChange={(e) => handleToggleRule(rule.id, e.target.checked)}
                      className="sr-only peer"
                    />
                    <div
                      className="w-5 h-5 rounded border-2 border-gray-300 dark:border-gray-600 peer-checked:border-transparent transition-all duration-200 flex items-center justify-center"
                      style={{
                        backgroundColor: rule.enabled ? themeColor : 'transparent',
                      }}
                    >
                      {rule.enabled && (
                        <svg
                          className="w-3 h-3 text-white"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={3}
                            d="M5 13l4 4L19 7"
                          />
                        </svg>
                      )}
                    </div>
                  </label>

                  {/* 图标预览 */}
                  {rule.iconType === 'URL' && rule.iconData ? (
                    <img
                      src={rule.iconData}
                      alt={rule.name}
                      className="h-10 w-10 rounded-lg object-cover"
                      onError={(e) => {
                        e.currentTarget.style.display = 'none';
                      }}
                    />
                  ) : rule.iconType === 'BASE64' && rule.iconData ? (
                    <img
                      src={rule.iconData.startsWith('data:') ? rule.iconData : `data:image/png;base64,${rule.iconData}`}
                      alt={rule.name}
                      className="h-10 w-10 rounded-lg object-cover"
                      onError={(e) => {
                        e.currentTarget.style.display = 'none';
                      }}
                    />
                  ) : (
                    <div className="h-10 w-10 rounded-lg bg-gray-200 dark:bg-gray-700 flex items-center justify-center">
                      <span className="text-xs text-gray-500 dark:text-gray-400">?</span>
                    </div>
                  )}

                  {/* 规则信息 */}
                  <div className="flex-1">
                    <p className="text-sm font-medium text-gray-700 dark:text-gray-200">
                      {rule.name}
                    </p>
                    <div className="flex gap-4 mt-1">
                      <span className="text-xs text-gray-500 dark:text-gray-400">
                        {t('proxyIcon.regex')}: {rule.regex}
                      </span>
                      <span className="text-xs text-gray-500 dark:text-gray-400">
                        {t('proxyIcon.priority')}: {rule.priority}
                      </span>
                      <span className="text-xs text-gray-500 dark:text-gray-400">
                        {t('proxyIcon.type')}: {rule.iconType}
                      </span>
                    </div>
                  </div>
                </div>

                {/* 操作按钮 */}
                <div className="flex gap-2">
                  <button
                    onClick={() => handleEditRule(rule)}
                    className="rounded-lg p-2 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition"
                  >
                    <Pencil1Icon className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => handleDeleteRule(rule.id)}
                    className="rounded-lg p-2 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition"
                  >
                    <TrashIcon className="h-4 w-4" />
                  </button>
                </div>
              </div>
            ))}
        </div>
      )}

      {/* 清除缓存按钮 */}
      <div className="rounded-2xl bg-white px-4 py-4 shadow-sm dark:bg-[#2a2a2a]">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-base font-medium text-gray-700 dark:text-gray-200">
              {t('proxyIcon.clearCache')}
            </h3>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
              {t('proxyIcon.clearCacheDesc')}
            </p>
          </div>
          <button
            onClick={handleClearCache}
            className="rounded-lg border border-gray-300 dark:border-gray-600 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition"
          >
            {t('proxyIcon.clearCache')}
          </button>
        </div>
      </div>

      {/* 规则编辑对话框 */}
      <Dialog open={showRuleDialog} onOpenChange={setShowRuleDialog}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {editingRule?.id ? t('proxyIcon.editRule') : t('proxyIcon.addRule')}
            </DialogTitle>
          </DialogHeader>

          {editingRule && (
            <div className="space-y-4">
              {/* 规则名称 */}
              <div>
                <label className="mb-2 block text-sm font-medium">{t('proxyIcon.ruleName')}</label>
                <input
                  type="text"
                  value={editingRule.name}
                  onChange={(e) => setEditingRule({ ...editingRule, name: e.target.value })}
                  className="w-full rounded-lg border border-border bg-background px-4 py-2 focus:outline-none focus:ring-2 focus:ring-primary"
                  placeholder={t('proxyIcon.ruleNamePlaceholder')}
                />
              </div>

              {/* 正则表达式 */}
              <div>
                <label className="mb-2 block text-sm font-medium">{t('proxyIcon.regex')}</label>
                <input
                  type="text"
                  value={editingRule.regex}
                  onChange={(e) => setEditingRule({ ...editingRule, regex: e.target.value })}
                  className="w-full rounded-lg border border-border bg-background px-4 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                  placeholder={t('proxyIcon.regexPlaceholder')}
                />
              </div>

              {/* 图标类型 */}
              <div>
                <label className="mb-2 block text-sm font-medium">{t('proxyIcon.iconType')}</label>
                <div className="flex gap-4">
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      checked={editingRule.iconType === 'URL'}
                      onChange={() => setEditingRule({ ...editingRule, iconType: 'URL' })}
                      className="h-4 w-4"
                    />
                    <span>URL</span>
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      checked={editingRule.iconType === 'BASE64'}
                      onChange={() => setEditingRule({ ...editingRule, iconType: 'BASE64' })}
                      className="h-4 w-4"
                    />
                    <span>Base64</span>
                  </label>
                </div>
              </div>

              {/* 图标数据 */}
              <div>
                <label className="mb-2 block text-sm font-medium">
                  {editingRule.iconType === 'URL' ? t('proxyIcon.iconUrl') : t('proxyIcon.iconBase64')}
                </label>
                <textarea
                  value={editingRule.iconData}
                  onChange={(e) => setEditingRule({ ...editingRule, iconData: e.target.value })}
                  className="w-full rounded-lg border border-border bg-background px-4 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                  rows={editingRule.iconType === 'BASE64' ? 6 : 2}
                  placeholder={
                    editingRule.iconType === 'URL'
                      ? 'https://example.com/icon.png'
                      : 'iVBORw0KGgoAAAANSUhEUgAA...'
                  }
                />
              </div>

              {/* 优先级 */}
              <div>
                <label className="mb-2 block text-sm font-medium">{t('proxyIcon.priority')}</label>
                <input
                  type="number"
                  value={editingRule.priority}
                  onChange={(e) => setEditingRule({ ...editingRule, priority: parseInt(e.target.value) || 0 })}
                  className="w-full rounded-lg border border-border bg-background px-4 py-2 focus:outline-none focus:ring-2 focus:ring-primary"
                  placeholder="0"
                />
                <p className="mt-1 text-xs text-muted-foreground">{t('proxyIcon.priorityDesc')}</p>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setShowRuleDialog(false)}
            >
              {t('common.cancel')}
            </Button>
            <button
              type="button"
              onClick={handleSaveRule}
              className="relative inline-flex items-center justify-center whitespace-nowrap rounded-xl text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-60 overflow-hidden text-white h-11 px-5 transition-all hover:brightness-110"
              style={{
                backgroundColor: themeColor,
                boxShadow: `0 20px 42px -22px ${themeColor}70`
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.boxShadow = `0 24px 52px -20px ${themeColor}90`;
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.boxShadow = `0 20px 42px -22px ${themeColor}70`;
              }}
            >
              {t('common.save')}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default ProxyIconSettings;

