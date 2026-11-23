'use client';

import React, { useEffect, useId, useMemo, useState } from 'react';
import { AppWindow } from 'lucide-react';
import { formatUsageBytes, UsagePoint } from '@/lib/usage-api';
import { loadProcessIcon, processIconKey } from '@/lib/process-icons';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Split Bar (Proxy / Direct or Multi-group)
// ---------------------------------------------------------------------------

export interface SplitBarSegment {
  value: number;
  color: string;
}

export function UsageSplitBar({
  segments,
  height = 10,
  className,
}: {
  segments: SplitBarSegment[];
  height?: number;
  className?: string;
}) {
  const visible = segments.filter((s) => s.value > 0);
  const total = visible.reduce((sum, s) => sum + s.value, 0);

  if (total <= 0) {
    return (
      <div
        className={cn('w-full rounded-full bg-black/[0.06] dark:bg-white/[0.08]', className)}
        style={{ height }}
      />
    );
  }

  return (
    <div
      className={cn('flex w-full items-center gap-[3px]', className)}
      style={{ height }}
    >
      {visible.map((seg, idx) => {
        const pct = (seg.value / total) * 100;
        return (
          <div
            key={idx}
            className="h-full rounded-full transition-all duration-500 ease-out"
            style={{
              width: `${pct}%`,
              minWidth: height,
              backgroundColor: seg.color,
            }}
          />
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stacked Bar Chart (Proxy bottom + Direct top, interactive scrubbing)
// ---------------------------------------------------------------------------

export function UsageStackedBarChart({
  points,
  labels,
  bucketLabels,
  proxyColor,
  directColor = '#34C759',
  proxyLabel,
  directLabel,
  height = 196,
  className,
}: {
  points: UsagePoint[];
  labels: string[];
  bucketLabels: string[];
  proxyColor: string;
  directColor?: string;
  proxyLabel: string;
  directLabel: string;
  height?: number;
  className?: string;
}) {
  const busiestIndex = useMemo(() => {
    let best = -1;
    let bestVal = 0;
    points.forEach((p, i) => {
      if (p.total > bestVal) {
        bestVal = p.total;
        best = i;
      }
    });
    return best >= 0 ? best : null;
  }, [points]);

  const [hovered, setHovered] = useState<number | null>(null);
  const activeIdx = hovered ?? busiestIndex;
  const maxV = useMemo(
    () => Math.max(1, ...points.map((p) => p.total)),
    [points],
  );
  const n = points.length || 1;
  const activePoint = activeIdx !== null ? points[activeIdx] : null;
  const activeTipLeft = activeIdx !== null ? ((activeIdx + 0.5) / n) * 100 : 50;

  return (
    <div className={cn('relative select-none', className)}>
      {/* Floating top tooltip */}
      <div className="relative h-8">
        {activeIdx !== null && activePoint && activePoint.total > 0 && (
          <div
            className="pointer-events-none absolute top-0 z-10 flex items-center gap-2 whitespace-nowrap rounded-pill bg-foreground px-3 py-1 text-[11px] font-medium text-background shadow-md transition-all duration-150"
            style={{
              left: `${Math.min(86, Math.max(14, activeTipLeft))}%`,
              transform: 'translateX(-50%)',
            }}
          >
            <span className="opacity-75">{bucketLabels[activeIdx] ?? ''}</span>
            <span className="font-semibold tabular-nums">
              {formatUsageBytes(activePoint.total)}
            </span>
            <span className="hidden items-center gap-1.5 opacity-80 sm:inline-flex">
              <span className="inline-block size-1.5 rounded-full" style={{ backgroundColor: proxyColor }} />
              <span className="tabular-nums">{formatUsageBytes(activePoint.proxy, true)}</span>
              <span className="inline-block size-1.5 rounded-full" style={{ backgroundColor: directColor }} />
              <span className="tabular-nums">{formatUsageBytes(activePoint.direct, true)}</span>
            </span>
          </div>
        )}
      </div>

      {/* Bars + gridlines */}
      <div
        className="relative flex items-end"
        style={{ height: height - 52 }}
        onMouseLeave={() => setHovered(null)}
      >
        {/* Subtle horizontal gridlines */}
        <div className="pointer-events-none absolute inset-0 flex flex-col justify-between">
          <div className="border-t border-dashed border-black/[0.07] dark:border-white/[0.08]" />
          <div className="border-t border-dashed border-black/[0.07] dark:border-white/[0.08]" />
          <div className="border-t border-black/[0.08] dark:border-white/[0.10]" />
        </div>

        {/* Columns */}
        <div
          className="relative z-[1] flex h-full w-full items-end"
          style={{ gap: n > 20 ? 3 : n > 10 ? 6 : 12 }}
        >
          {points.map((pt, i) => {
            const isFocus = activeIdx === null || activeIdx === i;
            const pPct = (pt.proxy / maxV) * 100;
            const dPct = (pt.direct / maxV) * 100;
            const isEmpty = pt.total <= 0;

            return (
              <div
                key={i}
                onMouseEnter={() => setHovered(i)}
                onClick={() => setHovered(i)}
                className="group relative flex h-full flex-1 cursor-pointer flex-col justify-end"
                title={`${bucketLabels[i] ?? ''}\n${proxyLabel}: ${formatUsageBytes(pt.proxy)}\n${directLabel}: ${formatUsageBytes(pt.direct)}`}
              >
                {isEmpty ? (
                  <div className="h-[3px] w-full rounded-full bg-black/[0.07] transition-colors group-hover:bg-black/20 dark:bg-white/[0.09] dark:group-hover:bg-white/25" />
                ) : (
                  <div
                    className="flex w-full flex-col justify-end gap-[2px] transition-opacity duration-150"
                    style={{
                      height: '100%',
                      opacity: isFocus ? 1 : 0.42,
                    }}
                  >
                    {pt.direct > 0 && (
                      <div
                        className="w-full rounded-[4px] transition-all duration-300"
                        style={{
                          height: `${Math.max(dPct, 2.5)}%`,
                          backgroundColor: directColor,
                        }}
                      />
                    )}
                    {pt.proxy > 0 && (
                      <div
                        className="w-full rounded-[4px] transition-all duration-300"
                        style={{
                          height: `${Math.max(pPct, 2.5)}%`,
                          backgroundColor: proxyColor,
                        }}
                      />
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* X-axis labels */}
      <div className="relative mt-2 h-4 text-[10.5px] text-muted-foreground tabular-nums">
        {labels.map((label, i) => {
          if (!label) return null;
          const isFirst = i === 0;
          const isLast = i === labels.length - 1;
          const leftPct = ((i + 0.5) / n) * 100;
          return (
            <span
              key={i}
              className={cn(
                'absolute top-0 whitespace-nowrap transition-colors',
                activeIdx === i && 'font-semibold text-foreground',
              )}
              style={
                isFirst
                  ? { left: 0 }
                  : isLast
                    ? { right: 0 }
                    : { left: `${leftPct}%`, transform: 'translateX(-50%)' }
              }
            >
              {label}
            </span>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 7 × 24 Activity Heatmap
// ---------------------------------------------------------------------------

export function UsageHeatmapGrid({
  values,
  rowLabels,
  accentColor,
  compact = false,
  className,
}: {
  values: number[][];
  rowLabels?: string[];
  accentColor: string;
  compact?: boolean;
  className?: string;
}) {
  const [hoveredCell, setHoveredCell] = useState<{ d: number; h: number; v: number } | null>(null);
  const maxV = useMemo(() => {
    let m = 1;
    for (const row of values) {
      for (const v of row) {
        if (v > m) m = v;
      }
    }
    return m;
  }, [values]);

  const floor = compact ? 0.1 : 0.08;

  return (
    <div className={cn('relative flex flex-col', className)}>
      <div className="flex flex-col" style={{ gap: compact ? 2 : 3 }}>
        {Array.from({ length: 7 }, (_, d) => (
          <div key={d} className="flex items-center" style={{ gap: compact ? 2 : 3 }}>
            {rowLabels && rowLabels.length > 0 && (
              <span className="w-5 shrink-0 text-[10px] font-medium text-muted-foreground">
                {rowLabels[d] ?? ''}
              </span>
            )}
            <div className="grid flex-1 grid-cols-24" style={{ gridTemplateColumns: 'repeat(24, minmax(0, 1fr))', gap: compact ? 2 : 3 }}>
              {Array.from({ length: 24 }, (_, h) => {
                const v = values[d]?.[h] ?? 0;
                const intensity = floor + (1 - floor) * (v / maxV);
                const isHovered = hoveredCell?.d === d && hoveredCell?.h === h;
                return (
                  <div
                    key={h}
                    onMouseEnter={() => setHoveredCell({ d, h, v })}
                    onMouseLeave={() => setHoveredCell(null)}
                    className={cn(
                      'w-full transition-transform duration-150',
                      compact ? 'h-[8px] rounded-[2px]' : 'aspect-square rounded-[3px]',
                      isHovered && 'scale-125 ring-1 ring-foreground/40 z-10',
                    )}
                    style={{
                      backgroundColor: accentColor,
                      opacity: intensity,
                    }}
                    title={`${rowLabels?.[d] ?? ''} ${String(h).padStart(2, '0')}:00 · ${formatUsageBytes(v)}`}
                  />
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* Hour axis + live hover readout */}
      <div className={cn('mt-1.5 flex items-center justify-between text-[10px] text-muted-foreground tabular-nums', rowLabels?.length ? 'pl-6' : '')}>
        {hoveredCell && !compact ? (
          <div className="flex w-full items-center justify-between text-[11px] text-foreground">
            <span className="font-medium">
              {rowLabels?.[hoveredCell.d] ?? ''} {String(hoveredCell.h).padStart(2, '0')}:00 – {String((hoveredCell.h + 1) % 24).padStart(2, '0')}:00
            </span>
            <span className="font-semibold tabular-nums">{formatUsageBytes(hoveredCell.v)}</span>
          </div>
        ) : (
          <>
            <span>00</span>
            <span>06</span>
            <span>12</span>
            <span>18</span>
            <span>24</span>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Monthly Daily Bars (for Dashboard Month Card with hover scrubbing)
// ---------------------------------------------------------------------------

export function UsageMonthBars({
  days,
  today,
  accentColor,
  showLabels = true,
  selectedIndex,
  onSelect,
  className,
}: {
  days: number[];
  today: number;
  accentColor: string;
  showLabels?: boolean;
  selectedIndex: number | null;
  onSelect: (index: number | null) => void;
  className?: string;
}) {
  const n = days.length;
  const past = days.slice(0, Math.min(today, n));
  const maxV = Math.max(1, ...past);
  const avg = past.length > 0 ? past.reduce((a, b) => a + b, 0) / past.length : 0;
  const avgBottomPct = (avg / maxV) * 100;
  const ticks = useMemo(() => new Set([1, 8, 15, 22, n]), [n]);

  return (
    <div
      className={cn('flex flex-col select-none', className)}
      onMouseLeave={() => onSelect(null)}
    >
      <div className="relative flex flex-1 items-end gap-[2.5px]">
        {/* Dashed daily average line */}
        {selectedIndex === null && avg > 0 && (
          <div
            className="pointer-events-none absolute inset-x-0 z-10 border-t border-dashed border-foreground/25"
            style={{ bottom: `${Math.min(96, Math.max(6, avgBottomPct))}%` }}
          />
        )}

        {days.map((v, i) => {
          const day = i + 1;
          const isFuture = day > today;
          const isSelected = selectedIndex === i;
          const isToday = day === today;
          const pct = Math.max(10, (v / maxV) * 100);
          const opacity = selectedIndex !== null
            ? (isSelected ? 1 : 0.32)
            : (isToday ? 1 : 0.55);

          return (
            <div
              key={i}
              onMouseEnter={() => {
                if (!isFuture) onSelect(i);
              }}
              className={cn(
                'flex h-full flex-1 flex-col items-center justify-end',
                !isFuture && 'cursor-pointer',
              )}
            >
              {isFuture ? (
                <div className="mb-[1px] size-[3px] rounded-full bg-foreground/20" />
              ) : (
                <div
                  className="w-full rounded-full transition-all duration-150"
                  style={{
                    height: `${pct}%`,
                    backgroundColor: accentColor,
                    opacity,
                  }}
                />
              )}
            </div>
          );
        })}
      </div>

      {showLabels && n > 0 && (
        <div className="mt-1 flex items-center justify-between text-[9.5px] text-muted-foreground tabular-nums">
          {days.map((_, i) => {
            const day = i + 1;
            const visible = ticks.has(day);
            const active = selectedIndex === i || (selectedIndex === null && day === today);
            return (
              <span
                key={i}
                className={cn(
                  'flex-1 text-center',
                  !visible && 'opacity-0',
                  active && 'font-semibold text-foreground',
                )}
              >
                {visible ? day : ''}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 7-Day Smooth Area Trend Curve (with dashed previous week comparison)
// ---------------------------------------------------------------------------

function buildSmoothPath(pts: Array<[number, number]>): string {
  if (pts.length === 0) return '';
  let d = `M ${pts[0][0].toFixed(2)} ${pts[0][1].toFixed(2)}`;
  for (let i = 1; i < pts.length; i++) {
    const [px, py] = pts[i - 1];
    const [x, y] = pts[i];
    const cx = (px + x) / 2;
    d += ` C ${cx.toFixed(2)} ${py.toFixed(2)}, ${cx.toFixed(2)} ${y.toFixed(2)}, ${x.toFixed(2)} ${y.toFixed(2)}`;
  }
  return d;
}

export function UsageTrendAreaChart({
  values,
  previous,
  labels,
  accentColor,
  className,
}: {
  values: number[];
  previous: number[];
  labels: string[];
  accentColor: string;
  className?: string;
}) {
  const gradId = useId();
  const n = values.length;
  if (n < 2) return null;

  const width = 320;
  const height = 72;
  const padX = 8;
  const padTop = 10;
  const padBottom = 6;
  const chartH = height - padTop - padBottom;
  const maxV = Math.max(1, ...values, ...previous) * 1.1;
  const step = (width - padX * 2) / (n - 1);

  const toPt = (i: number, v: number): [number, number] => [
    padX + i * step,
    height - padBottom - (chartH * v) / maxV,
  ];

  const currentPts = values.map((v, i) => toPt(i, v));
  const prevPts = previous.length === n ? previous.map((v, i) => toPt(i, v)) : [];
  const linePath = buildSmoothPath(currentPts);
  const areaPath = `${linePath} L ${currentPts[n - 1][0].toFixed(2)} ${(height - padBottom).toFixed(2)} L ${currentPts[0][0].toFixed(2)} ${(height - padBottom).toFixed(2)} Z`;
  const prevPath = prevPts.length === n && previous.some((v) => v > 0) ? buildSmoothPath(prevPts) : '';
  const lastPt = currentPts[n - 1];

  return (
    <div className={cn('flex flex-col', className)}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="min-h-0 w-full flex-1 overflow-visible"
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={accentColor} stopOpacity="0.28" />
            <stop offset="100%" stopColor={accentColor} stopOpacity="0.01" />
          </linearGradient>
        </defs>
        {prevPath && (
          <path
            d={prevPath}
            fill="none"
            stroke={accentColor}
            strokeOpacity="0.32"
            strokeWidth="1.5"
            strokeDasharray="3 4"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        )}
        <path d={areaPath} fill={`url(#${gradId})`} />
        <path
          d={linePath}
          fill="none"
          stroke={accentColor}
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
        {currentPts.slice(0, -1).map(([x, y], i) => (
          <circle key={i} cx={x} cy={y} r="2.2" fill={accentColor} opacity="0.7" />
        ))}
        <circle cx={lastPt[0]} cy={lastPt[1]} r="7" fill={accentColor} opacity="0.2" />
        <circle cx={lastPt[0]} cy={lastPt[1]} r="3.5" fill={accentColor} />
      </svg>

      {labels.length > 0 && (
        <div className="mt-1 flex items-center justify-between text-[10px] text-muted-foreground">
          {labels.map((label, i) => (
            <span
              key={i}
              className={cn(
                i === labels.length - 1 && 'font-semibold text-foreground',
              )}
            >
              {label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Async OS Process Icon Badge
// ---------------------------------------------------------------------------

export function ProcessIconBadge({
  name,
  path,
  size = 20,
  className,
}: {
  name: string;
  path?: string;
  size?: number;
  className?: string;
}) {
  const key = useMemo(() => processIconKey(path, name), [path, name]);
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    if (!key) {
      setSrc(null);
      return;
    }
    let alive = true;
    void loadProcessIcon(key).then((url) => {
      if (alive) setSrc(url);
    });
    return () => {
      alive = false;
    };
  }, [key]);

  if (src) {
    return (
      <img
        src={src}
        alt=""
        className={cn('shrink-0 rounded-[5px] object-contain', className)}
        style={{ width: size, height: size }}
      />
    );
  }

  return (
    <div
      className={cn(
        'flex shrink-0 items-center justify-center rounded-[6px] bg-black/[0.06] text-muted-foreground dark:bg-white/[0.09]',
        className,
      )}
      style={{ width: size, height: size }}
    >
      <AppWindow style={{ width: Math.round(size * 0.62), height: Math.round(size * 0.62) }} />
    </div>
  );
}
