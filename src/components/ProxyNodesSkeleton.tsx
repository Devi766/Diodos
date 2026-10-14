import React from 'react';

export function ProxyNodesSkeleton({ label, toolbar = true }: { label: string; toolbar?: boolean }) {
  return (
    <div role="status" aria-busy="true" className="space-y-4">
      <span className="sr-only">{label}</span>
      <div aria-hidden="true" className="space-y-4 motion-safe:animate-pulse">
        {toolbar && <div className="flex items-center justify-between gap-4 rounded-2xl bg-white/80 p-4 dark:bg-[#2a2a2a]">
          <div className="h-10 w-full max-w-sm rounded-full bg-slate-200/60 dark:bg-white/[0.07]" />
          <div className="hidden h-9 w-24 shrink-0 rounded-full bg-slate-200/60 dark:bg-white/[0.07] sm:block" />
        </div>}
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {Array.from({ length: 6 }, (_, index) => (
            <div key={index} className="flex min-h-[88px] items-center gap-3 rounded-2xl bg-white/80 p-4 dark:bg-[#2a2a2a]">
              <div className="size-9 shrink-0 rounded-xl bg-slate-200/60 dark:bg-white/[0.07]" />
              <div className="min-w-0 flex-1 space-y-2.5">
                <div className="h-3 w-3/5 rounded-full bg-slate-200/60 dark:bg-white/[0.07]" />
                <div className="h-2.5 w-2/5 rounded-full bg-slate-100 dark:bg-white/[0.04]" />
              </div>
              <div className="h-5 w-10 shrink-0 rounded-full bg-slate-100 dark:bg-white/[0.04]" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
