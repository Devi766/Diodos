'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'motion/react';
import {
  AlertTriangle,
  AppWindow,
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  Clock,
  Filter,
  Globe,
  Layers,
  Server,
  Trash2,
} from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { showToast } from '@/components/ui/toast';
import { useThemeColor } from '@/hooks/useThemeColor';
import { getUiLocale } from '@/i18n/ui-text';
import {
  clearUsageData,
  emptyUsageSnapshot,
  formatUsageBytes,
  queryUsageSnapshot,
  splitUsageBytes,
  updateUsageSettings,
  USAGE_DIM,
  UsageDim,
  UsagePeriod,
  UsageRange,
  UsageRankItem,
  UsageSnapshot,
} from '@/lib/usage-api';
import {
  ProcessIconBadge,
  UsageHeatmapGrid,
  UsageSplitBar,
  UsageStackedBarChart,
} from '@/components/usage/UsageCharts';
import { cn } from '@/lib/utils';

const DIRECT_COLOR = '#34C759';
const RANGE_STORAGE_KEY = 'diodos-usage-range';
const RETENTION_OPTIONS = [30, 90, 180, 365] as const;

const RANGES: UsageRange[] = ['day', 'week', 'month', 'year'];

const RANK_TABS: Array<{ dim: UsageDim; key: string }> = [
  { dim: USAGE_DIM.SITE, key: 'usage.rank.site' },
  { dim: USAGE_DIM.APP, key: 'usage.rank.app' },
  { dim: USAGE_DIM.NODE, key: 'usage.rank.node' },
  { dim: USAGE_DIM.GROUP, key: 'usage.rank.group' },
  { dim: USAGE_DIM.RULE, key: 'usage.rank.rule' },
];

function formatPeriodLabel(range: UsageRange, offset: number, period: UsagePeriod, locale: string, todayPrefix: string): string {
  const start = new Date(period.startMs);
  const end = new Date(Math.max(period.startMs, period.endMs - 1));
  if (range === 'day') {
    const md = start.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
    if (offset === 0) return `${todayPrefix} · ${md}`;
    return start.toLocaleDateString(locale, { month: 'short', day: 'numeric', weekday: 'short' });
  }
  if (range === 'week') {
    const a = start.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
    const b = end.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
    return `${a} – ${b}`;
  }
  if (range === 'month') {
    return start.toLocaleDateString(locale, { year: 'numeric', month: 'long' });
  }
  return String(start.getFullYear());
}

function buildAxisLabels(range: UsageRange, count: number, weekdaysShort: string[], isZh: boolean): string[] {
  return Array.from({ length: count }, (_, i) => {
    if (range === 'day') return i % 6 === 0 ? (isZh ? `${i}时` : `${i}h`) : '';
    if (range === 'week') return weekdaysShort[i] ?? '';
    if (range === 'month') {
      if (i === 0 || i === 9 || i === 19 || i === count - 1) return isZh ? `${i + 1}日` : `${i + 1}`;
      return '';
    }
    return i % 3 === 0 || i === count - 1 ? (isZh ? `${i + 1}月` : `M${i + 1}`) : '';
  });
}

function buildBucketLabels(
  range: UsageRange,
  count: number,
  period: UsagePeriod,
  locale: string,
  weekdays: string[],
): string[] {
  return Array.from({ length: count }, (_, i) => {
    if (range === 'day') return `${String(i).padStart(2, '0')}:00`;
    if (range === 'week') return weekdays[i] ?? '';
    if (range === 'month') {
      const d = new Date(period.startMs + i * 86_400_000);
      return d.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
    }
    const base = new Date(period.startMs);
    const d = new Date(base.getFullYear(), i, 1);
    return d.toLocaleDateString(locale, { year: 'numeric', month: 'short' });
  });
}

