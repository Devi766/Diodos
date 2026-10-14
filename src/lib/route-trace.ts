import { useEffect, useSyncExternalStore } from 'react';
import { fetchIpInfoByIp, type IpInfo } from '@/utils/ip-info';
import { readCachedProxyEntry, resolveProxyEntry } from '@/lib/proxy-entry';

export interface RouteHop {
  ttl: number; ip: string | null; sent: number; received: number; loss: number;
  avg: number | null; min: number | null; max: number | null; reached: boolean; geo?: IpInfo;
}
export interface RouteSnapshot {
  running: boolean; preparing: boolean; target: string | null; node: string | null; requestedTarget?: string; maxHops?: number;
  hops: RouteHop[]; targetGeo?: IpInfo; error?: string; finishedAt?: number;
}
export interface RouteTraceOptions { target?: string; maxHops?: number; count?: number; timeoutMs?: number }
export interface RoutePoint { lat: number; lon: number; label: string; hidden?: boolean }
const initial: RouteSnapshot = { running: false, preparing: false, target: null, node: null, hops: [] };
export function isPublicIpv4(value: string): boolean {
  if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(value)) return false;
  const [a, b, c, d] = value.split('.').map(Number);
  return !([a, b, c, d].some(n => n > 255) || a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b < 128) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b < 32)
    || (a === 192 && (b === 168 || (b === 0 && c === 2))) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    || (a === 203 && b === 0 && c === 113));
}

export function routePoints(hops: RouteHop[]): RoutePoint[] {
  const points: RoutePoint[] = [];
  let hidden = false;
  for (const hop of hops) {
    const lat = hop.geo?.latitude; const lon = hop.geo?.longitude;
    if (lat === undefined || lon === undefined || !Number.isFinite(lat) || !Number.isFinite(lon)) { hidden = true; continue; }
    const last = points[points.length - 1];
    if (last && Math.abs(last.lat - lat) < 0.01 && Math.abs(last.lon - lon) < 0.01) continue;
    points.push({ lat, lon, label: hop.geo?.city || hop.geo?.country || hop.ip || '', hidden });
    hidden = false;
  }
  return points;
}

