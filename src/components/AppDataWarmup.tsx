'use client';

import { useEffect } from 'react';
import {
  APP_DATA_INVALIDATE_EVENT,
  invalidateAppDataCache,
  type AppDataInvalidationScope,
} from '@/services/app-data-cache';
import { preloadCommonAppData } from '@/services/app-data-preload';

const asScope = (value: unknown): AppDataInvalidationScope => {
  if (
    value === 'all' ||
    value === 'profile' ||
    value === 'active-config' ||
    value === 'providers' ||
    value === 'runtime' ||
    value === 'network' ||
    value === 'backup'
  ) {
    return value;
  }
  return 'profile';
};

export default function AppDataWarmup() {
  useEffect(() => {
    if (typeof window === 'undefined') return;

    let disposed = false;
    let refreshTimer: number | null = null;
    let idleHandle: number | null = null;

    const cancelIdleWarmup = () => {
      if (idleHandle === null) return;
      const cancelIdle = (window as any).cancelIdleCallback as
        | ((handle: number) => void)
        | undefined;
      if (typeof cancelIdle === 'function') {
        cancelIdle(idleHandle);
      } else {
        window.clearTimeout(idleHandle);
      }
      idleHandle = null;
    };

    const runWarmup = (force: boolean) => {
      if (disposed) return;
      void preloadCommonAppData({
        force,
        idle: true,
        idleTimeoutMs: force ? 1200 : 1800,
        timeoutMs: force ? 4000 : 3000,
      });
    };

    const scheduleWarmup = (force: boolean, delay: number) => {
      if (refreshTimer !== null) {
        window.clearTimeout(refreshTimer);
      }
      cancelIdleWarmup();
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        if (disposed) return;

        const requestIdle = (window as any).requestIdleCallback as
          | ((callback: () => void, options?: { timeout?: number }) => number)
          | undefined;
        if (typeof requestIdle === 'function') {
          idleHandle = requestIdle(() => {
            idleHandle = null;
            runWarmup(force);
          }, { timeout: force ? 500 : 1800 });
        } else {
          idleHandle = window.setTimeout(() => {
            idleHandle = null;
            runWarmup(force);
          }, force ? 0 : 350);
        }
      }, delay);
    };

    const invalidateAndRefresh = (
      scope: AppDataInvalidationScope = 'profile',
      force = true,
      delay = 250,
    ) => {
      invalidateAppDataCache(scope);
      scheduleWarmup(force, delay);
    };

    scheduleWarmup(false, 1800);

    const onProfileUpdated = (event: Event) => {
      const detail = event instanceof CustomEvent ? event.detail : null;
      const source = detail?.source;
      if (source === 'proxy-nodes' && detail?.action === 'node-changed') {
        // Node selection already writes local caches; only soft refresh runtime bits.
        invalidateAndRefresh('network', true, 400);
        return;
      }
      if (source === 'proxy-providers' || source === 'rule-providers') {
        invalidateAndRefresh('providers', true, 300);
        return;
      }
      if (source === 'tun-settings') {
        invalidateAndRefresh('runtime', true, 300);
        return;
      }
      if (source === 'overrides') {
        // 覆写页已乐观更新列表；清掉 overrides 缓存会闪回空/初始态。
        // 这里只刷新运行时相关数据（内核重载后的代理组等）。
        invalidateAndRefresh('runtime', true, 400);
        return;
      }
      invalidateAndRefresh('profile', true, 300);
    };

    const onBackupRestored = () => invalidateAndRefresh('backup', true, 200);
    const onSubscriptionAutoUpdated = () => invalidateAndRefresh('profile', true, 300);
    const onActiveConfigChanged = () => invalidateAndRefresh('active-config', true, 200);
    const onInvalidateEvent = (event: Event) => {
      const detail = event instanceof CustomEvent ? event.detail : null;
      invalidateAndRefresh(asScope(detail?.scope), true, 150);
    };

    window.addEventListener('profile-updated', onProfileUpdated);
    window.addEventListener('backup-restored', onBackupRestored);
    window.addEventListener('subscription-auto-updated', onSubscriptionAutoUpdated);
    window.addEventListener(APP_DATA_INVALIDATE_EVENT, onInvalidateEvent as EventListener);

    const unsubscribeActiveConfig = window.electronAPI?.onActiveConfigChanged?.(onActiveConfigChanged);
    const unsubscribeAutoUpdated = window.electronAPI?.onSubscriptionAutoUpdated?.(onSubscriptionAutoUpdated);

    return () => {
      disposed = true;
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      cancelIdleWarmup();
      window.removeEventListener('profile-updated', onProfileUpdated);
      window.removeEventListener('backup-restored', onBackupRestored);
      window.removeEventListener('subscription-auto-updated', onSubscriptionAutoUpdated);
      window.removeEventListener(APP_DATA_INVALIDATE_EVENT, onInvalidateEvent as EventListener);
      unsubscribeActiveConfig?.();
      unsubscribeAutoUpdated?.();
    };
  }, []);

  return null;
}
