import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const timers = new Map(); let nextTimer = 0;
const module = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/group-latency.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { module, exports: module.exports,
  setTimeout: callback => { const id = ++nextTimer; timers.set(id, callback); return id; },
  clearTimeout: id => timers.delete(id),
});
const { createGroupLatencyTester, GROUP_LATENCY_URL } = module.exports;
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const runTimer = () => { const [id, callback] = timers.entries().next().value; timers.delete(id); callback(); };
const time = 20000;
const snapshot = (entries, url = GROUP_LATENCY_URL) => ({ proxies: Object.fromEntries(entries.map(([name, delay, timestamp]) =>
  [name, { extra: { [url]: { history: [{ time: new Date(timestamp).toISOString(), delay }] } } }])) });
function setup() {
  const work = deferred();
  const writes = [], pending = [], starts = [];
  let data = snapshot([]), reads = 0;
  const tester = createGroupLatencyTester({
    now: () => time,
    probeGroup: group => { starts.push(group); return work.promise; },
    baselineSnapshot: () => snapshot([['fast', 28, time - 1000]]),
    readSnapshot: async () => { reads++; return data; },
    onPending: names => pending.push([...names]),
    onResults: results => writes.push({ ...results }),
  });
  return { tester, work, writes, pending, starts, reads: () => reads, setData: value => { data = value; } };
}

const first = setup();
const names = ['fast', 'slow', ...Array.from({ length: 40 }, (_, index) => `node-${index}`)];
let done = false;
const result = first.tester.test('group', names).then(value => { done = true; return value; });
assert.deepEqual(first.starts, ['group'], 'one native group call starts immediately for all members');
assert.equal(first.reads(), 0, 'no progress preflight before the core test starts');
assert.equal(first.pending.at(-1).length, 42);
first.setData(snapshot([['fast', 28, time - 1000], ['slow', 50, time - 1]]));
runTimer(); await tick();
assert.equal(first.writes.length, 0, 'cached records are not presented as fresh results');
first.setData(snapshot([['fast', 28, time + 1], ['slow', 50, time - 1]]));
runTimer(); await tick();
assert.deepEqual(first.writes.at(-1), { fast: 28 }, 'same delay with a new timestamp still finishes this item');
assert.equal(first.pending.at(-1).includes('fast'), false);
assert.equal(first.pending.at(-1).includes('slow'), true);
assert.equal(done, false, 'progress arrives while slow native tests are still running');
first.setData(snapshot([['slow', 1, time + 2]], 'https://another-test.example/'));
runTimer(); await tick();
assert.equal(first.writes.length, 1, 'other test URL histories are ignored');
first.work.resolve({ fast: 29, slow: 80 });
const summary = await result;
assert.equal(summary.successCount, 2);
assert.equal(summary.failCount, 40);
assert.equal(first.writes.at(-1).fast, 29, 'final native result remains authoritative');
assert.equal(timers.size, 0);

// A slow progress request never delays the authoritative result or writes after completion.
const core = deferred(), poll = deferred(); let writes = 0;
const independent = createGroupLatencyTester({ now: () => time, baselineSnapshot: () => null,
  probeGroup: () => core.promise, readSnapshot: () => poll.promise,
  onPending() {}, onResults() { writes++; },
});
const independentResult = independent.test('group', ['node']);
runTimer();
core.resolve({ node: 36 });
assert.equal((await independentResult).successCount, 1);
poll.resolve(snapshot([['node', 999, time + 10]]));
await tick();
assert.equal(writes, 1);
assert.equal(timers.size, 0);

const cancelled = setup();
const old = cancelled.tester.test('group', ['node']);
assert.equal(cancelled.tester.test('group', ['node']), old, 'repeated group clicks reuse the in-flight job');
cancelled.tester.cancel();
assert.equal((await old).cancelled, true);
cancelled.work.resolve({ node: 123 });
await tick();
assert.equal(cancelled.writes.length, 0);
assert.equal(timers.size, 0);
cancelled.tester.dispose();
assert.equal((await cancelled.tester.test('ignored', ['node'])).cancelled, true);
console.log('✓ 整组只发起一次原生并行测试、无需逐节点排队、逐项显示新记录、过滤旧历史与其他测试地址、进度请求不拖慢最终完成、取消与旧结果隔离');
