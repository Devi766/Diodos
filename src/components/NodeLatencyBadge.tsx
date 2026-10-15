import React from 'react';

export function NodeLatencyBadge({ delay, testing, loadingLabel, timeoutLabel }: {
  delay?: number;
  testing: boolean;
  loadingLabel: string;
  timeoutLabel: string;
}) {
  if (testing) {
    return <span role="status" aria-label={loadingLabel} title={loadingLabel} data-latency-state="loading"
      className="inline-flex h-5 min-w-10 shrink-0 items-center justify-center px-1.5 py-0.5 text-xs leading-none text-slate-400 dark:text-slate-500">
      <span aria-hidden="true" className="size-3 rounded-full border-[1.5px] border-current border-r-transparent motion-safe:animate-spin" />
    </span>;
  }
  if (delay === undefined) return null;
  return <span data-latency-state={delay === 0 ? 'timeout' : 'ready'} className={`inline-flex h-5 shrink-0 items-center justify-center whitespace-nowrap text-xs leading-none px-1.5 py-0.5 rounded-full ${
    delay === 0 ? 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400'
      : delay < 100 ? 'bg-green-100 text-green-800 dark:bg-[#2a2a2a] dark:text-green-400'
      : delay < 300 ? 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400'
      : 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400'
  }`}>{delay === 0 ? timeoutLabel : `${delay}ms`}</span>;
}
