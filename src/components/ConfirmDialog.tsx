import React from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle } from 'lucide-react';
import { useThemeColor } from '@/hooks/useThemeColor';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmText?: string;
  cancelText?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  open,
  title,
  description,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  onConfirm,
  onCancel
}) => {
  const themeColor = useThemeColor();

  if (!open) return null;

  return createPortal(
    <>
      {/* 背景遮罩 */}
      <div
        className="fixed inset-0 bg-slate-950/50 backdrop-blur-sm z-[100]"
        onClick={onCancel}
      />

      {/* 对话框 */}
      <div className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-[100] w-full max-w-xl grid gap-4 glass-panel card-surface rounded-[28px] p-8">
        {/* 图标和标题 */}
        <div className="flex items-start gap-4">
          <div className="flex-shrink-0 w-10 h-10 rounded-full bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center">
            <AlertCircle className="h-6 w-6 text-amber-600 dark:text-amber-500" />
          </div>
          <div className="flex-1">
            <h3 className="text-lg font-semibold leading-none tracking-tight mb-2">
              {title}
            </h3>
            <p className="text-sm text-muted-foreground whitespace-pre-line">
              {description}
            </p>
          </div>
        </div>

        {/* 按钮 */}
        <div className="flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2 mt-2">
          <button
            onClick={onCancel}
            className="relative inline-flex items-center justify-center whitespace-nowrap rounded-xl text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-60 overflow-hidden border border-white/25 bg-white/20 text-foreground backdrop-blur-md hover:border-white/40 hover:bg-white/30 dark:border-white/10 dark:bg-white/8 dark:hover:bg-white/12 h-11 px-5"
          >
            {cancelText}
          </button>
          <button
            onClick={onConfirm}
            className="relative inline-flex items-center justify-center whitespace-nowrap rounded-xl text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-60 overflow-hidden text-white h-11 px-5 hover:brightness-110"
            style={{
              backgroundColor: themeColor,
              boxShadow: `0 20px 42px -22px ${themeColor}70`
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.boxShadow = `0 24px 52px -20px ${themeColor}90`;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.boxShadow = `0 20px 42px -22px ${themeColor}70`;
            }}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </>,
    document.body
  );
};

