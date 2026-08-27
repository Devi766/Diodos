'use client';

import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

const Skeleton = ({ className }: { className?: string }) => (
  <div className={cn('route-fallback-block rounded-xl', className)} />
);

const Rows = ({ count = 6 }: { count?: number }) => (
  <div className="overflow-hidden rounded-2xl border border-slate-400/10 dark:border-white/[0.035]">
    {Array.from({ length: count }, (_, index) => (
      <div
        key={index}
        className="flex h-14 items-center gap-4 border-b border-slate-400/[0.07] px-4 last:border-b-0 dark:border-white/[0.025]"
      >
        <Skeleton className="h-7 w-7 shrink-0 rounded-lg" />
        <Skeleton className={cn('h-3', index % 3 === 0 ? 'w-1/3' : index % 3 === 1 ? 'w-2/5' : 'w-1/4')} />
        <Skeleton className="ml-auto h-3 w-20" />
      </div>
    ))}
  </div>
);

const DashboardFallback = () => (
  <div className="grid gap-4 lg:grid-cols-12" aria-hidden="true">
    <Skeleton className="h-40 lg:col-span-5" />
    <Skeleton className="h-40 lg:col-span-4" />
    <Skeleton className="h-40 lg:col-span-3" />
    <Skeleton className="h-52 lg:col-span-8" />
    <Skeleton className="h-52 lg:col-span-4" />
  </div>
);

const NodesFallback = () => (
  <div className="space-y-4" aria-hidden="true">
    <div className="flex items-center gap-3">
      <Skeleton className="h-10 w-44" />
      <Skeleton className="ml-auto h-9 w-24" />
      <Skeleton className="h-9 w-9" />
    </div>
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: 6 }, (_, index) => (
        <div key={index} className="rounded-2xl border border-slate-400/10 p-4 dark:border-white/[0.035]">
          <div className="flex items-center gap-3">
            <Skeleton className="h-9 w-9 rounded-full" />
            <div className="flex-1 space-y-2"><Skeleton className="h-3 w-2/3" /><Skeleton className="h-2.5 w-1/3" /></div>
            <Skeleton className="h-6 w-12 rounded-full" />
          </div>
        </div>
      ))}
    </div>
  </div>
);

const SubscriptionsFallback = () => (
  <div className="space-y-4" aria-hidden="true">
    <div className="flex items-center justify-between"><Skeleton className="h-9 w-52" /><Skeleton className="h-10 w-28" /></div>
    {Array.from({ length: 3 }, (_, index) => (
      <div key={index} className="rounded-2xl border border-slate-400/10 p-5 dark:border-white/[0.035]">
        <div className="flex items-start gap-4"><Skeleton className="h-11 w-11 rounded-xl" /><div className="flex-1 space-y-3"><Skeleton className="h-3.5 w-40" /><Skeleton className="h-2.5 w-3/5" /><Skeleton className="h-1.5 w-full rounded-full" /></div><Skeleton className="h-8 w-20" /></div>
      </div>
    ))}
  </div>
);

const TableFallback = ({ compact = false }: { compact?: boolean }) => (
  <div className="space-y-3" aria-hidden="true">
    <div className="flex gap-3"><Skeleton className="h-10 flex-1" /><Skeleton className="h-10 w-28" /><Skeleton className="h-10 w-10" /></div>
    <Skeleton className="h-10 w-full rounded-lg" />
    <Rows count={compact ? 5 : 8} />
  </div>
);

const SettingsFallback = () => (
  <div className="space-y-5" aria-hidden="true">
    <div className="flex gap-2">{Array.from({ length: 5 }, (_, index) => <Skeleton key={index} className="h-9 w-20 rounded-full" />)}</div>
    <div className="rounded-2xl border border-slate-400/10 p-5 dark:border-white/[0.035]">
      {Array.from({ length: 5 }, (_, index) => (
        <div key={index} className="flex min-h-16 items-center gap-4 border-b border-slate-400/[0.07] last:border-b-0 dark:border-white/[0.025]">
          <div className="flex-1 space-y-2"><Skeleton className="h-3 w-36" /><Skeleton className="h-2.5 w-64 max-w-[55%]" /></div>
          <Skeleton className={index % 2 === 0 ? 'h-6 w-12 rounded-full' : 'h-9 w-28'} />
        </div>
      ))}
    </div>
  </div>
);

