import { Activity, ArrowDown, ArrowUp, BarChart3, CloudDownload, Gauge, Globe, Image, Layers, Network, PieChart, Route, Scale, Tv, Wifi, type LucideIcon } from 'lucide-react';
import type { DashboardCardType } from '@/types/dashboard';

// 仪表盘和小组件库共用同一套卡片图标
export const DASHBOARD_CARD_ICONS: Record<DashboardCardType, LucideIcon> = {
  'network-info': Activity,
  'network-control': Network,
  'proxy-mode': Layers,
  'ip-address': Globe,
  'traffic-chart': Gauge,
  'traffic-ranking': BarChart3,
  'traffic-statistics': PieChart,
  'subscription-info': CloudDownload,
  'rules-overview': Scale,
  'connectivity-check': Wifi,
  'media-test': Tv,
  'route-trace': Route,
  image: Image,
};
export const NETWORK_METRIC_ICONS = [Activity, ArrowDown, ArrowUp, Gauge] as const;