export function createRouteTraceRunner() {
  let snapshot = initial;
  let generation = 0;
  let draining: Promise<void> = Promise.resolve();
  const listeners = new Set<() => void>();
  const publish = (next: RouteSnapshot) => { snapshot = next; listeners.forEach(fn => fn()); };
  const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
  const useSnapshot = () => {
    useEffect(() => {
      const changed = () => { if (snapshot.running && !snapshot.requestedTarget) { stop(); publish({ ...snapshot, error: 'route_changed' }); } };
      window.addEventListener('profile-updated', changed);
      const offNode = window.electronAPI?.onNodeChanged?.(changed);
      const offConfig = window.electronAPI?.onActiveConfigChanged?.(changed);
      return () => { window.removeEventListener('profile-updated', changed); offNode?.(); offConfig?.(); };
    }, []);
    return useSyncExternalStore(subscribe, () => snapshot, () => initial);
  };

  function stop() {
    generation += 1;
    publish({ ...snapshot, running: false, preparing: false, finishedAt: Date.now() });
  }

  // 六跳滑动窗口，按跳序发布；归属地使用独立的三并发队列
  async function start(options: RouteTraceOptions = {}) {
    if (snapshot.running) return;
    const current = ++generation;
    const alive = () => current === generation;
    const cached = readCachedProxyEntry();
    const bounded = (value: number | undefined, fallback: number, min: number, max: number) => value !== undefined && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
    const maxHops = bounded(options.maxHops, 24, 4, 24);
    const count = bounded(options.count, 3, 1, 3);
    const timeoutMs = bounded(options.timeoutMs, 1000, 200, 2000);
    publish({ ...initial, running: true, preparing: true, requestedTarget: options.target, maxHops });
    const geoQueue: Array<{ ip: string; ttl?: number }> = [];
    const geoRequests: Promise<void>[] = [];
    let geoActive = 0;
    const enqueueGeo = (ip: string, ttl?: number) => {
      if (!isPublicIpv4(ip)) return;
      geoQueue.push({ ip, ttl });
      pumpGeo();
    };
    const pumpGeo = () => {
      while (alive() && geoActive < 3 && geoQueue.length) {
        const item = geoQueue.shift()!; geoActive += 1;
        let timer: ReturnType<typeof setTimeout>;
        const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('geo_timeout')), 10_000); });
        const task = Promise.race([fetchIpInfoByIp(item.ip), timeout]).then(geo => {
          if (!alive()) return;
          publish(item.ttl === undefined ? { ...snapshot, targetGeo: geo }
            : { ...snapshot, hops: snapshot.hops.map(hop => hop.ttl === item.ttl ? { ...hop, geo } : hop) });
        }).catch(() => {}).finally(() => { clearTimeout(timer!); geoActive -= 1; pumpGeo(); });
        geoRequests.push(task);
      }
    };
    try {
      await draining;
      if (!alive()) return;
      const api = window.electronAPI;
      if (!api?.probeHop || !api.prepareRouteTrace) throw new Error('probe_unavailable');
      let target: string; let node: string | null = null;
      if (options.target?.trim()) {
        if (!api.resolveRouteTarget) throw new Error('resolve_unavailable');
        const resolved = await api.resolveRouteTarget(options.target.trim());
        if (!alive()) return;
        if (!resolved?.ip) throw new Error('dns_failed');
        target = resolved.ip;
      } else {
        let entry = await resolveProxyEntry();
        if (!alive()) return;
        if (entry.error === 'core_unavailable' && cached?.ip) entry = cached;
        if (!entry.ip || entry.error || !isPublicIpv4(entry.ip)) throw new Error(entry.error || 'no_entry');
        target = entry.ip; node = entry.entryNode || entry.node;
      }
      const { source } = await api.prepareRouteTrace();
      if (!alive()) return;
      if (!source) throw new Error('physical_interface_unavailable');
      publish({ ...snapshot, preparing: false, target, node });
      enqueueGeo(target);
      let next = 1; let silent = 0;
      const pending: Array<Promise<RouteHop>> = [];
      const allRequests: Promise<unknown>[] = [];
      const launch = () => {
        if (next > maxHops || !alive()) return;
        const ttl = next++;
        // 转成已处理的结果，靠后的请求先失败时不会产生未处理拒绝
        const request = api.probeHop!({ target, source, ttl, count, timeoutMs })
          .then(result => ({ result, error: null as unknown }))
          .catch(error => ({ result: null, error }));
        allRequests.push(request);
        pending.push(request.then(({ result, error }) => {
          if (error) return { ttl, ip: null, sent: count, received: 0, loss: 100, avg: null, min: null, max: null, reached: false, probeError: String(error) };
          return result!;
        }));
      };
      for (let i = 0; i < 6; i++) launch();
      try {
        while (pending.length && alive()) {
          const hop = await pending.shift()!;
          if (!alive()) break;
          if ('probeError' in hop) throw new Error(String(hop.probeError));
          publish({ ...snapshot, hops: [...snapshot.hops, hop] });
          if (hop.ip) enqueueGeo(hop.ip, hop.ttl);
          silent = hop.ip ? 0 : silent + 1;
          if (hop.reached || silent >= 6) break;
          launch();
        }
      } finally {
        draining = Promise.allSettled(allRequests).then(() => {});
      }
      // 队列任务在完成时可能继续补入三个查询，直到全部补齐
      while (alive() && (geoActive || geoQueue.length)) await Promise.allSettled([...geoRequests]);
      if (alive()) publish({ ...snapshot, running: false, finishedAt: Date.now() });
    } catch (error) {
      if (alive()) publish({ ...snapshot, running: false, preparing: false, error: error instanceof Error ? error.message : String(error), finishedAt: Date.now() });
    }
  }

  return { useSnapshot, start, stop, getSnapshot: () => snapshot,
    clear: () => { generation += 1; publish(initial); } };
}

const dashboardRunner = createRouteTraceRunner();
export const useRouteSnapshot = dashboardRunner.useSnapshot;
export const startRouteTrace = dashboardRunner.start;
export const stopRouteTrace = dashboardRunner.stop;

export const ROUTE_PREVIEW: RouteSnapshot = {
  running: false, preparing: false, target: '1.1.1.1', node: 'Preview', hops: [
    { ttl: 1, ip: '192.168.1.1', sent: 3, received: 3, loss: 0, avg: 1, min: 1, max: 2, reached: false, geo: { ip: '', latitude: 31.23, longitude: 121.47, city: 'Shanghai' } },
    { ttl: 2, ip: null, sent: 3, received: 0, loss: 100, avg: null, min: null, max: null, reached: false },
    { ttl: 3, ip: '1.1.1.1', sent: 3, received: 3, loss: 0, avg: 38, min: 36, max: 41, reached: true, geo: { ip: '', latitude: 35.68, longitude: 139.69, city: 'Tokyo' } },
  ],
};
