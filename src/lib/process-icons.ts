type IconStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const PREFIX = 'process-icon:v3:';
const SUCCESS_TTL = 24 * 60 * 60 * 1000;
const FAILURE_TTL = 30 * 1000;
const validIcon = (value: unknown): value is string => typeof value === 'string'
  && value.length < 512 * 1024 && /^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(value);

export function processIconKey(path?: string | null, name?: string | null): string | null {
  const input = path?.trim() || '', hint = name?.trim() || '';
  return input || hint ? JSON.stringify([input, hint]) : null;
}

export function createProcessIconLoader(options: {
  request: (path: string, name: string) => Promise<unknown>;
  storage?: () => IconStorage | undefined;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const cache = new Map<string, { value: string | null; expires: number }>();
  const inFlight = new Map<string, Promise<string | null>>();
  const queue: Array<() => Promise<void>> = [];
  let running = 0;
  const remember = (key: string, value: string | null) => {
    cache.delete(key);
    cache.set(key, { value, expires: now() + (value ? SUCCESS_TTL : FAILURE_TTL) });
    while (cache.size > 128) cache.delete(cache.keys().next().value!);
  };
  const pump = () => {
    while (running < 2 && queue.length) {
      running++;
      void queue.shift()!().finally(() => { running--; pump(); });
    }
  };
  return {
    load(key: string): Promise<string | null> {
      const cached = cache.get(key);
      if (cached && cached.expires > now()) return Promise.resolve(cached.value);
      const existing = inFlight.get(key);
      if (existing) return existing;
      let request: [string, string];
      try {
        request = JSON.parse(key);
        if (!Array.isArray(request) || request.length !== 2 || request.some(value => typeof value !== 'string' || value.includes('\0'))) return Promise.resolve(null);
      } catch { return Promise.resolve(null); }
      try {
        const stored = JSON.parse(options.storage?.()?.getItem(PREFIX + key) || 'null');
        if (stored && validIcon(stored.value) && stored.expires > now()) {
          remember(key, stored.value); return Promise.resolve(stored.value);
        }
      } catch { /* Storage is optional (private mode/quota/disabled storage). */ }
      let resolve!: (value: string | null) => void;
      const promise = new Promise<string | null>(done => { resolve = done; });
      inFlight.set(key, promise);
      queue.push(async () => {
        let value: string | null = null;
        try {
          const result = await options.request(request[0] || request[1], request[1]);
          if (validIcon(result)) value = result;
          remember(key, value);
          if (value) {
            try { options.storage?.()?.setItem(PREFIX + key, JSON.stringify({ value, expires: now() + SUCCESS_TTL })); } catch { /* Quota should never break UI. */ }
          }
        } catch { remember(key, null); }
        finally { inFlight.delete(key); resolve(value); }
      });
      pump();
      return promise;
    },
    invalidate(key: string) {
      remember(key, null);
      try { options.storage?.()?.removeItem(PREFIX + key); } catch { /* Optional cache. */ }
    },
  };
}

const loader = createProcessIconLoader({
  request: async (path, name) => typeof window === 'undefined' ? null : window.electronAPI?.getIconDataURL?.(path, name),
  storage: () => typeof window === 'undefined' ? undefined : window.localStorage,
});
export const loadProcessIcon = (key: string) => loader.load(key);
export const invalidateProcessIcon = (key: string) => loader.invalidate(key);
