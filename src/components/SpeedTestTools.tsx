'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowDown, ArrowLeft, ArrowUp, Check, Gauge, Loader2, Play, Square, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useMihomoRunningCache } from '@/services/app-data-hooks';
import type { SpeedTestPhase, SpeedTestProvider, SpeedTestStatus } from '@/types/electron';

const PROVIDERS: SpeedTestProvider[] = ['cloudflare', 'apple', 'speedtest'];
const DURATIONS = [5, 10, 15, 30];
const STREAMS = [1, 4, 6, 8, 16];
const PHASES: SpeedTestPhase[] = ['latency', 'download', 'upload', 'done'];
const SETTINGS_KEY = 'diodos.speedtest';
const HISTORY_KEY = 'diodos.speedtest.history';
const MAX_HISTORY = 20;

type Settings = { provider: SpeedTestProvider; duration: number; streams: number };
const DEFAULT_SETTINGS: Settings = { provider: 'cloudflare', duration: 10, streams: 6 };

type HistoryEntry = {
  at: number;
  provider: SpeedTestProvider;
  direct: boolean;
  download: number;
  upload: number;
  latency: number;
  jitter: number;
};

function loadSettings(): Settings {
  try {
    const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    return {
      provider: PROVIDERS.includes(stored.provider) ? stored.provider : DEFAULT_SETTINGS.provider,
      duration: DURATIONS.includes(stored.duration) ? stored.duration : DEFAULT_SETTINGS.duration,
      streams: STREAMS.includes(stored.streams) ? stored.streams : DEFAULT_SETTINGS.streams,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function loadHistory(): HistoryEntry[] {
  try {
    const stored = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    return Array.isArray(stored) ? stored.slice(0, MAX_HISTORY) : [];
  } catch {
    return [];
  }
}

function saveHistory(entries: HistoryEntry[]) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(entries)); } catch { /* 存不了就算了 */ }
}

function splitRate(bps: number): [string, string] {
  if (bps >= 1e9) return [(bps / 1e9).toFixed(2), 'Gbps'];
  if (bps >= 1e6) return [(bps / 1e6).toFixed(bps >= 1e8 ? 0 : 1), 'Mbps'];
  return [(bps / 1e3).toFixed(0), 'Kbps'];
}

const formatRate = (bps?: number) => (bps ? splitRate(bps).join(' ') : '--');
const formatMs = (ms?: number) => (ms ? `${ms.toFixed(ms >= 100 ? 0 : 1)} ms` : '--');

function formatBytes(bytes?: number): string {
  if (!bytes) return '--';
  if (bytes >= 1 << 30) return `${(bytes / (1 << 30)).toFixed(2)} GB`;
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

function linePath(values: number[], top: number, width: number, height: number) {
  if (!values.length) return null;
  const points = values.length === 1 ? [values[0], values[0]] : values;
  const step = width / (points.length - 1);
  const y = (value: number) => height - 2 - (value / top) * (height - 4);
  let line = `M0,${y(points[0]).toFixed(1)}`;
  for (let i = 1; i < points.length; i += 1) {
    const mid = (i - 0.5) * step;
    line += ` C${mid.toFixed(1)},${y(points[i - 1]).toFixed(1)} ${mid.toFixed(1)},${y(points[i]).toFixed(1)} ${(i * step).toFixed(1)},${y(points[i]).toFixed(1)}`;
  }
  return { line, area: `${line} L${width},${height} L0,${height} Z` };
}

/** 下载用主题色，上传用同色的淡线，和仪表盘的网速曲线一致 */
function SpeedChart({ download, upload }: { download: number[]; upload: number[] }) {
  const width = 600;
  const height = 120;
  const top = Math.max(...download, ...upload, 1) * 1.15;
  const down = useMemo(() => linePath(download, top, width, height), [download, top]);
  const up = useMemo(() => linePath(upload, top, width, height), [upload, top]);
  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="h-28 w-full overflow-visible text-primary">
      <defs>
        <linearGradient id="speedtest-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.28" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[1, 2, 3].map(i => <line key={i} x1="0" x2={width} y1={(height * i) / 4} y2={(height * i) / 4} className="stroke-muted-foreground/15" strokeWidth="1" vectorEffect="non-scaling-stroke" />)}
      {down && <>
        <path d={down.area} fill="url(#speedtest-fill)" />
        <path d={down.line} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      </>}
      {up && <path d={up.line} fill="none" stroke="currentColor" strokeOpacity="0.45" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />}
    </svg>
  );
}

