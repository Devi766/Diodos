'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslation } from 'react-i18next';
import {
  AppWindow,
  Calendar,
  Clock,
  Layers,
  PieChart,
  RefreshCw,
  Server,
  TrendingUp,
} from 'lucide-react';
import { CardHeading } from './CardHeading';
import { useThemeColor } from '@/hooks/useThemeColor';
import { useElementVisible } from '@/hooks/useElementVisible';
import { getUiLocale } from '@/i18n/ui-text';
import {
  formatUsageBytes,
  HeatmapWidgetData,
  MonthWidgetData,
  nextUsageRange,
  queryUsageWidget,
  RankWidgetData,
  sampleAppsWidget,
  sampleDestinationsWidget,
  sampleHeatmapWidget,
  sampleMonthWidget,
  sampleNodesWidget,
  sampleTodayWidget,
  sampleTrendWidget,
  splitUsageBytes,
  TodayWidgetData,
  TrendWidgetData,
  USAGE_GROUP_PALETTE,
  UsageRange,
  UsageRankItem,
} from '@/lib/usage-api';
import {
  ProcessIconBadge,
  UsageHeatmapGrid,
  UsageMonthBars,
  UsageSplitBar,
  UsageTrendAreaChart,
} from '@/components/usage/UsageCharts';
import { cn } from '@/lib/utils';

export type UsageWidgetVariant =
  | 'month'
  | 'today'
  | 'trend'
  | 'destinations'
  | 'apps'
  | 'nodes'
  | 'heatmap';

interface UsageWidgetCardProps {
  cardId: string;
  variant?: string;
  preview?: boolean;
}

const DIRECT_COLOR = '#34C759';
const RANGE_PREFIX = 'diodos-usage-widget-range:';

function loadSavedRange(cardId: string): UsageRange {
  if (typeof window === 'undefined') return 'day';
  try {
    const v = window.localStorage.getItem(RANGE_PREFIX + cardId);
    if (v === 'day' || v === 'week' || v === 'month' || v === 'year') return v;
  } catch {}
  return 'day';
}

function saveRange(cardId: string, range: UsageRange) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(RANGE_PREFIX + cardId, range);
  } catch {}
}

function RangePill({
  range,
  onCycle,
  preview,
}: {
  range: UsageRange;
  onCycle: () => void;
  preview: boolean;
}) {
  const { t } = useTranslation();
  const label =
    range === 'day'
      ? t('usage.today')
      : range === 'week'
        ? t('usage.card.rangeWeek')
        : range === 'month'
          ? t('usage.card.rangeMonth')
          : t('usage.card.rangeYear');
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        if (!preview) onCycle();
      }}
      className="inline-flex shrink-0 items-center gap-1 rounded-pill bg-black/[0.05] px-2 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-black/[0.09] hover:text-foreground dark:bg-white/[0.08] dark:hover:bg-white/[0.14]"
    >
      <span>{label}</span>
      <RefreshCw className="size-2.5 opacity-70" />
    </button>
  );
}

