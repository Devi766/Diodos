// 卡片类型定义
export type DashboardCardType =
  | 'network-info' // 网络概览与独立指标
  | 'network-control' // 系统代理与 TUN 接管
  | 'proxy-mode' // 代理模式
  | 'ip-address' // IP地址
  | 'traffic-chart' // 流量图表
  | 'traffic-ranking' // 流量排行
  | 'traffic-statistics' // 流量统计
  | 'subscription-info' // 订阅信息
  | 'rules-overview' // 规则统计
  | 'connectivity-check' // 连通性检查
  | 'media-test' // 媒体服务测试
  | 'route-trace' // 路由跟踪
  | 'image'; // 图片

// 卡片在网格中占全宽（两列）还是半宽（一列，两张拼成一个全宽位）
export type DashboardCardWidth = 'full' | 'half';
export type DashboardCardSize = 'half' | 'full' | 'large-full';

// 卡片的一种尺寸
export interface DashboardCardVariant {
  id: string;
  width: DashboardCardWidth;
  // 标准全宽与半宽同高，超大全宽占两行
  size: DashboardCardSize;
  // 尺寸名称的 i18n key；卡片只有一种尺寸时不显示
  nameKey: string;
}

// 每种卡片的元数据：名称、描述与可选尺寸（第一个为默认尺寸）
export interface DashboardCardDefinition {
  type: DashboardCardType;
  titleKey: string;
  descriptionKey: string;
  variants: DashboardCardVariant[];
}

// 卡片配置项
// id 为卡片类型（本体）或「类型#8位随机串」（副本），同一类型可以添加多张
export interface DashboardCard {
  id: string;
  type: DashboardCardType;
  enabled: boolean;
  order: number;
  variant?: string;
}

const STANDARD_HALF: DashboardCardVariant[] = [
  { id: 'standard', width: 'half', size: 'half', nameKey: 'dashboard.widgetLibrary.sizeHalf' },
];

const LARGE_FULL: DashboardCardVariant[] = [
  { id: 'standard', width: 'full', size: 'large-full', nameKey: 'dashboard.widgetLibrary.sizeExtraLargeFull' },
];

const variant = (
  id: string,
  width: DashboardCardWidth,
  nameKey: string,
  large = false,
): DashboardCardVariant => ({ id, width, nameKey: `dashboard.widgetLibrary.${nameKey}`, size: width === 'half' ? 'half' : large ? 'large-full' : 'full' });

const defineCard = (
  type: DashboardCardType,
  variants: DashboardCardVariant[],
): DashboardCardDefinition => ({
  type,
  titleKey: `dashboard.cardMeta.${type}.title`,
  descriptionKey: `dashboard.cardMeta.${type}.description`,
  variants,
});

// 卡片注册表，顺序即小组件库中的展示顺序
export const DASHBOARD_CARD_DEFINITIONS: DashboardCardDefinition[] = [
  defineCard('network-info', [
    variant('standard', 'full', 'sizeOverview'),
    variant('connections', 'half', 'metricConnections'),
    variant('download', 'half', 'metricDownload'),
    variant('upload', 'half', 'metricUpload'),
    variant('total', 'half', 'metricTotal'),
  ]),
  defineCard('traffic-chart', [
    variant('standard', 'full', 'sizeFull'),
    variant('speed', 'half', 'sizeHalf'),
    variant('large', 'full', 'sizeExtraLargeFull', true),
  ]),
  defineCard('connectivity-check', [
    variant('grid', 'full', 'sizeFull'),
    variant('small', 'half', 'sizeSmall'),
    variant('list', 'full', 'sizeList', true),
  ]),
  defineCard('media-test', [
    variant('standard', 'full', 'sizeFull'),
    variant('small', 'half', 'sizeHalf'),
  ]),
  defineCard('route-trace', [
    variant('standard', 'full', 'sizeExtraLargeFull', true),
    variant('full', 'full', 'sizeFull'),
    variant('small', 'half', 'sizeHalf'),
  ]),
  defineCard('network-control', STANDARD_HALF),
  defineCard('proxy-mode', STANDARD_HALF),
  defineCard('ip-address', STANDARD_HALF),
  defineCard('traffic-ranking', LARGE_FULL),
  defineCard('traffic-statistics', LARGE_FULL),
  defineCard('subscription-info', [
    variant('standard', 'full', 'sizeFull'),
    variant('immersive', 'half', 'sizeImmersive'),
    variant('large', 'full', 'sizeExtraLargeFull', true),
  ]),
  defineCard('rules-overview', LARGE_FULL),
  defineCard('image', [
    variant('large', 'full', 'sizeLarge', true),
    variant('medium', 'half', 'sizeMedium'),
  ]),
];

