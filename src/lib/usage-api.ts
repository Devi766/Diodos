export type UsageRange = 'day' | 'week' | 'month' | 'year';

export const USAGE_DIM = {
  SITE: 1,
  HOST: 2,
  APP: 3,
  NODE: 4,
  GROUP: 5,
  RULE: 6,
} as const;

export type UsageDim = (typeof USAGE_DIM)[keyof typeof USAGE_DIM];

export interface UsageTotals {
  up: number;
  down: number;
  proxy: number;
  direct: number;
  total: number;
}

export interface UsagePoint {
  proxy: number;
  direct: number;
  total: number;
}

export interface UsageRankItem {
  name: string;
  up: number;
  down: number;
  total: number;
  proxyBytes: number;
  mostlyProxy: boolean;
  extra: string;
  hits: number;
  subCount: number;
}

export interface UsageSettings {
  enabled: boolean;
  detail: boolean;
  retentionDays: number;
}

export interface UsagePeriod {
  startMs: number;
  endMs: number;
  buckets: number;
}

export interface UsageSnapshot {
  totals: UsageTotals;
  series: UsagePoint[];
  heat: number[][];
  ranking: UsageRankItem[];
  settings: UsageSettings;
  period: UsagePeriod;
}

export interface TodayWidgetData {
  today: UsageTotals;
  yesterdaySameTime: number;
}

export interface MonthWidgetData {
  days: number[];
  today: number;
  monthStartMs: number;
}

export interface TrendWidgetData {
  days: number[];
  previous: number[];
  startMs: number;
}

export interface RankWidgetData {
  items: UsageRankItem[];
}

export interface HeatmapWidgetData {
  heat: number[][];
}

export const USAGE_GROUP_PALETTE = [
  '#FF453A',
  '#FF9F0A',
  '#30D158',
  '#38BDF8',
  '#BF5AF2',
  '#FFD60A',
  '#FF6482',
  '#6366F1',
] as const;

export function formatUsageBytes(value: number, compact = false): string {
  const v = Math.max(0, Number.isFinite(value) ? value : 0);
  const sep = compact ? '' : ' ';
  const GB = 1024 * 1024 * 1024;
  const MB = 1024 * 1024;
  const KB = 1024;

  if (v >= GB * 100) return `${(v / GB).toFixed(0)}${sep}GB`;
  if (v >= GB * 10) return `${(v / GB).toFixed(1)}${sep}GB`;
  if (v >= GB) return `${(v / GB).toFixed(2)}${sep}GB`;
  if (v >= MB) return `${(v / MB).toFixed(0)}${sep}MB`;
  if (v >= KB) return `${(v / KB).toFixed(0)}${sep}KB`;
  return `${Math.round(v)}${sep}B`;
}

export function splitUsageBytes(value: number): { num: string; unit: string } {
  const formatted = formatUsageBytes(value, false);
  const idx = formatted.lastIndexOf(' ');
  if (idx > 0) {
    return { num: formatted.slice(0, idx), unit: formatted.slice(idx + 1) };
  }
  return { num: formatted, unit: '' };
}

export function nextUsageRange(range: UsageRange): UsageRange {
  const order: UsageRange[] = ['day', 'week', 'month', 'year'];
  return order[(order.indexOf(range) + 1) % order.length];
}

export function emptyUsageSnapshot(range: UsageRange, offset = 0): UsageSnapshot {
  const now = new Date();
  let start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  let buckets = 24;
  let end = start + 86_400_000;
  if (range === 'week') {
    const dow = (now.getDay() + 6) % 7;
    start = start - dow * 86_400_000 + offset * 7 * 86_400_000;
    end = start + 7 * 86_400_000;
    buckets = 7;
  } else if (range === 'month') {
    const d = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    start = d.getTime();
    const n = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    end = n.getTime();
    buckets = Math.round((end - start) / 86_400_000);
  } else if (range === 'year') {
    const y = now.getFullYear() + offset;
    start = new Date(y, 0, 1).getTime();
    end = new Date(y + 1, 0, 1).getTime();
    buckets = 12;
  } else {
    start += offset * 86_400_000;
    end = start + 86_400_000;
  }
  return {
    totals: { up: 0, down: 0, proxy: 0, direct: 0, total: 0 },
    series: Array.from({ length: buckets }, () => ({ proxy: 0, direct: 0, total: 0 })),
    heat: Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0)),
    ranking: [],
    settings: { enabled: true, detail: true, retentionDays: 30 },
    period: { startMs: start, endMs: end, buckets },
  };
}

export async function queryUsageSnapshot(params: {
  range: UsageRange;
  offset: number;
  rankDim: UsageDim;
  rankLimit: number;
}): Promise<UsageSnapshot> {
  const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
  if (!api?.usageQuerySnapshot) {
    return emptyUsageSnapshot(params.range, params.offset);
  }
  const res = await api.usageQuerySnapshot(params);
  if (res?.success && res.data) {
    return res.data as UsageSnapshot;
  }
  return emptyUsageSnapshot(params.range, params.offset);
}

