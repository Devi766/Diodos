import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';

const require = createRequire(import.meta.url);
function load(file, overrides = {}, append = '') {
  const source = ts.transpileModule(fs.readFileSync(file, 'utf8') + append, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(source, { module, exports: module.exports, require: name => overrides[name] ?? require(name) }, { filename: file });
  return module.exports;
}
const model = load('src/types/dashboard.ts');
const { migrateLegacyMetricCards: migrate, resolveCardVariant, DEFAULT_DASHBOARD_CARDS, DASHBOARD_CARD_DEFINITIONS } = model;
const old = (type, enabled, order, id = type) => ({ id, type, enabled, order });
const legacy = ['connections', 'download', 'upload', 'total'].map((name, order) => old(`metric-${name}`, true, order));
const merged = migrate(legacy);
assert.equal(merged.length, 1);
assert.equal(merged[0].type, 'network-info');
assert.equal(merged[0].order, 0);
assert.equal(merged[0].enabled, true);
assert.equal(resolveCardVariant('network-info', merged[0].variant).size, 'full');
assert.equal(migrate(legacy.map(card => ({ ...card, enabled: false })))[0].enabled, false);
const disabled = old('network-info', false, 8);
assert.equal(migrate([...legacy, disabled]).find(card => card.id === 'network-info'), disabled);
const copies = migrate([
  ...legacy,
  old('metric-download', true, 7, 'metric-download#abcdefgh'),
  old('metric-upload', true, 8, 'metric-upload#abcdefgh'),
]);
assert.equal(copies.length, 3);
assert.equal(new Set(copies.map(card => card.id)).size, 3);
assert.equal(copies.find(card => card.variant === 'download').order, 7);
assert.equal(copies.find(card => card.variant === 'upload').order, 8);
assert.equal(JSON.stringify(migrate(copies)), JSON.stringify(copies));

const { normalizeDashboardCards } = load('src/hooks/useDashboardCards.ts', {
  '@/types/dashboard': model,
  '@/components/ui/toast': { showToast() {} },
  '@/lib/dashboard-images': { removeDashboardImage() {} },
}, '\nexport { normalizeDashboardCards };');
const normalized = normalizeDashboardCards([...legacy, old('network-control', true, 4)]);
assert.equal(normalized.filter(card => card.enabled && card.type === 'network-info').length, 1);
assert(!normalized.some(card => card.type.startsWith('metric-')));
assert.equal(JSON.stringify(normalizeDashboardCards(JSON.parse(JSON.stringify(normalized)))), JSON.stringify(normalized));
assert.equal(DEFAULT_DASHBOARD_CARDS[0].type, 'network-info');
assert.equal(DEFAULT_DASHBOARD_CARDS[0].enabled, true);
assert(!DASHBOARD_CARD_DEFINITIONS.some(def => def.type.startsWith('metric-')));
assert.equal(DASHBOARD_CARD_DEFINITIONS.find(def => def.type === 'network-info').variants.length, 5);
assert.equal(resolveCardVariant('network-info').size, 'full');
assert.equal(resolveCardVariant('network-info', 'connections').size, 'half');
assert.equal(resolveCardVariant('traffic-chart').size, 'full');
assert.equal(resolveCardVariant('traffic-chart', 'large').size, 'large-full');
assert.equal(resolveCardVariant('subscription-info').size, 'full');
assert.equal(resolveCardVariant('subscription-info', 'large').size, 'large-full');
assert.equal(resolveCardVariant('connectivity-check').size, 'full');
assert.equal(resolveCardVariant('connectivity-check', 'small').size, 'half');
for (const definition of DASHBOARD_CARD_DEFINITIONS) {
  for (const variant of definition.variants) {
    assert(['half', 'full', 'large-full'].includes(variant.size));
    assert.equal(variant.width, variant.size === 'half' ? 'half' : 'full');
  }
}
console.log('✓ 三种尺寸、默认全宽、四个子卡片、旧布局迁移与无损往返');

const headings = load('src/components/dashboard-cards/CardHeading.tsx', { '@/lib/dashboard-icons': load('src/lib/dashboard-icons.ts'), '@/lib/utils': { cn: (...values) => values.filter(Boolean).join(' ') } });
const { NetworkInfoCard } = load('src/components/dashboard-cards/NetworkInfoCard.tsx', {
  './CardHeading': headings,
  'react-i18next': { useTranslation: () => ({ t: key => key }) },
});
const metrics = [
  { label: 'Connections', value: '42', helper: 'Realtime' },
  { label: 'Download', value: '2.4 MB/s', helper: 'Total 20 MB' },
  { label: 'Upload', value: '512 KB/s', helper: 'Total 4 MB' },
  { label: 'Traffic', value: '24 MB', helper: 'Node 01' },
];
const html = renderToStaticMarkup(React.createElement(NetworkInfoCard, { metrics }));
for (const metric of metrics) assert(html.includes(metric.value));
assert(html.includes('Node 01'));
assert(html.includes('dashboard-standard-full-card'));
assert(!html.includes('dashboard-large-card'));
for (const locale of ['zh-CN', 'en-US']) {
  const dict = JSON.parse(fs.readFileSync(`src/i18n/locales/${locale}.json`, 'utf8'));
  assert(dict.dashboard.cardMeta['network-info'].title);
  for (const key of ['sizeHalf', 'sizeFull', 'sizeExtraLargeFull', 'sizeOverview', 'metricConnections', 'metricDownload', 'metricUpload', 'metricTotal', 'networkVariants']) {
    assert(dict.dashboard.widgetLibrary[key]);
  }
}
console.log('✓ 主数值、三分区指标、节点信息与中英文文案');
