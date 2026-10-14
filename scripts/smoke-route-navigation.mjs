import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function harness() {
  let clock = 0, id = 0;
  const timers = new Map(), idle = new Map(), windowEvents = new Map(), documentEvents = new Map(), loads = [];
  const document = { visibilityState: 'visible', addEventListener: (key, fn) => documentEvents.set(key, fn), removeEventListener: key => documentEvents.delete(key) };
  const window = { setTimeout: (fn, ms) => { const key = ++id; timers.set(key, { fn, when: clock + ms }); return key; }, clearTimeout: key => timers.delete(key),
    requestIdleCallback: fn => { const key = ++id; idle.set(key, fn); return key; }, cancelIdleCallback: key => idle.delete(key),
    addEventListener: (key, fn) => windowEvents.set(key, fn), removeEventListener: key => windowEvents.delete(key) };
  const module = { exports: {} };
  const source = ts.transpileModule(fs.readFileSync('src/services/route-preload.ts', 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInNewContext(source, { module, exports: module.exports, window, document, navigator: {}, URL, Date: { now: () => clock }, console,
    require: name => { loads.push(name); return { default: () => null }; } });
  const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  const tick = async () => {
    const next = [...timers].sort((a, b) => a[1].when - b[1].when)[0];
    if (!next) return false;
    timers.delete(next[0]); clock = next[1].when; next[1].fn(); await flush(); return true;
  };
  const runIdle = async () => { const next = [...idle][0]; if (!next) return false; idle.delete(next[0]); next[1](); await flush(); return true; };
  return { api: module.exports, loads, timers, idle, windowEvents, documentEvents, document, tick, runIdle, flush };
}

{
  const h = harness(); const a = h.api.preloadRouteModule('/nodes'), b = h.api.preloadRouteModule('/nodes');
  assert.equal(a, b); await Promise.all([a, b]); await h.api.preloadRouteModule('/nodes');
  assert.equal(h.loads.length, 1);
}
{
  const h = harness(); const stop = h.api.scheduleRouteModuleWarmup(['/nodes', '/subscriptions']);
  assert.equal(h.loads.length, 0); await h.tick(); assert.equal(h.loads.length, 0);
  await h.runIdle(); assert.equal(h.loads.length, 1);
  await h.tick(); await h.runIdle(); assert.equal(h.loads.length, 2);
  stop(); assert.equal(h.windowEvents.size, 0); assert.equal(h.documentEvents.size, 0);
}
{
  const h = harness(); const stop = h.api.scheduleRouteModuleWarmup(['/settings']);
  await h.tick(); h.windowEvents.get('pointerdown')(); await h.runIdle(); assert.equal(h.loads.length, 0);
  await h.tick(); await h.runIdle(); assert.equal(h.loads.length, 1); stop();
}
{
  const h = harness(); const stop = h.api.scheduleRouteModuleWarmup(['/settings']);
  h.document.visibilityState = 'hidden'; await h.tick(); assert.equal(h.loads.length, 0);
  h.document.visibilityState = 'visible'; h.documentEvents.get('visibilitychange')();
  await h.tick(); await h.runIdle(); assert.equal(h.loads.length, 1); stop();
}
{
  const h = harness(); const stop = h.api.scheduleRouteModuleWarmup(['/settings']); stop();
  assert.equal(h.timers.size, 0); assert.equal(h.idle.size, 0); assert.equal(h.loads.length, 0);
}
const transition = fs.readFileSync('src/components/PageTransition.tsx', 'utf8');
assert(!transition.includes('AnimatePresence')); assert(!transition.includes('key={pathname}'));
assert(transition.includes('reducedMotion="user"'));
const layout = fs.readFileSync('src/components/Layout.tsx', 'utf8');
const warmup = layout.slice(layout.indexOf('const warmRouteData'), layout.indexOf('const handleNavigationClick'));
assert(!warmup.includes('force')); assert(warmup.includes('30_000'));
console.log('✓ 模块预取去重、逐个空闲加载、用户操作让行、隐藏暂停、取消清理');
console.log('✓ 无退出页面副本、保留减少动态效果设置、导航不再强制刷新数据');
