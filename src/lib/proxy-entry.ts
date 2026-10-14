export interface ProxyEntry {
  node: string | null;
  entryNode: string | null;
  host: string | null;
  ip: string | null;
  privateDns: boolean;
  source: 'tcp' | 'dns' | 'config' | 'direct' | null;
  error: string | null;
}

let cached: ProxyEntry | null = null;
let revision = 0;
let pending: { revision: number; promise: Promise<ProxyEntry> } | null = null;

export const readCachedProxyEntry = () => cached;

export const invalidateProxyEntry = () => {
  revision += 1;
  cached = null;
};

// 同一轮解析共享请求，配置变更后的旧结果不写回缓存
export const resolveProxyEntry = (): Promise<ProxyEntry> => {
  if (pending?.revision === revision) return pending.promise;
  const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
  if (!api?.resolveProxyEntry) return Promise.reject(new Error('Entry API unavailable'));
  const current = revision;
  const promise = api.resolveProxyEntry().then(result => {
    if (!result || typeof result.privateDns !== 'boolean') throw new Error('Invalid entry response');
    if (revision === current) cached = result;
    return result;
  }).finally(() => {
    if (pending?.promise === promise) pending = null;
  });
  pending = { revision: current, promise };
  return promise;
};
