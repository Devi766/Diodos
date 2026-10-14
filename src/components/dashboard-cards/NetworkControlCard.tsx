import React from 'react';
import { Cable, Globe2, Loader2, type LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { CardHeading } from './CardHeading';

interface NetworkControlCardProps {
  proxyEnabled: boolean;
  proxyUpdating: boolean;
  onProxyToggle: (enabled: boolean) => void;
  tunEnabled: boolean;
  tunUpdating: boolean;
  tunAvailable: boolean;
  isRunning: boolean;
  onTunToggle: (enabled: boolean) => void;
  preview?: boolean;
}

function ControlTile({ label, description, Icon, enabled, updating, disabled, preview, onToggle }: {
  label: string;
  description: string;
  Icon: LucideIcon;
  enabled: boolean;
  updating: boolean;
  disabled: boolean;
  preview: boolean;
  onToggle: (enabled: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={label}
      aria-busy={updating}
      disabled={disabled || updating || preview}
      title={description}
      onClick={() => onToggle(!enabled)}
      className={cn(
        'dashboard-control-surface group/control flex min-w-0 flex-col justify-between rounded-nested border border-black/[0.04] p-2.5 text-left transition-colors duration-200 dark:border-white/[0.06]',
        'disabled:cursor-default focus-visible:ring-2 focus-visible:ring-primary/50',
        !disabled && !updating && !preview && 'dashboard-control-hover',
        disabled && !preview && '[&>span]:opacity-50',
      )}
    >
      <span className="flex items-center justify-between gap-1">
        <Icon aria-hidden className={cn('size-4 shrink-0', enabled ? 'text-primary' : 'text-muted-foreground')} strokeWidth={1.8} />
        {updating ? (
          <Loader2 aria-hidden className="h-4 w-7 animate-spin text-primary" />
        ) : (
          <span aria-hidden className={cn('relative h-4 w-7 shrink-0 rounded-pill transition-colors', enabled ? 'bg-primary' : 'bg-black/15 dark:bg-white/20')}>
            <span className={cn('absolute top-0.5 size-3 rounded-pill bg-white shadow-sm transition-transform duration-200 motion-reduce:transition-none', enabled ? 'translate-x-3.5' : 'translate-x-0.5')} />
          </span>
        )}
      </span>
      <span className={cn('truncate text-[11px] font-medium leading-4', enabled ? 'text-foreground' : 'text-muted-foreground')}>{label}</span>
    </button>
  );
}

export function NetworkControlCard({
  proxyEnabled, proxyUpdating, onProxyToggle,
  tunEnabled, tunUpdating, tunAvailable, isRunning, onTunToggle, preview = false,
}: NetworkControlCardProps) {
  const { t } = useTranslation();
  const active = proxyEnabled || tunEnabled;
  const tunDisabled = !tunAvailable || !isRunning;
  const tunDescription = !isRunning
    ? t('dashboard.networkControl.startCore')
    : !tunAvailable ? t('dashboard.networkControl.tunUnavailable') : t('dashboard.tunModeDesc');

  return (
    <div className="dashboard-card dashboard-half-card flex flex-col p-card">
      <div className="flex h-6 shrink-0 items-center justify-between gap-2">
        <CardHeading type="network-control">{t('dashboard.networkControl.title')}</CardHeading>
        <span className={cn('flex shrink-0 items-center gap-1 text-[10px] leading-4', active ? 'text-primary' : 'text-muted-foreground')}>
          <span aria-hidden className={cn('size-1 rounded-pill', active ? 'bg-primary' : 'bg-muted-foreground/40')} />
          {t(active ? 'dashboard.networkControl.active' : 'dashboard.networkControl.inactive')}
        </span>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-2 items-center gap-2 [&>button]:h-[68px]">
        <ControlTile label={t('dashboard.systemProxy')} description={t('dashboard.systemProxyDesc')} Icon={Globe2}
          enabled={proxyEnabled} updating={proxyUpdating} disabled={false} preview={preview} onToggle={onProxyToggle} />
        <ControlTile label={t('dashboard.tunMode')} description={tunDescription} Icon={Cable}
          enabled={tunEnabled} updating={tunUpdating} disabled={tunDisabled} preview={preview} onToggle={onTunToggle} />
      </div>
    </div>
  );
}
