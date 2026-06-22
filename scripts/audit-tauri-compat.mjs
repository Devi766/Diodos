import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

const readText = (relativePath) =>
  fs.readFileSync(path.join(root, relativePath), 'utf8');

const findMatchingBrace = (source, openIndex) => {
  let depth = 0;
  let quote = null;
  let escaped = false;

  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];

    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }

    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  return -1;
};

const countBraces = (line) => {
  let delta = 0;
  let quote = null;
  let escaped = false;

  for (const char of line) {
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      quote = char;
    } else if (char === '{') {
      delta += 1;
    } else if (char === '}') {
      delta -= 1;
    }
  }

  return delta;
};

const extractApiObject = (source, marker) => {
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) {
    throw new Error(`Marker not found: ${marker}`);
  }

  const openIndex = source.indexOf('{', markerIndex);
  const closeIndex = findMatchingBrace(source, openIndex);
  if (openIndex < 0 || closeIndex < 0) {
    throw new Error(`Could not parse object for marker: ${marker}`);
  }

  return source.slice(openIndex + 1, closeIndex);
};

const extractObjectApiNames = (objectSource) => {
  const names = new Set();
  const namespaceStack = [];
  let depth = 1;

  for (const rawLine of objectSource.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '');
    const trimmed = line.trim();
    const keyMatch = trimmed.match(/^([A-Za-z_$][\w$]*):/);

    if (keyMatch) {
      const key = keyMatch[1];
      if (depth === 1) {
        names.add(key);
        if (trimmed.endsWith('{')) {
          namespaceStack[depth + 1] = key;
        }
      } else if (depth === 2 && namespaceStack[2]) {
        names.add(`${namespaceStack[2]}.${key}`);
      }
    }

    const delta = countBraces(line);
    const nextDepth = depth + delta;
    if (nextDepth < depth) {
      for (let level = depth; level > nextDepth; level -= 1) {
        namespaceStack[level] = null;
      }
    }
    depth = nextDepth;
  }

  return names;
};

const extractElectronApi = (source) =>
  extractObjectApiNames(extractApiObject(source, "contextBridge.exposeInMainWorld('electronAPI',"));

const extractCompatApi = (source) => {
  const proxyIndex = source.indexOf('const api = new Proxy');
  if (proxyIndex < 0) throw new Error('Could not find Tauri compat proxy');
  const openIndex = source.indexOf('{', proxyIndex);
  const closeIndex = findMatchingBrace(source, openIndex);
  const objectSource = source.slice(openIndex + 1, closeIndex);

  return {
    names: extractObjectApiNames(objectSource),
    calls: new Set(
      [...source.matchAll(/\bcall(?:WithDefault)?\(\s*["']([^"']+)["']/g)]
        .map((match) => match[1])
    ),
    defaults: new Set(
      [...source.matchAll(/\bcallWithDefault\(\s*["']([^"']+)["']/g)]
        .map((match) => match[1])
    ),
  };
};

const extractBackendMethods = (source) => {
  const start = source.indexOf('async fn tauri_compat_call');
  if (start < 0) throw new Error('Could not find tauri_compat_call');
  const matchStart = source.indexOf('match method {', start);
  if (matchStart < 0) throw new Error('Could not find method match');
  const openIndex = source.indexOf('{', matchStart);
  const closeIndex = findMatchingBrace(source, openIndex);
  const matchBody = source.slice(openIndex + 1, closeIndex);
  const names = new Set();
  let depth = 1;

  for (const line of matchBody.split(/\r?\n/)) {
    const trimmed = line.trimStart();
    if (depth === 1 && (trimmed.startsWith('"') || trimmed.startsWith('| "'))) {
      for (const match of line.matchAll(/"([A-Za-z0-9_.:-]+)"/g)) {
        names.add(match[1]);
      }
    }
    depth += countBraces(line);
  }

  return names;
};

const sort = (items) => [...items].sort((left, right) => left.localeCompare(right));
const difference = (left, right) => sort([...left].filter((item) => !right.has(item)));

const electron = extractElectronApi(readText('electron/preload.js'));
const compat = extractCompatApi(readText('public/tauri-compat.js'));
const backend = extractBackendMethods(readText('src-tauri/src/main.rs'));

const report = {
  counts: {
    electronApi: electron.size,
    tauriCompatApi: compat.names.size,
    tauriCompatBackendCalls: compat.calls.size,
    tauriCompatDefaultFallbacks: compat.defaults.size,
    backendAcceptedMethodsAndAliases: backend.size,
  },
  electronMissingInCompat: difference(electron, compat.names),
  compatExtraVsElectron: difference(compat.names, electron),
  compatCallsMissingBackendDispatch: difference(compat.calls, backend),
  backendAliasesWithoutCompatCall: difference(backend, compat.calls),
  compatDefaultFallbacks: sort(compat.defaults),
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log('Tauri compat parity audit');
  console.log('');
  for (const [key, value] of Object.entries(report.counts)) {
    console.log(`${key}: ${value}`);
  }
  console.log('');
  for (const key of [
    'electronMissingInCompat',
    'compatExtraVsElectron',
    'compatCallsMissingBackendDispatch',
    'compatDefaultFallbacks',
  ]) {
    console.log(`${key} (${report[key].length}):`);
    if (report[key].length === 0) {
      console.log('  - none');
    } else {
      for (const item of report[key]) console.log(`  - ${item}`);
    }
    console.log('');
  }
}
