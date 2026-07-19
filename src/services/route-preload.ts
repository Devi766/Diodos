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