function PhaseSteps({ status, running }: { status: SpeedTestStatus; running: boolean }) {
  const { t } = useTranslation();
  const current = status.phase ? PHASES.indexOf(status.phase) : -1;
  return (
    <ol className="flex items-center gap-2">
      {PHASES.map((phase, index) => {
        const finished = status.state === 'done' || index < current;
        const active = running && index === current;
        return (
          <li key={phase} className="flex min-w-0 flex-1 items-center gap-2">
            <span className={cn('flex size-5 shrink-0 items-center justify-center rounded-pill text-[10px] transition-colors', finished ? 'bg-primary text-primary-foreground' : active ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground')}>
              {finished ? <Check className="size-3" /> : active ? <Loader2 className="size-3 animate-spin" /> : index + 1}
            </span>
            <span className={cn('truncate text-xs', active || finished ? 'text-foreground' : 'text-muted-foreground')}>{t(`tools.speedTest.phase.${phase}`)}</span>
          </li>
        );
      })}
    </ol>
  );
}

function Metric({ label, value, icon }: { label: string; value: string; icon?: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1 text-[11px] text-muted-foreground">{icon}{label}</div>
      <div className="mt-1 truncate text-xl font-semibold tabular-nums text-foreground">{value}</div>
    </div>
  );
}

export default function SpeedTestTools() {
  const { t } = useTranslation();
  const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
  const coreRunning = useMihomoRunningCache();
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState<SpeedTestStatus>({ state: 'idle' });
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [localError, setLocalError] = useState<string | null>(null);
  const [currentNode, setCurrentNode] = useState<string | null>(null);
  const savedRun = useRef<number | undefined>(undefined);

  useEffect(() => { setSettings(loadSettings()); setHistory(loadHistory()); setLoaded(true); }, []);
  useEffect(() => {
    if (!loaded) return;
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* 存不了就算了 */ }
  }, [settings, loaded]);
  const update = (patch: Partial<Settings>) => setSettings(current => ({ ...current, ...patch }));

  const running = status.state === 'running';

  const refresh = useCallback(async () => {
    const result = await api?.speedTestStatus?.().catch(() => undefined);
    if (result?.success && result.status) setStatus(result.status);
  }, [api]);

  // 离开页面再回来也能接上正在跑的测速；空闲时不用这么频繁
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), running ? 250 : 2000);
    return () => clearInterval(timer);
  }, [refresh, running]);

  useEffect(() => {
    if (!coreRunning) { setCurrentNode(null); return; }
    let cancelled = false;
    void api?.fetchConnectionsInfo?.()
      .then(info => { if (!cancelled) setCurrentNode(info?.currentNode || null); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [api, coreRunning, running]);

  // 每次测速只记一条
  useEffect(() => {
    if (status.state !== 'done' || !status.startedAt) return;
    const startedAt = status.startedAt;
    if (savedRun.current === startedAt) return;
    savedRun.current = startedAt;
    setHistory(current => {
      if (current.some(entry => entry.at === startedAt)) return current;
      const next = [{
        at: startedAt,
        provider: status.provider || 'cloudflare',
        direct: status.direct === true,
        download: status.download || 0,
        upload: status.upload || 0,
        latency: status.latency || 0,
        jitter: status.jitter || 0,
      }, ...current].slice(0, MAX_HISTORY);
      saveHistory(next);
      return next;
    });
  }, [status]);

  const start = async () => {
    if (!api?.speedTestStart || running) return;
    setLocalError(null);
    const result = await api.speedTestStart({ ...settings, useProxy: coreRunning }).catch(error => ({ success: false, error: String(error) }));
    if (!result.success) setLocalError(result.error || 'failed');
    void refresh();
  };

  const stop = () => { void api?.speedTestCancel?.().then(refresh); };

  const clearHistory = () => { setHistory([]); saveHistory([]); };

  const direct = running || status.state === 'done' ? status.direct === true : !coreRunning;
  const routeText = direct ? t('tools.speedTest.routeDirect') : currentNode ? `${t('tools.speedTest.routeProxy')} › ${currentNode}` : t('tools.speedTest.routeProxy');
  const serverText = [status.server?.name, status.server?.location, status.server?.country].filter(Boolean).join(' · ');
  const showResult = status.state !== 'idle';

  const heroRate = running ? status.speed || 0 : status.state === 'done' ? status.download || 0 : 0;
  const [rateValue, rateUnit] = heroRate ? splitRate(heroRate) : ['--', 'Mbps'];
  const statusText = running ? t(`tools.speedTest.phase.${status.phase || 'connecting'}`)
    : status.state === 'done' ? t('tools.speedTest.phase.done')
      : status.state === 'cancelled' ? t('tools.speedTest.status.cancelled')
        : status.state === 'error' ? t('tools.speedTest.status.failed') : t('tools.speedTest.status.idle');
  const errorCode = localError || (status.state === 'error' ? status.error : null);
  const errorText = errorCode ? t(`tools.speedTest.errors.${errorCode}`, { defaultValue: t('tools.speedTest.errors.failed') }) : null;

  return (
    <div className="space-y-5 pb-2">
      <Link href="/tools" className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"><ArrowLeft className="size-3.5" />{t('tools.title')}</Link>
      <div className="flex items-center gap-3">
        <div className="flex size-11 shrink-0 items-center justify-center rounded-control bg-primary/10 text-primary"><Gauge className="size-5" /></div>
        <div><h1 className="text-2xl font-semibold text-foreground">{t('tools.speedTest.title')}</h1><p className="mt-1 text-sm text-muted-foreground">{t('tools.speedTest.subtitle')}</p></div>
      </div>

      <section className="dashboard-card p-5">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="flex flex-col gap-1.5 text-xs text-muted-foreground">{t('tools.speedTest.provider')}
            <div className="grid h-9 grid-cols-3 rounded-control border border-border bg-white/50 p-0.5 dark:bg-white/5">
              {PROVIDERS.map(provider => <button key={provider} type="button" disabled={running} onClick={() => update({ provider })} className={cn('truncate rounded-lg px-1 text-xs transition-colors disabled:opacity-50', settings.provider === provider ? 'bg-primary/10 font-medium text-primary' : 'text-muted-foreground hover:text-foreground')}>{t(`tools.speedTest.providers.${provider}`)}</button>)}
            </div>
          </div>
          <label className="flex flex-col gap-1.5 text-xs text-muted-foreground">{t('tools.speedTest.duration')}
            <select value={settings.duration} disabled={running} onChange={event => update({ duration: Number(event.target.value) })} className="h-9 rounded-control border border-border bg-white/50 px-3 text-foreground dark:bg-white/5">{DURATIONS.map(value => <option key={value} value={value}>{t('tools.speedTest.seconds', { count: value })}</option>)}</select>
          </label>
          <label className="flex flex-col gap-1.5 text-xs text-muted-foreground">{t('tools.speedTest.connections')}
            <select value={settings.streams} disabled={running} onChange={event => update({ streams: Number(event.target.value) })} className="h-9 rounded-control border border-border bg-white/50 px-3 text-foreground dark:bg-white/5">{STREAMS.map(value => <option key={value} value={value}>{value === 1 ? t('tools.speedTest.single') : t('tools.speedTest.multi', { count: value })}</option>)}</select>
          </label>
        </div>
        <div className="mt-4 flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 text-xs text-muted-foreground"><span>{t('tools.speedTest.route')}</span><span className="ml-2 truncate text-foreground">{routeText}</span></div>
          <Button type="button" variant={running ? 'destructive' : 'primary'} className="sm:min-w-32" onClick={running ? stop : () => void start()}>
            {running ? <Square className="mr-2 size-4" /> : <Play className="mr-2 size-4" />}
            {t(running ? 'tools.speedTest.stop' : status.state === 'done' ? 'tools.speedTest.again' : 'tools.speedTest.start')}
          </Button>
        </div>
      </section>

      {errorText && <div role="alert" className="rounded-nested border border-red-500/15 bg-red-500/5 px-4 py-3 text-sm text-red-600 dark:text-red-400">{errorText}</div>}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_19rem]">
        <section className="dashboard-card p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 truncate text-xs text-muted-foreground">{serverText || statusText}</div>
            <div className={cn('flex shrink-0 items-center gap-1.5 rounded-pill px-2.5 py-1 text-[10px]', running ? 'bg-primary/10 text-primary' : status.state === 'done' ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-muted text-muted-foreground')}>
              {running ? <Loader2 className="size-3 animate-spin" /> : <span className="size-1 rounded-pill bg-current" />}{running ? statusText : t(`tools.speedTest.badge.${status.state === 'done' ? 'done' : 'idle'}`)}
            </div>
          </div>
          <div className="mt-3 flex items-baseline gap-2"><span className="text-5xl font-semibold tabular-nums text-foreground">{rateValue}</span><span className="text-sm text-muted-foreground">{rateUnit}</span></div>
          <div className="mt-4"><SpeedChart download={status.downloadSeries || []} upload={status.uploadSeries || []} /></div>
          <div className="mt-4 border-t border-border pt-4"><PhaseSteps status={status} running={running} /></div>
        </section>
        <section className="dashboard-card flex flex-col justify-between gap-5 p-5">
          <div className="grid grid-cols-2 gap-4">
            <Metric label={t('tools.speedTest.download')} icon={<ArrowDown className="size-3" />} value={showResult ? formatRate(status.download) : '--'} />
            <Metric label={t('tools.speedTest.upload')} icon={<ArrowUp className="size-3" />} value={showResult ? formatRate(status.upload) : '--'} />
            <Metric label={t('tools.speedTest.latency')} value={showResult ? formatMs(status.latency) : '--'} />
            <Metric label={t('tools.speedTest.jitter')} value={showResult ? formatMs(status.jitter) : '--'} />
            <Metric label={t('tools.speedTest.dataUsed')} value={showResult ? formatBytes(status.bytes) : '--'} />
          </div>
          <p className="text-[11px] leading-5 text-muted-foreground">{t('tools.speedTest.note')}</p>
        </section>
      </div>

      <section className="dashboard-card overflow-hidden">
        <div className="flex items-center justify-between gap-4 px-5 py-4">
          <h2 className="text-sm font-medium">{t('tools.speedTest.history')}</h2>
          {history.length > 0 && <Button variant="ghost" size="sm" onClick={clearHistory}><Trash2 className="mr-1.5 size-4" />{t('tools.speedTest.clearHistory')}</Button>}
        </div>
        {!history.length ? <div className="flex min-h-20 items-center justify-center border-t border-border p-6 text-sm text-muted-foreground">{t('tools.speedTest.historyEmpty')}</div>
          : <div className="border-t border-border">{history.map(entry => (
            <div key={entry.at} className="grid grid-cols-[minmax(0,1.4fr)_repeat(3,minmax(0,1fr))] items-center gap-3 border-t border-black/[0.055] px-5 py-3 text-sm first:border-t-0 dark:border-white/[0.07]">
              <div className="min-w-0"><div className="truncate text-foreground">{t(`tools.speedTest.providers.${entry.provider}`)}</div><div className="truncate text-xs text-muted-foreground">{new Date(entry.at).toLocaleString()}</div></div>
              <div className="truncate tabular-nums"><ArrowDown className="mr-1 inline size-3 text-muted-foreground" />{formatRate(entry.download)}</div>
              <div className="truncate tabular-nums"><ArrowUp className="mr-1 inline size-3 text-muted-foreground" />{formatRate(entry.upload)}</div>
              <div className="truncate text-right tabular-nums text-muted-foreground">{formatMs(entry.latency)}</div>
            </div>
          ))}</div>}
      </section>
    </div>
  );
}
