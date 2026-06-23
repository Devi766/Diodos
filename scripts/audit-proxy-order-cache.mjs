import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const proxyNodes = read('src/components/ProxyNodes.tsx');
const preload = read('src/services/app-data-preload.ts');
const runtimeConfig = read('src-tauri/src/runtime_config.rs');

const checks = [
  {
    name: 'ProxyNodes writes a tagged, config-scoped proxy group cache',
    pass:
      proxyNodes.includes("const PROXY_GROUPS_CACHE_SOURCE = 'proxy-nodes-config-order'") &&
      proxyNodes.includes('source: PROXY_GROUPS_CACHE_SOURCE') &&
      proxyNodes.includes('configPath: normalizeCacheIdentity(configPath) || readCachedActiveConfig()'),
  },
  {
    name: 'ProxyNodes rejects untagged or stale proxy group caches',
    pass:
      proxyNodes.includes('trustedProxyGroupsCache(record.source, record.configPath)') &&
      proxyNodes.includes('unpacked.source !== PROXY_GROUPS_CACHE_SOURCE') &&
      proxyNodes.includes('clearProxyNodesOrderedCache()'),
  },
  {
    name: 'Route preloader does not write runtime-order proxy groups into the ordered cache',
    pass:
      !preload.includes('preloadProxyGroups') &&
      !preload.includes('APP_DATA_CACHE_KEYS.proxyGroups'),
  },
  {
    name: 'getConfigOrder returns the active config identity and config-derived node orders',
    pass:
      runtimeConfig.includes('"configPath": path') &&
      runtimeConfig.includes('"proxies": top_level_proxies') &&
      runtimeConfig.includes('"providerProxies": provider_proxies') &&
      runtimeConfig.includes('parse_provider_proxy_orders'),
  },
];

const failed = checks.filter((check) => !check.pass);
for (const check of checks) {
  console.log(`${check.pass ? 'ok' : 'not ok'} - ${check.name}`);
}

if (failed.length > 0) {
  console.error(`Proxy order cache audit failed: ${failed.map((check) => check.name).join('; ')}`);
  process.exit(1);
}
