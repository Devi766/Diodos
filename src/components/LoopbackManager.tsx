'use client';

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Search, Shield, ShieldCheck, ShieldX, Loader2, AlertCircle, Save, RefreshCw } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { useThemeColor } from '@/hooks/useThemeColor';

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
  const themeColor = useThemeColor();
  const [apps, setApps] = useState<LoopbackAppItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  // 跟踪用户修改的豁免状态（SID -> boolean）
  const [exemptChanges, setExemptChanges] = useState<Map<string, boolean>>(new Map());

  // 是否有未保存的更改
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
        setExemptChanges(new Map());
      } else {
        setError(result.error || t('tools.loopback.loadError'));
      }
    } catch (err: unknown) {
      console.error('Failed to load UWP app list:', err);
      const message = err instanceof Error ? err.message : String(err);
      setError(message || t('tools.loopback.loadError'));
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
      const originalApp = apps.find(a => a.sid === sid);
      const originalExempt = originalApp?.isExempt ?? false;
      const newExempt = !currentExempt;

      if (newExempt === originalExempt) {
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
        await loadApps();
      } else {
        toast.error(t('tools.loopback.saveError', {
          error: result.error || ''
        }));
      }
    } catch (err: unknown) {
      console.error('Failed to save loopback exemption config:', err);
      const message = err instanceof Error ? err.message : String(err);
      toast.error(t('tools.loopback.saveError', { error: message }));
    } finally {
      setSaving(false);
    }
  }, [apps, getEffectiveExempt, loadApps, t]);
  // 加载中状态
  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-16 space-y-3">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
        <p className="text-sm text-muted-foreground">{t('tools.loopback.loading')}</p>
      </div>
    );
  }

  // 错误状态
  if (error) {
    return (
      <div className="space-y-4 py-2">
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4">
          <div className="flex items-start gap-2.5">
            <AlertCircle className="w-5 h-5 text-destructive mt-0.5 flex-shrink-0" />
            <div>
              <h4 className="font-medium text-destructive">
                {t('tools.loopback.errorTitle')}
              </h4>
              <p className="text-sm text-destructive/80 mt-1">{error}</p>
            </div>
          </div>
        </div>
        <Button onClick={loadApps} variant="default" className="w-full">
          {t('tools.loopback.retry')}
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3 h-full" style={{ WebkitFontSmoothing: 'antialiased', backfaceVisibility: 'hidden' }}>
      {/* 统计信息栏 + 操作按钮 */}
      <div className="flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Shield className="w-4 h-4" />
          <span>
            {t('tools.loopback.stats', {
              total: stats.total,
              exempt: stats.exempt
            })}
          </span>
          {hasChanges && (
            <span className="text-xs text-primary font-medium ml-1">
              ({exemptChanges.size} {t('tools.loopback.modified')})
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            onClick={selectAll}
            className="text-xs h-7 px-2.5"
          >
            {t('tools.loopback.selectAll')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={deselectAll}
            className="text-xs h-7 px-2.5"
          >
            {t('tools.loopback.deselectAll')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={loadApps}
            className="text-xs h-7 w-7 p-0"
            title={t('tools.loopback.retry')}
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>
      {/* 搜索栏 */}
      <div className="relative flex-shrink-0">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
        <Input
          placeholder={t('tools.loopback.searchPlaceholder')}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pl-9 h-9"
        />
        {searchQuery.trim() && (
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
            {filteredApps.length}/{apps.length}
          </span>
        )}
      </div>

      {/* 应用列表 */}
      <div className="overflow-y-auto max-h-[380px] rounded-xl custom-scrollbar" style={{ WebkitFontSmoothing: 'antialiased' }}>
        <div className="flex flex-col p-1">
          {filteredApps.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
              <Search className="w-8 h-8 mb-2 opacity-40" />
              <p className="text-sm">{t('tools.loopback.noResults')}</p>
            </div>
          ) : (
            filteredApps.map((app) => {
              const isExempt = getEffectiveExempt(app);
              const isChanged = exemptChanges.has(app.sid);
              return (
                <div
                  key={app.sid}
                  className={cn(
                    'flex items-center gap-3 px-3 py-2.5 cursor-pointer transition-colors rounded-lg',
                    'hover:bg-accent/50',
                    isChanged && 'bg-primary/5'
                  )}
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
                        <ShieldX className="w-3.5 h-3.5 text-muted-foreground/30 flex-shrink-0" />
                      )}
                      <span className="text-sm font-medium truncate">
                        {app.displayName}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground/60 truncate mt-0.5 pl-5">
                      {app.packageFamilyName}
                    </p>
                  </div>
                  {isChanged && (
                    <span className="text-[11px] text-primary font-medium flex-shrink-0 px-1.5 py-0.5 rounded-md bg-primary/10">
                      {t('tools.loopback.modified')}
                    </span>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* 保存按钮 */}
      <button
        onClick={saveConfig}
        disabled={saving || !hasChanges}
        className="w-full flex-shrink-0 relative inline-flex items-center justify-center whitespace-nowrap rounded-xl text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-60 overflow-hidden text-white h-10 px-5 hover:brightness-110"
        style={{
          backgroundColor: themeColor,
          boxShadow: `0 16px 36px -18px ${themeColor}70`
        }}
        onMouseEnter={(e) => {
          if (!e.currentTarget.disabled) {
            e.currentTarget.style.boxShadow = `0 20px 44px -16px ${themeColor}90`;
          }
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.boxShadow = `0 16px 36px -18px ${themeColor}70`;
        }}
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
            {hasChanges && (
              <span className="ml-1.5 text-xs opacity-80">
                ({exemptChanges.size})
              </span>
            )}
          </>
        )}
      </button>
    </div>
  );
}
