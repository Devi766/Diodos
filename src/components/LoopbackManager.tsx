'use client';

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  Search,
  Shield,
  ShieldCheck,
  ShieldX,
  Loader2,
  AlertCircle,
  RefreshCw,
  Filter,
  AppWindow,
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

interface LoopbackAppItem {
  appContainerName: string;
  displayName: string;
  packageFamilyName: string;
  sid: string;
  workingDir: string;
  isExempt: boolean;
  iconDataUrl?: string | null;
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
  const [apps, setApps] = useState<LoopbackAppItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingSid, setSavingSid] = useState<string | null>(null);
  const [bulkSaving, setBulkSaving] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [exemptOnly, setExemptOnly] = useState(false);
  const appsRef = useRef<LoopbackAppItem[]>([]);

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
        const next = result.apps as LoopbackAppItem[];
        appsRef.current = next;
        setApps(next);
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

  const persistExemptions = useCallback(
    async (nextApps: LoopbackAppItem[], successMessage?: string) => {
      const api = getLoopbackApi();
      if (!hasLoopbackMethod(api, 'saveConfig')) {
        toast.error(t('tools.loopback.apiUnavailable'));
        return false;
      }

      const exemptSids = nextApps.filter((app) => app.isExempt).map((app) => app.sid);
      try {
        const result = await api.saveConfig(exemptSids);
        if (result.success) {
          appsRef.current = nextApps;
          setApps(nextApps);
          if (successMessage) {
            toast.success(successMessage);
          }
          return true;
        }

        toast.error(
          t('tools.loopback.saveError', {
            error: friendlyError(result.error, t('tools.loopback.loadError')),
          })
        );
        return false;
      } catch (err: unknown) {
        toast.error(
          t('tools.loopback.saveError', {
            error: friendlyError(err, t('tools.loopback.loadError')),
          })
        );
        return false;
      }
    },
    [friendlyError, t]
  );

  const toggleExemption = useCallback(
    async (sid: string) => {
      if (savingSid || bulkSaving) return;
      const current = appsRef.current;
      const target = current.find((app) => app.sid === sid);
      if (!target) return;

      const nextApps = current.map((app) =>
        app.sid === sid ? { ...app, isExempt: !app.isExempt } : app
      );
      // Optimistic UI update.
      setApps(nextApps);
      setSavingSid(sid);
      const ok = await persistExemptions(nextApps);
      if (!ok) {
        // Roll back on failure.
        setApps(current);
        appsRef.current = current;
      }
      setSavingSid(null);
    },
    [bulkSaving, persistExemptions, savingSid]
  );

  const filteredApps = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return apps.filter((app) => {
      if (exemptOnly && !app.isExempt) {
        return false;
      }
      if (!query) return true;
      return (
        app.displayName.toLowerCase().includes(query) ||
        app.packageFamilyName.toLowerCase().includes(query) ||
        app.appContainerName.toLowerCase().includes(query)
      );
    });
  }, [apps, searchQuery, exemptOnly]);

  const stats = useMemo(() => {
    let exemptCount = 0;
    for (const app of apps) {
      if (app.isExempt) exemptCount++;
    }
    return { total: apps.length, exempt: exemptCount };
  }, [apps]);

  const selectAllVisible = useCallback(async () => {
    if (bulkSaving || savingSid) return;
    const visible = new Set(filteredApps.map((app) => app.sid));
    const current = appsRef.current;
    const nextApps = current.map((app) =>
      visible.has(app.sid) ? { ...app, isExempt: true } : app
    );
    setApps(nextApps);
    setBulkSaving(true);
    const ok = await persistExemptions(nextApps);
    if (!ok) {
      setApps(current);
      appsRef.current = current;
    }
    setBulkSaving(false);
  }, [bulkSaving, filteredApps, persistExemptions, savingSid]);

  const deselectAllVisible = useCallback(async () => {
    if (bulkSaving || savingSid) return;
    const visible = new Set(filteredApps.map((app) => app.sid));
    const current = appsRef.current;
    const nextApps = current.map((app) =>
      visible.has(app.sid) ? { ...app, isExempt: false } : app
    );
    setApps(nextApps);
    setBulkSaving(true);
    const ok = await persistExemptions(nextApps);
    if (!ok) {
      setApps(current);
      appsRef.current = current;
    }
    setBulkSaving(false);
  }, [bulkSaving, filteredApps, persistExemptions, savingSid]);

  const applyBulk = useCallback(
    async (mode: 'all' | 'none') => {
      if (bulkSaving || savingSid) return;
      const confirmed = window.confirm(
        mode === 'all'
          ? t('tools.loopback.confirmExemptAll')
          : t('tools.loopback.confirmClearAll')
      );
      if (!confirmed) return;

      const api = getLoopbackApi();
      const bulkMethod =
        mode === 'all'
          ? hasLoopbackMethod(api, 'exemptAll')
            ? api.exemptAll
            : null
          : hasLoopbackMethod(api, 'clearAll')
            ? api.clearAll
            : null;

      setBulkSaving(true);
      try {
        if (bulkMethod) {
          const result = await bulkMethod();
          if (result?.success) {
            toast.success(
              mode === 'all'
                ? t('tools.loopback.exemptAllSuccess', {
                    count: result.count ?? appsRef.current.length,
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
        } else {
          const current = appsRef.current;
          const nextApps = current.map((app) => ({
            ...app,
            isExempt: mode === 'all',
          }));
          setApps(nextApps);
          const ok = await persistExemptions(
            nextApps,
            mode === 'all'
              ? t('tools.loopback.exemptAllSuccess', { count: nextApps.length })
              : t('tools.loopback.clearAllSuccess')
          );
          if (!ok) {
            setApps(current);
            appsRef.current = current;
          }
        }
      } finally {
        setBulkSaving(false);
      }
    },
    [bulkSaving, friendlyError, loadApps, persistExemptions, savingSid, t]
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
          {(savingSid || bulkSaving) && (
            <span className="inline-flex items-center gap-1 text-xs text-primary">
              <Loader2 className="h-3 w-3 animate-spin" />
              {t('tools.loopback.saving')}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <Button
            variant="outline"
            size="sm"
            onClick={() => applyBulk('all')}
            disabled={bulkSaving || !!savingSid || apps.length === 0}
            className="h-7 px-2.5 text-xs"
          >
            {t('tools.loopback.exemptAll')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => applyBulk('none')}
            disabled={bulkSaving || !!savingSid || stats.exempt === 0}
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
            onClick={selectAllVisible}
            disabled={bulkSaving || !!savingSid}
            className="h-7 px-2.5 text-xs"
          >
            {t('tools.loopback.selectAll')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={deselectAllVisible}
            disabled={bulkSaving || !!savingSid}
            className="h-7 px-2.5 text-xs"
          >
            {t('tools.loopback.deselectAll')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={loadApps}
            disabled={bulkSaving || !!savingSid}
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
              const isSaving = savingSid === app.sid;
              return (
                <div
                  key={app.sid}
                  className={cn(
                    'flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 transition-colors',
                    'hover:bg-accent/50',
                    isSaving && 'opacity-70'
                  )}
                  onClick={() => {
                    void toggleExemption(app.sid);
                  }}
                >
                  <Checkbox
                    checked={app.isExempt}
                    disabled={isSaving || bulkSaving}
                    onCheckedChange={() => {
                      void toggleExemption(app.sid);
                    }}
                    className="flex-shrink-0"
                  />
                  <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted/60">
                    {app.iconDataUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={app.iconDataUrl}
                        alt=""
                        className="h-full w-full object-contain"
                        draggable={false}
                      />
                    ) : (
                      <AppWindow className="h-4 w-4 text-muted-foreground/70" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      {app.isExempt ? (
                        <ShieldCheck className="h-3.5 w-3.5 flex-shrink-0 text-green-500" />
                      ) : (
                        <ShieldX className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground/30" />
                      )}
                      <span className="truncate text-sm font-medium">
                        {app.displayName}
                      </span>
                      {isSaving && (
                        <Loader2 className="h-3 w-3 animate-spin text-primary" />
                      )}
                    </div>
                    <p className="mt-0.5 truncate pl-5 text-xs text-muted-foreground/60">
                      {app.packageFamilyName}
                    </p>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
