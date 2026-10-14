import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import ts from 'typescript';

const require = createRequire(import.meta.url);
function loadTs(file, overrides = {}) {
  const filename = path.resolve(file);
  const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(source, { module, exports: module.exports, require: name => overrides[name] ?? require(name) }, { filename });
  return module.exports;
}

const { migrateLegacyControlCards, DEFAULT_DASHBOARD_CARDS, DASHBOARD_CARD_DEFINITIONS } = loadTs('src/types/dashboard.ts');
const old = (type, enabled, order, id = type) => ({ id, type, enabled, order });
const migrated = migrateLegacyControlCards([old('system-proxy', true, 7), old('tun-mode', true, 4)]);
assert.equal(migrated.length, 1);
assert.equal(migrated[0].type, 'network-control');
assert.equal(migrated[0].enabled, true);
assert.equal(migrated[0].order, 4);
assert.equal(migrateLegacyControlCards([old('system-proxy', false, 1), old('tun-mode', false, 2)])[0].enabled, false);
assert.equal(migrateLegacyControlCards([old('system-proxy', false, 1), old('tun-mode', true, 9, 'tun-mode#abcdefgh')])[0].order, 9);
assert.equal(migrateLegacyControlCards([old('system-proxy', true, 1, 'system-proxy-card')])[0].type, 'network-control');
const removed = old('network-control', false, 10);
assert.equal(migrateLegacyControlCards([removed, old('system-proxy', true, 1)])[0], removed);
assert.equal(DEFAULT_DASHBOARD_CARDS.filter(card => card.type === 'network-control').length, 1);
assert(!DASHBOARD_CARD_DEFINITIONS.some(card => ['system-proxy', 'tun-mode'].includes(card.type)));
assert.equal(DASHBOARD_CARD_DEFINITIONS.find(card => card.type === 'network-control').variants[0].width, 'half');
console.log('✓ 旧布局合并、排序、禁用状态与新卡片优先级');

const headings = loadTs('src/components/dashboard-cards/CardHeading.tsx', { '@/lib/dashboard-icons': loadTs('src/lib/dashboard-icons.ts'), '@/lib/utils': { cn: (...values) => values.filter(Boolean).join(' ') } });
const { NetworkControlCard } = loadTs('src/components/dashboard-cards/NetworkControlCard.tsx', {
  './CardHeading': headings,
  '@/lib/utils': { cn: (...values) => values.filter(Boolean).join(' ') },
  'react-i18next': { useTranslation: () => ({ t: key => key }) },
});
const calls = [];
const props = {
  proxyEnabled: false, proxyUpdating: false, onProxyToggle: value => calls.push(['proxy', value]),
  tunEnabled: false, tunUpdating: false, tunAvailable: true, isRunning: true, onTunToggle: value => calls.push(['tun', value]),
};
const tiles = value => NetworkControlCard(value).props.children[1].props.children.map(tile => tile.type(tile.props));
const [proxy, tun] = tiles(props);
assert.equal(proxy.props.role, 'switch');
assert.equal(tun.props.role, 'switch');
proxy.props.onClick();
tun.props.onClick();
assert.deepEqual(calls, [['proxy', true], ['tun', true]]);
assert.equal(tiles({ ...props, proxyEnabled: true })[0].props['aria-checked'], true);
assert.equal(tiles({ ...props, tunEnabled: true })[1].props['aria-checked'], true);
assert.equal(tiles({ ...props, isRunning: false })[1].props.disabled, true);
assert.equal(tiles({ ...props, tunAvailable: false })[1].props.disabled, true);
assert.equal(tiles({ ...props, proxyUpdating: true })[0].props.disabled, true);
assert.equal(tiles({ ...props, tunUpdating: true })[1].props.disabled, true);
assert(tiles({ ...props, preview: true }).every(tile => tile.props.disabled));
console.log('✓ 两个开关独立回调、状态、忙碌、内核/权限限制与只读预览');

for (const locale of ['zh-CN', 'en-US']) {
  const dictionary = JSON.parse(fs.readFileSync(`src/i18n/locales/${locale}.json`, 'utf8'));
  assert(dictionary.dashboard.cardMeta['network-control'].title);
  for (const key of ['title', 'active', 'inactive', 'startCore', 'tunUnavailable']) assert(dictionary.dashboard.networkControl[key]);
}
console.log('✓ 中英文文案完整');
