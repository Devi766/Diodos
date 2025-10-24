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
import { DashboardCardType, DashboardCard } from '@/types/dashboard';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

// 卡片组件导入
import { SystemProxyCard, TunModeCard, ProxyModeCard } from '@/components/dashboard-cards/ControlCards';
import { TrafficRankingCard } from '@/components/dashboard-cards/TrafficRankingCard';
import { TrafficStatisticsCard } from '@/components/dashboard-cards/TrafficStatisticsCard';

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
  const {
    cards,
    availableCards,
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
        className="rounded-3xl bg-white p-5 shadow-sm transition-all hover:shadow-md dark:bg-[#2a2a2a]"
      >
        <div className="flex items-center justify-between">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {metric.label}
          </div>
          {metric.icon}
        </div>
        <div className="mt-3 text-2xl font-semibold text-foreground">{metric.value}</div>
        <div className="mt-1 text-xs text-muted-foreground">{metric.helper}</div>
      </Card>
    );
  };

  // 渲染卡片内容
  const renderCardContent = (type: DashboardCardType) => {
    switch (type) {
      case 'metric-connections':
        return getMetricCard(0);

      case 'metric-download':
        return getMetricCard(1);

      case 'metric-upload':
        return getMetricCard(2);

      case 'metric-total':
        return getMetricCard(3);

      case 'system-proxy':
        return (
          <SystemProxyCard
            enabled={proxyEnabled}
            updating={isProxyUpdating}
            onToggle={onProxyToggle}
          />
        );

      case 'tun-mode':
        return (
          <TunModeCard
            enabled={tunEnabled}
            updating={isTunUpdating}
            available={tunAvailable}
            onToggle={onTunToggle}
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

      case 'traffic-chart':
        return (
          <div className="flex h-[260px] flex-col space-y-5 rounded-3xl bg-white p-6 shadow-sm dark:bg-[#2a2a2a]">
            <TrafficChart samples={trafficSamples} />
          </div>
        );

      case 'traffic-ranking':
        return (
          <TrafficRankingCard connections={connections} />
        );

      case 'traffic-statistics':
        return <TrafficStatisticsCard />;

      default:
        return null;
    }
  };

  // 根据卡片类型返回布局类名
  const getCardLayoutClass = (type: DashboardCardType) => {
    // 指标卡片：4列网格中的1列
    if (type.startsWith('metric-')) {
      return 'col-span-1';
    }
    // 系统代理和TUN模式：占一半宽度（在2列以上时是2列，在4列时是2列）
    if (type === 'system-proxy' || type === 'tun-mode') {
      return 'md:col-span-1 xl:col-span-2';
    }
    // 代理模式：占一半宽度（在2列以上时占2列）
    if (type === 'proxy-mode') {
      return 'md:col-span-1 xl:col-span-2';
    }
    // 流量图表：占一半宽度
    if (type === 'traffic-chart') {
      return 'md:col-span-1 xl:col-span-2';
    }
    // 流量排行：占一半宽度
    if (type === 'traffic-ranking') {
      return 'md:col-span-1 xl:col-span-2';
    }
    // 流量统计：占一半宽度
    if (type === 'traffic-statistics') {
      return 'md:col-span-1 xl:col-span-2';
    }
    return '';
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
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
            {cards.map((card) => (
              <DraggableCard
                key={card.id}
                id={card.id}
                isEditMode={isEditMode}
                enabled={card.enabled}
                onRemove={() => removeCard(card.id)}
                className={getCardLayoutClass(card.type)}
              >
                {renderCardContent(card.type)}
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
              {renderCardContent(activeCard.type)}
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      {/* 添加卡片对话框 */}
      <AddCardDialog
        open={showAddDialog}
        onOpenChange={onShowAddDialogChange}
        availableCards={availableCards}
        onAddCard={(card) => {
          addCard(card);
          onShowAddDialogChange(false);
        }}
        renderCardPreview={renderCardContent}
      />
    </>
  );
}
