type Result = number | null;
type Task = {
  name: string;
  generation: number;
  promise: Promise<Result>;
  resolve: (result: Result) => void;
};

/** A shared, bounded queue: duplicate node names share one request across groups. */
export function createNodeLatencyTester(options: {
  probe: (name: string, isCurrent: () => boolean) => Promise<number>;
  onPending: (names: Set<string>) => void;
  onResult: (name: string, delay: number) => void;
  concurrency?: number;
}) {
  const limit = Math.max(1, Math.min(16, Math.floor(options.concurrency ?? 5)));
  const pending = new Map<string, Task>();
  let queue: Task[] = [];
  let generation = 0;
  let running = 0;
  let disposed = false;

  const notify = () => { if (!disposed) options.onPending(new Set(pending.keys())); };
  const pump = () => {
    while (!disposed && running < limit && queue.length) {
      const task = queue.shift()!;
      running++;
      void run(task);
    }
  };
  const run = async (task: Task) => {
    const isCurrent = () => !disposed && task.generation === generation;
    let result: Result = 0;
    try {
      const delay = await options.probe(task.name, isCurrent);
      result = Number.isFinite(delay) && delay > 0 ? delay : 0;
    } catch {
      result = 0;
    }
    if (isCurrent()) {
      pending.delete(task.name);
      options.onResult(task.name, result);
      notify();
    } else {
      result = null;
    }
    task.resolve(result);
    running--;
    pump();
  };
  const cancel = () => {
    generation++;
    for (const task of pending.values()) task.resolve(null);
    pending.clear();
    queue = [];
    notify();
  };

  return {
    async test(names: string[]) {
      if (disposed) return { successCount: 0, failCount: 0, cancelled: true };
      const tasks = [...new Set(names)].map(name => {
        const existing = pending.get(name);
        if (existing) return existing.promise;
        let resolve!: Task['resolve'];
        const promise = new Promise<Result>(callback => { resolve = callback; });
        const task = { name, generation, promise, resolve };
        pending.set(name, task);
        queue.push(task);
        return promise;
      });
      notify();
      pump();
      const results = await Promise.all(tasks);
      return {
        successCount: results.filter(result => result !== null && result > 0).length,
        failCount: results.filter(result => result === 0).length,
        cancelled: results.some(result => result === null),
      };
    },
    cancel,
    dispose() { disposed = true; cancel(); },
  };
}
