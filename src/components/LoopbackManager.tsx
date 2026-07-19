'use client';

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Search,
  Shield,
  ShieldCheck,
  ShieldX,
  Loader2,
  AlertCircle,
  Save,
  RefreshCw,
  ExternalLink,
  Filter,
} from 'lucide-react';
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

type LoopbackApi = NonNullable<NonNullable<Window['electronAPI']>['loopback']>;

const TAURI_RUNTIME_UNAVAILABLE = 'Tauri runtime is not available';

const getLoopbackApi = () => {
  if (typeof window === 'undefined') return undefined;
  return window.electronAPI?.loopback;
};

const hasLoopbackMethod = <K extends string>(
  api: LoopbackApi | undefined,
  method: K
): api is LoopbackApi & Record<K, (...args: any[]) => Promise<any>> => {
  try {
    return !!api && typeof (api as unknown as Record<string, unknown>)[method] === 'function';
  } catch {
    return false;
  }
};

export default function LoopbackManager() {
  const { t } = useTranslation();
  const themeColor = useThemeColor();
  const [apps, setApps] = useState<LoopbackAppItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [openingTool, setOpeningTool] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [toolAvailable, setToolAvailable] = useState(false);
  const [exemptOnly, setExemptOnly] = useState(false);
  // 跟踪用户修改的豁免状态（SID -> boolean）
  const [exemptChanges, setExemptChanges] = useState<Map<string, boolean>>(new Map());

  const hasChanges = exemptChanges.size > 0;

  const friendlyError = useCallback(
    (error: unknown, fallback: string) => {
      const message =
        error instanceof Error ? error.message : error ? String(error) : fallback;
      return message.includes(TAURI_RUNTIME_UNAVAILABLE)
        ? t('tools.loopback.apiUnavailable')
        : message;
    },
    [t]
  );

  const loadApps = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const api = getLoopbackApi();
      if (!hasLoopbackMethod(api, 'getApps')) {
        const message = t('tools.loopback.apiUnavailable');
        setError(message);
        toast.error(message);
        return;
      }

      const result = await api.getApps();
      if (result.success && result.apps) {
        setApps(result.apps);
        setExemptChanges(new Map());
        if (typeof result.toolAvailable === 'boolean') {
          setToolAvailable(result.toolAvailable);
        } else if (hasLoopbackMethod(api, 'toolAvailable')) {
          try {
            const tool = await api.toolAvailable();
            setToolAvailable(!!tool?.available);
          } catch {
            setToolAvailable(false);
          }
        }
      } else {
        const message = friendlyError(result.error, t('tools.loopback.loadError'));
        setError(message);
        toast.error(message);
        if (typeof result.toolAvailable === 'boolean') {
          setToolAvailable(result.toolAvailable);
        }
      }
    } catch (err: unknown) {
      console.error('Failed to load UWP app list:', err);
      const message = friendlyError(err, t('tools.loopback.loadError'));
      setError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }, [friendlyError, t]);

  useEffect(() => {
    loadApps();
  }, [loadApps]);

  const toggleExemption = useCallback(
    (sid: string, currentExempt: boolean) => {
      setExemptChanges((prev) => {
        const next = new Map(prev);
        const originalApp = apps.find((a) => a.sid === sid);
        const originalExempt = originalApp?.isExempt ?? false;
        const newExempt = !currentExempt;

        if (newExempt === originalExempt) {
          next.delete(sid);
        } else {
          next.set(sid, newExempt);
        }
        return next;
      });
    },
    [apps]
  );

  const getEffectiveExempt = useCallback(
    (app: LoopbackAppItem): boolean => {
      if (exemptChanges.has(app.sid)) {
        return exemptChanges.get(app.sid)!;
      }
      return app.isExempt;
    },
    [exemptChanges]
  );

  const filteredApps = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return apps.filter((app) => {
      if (exemptOnly && !getEffectiveExempt(app)) {
        return false;
      }
      if (!query) return true;
      return (
        app.displayName.toLowerCase().includes(query) ||
        app.packageFamilyName.toLowerCase().includes(query) ||
        app.appContainerName.toLowerCase().includes(query)
      );
    });
  }, [apps, searchQuery, exemptOnly, getEffectiveExempt]);

  const stats = useMemo(() => {
    let exemptCount = 0;
    for (const app of apps) {
      if (getEffectiveExempt(app)) {
        exemptCount++;
      }
    }
    return { total: apps.length, exempt: exemptCount };
  }, [apps, getEffectiveExempt]);

  const selectAll = useCallback(() => {
    setExemptChanges((prev) => {
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

  const deselectAll = useCallback(() => {
    setExemptChanges((prev) => {
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

  const saveConfig = useCallback(async () => {
    const api = getLoopbackApi();
    if (!hasLoopbackMethod(api, 'saveConfig')) {
      toast.error(t('tools.loopback.apiUnavailable'));
      return;
    }

    setSaving(true);
    try {
      const exemptSids: string[] = [];
      for (const app of apps) {
        if (getEffectiveExempt(app)) {
          exemptSids.push(app.sid);
        }
      }

      const result = await api.saveConfig(exemptSids);
      if (result.success) {
        toast.success(
          t('tools.loopback.saveSuccess', {
            count: exemptSids.length,
          })
        );
        await loadApps();
      } else {
        toast.error(
          t('tools.loopback.saveError', {
            error: friendlyError(result.error, t('tools.loopback.loadError')),
          })
        );
      }
    } catch (err: unknown) {
      console.error('Failed to save loopback exemption config:', err);
      const message = friendlyError(err, t('tools.loopback.loadError'));
      toast.error(t('tools.loopback.saveError', { error: message }));
    } finally {
      setSaving(false);
    }
  }, [apps, friendlyError, getEffectiveExempt, loadApps, t]);

  const openExternalTool = useCallback(async () => {
    const api = getLoopbackApi();
    const open =
      (hasLoopbackMethod(api, 'openTool') && api.openTool) ||
      (hasLoopbackMethod(api, 'launchEnableLoopback') && api.launchEnableLoopback);
    if (!open) {
      toast.error(t('tools.loopback.toolUnavailable'));
      return;
    }

    setOpeningTool(true);
    try {
      const result = await open();
      if (result?.success) {
        toast.success(t('tools.loopback.openExternalToolSuccess'));
      } else {
        toast.error(
          t('tools.loopback.openExternalToolError', {
            error: friendlyError(result?.error, t('tools.enableLoopback.error')),
          })
        );
      }
    } catch (err: unknown) {
      toast.error(
        t('tools.loopback.openExternalToolError', {
          error: friendlyError(err, t('tools.enableLoopback.error')),
        })
      );
    } finally {
      setOpeningTool(false);
    }
  }, [friendlyError, t]);

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-16 space-y-3">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
        <p className="text-sm text-muted-foreground">{t('tools.loopback.loading')}</p>
      </div>
    );
  }

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
              <p className="text-xs text-muted-foreground mt-2">{t('tools.loopback.hint')}</p>
            </div>
          </div>
        </div>
        <div className="flex gap-2">
          <Button onClick={loadApps} variant="default" className="flex-1">
            {t('tools.loopback.retry')}
          </Button>
          <Button
            onClick={openExternalTool}
            variant="outline"
            className="flex-1"
            disabled={openingTool}
            title={t('tools.loopback.openExternalToolHint')}
          >
            {openingTool ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <ExternalLink className="w-4 h-4 mr-2" />
            )}
            {t('tools.loopback.openExternalTool')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="flex flex-col gap-3 h-full"
      style={{ WebkitFontSmoothing: 'antialiased', backfaceVisibility: 'hidden' }}
    >
      <div className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        {t('tools.loopback.hint')}
      </div>

      {/* 统计信息栏 + 操作按钮 */}
      <div className="flex items-center justify-between flex-shrink-0 gap-2 flex-wrap">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Shield className="w-4 h-4" />
          <span>
            {t('tools.loopback.stats', {
              total: stats.total,
              exempt: stats.exempt,
            })}
          </span>
          {hasChanges && (
            <span className="text-xs text-primary font-medium ml-1">
              ({exemptChanges.size} {t('tools.loopback.modified')})
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 flex-wrap justify-end">
          <Button
            variant={exemptOnly ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setExemptOnly((v) => !v)}
            className="text-xs h-7 px-2.5"
            title={exemptOnly ? t('tools.loopback.showAll') : t('tools.loopback.exemptOnly')}
          >
            <Filter className="w-3.5 h-3.5 mr-1" />
            {exemptOnly ? t('tools.loopback.showAll') : t('tools.loopback.exemptOnly')}
          </Button>
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
          <Button
            variant="outline"
            size="sm"
            onClick={openExternalTool}
            disabled={openingTool}
            className="text-xs h-7 px-2.5"
            title={t('tools.loopback.openExternalToolHint')}
          >
            {openingTool ? (
              <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
            ) : (
              <ExternalLink className="w-3.5 h-3.5 mr-1" />
            )}
            {t('tools.loopback.openExternalTool')}
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
        {(searchQuery.trim() || exemptOnly) && (
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
            {filteredApps.length}/{apps.length}
          </span>
        )}
      </div>

      {/* 应用列表 */}
      <div
        className="overflow-y-auto max-h-[380px] rounded-xl custom-scrollbar"
        style={{ WebkitFontSmoothing: 'antialiased' }}
      >
        <div className="flex flex-col p-1">
          {filteredApps.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
              <Search className="w-8 h-8 mb-2 opacity-40" />
              <p className="text-sm">
                {apps.length === 0
                  ? t('tools.loopback.empty')
                  : t('tools.loopback.noResults')}
              </p>
              {toolAvailable && (
                <Button
                  variant="link"
                  size="sm"
                  className="mt-2"
                  onClick={openExternalTool}
                  disabled={openingTool}
                >
                  <ExternalLink className="w-3.5 h-3.5 mr-1" />
                  {t('tools.loopback.openExternalTool')}
                </Button>
              )}
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
          boxShadow: `0 16px 36px -18px ${themeColor}70`,
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
              <span className="ml-1.5 text-xs opacity-80">({exemptChanges.size})</span>
            )}
          </>
        )}
      </button>
    </div>
  );
}
