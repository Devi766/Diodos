import React from 'react';
import { Card } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { useTranslation } from 'react-i18next';

interface SystemProxyCardProps {
  enabled: boolean;
  updating: boolean;
  onToggle: (checked: boolean) => void;
}

export function SystemProxyCard({ enabled, updating, onToggle }: SystemProxyCardProps) {
  const { t } = useTranslation();
  return (
    <Card
      data-hoverable="false"
      className="flex items-center justify-between rounded-3xl bg-white px-6 py-4 shadow-sm dark:bg-[#2a2a2a]"
    >
      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t('dashboard.systemProxy')}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('dashboard.systemProxyDesc')}
        </p>
      </div>
      <Switch checked={enabled} disabled={updating} onCheckedChange={onToggle} />
    </Card>
  );
}

interface TunModeCardProps {
  enabled: boolean;
  updating: boolean;
  available: boolean;
  onToggle: (checked: boolean) => void;
}

export function TunModeCard({ enabled, updating, available, onToggle }: TunModeCardProps) {
  const { t } = useTranslation();
  return (
    <Card
      data-hoverable="false"
      className="flex items-center justify-between rounded-3xl bg-white px-6 py-4 shadow-sm dark:bg-[#2a2a2a]"
    >
      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t('dashboard.tunMode')}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('dashboard.tunModeDesc')}
        </p>
      </div>
      <Switch checked={enabled} disabled={updating || !available} onCheckedChange={onToggle} />
    </Card>
  );
}

interface ProxyModeCardProps {
  mode: 'rule' | 'global' | 'direct' | null;
  updating: boolean;
  onModeSwitch: (mode: 'rule' | 'global' | 'direct') => void;
}

export function ProxyModeCard({ mode, updating, onModeSwitch }: ProxyModeCardProps) {
  const { t } = useTranslation();

  const MODE_LABELS = {
    rule: t('dashboard.ruleMode'),
    global: t('dashboard.globalMode'),
    direct: t('dashboard.directMode'),
  };

  const MODE_OPTIONS = [
    { key: 'rule' as const, label: MODE_LABELS.rule },
    { key: 'global' as const, label: MODE_LABELS.global },
    { key: 'direct' as const, label: MODE_LABELS.direct },
  ];

  return (
    <Card
      data-hoverable="false"
      className="flex flex-col gap-4 rounded-3xl bg-white p-6 shadow-sm dark:bg-[#2a2a2a]"
    >
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t('dashboard.proxyMode')}
        </p>
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-blue-500/10 px-3 py-1 text-xs font-medium text-blue-600 dark:bg-blue-500/20 dark:text-blue-100">
            {mode ? MODE_LABELS[mode] : t('dashboard.loading')}
          </span>
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-3">
        {MODE_OPTIONS.map((option) => {
          const isActive = mode === option.key;
          return (
            <button
              key={option.key}
              type="button"
              onClick={() => onModeSwitch(option.key)}
              disabled={updating || isActive}
              className={cn(
                'inline-flex h-10 w-full min-w-[0] items-center justify-center gap-2 rounded-xl border px-4 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/60 bg-white dark:bg-[#222222]',
                isActive
                  ? 'border-blue-500 text-blue-600 dark:border-blue-400 dark:text-blue-100'
                  : 'border-slate-200 text-slate-700 hover:border-blue-300 hover:bg-blue-50/40 dark:border-slate-700 dark:text-slate-200 dark:hover:border-blue-400/60 dark:hover:bg-blue-500/10',
              )}
            >
              <span className="whitespace-nowrap">{option.label}</span>
            </button>
          );
        })}
      </div>
    </Card>
  );
}
