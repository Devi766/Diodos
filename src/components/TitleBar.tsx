'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { MinusIcon, Cross2Icon } from '@radix-ui/react-icons';
import { Square } from 'lucide-react';

const resolveElectron = () => {
  if (typeof window === 'undefined') return undefined;
  return window.electronAPI;
};

export default function TitleBar() {
  const electron = useMemo(resolveElectron, []);
  const [isMaximized, setIsMaximized] = useState(false);
  const [isMacOS, setIsMacOS] = useState(false);

  useEffect(() => {
    // 检测是否是 macOS
    setIsMacOS(navigator.platform.toLowerCase().includes('mac'));
  }, []);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;

    const syncWindowState = async () => {
      try {
        const result = await electron?.getWindowState?.();
        if (result && result.success) {
          const nextMaximized = Boolean(result.maximized || result.fullScreen);
          setIsMaximized(nextMaximized);
        }
      } catch {}

      try {
        if (electron?.onWindowStateChanged) {
          unsubscribe = electron.onWindowStateChanged((state: any) => {
            if (!state) return;
            const nextMaximized = Boolean(state.maximized || state.fullScreen);
            setIsMaximized(nextMaximized);
          });
        }
      } catch {}
    };

    syncWindowState();

    return () => {
      if (typeof unsubscribe === 'function') {
        unsubscribe();
      }
    };
  }, [electron]);

  const runMinimize = useCallback(async () => {
    try {
      await electron?.minimizeWindow?.();
    } catch {}
  }, [electron]);

  const runToggleMaximize = useCallback(async () => {
    try {
      const result = await electron?.maximizeWindow?.();
      if (result && typeof result === 'object' && 'maximized' in result) {
        setIsMaximized(Boolean(result.maximized));
      } else {
        setIsMaximized((prev) => !prev);
      }
    } catch {}
  }, [electron]);

  const runClose = useCallback(async () => {
    try {
      await electron?.closeWindow?.();
    } catch {}
  }, [electron]);

  // macOS 上隐藏窗口控制按钮（使用原生红绿灯按钮）
  if (isMacOS) {
    return (
      <div
        className="glass-titlebar fixed top-0 left-0 right-0 z-50 flex h-12 items-center justify-end px-2"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      />
    );
  }

  // 尽量还原 Windows 的“还原”图标（两个错位的方框）
  const MaximizedIcon = () => (
    <svg
      className="h-3.5 w-3.5"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1"
      strokeLinecap="square"
      strokeLinejoin="miter"
    >
      {/* 前景方框（左下） */}
      <rect x="3.5" y="5.5" width="7" height="7" />
      {/* 背景方框：只画上边和右边，模拟 Windows 的重叠效果 */}
      <path d="M6.5 3.5H12.5V9.5" />
    </svg>
  );

  return (
    <div
      className="glass-titlebar fixed top-0 left-0 right-0 z-50 flex h-12 items-center justify-end px-2"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      <div
        className="flex items-center gap-1"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <button
          type="button"
          onClick={runMinimize}
          className="inline-flex h-7 w-9 items-center justify-center rounded-md text-slate-600 transition hover:bg-slate-200/70 focus:outline-none dark:text-slate-200 dark:hover:bg-slate-700/60"
        >
          <MinusIcon className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={runToggleMaximize}
          className="inline-flex h-7 w-9 items-center justify-center rounded-md text-slate-600 transition hover:bg-slate-200/70 focus:outline-none dark:text-slate-200 dark:hover:bg-slate-700/60"
        >
          {isMaximized ? (
            <MaximizedIcon />
          ) : (
            <Square className="h-3.5 w-3.5" strokeWidth={1.7} />
          )}
        </button>
        <button
          type="button"
          onClick={runClose}
          className="inline-flex h-7 w-9 items-center justify-center rounded-md text-slate-600 transition hover:bg-slate-200/70 focus:outline-none dark:text-slate-200 dark:hover:bg-slate-700/60"
        >
          <Cross2Icon className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
