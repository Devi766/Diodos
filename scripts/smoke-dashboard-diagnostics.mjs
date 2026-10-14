import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const react = { ...require('react'), useEffect() {}, useSyncExternalStore: (_subscribe, get) => get() };
function load(file, overrides = {}) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, require: name => name === 'react' ? react : overrides[name] ?? require(name),
    window: { electronAPI: api }, URL, setTimeout, clearTimeout, console, fetch: () => { throw new Error('unexpected fetch'); } }, { filename: file });
  return module.exports;
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let active = 0, maximum = 0, total = 0, mode = 'target', queried = [];
const api = {
  prepareRouteTrace: async () => ({ source: '192.168.1.2' }),
  probeHop: async ({ ttl }) => {
    active++; maximum = Math.max(maximum, active); total++;
    await pause(ttl === 1 ? 8 : 2); active--;
    const ip = mode === 'silent' ? null : ttl === 1 ? '192.168.1.1' : ttl === 3 ? '1.1.1.1' : '8.8.8.8';
    return { ttl, ip, sent: 3, received: ip ? 3 : 0, loss: ip ? 0 : 100, avg: ip ? ttl * 3 : null, min: ip ? ttl : null, max: ip ? ttl * 4 : null, reached: mode === 'target' && ttl === 3 };
  },
  testMediaStreaming: async name => name === 'Netflix' ? { available: true, fullSupport: true } : { available: false, verdict: 'unknown' },
};
const entry = { ip: '1.1.1.1', entryNode: 'Node', node: 'Node', error: null };
const trace = load('src/lib/route-trace.ts', {
  '@/utils/ip-info': { fetchIpInfoByIp: async ip => { queried.push(ip); await pause(2); return { ip, latitude: 35, longitude: 139, city: 'City' }; } },
  '@/lib/proxy-entry': { readCachedProxyEntry: () => entry, resolveProxyEntry: async () => entry },
});
await trace.startRouteTrace();
let state = trace.useRouteSnapshot();
assert.equal(state.running, false); assert.equal(state.hops.length, 3);
assert.equal(state.hops.map(h => h.ttl).join(','), '1,2,3');
assert(maximum <= 6); assert(!queried.includes('192.168.1.1'));
assert(!trace.isPublicIpv4('100.64.0.1')); assert(!trace.isPublicIpv4('169.254.1.1')); assert(!trace.isPublicIpv4('203.0.113.1'));
await pause(15); mode = 'silent'; total = 0; maximum = 0;
await trace.startRouteTrace(); state = trace.useRouteSnapshot();
assert.equal(state.hops.length, 6); assert(total <= 11); assert(maximum <= 6);
await pause(15); mode = 'target';
const pending = trace.startRouteTrace(); await pause(1); trace.stopRouteTrace(); await pending; await pause(15);
assert.equal(trace.useRouteSnapshot().running, false); assert.equal(trace.useRouteSnapshot().hops.length, 0);
console.log('✓ 六跳窗口、顺序发布、抵达终点/六跳无回应收尾、停止后丢弃旧结果、内网不外查');

const media = load('src/lib/media-checker.ts');
await media.runMediaCheck();
const result = media.useMediaSnapshot();
assert.equal(result.running, false); assert.equal(result.results[0].status, 'supported');
assert.equal(result.results[1].status, 'unknown');
console.log('✓ 媒体服务共用状态、手动检测与结果分类');
media.applyMediaToolResults([{ name: 'Netflix', status: 'partial', region: 'JP' }, { name: 'Disney+', status: 'timeout' }]);
assert.equal(media.useMediaSnapshot().results[0].status, 'partial');
assert.equal(media.useMediaSnapshot().results[0].region, 'JP');
assert.equal(media.useMediaSnapshot().results[2].status, 'failed');
assert.equal(media.useMediaSnapshot().running, false);
for (const file of ['app/tools/page.tsx', 'src/components/dashboard-cards/MediaTestCard.tsx']) assert(fs.readFileSync(file, 'utf8').includes('MediaStreamingTestDialog'));
assert(!fs.readFileSync('src/components/dashboard-cards/MediaTestCard.tsx', 'utf8').includes('<Dialog '));
console.log('✓ 工具箱与卡片共用完整媒体测试弹框，检测结果回写卡片');

const globe = load('src/lib/route-globe.ts');
const binary = fs.readFileSync('public/dashboard/globe-land-dots.bin');
const points = globe.parseLandDots(binary.buffer.slice(binary.byteOffset, binary.byteOffset + binary.byteLength));
assert(points.length > 2000); assert(points.every(p => Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180));
assert.throws(() => globe.parseLandDots(new ArrayBuffer(2)));
const a = globe.vector({ lat: 0, lon: 0 }); const b = globe.vector({ lat: 0, lon: 180 });
assert(globe.greatCircle(a, b, 0.5).every(Number.isFinite));
assert(Number.isFinite(globe.cameraFor(points.slice(0, 5)).zoom));
console.log('✓ 点阵二进制数据、大圆插值及对跖点边界');

for (const locale of ['zh-CN', 'en-US']) {
  const dict = JSON.parse(fs.readFileSync(`src/i18n/locales/${locale}.json`, 'utf8'));
  for (const id of ['media-test', 'route-trace']) assert(dict.dashboard.cardMeta[id].title);
  assert(dict.dashboard.mediaTest.status.unknown); assert(dict.dashboard.routeTrace.errors.physical_interface_unavailable);
}
console.log('✓ 两种新卡片的中英文文案');

const tools = load('src/lib/mtr-tools.ts', { './route-trace': trace });
assert.equal(tools.normalizeMtrTarget(' Example.COM. '), 'example.com');
assert.equal(tools.normalizeMtrTarget('192.168.1.1'), '192.168.1.1');
for (const bad of ['', 'https://example.com', 'host:443', 'a b.com', '999.1.1.1', '-bad.com', 'example.com/path']) assert.throws(() => tools.normalizeMtrTarget(bad));
assert.throws(() => tools.normalizeMtrTarget('2001:db8::1'), /ipv6_only/);
const beforeTool = JSON.stringify(trace.useRouteSnapshot());
const requests = [];
api.resolveRouteTarget = async target => { assert.equal(target, 'example.com'); return { ip: '8.8.8.8' }; };
const originalProbe = api.probeHop;
api.probeHop = async options => { requests.push(options); return originalProbe(options); };
mode = 'silent';
await tools.mtrToolRunner.start({ target: 'example.com', maxHops: 8, count: 1, timeoutMs: 500 });
const toolState = tools.mtrToolRunner.getSnapshot();
assert.equal(toolState.target, '8.8.8.8'); assert.equal(toolState.requestedTarget, 'example.com'); assert.equal(toolState.hops.length, 6);
assert(requests.every(request => request.count === 1 && request.timeoutMs === 500 && request.ttl <= 8));
assert.equal(JSON.stringify(trace.useRouteSnapshot()), beforeTool);
assert(tools.createMtrReport(toolState, ['Hop', 'IP']).includes('example.com (8.8.8.8)'));
tools.mtrToolRunner.clear(); assert.equal(tools.mtrToolRunner.getSnapshot().hops.length, 0);
console.log('✓ MTR 工具目标校验、参数传递、域名解析、结果复制与仪表盘会话隔离');
