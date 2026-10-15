import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createI18nRuntime } from './i18n-test-runtime.mjs';

const runtime = createI18nRuntime();
await runtime.i18n.changeLanguage('zh-CN');

const require = createRequire(import.meta.url);
function load(file, overrides = {}) {
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.React, esModuleInterop: true },
  }).outputText, { module, exports: module.exports, URL, require: name => overrides[name] ?? (name === '@/i18n/ui-text' ? { uiText: runtime.uiText } : require(name)) });
  return module.exports;
}
const { subscriptionErrorMessage: error, sanitizeSubscriptionMessage: sanitize } = load('src/lib/subscription-errors.ts');
const privateUrl = `https://user:password@example.com/SECRET/${'a'.repeat(4096)}?token=TOP_SECRET`;
assert.equal(sanitize(`request to ${privateUrl} failed`), 'request to https://example.com/… failed');
assert.equal(error(new Error(`request to ${privateUrl} failed, reason: read ECONNRESET`)), '订阅连接被中断或重置（ECONNRESET），请检查网络或代理后重试');
assert.ok(!error({ message: `failed: ${privateUrl}` }).includes('SECRET'));
assert.equal(error(null, 'fallback'), 'fallback');

const { Toast } = load('src/components/ui/toast.tsx', { '@/lib/utils': { cn: (...values) => values.filter(Boolean).join(' ') } });
const markup = renderToStaticMarkup(React.createElement(Toast, { message: privateUrl, type: 'error' }));
assert.ok(markup.includes('[overflow-wrap:anywhere]'));
assert.ok(markup.includes('max-w-full overflow-hidden'));
const component = fs.readFileSync('src/components/Subscription.tsx', 'utf8');
assert.ok(component.includes('{sanitizeSubscriptionMessage(toastDescription)}'));
assert.ok(component.includes('max-w-[calc(100vw-3rem)] overflow-hidden'));
assert.ok(!component.includes("console.log('开始添加订阅，URL:'"));
const native = fs.readFileSync('src-tauri/src/subscription_commands.rs', 'utf8');
assert.ok(native.includes('crate::subscription_download::download(url, &ua, routes)'));
assert.ok(native.includes('let mut fetched = fetch_subscription(app, &url).await?'));
assert.ok(native.includes('"sourceType": "inline"'));
assert.ok(component.includes("configData.sourceType === 'inline' ? 'local:imported' : subUrl"));
assert.ok(component.includes('<textarea'));
assert.ok(component.includes('.yaml,.yml,.json,.txt,.conf'));
const download = fs.readFileSync('src-tauri/src/subscription_download.rs', 'utf8');
assert.ok(download.includes('validate_content(&content)'));
assert.ok(!download.includes('danger_accept_invalid'));
console.log('✓ 长链接强制换行与宽度约束、订阅凭据脱敏、连接重置提示、添加/更新共用下载和内容校验、保留 TLS 校验');
