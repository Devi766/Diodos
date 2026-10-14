import React from 'react';
import type { LucideIcon } from 'lucide-react';
import type { DashboardCardType } from '@/types/dashboard';
import { DASHBOARD_CARD_ICONS } from '@/lib/dashboard-icons';
import { cn } from '@/lib/utils';

export function CardHeading({ type, children, icon, className }: {
  type: DashboardCardType; children: React.ReactNode; icon?: LucideIcon; className?: string;
}) {
  const Icon = icon ?? DASHBOARD_CARD_ICONS[type];
  return <div className={cn('flex min-w-0 self-start items-start gap-1.5 text-muted-foreground', className)}>
    <Icon aria-hidden className="size-card-icon shrink-0" strokeWidth={1.7} />
    <span className="dashboard-card-title truncate text-inherit">{children}</span>
  </div>;
}
