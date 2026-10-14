/** Publish the node tree first; slow or failed remote icons never gate it. */
export async function enrichProxyIcons<T extends { name: string; icon?: string | null }>(
  groups: T[],
  resolve: (name: string, icon?: string | null) => Promise<{ success?: boolean; iconPath?: string | null } | undefined>,
  isCurrent: () => boolean,
  publish: (name: string, icon: string | null) => void,
) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, groups.length) }, async () => {
    while (isCurrent() && cursor < groups.length) {
      const group = groups[cursor++];
      try {
        const result = await resolve(group.name, group.icon);
        if (isCurrent() && result?.success) publish(group.name, result.iconPath ?? null);
      } catch {
        // Retain the config icon / generic fallback on failure.
      }
    }
  }));
}

/** Merge event bursts and never run two expensive snapshot builds concurrently. */
export function createProxyRefreshScheduler(refresh: () => Promise<void>, delay = 40) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let queued = false;
  let disposed = false;
  const run = async () => {
    timer = undefined;
    if (disposed) return;
    queued = false;
    running = true;
    try { await refresh(); }
    catch { /* Refresh owns its user-visible error state. */ }
    finally {
      running = false;
      if (queued && !disposed) timer = setTimeout(() => { void run(); }, delay);
    }
  };
  return {
    schedule() {
      if (disposed) return;
      queued = true;
      if (!running) {
        clearTimeout(timer);
        timer = setTimeout(() => { void run(); }, delay);
      }
    },
    dispose() { disposed = true; clearTimeout(timer); },
  };
}
