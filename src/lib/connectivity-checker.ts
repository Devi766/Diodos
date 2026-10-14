import { useSyncExternalStore } from 'react';

// 连通性检查：并发访问几个常用站点，记录能否连通以及首字节延迟。
// 请求经内核 mixed 端口发出，结果反映"当前这套配置下能不能上这些网站"。
// 结果在页面内共享，多张卡片订阅同一份状态；只在用户主动触发时检测。

export const CONNECTIVITY_TARGETS = [
  { id: 'google', label: 'Google' },
  { id: 'youtube', label: 'YouTube' },
  { id: 'github', label: 'GitHub' },
  { id: 'chatgpt', label: 'ChatGPT' },
  { id: 'telegram', label: 'Telegram' },
  { id: 'cloudflare', label: 'Cloudflare' },
] as const;

export type ConnectivityLevel = 'pending' | 'good' | 'fair' | 'slow' | 'failed';

export interface ConnectivityResult {
  id: string;
  level: ConnectivityLevel;
  delay: number | null;
}

export interface ConnectivitySnapshot {
  results: ConnectivityResult[];
  running: boolean;
  checkedAt: number;
  error?: string;
}

const GOOD_MS = 300;
const FAIR_MS = 800;

const levelOf = (delay: number | null): ConnectivityLevel => {
  if (delay === null) return 'failed';
  if (delay <= GOOD_MS) return 'good';
  if (delay <= FAIR_MS) return 'fair';
  return 'slow';
};

const pendingResults = (): ConnectivityResult[] =>
  CONNECTIVITY_TARGETS.map(({ id }) => ({ id, level: 'pending', delay: null }));

let snapshot: ConnectivitySnapshot = { results: pendingResults(), running: false, checkedAt: 0 };
const listeners = new Set<() => void>();

const publish = (next: ConnectivitySnapshot) => {
  snapshot = next;
  listeners.forEach((listener) => listener());
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

// 立即重新检查；正在检查时忽略
export async function runConnectivityCheck() {
  if (snapshot.running) return;
  publish({ ...snapshot, results: pendingResults(), running: true, error: undefined });

  const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
  try {
    if (!api?.checkConnectivity) throw new Error('checkConnectivity unavailable');
    const response = await api.checkConnectivity();
    if (!response?.success || !Array.isArray(response.results)) {
      throw new Error(response?.error || 'checkConnectivity failed');
    }
    const delays = new Map(response.results.map((item) => [item.id, item.delay]));
    publish({
      results: CONNECTIVITY_TARGETS.map(({ id }) => {
        const delay = delays.get(id);
        const value = typeof delay === 'number' && Number.isFinite(delay) ? delay : null;
        return { id, level: levelOf(value), delay: value };
      }),
      running: false,
      checkedAt: response.checkedAt ?? Date.now(),
    });
  } catch (error) {
    publish({
      results: CONNECTIVITY_TARGETS.map(({ id }) => ({ id, level: 'failed', delay: null })),
      running: false,
      checkedAt: Date.now(),
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export const CONNECTIVITY_PREVIEW: ConnectivitySnapshot = {
  results: [
    { id: 'google', level: 'good', delay: 128 },
    { id: 'youtube', level: 'good', delay: 156 },
    { id: 'github', level: 'fair', delay: 412 },
    { id: 'chatgpt', level: 'good', delay: 233 },
    { id: 'telegram', level: 'good', delay: 187 },
    { id: 'cloudflare', level: 'good', delay: 38 },
  ],
  running: false,
  checkedAt: 1,
};

export function useConnectivitySnapshot() {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}
