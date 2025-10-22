import React from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Plus, Activity, Wifi, Shield, BarChart3, Info, Cpu } from 'lucide-react';
import { DashboardCard, DashboardCardType } from '@/types/dashboard';
import { cn } from '@/lib/utils';

interface AddCardDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  availableCards: DashboardCard[];
  onAddCard: (card: DashboardCard) => void;
}

// 卡片图标映射
const CARD_ICONS: Record<DashboardCardType, React.ReactNode> = {
  'metric-connections': <Activity className="h-6 w-6" />,
  'metric-download': <Activity className="h-6 w-6" />,
  'metric-upload': <Activity className="h-6 w-6" />,
  'metric-total': <Activity className="h-6 w-6" />,
  'system-proxy': <Wifi className="h-6 w-6" />,
  'tun-mode': <Shield className="h-6 w-6" />,
  'proxy-mode': <BarChart3 className="h-6 w-6" />,
  'traffic-chart': <BarChart3 className="h-6 w-6" />,
};

export function AddCardDialog({
  open,
  onOpenChange,
  availableCards,
  onAddCard,
}: AddCardDialogProps) {
  const handleAddCard = (card: DashboardCard) => {
    onAddCard(card);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>添加卡片</DialogTitle>
          <DialogDescription>
            选择要添加到控制面板的卡片
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 py-4 md:grid-cols-2">
          {availableCards.length === 0 ? (
            <div className="col-span-2 rounded-lg border border-dashed p-8 text-center">
              <p className="text-sm text-muted-foreground">
                所有卡片已添加
              </p>
            </div>
          ) : (
            availableCards.map((card) => (
              <button
                key={card.id}
                onClick={() => handleAddCard(card)}
                className={cn(
                  'group relative flex items-start gap-4 rounded-xl border bg-white p-4 text-left transition-all hover:border-blue-500 hover:shadow-md dark:bg-[#2a2a2a]',
                )}
              >
                {/* 图标 */}
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-blue-100 text-blue-600 transition-colors group-hover:bg-blue-500 group-hover:text-white dark:bg-blue-900/30 dark:text-blue-400 dark:group-hover:bg-blue-500">
                  {CARD_ICONS[card.type]}
                </div>

                {/* 内容 */}
                <div className="flex-1 space-y-1">
                  <h3 className="font-medium">{card.title}</h3>
                  <p className="text-sm text-muted-foreground">
                    {card.description}
                  </p>
                </div>

                {/* 添加图标 */}
                <Plus className="h-5 w-5 shrink-0 text-gray-400 transition-colors group-hover:text-blue-500" />
              </button>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
