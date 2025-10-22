import React from 'react';
import { Button } from '@/components/ui/button';
import { Settings2, Plus, RotateCcw, Check, X } from 'lucide-react';
import { cn } from '@/lib/utils';

interface DashboardToolbarProps {
  isEditMode: boolean;
  onToggleEditMode: () => void;
  onAddCard: () => void;
  onReset: () => void;
}

export function DashboardToolbar({
  isEditMode,
  onToggleEditMode,
  onAddCard,
  onReset,
}: DashboardToolbarProps) {
  return (
    <div
      className={cn(
        'flex items-center justify-between rounded-2xl bg-white/80 p-3 shadow-sm backdrop-blur-sm transition-all dark:bg-[#2a2a2a]/80',
        isEditMode && 'bg-blue-50/80 dark:bg-blue-900/20',
      )}
    >
      {/* 左侧：编辑模式提示 */}
      <div className="flex items-center gap-3">
        {isEditMode && (
          <div className="flex items-center gap-2 text-sm font-medium text-blue-600 dark:text-blue-400">
            <Settings2 className="h-4 w-4 animate-pulse" />
            编辑模式
          </div>
        )}
      </div>

      {/* 右侧：操作按钮 */}
      <div className="flex items-center gap-2">
        {isEditMode ? (
          <>
            {/* 添加卡片 */}
            <Button
              variant="outline"
              size="sm"
              onClick={onAddCard}
              className="gap-2"
            >
              <Plus className="h-4 w-4" />
              添加卡片
            </Button>

            {/* 重置 */}
            <Button
              variant="outline"
              size="sm"
              onClick={onReset}
              className="gap-2"
            >
              <RotateCcw className="h-4 w-4" />
              重置
            </Button>

            {/* 完成 */}
            <Button
              variant="default"
              size="sm"
              onClick={onToggleEditMode}
              className="gap-2"
            >
              <Check className="h-4 w-4" />
              完成
            </Button>
          </>
        ) : (
          <>
            {/* 自定义布局 */}
            <Button
              variant="outline"
              size="sm"
              onClick={onToggleEditMode}
              className="gap-2"
            >
              <Settings2 className="h-4 w-4" />
              自定义布局
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
