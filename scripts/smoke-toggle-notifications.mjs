import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const dashboard = fs.readFileSync('src/components/Dashboard.tsx', 'utf8');
const start = dashboard.indexOf('  const handleProxyToggle = async');
const end = dashboard.indexOf('  const handleTunToggle = async', start);
const notices = [], states = [], refreshed = [];
const context = {
  electron: { toggleSystemProxy: async enabled => ({ success: true, enabled }), toggleTunMode: async enabled => ({ success: true, enabled }) },
  isProxyUpdating: false, isTunUpdating: false,
  showBanner: value => { if (value) notices.push(value); },
  setProxyEnabled: value => states.push(['proxy', value]), setTunEnabled: value => states.push(['tun', value]),
  setIsProxyUpdating() {}, setIsTunUpdating() {}, writeCachedBoolean() {},
  APP_DATA_CACHE_KEYS: { systemProxyEnabled: 'proxy', tunEnabled: 'tun' },
  refreshProxyStatus: async () => refreshed.push('proxy'), refreshTunStatus: async () => refreshed.push('tun'),
  formatDashboardError: (value, fallback) => String(value || fallback), t: key => key,
};
vm.runInNewContext(ts.transpileModule(dashboard.slice(start, end) + '\nglobalThis.handlers = { handleProxyToggle, runTunToggle };', {
  compilerOptions: { target: ts.ScriptTarget.ES2020 },
}).outputText, context);
for (const enabled of [true, false]) {
  await context.handlers.handleProxyToggle(enabled);
  await context.handlers.runTunToggle(enabled);
}
assert.deepEqual(states, [['proxy', true], ['tun', true], ['proxy', false], ['tun', false]]);
assert.equal(notices.length, 0);
context.electron.toggleSystemProxy = async () => ({ success: false, error: 'failed' });
context.electron.toggleTunMode = async () => { throw Error('failed'); };
await context.handlers.handleProxyToggle(true);
await context.handlers.runTunToggle(true);
assert.equal(notices.length, 2);
assert.ok(notices.every(notice => notice.type === 'error'));
assert.deepEqual(refreshed, ['proxy', 'tun']);
assert.ok(!dashboard.includes("showBanner({ type: 'success', message: t('dashboard.tunPermissionGranted')"));

const layout = fs.readFileSync('src/components/Layout.tsx', 'utf8');
const callbackStart = layout.indexOf('    const cleanup = window.electronAPI.onTrayAction(');
const callbackEnd = layout.indexOf('\n    return () => {', callbackStart);
const toasts = [], synced = [];
const tray = {
  window: { electronAPI: { onTrayAction: handler => { tray.handler = handler; } } },
  isRecord: value => value && typeof value === 'object',
  didSucceed: value => value?.success === true,
  showToast: value => toasts.push(value), successMessage: () => 'success',
  notifyProfileChanged: action => synced.push(action),
  readString: (record, field) => record?.[field], labels: {}, t: key => key,
};
vm.runInNewContext(ts.transpileModule(layout.slice(callbackStart, callbackEnd), {
  compilerOptions: { target: ts.ScriptTarget.ES2020 },
}).outputText, tray);
for (const action of ['toggle-system-proxy', 'toggle-tun']) tray.handler({ action, result: { success: true } });
assert.equal(toasts.length, 0);
assert.equal(synced.length, 2);
tray.handler({ action: 'restart-core', result: { success: true } });
tray.handler({ action: 'toggle-tun', result: { success: false, error: 'failed' } });
assert.deepEqual(toasts.map(toast => toast.type), ['success', 'error']);
console.log('✓ 代理/TUN 开关成功静默、状态正常同步、失败仍提示、托盘一致、其他操作通知保留');