export const ExternalResourcesSkeleton = () => (
  <div className="space-y-5" aria-hidden="true" aria-label="Loading external resources">
    <div className="flex items-center gap-2">
      <Skeleton className="h-9 w-24 rounded-full" />
      <Skeleton className="h-9 w-24 rounded-full" />
    </div>
    <div className="rounded-2xl border border-slate-400/10 p-5 dark:border-white/[0.035]">
      <div className="mb-5 flex items-center justify-between gap-4">
        <div className="space-y-2"><Skeleton className="h-4 w-36" /><Skeleton className="h-2.5 w-64" /></div>
        <Skeleton className="h-10 w-32" />
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="space-y-2">
            <Skeleton className={cn('h-2.5', index % 2 === 0 ? 'w-20' : 'w-28')} />
            <Skeleton className="h-10 w-full" />
          </div>
        ))}
      </div>
    </div>
    <div className="rounded-2xl border border-slate-400/10 p-5 dark:border-white/[0.035]">
      {Array.from({ length: 3 }, (_, index) => (
        <div key={index} className="flex min-h-16 items-center gap-4 border-b border-slate-400/[0.07] last:border-b-0 dark:border-white/[0.025]">
          <div className="flex-1 space-y-2"><Skeleton className="h-3 w-32" /><Skeleton className="h-2.5 w-56 max-w-[55%]" /></div>
          <Skeleton className={index === 2 ? 'h-9 w-24' : 'h-6 w-12 rounded-full'} />
        </div>
      ))}
    </div>
  </div>
);

const LogsFallback = () => (
  <div className="space-y-3" aria-hidden="true">
    <div className="flex gap-3"><Skeleton className="h-10 flex-1" /><Skeleton className="h-10 w-24" /></div>
    <div className="space-y-3 rounded-2xl border border-slate-400/10 p-4 dark:border-white/[0.035]">
      {Array.from({ length: 9 }, (_, index) => <Skeleton key={index} className={cn('h-2.5', index % 4 === 0 ? 'w-4/5' : index % 4 === 1 ? 'w-3/5' : index % 4 === 2 ? 'w-11/12' : 'w-2/3')} />)}
    </div>
  </div>
);

const AiFallback = () => (
  <div className="grid h-full min-h-[420px] gap-3 md:grid-cols-[220px_1fr]" aria-hidden="true">
    <div className="space-y-3 rounded-2xl border border-slate-400/10 p-3 dark:border-white/[0.035]"><Skeleton className="h-9 w-full" />{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
    <div className="flex flex-col rounded-2xl border border-slate-400/10 p-4 dark:border-white/[0.035]"><Skeleton className="h-10 w-2/5" /><div className="flex-1" /><Skeleton className="h-20 w-full" /></div>
  </div>
);

export default function RouteContentFallback() {
  const pathname = usePathname() || '/';

  if (pathname === '/') return <DashboardFallback />;
  if (pathname.startsWith('/nodes')) return <NodesFallback />;
  if (pathname.startsWith('/subscriptions')) return <SubscriptionsFallback />;
  if (pathname.startsWith('/connections')) return <TableFallback />;
  if (pathname.startsWith('/match-rules') || pathname.startsWith('/providers')) return <TableFallback compact />;
  if (pathname.startsWith('/external-resources')) return <ExternalResourcesSkeleton />;
  if (pathname.startsWith('/settings') || pathname.startsWith('/overrides')) return <SettingsFallback />;
  if (pathname.startsWith('/logs')) return <LogsFallback />;
  if (pathname.startsWith('/ai-assistant')) return <AiFallback />;

  return <TableFallback compact />;
}
