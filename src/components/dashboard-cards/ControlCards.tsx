import React from 'react';
import { ArrowUpRight, Globe2, Loader2, Split } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { useTranslation } from 'react-i18next';
import { CardHeading } from './CardHeading';

interface ProxyModeCardProps {
  mode: 'rule' | 'global' | 'direct' | null;
  updating: boolean;
  onModeSwitch: (mode: 'rule' | 'global' | 'direct') => void;
}

export function ProxyModeCard({ mode, updating, onModeSwitch }: ProxyModeCardProps) {
  const { t } = useTranslation();
  const options = [
    { key: 'rule' as const, label: t('dashboard.ruleMode'), Icon: Split },
    { key: 'global' as const, label: t('dashboard.globalMode'), Icon: Globe2 },
    { key: 'direct' as const, label: t('dashboard.directMode'), Icon: ArrowUpRight },
  ];

  return (
    <Card data-hoverable="false" className="dashboard-card dashboard-half-card flex flex-col p-card">
      <div className="flex h-6 shrink-0 items-center justify-between gap-2">
        <CardHeading type="proxy-mode">{t('dashboard.proxyMode')}</CardHeading>
        {updating && <Loader2 aria-hidden className="size-3.5 animate-spin text-primary" />}
      </div>
      <div className="flex min-h-0 flex-1 items-center">
        <div className="dashboard-control-surface grid h-[68px] w-full grid-cols-3 gap-1 rounded-[18px] p-1" role="group" aria-label={t('dashboard.proxyMode')} aria-busy={updating}>
          {options.map(option => {
            const isActive = mode === option.key;
            return (
              <button
                key={option.key}
                type="button"
                aria-label={option.label}
                aria-pressed={isActive}
                title={option.label}
                onClick={() => { if (!updating && !isActive) onModeSwitch(option.key); }}
                disabled={updating || isActive}
                className={cn(
                  'relative flex min-w-0 flex-col items-center justify-center gap-1 rounded-[14px] transition-all duration-200 motion-reduce:transition-none',
                  'disabled:cursor-default focus-visible:ring-2 focus-visible:ring-primary/40',
                  isActive
                    ? 'dashboard-control-selected text-primary ring-1 ring-black/[0.025] dark:ring-white/[0.04]'
                    : 'dashboard-control-hover text-muted-foreground hover:text-foreground',
                  updating && !isActive && 'opacity-50',
                )}
              >
                <option.Icon aria-hidden className="size-[19px]" strokeWidth={1.7} />
                <span className="max-w-full truncate px-0.5 text-[10px] font-medium leading-4">{t(`dashboard.proxyModeOptions.${option.key}`)}</span>
              </button>
            );
          })}
        </div>
      </div>
    </Card>
  );
}
