import React from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';

interface DraggableCardProps {
  id: string;
  children: React.ReactNode;
  isEditMode: boolean;
  onRemove?: () => void;
  enabled?: boolean;
  className?: string;
}

export function DraggableCard({
  id,
  children,
  isEditMode,
  onRemove,
  enabled = true,
  className,
}: DraggableCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id,
    disabled: !isEditMode,
    transition: {
      duration: 200,
      easing: 'cubic-bezier(0.25, 1, 0.5, 1)',
    },
  });

  const style: React.CSSProperties = {
    // 关键：使用 Translate 而不是 Transform，避免缩放导致的拉伸问题
    transform: CSS.Translate.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 999 : undefined,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'group relative',
        !enabled && 'opacity-60',
        className,
      )}
    >
      {/* 编辑模式覆盖层 */}
      {isEditMode && (
        <div className="absolute left-0 right-0 top-0 z-10 flex items-center justify-between p-2">
          {/* 拖拽手柄 */}
          <button
            {...attributes}
            {...listeners}
            className="cursor-grab rounded-lg bg-white/95 p-2 shadow-lg transition-all hover:bg-white hover:shadow-xl active:cursor-grabbing dark:bg-gray-800/95 dark:hover:bg-gray-800"
          >
            <GripVertical className="h-4 w-4 text-gray-600 dark:text-gray-300" />
          </button>

          {/* 删除按钮 */}
          {onRemove && (
            <button
              onClick={onRemove}
              className="rounded-lg bg-white/95 p-2 shadow-lg transition-all hover:bg-red-50 hover:shadow-xl dark:bg-gray-800/95 dark:hover:bg-red-900/30"
            >
              <Trash2 className="h-4 w-4 text-red-600 dark:text-red-400" />
            </button>
          )}
        </div>
      )}

      {/* 卡片内容 */}
      <div className="h-full w-full">{children}</div>
    </div>
  );
}
