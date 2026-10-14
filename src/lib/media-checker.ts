import { useEffect, useSyncExternalStore } from 'react';

export const MEDIA_SERVICES = [
  { id: 'netflix', name: 'Netflix' },
  { id: 'chatgpt', name: 'ChatGPT' },
  { id: 'disney', name: 'Disney+' },
] as const;
export type MediaId = typeof MEDIA_SERVICES[number]['id'];
export type MediaStatus = 'pending' | 'testing' | 'supported' | 'reachable' | 'partial' | 'restricted' | 'unknown' | 'failed';
export interface MediaResult { id: MediaId; status: MediaStatus; region?: string; checkedAt?: number }
export interface MediaSnapshot { results: MediaResult[]; running: boolean }
const initial: MediaSnapshot = { results: MEDIA_SERVICES.map(s => ({ id: s.id, status: 'pending' })), running: false };
let snapshot = initial;
let revision = 0;
const listeners = new Set<() => void>();
const publish = (next: MediaSnapshot) => { snapshot = next; listeners.forEach(fn => fn()); };
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

export async function runMediaCheck(selected?: MediaId) {
  if (snapshot.running) return;
  const services = MEDIA_SERVICES.filter(service => !selected || service.id === selected);
  const current = revision;
  const ids = new Set(services.map(s => s.id));
  publish({ running: true, results: snapshot.results.map(r => ids.has(r.id) ? { ...r, status: 'testing' } : r) });
  await Promise.all(services.map(async service => {
    let result: MediaResult;
    try {
      if (!window.electronAPI?.testMediaStreaming) throw new Error('media_api_unavailable');
      const response = await window.electronAPI.testMediaStreaming(service.name);
      if (typeof response?.available !== 'boolean') throw new Error('invalid_media_response');
      const message = response.message || '';
      const fallback: MediaStatus = /未知|unknown|无法判断/i.test(message) ? 'unknown' : /检测失败|超时|failed|timeout/i.test(message) ? 'failed'
        : response.fullSupport ? 'supported' : response.available ? 'partial' : 'restricted';
      const status: MediaStatus = response.verdict ?? fallback;
      result = { id: service.id, status, region: response.region, checkedAt: Date.now() };
    } catch { result = { id: service.id, status: 'failed', checkedAt: Date.now() }; }
    if (current === revision) publish({ ...snapshot, results: snapshot.results.map(r => r.id === service.id ? result : r) });
  }));
  if (current === revision) publish({ ...snapshot, running: false });
}

export const MEDIA_PREVIEW: MediaSnapshot = { running: false, results: [
  { id: 'netflix', status: 'supported', region: 'JP' },
  { id: 'chatgpt', status: 'reachable' },
  { id: 'disney', status: 'reachable' },
] };

// 完整工具测试结束后，将同名服务的结果同步到仪表盘
export function applyMediaToolResults(results: Array<{ name: string; status: string; fullSupport?: boolean; region?: string; message?: string }>) {
  revision += 1;
  publish({ running: false, results: snapshot.results.map(previous => {
    const service = MEDIA_SERVICES.find(service => service.id === previous.id)!;
    const result = results.find(result => result.name === service.name);
    if (!result || result.status === 'idle' || result.status === 'checking') return previous.status === 'testing' ? { ...previous, status: 'pending' } : previous;
    const status: MediaStatus = result.status === 'success' ? result.fullSupport ? 'supported' : 'reachable'
      : result.status === 'partial' ? 'partial' : result.status === 'timeout' || /失败|超时|failed|timeout/i.test(result.message || '') ? 'failed' : 'restricted';
    return { id: previous.id, status, region: result.region, checkedAt: Date.now() };
  }) });
}
export const useMediaSnapshot = () => {
  useEffect(() => {
    const reset = () => { revision += 1; publish(initial); };
    const events = ['profile-updated', 'backup-restored', 'subscription-auto-updated'];
    events.forEach(event => window.addEventListener(event, reset));
    const offNode = window.electronAPI?.onNodeChanged?.(reset);
    const offConfig = window.electronAPI?.onActiveConfigChanged?.(reset);
    return () => { events.forEach(event => window.removeEventListener(event, reset)); offNode?.(); offConfig?.(); };
  }, []);
  return useSyncExternalStore(subscribe, () => snapshot, () => initial);
};
