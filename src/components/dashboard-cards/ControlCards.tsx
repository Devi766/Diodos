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
        <p className="mt-1 text-sm text-muted-foreground">
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
    <path d="M12 4L12 20M12 4L8 8M12 4L16 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
  </svg>
);

const GlobalModeIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg" {...props}>
    <path fillRule="evenodd" d="M10.5 4.646L8.354 2.5h-.707L5.5 4.646l.707.707L7.3 4.261V5.28h-.02v.456l.025.001l.006.319q.005.281.05.574t.117.586t.2.627q.232.568.565 1.031t.715.867t.76.797q.376.393.681.838t.494.973q.188.526.188 1.213v.884H12.5v-.884a6 6 0 0 0-.166-1.39a4.6 4.6 0 0 0-.427-1.1a6 6 0 0 0-.604-.897q-.333-.404-.693-.774q-.36-.369-.693-.738a6.4 6.4 0 0 1-.604-.785a3.8 3.8 0 0 1-.433-.914a3.7 3.7 0 0 1-.16-1.13V5.28h-.001v-1l1.074 1.074zM7.042 9.741a8 8 0 0 0 .329-.369a6 6 0 0 1-.62-1.15L6.744 8.2a7 7 0 0 1-.095-.263q-.255.384-.565.726q-.333.369-.693.738q-.36.37-.693.774t-.604.896a4.6 4.6 0 0 0-.427 1.102a6 6 0 0 0-.166 1.389v.884h1.42v-.884q0-.686.188-1.213q.188-.528.493-.973q.304-.445.682-.838l.76-.797z" clipRule="evenodd" />
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
          <span className="rounded-full bg-blue-500/10 px-3 py-1 text-xs font-medium text-blue-600 dark:bg-blue-500/20 dark:text-blue-100">
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
                'flex h-11 w-full flex-1 items-center justify-center rounded-xl border text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/60 bg-white dark:bg-[#222222]',
                isActive
                  ? 'border-blue-500 text-blue-600 dark:border-blue-400 dark:text-blue-100'
                  : 'border-slate-200 text-slate-700 hover:border-blue-300 hover:bg-blue-50/40 dark:border-slate-700 dark:text-slate-200 dark:hover:border-blue-400/60 dark:hover:bg-blue-500/10',
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
