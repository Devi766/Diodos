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
  const [searchQuery, setSearchQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [exemptOnly, setExemptOnly] = useState(false);
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
      } else {
        const message = friendlyError(result.error, t('tools.loopback.loadError'));
        setError(message);
        toast.error(message);
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
        if (!app.isExempt) {
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
        if (app.isExempt) {
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

  const applyBulk = useCallback(
    async (mode: 'all' | 'none') => {
      const api = getLoopbackApi();
      const method =
        mode === 'all'
          ? hasLoopbackMethod(api, 'exemptAll')
            ? api.exemptAll
            : null
          : hasLoopbackMethod(api, 'clearAll')
            ? api.clearAll
            : null;

      if (!method) {
        // Fallback to saveConfig with computed SID list when bulk APIs are missing.
        if (!hasLoopbackMethod(api, 'saveConfig')) {
          toast.error(t('tools.loopback.apiUnavailable'));
          return;
        }
        const sids = mode === 'all' ? apps.map((app) => app.sid) : [];
        setSaving(true);
        try {
          const result = await api.saveConfig(sids);
          if (result.success) {
            toast.success(
              mode === 'all'
                ? t('tools.loopback.exemptAllSuccess', { count: sids.length })
                : t('tools.loopback.clearAllSuccess')
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
          toast.error(
            t('tools.loopback.saveError', {
              error: friendlyError(err, t('tools.loopback.loadError')),
            })
          );
        } finally {
          setSaving(false);
        }
        return;
      }

      const confirmed = window.confirm(
        mode === 'all'
          ? t('tools.loopback.confirmExemptAll')
          : t('tools.loopback.confirmClearAll')
      );
      if (!confirmed) return;

      setSaving(true);
      try {
        const result = await method();
        if (result?.success) {
          toast.success(
            mode === 'all'
              ? t('tools.loopback.exemptAllSuccess', {
                  count: result.count ?? apps.length,
                })
              : t('tools.loopback.clearAllSuccess')
          );
          await loadApps();
        } else {
          toast.error(
            t('tools.loopback.saveError', {
              error: friendlyError(result?.error, t('tools.loopback.loadError')),
            })
          );
        }
      } catch (err: unknown) {
        toast.error(
          t('tools.loopback.saveError', {
            error: friendlyError(err, t('tools.loopback.loadError')),
          })
        );
      } finally {
        setSaving(false);
      }
    },
    [apps, friendlyError, loadApps, t]
  );

  if (loading) {
    return (
      <div className="flex h-full min-h-[240px] flex-col items-center justify-center space-y-3 py-10">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <p className="text-sm text-muted-foreground">{t('tools.loopback.loading')}</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full min-h-[240px] flex-col justify-center space-y-4 py-2">
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4">
          <div className="flex items-start gap-2.5">
            <AlertCircle className="mt-0.5 h-5 w-5 flex-shrink-0 text-destructive" />
            <div>
              <h4 className="font-medium text-destructive">
                {t('tools.loopback.errorTitle')}
              </h4>
              <p className="mt-1 text-sm text-destructive/80">{error}</p>
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
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex flex-shrink-0 flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Shield className="h-4 w-4" />
          <span>
            {t('tools.loopback.stats', {
              total: stats.total,
              exempt: stats.exempt,
            })}
          </span>
          {hasChanges && (
            <span className="ml-1 text-xs font-medium text-primary">
              ({exemptChanges.size} {t('tools.loopback.modified')})
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <Button
            variant="outline"
            size="sm"
            onClick={() => applyBulk('all')}
            disabled={saving || apps.length === 0}
            className="h-7 px-2.5 text-xs"
          >
            {t('tools.loopback.exemptAll')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => applyBulk('none')}
            disabled={saving || stats.exempt === 0}
            className="h-7 px-2.5 text-xs"
          >
            {t('tools.loopback.clearAll')}
          </Button>
          <Button
            variant={exemptOnly ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setExemptOnly((value) => !value)}
            className="h-7 px-2.5 text-xs"
            title={exemptOnly ? t('tools.loopback.showAll') : t('tools.loopback.exemptOnly')}
          >
            <Filter className="mr-1 h-3.5 w-3.5" />
            {exemptOnly ? t('tools.loopback.showAll') : t('tools.loopback.exemptOnly')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={selectAll}
            className="h-7 px-2.5 text-xs"
          >
            {t('tools.loopback.selectAll')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={deselectAll}
            className="h-7 px-2.5 text-xs"
          >
            {t('tools.loopback.deselectAll')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={loadApps}
            className="h-7 w-7 p-0 text-xs"
            title={t('tools.loopback.retry')}
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <div className="relative flex-shrink-0">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder={t('tools.loopback.searchPlaceholder')}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="h-9 pl-9"
        />
        {(searchQuery.trim() || exemptOnly) && (
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
            {filteredApps.length}/{apps.length}
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto rounded-xl custom-scrollbar">
        <div className="flex flex-col p-1">
          {filteredApps.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
              <Search className="mb-2 h-8 w-8 opacity-40" />
              <p className="text-sm">
                {apps.length === 0
                  ? t('tools.loopback.empty')
                  : t('tools.loopback.noResults')}
              </p>
            </div>
          ) : (
            filteredApps.map((app) => {
              const isExempt = getEffectiveExempt(app);
              const isChanged = exemptChanges.has(app.sid);
              return (
                <div
                  key={app.sid}
                  className={cn(
                    'flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 transition-colors',
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
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      {isExempt ? (
                        <ShieldCheck className="h-3.5 w-3.5 flex-shrink-0 text-green-500" />
                      ) : (
                        <ShieldX className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground/30" />
                      )}
                      <span className="truncate text-sm font-medium">
                        {app.displayName}
                      </span>
                    </div>
                    <p className="mt-0.5 truncate pl-5 text-xs text-muted-foreground/60">
                      {app.packageFamilyName}
                    </p>
                  </div>
                  {isChanged && (
                    <span className="flex-shrink-0 rounded-md bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary">
                      {t('tools.loopback.modified')}
                    </span>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>

      <button
        onClick={saveConfig}
        disabled={saving || !hasChanges}
        className="h-10 w-full flex-shrink-0 relative inline-flex items-center justify-center overflow-hidden whitespace-nowrap rounded-xl px-5 text-sm font-medium text-white transition-all hover:brightness-110 disabled:pointer-events-none disabled:opacity-60"
        style={{
          backgroundColor: themeColor,
          boxShadow: `0 16px 36px -18px ${themeColor}70`,
        }}
      >
        {saving ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            {t('tools.loopback.saving')}
          </>
        ) : (
          <>
            <Save className="mr-2 h-4 w-4" />
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
