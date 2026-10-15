import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { createI18nRuntime } from './i18n-test-runtime.mjs';

const en = JSON.parse(fs.readFileSync('src/i18n/locales/en-US.json', 'utf8'));
const zh = JSON.parse(fs.readFileSync('src/i18n/locales/zh-CN.json', 'utf8'));
const placeholders = value => [...value.matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]).sort();
function compare(a, b, prefix = '') {
  assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort(), `Locale keys: ${prefix}`);
  for (const key of Object.keys(a)) {
    const name = `${prefix}.${key}`;
    if (typeof a[key] === 'object') compare(a[key], b[key], name);
    else {
      assert.equal(typeof b[key], 'string', name);
      assert.ok(b[key].trim(), `Empty translation: ${name}`);
      assert.deepEqual(placeholders(a[key]), placeholders(b[key]), `Interpolation: ${name}`);
      if (name !== '.settings.simplifiedChinese') assert.ok(!/[\u3400-\u9fff]/u.test(b[key]), `Untranslated English: ${name}`);
    }
  }
}
compare(zh, en);

const storage = data => ({ getItem: key => data[key] ?? null });
for (const [data, expected] of [[{}, 'en-US'], [{ language: 'zh-CN' }, 'zh-CN'], [{ language: 'en' }, 'en-US'], [{ language: 'xx' }, 'en-US'], [{ i18nextLng: 'zh-CN' }, 'zh-CN'], [{ language: 'en-US', i18nextLng: 'zh-CN' }, 'en-US']]) {
  const { i18n, document } = createI18nRuntime({ browser: true, storage: storage(data) });
  assert.equal(i18n.language, expected);
  assert.equal(document.documentElement.lang, expected);
}
const blocked = createI18nRuntime({ browser: true, storage: { getItem() { throw Error('Storage disabled'); } } });
assert.equal(blocked.i18n.language, 'en-US');
const runtime = createI18nRuntime();
assert.equal(runtime.i18n.language, 'en-US');
assert.equal(runtime.uiText('编辑模式'), 'Edit mode');
assert.equal(runtime.uiText('导入配置文件 {{p0}} 失败: {{p1}}', { p0: '用户{{p1}}.yaml', p1: '<bad URL>' }), 'Failed to import 用户{{p1}}.yaml: <bad URL>');
assert.equal(runtime.uiText('Bilibili台湾'), 'Bilibili Taiwan');
assert.equal(runtime.uiText('User-defined node name'), 'User-defined node name');
assert.equal(runtime.uiText('constructor'), 'constructor');
assert.equal(runtime.load('src/utils/formatters.ts').formatDuration(90061000), '1d 1h');
assert.equal(runtime.load('src/lib/subscription-errors.ts').subscriptionErrorMessage('ECONNRESET'), en.uiMessages['订阅连接被中断或重置（ECONNRESET），请检查网络或代理后重试']);
await runtime.i18n.changeLanguage('zh-CN');
assert.equal(runtime.uiText('编辑模式'), '编辑模式');
assert.equal(runtime.document.documentElement.lang, 'zh-CN');
assert.equal(runtime.load('src/utils/formatters.ts').formatDuration(90061000), '1天 1小时');

// Each literal source-keyed UI message must have translations, including templates.
function audit(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = `${directory}/${entry.name}`;
    if (entry.isDirectory()) { if (file !== 'src/i18n/locales') audit(file); continue; }
    if (!/\.tsx?$/.test(file)) continue;
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    function visit(node) {
      if (ts.isCallExpression(node) && node.expression.getText(source) === 'uiText' && ts.isStringLiteralLike(node.arguments[0])) {
        assert.ok(Object.hasOwn(en.uiMessages, node.arguments[0].text), `Missing message in ${file}: ${node.arguments[0].text}`);
      }
      if (ts.isCallExpression(node) && node.expression.getText(source) === 't' && ts.isStringLiteralLike(node.arguments[0])) {
        const key = node.arguments[0].text;
        assert.notEqual(key.split('.').reduce((value, part) => value?.[part], en), undefined, `Missing translation in ${file}: ${key}`);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
}
audit('src'); audit('app');
const media = fs.readFileSync('app/components/MediaStreamingTest.tsx', 'utf8');
assert.ok(media.includes('mediaApi(service.name, service.checkUrl)'), 'Canonical media API identifiers stay unchanged');
assert.ok(media.includes("setActiveTab('全部')"), 'Localized category labels do not change category IDs');
assert.ok(media.includes("msg.includes('自制剧')"), 'Raw result classification remains locale-independent');
const tray = fs.readFileSync('src-tauri/src/tray.rs', 'utf8');
for (const [, key] of tray.matchAll(/locale\.(?:text|format)\(\s*"([^"]+)"/g)) {
  assert.ok(Object.hasOwn(en.uiMessages, key), `Missing native tray message: ${key}`);
  assert.equal((key.match(/\{\}/g) || []).length, (en.uiMessages[key].match(/\{\}/g) || []).length, `Native interpolation: ${key}`);
}
console.log('✓ English default, saved preferences, blocked storage, locale parity, interpolation, live language changes, and UI message coverage');