export async function queryUsageWidget<T = unknown>(
  kind: 'today' | 'month' | 'trend' | 'destinations' | 'apps' | 'nodes' | 'heatmap',
  range: UsageRange = 'day',
): Promise<T | null> {
  const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
  if (!api?.usageQueryWidget) return null;
  const res = await api.usageQueryWidget({ kind, range });
  if (res?.success && res.data) {
    return res.data as T;
  }
  return null;
}

export async function updateUsageSettings(
  patch: Partial<UsageSettings>,
): Promise<UsageSettings | null> {
  const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
  if (!api?.usageUpdateSettings) return null;
  const res = await api.usageUpdateSettings(patch);
  if (res?.success && res.data) {
    return res.data as UsageSettings;
  }
  return null;
}

export async function clearUsageData(): Promise<boolean> {
  const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
  if (!api?.usageClear) return false;
  const res = await api.usageClear();
  return Boolean(res?.success);
}

// ---------------------------------------------------------------------------
// Realistic sample data for Widget Library previews
// ---------------------------------------------------------------------------

const MB = 1024 * 1024;
const GB = 1024 * MB;

export function sampleTodayWidget(): TodayWidgetData {
  return {
    today: {
      up: 412 * MB,
      down: 3092 * MB,
      proxy: 2672 * MB,
      direct: 832 * MB,
      total: 3504 * MB,
    },
    yesterdaySameTime: 3050 * MB,
  };
}

export function sampleMonthWidget(): MonthWidgetData {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const today = Math.min(Math.max(now.getDate(), 12), daysInMonth);
  const pattern = [6, 8, 5, 9, 7, 11, 12, 6, 7, 8, 9, 13, 10, 6, 8, 7, 9, 12];
  const days = Array.from({ length: daysInMonth }, (_, i) =>
    i < today ? pattern[i % pattern.length] * 700 * MB : 0,
  );
  return { days, today, monthStartMs: start };
}

export function sampleTrendWidget(): TrendWidgetData {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return {
    days: [2.7, 2.5, 3.1, 2.3, 3.7, 3.8, 3.4].map((v) => Math.round(v * GB)),
    previous: [2.8, 2.5, 3.1, 2.9, 3.1, 3.3, 3.1].map((v) => Math.round(v * GB)),
    startMs: todayStart - 6 * 86_400_000,
  };
}

export function sampleDestinationsWidget(): RankWidgetData {
  const rows: Array<[string, number]> = [
    ['YouTube', 980],
    ['国内服务', 830],
    ['Netflix', 620],
    ['ChatGPT', 310],
    ['Telegram', 240],
    ['GitHub', 180],
  ];
  return {
    items: rows.map(([name, mb]) => ({
      name,
      up: Math.round(mb * 0.12 * MB),
      down: Math.round(mb * 0.88 * MB),
      total: mb * MB,
      proxyBytes: name === '国内服务' ? 0 : mb * MB,
      mostlyProxy: name !== '国内服务',
      extra: '',
      hits: Math.round(mb / 4),
      subCount: 0,
    })),
  };
}

export function sampleAppsWidget(): RankWidgetData {
  const rows: Array<[string, number]> = [
    ['chrome.exe', 1239],
    ['Telegram.exe', 430],
    ['Code.exe', 379],
    ['Spotify.exe', 212],
    ['Discord.exe', 160],
  ];
  return {
    items: rows.map(([name, mb]) => ({
      name,
      up: Math.round(mb * 0.14 * MB),
      down: Math.round(mb * 0.86 * MB),
      total: mb * MB,
      proxyBytes: Math.round(mb * 0.85 * MB),
      mostlyProxy: true,
      extra: '',
      hits: Math.round(mb / 3),
      subCount: 0,
    })),
  };
}

export function sampleNodesWidget(): RankWidgetData {
  const rows: Array<[string, number]> = [
    ['香港 IEPL 01', 1352],
    ['东京 02', 727],
    ['新加坡 01', 594],
    ['洛杉矶 03', 410],
    ['台北 02', 288],
  ];
  return {
    items: rows.map(([name, mb]) => ({
      name,
      up: Math.round(mb * 0.15 * MB),
      down: Math.round(mb * 0.85 * MB),
      total: mb * MB,
      proxyBytes: mb * MB,
      mostlyProxy: true,
      extra: '',
      hits: Math.round(mb / 5),
      subCount: 0,
    })),
  };
}

export function sampleHeatmapWidget(): HeatmapWidgetData {
  const base = [
    0.15, 0.08, 0.05, 0.03, 0.03, 0.05, 0.12, 0.3, 0.5, 0.45, 0.4, 0.45,
    0.6, 0.5, 0.42, 0.45, 0.5, 0.55, 0.62, 0.72, 0.85, 0.97, 0.9, 0.55,
  ];
  const heat = Array.from({ length: 7 }, (_, d) =>
    Array.from({ length: 24 }, (_, h) =>
      Math.round(base[h] * (d >= 5 ? 1.12 : 1.0) * (0.85 + (((d * 7 + h * 13) % 10) / 40)) * 400 * MB),
    ),
  );
  return { heat };
}
