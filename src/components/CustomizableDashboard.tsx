'use client';

import React, { useState } from 'react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
  DragStartEvent,
  DragOverlay,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  rectSortingStrategy,
} from '@dnd-kit/sortable';
import { useDashboardCards } from '@/hooks/useDashboardCards';
import { DraggableCard } from '@/components/DraggableCard';
import { AddCardDialog } from '@/components/AddCardDialog';
import { useTranslation } from 'react-i18next';
import { DashboardCardType, DashboardCard, resolveCardVariant } from '@/types/dashboard';
import { Card } from '@/components/ui/card';
import { showToast } from '@/components/ui/toast';

// 卡片组件导入
import { ProxyModeCard } from '@/components/dashboard-cards/ControlCards';
import { NetworkControlCard } from '@/components/dashboard-cards/NetworkControlCard';
import { NetworkInfoCard } from '@/components/dashboard-cards/NetworkInfoCard';
import { MediaTestCard } from '@/components/dashboard-cards/MediaTestCard';
import { RouteTraceCard } from '@/components/dashboard-cards/RouteTraceCard';
import { CardHeading } from '@/components/dashboard-cards/CardHeading';
import { NETWORK_METRIC_ICONS } from '@/lib/dashboard-icons';
import { IpAddressCard } from '@/components/dashboard-cards/IpAddressCard';
import { TrafficRankingCard } from '@/components/dashboard-cards/TrafficRankingCard';
import { TrafficStatisticsCard } from '@/components/dashboard-cards/TrafficStatisticsCard';
import { SubscriptionInfoCard } from '@/components/dashboard-cards/SubscriptionInfoCard';
import { RulesOverviewCard } from '@/components/dashboard-cards/RulesOverviewCard';
import { SpeedLinesCard } from '@/components/dashboard-cards/SpeedLinesCard';
import { ConnectivityCheckCard } from '@/components/dashboard-cards/ConnectivityCheckCard';
import { ImageCard } from '@/components/dashboard-cards/ImageCard';

interface CustomizableDashboardProps {
  // Metrics卡片数据
  metrics: Array<{
    label: string;
    value: string;
    icon: React.ReactNode;
    helper?: string;
  }>;

  // 系统代理
  proxyEnabled: boolean;
  isProxyUpdating: boolean;
  onProxyToggle: (checked: boolean) => void;

  // TUN模式
  tunEnabled: boolean;
  isTunUpdating: boolean;
  tunAvailable: boolean;
  isRunning: boolean;
  onTunToggle: (checked: boolean) => void;

  // 代理模式
  proxyMode: 'rule' | 'global' | 'direct' | null;
  isModeUpdating: boolean;
  onModeSwitch: (mode: 'rule' | 'global' | 'direct') => void;

  // 流量图表
  trafficSamples: Array<{
    timestamp: number;
    upSpeed: number;
    downSpeed: number;
  }>;

  // 连接数据 (用于流量排行和流量统计)
  connections: Array<{
    id: string;
    metadata: {
      network: string;
      type: string;
      sourceIP: string;
      destinationIP: string;
      sourcePort: string;
      destinationPort: string;
      host: string;
      process: string;
      processPath: string;
    };
    upload: number;
    download: number;
    start: string;
    chains: string[];
    rule: string;
    rulePayload: string;
  }>;
  uploadTotal: number;
  downloadTotal: number;

  // 编辑模式
  isEditMode: boolean;
  onEditModeChange: (enabled: boolean) => void;
  onAddCard: () => void;
  onReset: () => void;

  // 添加卡片对话框
  showAddDialog: boolean;
  onShowAddDialogChange: (show: boolean) => void;

  // 其他组件
  TrafficChart: React.ComponentType<any>;
}