export function UsageWidgetCard({ cardId, variant = 'month', preview = false }: UsageWidgetCardProps) {
  const kind: UsageWidgetVariant = (
    ['month', 'today', 'trend', 'destinations', 'apps', 'nodes', 'heatmap'].includes(variant)
      ? variant
      : 'month'
  ) as UsageWidgetVariant;

  const { t, i18n } = useTranslation();
  const router = useRouter();
  const accent = useThemeColor();
  const locale = getUiLocale();
  const isZh = (i18n.resolvedLanguage || locale).toLowerCase().startsWith('zh');

  const containerRef = useRef<HTMLDivElement>(null);
  const visible = useElementVisible(containerRef);
  const [range, setRange] = useState<UsageRange>(() => loadSavedRange(cardId));
  const [data, setData] = useState<unknown>(null);
  const [scrubDay, setScrubDay] = useState<number | null>(null);

  const cycleRange = useCallback(() => {
    setRange((prev) => {
      const next = nextUsageRange(prev);
      saveRange(cardId, next);
      return next;
    });
  }, [cardId]);

  useEffect(() => {
    if (preview) {
      setData(null);
      return;
    }
    if (!visible) return;
    let alive = true;
    const load = async () => {
      const res = await queryUsageWidget(kind, range);
      if (alive && res) setData(res);
    };
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, 30_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [kind, range, preview, visible]);

  const openDetail = () => {
    if (!preview) router.push('/usage');
  };

  // --- 1. Today (half) ---
  if (kind === 'today') {
    const d = (preview ? sampleTodayWidget() : (data as TodayWidgetData | null)) ?? {
      today: { up: 0, down: 0, proxy: 0, direct: 0, total: 0 },
      yesterdaySameTime: 0,
    };
    const { num, unit } = splitUsageBytes(d.today.total);
    const pct = d.today.total > 0 ? Math.round((d.today.proxy / d.today.total) * 100) : 0;
    const compare =
      d.yesterdaySameTime > 0 && d.today.total > 0
        ? Math.round(((d.today.total - d.yesterdaySameTime) / d.yesterdaySameTime) * 100)
        : null;

    return (
      <div
        ref={containerRef}
        onClick={openDetail}
        className="dashboard-card dashboard-half-card flex cursor-pointer flex-col justify-between p-card transition-shadow hover:shadow-md"
      >
        <div className="flex h-6 items-center justify-between gap-2">
          <CardHeading type="usage-overview" icon={PieChart}>
            {t('usage.card.today')}
          </CardHeading>
        </div>

        <div className="flex flex-1 flex-col justify-center gap-2.5">
          <div className="flex items-baseline gap-1.5">
            <span className="text-2xl font-semibold leading-7 text-foreground tabular-nums">
              {num}
            </span>
            <span className="text-xs font-medium text-muted-foreground">{unit}</span>
          </div>

          <UsageSplitBar
            height={6}
            segments={[
              { value: d.today.proxy, color: accent },
              { value: d.today.direct, color: DIRECT_COLOR },
            ]}
          />

          <div className="truncate text-[11.5px] text-muted-foreground tabular-nums">
            {t('usage.card.proxyShare', { pct })}
            {compare !== null && (
              <>
                {' · '}
                <span className={compare >= 0 ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400'}>
                  {compare >= 0
                    ? t('usage.card.vsYesterdayUp', { pct: Math.abs(compare) })
                    : t('usage.card.vsYesterdayDown', { pct: Math.abs(compare) })}
                </span>
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  // --- 2. Month Wide (standard full) ---
  if (kind === 'month') {
    const d = (preview ? sampleMonthWidget() : (data as MonthWidgetData | null)) ?? {
      days: Array.from({ length: 30 }, () => 0),
      today: new Date().getDate(),
      monthStartMs: new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime(),
    };
    const past = d.days.slice(0, Math.min(d.today, d.days.length));
    const total = past.reduce((a, b) => a + b, 0);
    const avg = Math.round(total / Math.max(1, d.today));
    const peakIdx = past.reduce((best, val, idx) => (val > past[best] ? idx : best), 0);
    const displayBytes = scrubDay !== null ? (d.days[scrubDay] ?? 0) : total;
    const { num, unit } = splitUsageBytes(displayBytes);
    const monthLabel = new Date(d.monthStartMs).toLocaleDateString(locale, { month: 'short' });
    const dayLabel = (idx: number) =>
      new Date(d.monthStartMs + idx * 86_400_000).toLocaleDateString(locale, {
        month: 'short',
        day: 'numeric',
      });

    return (
      <div
        ref={containerRef}
        onClick={openDetail}
        className="dashboard-card dashboard-standard-full-card flex cursor-pointer flex-col p-card transition-shadow hover:shadow-md"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardHeading type="usage-overview" icon={Calendar}>
              {t('usage.card.month')} · {monthLabel}
            </CardHeading>
            <div className="mt-1 flex items-baseline gap-1.5">
              <span className="text-2xl font-semibold leading-7 text-foreground tabular-nums">
                {num}
              </span>
              <span className="text-xs font-medium text-muted-foreground">{unit}</span>
            </div>
          </div>

          <div className="shrink-0 text-right text-[11px] text-muted-foreground tabular-nums">
            {scrubDay !== null ? (
              <>
                <div className="font-semibold text-foreground">{dayLabel(scrubDay)}</div>
                <div>
                  {(d.days[scrubDay] ?? 0) >= avg
                    ? t('usage.card.aboveAvg', {
                        value: formatUsageBytes(Math.abs((d.days[scrubDay] ?? 0) - avg), true),
                      })
                    : t('usage.card.belowAvg', {
                        value: formatUsageBytes(Math.abs((d.days[scrubDay] ?? 0) - avg), true),
                      })}
                </div>
              </>
            ) : (
              <>
                <div>{t('usage.card.dailyAvg', { value: formatUsageBytes(avg, true) })}</div>
                {past[peakIdx] > 0 && (
                  <div className="opacity-80">
                    {t('usage.card.peakDay', {
                      day: dayLabel(peakIdx),
                      value: formatUsageBytes(past[peakIdx], true),
                    })}
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        <UsageMonthBars
          days={d.days}
          today={d.today}
          accentColor={accent}
          selectedIndex={scrubDay}
          onSelect={setScrubDay}
          className="mt-2 min-h-0 flex-1"
        />
      </div>
    );
  }

  // --- 3. 7-Day Trend (standard full) ---
  if (kind === 'trend') {
    const d = (preview ? sampleTrendWidget() : (data as TrendWidgetData | null)) ?? {
      days: [0, 0, 0, 0, 0, 0, 0],
      previous: [0, 0, 0, 0, 0, 0, 0],
      startMs: Date.now() - 6 * 86_400_000,
    };
    const total = d.days.reduce((a, b) => a + b, 0);
    const prevTotal = d.previous.reduce((a, b) => a + b, 0);
    const { num, unit } = splitUsageBytes(total);
    const delta =
      prevTotal > 0 && total > 0 ? Math.round(((total - prevTotal) / prevTotal) * 100) : null;
    const weekdays = isZh
      ? ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
      : ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const labels = Array.from({ length: 7 }, (_, i) => {
      if (i === 6) return t('usage.today');
      const dt = new Date(d.startMs + i * 86_400_000);
      return weekdays[(dt.getDay() + 6) % 7] ?? '';
    });

    return (
      <div
        ref={containerRef}
        onClick={openDetail}
        className="dashboard-card dashboard-standard-full-card flex cursor-pointer flex-col p-card transition-shadow hover:shadow-md"
      >
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-baseline gap-2.5">
            <CardHeading type="usage-overview" icon={TrendingUp}>
              {t('usage.card.trend')}
            </CardHeading>
            <div className="flex items-baseline gap-1">
              <span className="text-lg font-semibold text-foreground tabular-nums">{num}</span>
              <span className="text-[11px] font-medium text-muted-foreground">{unit}</span>
            </div>
            <span className="hidden text-[11px] text-muted-foreground sm:inline tabular-nums">
              {t('usage.card.dailyAvg', { value: formatUsageBytes(Math.round(total / 7), true) })}
            </span>
          </div>

          {delta !== null ? (
            <span
              className={cn(
                'shrink-0 rounded-pill px-2 py-0.5 text-[10.5px] font-semibold tabular-nums',
                delta >= 0
                  ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                  : 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
              )}
            >
              {delta >= 0
                ? t('usage.card.vsLastWeekUp', { pct: Math.abs(delta) })
                : t('usage.card.vsLastWeekDown', { pct: Math.abs(delta) })}
            </span>
          ) : (
            <span className="text-[11px] text-muted-foreground">{t('usage.card.last7Days')}</span>
          )}
        </div>

        <UsageTrendAreaChart
          values={d.days}
          previous={d.previous}
          labels={labels}
          accentColor={accent}
          className="mt-1 min-h-0 flex-1"
        />
      </div>
    );
  }

  // --- 4. Destinations / Strategy Groups (large full) ---
  if (kind === 'destinations') {
    const d = (preview ? sampleDestinationsWidget() : (data as RankWidgetData | null)) ?? {
      items: [],
    };
    const items = d.items.slice(0, 6);
    const total = Math.max(1, items.reduce((s, it) => s + it.total, 0));

    return (
      <div
        ref={containerRef}
        onClick={openDetail}
        className="dashboard-card dashboard-large-card flex cursor-pointer flex-col p-card transition-shadow hover:shadow-md"
      >
        <div className="flex h-6 items-center justify-between gap-2">
          <CardHeading type="usage-overview" icon={Layers}>
            {t('usage.card.destinations')}
          </CardHeading>
          <RangePill range={range} onCycle={cycleRange} preview={preview} />
        </div>

        <div className="mt-3">
          <UsageSplitBar
            height={10}
            segments={items.map((it, idx) => ({
              value: it.total,
              color: USAGE_GROUP_PALETTE[idx % USAGE_GROUP_PALETTE.length],
            }))}
          />
        </div>

        {items.length === 0 ? (
          <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
            {t('usage.card.empty')}
          </div>
        ) : (
          <div className="mt-4 grid flex-1 grid-cols-2 content-start gap-x-5 gap-y-3">
            {items.map((item, idx) => {
              const color = USAGE_GROUP_PALETTE[idx % USAGE_GROUP_PALETTE.length];
              const share = Math.round((item.total / total) * 100);
              return (
                <div
                  key={item.name}
                  className="flex items-center gap-2.5 rounded-control bg-black/[0.025] px-2.5 py-2 dark:bg-white/[0.04]"
                >
                  <span
                    className="h-6 w-1 shrink-0 rounded-full"
                    style={{ backgroundColor: color }}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-medium text-foreground">{item.name}</div>
                    <div className="text-[10.5px] text-muted-foreground tabular-nums">{share}%</div>
                  </div>
                  <span className="shrink-0 text-xs font-semibold text-foreground tabular-nums">
                    {formatUsageBytes(item.total, true)}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  // --- 5 & 6. Apps / Nodes Mini Ranking (half) ---
  if (kind === 'apps' || kind === 'nodes') {
    const isApps = kind === 'apps';
    const d = (
      preview
        ? (isApps ? sampleAppsWidget() : sampleNodesWidget())
        : (data as RankWidgetData | null)
    ) ?? { items: [] };
    const items: UsageRankItem[] = d.items;
    const maxV = Math.max(1, ...items.map((it) => it.total));

    return (
      <div
        ref={containerRef}
        onClick={openDetail}
        className="dashboard-card dashboard-half-card flex cursor-pointer flex-col p-card transition-shadow hover:shadow-md"
      >
        <div className="flex h-6 shrink-0 items-center justify-between gap-2">
          <CardHeading type="usage-overview" icon={isApps ? AppWindow : Server}>
            {isApps ? t('usage.card.apps') : t('usage.card.nodes')}
          </CardHeading>
          <RangePill range={range} onCycle={cycleRange} preview={preview} />
        </div>

        {items.length === 0 ? (
          <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
            {t('usage.card.empty')}
          </div>
        ) : (
          <div className="custom-scrollbar mt-2 min-h-0 flex-1 space-y-2 overflow-y-auto pr-0.5">
            {items.slice(0, 6).map((item) => {
              const pct = Math.max(4, (item.total / maxV) * 100);
              return (
                <div key={item.name} className="flex items-center gap-2">
                  {isApps ? (
                    <ProcessIconBadge name={item.name} path={item.extra} size={18} />
                  ) : (
                    <div
                      className="flex size-[18px] shrink-0 items-center justify-center rounded-[5px]"
                      style={{ backgroundColor: `${accent}1A`, color: accent }}
                    >
                      <Server className="size-2.5" />
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-1.5 text-[11.5px] leading-none">
                      <span className="truncate text-foreground">{item.name}</span>
                      <span className="shrink-0 font-semibold text-foreground tabular-nums">
                        {formatUsageBytes(item.total, true)}
                      </span>
                    </div>
                    <div className="mt-1 h-[3px] w-full overflow-hidden rounded-full bg-black/[0.06] dark:bg-white/[0.08]">
                      <div
                        className="h-full rounded-full"
                        style={{ width: `${pct}%`, backgroundColor: accent }}
                      />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  // --- 7. Heatmap (standard full) ---
  const heatData = (preview ? sampleHeatmapWidget() : (data as HeatmapWidgetData | null)) ?? {
    heat: Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0)),
  };
  const byHour = Array.from({ length: 24 }, (_, h) =>
    heatData.heat.reduce((sum, row) => sum + (row[h] ?? 0), 0),
  );
  const heatSum = byHour.reduce((a, b) => a + b, 0);
  let peakH = 0;
  let peakVal = -1;
  for (let h = 0; h < 24; h++) {
    const pair = byHour[h] + byHour[(h + 1) % 24];
    if (pair > peakVal) {
      peakVal = pair;
      peakH = h;
    }
  }
  const peakWindow =
    heatSum > 0
      ? `${String(peakH).padStart(2, '0')}:00–${String((peakH + 2) % 24).padStart(2, '0')}:00`
      : null;

  return (
    <div
      ref={containerRef}
      onClick={openDetail}
      className="dashboard-card dashboard-standard-full-card flex cursor-pointer flex-col justify-between p-card transition-shadow hover:shadow-md"
    >
      <div className="flex h-5 items-center justify-between gap-2">
        <CardHeading type="usage-overview" icon={Clock}>
          {t('usage.card.heatmap')}
        </CardHeading>
        {peakWindow && (
          <span className="text-[11px] font-medium text-muted-foreground tabular-nums">
            {t('usage.heatmap.peak', { window: peakWindow })}
          </span>
        )}
      </div>

      <UsageHeatmapGrid
        values={heatData.heat}
        accentColor={accent}
        compact
        className="mt-1.5"
      />
    </div>
  );
}
