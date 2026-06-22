'use client';

import { useEffect } from 'react';
import { preloadCommonAppData } from '@/services/app-data-preload';

export default function AppDataWarmup() {
  useEffect(() => {
    if (typeof window === 'undefined') return;

    let disposed = false;
    void preloadCommonAppData({ force: true });

    let refreshTimer: number | null = null;
    const scheduleRefresh = () => {
      if (refreshTimer !== null) {
        window.clearTimeout(refreshTimer);
      }
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        if (!disposed) void preloadCommonAppData({ force: true });
      }, 350);
    };

    window.addEventListener('profile-updated', scheduleRefresh);
    window.addEventListener('backup-restored', scheduleRefresh);
    window.addEventListener('subscription-auto-updated', scheduleRefresh);

    const unsubscribeActiveConfig = window.electronAPI?.onActiveConfigChanged?.(scheduleRefresh);
    const unsubscribeAutoUpdated = window.electronAPI?.onSubscriptionAutoUpdated?.(scheduleRefresh);

    return () => {
      disposed = true;
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      window.removeEventListener('profile-updated', scheduleRefresh);
      window.removeEventListener('backup-restored', scheduleRefresh);
      window.removeEventListener('subscription-auto-updated', scheduleRefresh);
      unsubscribeActiveConfig?.();
      unsubscribeAutoUpdated?.();
    };
  }, []);

  return null;
}