export function CustomizableDashboard({
  metrics,
  proxyEnabled,
  isProxyUpdating,
  onProxyToggle,
  tunEnabled,
  isTunUpdating,
  tunAvailable,
  isRunning,
  onTunToggle,
  proxyMode,
  isModeUpdating,
  onModeSwitch,
  trafficSamples,
  connections,
  uploadTotal,
  downloadTotal,
  isEditMode,
  onEditModeChange,
  onAddCard,
  onReset,
  showAddDialog,
  onShowAddDialogChange,
  TrafficChart,
}: CustomizableDashboardProps) {
  const { t } = useTranslation();
  const {
    cards,
    reorderCards,
    addCard,
    removeCard,
  } = useDashboardCards();

  const [activeId, setActiveId] = useState<string | null>(null);

  // 配置拖拽传感器 - 增加激活距离避免误触
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 10,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(event.active.id as string);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;

    if (over && active.id !== over.id) {
      const oldIndex = cards.findIndex((card) => card.id === active.id);
      const newIndex = cards.findIndex((card) => card.id === over.id);

      if (oldIndex !== -1 && newIndex !== -1) {
        reorderCards(oldIndex, newIndex);
      }
    }

    setActiveId(null);
  };

  const handleDragCancel = () => {
    setActiveId(null);
  };

  // 获取单个指标卡片
  const getMetricCard = (index: number) => {
    if (!metrics[index]) return null;
    const metric = metrics[index];
    return (
      <Card
        data-hoverable="false"
        className="dashboard-card dashboard-half-card flex flex-col p-card transition-all hover:shadow-md"
      >
        <div className="flex h-6 shrink-0 items-center justify-between gap-2">
          <CardHeading type="network-info" icon={NETWORK_METRIC_ICONS[index]}>
            {metric.label}
          </CardHeading>
        </div>
        <div className="flex min-h-0 flex-1 flex-col justify-center gap-1">
          <div className="truncate text-2xl font-semibold leading-7 text-foreground tabular-nums">{metric.value}</div>
          <div className="truncate text-xs leading-4 text-muted-foreground">{metric.helper}</div>
        </div>
      </Card>
    );
  };

  // 渲染卡片内容；variant 为尺寸变体 id，缺省时使用默认尺寸；preview 为小组件库中的只读预览
  const renderCardContent = (
    type: DashboardCardType,
    variant?: string,
    options: { cardId?: string; preview?: boolean } = {},
  ) => {
    const { cardId = type, preview = false } = options;
    const variantId = resolveCardVariant(type, variant).id;
    switch (type) {
      case 'network-info': {
        const metricIndex = ['connections', 'download', 'upload', 'total'].indexOf(variantId);
        return metricIndex >= 0 ? getMetricCard(metricIndex) : <NetworkInfoCard metrics={metrics} />;
      }

      case 'network-control':
        return (
          <NetworkControlCard
            proxyEnabled={preview ? true : proxyEnabled}
            proxyUpdating={isProxyUpdating}
            onProxyToggle={onProxyToggle}
            tunEnabled={preview ? false : tunEnabled}
            tunUpdating={isTunUpdating}
            tunAvailable={preview || tunAvailable}
            isRunning={preview || isRunning}
            onTunToggle={onTunToggle}
            preview={preview}
          />
        );

      case 'proxy-mode':
        return (
          <ProxyModeCard
            mode={proxyMode}
            updating={isModeUpdating}
            onModeSwitch={onModeSwitch}
          />
        );

      case 'ip-address':
        return <IpAddressCard />;

      case 'traffic-chart':
        if (variantId !== 'large') {
          return <SpeedLinesCard samples={trafficSamples} preview={preview} fullWidth={variantId === 'standard'} />;
        }
        return (
          <div className="dashboard-card dashboard-large-card flex flex-col space-y-3 p-card">
            <CardHeading type="traffic-chart">{t('dashboard.speedLines.title')}</CardHeading>
            <TrafficChart samples={trafficSamples} />
          </div>
        );

      case 'traffic-ranking':
        return (
          <TrafficRankingCard connections={connections} />
        );

      case 'traffic-statistics':
        return <TrafficStatisticsCard />;

      case 'subscription-info':
        return <SubscriptionInfoCard variant={variantId} preview={preview} />;

      case 'rules-overview':
        return <RulesOverviewCard />;

      case 'connectivity-check':
        return <ConnectivityCheckCard variant={variantId} preview={preview} />;
      case 'media-test':
        return <MediaTestCard variant={variantId} preview={preview} />;
      case 'route-trace':
        return <RouteTraceCard variant={variantId} preview={preview} editing={isEditMode} />;

      case 'image':
        return <ImageCard cardId={cardId} variant={variantId} preview={preview} />;

      default:
        return null;
    }
  };

  // 标准全宽与半宽占一行，超大全宽占两列两行
  const getCardLayoutClass = (card: DashboardCard) => {
    const variant = resolveCardVariant(card.type, card.variant);
    if (variant.size === 'large-full') return 'md:col-span-2 row-span-2 dashboard-large-slot';
    if (variant.size === 'full') return 'md:col-span-2 dashboard-full-slot';
    return 'col-span-1 dashboard-half-slot';
  };

  const activeCard = activeId ? cards.find((card) => card.id === activeId) : null;

  return (
    <>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <SortableContext items={cards.map((c) => c.id)} strategy={rectSortingStrategy}>
          <div className="grid auto-rows-[var(--card-half-height)] grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
            {cards.map((card) => (
              <DraggableCard
                key={card.id}
                id={card.id}
                isEditMode={isEditMode}
                enabled={card.enabled}
                onRemove={() => removeCard(card.id)}
                className={getCardLayoutClass(card)}
              >
                {renderCardContent(card.type, card.variant, { cardId: card.id })}
              </DraggableCard>
            ))}
          </div>
        </SortableContext>

        <DragOverlay
          adjustScale={false}
          dropAnimation={{
            duration: 200,
            easing: 'cubic-bezier(0.25, 1, 0.5, 1)',
          }}
        >
          {activeCard ? (
            <div
              className="cursor-grabbing opacity-90"
              style={{
                transform: 'scale(1.05)',
              }}
            >
              {renderCardContent(activeCard.type, activeCard.variant, { cardId: activeCard.id })}
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      {/* 添加卡片对话框 */}
      <AddCardDialog
        open={showAddDialog}
        onOpenChange={onShowAddDialogChange}
        cards={cards}
        onAddCard={(type, variantId) => {
          addCard(type, variantId);
          onShowAddDialogChange(false);
          showToast({ message: t('dashboard.widgetLibrary.added'), type: 'success' });
        }}
        renderCardPreview={(type, variant) => renderCardContent(type, variant, { preview: true })}
      />
    </>
  );
}
