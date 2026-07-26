'use client';

import * as React from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface StyledSelectOption {
  value: string;
  label: React.ReactNode;
  disabled?: boolean;
}

export interface StyledSelectProps {
  value: string;
  onChange: (value: string) => void;
  options: StyledSelectOption[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  contentClassName?: string;
  size?: 'sm' | 'default';
  align?: 'start' | 'center' | 'end';
}

/**
 * 自绘下拉选择器。原生 <select> 的弹出列表由系统 WebView 渲染，
 * 无法与应用视觉风格统一（macOS 上尤其突兀），此处统一替换。
 */
export function StyledSelect({
  value,
  onChange,
  options,
  placeholder,
  disabled,
  className,
  contentClassName,
  size = 'default',
  align = 'start',
}: StyledSelectProps) {
  const [open, setOpen] = React.useState(false);
  const listRef = React.useRef<HTMLDivElement>(null);
  const selected = options.find((option) => option.value === value);

  React.useEffect(() => {
    if (!open) return;
    const node = listRef.current?.querySelector<HTMLElement>('[data-selected="true"]');
    node?.scrollIntoView({ block: 'nearest' });
  }, [open]);

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            'group flex w-full items-center justify-between gap-2 rounded-xl border border-gray-200 bg-white text-left text-sm text-gray-700 shadow-sm transition-all',
            'hover:border-gray-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30 focus-visible:border-blue-500/50',
            'disabled:cursor-not-allowed disabled:opacity-60',
            'dark:border-gray-600 dark:bg-[#2a2a2a] dark:text-gray-200 dark:hover:border-gray-500',
            open && 'border-blue-500/50 ring-2 ring-blue-500/20',
            size === 'sm' ? 'h-8 px-2.5' : 'h-10 px-3',
            className,
          )}
        >
          <span className={cn('truncate', !selected && 'text-gray-400 dark:text-gray-500')}>
            {selected ? selected.label : placeholder ?? ''}
          </span>
          <ChevronDown
            className={cn(
              'h-3.5 w-3.5 shrink-0 text-gray-400 transition-transform duration-200',
              open && 'rotate-180 text-blue-500',
            )}
          />
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align={align}
          sideOffset={6}
          collisionPadding={8}
          className={cn(
            'z-[200] max-h-[min(320px,var(--radix-popover-content-available-height))] w-[var(--radix-popover-trigger-width)] min-w-[8rem]',
            'overflow-y-auto rounded-xl border border-gray-200/80 bg-white/95 p-1 shadow-xl backdrop-blur-md',
            'dark:border-gray-600/80 dark:bg-[#2a2a2a]/95',
            'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
            'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95',
            contentClassName,
          )}
          ref={listRef}
        >
          {options.map((option) => {
            const isSelected = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                data-selected={isSelected || undefined}
                disabled={option.disabled}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
                className={cn(
                  'flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors',
                  'text-gray-700 hover:bg-blue-50 dark:text-gray-200 dark:hover:bg-blue-900/25',
                  'disabled:cursor-not-allowed disabled:opacity-50',
                  isSelected && 'bg-blue-50 font-medium text-blue-600 dark:bg-blue-900/30 dark:text-blue-300',
                )}
              >
                <span className="truncate">{option.label}</span>
                {isSelected && <Check className="h-3.5 w-3.5 shrink-0 text-blue-500" />}
              </button>
            );
          })}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
