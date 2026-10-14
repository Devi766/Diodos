import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const module = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/node-latency.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText, { module, exports: module.exports });
const { createNodeLatencyTester } = module.exports;
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

const gates = new Map(), started = [], results = [], snapshots = [];
const tester = createNodeLatencyTester({ concurrency: 2,
  probe: name => { started.push(name); const gate = deferred(); gates.set(name, gate); return gate.promise; },
  onPending: names => snapshots.push([...names]),
  onResult: (name, delay) => results.push([name, delay]),
});
let finished = false;
const group = tester.test(['a', 'b', 'c']).then(result => { finished = true; return result; });
assert.deepEqual(started, ['a', 'b']);
assert.deepEqual(snapshots[0], ['a', 'b', 'c']);
gates.get('b').resolve(28);
await tick();
assert.deepEqual(results, [['b', 28]]);
assert.equal(finished, false, 'fast results are published before the group finishes');
assert.deepEqual(snapshots.at(-1), ['a', 'c']);
assert.deepEqual(started, ['a', 'b', 'c'], 'next work starts without waiting for slow a');
gates.get('c').reject(Error('timeout'));
await tick();
assert.deepEqual(results.at(-1), ['c', 0]);
assert.deepEqual(snapshots.at(-1), ['a']);
gates.get('a').resolve(90);
const summary = await group;
assert.equal(summary.successCount, 2);
assert.equal(summary.failCount, 1);
assert.equal(summary.cancelled, false);
assert.deepEqual(snapshots.at(-1), []);

const duplicateGate = deferred();
let requests = 0;
const shared = createNodeLatencyTester({ probe: async () => { requests++; return duplicateGate.promise; }, onPending() {}, onResult() {} });
const first = shared.test(['same', 'same']);
const second = shared.test(['same']);
assert.equal(requests, 1, 'duplicate nodes share a request across overlapping group tests');
duplicateGate.resolve(20);
assert.equal((await first).successCount, 1);
assert.equal((await second).successCount, 1);

const oldGate = deferred(), newGate = deferred(), published = [];
let probes = 0;
const cancellable = createNodeLatencyTester({ concurrency: 1,
  probe: () => (++probes === 1 ? oldGate.promise : newGate.promise),
  onPending() {}, onResult: (name, value) => published.push([name, value]),
});
const old = cancellable.test(['same', 'queued-old']);
cancellable.cancel();
assert.equal((await old).cancelled, true);
const current = cancellable.test(['same']);
assert.equal(probes, 1, 'old in-flight work still occupies a physical concurrency slot');
oldGate.resolve(999);
await tick();
assert.equal(probes, 2);
assert.deepEqual(published, [], 'old profile results are discarded');
newGate.resolve(36);
assert.equal((await current).successCount, 1);
assert.deepEqual(published, [['same', 36]]);
cancellable.dispose();
assert.equal((await cancellable.test(['ignored'])).cancelled, true);

const source = fs.readFileSync('src/components/ProxyNodes.tsx', 'utf8');
assert.ok(source.includes('mihomoAPI.groupDelay('));
assert.ok(source.includes('getGroupLatencyTester().test(groupName,'));
assert.ok(source.includes('const isTesting = testingNodes.has(node.name)'));
assert.ok(!source.includes('groupTesting || testingNodes.has'));
assert.ok(source.includes('cancelLatencyTests();'));
assert.ok(source.includes("if (!isCurrent()) throw new Error('latency_cancelled')"));
console.log('✓ 逐项即时显示、独立停止转圈、并发池不断档、重叠组节点去重、超时回填、切配置取消与旧结果隔离');
