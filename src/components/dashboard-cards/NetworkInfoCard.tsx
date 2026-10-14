import React from 'react';
import { CardHeading } from './CardHeading';
import { useTranslation } from 'react-i18next';

export interface NetworkMetric {
  label: string;
  value: string;
  helper?: string;
}

export function NetworkInfoCard({ metrics }: { metrics: NetworkMetric[] }) {
  const { t } = useTranslation();
  const total = metrics[3];
  const totalParts = total?.value.match(/^(.*?)\s+(\S+)$/);
  const indicators = [
    { metric: metrics[0], label: t('dashboard.networkInfo.connections') },
    { metric: metrics[1], label: t('dashboard.networkInfo.download') },
    { metric: metrics[2], label: t('dashboard.networkInfo.upload') },
  ];

  return (
    <div className="dashboard-card dashboard-standard-full-card flex flex-col justify-between p-card">
      <div className="flex h-4 shrink-0 items-center justify-between gap-3">
        <CardHeading type="network-info">{t('dashboard.networkInfo.title')}</CardHeading>
        {total?.helper && <span className="max-w-[45%] truncate text-[10px] text-muted-foreground" title={total.helper}>{total.helper}</span>}
      </div>

      <div className="flex min-w-0 items-baseline gap-2" aria-label={total?.label}>
        <span className="flex min-w-0 items-baseline gap-1.5 text-foreground" aria-label={total?.value}>
          <span className="dashboard-traffic-number truncate text-2xl font-medium leading-8 tracking-[-0.02em] tabular-nums">{totalParts ? totalParts[1] : total?.value ?? '--'}</span>
          {totalParts && <span className="text-xs font-medium leading-4 tracking-normal text-muted-foreground">{totalParts[2]}</span>}
        </span>
        <span className="shrink-0 text-[11px] text-muted-foreground">{total?.label ?? t('dashboard.totalTrafficLabel')}</span>
      </div>

      <div className="grid grid-cols-3 divide-x divide-black/[0.08] dark:divide-white/10">
        {indicators.map(({ metric, label }, index) => (
          <div key={index} className="min-w-0 px-4 first:pl-0 last:pr-0" title={[metric?.label, metric?.helper].filter(Boolean).join(' · ')}>
            <div className="truncate text-[10px] leading-4 text-muted-foreground">{label}</div>
            <div className="truncate text-sm font-semibold leading-5 tabular-nums text-foreground">{metric?.value ?? '--'}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