const DEFINITION_MAP = new Map(
  DASHBOARD_CARD_DEFINITIONS.map((definition) => [definition.type, definition]),
);

export const isDashboardCardType = (value: unknown): value is DashboardCardType =>
  typeof value === 'string' && DEFINITION_MAP.has(value as DashboardCardType);

export const getCardDefinition = (type: DashboardCardType): DashboardCardDefinition =>
  DEFINITION_MAP.get(type)!;

// 返回卡片实际使用的尺寸；未知或缺失时回落到默认尺寸
export const resolveCardVariant = (
  type: DashboardCardType,
  variantId?: string,
): DashboardCardVariant => {
  const { variants } = getCardDefinition(type);
  return variants.find((variant) => variant.id === variantId) ?? variants[0];
};

// 多实例：本体 id 即类型，副本 id 为「类型#8位随机串」
const COPY_SEPARATOR = '#';
const COPY_SUFFIX_PATTERN = /^[a-z0-9]{8}$/;

export const cardBaseId = (cardId: string) => cardId.split(COPY_SEPARATOR)[0];

export const isCardCopyId = (cardId: string) => cardId.includes(COPY_SEPARATOR);

export const isValidCardId = (cardId: string, type: DashboardCardType) => {
  if (cardId === type) return true;
  const separatorIndex = cardId.indexOf(COPY_SEPARATOR);
  if (separatorIndex < 0 || cardId.slice(0, separatorIndex) !== type) return false;
  return COPY_SUFFIX_PATTERN.test(cardId.slice(separatorIndex + 1));
};

export const newCardCopyId = (type: DashboardCardType) => {
  let suffix = '';
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
  }
  while (suffix.length < 8) {
    suffix += Math.random().toString(36).slice(2);
  }
  return `${type}${COPY_SEPARATOR}${suffix.slice(0, 8).toLowerCase()}`;
};

// 旧版本保存的卡片 id，加载时映射为对应的类型 id
export const LEGACY_CARD_IDS: Record<string, DashboardCardType> = {
  'proxy-mode-card': 'proxy-mode',
  'ip-address-card': 'ip-address',
  'traffic-chart-card': 'traffic-chart',
  'traffic-ranking-card': 'traffic-ranking',
  'traffic-statistics-card': 'traffic-statistics',
  'subscription-info-card': 'subscription-info',
  'rules-overview-card': 'rules-overview',
};

// 将旧接管卡片合并到最靠前的启用位置；已保存的新卡片优先，删除后不自动恢复
export const migrateLegacyControlCards = (entries: unknown[]): unknown[] => {
  const isRecord = (entry: unknown): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object');
  const isLegacy = (entry: unknown): entry is Record<string, unknown> => {
    if (!isRecord(entry) || (entry.type !== 'system-proxy' && entry.type !== 'tun-mode')) return false;
    if (typeof entry.id !== 'string' || typeof entry.enabled !== 'boolean' || !Number.isFinite(entry.order)) return false;
    return entry.id === `${entry.type}-card` || entry.id === entry.type
      || (entry.id.startsWith(`${entry.type}#`) && /^[a-z0-9]{8}$/.test(entry.id.slice(entry.type.length + 1)));
  };
  const oldCards = entries.filter(isLegacy);
  if (!oldCards.length) return entries;
  const remaining = entries.filter(entry => !isLegacy(entry));
  if (remaining.some(entry => isRecord(entry) && entry.type === 'network-control'
    && typeof entry.id === 'string' && isValidCardId(entry.id, 'network-control')
    && typeof entry.enabled === 'boolean' && Number.isFinite(entry.order))) return remaining;
  const enabled = oldCards.filter(card => card.enabled);
  return [...remaining, {
    id: 'network-control', type: 'network-control', enabled: enabled.length > 0,
    order: Math.min(...(enabled.length ? enabled : oldCards).map(card => card.order as number)),
  }];
};

