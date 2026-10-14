import { createRequire } from 'node:module';

// 预览服务与桌面服务分别写入缓存，防止热更新覆盖彼此的模块
process.env.FLYCLASH_NEXT_DIST_DIR = '.next-preview';
const require = createRequire(import.meta.url);
process.argv = [process.execPath, require.resolve('next/dist/bin/next'), 'dev', '-p', process.env.PORT || '3123'];
require('next/dist/bin/next');
