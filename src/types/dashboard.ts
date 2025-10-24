// 卡片类型定义
export type DashboardCardType =
  | 'metric-connections' // 活跃连接
  | 'metric-download' // 下载速度
  | 'metric-upload' // 上传速度
  | 'metric-total' // 总流量
  | 'system-proxy' // 系统代理
  | 'tun-mode' // TUN模式
  | 'proxy-mode' // 代理模式
  | 'traffic-chart' // 流量图表
  | 'traffic-ranking' // 流量排行
  | 'traffic-statistics'; // 流量统计

// 卡片配置项
export interface DashboardCard {
  id: string;
  type: DashboardCardType;
  title: string;
  description: string;
  enabled: boolean;
  order: number;
}

// 默认卡片配置
export const DEFAULT_DASHBOARD_CARDS: DashboardCard[] = [
  {
    id: 'metric-connections',
    type: 'metric-connections',
    title: '活跃连接',
    description: '实时连接数',
    enabled: true,
    order: 0,
  },
  {
    id: 'metric-download',
    type: 'metric-download',
    title: '下载速度',
    description: '当前下载速度',
    enabled: true,
    order: 1,
  },
  {
    id: 'metric-upload',
    type: 'metric-upload',
    title: '上传速度',
    description: '当前上传速度',
    enabled: true,
    order: 2,
  },
  {
    id: 'metric-total',
    type: 'metric-total',
    title: '总流量',
    description: '累计流量统计',
    enabled: true,
    order: 3,
  },
  {
    id: 'system-proxy-card',
    type: 'system-proxy',
    title: '系统代理',
    description: '切换系统级别代理',
    enabled: true,
    order: 4,
  },
  {
    id: 'tun-mode-card',
    type: 'tun-mode',
    title: 'TUN 模式',
    description: '虚拟网卡模式(需要管理员权限)',
    enabled: true,
    order: 5,
  },
  {
    id: 'proxy-mode-card',
    type: 'proxy-mode',
    title: '代理模式',
    description: '切换规则/全局/直连模式',
    enabled: true,
    order: 6,
  },
  {
    id: 'traffic-chart-card',
    type: 'traffic-chart',
    title: '流量图表',
    description: '实时流量监控图表',
    enabled: true,
    order: 7,
  },
  {
    id: 'traffic-ranking-card',
    type: 'traffic-ranking',
    title: '流量排行',
    description: '按进程/域名/策略统计流量排行',
    enabled: false,
    order: 8,
  },
  {
    id: 'traffic-statistics-card',
    type: 'traffic-statistics',
    title: '流量统计',
    description: '总流量和连接统计信息',
    enabled: false,
    order: 9,
  },
];

// 卡片配置的本地存储key
export const DASHBOARD_CONFIG_KEY = 'flyClash-dashboard-config';
