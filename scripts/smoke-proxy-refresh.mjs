import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const timers = new Map();
let timerId = 0;
const module = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/proxy-refresh.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText, {
  module, exports: module.exports,
  setTimeout: fn => { timers.set(++timerId, fn); return timerId; },
  clearTimeout: id => timers.delete(id),
});
const { enrichProxyIcons, createProxyRefreshScheduler } = module.exports;
const skeletonModule = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/components/ProxyNodesSkeleton.tsx', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.React, esModuleInterop: true },
}).outputText, { module: skeletonModule, exports: skeletonModule.exports, require: () => React });
const skeleton = renderToStaticMarkup(React.createElement(skeletonModule.exports.ProxyNodesSkeleton, { label: '加载中' }));
assert.equal((skeleton.match(/min-h-\[88px\]/g) ?? []).length, 6);
assert.ok(skeleton.includes('role="status"'));
assert.ok(skeleton.includes('aria-busy="true"'));
assert.ok(skeleton.includes('motion-safe:animate-pulse'));
assert.ok(!skeleton.includes('animate-spin'));
const badgeModule = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/components/NodeLatencyBadge.tsx', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.React, esModuleInterop: true },
}).outputText, { module: badgeModule, exports: badgeModule.exports, require: () => React });
for (const props of [{ testing: true, delay: 28 }, { testing: true }, { testing: false, delay: 28 }, { testing: false, delay: 0 }]) {
  const markup = renderToStaticMarkup(React.createElement(badgeModule.exports.NodeLatencyBadge, { ...props, loadingLabel: 'Testing', timeoutLabel: 'Timeout' }));
  const outerClass = markup.match(/^<span[^>]*class="([^"]+)"/)?.[1];
  assert.ok(outerClass?.split(' ').includes('h-5'), 'loading and result badges both reserve 20px');
  if (props.testing) assert.ok(!/\bbg-|\brounded-full/.test(outerClass), 'spinner has no capsule background');
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
function runTimer() { const [id, fn] = timers.entries().next().value; timers.delete(id); fn(); }

const iconGate = deferred();
let current = true, requested = 0;
const published = [];
const icons = enrichProxyIcons(Array.from({ length: 20 }, (_, index) => ({ name: `group-${index}` })),
  async () => { requested++; return iconGate.promise; }, () => current,
  (...args) => published.push(args));
assert.equal(requested, 4, 'remote icon concurrency is capped at four');
// Cancellation prevents both stale publication and downloading the rest of an old profile.
current = false;
iconGate.resolve({ success: true, iconPath: 'stale-icon' });
await icons;
assert.equal(requested, 4);
assert.equal(published.length, 0);
await enrichProxyIcons([{ name: 'ok' }, { name: 'failed' }], async name => {
  if (name === 'failed') throw Error('offline');
  return { success: true, iconPath: 'brand-icon' };
}, () => true, (...args) => published.push(args));
assert.deepEqual(published, [['ok', 'brand-icon']]);

let refreshes = 0, concurrent = 0, maxConcurrent = 0;
const snapshotGate = deferred();
const scheduler = createProxyRefreshScheduler(async () => {
  refreshes++; concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent);
  if (refreshes === 1) await snapshotGate.promise;
  concurrent--;
});
for (let index = 0; index < 6; index++) scheduler.schedule();
assert.equal(timers.size, 1, 'event burst produces one timer');
runTimer();
for (let index = 0; index < 6; index++) scheduler.schedule();
assert.equal(refreshes, 1);
assert.equal(timers.size, 0, 'in-flight refresh is not duplicated');
snapshotGate.resolve();
await tick();
assert.equal(timers.size, 1);
runTimer();
await tick();
assert.equal(refreshes, 2, 'latest queued state is refreshed once');
assert.equal(maxConcurrent, 1);
scheduler.schedule();
scheduler.dispose();
assert.equal(timers.size, 0);
scheduler.schedule();
assert.equal(timers.size, 0);

const source = fs.readFileSync('src/components/ProxyNodes.tsx', 'utf8');
const refresh = source.slice(source.indexOf('  const fetchProxies = async'), source.indexOf('  const scheduleSoftRefresh'));
assert.ok(!/await.*getGroupIcon/.test(refresh));
assert.ok(refresh.indexOf('setGroups(nextGroupsData)') < refresh.indexOf('void enrichProxyIcons'));
assert.ok(!refresh.includes('mihomoAPI.version()'));
const events = source.slice(source.indexOf('// 初始加载以及'), source.indexOf('// 监听全局滚动'));
assert.ok(!events.includes('setGroups([])'));
assert.ok(events.includes('setIsSnapshotStale(true)'));
assert.ok(source.includes("isSnapshotStale && !(event.target as HTMLElement).closest('[data-proxy-refresh]')"));
assert.ok(!source.includes('min-h-[260px]" aria-busy="true" />'));
assert.ok(source.includes('suppressColdEmptyState || (isSnapshotStale && isRefreshing)'));
assert.ok(source.includes('<ProxyNodesSkeleton label={t(\'common.loading\')} toolbar={false} />'));
assert.ok(source.includes('flex min-h-5 justify-between items-center'), 'untested nodes reserve the same latency row height');
const subscriptions = fs.readFileSync('src/components/Subscription.tsx', 'utf8');
assert.ok(!subscriptions.includes('const refreshProxies = async (attempt'));
const native = fs.readFileSync('src-tauri/src/runtime_commands.rs', 'utf8');
const reload = native.slice(native.indexOf('async fn reload_mihomo_config('), native.indexOf('async fn restart_service('));
assert.ok(reload.includes('spawn_blocking(move ||'));
console.log('✓ 图标慢请求不阻塞节点显示、并发上限、旧请求隔离、刷新事件合并、单构建互斥、旧快照只读、移除重复轮询与同步托盘等待');
