import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { List, RefreshCw } from 'lucide-react';
import { RouteGlobe } from './RouteGlobe';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ROUTE_PREVIEW, isPublicIpv4, routePoints, startRouteTrace, stopRouteTrace, useRouteSnapshot, type RoutePoint } from '@/lib/route-trace';
import { cn } from '@/lib/utils';
import { CardHeading } from './CardHeading';

export function RouteTraceCard({ variant = 'standard', preview = false, editing = false }: { variant?: string; preview?: boolean; editing?: boolean }) {
  const { t } = useTranslation();
  const live = useRouteSnapshot();
  const data = preview ? ROUTE_PREVIEW : live;
  const [open, setOpen] = useState(false);
  const [showNote, setShowNote] = useState(false);
  const points = useMemo(() => routePoints(data.hops), [data.hops]);
  const destination: RoutePoint | undefined = useMemo(() => data.targetGeo?.latitude !== undefined && data.targetGeo?.longitude !== undefined
    ? { lat: data.targetGeo.latitude, lon: data.targetGeo.longitude, label: data.targetGeo.city || data.targetGeo.country || '' } : undefined, [data.targetGeo]);
  const small = variant === 'small'; const large = variant === 'standard';
  const full = variant === 'full';
  const lastHop = [...data.hops].reverse().find(hop => hop.ip);
  const ms = (value: number | null | undefined) => value === undefined || value === null ? '--' : `${Math.round(value)} ms`;
  const summary = data.preparing ? t('dashboard.routeTrace.preparing') : data.running
    ? t('dashboard.routeTrace.tracing', { count: data.hops.length })
    : data.hops.length ? t('dashboard.routeTrace.summary', { count: data.hops.length, ms: ms(lastHop?.avg) }) : t('dashboard.routeTrace.ready');
  const errorCode = data.error?.includes('physical_interface_unavailable') ? 'physical_interface_unavailable'
    : data.error === 'route_changed' ? 'route_changed'
    : data.error?.includes('permission') ? 'permission' : data.error === 'ipv6_only' ? 'ipv6_only'
    : data.error === 'core_unavailable' || data.error === 'no_entry' ? 'no_entry' : 'failed';

  useEffect(() => {
    if (preview || !data.finishedAt || !data.hops.length) return;
    setShowNote(true); const timer = setTimeout(() => setShowNote(false), 1400);
    return () => clearTimeout(timer);
  }, [data.finishedAt, preview]);

  return <>
    <div className={cn('dashboard-card relative isolate overflow-hidden', small ? 'dashboard-half-card' : large ? 'dashboard-large-card' : 'dashboard-standard-full-card')}>
      <RouteGlobe points={points} destination={destination} running={data.running} interactive={!preview && !editing} animate={!preview} />
      <div className={cn('pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start justify-between gap-2 bg-gradient-to-b to-transparent px-card pt-card',
        full ? 'h-11 from-white/50 via-white/10 dark:from-[#2a2a2a]/50 dark:via-[#2a2a2a]/10'
          : 'h-16 from-white via-white/80 dark:from-[#2a2a2a] dark:via-[#2a2a2a]/80')}>
        <CardHeading type="route-trace">{t('dashboard.routeTrace.title')}</CardHeading>
        <button type="button" disabled={preview || editing} onClick={() => data.running ? stopRouteTrace() : void startRouteTrace()}
          title={t(data.running ? 'dashboard.routeTrace.stop' : 'dashboard.routeTrace.start')} className="pointer-events-auto -mt-1 rounded-lg p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-default">
          <RefreshCw className={cn('size-card-icon', data.running && 'animate-spin')} />
        </button>
      </div>
      <div className={cn('pointer-events-none absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t to-transparent px-card',
        full ? 'pb-3 pt-2 from-white/60 via-white/15 dark:from-[#2a2a2a]/60 dark:via-[#2a2a2a]/15'
          : 'pb-4 pt-7 from-white via-white/85 dark:from-[#2a2a2a] dark:via-[#2a2a2a]/85')}>
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-xs font-medium text-foreground" role="status">{data.error ? t(`dashboard.routeTrace.errors.${errorCode}`) : showNote && !data.running ? t('dashboard.routeTrace.disclaimer') : summary}</span>
          <button type="button" onClick={() => setOpen(true)} disabled={preview || editing || !data.hops.length} title={t('dashboard.routeTrace.details')} className="pointer-events-auto shrink-0 rounded-lg p-1 text-muted-foreground hover:bg-muted disabled:opacity-30"><List className="size-3.5" /></button>
        </div>
        {!small && <div className="mt-0.5 truncate text-[10px] text-muted-foreground" title={data.target || undefined}>{points.length > 1 ? `${points[0].label} → ${points[points.length - 1].label}` : data.target || t('dashboard.routeTrace.targetHint')}</div>}
      </div>
    </div>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto rounded-dialog">
      <DialogHeader><DialogTitle>{t('dashboard.routeTrace.title')}</DialogTitle><DialogDescription>{data.node ? `${data.node} · ` : ''}{data.target} · {t('dashboard.routeTrace.disclaimer')}</DialogDescription></DialogHeader>
      <div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead><tr className="border-b border-black/[0.055] text-muted-foreground dark:border-white/[0.07]">{['hop','ip','location','loss','avg','min','max'].map(key => <th key={key} className="whitespace-nowrap px-2 py-3 font-medium">{t(`dashboard.routeTrace.columns.${key}`)}</th>)}</tr></thead>
        <tbody>{data.hops.map(hop => <tr key={hop.ttl} className="border-b border-black/[0.055] dark:border-white/[0.07]"><td className="px-2 py-3 tabular-nums">{hop.ttl}</td><td className="whitespace-nowrap px-2 py-3 font-mono">{hop.ip || '*'}</td><td className="px-2 py-3">{hop.ip && !isPublicIpv4(hop.ip) ? t('dashboard.routeTrace.localNetwork') : [hop.geo?.country, hop.geo?.city].filter(Boolean).join(' · ') || '--'}</td><td className="px-2 py-3 tabular-nums">{Math.round(hop.loss)}%</td><td className="whitespace-nowrap px-2 py-3 tabular-nums">{ms(hop.avg)}</td><td className="whitespace-nowrap px-2 py-3 tabular-nums">{ms(hop.min)}</td><td className="whitespace-nowrap px-2 py-3 tabular-nums">{ms(hop.max)}</td></tr>)}</tbody>
      </table></div>
    </DialogContent></Dialog>
  </>;
}
