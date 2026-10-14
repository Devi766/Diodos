import React from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { BrandIcon } from '@/components/dashboard-cards/BrandIcon';
import { CardHeading } from './CardHeading';
import {
  CONNECTIVITY_PREVIEW,
  CONNECTIVITY_TARGETS,
  ConnectivityLevel,
  ConnectivityResult,
  ConnectivitySnapshot,
  runConnectivityCheck,
  useConnectivitySnapshot,
} from '@/lib/connectivity-checker';

export type ConnectivityCardVariant = 'grid' | 'small' | 'list';

interface ConnectivityCheckCardProps {
  variant?: string;
  // 小组件库预览：展示示例结果，不响应点击
  preview?: boolean;
}

const LEVEL_COLOR: Record<ConnectivityLevel, string> = {
  good: '#34C759',
  fair: '#FFCC00',
  slow: '#FF9500',
  failed: '#FF3B30',
  pending: '#9A9A9E',
};

const LEVEL_TEXT_KEY: Record<Exclude<ConnectivityLevel, 'pending'>, string> = {
  good: 'dashboard.connectivity.fast',
  fair: 'dashboard.connectivity.normal',
  slow: 'dashboard.connectivity.slow',
  failed: 'dashboard.connectivity.unreachable',
};

// 延迟条：越快越长，超时为空
const barFraction = (result: ConnectivityResult) => {
  if (result.delay === null) return 0;
  return Math.min(1, Math.max(0.08, 1 - result.delay / 1500));
};

const LABELS: Record<string, string> = Object.fromEntries(
  CONNECTIVITY_TARGETS.map((target) => [target.id, target.label]),
);

function StatusDot({ level }: { level: ConnectivityLevel }) {
  return (
    <span
      className="inline-block size-1.5 shrink-0 rounded-pill"
      style={{ backgroundColor: LEVEL_COLOR[level] }}
    />
  );
}

export function ConnectivityCheckCard({ variant = 'grid', preview = false }: ConnectivityCheckCardProps) {
  const { t } = useTranslation();
  const live = useConnectivitySnapshot();
  const snapshot: ConnectivitySnapshot = preview ? CONNECTIVITY_PREVIEW : live;
  const { running } = snapshot;
  const layout: ConnectivityCardVariant =
    variant === 'small' || variant === 'list' ? variant : 'grid';

  const delayText = (result: ConnectivityResult, withUnit = true) => {
    if (result.level === 'pending') return running ? '···' : '--';
    if (result.delay === null) return t('dashboard.connectivity.timeout');
    return withUnit ? `${result.delay}ms` : String(result.delay);
  };

  const statusText = (result: ConnectivityResult) => {
    if (result.level === 'pending') {
      return t(running ? 'dashboard.connectivity.checking' : 'dashboard.connectivity.notChecked');
    }
    return t(LEVEL_TEXT_KEY[result.level]);
  };

  const reachable = snapshot.results.filter((r) => r.delay !== null).length;
  const delays = snapshot.results.map((r) => r.delay).filter((d): d is number => d !== null);
  const average = delays.length ? Math.round(delays.reduce((sum, d) => sum + d, 0) / delays.length) : null;
  const summary = snapshot.checkedAt > 0 && !running
    ? `${reachable}/${snapshot.results.length}${average !== null ? ` · ${average}ms` : ''}`
    : '';

  const handleCheck = (event?: React.MouseEvent) => {
    event?.stopPropagation();
    if (!preview) void runConnectivityCheck();
  };

  return (
    <div
      className={cn(
        'dashboard-card flex flex-col',
        layout === 'small' ? 'dashboard-half-card p-card' : layout === 'list' ? 'dashboard-large-card p-card' : 'dashboard-standard-full-card p-card',
        !preview && 'cursor-pointer',
      )}
      onClick={() => handleCheck()}
    >
      <div className="flex h-6 shrink-0 items-center justify-between gap-2">
        <CardHeading type="connectivity-check">{t('dashboard.connectivity.title')}</CardHeading>
        <div className="flex shrink-0 items-center gap-1.5">
          {summary && layout !== 'small' && <span className="text-xs tabular-nums text-muted-foreground">{summary}</span>}
          <button
            type="button"
            onClick={handleCheck}
            disabled={running}
            className="rounded-lg p-1 transition-colors hover:bg-muted disabled:cursor-default"
            title={t('dashboard.connectivity.check')}
          >
            <RefreshCw className={cn('size-card-icon text-muted-foreground', running && 'animate-spin')} />
          </button>
        </div>
      </div>

      {layout === 'grid' && (
        <div className="mt-2 grid min-h-0 flex-1 grid-cols-6 gap-1.5">
          {snapshot.results.map((result) => (
            <div
              key={result.id}
              className="dashboard-control-surface flex min-w-0 flex-col items-center justify-center gap-1 rounded-control px-1 py-2 text-center"
              title={`${LABELS[result.id]} · ${statusText(result)}`}
            >
              <div className="relative">
                <BrandIcon id={result.id} className="size-[18px] text-black dark:text-white" />
                <span className="absolute -right-1.5 -top-1"><StatusDot level={result.level} /></span>
              </div>
              <div className="w-full min-w-0">
                <div className="truncate text-[9px] font-medium leading-3 text-muted-foreground">{LABELS[result.id]}</div>
                <div className="mt-0.5 truncate text-[10px] font-medium leading-3 tabular-nums text-foreground">{delayText(result)}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {layout === 'small' && (
        <div className="grid min-h-0 flex-1 grid-cols-3 grid-rows-2 place-items-center gap-x-2 gap-y-1">
          {snapshot.results.map((result) => (
            <div key={result.id} className="flex min-w-0 flex-col items-center" title={LABELS[result.id]}>
              <div className="relative flex size-5 items-center justify-center rounded-md bg-gray-50 dark:bg-white/5">
                <BrandIcon id={result.id} className="size-3.5 text-black dark:text-white" />
                <span className="absolute -right-1 -top-0.5">
                  <StatusDot level={result.level} />
                </span>
              </div>
              <span className="text-[10px] leading-3 font-medium tabular-nums text-foreground">{delayText(result, false)}</span>
            </div>
          ))}
        </div>
      )}

      {layout === 'list' && (
        <div className="mt-3 flex min-h-0 flex-1 flex-col justify-between">
          {snapshot.results.map((result) => (
            <div key={result.id} className="flex items-center gap-3">
              <BrandIcon id={result.id} className="size-4 shrink-0 text-black dark:text-white" />
              <span className="w-20 shrink-0 truncate text-xs font-medium text-foreground">{LABELS[result.id]}</span>
              <div className="relative h-1.5 min-w-0 flex-1 overflow-hidden rounded-pill bg-gray-100 dark:bg-gray-800">
                <div
                  className="absolute inset-0 origin-left rounded-pill transition-transform duration-300 ease-out"
                  style={{
                    backgroundColor: LEVEL_COLOR[result.level],
                    transform: `scaleX(${barFraction(result)})`,
                  }}
                />
              </div>
              <span className="w-12 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                {delayText(result)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