function RankDimIcon({ dim, item, accent }: { dim: UsageDim; item: UsageRankItem; accent: string }) {
  if (dim === USAGE_DIM.APP) {
    return <ProcessIconBadge name={item.name} path={item.extra} size={34} className="rounded-[9px]" />;
  }
  const Icon =
    dim === USAGE_DIM.SITE
      ? Globe
      : dim === USAGE_DIM.NODE
        ? Server
        : dim === USAGE_DIM.GROUP
          ? Layers
          : Filter;
  const tone =
    (dim === USAGE_DIM.SITE && !item.mostlyProxy) || item.name.toUpperCase() === 'DIRECT'
      ? DIRECT_COLOR
      : accent;

  return (
    <div
      className="flex size-[34px] shrink-0 items-center justify-center rounded-[9px]"
      style={{ backgroundColor: `${tone}16`, color: tone }}
    >
      <Icon className="size-4" strokeWidth={1.9} />
    </div>
  );
}

export default function UsageAnalytics() {
  const { t, i18n } = useTranslation();
  const accent = useThemeColor();
  const locale = getUiLocale();
  const isZh = (i18n.resolvedLanguage || locale).toLowerCase().startsWith('zh');

  const [range, setRange] = useState<UsageRange>(() => {
    if (typeof window === 'undefined') return 'day';
    const saved = window.localStorage.getItem(RANGE_STORAGE_KEY);
    return RANGES.includes(saved as UsageRange) ? (saved as UsageRange) : 'day';
  });
  const [offset, setOffset] = useState(0);
  const [rankDim, setRankDim] = useState<UsageDim>(USAGE_DIM.SITE);
  const [rankExpanded, setRankExpanded] = useState(false);
  const [snapshot, setSnapshot] = useState<UsageSnapshot>(() => emptyUsageSnapshot('day', 0));
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);

  const loadSnapshot = useCallback(async () => {
    try {
      const data = await queryUsageSnapshot({
        range,
        offset,
        rankDim,
        rankLimit: rankExpanded ? 50 : 6,
      });
      setSnapshot(data);
    } catch (error) {
      console.error('[UsageAnalytics] failed to query snapshot:', error);
    }
  }, [range, offset, rankDim, rankExpanded]);

  useEffect(() => {
    void loadSnapshot();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void loadSnapshot();
      }
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [loadSnapshot]);

  const handleRangeChange = (next: UsageRange) => {
    setRange(next);
    setOffset(0);
    try {
      window.localStorage.setItem(RANGE_STORAGE_KEY, next);
    } catch {}
  };

  const handleToggleEnabled = async (checked: boolean) => {
    const updated = await updateUsageSettings({ enabled: checked });
    if (updated) {
      setSnapshot((prev) => ({ ...prev, settings: updated }));
    }
    void loadSnapshot();
  };

  const handleToggleDetail = async (checked: boolean) => {
    const updated = await updateUsageSettings({ detail: checked });
    if (updated) {
      setSnapshot((prev) => ({ ...prev, settings: updated }));
    }
    void loadSnapshot();
  };

  const handleRetentionChange = async (days: number) => {
    const updated = await updateUsageSettings({ retentionDays: days });
    if (updated) {
      setSnapshot((prev) => ({ ...prev, settings: updated }));
      showToast({ message: t('usage.settings.saved'), type: 'success' });
    }
    void loadSnapshot();
  };

  const handleConfirmClear = async () => {
    setClearConfirmOpen(false);
    const ok = await clearUsageData();
    if (ok) {
      showToast({ message: t('usage.settings.cleared'), type: 'success' });
      void loadSnapshot();
    }
  };

  const weekdaysShort = useMemo(
    () => (isZh ? ['一', '二', '三', '四', '五', '六', '日'] : ['M', 'T', 'W', 'T', 'F', 'S', 'S']),
    [isZh],
  );
  const weekdays = useMemo(
    () => (isZh ? ['周一', '周二', '周三', '周四', '周五', '周六', '周日'] : ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']),
    [isZh],
  );

  const { num: totalNum, unit: totalUnit } = splitUsageBytes(snapshot.totals.total);
  const proxyShare = snapshot.totals.total > 0
    ? Math.round((snapshot.totals.proxy / snapshot.totals.total) * 100)
    : 0;
  const directShare = snapshot.totals.total > 0 ? 100 - proxyShare : 0;

  const periodLabel = useMemo(
    () => formatPeriodLabel(range, offset, snapshot.period, locale, t('usage.today')),
    [range, offset, snapshot.period, locale, t],
  );

  const axisLabels = useMemo(
    () => buildAxisLabels(range, snapshot.series.length, weekdaysShort, isZh),
    [range, snapshot.series.length, weekdaysShort, isZh],
  );
  const bucketLabels = useMemo(
    () => buildBucketLabels(range, snapshot.series.length, snapshot.period, locale, weekdays),
    [range, snapshot.series.length, snapshot.period, locale, weekdays],
  );

  const trendSubtitle =
    range === 'day'
      ? t('usage.trend.byHour')
      : range === 'year'
        ? t('usage.trend.byMonth')
        : t('usage.trend.byDay');

  const heatPeakLabel = useMemo(() => {
    const byHour = Array.from({ length: 24 }, (_, h) =>
      snapshot.heat.reduce((sum, row) => sum + (row[h] ?? 0), 0),
    );
    const sum = byHour.reduce((a, b) => a + b, 0);
    if (sum <= 0) return null;
    let bestH = 0;
    let bestVal = -1;
    for (let h = 0; h < 24; h++) {
      const pair = byHour[h] + byHour[(h + 1) % 24];
      if (pair > bestVal) {
        bestVal = pair;
        bestH = h;
      }
    }
    return `${String(bestH).padStart(2, '0')}:00–${String((bestH + 2) % 24).padStart(2, '0')}:00`;
  }, [snapshot.heat]);

  const maxRankTotal = useMemo(
    () => Math.max(1, ...snapshot.ranking.map((r) => r.total)),
    [snapshot.ranking],
  );
  const overallTotal = Math.max(1, snapshot.totals.total);

  const subtitleOf = (item: UsageRankItem) => {
    if (rankDim === USAGE_DIM.SITE) {
      return [
        item.extra || null,
        item.subCount > 1 ? t('usage.rank.subdomains', { count: item.subCount }) : null,
      ]
        .filter(Boolean)
        .join(' · ');
    }
    if (rankDim === USAGE_DIM.APP) {
      return item.extra || t('usage.rank.connections', { count: item.hits });
    }
    if (rankDim === USAGE_DIM.NODE) {
      return [item.extra || null, t('usage.rank.connections', { count: item.hits })]
        .filter(Boolean)
        .join(' · ');
    }
    if (rankDim === USAGE_DIM.GROUP) {
      return [item.extra ? `→ ${item.extra}` : null, t('usage.rank.connections', { count: item.hits })]
        .filter(Boolean)
        .join(' · ');
    }
    return [item.extra || null, t('usage.rank.hits', { count: item.hits })]
      .filter(Boolean)
      .join(' · ');
  };

  return (
    <div className="space-y-6 min-w-0">
      {/* Top Header + Controls */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1 min-w-0">
          <h1 className="text-2xl font-semibold text-foreground">
            {t('usage.title')}
          </h1>
          <p className="text-sm text-muted-foreground">{t('usage.subtitle')}</p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          {/* Range Segmented Control */}
          <div className="relative inline-flex rounded-pill bg-black/[0.05] p-1 dark:bg-white/[0.08]">
            {RANGES.map((item) => {
              const active = range === item;
              return (
                <button
                  key={item}
                  type="button"
                  onClick={() => handleRangeChange(item)}
                  className={cn(
                    'relative z-[1] rounded-pill px-3.5 py-1.5 text-xs font-medium transition-colors',
                    active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {active && (
                    <motion.span
                      layoutId="usage-range-pill"
                      transition={{ type: 'spring', stiffness: 460, damping: 34 }}
                      className="absolute inset-0 -z-[1] rounded-pill bg-white shadow-sm dark:bg-[#3a3a3d]"
                    />
                  )}
                  {t(`usage.range.${item}`)}
                </button>
              );
            })}
          </div>

          {/* Period Navigator */}
          <div className="inline-flex items-center gap-1 rounded-pill bg-white px-1.5 py-1 shadow-sm dark:bg-[#2a2a2a]">
            <button
              type="button"
              onClick={() => setOffset((o) => o - 1)}
              aria-label={t('usage.prevPeriod')}
              className="flex size-7 items-center justify-center rounded-full text-foreground/80 transition-colors hover:bg-black/[0.06] dark:hover:bg-white/[0.08]"
            >
              <ChevronLeft className="size-4" />
            </button>
            <span className="min-w-[118px] px-1 text-center text-xs font-semibold text-foreground tabular-nums">
              {periodLabel}
            </span>
            <button
              type="button"
              disabled={offset >= 0}
              onClick={() => setOffset((o) => Math.min(0, o + 1))}
              aria-label={t('usage.nextPeriod')}
              className="flex size-7 items-center justify-center rounded-full text-foreground/80 transition-colors hover:bg-black/[0.06] disabled:pointer-events-none disabled:opacity-30 dark:hover:bg-white/[0.08]"
            >
              <ChevronRight className="size-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Paused Recording Banner */}
      {!snapshot.settings.enabled && (
        <div className="flex items-center justify-between gap-3 rounded-nested border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
          <div className="flex items-center gap-2.5">
            <AlertTriangle className="size-4 shrink-0" />
            <span>{t('usage.disabledBanner')}</span>
          </div>
          <button
            type="button"
            onClick={() => handleToggleEnabled(true)}
            className="shrink-0 rounded-pill bg-amber-500 px-3 py-1 text-xs font-semibold text-white transition-opacity hover:opacity-90"
          >
            {t('usage.enableNow')}
          </button>
        </div>
      )}

      {/* Row 1: Hero Overview + Trend Chart */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        {/* Overview Hero Card */}
        <div className="dashboard-card flex flex-col justify-between p-6 lg:col-span-5">
          <div>
            <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              {t('usage.overview.totalTraffic')}
            </div>
            <div className="mt-2 flex items-baseline gap-2">
              <span className="text-[44px] font-bold leading-none tracking-tight text-foreground tabular-nums">
                {totalNum}
              </span>
              <span className="text-lg font-semibold text-muted-foreground">{totalUnit}</span>
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5 rounded-pill bg-black/[0.04] px-2.5 py-1 dark:bg-white/[0.06]">
                <ArrowUp className="size-3.5 text-amber-500" />
                <span>{t('usage.upload')}</span>
                <strong className="font-semibold text-foreground tabular-nums">
                  {formatUsageBytes(snapshot.totals.up)}
                </strong>
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-pill bg-black/[0.04] px-2.5 py-1 dark:bg-white/[0.06]">
                <ArrowDown className="size-3.5 text-primary" />
                <span>{t('usage.download')}</span>
                <strong className="font-semibold text-foreground tabular-nums">
                  {formatUsageBytes(snapshot.totals.down)}
                </strong>
              </span>
            </div>
          </div>

          <div className="mt-6 space-y-3.5">
            <UsageSplitBar
              height={10}
              segments={[
                { value: snapshot.totals.proxy, color: accent },
                { value: snapshot.totals.direct, color: DIRECT_COLOR },
              ]}
            />

            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-nested bg-black/[0.03] px-3.5 py-2.5 dark:bg-white/[0.04]">
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="size-2 rounded-full" style={{ backgroundColor: accent }} />
                    {t('usage.proxy')}
                  </span>
                  <span className="tabular-nums">{proxyShare}%</span>
                </div>
                <div className="mt-1 text-base font-semibold text-foreground tabular-nums">
                  {formatUsageBytes(snapshot.totals.proxy)}
                </div>
              </div>

              <div className="rounded-nested bg-black/[0.03] px-3.5 py-2.5 dark:bg-white/[0.04]">
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="size-2 rounded-full" style={{ backgroundColor: DIRECT_COLOR }} />
                    {t('usage.direct')}
                  </span>
                  <span className="tabular-nums">{directShare}%</span>
                </div>
                <div className="mt-1 text-base font-semibold text-foreground tabular-nums">
                  {formatUsageBytes(snapshot.totals.direct)}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Stacked Trend Bar Chart Card */}
        <div className="dashboard-card flex flex-col justify-between p-6 lg:col-span-7">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold text-foreground">{t('usage.section.trend')}</h2>
              <p className="text-xs text-muted-foreground">{trendSubtitle}</p>
            </div>
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                <span className="size-2 rounded-full" style={{ backgroundColor: accent }} />
                {t('usage.proxy')}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="size-2 rounded-full" style={{ backgroundColor: DIRECT_COLOR }} />
                {t('usage.direct')}
              </span>
            </div>
          </div>

          <UsageStackedBarChart
            points={snapshot.series}
            labels={axisLabels}
            bucketLabels={bucketLabels}
            proxyColor={accent}
            directColor={DIRECT_COLOR}
            proxyLabel={t('usage.proxy')}
            directLabel={t('usage.direct')}
            height={196}
          />
        </div>
      </div>

      {/* Row 2: Ranking + Heatmap */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        {/* Ranking Card */}
        <div className="dashboard-card flex flex-col p-6 lg:col-span-7">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-foreground">{t('usage.section.ranking')}</h2>

            {/* Dimension Pills */}
            <div className="flex flex-wrap items-center gap-1.5">
              {RANK_TABS.map(({ dim, key }) => {
                const active = rankDim === dim;
                return (
                  <button
                    key={dim}
                    type="button"
                    onClick={() => {
                      setRankDim(dim);
                      setRankExpanded(false);
                    }}
                    className={cn(
                      'rounded-pill px-3 py-1 text-xs font-medium transition-all',
                      active
                        ? 'text-white shadow-sm'
                        : 'bg-black/[0.05] text-muted-foreground hover:bg-black/[0.09] hover:text-foreground dark:bg-white/[0.07] dark:hover:bg-white/[0.12]',
                    )}
                    style={active ? { backgroundColor: accent } : undefined}
                  >
                    {t(key)}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="mt-4 divide-y divide-black/[0.05] dark:divide-white/[0.06]">
            {snapshot.ranking.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center text-xs text-muted-foreground">
                <AppWindow className="mb-2 size-7 opacity-35" />
                <span>
                  {snapshot.settings.detail
                    ? t('usage.rank.empty')
                    : t('usage.rank.detailOff')}
                </span>
              </div>
            ) : (
              snapshot.ranking.map((item) => {
                const showBadge = rankDim === USAGE_DIM.SITE || rankDim === USAGE_DIM.APP;
                const tone =
                  !showBadge || item.mostlyProxy ? accent : DIRECT_COLOR;
                const barPct = Math.max(2, (item.total / maxRankTotal) * 100);
                const sharePct = Math.min(100, Math.round((item.total / overallTotal) * 100));
                const sub = subtitleOf(item);

                return (
                  <div
                    key={item.name}
                    className="flex items-center gap-3 py-3 first:pt-1 last:pb-1"
                  >
                    <RankDimIcon dim={rankDim} item={item} accent={accent} />

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-foreground">
                          {item.name}
                        </span>
                        {showBadge && (
                          <span
                            className="shrink-0 rounded-[5px] px-1.5 py-[1px] text-[10px] font-semibold"
                            style={{
                              backgroundColor: `${tone}1F`,
                              color: tone,
                            }}
                          >
                            {item.mostlyProxy ? t('usage.proxy') : t('usage.direct')}
                          </span>
                        )}
                      </div>
                      {sub && (
                        <div className="mt-0.5 truncate text-[11.5px] text-muted-foreground">
                          {sub}
                        </div>
                      )}
                      <div className="mt-2 h-[4px] w-full overflow-hidden rounded-full bg-black/[0.06] dark:bg-white/[0.08]">
                        <div
                          className="h-full rounded-full transition-all duration-500 ease-out"
                          style={{ width: `${barPct}%`, backgroundColor: tone }}
                        />
                      </div>
                    </div>

                    <div className="shrink-0 text-right tabular-nums">
                      <div className="text-sm font-semibold text-foreground">
                        {formatUsageBytes(item.total)}
                      </div>
                      <div className="text-[11px] text-muted-foreground">{sharePct}%</div>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {snapshot.ranking.length >= 6 && (
            <button
              type="button"
              onClick={() => setRankExpanded((v) => !v)}
              className="mt-3 self-center rounded-pill px-4 py-1.5 text-xs font-medium transition-colors hover:bg-black/[0.05] dark:hover:bg-white/[0.07]"
              style={{ color: accent }}
            >
              {rankExpanded ? t('usage.rank.showLess') : t('usage.rank.showMore')}
            </button>
          )}
        </div>

        {/* Right Column: Heatmap + Settings */}
        <div className="flex flex-col gap-4 lg:col-span-5">
          {/* Activity Heatmap Card */}
          <div className="dashboard-card p-6">
            <div className="mb-4 flex items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold text-foreground">
                  {t('usage.section.heatmap')}
                </h2>
                <p className="text-xs text-muted-foreground">{t('usage.heatmap.recent')}</p>
              </div>
              {heatPeakLabel && (
                <span className="inline-flex items-center gap-1 rounded-pill bg-black/[0.05] px-2.5 py-1 text-[11px] font-medium text-foreground tabular-nums dark:bg-white/[0.08]">
                  <Clock className="size-3 text-muted-foreground" />
                  {t('usage.heatmap.peak', { window: heatPeakLabel })}
                </span>
              )}
            </div>

            <UsageHeatmapGrid
              values={snapshot.heat}
              rowLabels={weekdaysShort}
              accentColor={accent}
            />
          </div>

          {/* Settings Card */}
          <div className="dashboard-card p-6">
            <h2 className="mb-3 text-sm font-semibold text-foreground">
              {t('usage.section.settings')}
            </h2>

            <div className="divide-y divide-black/[0.06] dark:divide-white/[0.07]">
              <div className="flex items-center justify-between gap-4 py-3 first:pt-1">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-foreground">
                    {t('usage.settings.enable')}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {t('usage.settings.enableDesc')}
                  </div>
                </div>
                <Switch
                  checked={snapshot.settings.enabled}
                  onCheckedChange={handleToggleEnabled}
                />
              </div>

              <div className="flex items-center justify-between gap-4 py-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-foreground">
                    {t('usage.settings.detail')}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {t('usage.settings.detailDesc')}
                  </div>
                </div>
                <Switch
                  checked={snapshot.settings.detail}
                  disabled={!snapshot.settings.enabled}
                  onCheckedChange={handleToggleDetail}
                />
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="text-sm font-medium text-foreground">
                  {t('usage.settings.retention')}
                </div>
                <div className="inline-flex rounded-pill bg-black/[0.05] p-0.5 dark:bg-white/[0.08]">
                  {RETENTION_OPTIONS.map((days) => {
                    const active = snapshot.settings.retentionDays === days;
                    const label =
                      days >= 365
                        ? t('usage.settings.oneYear')
                        : t('usage.settings.days', { days });
                    return (
                      <button
                        key={days}
                        type="button"
                        onClick={() => handleRetentionChange(days)}
                        className={cn(
                          'rounded-pill px-2.5 py-1 text-[11px] font-medium transition-colors',
                          active
                            ? 'bg-white text-foreground shadow-sm dark:bg-[#3a3a3d]'
                            : 'text-muted-foreground hover:text-foreground',
                        )}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="flex items-center justify-between gap-4 pt-3">
                <div className="text-xs text-muted-foreground">
                  {t('usage.footer')}
                </div>
                <button
                  type="button"
                  onClick={() => setClearConfirmOpen(true)}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-pill bg-red-500/10 px-3 py-1.5 text-xs font-medium text-red-600 transition-colors hover:bg-red-500/20 dark:text-red-400"
                >
                  <Trash2 className="size-3.5" />
                  {t('usage.settings.clear')}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={clearConfirmOpen}
        title={t('usage.settings.clear')}
        description={t('usage.settings.clearConfirm')}
        confirmText={t('usage.settings.clearAction')}
        cancelText={t('common.cancel')}
        onConfirm={handleConfirmClear}
        onCancel={() => setClearConfirmOpen(false)}
      />
    </div>
  );
}
