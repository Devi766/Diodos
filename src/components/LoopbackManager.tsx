'use client';

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Search, Shield, ShieldCheck, ShieldX, Loader2, AlertCircle, CheckCircle2, Save } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ScrollArea } from '@/components/ui/scroll-area';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';

interface LoopbackAppItem {
  appContainerName: string;
  displayName: string;
  packageFamilyName: string;
  sid: string;
  workingDir: string;
  isExempt: boolean;
}

export default function LoopbackManager() {
  const { t } = useTranslation();
  const [apps, setApps] = useState<LoopbackAppItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 跟踪用户修改的豁免状态（SID -> boolean）
  const [exemptChanges, setExemptChanges] = useState<Map<string, boolean>>(new Map());

  // 是否有未保存的更改（从 exemptChanges 的大小派生）
  const hasChanges = exemptChanges.size > 0;

  // 加载应用列表
  const loadApps = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (!window.electronAPI?.loopback) {
        setError(t('tools.loopback.noAccess'));
        return;
      }

      const result = await window.electronAPI.loopback.getApps();
      if (result.success && result.apps) {
        setApps(result.apps);
        setIsAdmin(result.isAdmin);
        setExemptChanges(new Map());
      } else {
        setError(result.error || t('tools.loopback.loadError'));
      }
    } catch (err: any) {
      console.error('加载 UWP 应用列表失败:', err);
      setError(err.message || t('tools.loopback.loadError'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    loadApps();
  }, [loadApps]);

  // 切换单个应用的豁免状态
  const toggleExemption = useCallback((sid: string, currentExempt: boolean) => {
    setExemptChanges(prev => {
      const next = new Map(prev);
      // 找到原始状态
      const originalApp = apps.find(a => a.sid === sid);
      const originalExempt = originalApp?.isExempt ?? false;
      const newExempt = !currentExempt;

      if (newExempt === originalExempt) {
        // 恢复到原始状态，移除变更记录
        next.delete(sid);
      } else {
        next.set(sid, newExempt);
      }
      return next;
    });
  }, [apps]);

  // 获取应用的当前豁免状态（考虑用户修改）
  const getEffectiveExempt = useCallback((app: LoopbackAppItem): boolean => {
    if (exemptChanges.has(app.sid)) {
      return exemptChanges.get(app.sid)!;
    }
    return app.isExempt;
  }, [exemptChanges]);

  // 过滤后的应用列表
  const filteredApps = useMemo(() => {
    if (!searchQuery.trim()) return apps;
    const query = searchQuery.toLowerCase();
    return apps.filter(app =>
      app.displayName.toLowerCase().includes(query) ||
      app.packageFamilyName.toLowerCase().includes(query) ||
      app.appContainerName.toLowerCase().includes(query)
    );
  }, [apps, searchQuery]);

  // 统计信息
  const stats = useMemo(() => {
    let exemptCount = 0;
    for (const app of apps) {
      if (getEffectiveExempt(app)) {
        exemptCount++;
      }
    }
    return { total: apps.length, exempt: exemptCount };
  }, [apps, getEffectiveExempt]);

  // 全选当前过滤列表
  const selectAll = useCallback(() => {
    setExemptChanges(prev => {
      const next = new Map(prev);
      for (const app of filteredApps) {
        const originalExempt = app.isExempt;
        if (!originalExempt) {
          next.set(app.sid, true);
        } else {
          next.delete(app.sid);
        }
      }
      return next;
    });
  }, [filteredApps]);

  // 全不选当前过滤列表
  const deselectAll = useCallback(() => {
    setExemptChanges(prev => {
      const next = new Map(prev);
      for (const app of filteredApps) {
        const originalExempt = app.isExempt;
        if (originalExempt) {
          next.set(app.sid, false);
        } else {
          next.delete(app.sid);
        }
      }
      return next;
    });
  }, [filteredApps]);

  // 保存配置
  const saveConfig = useCallback(async () => {
    if (!window.electronAPI?.loopback) return;

    setSaving(true);
    try {
      // 收集所有需要豁免的 SID
      const exemptSids: string[] = [];
      for (const app of apps) {
        if (getEffectiveExempt(app)) {
          exemptSids.push(app.sid);
        }
      }

      const result = await window.electronAPI.loopback.saveConfig(exemptSids);
      if (result.success) {
        toast.success(t('tools.loopback.saveSuccess', {
          count: exemptSids.length
        }));
        // 重新加载以获取最新状态
        await loadApps();
      } else {
        toast.error(t('tools.loopback.saveError', {
          error: result.error || ''
        }));
      }
    } catch (err: any) {
      console.error('保存回环豁免配置失败:', err);
      toast.error(t('tools.loopback.saveError', { error: err.message }));
    } finally {
      setSaving(false);
    }
  }, [apps, getEffectiveExempt, loadApps, t]);

  // 加载中状态
  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-12 space-y-3">
        <Loader2 className="w-8 h-8 animate-spin text-blue-500" />
        <p className="text-sm text-muted-foreground">{t('tools.loopback.loading')}</p>
      </div>
    );
  }

  // 错误状态
  if (error) {
    return (
      <div className="space-y-4">
        <div className="bg-red-50 dark:bg-red-900/20 p-4 rounded-md border border-red-200 dark:border-red-800">
          <div className="flex items-start">
            <AlertCircle className="w-5 h-5 text-red-500 mt-0.5 mr-2 flex-shrink-0" />
            <div>
              <h4 className="font-medium text-red-800 dark:text-red-300">
                {t('tools.loopback.errorTitle')}
              </h4>
              <p className="text-sm text-red-700 dark:text-red-400 mt-1">{error}</p>
            </div>
          </div>
        </div>
        <Button
          onClick={loadApps}
          className="w-full bg-blue-500 hover:bg-blue-600 text-white"
          variant="default"
        >
          {t('tools.loopback.retry')}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* 管理员权限提示 */}
      {!isAdmin && (
        <div className="bg-amber-50 dark:bg-amber-900/20 p-3 rounded-md border border-amber-200 dark:border-amber-800">
          <div className="flex items-center">
            <ShieldX className="w-4 h-4 text-amber-500 mr-2 flex-shrink-0" />
            <p className="text-sm text-amber-700 dark:text-amber-400">
              {t('tools.loopback.noAdmin')}
            </p>
          </div>
        </div>
      )}

      {/* 统计信息和操作栏 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Shield className="w-4 h-4" />
          <span>
            {t('tools.loopback.stats', {
              total: stats.total,
              exempt: stats.exempt
            })}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={selectAll}
            className="text-xs h-7 px-2"
          >
            {t('tools.loopback.selectAll')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={deselectAll}
            className="text-xs h-7 px-2"
          >
            {t('tools.loopback.deselectAll')}
          </Button>
        </div>
      </div>

      {/* 搜索栏 */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          placeholder={t('tools.loopback.searchPlaceholder')}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pl-9"
        />
      </div>

      {/* 应用列表 */}
      <ScrollArea className="h-[360px] rounded-md border border-gray-200 dark:border-gray-700">
        <div className="divide-y divide-gray-100 dark:divide-gray-800">
          {filteredApps.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
              <Search className="w-8 h-8 mb-2 opacity-50" />
              <p className="text-sm">{t('tools.loopback.noResults')}</p>
            </div>
          ) : (
            filteredApps.map((app) => {
              const isExempt = getEffectiveExempt(app);
              const isChanged = exemptChanges.has(app.sid);
              return (
                <div
                  key={app.sid}
                  className={`flex items-center gap-3 px-3 py-2.5 hover:bg-gray-50 dark:hover:bg-gray-800/50 cursor-pointer transition-colors ${
                    isChanged ? 'bg-blue-50/50 dark:bg-blue-900/10' : ''
                  }`}
                  onClick={() => toggleExemption(app.sid, isExempt)}
                >
                  <Checkbox
                    checked={isExempt}
                    onCheckedChange={() => toggleExemption(app.sid, isExempt)}
                    className="flex-shrink-0"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      {isExempt ? (
                        <ShieldCheck className="w-3.5 h-3.5 text-green-500 flex-shrink-0" />
                      ) : (
                        <ShieldX className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />
                      )}
                      <span className="text-sm font-medium truncate">
                        {app.displayName}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground truncate mt-0.5">
                      {app.packageFamilyName}
                    </p>
                  </div>
                  {isChanged && (
                    <span className="text-xs text-blue-500 flex-shrink-0">
                      {t('tools.loopback.modified')}
                    </span>
                  )}
                </div>
              );
            })
          )}
        </div>
      </ScrollArea>

      {/* 保存按钮 */}
      <Button
        onClick={saveConfig}
        disabled={saving || !isAdmin || !hasChanges}
        className="w-full bg-blue-500 hover:bg-blue-600 text-white disabled:opacity-50"
        variant="default"
      >
        {saving ? (
          <>
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            {t('tools.loopback.saving')}
          </>
        ) : (
          <>
            <Save className="w-4 h-4 mr-2" />
            {t('tools.loopback.save')}
          </>
        )}
      </Button>
    </div>
  );
}
