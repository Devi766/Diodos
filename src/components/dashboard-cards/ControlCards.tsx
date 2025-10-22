import React from 'react';
import { Card } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

interface SystemProxyCardProps {
  enabled: boolean;
  updating: boolean;
  onToggle: (checked: boolean) => void;
}

export function SystemProxyCard({ enabled, updating, onToggle }: SystemProxyCardProps) {
  return (
    <Card
      data-hoverable="false"
      className="flex items-center justify-between rounded-3xl bg-white px-6 py-4 shadow-sm dark:bg-[#2a2a2a]"
    >
      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          系统代理
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          切换操作系统级代理开关
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
  return (
    <Card
      data-hoverable="false"
      className="flex items-center justify-between rounded-3xl bg-white px-6 py-4 shadow-sm dark:bg-[#2a2a2a]"
    >
      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          TUN 模式
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          增强路由模式,需管理员权限
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

const MODE_LABELS = {
  rule: '规则模式',
  global: '全局模式',
  direct: '直连模式',
};

const MODE_OPTIONS = [
  { key: 'rule' as const, label: MODE_LABELS.rule },
  { key: 'global' as const, label: MODE_LABELS.global },
  { key: 'direct' as const, label: MODE_LABELS.direct },
];

export function ProxyModeCard({ mode, updating, onModeSwitch }: ProxyModeCardProps) {
  return (
    <Card
      data-hoverable="false"
      className="flex flex-col gap-4 rounded-3xl bg-white p-6 shadow-sm dark:bg-[#2a2a2a]"
    >
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          代理模式
        </p>
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-blue-500/10 px-3 py-1 text-xs font-medium text-blue-600 dark:bg-blue-500/20 dark:text-blue-100">
            {mode ? MODE_LABELS[mode] : '读取中...'}
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
