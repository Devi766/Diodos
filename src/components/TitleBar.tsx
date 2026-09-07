'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Minus, X, Square } from 'lucide-react';
import { getBrowserPlatform, getRuntimePlatform } from '@/utils/platform';

const resolveElectron = () => {
  if (typeof window === 'undefined') return undefined;
  return window.electronAPI;
};

const resolveMaximizedState = (state: any) => {
  if (!state || typeof state !== 'object') return false;
  return Boolean(state.maximized ?? state.isMaximized ?? state.fullScreen ?? state.isFullscreen);
};

export default function TitleBar() {
  const [electron, setElectron] = useState(resolveElectron);
  const [isMaximized, setIsMaximized] = useState(false);
  const [isMacOS, setIsMacOS] = useState(() => getBrowserPlatform() === 'darwin');

  useEffect(() => {
    let disposed = false;

    setIsMacOS(getBrowserPlatform() === 'darwin');
    setElectron(resolveElectron());

    void getRuntimePlatform().then((platform) => {
      if (!disposed) {
        setIsMacOS(platform === 'darwin');
      }
    });

    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    let disposed = false;

    const syncWindowState = async () => {
      try {
        const result = await electron?.getWindowState?.();
        if (!disposed && result && result.success) {
          setIsMaximized(resolveMaximizedState(result));
        }
      } catch {}

      try {
        if (!disposed && electron?.onWindowStateChanged) {
          unsubscribe = electron.onWindowStateChanged((state: any) => {
            if (!state) return;
            setIsMaximized(resolveMaximizedState(state));
          });
        }
      } catch {}
    };

    syncWindowState();

    return () => {
      disposed = true;
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
      if (result && typeof result === 'object' && (
        'maximized' in result ||
        'isMaximized' in result ||
        'fullScreen' in result ||
        'isFullscreen' in result
      )) {
        setIsMaximized(resolveMaximizedState(result));
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

  const startWindowDrag = useCallback((event: React.MouseEvent<HTMLElement>) => {
    if (event.button !== 0 || event.detail !== 1) return;

    const target = event.target as HTMLElement | null;
    if (target?.closest('button, a, input, textarea, select, [data-no-drag]')) return;

    const tauri = (window as unknown as {
      __TAURI__?: {
        window?: {
          getCurrentWindow?: () => { startDragging?: () => Promise<void> };
        };
      };
    }).__TAURI__;
    const currentWindow = tauri?.window?.getCurrentWindow?.();
    if (typeof currentWindow?.startDragging === 'function') {
      void currentWindow.startDragging();
    }
  }, []);

  // macOS Overlay titlebar: native traffic lights sit on the left.
  // The strip to their right must be a real Tauri drag region so the window can move.
  if (isMacOS) {
    return (
      <div
        className="glass-titlebar pointer-events-none fixed inset-x-0 top-0 z-[80] flex h-10"
        aria-hidden
      >
        <div className="h-full w-[78px] shrink-0" />
        <div
          className="titlebar-drag-region pointer-events-auto h-full min-w-0 flex-1 cursor-default"
          data-tauri-drag-region
          onMouseDown={startWindowDrag}
        />
      </div>
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
      className="glass-titlebar titlebar-drag-region fixed top-0 left-0 right-0 z-50 flex h-12 items-center justify-end px-2"
      data-tauri-drag-region
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      <div
        className="titlebar-no-drag flex items-center gap-1"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <button
          type="button"
          onClick={runMinimize}
          className="inline-flex h-7 w-9 items-center justify-center rounded-md text-slate-600 transition hover:bg-slate-200/70 focus:outline-none dark:text-slate-200 dark:hover:bg-slate-700/60"
        >
          <Minus className="h-3.5 w-3.5" />
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
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
