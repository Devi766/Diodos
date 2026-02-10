import React from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Plus, Activity, Wifi, Shield, BarChart3, Info, Cpu, FileText, Scale } from 'lucide-react';
import { DashboardCard, DashboardCardType } from '@/types/dashboard';
import { cn } from '@/lib/utils';

interface AddCardDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  availableCards: DashboardCard[];
  onAddCard: (card: DashboardCard) => void;
  renderCardPreview: (type: DashboardCardType) => React.ReactNode;
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
  'traffic-ranking': <BarChart3 className="h-6 w-6" />,
  'traffic-statistics': <Activity className="h-6 w-6" />,
  'subscription-info': <FileText className="h-6 w-6" />,
  'rules-overview': <Scale className="h-6 w-6" />,
};

export function AddCardDialog({
  open,
  onOpenChange,
  availableCards,
  onAddCard,
  renderCardPreview,
}: AddCardDialogProps) {
  const handleAddCard = (card: DashboardCard) => {
    onAddCard(card);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[80vh] overflow-y-auto custom-scrollbar">
        <DialogHeader>
          <DialogTitle>添加卡片</DialogTitle>
          <DialogDescription>
            选择要添加到仪表盘的卡片
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-4 md:grid-cols-2">
          {availableCards.length === 0 ? (
            <div className="col-span-2 rounded-lg border border-dashed p-8 text-center">
              <p className="text-sm text-muted-foreground">
                所有卡片已添加
              </p>
            </div>
          ) : (
            availableCards.map((card) => (
              <div
                key={card.id}
                className="group relative cursor-pointer transition-all hover:scale-[1.02]"
                onClick={() => handleAddCard(card)}
              >
                {/* 卡片标题和描述 - 悬浮在卡片上方 */}
                <div className="absolute -top-2 left-2 z-10 flex items-center gap-2 rounded-full bg-white px-3 py-1.5 shadow-md dark:bg-[#2a2a2a]">
                  <div className="flex h-6 w-6 items-center justify-center rounded-md bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400">
                    {CARD_ICONS[card.type]}
                  </div>
                  <span className="text-sm font-medium">{card.title}</span>
                  <Plus className="h-4 w-4 text-gray-400 transition-colors group-hover:text-blue-500" />
                </div>

                {/* 真实卡片预览 */}
                <div className="pointer-events-none mt-4 transition-all group-hover:shadow-lg">
                  {renderCardPreview(card.type)}
                </div>
              </div>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
