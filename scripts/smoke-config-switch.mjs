import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { createI18nRuntime } from './i18n-test-runtime.mjs';

const { uiText, i18n } = createI18nRuntime();
await i18n.changeLanguage('zh-CN');

// Exercise the actual component handlers without mounting the subscription UI.
const source = fs.readFileSync('src/components/Subscription.tsx', 'utf8');
const handlers = source.slice(source.indexOf('  const loadActiveConfig = async'), source.indexOf('  const loadSubscriptions = async'));
const code = ts.transpileModule(`${handlers}\nglobalThis.handlers = { switchConfig, loadActiveConfig };`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function setup(overrides = {}, close = async () => {}) {
  const calls = [], timers = [];
  const api = {
    isMihomoRunning: async () => true,
    reloadMihomoConfig: async path => { calls.push(['reload', path]); return { success: true }; },
    setPreferredConfig: async path => { calls.push(['preferred', path]); return { success: true }; },
    startMihomo: async path => { calls.push(['start', path]); return { success: true }; },
    stopMihomo: async () => { calls.push(['stop']); return { success: true }; },
    getActiveConfig: async () => 'old',
    getProxies: async () => { calls.push(['proxies']); return { groups: [{ now: 'node' }] }; },
    ...overrides,
  };
  const context = {
    uiText,
    window: { electronAPI: api, setTimeout: fn => timers.push(fn) }, console,
    activeConfig: 'old', isServiceRunning: false,
    switchSeqRef: { current: 0 }, switchTargetRef: { current: null },
    switchCleanupRef: { current: Promise.resolve() },
    hasElectronMethod: (object, key) => typeof object?.[key] === 'function',
    compatSuccess: result => result?.success === true,
    compatError: result => result?.error || 'error', formatSubscriptionError: String,
    runtimeReloadFromResult: result => result?.reloaded,
    activeConfigPath: value => value,
    updateActiveConfig: path => calls.push(['active', path]),
    setSwitchingConfig: path => calls.push(['busy', path]),
    setIsServiceRunning: running => calls.push(['running', running]),
    showToast: (...args) => calls.push(['toast', ...args]), t: key => key,
    notifyProfileUpdated: event => calls.push(['event', event.action]),
    refreshProvidersAvailability: () => {},
    require: () => ({ mihomoClient: { closeAllConnections: async () => { calls.push(['close']); await close(); } } }),
  };
  vm.runInNewContext(code, context);
  return { ...context.handlers, context, calls, timers };
}

// Stale UI says stopped, authoritative runtime says running: reload, never preferred-only.
const live = setup();
assert.equal(await live.switchConfig('new'), true);
assert.deepEqual(live.calls.filter(c => ['reload', 'preferred', 'start', 'stop'].includes(c[0])), [['reload', 'new']]);
assert.ok(live.calls.findIndex(c => c[0] === 'reload') < live.calls.findIndex(c => c[0] === 'active'));
assert.equal(live.context.switchTargetRef.current, null);
assert.ok(!live.calls.some(c => c[0] === 'proxies'), 'subscription page does not poll the entire proxy tree');
assert.ok(live.calls.some(c => c[0] === 'event' && c[1] === 'switch-config'));

const failed = setup({ reloadMihomoConfig: async () => ({ success: false, error: 'bad yaml', configError: true }) });
assert.equal(await failed.switchConfig('bad'), false);
assert.ok(!failed.calls.some(c => ['start', 'stop'].includes(c[0])));
assert.ok(!failed.calls.some(c => c[0] === 'active' && c[1] === 'bad'));
assert.equal(failed.context.switchTargetRef.current, null);

const stopped = setup({ isMihomoRunning: async () => false });
assert.equal(await stopped.switchConfig('new'), true);
assert.ok(stopped.calls.some(c => c[0] === 'preferred'));
assert.ok(!stopped.calls.some(c => c[0] === 'reload'));

const gate = deferred();
const concurrent = setup({ reloadMihomoConfig: () => gate.promise });
const first = concurrent.switchConfig('first');
assert.equal(await concurrent.switchConfig('second'), false);
gate.resolve({ success: true });
assert.equal(await first, true);

const poll = deferred();
const racing = setup({ getActiveConfig: () => poll.promise });
const pendingPoll = racing.loadActiveConfig();
await racing.switchConfig('new');
poll.resolve('old');
await pendingPoll;
assert.ok(!racing.calls.some(c => c[0] === 'active' && c[1] === 'old'));

// Slow cleanup must not hold the UI spinner, or close connections for a newer profile.
const cleanup = deferred();
const background = setup({}, () => cleanup.promise);
assert.equal(await background.switchConfig('first'), true);
assert.equal(background.context.switchTargetRef.current, null);
const next = background.switchConfig('second');
await new Promise(r => setImmediate(r));
assert.equal(background.calls.filter(c => c[0] === 'reload').length, 1);
cleanup.resolve();
assert.equal(await next, true);
assert.equal(background.calls.filter(c => c[0] === 'reload').length, 2);
assert.ok(source.includes('(switchingConfig ?? activeConfig) === sub.path'));
assert.ok(!source.includes('bg-white/80 dark:bg-gray-900/80'));

const backend = fs.readFileSync('src-tauri/src/core_lifecycle_commands.rs', 'utf8');
const reload = backend.slice(backend.indexOf('pub(crate) async fn reload_mihomo_config('), backend.indexOf('pub(crate) async fn refresh_active_config_after_override('));
assert.ok(!reload.includes('Some("/proxies"'), 'no redundant proxy-tree request before acknowledgement');
console.log('✓ 运行状态实时确认、热重载、停服首选、失败保留旧配置、连续点击互斥、轮询防回退、完成后后台刷新');
