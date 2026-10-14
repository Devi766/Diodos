export const GROUP_LATENCY_URL = 'http://www.gstatic.com/generate_204';
type Summary = { successCount: number; failCount: number; cancelled: boolean; error?: unknown };
type Job = {
  group: string;
  names: Set<string>;
  pending: Set<string>;
  values: Record<string, number>;
  baseline: Map<string, string>;
  startedAt: number;
  promise: Promise<Summary>;
  resolve: (value: Summary) => void;
};

function latestHistory(snapshot: any, name: string) {
  const history = snapshot?.proxies?.[name]?.extra?.[GROUP_LATENCY_URL]?.history;
  if (!Array.isArray(history)) return undefined;
  const record = history.at(-1);
  if (!record || typeof record.time !== 'string' || !Number.isFinite(Date.parse(record.time))
    || typeof record.delay !== 'number' || !Number.isFinite(record.delay)) return undefined;
  return { time: record.time, delay: record.delay > 0 ? record.delay : 0 };
}

/** Keep the core's parallel group test; observe history without launching more probes. */
export function createGroupLatencyTester(options: {
  probeGroup: (group: string, isCurrent: () => boolean) => Promise<Record<string, number>>;
  readSnapshot: () => Promise<unknown>;
  baselineSnapshot: () => unknown;
  onPending: (names: Set<string>) => void;
  onResults: (values: Record<string, number>) => void;
  interval?: number;
  now?: () => number;
}) {
  const jobs = new Map<string, Job>();
  const now = options.now ?? Date.now;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let polling = false;
  let generation = 0;
  const isCurrent = (job: Job) => !disposed && jobs.get(job.group) === job;
  const notify = () => {
    if (!disposed) options.onPending(new Set([...jobs.values()].flatMap(job => [...job.pending])));
  };
  const schedule = () => {
    if (!disposed && jobs.size && !timer && !polling) timer = setTimeout(() => { void poll(); }, options.interval ?? 200);
  };
  const poll = async () => {
    timer = undefined;
    if (disposed || !jobs.size) return;
    polling = true;
    const epoch = generation;
    const observed = [...jobs.values()];
    try {
      const snapshot = await options.readSnapshot();
      if (disposed || epoch !== generation) return;
      const changed: Record<string, number> = Object.create(null);
      for (const job of observed) {
        if (!isCurrent(job)) continue;
        for (const name of job.pending) {
          const record = latestHistory(snapshot, name);
          if (!record || record.time === job.baseline.get(name) || Date.parse(record.time) < job.startedAt) continue;
          job.values[name] = record.delay;
          job.pending.delete(name);
          changed[name] = record.delay;
        }
      }
      if (Object.keys(changed).length) { options.onResults(changed); notify(); }
    } catch {
      // Progress is best-effort; the authoritative group response remains independent.
    } finally {
      polling = false;
      schedule();
    }
  };
  const finish = async (job: Job) => {
    let error: unknown;
    let final: Record<string, number> | undefined;
    try { final = await options.probeGroup(job.group, () => isCurrent(job)); }
    catch (reason) { error = reason; }
    if (!isCurrent(job)) return;
    const updates: Record<string, number> = Object.create(null);
    for (const name of job.names) {
      const value = final?.[name];
      // Missing members in a completed group response timed out. A transport error
      // does not invalidate fresh results already observed in the core's history.
      updates[name] = final ? (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0)
        : job.values[name] ?? 0;
    }
    jobs.delete(job.group);
    if (!jobs.size) { clearTimeout(timer); timer = undefined; }
    options.onResults(updates);
    notify();
    const values = Object.values(updates);
    job.resolve({ successCount: values.filter(value => value > 0).length,
      failCount: values.filter(value => value === 0).length, cancelled: false, error });
  };
  const cancel = () => {
    generation++;
    clearTimeout(timer); timer = undefined;
    for (const job of jobs.values()) job.resolve({ successCount: 0, failCount: 0, cancelled: true });
    jobs.clear();
    notify();
  };
  return {
    test(group: string, names: string[]) {
      if (disposed) return Promise.resolve({ successCount: 0, failCount: 0, cancelled: true } as Summary);
      const existing = jobs.get(group);
      if (existing) return existing.promise;
      let resolve!: Job['resolve'];
      const promise = new Promise<Summary>(callback => { resolve = callback; });
      const unique = new Set(names);
      const snapshot = options.baselineSnapshot();
      const baseline = new Map([...unique].flatMap(name => {
        const record = latestHistory(snapshot, name);
        return record ? [[name, record.time] as [string, string]] : [];
      }));
      const job = { group, names: unique, pending: new Set(unique), values: Object.create(null), baseline, startedAt: now(), promise, resolve };
      jobs.set(group, job);
      notify();
      // Launch immediately: no history preflight, polling or UI work gates the core test.
      void finish(job);
      schedule();
      return promise;
    },
    cancel,
    dispose() { disposed = true; cancel(); },
  };
}