const defaultCard = (type: DashboardCardType, order: number, enabled: boolean): DashboardCard => ({
  id: type,
  type,
  enabled,
  order,
});

// 旧指标本体合并为网络概览，显式添加的副本保留为对应子卡片
export const migrateLegacyMetricCards = (entries: unknown[]): unknown[] => {
  const variants: Record<string, string> = {
    'metric-connections': 'connections', 'metric-download': 'download',
    'metric-upload': 'upload', 'metric-total': 'total',
  };
  const valid = (entry: unknown): entry is Record<string, unknown> => {
    if (!entry || typeof entry !== 'object') return false;
    const card = entry as Record<string, unknown>;
    if (typeof card.type !== 'string' || !variants[card.type] || typeof card.id !== 'string'
      || typeof card.enabled !== 'boolean' || !Number.isFinite(card.order)) return false;
    return card.id === card.type || (card.id.startsWith(`${card.type}#`) && /^[a-z0-9]{8}$/.test(card.id.slice(card.type.length + 1)));
  };
  const old = entries.filter(valid);
  if (!old.length) return entries;
  const remaining = entries.filter(entry => !valid(entry));
  const hasNew = remaining.some(entry => {
    if (!entry || typeof entry !== 'object') return false;
    const card = entry as Record<string, unknown>;
    return card.type === 'network-info' && typeof card.id === 'string' && isValidCardId(card.id, 'network-info')
      && typeof card.enabled === 'boolean' && Number.isFinite(card.order);
  });
  const bases = old.filter(card => card.id === card.type);
  if (!hasNew && bases.length) {
    const enabled = bases.filter(card => card.enabled);
    remaining.push({ id: 'network-info', type: 'network-info', enabled: enabled.length > 0,
      order: Math.min(...(enabled.length ? enabled : bases).map(card => card.order as number)) });
  }
  const ids = new Set(remaining.map(entry => (entry as Record<string, unknown> | null)?.id));
  for (const card of old.filter(card => card.id !== card.type && card.enabled)) {
    let hash = 2166136261;
    // 生成稳定副本 id，不让不同指标的相同旧后缀发生碰撞
    const seed = `${card.type}:${card.id}`;
    for (const char of seed) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
    let id = `network-info#${hash.toString(16).padStart(8, '0')}`;
    while (ids.has(id)) {
      hash = (hash + 1) >>> 0;
      id = `network-info#${hash.toString(16).padStart(8, '0')}`;
    }
    ids.add(id);
    remaining.push({ ...card, id, type: 'network-info', variant: variants[card.type as string] });
  }
  return remaining;
};

// 默认卡片配置
export const DEFAULT_DASHBOARD_CARDS: DashboardCard[] = [
  defaultCard('network-info', 0, true),
  defaultCard('network-control', 4, true),
  defaultCard('proxy-mode', 6, true),
  defaultCard('ip-address', 7, true),
  defaultCard('traffic-chart', 8, true),
  defaultCard('traffic-ranking', 9, false),
  defaultCard('traffic-statistics', 10, false),
  defaultCard('subscription-info', 11, false),
  defaultCard('rules-overview', 12, false),
  defaultCard('connectivity-check', 13, false),
  defaultCard('image', 14, false),
  defaultCard('media-test', 15, false),
  defaultCard('route-trace', 16, false),
];

// 卡片配置的本地存储key
export const DASHBOARD_CONFIG_KEY = 'flyClash-dashboard-config';
