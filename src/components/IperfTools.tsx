'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowDown, ArrowLeft, ArrowUp, Gauge, Laptop, Loader2, Play, RefreshCw, Smartphone, Square } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import type { IperfClientStatus, IperfDevice, IperfPeerStatus, IperfServerInfo } from '@/types/electron';

const DEFAULT_PORT = 5201;
const DURATIONS = [5, 10, 20, 30, 60];
const PARALLELS = [1, 2, 4, 8, 16];
const STORAGE_KEY = 'diodos.iperf';

type Settings = { target: string; reverse: boolean; duration: number; parallel: number; server: boolean };
const DEFAULT_SETTINGS: Settings = { target: '', reverse: false, duration: 10, parallel: 1, server: true };

function loadSettings(): Settings {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return {
      target: typeof stored.target === 'string' ? stored.target : '',
      reverse: stored.reverse === true,
      duration: DURATIONS.includes(stored.duration) ? stored.duration : DEFAULT_SETTINGS.duration,
      parallel: PARALLELS.includes(stored.parallel) ? stored.parallel : DEFAULT_SETTINGS.parallel,
      server: stored.server !== false,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/** host、host:port、[v6]:port 或裸 IPv6 */
export function parseIperfTarget(raw: string): { host: string; port: number } | null {
  const text = raw.trim().replace(/^iperf3:\/\//, '').replace(/\/+$/, '');
  if (!text || /\s/.test(text)) return null;
  let host = text;
  let port = DEFAULT_PORT;
  if (text.startsWith('[')) {
    const end = text.indexOf(']');
    if (end < 2) return null;
    host = text.slice(1, end);
    const rest = text.slice(end + 1);
    if (rest) {
      if (!rest.startsWith(':')) return null;
      port = Number(rest.slice(1));
    }
  } else if ((text.match(/:/g) || []).length === 1) {
    [host] = text.split(':');
    port = Number(text.split(':')[1]);
  }
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port };
}

const hostPort = (host: string, port: number) => (host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`);

function splitRate(bps: number): [string, string] {
  if (bps >= 1e9) return [(bps / 1e9).toFixed(2), 'Gbps'];
  if (bps >= 1e6) return [(bps / 1e6).toFixed(bps >= 1e8 ? 0 : 1), 'Mbps'];
  return [(bps / 1e3).toFixed(0), 'Kbps'];
}

const formatRate = (bps: number) => splitRate(bps).join(' ');

function formatBytes(bytes: number): string {
  if (bytes >= 1 << 30) return `${(bytes / (1 << 30)).toFixed(2)} GB`;
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

function deviceName(device: IperfDevice) {
  return device.hostName?.trim() || device.name.replace(/^Diodos · /, '').trim() || device.address;
}

function isMobile(device: IperfDevice) {
  if (device.deviceType === 'phone' || device.deviceType === 'tablet') return true;
  if (device.deviceType === 'desktop') return false;
  return device.platform === 'android' || device.platform === 'ios';
}

function platformLabel(device: IperfDevice, t: (key: string) => string) {
  switch ((device.platform || '').toLowerCase()) {
    case 'windows': return 'Windows';
    case 'macos': return 'macOS';
    case 'linux': return 'Linux';
    case 'android': return device.deviceType === 'tablet' ? 'Android Tablet' : 'Android';
    case 'ios': return device.deviceType === 'tablet' ? 'iPadOS' : 'iOS';
    default: return t(`tools.iperf.deviceType.${isMobile(device) ? 'mobile' : 'desktop'}`);
  }
}

function SpeedChart({ values }: { values: number[] }) {
  const width = 600;
  const height = 120;
  const path = useMemo(() => {
    if (!values.length) return null;
    const top = Math.max(...values, 1) * 1.15;
    const points = values.length === 1 ? [values[0], values[0]] : values;
    const step = width / (points.length - 1);
    const y = (value: number) => height - 2 - (value / top) * (height - 4);
    let line = `M0,${y(points[0]).toFixed(1)}`;
    for (let i = 1; i < points.length; i += 1) {
      const mid = (i - 0.5) * step;
      line += ` C${mid.toFixed(1)},${y(points[i - 1]).toFixed(1)} ${mid.toFixed(1)},${y(points[i]).toFixed(1)} ${(i * step).toFixed(1)},${y(points[i]).toFixed(1)}`;
    }
    return { line, area: `${line} L${width},${height} L0,${height} Z` };
  }, [values]);
  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="h-28 w-full overflow-visible text-primary">
      <defs>
        <linearGradient id="iperf-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.28" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[1, 2, 3].map(i => <line key={i} x1="0" x2={width} y1={(height * i) / 4} y2={(height * i) / 4} className="stroke-muted-foreground/15" strokeWidth="1" vectorEffect="non-scaling-stroke" />)}
      {path && <>
        <path d={path.area} fill="url(#iperf-fill)" />
        <path d={path.line} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      </>}
    </svg>
  );
}

export default function IperfTools() {
  const { t } = useTranslation();
  const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [client, setClient] = useState<IperfClientStatus>({ state: 'idle' });
  const [peer, setPeer] = useState<IperfPeerStatus>({ state: 'idle' });
  const [server, setServer] = useState<IperfServerInfo>({ running: false });
  const [serverError, setServerError] = useState(false);
  const [devices, setDevices] = useState<IperfDevice[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const discoverGeneration = useRef(0);

  useEffect(() => { setSettings(loadSettings()); setLoaded(true); }, []);
  useEffect(() => {
    if (!loaded) return;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch { /* 存不了就算了 */ }
  }, [settings, loaded]);
  const update = (patch: Partial<Settings>) => setSettings(current => ({ ...current, ...patch }));

  const refresh = useCallback(async () => {
    const status = await api?.iperfStatus?.().catch(() => undefined);
    if (!status?.success) return;
    if (status.client) setClient(status.client);
    if (status.peer) setPeer(status.peer);
    if (status.server) setServer(status.server);
  }, [api]);

  const discover = useCallback(async () => {
    if (!api?.iperfDiscover) return;
    const id = ++discoverGeneration.current;
    setDiscovering(true);
    const result = await api.iperfDiscover().catch(() => undefined);
    if (id !== discoverGeneration.current) return;
    setDevices(result?.success ? result.devices || [] : []);
    setDiscovering(false);
  }, [api]);

  // 页面打开期间作为服务端供其他设备连接
  useEffect(() => {
    if (!loaded || !api?.iperfServerStart) return;
    if (!settings.server) {
      void api.iperfServerStop?.().then(refresh);
      return;
    }
    let cancelled = false;
    api.iperfServerStart({ port: DEFAULT_PORT })
      .then(result => { if (!cancelled) { setServerError(!result?.success); void refresh(); } })
      .catch(() => { if (!cancelled) setServerError(true); });
    return () => { cancelled = true; };
  }, [api, loaded, settings.server, refresh]);

  useEffect(() => () => { void api?.iperfServerStop?.(); }, [api]);

  useEffect(() => {
    void discover();
    void refresh();
    const timer = setInterval(() => void refresh(), 500);
    return () => { clearInterval(timer); discoverGeneration.current += 1; };
  }, [discover, refresh]);

  const clientBusy = client.state === 'connecting' || client.state === 'running';

  const start = async (host: string, port: number, label?: string) => {
    if (!api?.iperfStart || clientBusy) return;
    setLocalError(null);
    const result = await api.iperfStart({ host, port, label, duration: settings.duration, parallel: settings.parallel, reverse: settings.reverse }).catch(error => ({ success: false, error: String(error) }));
    if (!result.success) setLocalError(result.error || 'failed');
    void refresh();
  };

  const startFromInput = () => {
    const parsed = parseIperfTarget(settings.target);
    if (!parsed) { setLocalError('invalid_target'); return; }
    const known = devices.find(device => device.address === parsed.host && device.port === parsed.port);
    void start(parsed.host, parsed.port, known ? deviceName(known) : undefined);
  };

  const startDevice = (device: IperfDevice) => {
    if (clientBusy) return;
    update({ target: device.port === DEFAULT_PORT ? device.address : hostPort(device.address, device.port) });
    void start(device.address, device.port, deviceName(device));
  };

  const stop = () => { void api?.iperfCancel?.().then(refresh); };

  // 本机作为客户端时优先展示自己的测试，否则展示对端测本机的过程
  const showPeer = !clientBusy && peer.state !== 'idle' && (peer.updatedAt || 0) > (client.updatedAt || 0);
  const view = showPeer ? peer : client;
  const intervals = view.intervals || [];
  const result = view.result;
  const liveRate = view.state === 'done' && result ? result.receiverBitsPerSecond : intervals.length ? intervals[intervals.length - 1].bitsPerSecond : 0;
  const [rateValue, rateUnit] = view.state === 'idle' || (!intervals.length && view.state !== 'done') ? ['--', 'Mbps'] : splitRate(liveRate);
  const running = showPeer ? peer.state === 'running' : clientBusy;
  const elapsed = Math.min(Math.floor(intervals.length ? intervals[intervals.length - 1].end : 0), view.duration || 0);

  const errorKey = (message?: string | null) => {
    if (!message) return null;
    if (message === 'invalid_target') return 'invalid_target';
    if (message.includes('busy')) return 'busy';
    if (message.includes('refused')) return 'refused';
    if (message.includes('timed out') || message.includes('stopped responding')) return 'timeout';
    if (message.includes('not supported')) return 'unsupported';
    if (message.includes('resolve')) return 'dns';
    return 'failed';
  };

  let statusText: string;
  if (showPeer) {
    const direction = t(`tools.iperf.${peer.peerSends ? 'download' : 'upload'}`);
    statusText = peer.state === 'running' ? t('tools.iperf.status.peerRunning', { peer: peer.peer, direction })
      : peer.state === 'done' ? t('tools.iperf.status.peerDone', { peer: peer.peer, direction })
        : t('tools.iperf.status.peerFailed', { peer: peer.peer, error: peer.error });
  } else {
    const direction = t(`tools.iperf.${client.reverse ? 'download' : 'upload'}`);
    const label = client.label || client.host || '';
    statusText = client.state === 'connecting' ? t('tools.iperf.status.connecting', { target: label })
      : client.state === 'running' ? t('tools.iperf.status.running', { target: label, direction, elapsed, total: client.duration })
        : client.state === 'done' ? t('tools.iperf.status.done', { target: label, direction })
          : client.state === 'cancelled' ? t('tools.iperf.status.cancelled')
            : client.state === 'error' ? t('tools.iperf.status.failed') : t('tools.iperf.status.idle');
  }
  const shownError = localError || (!showPeer && client.state === 'error' ? client.error : null);
  const shownErrorKey = errorKey(shownError);

  return (
    <div className="space-y-5 pb-2">
      <Link href="/tools" className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"><ArrowLeft className="size-3.5" />{t('tools.title')}</Link>
      <div className="flex items-center gap-3">
        <div className="flex size-11 shrink-0 items-center justify-center rounded-control bg-primary/10 text-primary"><Gauge className="size-5" /></div>
        <div><h1 className="text-2xl font-semibold text-foreground">{t('tools.iperf.title')}</h1><p className="mt-1 text-sm text-muted-foreground">{t('tools.iperf.subtitle')}</p></div>
      </div>

      <section className="dashboard-card p-5">
        <form onSubmit={event => { event.preventDefault(); if (clientBusy) stop(); else startFromInput(); }}>
          <label htmlFor="iperf-target" className="mb-2 block text-xs font-medium text-muted-foreground">{t('tools.iperf.target')}</label>
          <div className="flex flex-col gap-3 sm:flex-row">
            <Input id="iperf-target" value={settings.target} onChange={event => { update({ target: event.target.value }); if (localError === 'invalid_target') setLocalError(null); }} placeholder={t('tools.iperf.placeholder')} disabled={clientBusy} spellCheck={false} autoComplete="off" className="min-w-0 flex-1 border bg-muted/20 font-mono" aria-invalid={localError === 'invalid_target'} />
            <Button type="submit" variant={clientBusy ? 'destructive' : 'primary'} className="sm:min-w-32">{clientBusy ? <Square className="mr-2 size-4" /> : <Play className="mr-2 size-4" />}{t(clientBusy ? 'tools.iperf.stop' : 'tools.iperf.start')}</Button>
          </div>
        </form>
        <div className="mt-4 grid gap-3 border-t border-border/30 pt-4 sm:grid-cols-3">
          <div className="flex flex-col gap-1.5 text-xs text-muted-foreground">{t('tools.iperf.direction')}
            <div className="grid h-9 grid-cols-2 rounded-control border border-border/40 bg-white/50 p-0.5 dark:bg-white/5">
              {[false, true].map(reverse => <button key={String(reverse)} type="button" disabled={clientBusy} onClick={() => update({ reverse })} className={cn('inline-flex items-center justify-center gap-1.5 rounded-lg text-xs transition-colors disabled:opacity-50', settings.reverse === reverse ? 'bg-primary/10 font-medium text-primary' : 'text-muted-foreground hover:text-foreground')}>
                {reverse ? <ArrowDown className="size-3.5" /> : <ArrowUp className="size-3.5" />}{t(`tools.iperf.${reverse ? 'download' : 'upload'}`)}
              </button>)}
            </div>
          </div>
          {([
            { key: 'duration', value: settings.duration, values: DURATIONS, suffix: (v: number) => t('tools.iperf.seconds', { count: v }) },
            { key: 'parallel', value: settings.parallel, values: PARALLELS, suffix: (v: number) => String(v) },
          ] as const).map(item => <label key={item.key} className="flex flex-col gap-1.5 text-xs text-muted-foreground">{t(`tools.iperf.${item.key}`)}
            <select value={item.value} disabled={clientBusy} onChange={event => update({ [item.key]: Number(event.target.value) } as Partial<Settings>)} className="h-9 rounded-control border border-border/40 bg-white/50 px-3 text-foreground dark:bg-white/5">{item.values.map(value => <option key={value} value={value}>{item.suffix(value)}</option>)}</select>
          </label>)}
        </div>
      </section>

      {shownErrorKey && <div role="alert" className="rounded-nested border border-red-500/15 bg-red-500/5 px-4 py-3 text-sm text-red-600 dark:text-red-400">{t(`tools.iperf.errors.${shownErrorKey}`)}{shownErrorKey === 'failed' && shownError ? ` (${shownError})` : ''}</div>}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_19rem]">
        <section className="dashboard-card p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 truncate text-xs text-muted-foreground">{statusText}</div>
            <div className={cn('flex shrink-0 items-center gap-1.5 rounded-pill px-2.5 py-1 text-[10px]', running ? 'bg-primary/10 text-primary' : view.state === 'done' ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-muted/40 text-muted-foreground')}>
              {running ? <Loader2 className="size-3 animate-spin" /> : <span className="size-1 rounded-pill bg-current" />}{t(`tools.iperf.badge.${running ? 'running' : view.state === 'done' ? 'done' : 'idle'}`)}
            </div>
          </div>
          <div className="mt-3 flex items-baseline gap-2"><span className="text-5xl font-semibold tabular-nums text-foreground">{rateValue}</span><span className="text-sm text-muted-foreground">{rateUnit}</span></div>
          <div className="mt-4"><SpeedChart values={intervals.map(item => item.bitsPerSecond)} /></div>
        </section>
        <section className="dashboard-card flex flex-col justify-between gap-5 p-5">
          <h2 className="text-xs font-medium text-muted-foreground">{t('tools.iperf.overview')}</h2>
          <div className="grid grid-cols-3 gap-4 xl:grid-cols-1">
            <div><div className="text-[11px] text-muted-foreground">{t('tools.iperf.sender')}</div><div className="mt-1 whitespace-nowrap text-xl font-semibold tabular-nums">{result ? formatRate(result.senderBitsPerSecond) : '--'}</div></div>
            <div><div className="text-[11px] text-muted-foreground">{t('tools.iperf.receiver')}</div><div className="mt-1 whitespace-nowrap text-xl font-semibold tabular-nums">{result ? formatRate(result.receiverBitsPerSecond) : '--'}</div></div>
            <div><div className="text-[11px] text-muted-foreground">{t('tools.iperf.transferred')}</div><div className="mt-1 whitespace-nowrap text-xl font-semibold tabular-nums">{result ? formatBytes(result.receivedBytes) : '--'}</div></div>
          </div>
          <p className="text-[11px] leading-5 text-muted-foreground">{t('tools.iperf.methodHint')}</p>
        </section>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_19rem]">
        <section className="dashboard-card overflow-hidden">
          <div className="flex items-center justify-between gap-4 px-5 py-4">
            <h2 className="text-sm font-medium">{t('tools.iperf.devices')}</h2>
            <Button variant="ghost" size="sm" disabled={discovering} onClick={() => void discover()}>{discovering ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : <RefreshCw className="mr-1.5 size-4" />}{t('tools.iperf.refresh')}</Button>
          </div>
          {!devices.length ? <div className="flex min-h-28 flex-col items-center justify-center gap-2 border-t border-border/20 p-6 text-center text-muted-foreground"><Laptop className="size-6 opacity-40" /><p className="text-sm">{t(discovering ? 'tools.iperf.searching' : 'tools.iperf.noDevices')}</p></div>
            : <div className="border-t border-border/20">{devices.map(device => {
              const Icon = isMobile(device) ? Smartphone : Laptop;
              return <button key={device.id} type="button" disabled={clientBusy} onClick={() => startDevice(device)} className="flex w-full items-center gap-3 border-t border-black/[0.055] px-5 py-3 text-left transition-colors first:border-t-0 hover:bg-muted/15 disabled:opacity-50 dark:border-white/[0.07]">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-control bg-primary/10 text-primary"><Icon className="size-4" /></span>
                <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium text-foreground">{deviceName(device)}</span><span className="block truncate text-xs text-muted-foreground">{platformLabel(device, t)} · {hostPort(device.address, device.port)}</span></span>
                {device.busy ? <span className="rounded-pill bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-600 dark:text-amber-400">{t('tools.iperf.deviceBusy')}</span>
                  : <span className="inline-flex items-center gap-1 rounded-pill bg-primary/5 px-2.5 py-1 text-[11px] text-primary"><Play className="size-3" />{t('tools.iperf.testNow')}</span>}
              </button>;
            })}</div>}
        </section>
        <section className="dashboard-card flex flex-col gap-4 p-5">
          <div className="flex items-center justify-between gap-3">
            <div><h2 className="text-sm font-medium">{t('tools.iperf.server')}</h2><p className="mt-1 text-xs text-muted-foreground">{serverError ? t('tools.iperf.serverFailed') : server.running ? t('tools.iperf.serverOn', { address: (server.addresses?.length ? server.addresses : ['0.0.0.0']).map(address => hostPort(address, server.port || DEFAULT_PORT)).join(', ') }) : t('tools.iperf.serverOff')}</p></div>
            <Switch checked={settings.server} onCheckedChange={checked => update({ server: checked })} aria-label={t('tools.iperf.server')} />
          </div>
          <p className="text-[11px] leading-5 text-muted-foreground">{t('tools.iperf.serverHint', { port: server.port || DEFAULT_PORT })}</p>
        </section>
      </div>
    </div>
  );
}
