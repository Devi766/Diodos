'use client';

type RouteLoader = () => Promise<unknown>;

const routeLoaders: Record<string, RouteLoader> = {
  '/': () => import('@/components/Dashboard'),
  '/nodes': () => import('@/components/ProxyNodes'),
  '/subscriptions': () => import('@/components/Subscription'),
  '/connections': () => import('@/components/ConnectionTable'),
  '/match-rules': () => import('@/components/MatchRules'),
  '/providers': () => Promise.all([
    import('@/components/ProxyProviders'),
    import('@/components/RuleProviders'),
  ]),
  '/overrides': () => import('@/components/Overrides'),
  '/external-resources': () => import('@/components/ExternalResources'),
  '/logs': () => import('@/components/MihomoLogs'),
  '/ai-assistant': () => import('@/components/ai/AiAssistant'),
  '/settings': () => import('@/components/Settings'),
  '/tools/mtr': () => import('@/components/MtrTools'),
  '/tools': () => import('../../app/tools/page'),
};

const loadedRoutes = new Set<string>();
const inFlightRoutes = new Map<string, Promise<unknown>>();

const routePath = (href: string) => {
  try {
    return new URL(href, 'http://flyclash.local').pathname;
  } catch {
    return href.split('?')[0] || '/';
  }
};

const resolveRouteKey = (href: string) => {
  const path = routePath(href);
  if (path === '/') return '/';
  return Object.keys(routeLoaders)
    .filter((key) => key !== '/' && path.startsWith(key))
    .sort((a, b) => b.length - a.length)[0];
};

export const preloadRouteModule = (href: string) => {
  const key = resolveRouteKey(href);
  if (!key || loadedRoutes.has(key)) return Promise.resolve();

  const existing = inFlightRoutes.get(key);
  if (existing) return existing;

  const promise = routeLoaders[key]()
    .then((module) => {
      loadedRoutes.add(key);
      return module;
    })
    .catch((error) => {
      console.debug(`[RoutePreload] ${key} failed:`, error);
    })
    .finally(() => {
      inFlightRoutes.delete(key);
    });

  inFlightRoutes.set(key, promise);
  return promise;
};

export const preloadRouteModuleIdle = (href: string, timeoutMs = 1200) => {
  if (typeof window === 'undefined') return;

  const run = () => {
    void preloadRouteModule(href);
  };
  const requestIdle = (window as any).requestIdleCallback as
    | ((callback: () => void, options?: { timeout?: number }) => number)
    | undefined;

  if (typeof requestIdle === 'function') {
    requestIdle(run, { timeout: timeoutMs });
  } else {
    window.setTimeout(run, Math.min(timeoutMs, 180));
  }
};

// 常用页面逐个在空闲时加载；用户正在操作或窗口不可见时让出执行机会
export function scheduleRouteModuleWarmup(
  routes = ['/nodes', '/subscriptions', '/settings', '/tools', '/connections', '/match-rules'],
) {
  if (typeof window === 'undefined') return () => {};
  let disposed = false;
  let working = false;
  let index = 0;
  let quietAfter = 0;
  let timer: number | undefined;
  let idle: number | undefined;
  const idleApi = window as unknown as {
    requestIdleCallback?: (callback: () => void, options: { timeout: number }) => number;
    cancelIdleCallback?: (id: number) => void;
  };
  const clearSchedule = () => {
    window.clearTimeout(timer); timer = undefined;
    if (idle !== undefined) idleApi.cancelIdleCallback?.(idle);
    idle = undefined;
  };
  const schedule = (delay = 300) => {
    if (disposed || working || index >= routes.length) return;
    clearSchedule();
    timer = window.setTimeout(() => {
      timer = undefined;
      if (disposed || document.visibilityState === 'hidden') return;
      if (idleApi.requestIdleCallback) idle = idleApi.requestIdleCallback(run, { timeout: 2000 });
      else timer = window.setTimeout(run, 150);
    }, delay);
  };
  const run = () => {
    idle = undefined; timer = undefined;
    if (disposed || working || index >= routes.length || document.visibilityState === 'hidden') return;
    const input = navigator as Navigator & { scheduling?: { isInputPending?: () => boolean } };
    if (Date.now() < quietAfter || input.scheduling?.isInputPending?.()) { schedule(350); return; }
    working = true;
    void preloadRouteModule(routes[index++]).finally(() => {
      working = false;
      if (!disposed) schedule();
    });
  };
  const interaction = () => { quietAfter = Date.now() + 350; };
  const visibility = () => { if (document.visibilityState === 'visible') schedule(); else clearSchedule(); };
  window.addEventListener('pointerdown', interaction, { passive: true });
  window.addEventListener('keydown', interaction);
  document.addEventListener('visibilitychange', visibility);
  schedule(1200);
  return () => {
    disposed = true; clearSchedule();
    window.removeEventListener('pointerdown', interaction);
    window.removeEventListener('keydown', interaction);
    document.removeEventListener('visibilitychange', visibility);
  };
}
