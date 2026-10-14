'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, ArrowRight, Check, Copy, Globe, Loader2, Network, Play, Route, Settings2, Square, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { RouteGlobe } from '@/components/dashboard-cards/RouteGlobe';
import { routePoints, isPublicIpv4, type RoutePoint } from '@/lib/route-trace';
import { createMtrReport, mtrToolRunner, normalizeMtrTarget } from '@/lib/mtr-tools';
import { fetchIpInfo } from '@/utils/ip-info';
import { cn } from '@/lib/utils';

const COLUMN_KEYS = ['hop', 'ip', 'sent', 'received', 'loss', 'avg', 'min', 'max', 'location'] as const;
const KNOWN_ERRORS = ['invalid_target', 'ipv6_only', 'invalid_probe_address', 'dns_failed', 'no_entry', 'core_unavailable', 'physical_interface_unavailable', 'permission', 'probe_unavailable', 'route_changed'] as const;

export default function MtrTools() {
  const { t } = useTranslation();
  const state = mtrToolRunner.useSnapshot();
  const [target, setTarget] = useState(() => state.requestedTarget || state.target || '');
  const [settings, setSettings] = useState(false);
  const [maxHops, setMaxHops] = useState(24);
  const [count, setCount] = useState(3);
  const [timeoutMs, setTimeoutMs] = useState(1000);
  const [quickLoading, setQuickLoading] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const quickGeneration = useRef(0);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const busy = state.running || quickLoading;
  const points = useMemo(() => routePoints(state.hops), [state.hops]);
  const destination: RoutePoint | undefined = useMemo(() => state.targetGeo?.latitude !== undefined && state.targetGeo.longitude !== undefined
    ? { lat: state.targetGeo.latitude, lon: state.targetGeo.longitude, label: state.targetGeo.city || state.targetGeo.country || '' } : undefined, [state.targetGeo]);
  const reached = state.hops.some(hop => hop.reached);
  const responded = state.hops.filter(hop => hop.received > 0).length;
  const last = [...state.hops].reverse().find(hop => hop.received > 0);
  const milliseconds = (value: number | null | undefined) => value === null || value === undefined ? '--' : `${value.toFixed(1)} ms`;
  const error = localError || state.error;
  const errorKey = error ? KNOWN_ERRORS.find(key => error.includes(key)) || 'failed' : null;
  const status = quickLoading || state.preparing ? 'preparing' : state.running ? 'running' : state.error ? 'failed'
    : state.hops.length ? reached ? 'reached' : 'finished' : 'idle';

  useEffect(() => () => { quickGeneration.current += 1; clearTimeout(copyTimer.current); }, []);
  const stop = () => { quickGeneration.current += 1; setQuickLoading(false); mtrToolRunner.stop(); };
  const start = (nodeEntry = false) => {
    if (busy) return;
    setLocalError(null);
    try {
      const value = nodeEntry ? undefined : normalizeMtrTarget(target);
      void mtrToolRunner.start({ target: value, maxHops, count, timeoutMs });
    } catch (error) { setLocalError(error instanceof Error ? error.message : 'invalid_target'); }
  };
  const testExit = async () => {
    if (busy) return;
    const id = ++quickGeneration.current;
    setLocalError(null); setQuickLoading(true);
    try {
      const info = await fetchIpInfo();
      if (id !== quickGeneration.current) return;
      const ip = normalizeMtrTarget(info.ip); setTarget(ip); setQuickLoading(false);
      void mtrToolRunner.start({ target: ip, maxHops, count, timeoutMs });
    } catch { if (id === quickGeneration.current) { setQuickLoading(false); setLocalError('exit_failed'); } }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(createMtrReport(state, COLUMN_KEYS.map(key => t(`tools.mtr.columns.${key}`))));
      setCopied(true); clearTimeout(copyTimer.current); copyTimer.current = setTimeout(() => setCopied(false), 2000);
    } catch { setLocalError('copy_failed'); }
  };

  return (
    <div className="space-y-5 pb-2">
      <Link href="/tools" className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"><ArrowLeft className="size-3.5" />{t('tools.title')}</Link>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-control bg-primary/10 text-primary"><Route className="size-5" /></div>
          <div><h1 className="text-2xl font-semibold text-foreground">{t('tools.mtr.title')}</h1><p className="mt-1 text-sm text-muted-foreground">{t('tools.mtr.subtitle')}</p></div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" disabled={!state.hops.length} onClick={() => void copy()}>{copied ? <Check className="mr-1.5 size-4" /> : <Copy className="mr-1.5 size-4" />}{t(copied ? 'tools.mtr.copied' : 'tools.mtr.copy')}</Button>
          <Button variant="ghost" size="sm" disabled={busy || !state.hops.length} onClick={() => { mtrToolRunner.clear(); setLocalError(null); }}><Trash2 className="mr-1.5 size-4" />{t('tools.mtr.clear')}</Button>
        </div>
      </div>

      <section className="dashboard-card p-5">
        <form onSubmit={event => { event.preventDefault(); if (busy) stop(); else start(); }}>
          <label htmlFor="mtr-target" className="mb-2 block text-xs font-medium text-muted-foreground">{t('tools.mtr.target')}</label>
          <div className="flex flex-col gap-3 sm:flex-row">
            <Input id="mtr-target" value={target} onChange={event => setTarget(event.target.value)} placeholder={t('tools.mtr.placeholder')} disabled={busy} spellCheck={false} autoComplete="off" className="min-w-0 flex-1 border bg-muted/20 font-mono" aria-invalid={localError === 'invalid_target'} />
            <Button type="submit" variant={busy ? 'destructive' : 'primary'} className="sm:min-w-32">{busy ? <Square className="mr-2 size-4" /> : <Play className="mr-2 size-4" />}{t(busy ? 'tools.mtr.stop' : 'tools.mtr.start')}</Button>
          </div>
        </form>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" disabled={busy} onClick={() => start(true)} className="inline-flex items-center gap-1.5 rounded-pill bg-primary/5 px-3 py-1.5 text-xs text-primary transition-colors hover:bg-primary/10 disabled:opacity-40"><Network className="size-3.5" />{t('tools.mtr.entry')}<ArrowRight className="size-3" /></button>
          <button type="button" disabled={busy} onClick={() => void testExit()} className="inline-flex items-center gap-1.5 rounded-pill bg-primary/5 px-3 py-1.5 text-xs text-primary transition-colors hover:bg-primary/10 disabled:opacity-40"><Globe className="size-3.5" />{t('tools.mtr.exit')}<ArrowRight className="size-3" /></button>
          <button type="button" onClick={() => setSettings(!settings)} aria-expanded={settings} aria-controls="mtr-settings" className="ml-auto inline-flex items-center gap-1.5 rounded-pill px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted/30"><Settings2 className="size-3.5" />{t('tools.mtr.settings')}</button>
        </div>
        {settings && <div id="mtr-settings" className="mt-4 grid gap-3 border-t border-border/30 pt-4 sm:grid-cols-3">
          {[
            { key: 'maxHops', value: maxHops, set: setMaxHops, values: [8, 16, 24] },
            { key: 'probeCount', value: count, set: setCount, values: [1, 2, 3] },
            { key: 'timeout', value: timeoutMs, set: setTimeoutMs, values: [500, 1000, 2000] },
          ].map(item => <label key={item.key} className="flex flex-col gap-1.5 text-xs text-muted-foreground">{t(`tools.mtr.${item.key}`)}
            <select value={item.value} disabled={busy} onChange={event => item.set(Number(event.target.value))} className="h-9 rounded-control border border-border/40 bg-white/50 px-3 text-foreground dark:bg-white/5">{item.values.map(value => <option key={value} value={value}>{value}{item.key === 'timeout' ? ' ms' : ''}</option>)}</select>
          </label>)}
        </div>}
      </section>

      {error && <div role="alert" className="rounded-nested border border-red-500/15 bg-red-500/5 px-4 py-3 text-sm text-red-600 dark:text-red-400">{t(`tools.mtr.errors.${localError === 'exit_failed' || localError === 'copy_failed' ? localError : errorKey}`)}</div>}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_19rem]">
        <section className="dashboard-card relative isolate h-[300px] overflow-hidden sm:h-[340px]">
          <RouteGlobe points={points} destination={destination} running={state.running} />
          <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-4 bg-gradient-to-b from-white via-white/80 to-transparent p-5 pb-12 dark:from-[#2a2a2a] dark:via-[#2a2a2a]/80">
            <div className="min-w-0"><div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><Route className="size-4 text-primary" />{t('tools.mtr.routeView')}</div><div className="mt-2 truncate font-mono text-sm font-semibold text-foreground">{state.target || t('tools.mtr.waitingTarget')}</div>{state.node && <div className="mt-1 truncate text-xs text-muted-foreground">{state.node}</div>}</div>
            <div className={cn('flex shrink-0 items-center gap-1.5 rounded-pill px-2.5 py-1 text-[10px]', busy ? 'bg-primary/10 text-primary' : reached ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-muted/40 text-muted-foreground')}>
              {busy ? <Loader2 className="size-3 animate-spin" /> : <span className="size-1 rounded-pill bg-current" />}{t(`tools.mtr.status.${status}`)}
            </div>
          </div>
          <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-white via-white/70 to-transparent p-5 pt-10 text-[10px] text-muted-foreground dark:from-[#2a2a2a] dark:via-[#2a2a2a]/70">{t('tools.mtr.globeHint')}</div>
        </section>
        <section className="dashboard-card flex flex-col justify-between gap-5 p-5">
          <h2 className="text-xs font-medium text-muted-foreground">{t('tools.mtr.overview')}</h2>
          <div className="grid grid-cols-3 gap-4 xl:grid-cols-1">
            <div><div className="text-[11px] text-muted-foreground">{t('tools.mtr.hops')}</div><div className="mt-1 text-2xl font-semibold tabular-nums">{state.hops.length}<span className="ml-1 text-xs font-normal text-muted-foreground">/ {state.maxHops || maxHops}</span></div></div>
            <div><div className="text-[11px] text-muted-foreground">{t('tools.mtr.responded')}</div><div className="mt-1 text-2xl font-semibold tabular-nums">{responded}</div></div>
            <div><div className="text-[11px] text-muted-foreground">{t('tools.mtr.lastRtt')}</div><div className="mt-1 whitespace-nowrap text-xl font-semibold tabular-nums">{milliseconds(last?.avg)}</div></div>
          </div>
          <p className="text-[11px] leading-5 text-muted-foreground">{t('tools.mtr.methodHint')}</p>
        </section>
      </div>

      <section className="dashboard-card overflow-hidden">
        <div className="flex items-center justify-between gap-4 px-5 py-4"><h2 className="text-sm font-medium">{t('tools.mtr.hopDetails')}</h2><span className="text-[10px] text-muted-foreground">{t('tools.mtr.lossHint')}</span></div>
        {!state.hops.length ? <div className="flex min-h-36 flex-col items-center justify-center gap-2 border-t border-border/20 p-6 text-center text-muted-foreground"><Route className="size-6 opacity-40" /><p className="text-sm">{t(busy ? 'tools.mtr.preparingHint' : 'tools.mtr.empty')}</p></div>
          : <div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead className="bg-muted/20 text-muted-foreground"><tr>{COLUMN_KEYS.map(key => <th key={key} className="whitespace-nowrap px-4 py-3 font-medium">{t(`tools.mtr.columns.${key}`)}</th>)}</tr></thead><tbody>
            {state.hops.map(hop => <tr key={hop.ttl} className={cn('border-t border-black/[0.055] transition-colors hover:bg-muted/15 dark:border-white/[0.07]', hop.reached && 'bg-primary/[0.035]')}>
              <td className="px-4 py-3 tabular-nums"><span className={cn('inline-flex size-6 items-center justify-center rounded-lg', hop.reached ? 'bg-primary/10 text-primary' : 'bg-muted/30')}>{hop.ttl}</span></td>
              <td className="whitespace-nowrap px-4 py-3 font-mono">{hop.ip || '*'}</td><td className="px-4 py-3 tabular-nums">{hop.sent}</td><td className="px-4 py-3 tabular-nums">{hop.received}</td>
              <td className={cn('px-4 py-3 tabular-nums', hop.loss >= 50 ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground')}>{Math.round(hop.loss)}%</td>
              {[hop.avg, hop.min, hop.max].map((value, index) => <td key={index} className="whitespace-nowrap px-4 py-3 tabular-nums">{milliseconds(value)}</td>)}
              <td className="min-w-40 px-4 py-3"><div>{hop.ip && !isPublicIpv4(hop.ip) ? t('dashboard.routeTrace.localNetwork') : [hop.geo?.country, hop.geo?.city].filter(Boolean).join(' · ') || '--'}</div>{hop.geo?.isp && <div className="mt-0.5 text-[10px] text-muted-foreground">{hop.geo.isp}</div>}</td>
            </tr>)}
          </tbody></table></div>}
      </section>
      <p className="px-1 text-[11px] leading-5 text-muted-foreground">{t('tools.mtr.disclaimer')}</p>
    </div>
  );
}
