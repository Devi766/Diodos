import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react';
import { BrandIcon } from './BrandIcon';
import MediaStreamingTestDialog from '@/components/MediaStreamingTestDialog';
import { MEDIA_SERVICES, MEDIA_PREVIEW, runMediaCheck, useMediaSnapshot, type MediaId, type MediaStatus } from '@/lib/media-checker';
import { cn } from '@/lib/utils';
import { CardHeading } from './CardHeading';

const colorOf = (status: MediaStatus) => status === 'supported' || status === 'reachable' ? 'text-emerald-600 dark:text-emerald-400'
  : status === 'partial' ? 'text-amber-600 dark:text-amber-400' : status === 'restricted' || status === 'failed' ? 'text-red-500' : 'text-muted-foreground';
function ServiceIcon({ id }: { id: MediaId }) {
  if (id !== 'disney') return <BrandIcon id={id} className="size-6 shrink-0 text-foreground" />;
  // 保持品牌字标原始比例，单色适配明暗主题
  return <span aria-hidden className="flex h-6 w-11 shrink-0 items-center justify-center">
    {/* eslint-disable-next-line @next/next/no-img-element */}
    <img src="/brands/disney-plus.webp" alt="" draggable={false} className="max-h-full w-full object-contain brightness-0 dark:invert" />
  </span>;
}

export function MediaTestCard({ variant = 'standard', preview = false }: { variant?: string; preview?: boolean }) {
  const { t } = useTranslation();
  const live = useMediaSnapshot();
  const data = preview ? MEDIA_PREVIEW : live;
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState(false);
  const small = variant === 'small';
  const selected = MEDIA_SERVICES[page];
  const check = (event: React.MouseEvent, service?: MediaId) => {
    event.stopPropagation();
    if (!preview && !data.running) void runMediaCheck(service);
  };
  const status = (id: MediaId) => data.results.find(r => r.id === id)!;

  return <>
    <div className={cn('dashboard-card flex flex-col p-card', small ? 'dashboard-half-card' : 'dashboard-standard-full-card', !preview && 'cursor-pointer')}
      onClick={event => { if (!preview && !(event.target as HTMLElement).closest('button')) setOpen(true); }}>
      <div className="flex h-6 shrink-0 items-center justify-between gap-2">
        <CardHeading type="media-test">{t('dashboard.mediaTest.title')}</CardHeading>
        <button type="button" onClick={event => check(event, small ? selected.id : undefined)} disabled={preview || data.running} title={t(small ? 'dashboard.mediaTest.check' : 'dashboard.mediaTest.checkAll')} className="rounded-lg p-1 text-muted-foreground hover:bg-muted disabled:cursor-default">
          <RefreshCw className={cn('size-card-icon', data.running && 'animate-spin')} />
        </button>
      </div>
      {small ? <div className="flex min-h-0 flex-1 flex-col justify-center gap-1.5">
        <button type="button" disabled={preview || data.running} onClick={event => check(event, selected.id)} title={t('dashboard.mediaTest.testService', { service: selected.name })} className="flex min-w-0 items-center gap-3 text-left disabled:cursor-default">
          <ServiceIcon id={selected.id} />
          <div className="min-w-0"><div className="truncate text-sm font-semibold text-foreground">{selected.name}</div><div className={cn('truncate text-[11px]', colorOf(status(selected.id).status))}>{t(`dashboard.mediaTest.status.${status(selected.id).status}`)}</div></div>
        </button>
        <div className="flex items-center justify-between">
          <button type="button" onClick={() => setPage((page + 2) % 3)} disabled={preview} title={t('dashboard.mediaTest.previous')} className="rounded-pill p-0.5 hover:bg-muted"><ChevronLeft className="size-3 text-muted-foreground" /></button>
          <div className="flex gap-1.5">{MEDIA_SERVICES.map((service, index) => <button type="button" key={service.id} aria-label={service.name} aria-pressed={page === index} disabled={preview} onClick={() => setPage(index)} className={cn('size-1 rounded-pill bg-foreground', page === index ? 'opacity-80' : 'opacity-20')} />)}</div>
          <button type="button" onClick={() => setPage((page + 1) % 3)} disabled={preview} title={t('dashboard.mediaTest.next')} className="rounded-pill p-0.5 hover:bg-muted"><ChevronRight className="size-3 text-muted-foreground" /></button>
        </div>
      </div> : <div className="grid min-h-0 flex-1 grid-cols-3 divide-x divide-black/[0.06] dark:divide-white/[0.07]">
        {MEDIA_SERVICES.map(service => <button type="button" key={service.id} disabled={preview || data.running} onClick={event => check(event, service.id)} title={t('dashboard.mediaTest.testService', { service: service.name })}
          className="flex min-w-0 flex-col items-center justify-center gap-1 rounded-control px-2 text-center transition-colors hover:bg-primary/5 disabled:cursor-default">
          <ServiceIcon id={service.id} />
          <div className="min-w-0"><div className="truncate text-xs font-medium text-foreground">{service.name}</div>
            <div className={cn('truncate text-[10px] leading-4', colorOf(status(service.id).status))}>{t(`dashboard.mediaTest.status.${status(service.id).status}`)}{status(service.id).region ? ` · ${status(service.id).region}` : ''}</div>
          </div>
        </button>)}
      </div>}
    </div>
    <MediaStreamingTestDialog open={open && !preview} onOpenChange={setOpen} />
  </>;
}
