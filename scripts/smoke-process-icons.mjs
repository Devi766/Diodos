import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const module = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/process-icons.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText, { module, exports: module.exports });
const { processIconKey, createProcessIconLoader } = module.exports;
const image = 'data:image/png;base64,' + fs.readFileSync('src-tauri/icons/64x64.png').toString('base64');
const key = processIconKey('/Applications/Test.app/Contents/MacOS/Test', 'Test');
assert.equal(processIconKey('', ''), null);
assert.ok(processIconKey(undefined, 'FlyClash'));
assert.notEqual(processIconKey('/system/shared-helper', 'App A'), processIconKey('/system/shared-helper', 'App B'));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

let active = 0, maxActive = 0, requests = 0;
const gates = [];
const loader = createProcessIconLoader({ request: async () => {
  requests++; active++; maxActive = Math.max(maxActive, active);
  const gate = deferred(); gates.push(gate);
  const result = await gate.promise; active--; return result;
} });
const first = loader.load(key);
assert.equal(first, loader.load(key), 'duplicate refreshes share one request');
const second = loader.load(processIconKey('', 'Second'));
const third = loader.load(processIconKey('', 'Third'));
assert.equal(requests, 2);
gates[0].resolve(image); assert.equal(await first, image);
await tick(); assert.equal(requests, 3);
gates[1].resolve(image); gates[2].resolve(image);
await Promise.all([second, third]);
assert.equal(maxActive, 2);
assert.equal(await loader.load(key), image);
assert.equal(requests, 3, 'completed icons are cached');

let time = 0, misses = 0;
const absent = createProcessIconLoader({ now: () => time, request: async () => { misses++; return null; } });
assert.equal(await absent.load(key), null);
assert.equal(await absent.load(key), null);
assert.equal(misses, 1, 'missing icons do not relaunch native extraction every traffic refresh');
time += 31000;
await absent.load(key); assert.equal(misses, 2);

let invalidRequests = 0;
const invalid = createProcessIconLoader({ request: async () => { invalidRequests++; return { success: false }; } });
assert.equal(await invalid.load(key), null, 'compat error objects are never used as img src');
assert.equal(await invalid.load(key), null);
assert.equal(invalidRequests, 1);
let storedRequests = 0;
const storage = new Map();
const store = { getItem: name => storage.get(name) ?? null, setItem: (name, value) => storage.set(name, value), removeItem: name => storage.delete(name) };
const make = () => createProcessIconLoader({ storage: () => store, request: async () => { storedRequests++; return image; } });
assert.equal(await make().load(key), image);
assert.equal(await make().load(key), image);
assert.equal(storedRequests, 1);
const quota = createProcessIconLoader({ storage: () => { throw Error('disabled storage'); }, request: async () => image });
assert.equal(await quota.load(key), image);
loader.invalidate(key);
assert.equal(await loader.load(key), null, 'broken image is suppressed rather than endlessly reloaded');

const native = fs.readFileSync('src-tauri/src/process_icons.rs', 'utf8');
const script = native.match(/const ICON_SCRIPT: &str = r#"([\s\S]*?)"#;/)?.[1];
assert.ok(script); new vm.Script(script);
assert.ok(script.includes('workspace.iconForFile'));
assert.ok(script.includes('workspace.runningApplications'));
assert.ok(script.includes('NSPNGFileType'));
assert.ok(native.includes('Duration::from_secs(8)'));
assert.ok(native.includes('.env("FLYCLASH_ICON_PATH", path)'));
const ranking = fs.readFileSync('src/components/dashboard-cards/TrafficRankingCard.tsx', 'utf8');
assert.ok(ranking.includes('if (!existing.processPath && processPath)'));
assert.ok(ranking.includes('processIconKey(item.processPath, item.processName)'));
assert.ok(!ranking.includes("return '📱'"));
assert.ok(fs.readFileSync('src/components/ConnectionTable.tsx', 'utf8').includes('await loadProcessIcon(path)'));
console.log('✓ macOS 图标桥接脚本语法、应用包/名称解析入口、共享请求去重与并发上限、成功/失败缓存、禁用存储回退、错误对象过滤及缺失路径回补');
