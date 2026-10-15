import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import ts from 'typescript';

const require = createRequire(import.meta.url);

export function createI18nRuntime({ storage, browser = false } = {}) {
  const instance = require('i18next').createInstance();
  const cache = new Map();
  const document = { documentElement: { lang: '' } };
  function load(file) {
    file = path.resolve(file);
    if (cache.has(file)) return cache.get(file).exports;
    if (file.endsWith('.json')) return JSON.parse(fs.readFileSync(file, 'utf8'));
    const module = { exports: {} };
    cache.set(file, module);
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
    }).outputText;
    vm.runInNewContext(code, {
      module, exports: module.exports, document,
      ...(browser ? { window: { localStorage: storage } } : {}),
      require(name) {
        if (name === 'i18next') return instance;
        if (name === '@/i18n') return load('src/i18n/index.ts');
        if (name.startsWith('@/')) return load(`src/${name.slice(2)}.ts`);
        if (name.startsWith('.')) {
          let resolved = path.resolve(path.dirname(file), name);
          if (!path.extname(resolved)) resolved += '.ts';
          return load(resolved);
        }
        return require(name);
      },
    }, { filename: file });
    return module.exports;
  }
  const i18n = load('src/i18n/index.ts').default;
  return { i18n, document, load, ...load('src/i18n/ui-text.ts') };
}
