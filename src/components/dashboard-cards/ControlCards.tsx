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
        <p className="mt-1 text-xs text-muted-foreground">
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
  isRunning: boolean;
  onToggle: (checked: boolean) => void;
}

export function TunModeCard({ enabled, updating, available, isRunning, onToggle }: TunModeCardProps) {
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
        <p className="mt-1 text-xs text-muted-foreground">
          {t('dashboard.tunModeDesc')}
        </p>
      </div>
      <Switch checked={enabled} disabled={updating || !available || !isRunning} onCheckedChange={onToggle} />
    </Card>
  );
}

interface ProxyModeCardProps {
  mode: 'rule' | 'global' | 'direct' | null;
  updating: boolean;
  onModeSwitch: (mode: 'rule' | 'global' | 'direct') => void;
}

const DirectModeIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg" {...props}>
    <path d="M13.5,5.5C14.59,5.5 15.5,4.58 15.5,3.5C15.5,2.38 14.59,1.5 13.5,1.5C12.39,1.5 11.5,2.38 11.5,3.5C11.5,4.58 12.39,5.5 13.5,5.5M9.89,19.38L10.89,15L13,17V23H15V15.5L12.89,13.5L13.5,10.5C14.79,12 16.79,13 19,13V11C17.09,11 15.5,10 14.69,8.58L13.69,7C13.29,6.38 12.69,6 12,6C11.69,6 11.5,6.08 11.19,6.08L6,8.28V13H8V9.58L9.79,8.88L8.19,17L3.29,16L2.89,18L9.89,19.38Z" />
  </svg>
);

const GlobalModeIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg" {...props}>
    <path d="M16.36,14C16.44,13.34 16.5,12.68 16.5,12C16.5,11.32 16.44,10.66 16.36,10H19.74C19.9,10.64 20,11.31 20,12C20,12.69 19.9,13.36 19.74,14M14.59,19.56C15.19,18.45 15.65,17.25 15.97,16H18.92C17.96,17.65 16.43,18.93 14.59,19.56M14.34,14H9.66C9.56,13.34 9.5,12.68 9.5,12C9.5,11.32 9.56,10.65 9.66,10H14.34C14.43,10.65 14.5,11.32 14.5,12C14.5,12.68 14.43,13.34 14.34,14M12,19.96C11.17,18.76 10.5,17.43 10.09,16H13.91C13.5,17.43 12.83,18.76 12,19.96M8,8H5.08C6.03,6.34 7.57,5.06 9.4,4.44C8.8,5.55 8.35,6.75 8,8M5.08,16H8C8.35,17.25 8.8,18.45 9.4,19.56C7.57,18.93 6.03,17.65 5.08,16M4.26,14C4.1,13.36 4,12.69 4,12C4,11.31 4.1,10.64 4.26,10H7.64C7.56,10.66 7.5,11.32 7.5,12C7.5,12.68 7.56,13.34 7.64,14M12,4.03C12.83,5.23 13.5,6.57 13.91,8H10.09C10.5,6.57 11.17,5.23 12,4.03M18.92,8H15.97C15.65,6.75 15.19,5.55 14.59,4.44C16.43,5.07 17.96,6.34 18.92,8M12,2C6.47,2 2,6.5 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2Z" />
  </svg>
);

const RuleModeIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg" {...props}>
    <path d="M14 4L16.29 6.29L13.41 9.17L14.83 10.59L17.71 7.71L20 10V4M10 4H4V10L6.29 7.71L11 12.41V20H13V11.59L7.71 6.29" />
  </svg>
);

export function ProxyModeCard({ mode, updating, onModeSwitch }: ProxyModeCardProps) {
  const { t } = useTranslation();

  const MODE_LABELS = {
    rule: t('dashboard.ruleMode'),
    global: t('dashboard.globalMode'),
    direct: t('dashboard.directMode'),
  };

  const MODE_OPTIONS = [
    { key: 'rule' as const, label: MODE_LABELS.rule, Icon: RuleModeIcon },
    { key: 'global' as const, label: MODE_LABELS.global, Icon: GlobalModeIcon },
    { key: 'direct' as const, label: MODE_LABELS.direct, Icon: DirectModeIcon },
  ];

  return (
    <Card
      data-hoverable="false"
      className="flex flex-col gap-4 rounded-3xl bg-white p-5 shadow-sm dark:bg-[#2a2a2a]"
    >
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t('dashboard.proxyMode')}
        </p>
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary dark:bg-primary/20">
            {mode ? MODE_LABELS[mode] : t('dashboard.loading')}
          </span>
        </div>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-stretch sm:gap-3">
        {MODE_OPTIONS.map((option) => {
          const isActive = mode === option.key;
          return (
            <button
              key={option.key}
              type="button"
              onClick={() => onModeSwitch(option.key)}
              disabled={updating || isActive}
              className={cn(
                'flex h-11 w-full flex-1 items-center justify-center rounded-xl border text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 bg-white dark:bg-[#222222]',
                isActive
                  ? 'border-primary text-primary'
                  : 'border-slate-200 text-slate-700 hover:border-primary/40 hover:bg-primary/5 dark:border-slate-700 dark:text-slate-200 dark:hover:border-primary/60 dark:hover:bg-primary/10',
              )}
            >
              <option.Icon className="h-6 w-6" />
              <span className="sr-only">{option.label}</span>
            </button>
          );
        })}
      </div>
    </Card>
  );
}
