import React from 'react';
import { Clock3 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { CardHeading } from './CardHeading';

interface SubscriptionImmersiveCardProps {
  name?: string;
  remaining: string | null;
  fraction: number | null;
  expiry: Date | null;
  daysLeft: number | null;
  loading?: boolean;
}

export function SubscriptionImmersiveCard({ name, remaining, fraction, expiry, daysLeft, loading = false }: SubscriptionImmersiveCardProps) {
  const { t } = useTranslation();
  const remainingFraction = fraction !== null && Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : null;
  const usedFraction = remainingFraction !== null ? 1 - remainingFraction : null;
  const usedPercent = usedFraction !== null ? Math.round(usedFraction * 100) : null;
  const valueParts = remaining?.match(/^(.*?)\s+(\S+)$/);
  const date = expiry ? `${expiry.getFullYear()}/${String(expiry.getMonth() + 1).padStart(2, '0')}/${String(expiry.getDate()).padStart(2, '0')}` : null;
  const expiryLabel = date ? t(daysLeft !== null && daysLeft <= 0 ? 'dashboard.subscriptionImmersive.expiredOn' : 'dashboard.subscriptionImmersive.expiresOn', { date })
    : t(name ? 'dashboard.subscriptionImmersive.noExpiry' : 'dashboard.subscriptionImmersive.selectSubscription');
  const expiryColor = daysLeft !== null && daysLeft <= 0 ? 'text-red-500' : daysLeft !== null && daysLeft <= 7 ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground';

  return (
    <div className="dashboard-card dashboard-half-card relative isolate overflow-hidden [container-type:inline-size]" aria-busy={loading}>
      <div aria-hidden className="pointer-events-none absolute -right-4 top-6 size-28 rounded-full bg-primary/[0.035] blur-2xl dark:bg-primary/[0.055]" />
      <svg viewBox="0 0 112 88" role="img"
        aria-label={usedPercent === null ? t('dashboard.subscriptionImmersive.unknownUsage') : t('dashboard.subscriptionImmersive.usedPercent', { percentage: usedPercent })}
        className="pointer-events-none absolute -right-6 top-7"
        style={{ width: 'clamp(128px, 66cqw, 176px)', aspectRatio: '112 / 88' }}>
        {/* 圆环倾斜压缩成透视椭圆，中心文字保持正向 */}
        <g transform="translate(56 44) rotate(-28) scale(1 .62)">
          <circle cx="0" cy="1.5" r="42" fill="none" strokeWidth="10" className="stroke-slate-200/60 dark:stroke-white/[0.06]" />
          <circle cx="0" cy="0" r="42" fill="none" strokeWidth="9" className="stroke-slate-100 dark:stroke-white/10" />
          {usedFraction !== null && usedFraction > 0 && !loading && <circle cx="0" cy="0" r="42" pathLength="100" fill="none" strokeWidth="9" strokeLinecap="round"
            strokeDasharray="100 100" strokeDashoffset={100 - usedFraction * 100} transform="rotate(-90)"
            className={usedFraction >= 0.9 ? 'stroke-red-500' : usedFraction >= 0.7 ? 'stroke-amber-500' : 'stroke-primary'} />}
        </g>
        <text x="56" y="43" textAnchor="middle" className="fill-foreground text-[15px] font-semibold tabular-nums">{loading || usedPercent === null ? '--' : `${usedPercent}%`}</text>
        <text x="56" y="55" textAnchor="middle" className="fill-muted-foreground text-[9px]">{t('dashboard.subscriptionImmersive.used')}</text>
      </svg>
      <div className="relative flex h-full flex-col p-card">
        <div className="flex h-6 shrink-0 items-center gap-1.5" title={name}>
          <CardHeading type="subscription-info">{t('dashboard.subscriptionInfo')}</CardHeading>
        </div>
        <div className="flex min-h-0 flex-1 flex-col justify-center gap-0.5" style={{ paddingRight: 'clamp(60px, 34cqw, 80px)' }}>
          <span className="text-[10px] leading-4 text-muted-foreground">{t('dashboard.remainingTraffic')}</span>
          {loading ? <span className="h-7 w-24 animate-pulse rounded-md bg-muted/60" /> :
            <span className="flex min-w-0 items-baseline gap-1 whitespace-nowrap font-semibold leading-7 tracking-tight tabular-nums text-foreground" title={remaining ?? undefined}>
              <span className="truncate text-[clamp(18px,10cqw,24px)]">{valueParts ? valueParts[1] : remaining || '--'}</span>
              {valueParts && <span className="shrink-0 text-[11px] font-medium tracking-normal text-muted-foreground">{valueParts[2]}</span>}
            </span>}
        </div>
        <div className={`flex h-4 shrink-0 items-center gap-1.5 ${expiryColor} ${!date ? 'invisible' : ''}`} aria-hidden={!date} title={date ? `${t('dashboard.expiryDate')}: ${date}${daysLeft !== null && daysLeft > 0 ? ` · ${t('dashboard.daysRemaining', { days: daysLeft })}` : ''}` : undefined}>
          <Clock3 className="size-3 shrink-0" strokeWidth={1.7} />
          <span className="truncate text-[10px] leading-4">{expiryLabel}</span>
        </div>
      </div>
    </div>
  );
}
