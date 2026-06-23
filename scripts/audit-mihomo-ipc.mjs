import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const pluginRev = 'ff75ee3edd61923e6c76a7f3cf3c3fbd0f8e22c0';

const readText = (relativePath) =>
  fs.readFileSync(path.join(root, relativePath), 'utf8');

const listFiles = (directory, extensions) => {
  const dir = path.join(root, directory);
  if (!fs.existsSync(dir)) return [];

  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'target' || entry.name === '.next' || entry.name === 'node_modules') {
      continue;
    }

    const relativePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(relativePath, extensions));
    } else if (entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext))) {
      files.push(relativePath);
    }
  }
  return files;
};

const failures = [];
const checks = [];

const check = (name, passed, detail = '') => {
  checks.push({ name, passed, detail });
  if (!passed) failures.push({ name, detail });
};

const includes = (relativePath, needle) => readText(relativePath).includes(needle);

const mainLines = readText('src-tauri/src/main.rs').split(/\r?\n/).length;
check('main.rs is below 300 lines', mainLines <= 300, `${mainLines} lines`);

const cargoToml = readText('src-tauri/Cargo.toml');
const packageJson = readText('package.json');
const mainCapability = JSON.parse(readText('src-tauri/capabilities/main-capability.json'));
check(
  'Rust mihomo plugin is locked to the Verge commit',
  cargoToml.includes('https://github.com/clash-verge-rev/tauri-plugin-mihomo') &&
    cargoToml.includes(`rev = "${pluginRev}"`),
);
check(
  'Frontend mihomo API package is locked to the same Verge commit',
  packageJson.includes(`clash-verge-rev/tauri-plugin-mihomo/tar.gz/${pluginRev}`),
);
check(
  'Tauri builder registers tauri-plugin-mihomo as LocalSocket',
  includes('src-tauri/src/app.rs', 'tauri_plugin_mihomo::Builder::new()') &&
    includes('src-tauri/src/app.rs', 'tauri_plugin_mihomo::models::Protocol::LocalSocket'),
);
check(
  'Main Tauri capability allows mihomo plugin commands',
  Array.isArray(mainCapability.permissions) &&
    mainCapability.permissions.includes('mihomo:default'),
);
check(
  'Runtime updates the active mihomo socket path',
  includes('src-tauri/src/runtime.rs', 'update_socket_path(endpoint.path.clone())'),
);
check(
  'Core launch endpoints use pipe/unix socket args',
  includes('src-tauri/src/core/controller.rs', '-ext-ctl-pipe') &&
    includes('src-tauri/src/core/controller.rs', '-ext-ctl-unix'),
);
check(
  'requestMihomoAPI compat route uses the IPC-only transport',
  includes('src-tauri/src/mihomo_controller.rs', 'request_mihomo_ipc_only(app, target'),
);
check(
  'IPC-only transport rejects absolute HTTP controller targets',
  includes('src-tauri/src/mihomo_transport.rs', 'TargetTransport::RejectControllerFallback') &&
    includes('src-tauri/src/mihomo_transport.rs', 'allow_absolute_url: bool') &&
    includes('src-tauri/src/mihomo_transport.rs', 'request_mihomo_ipc_only'),
);

const frontendFiles = listFiles('src', ['.ts', '.tsx']).filter(
  (file) => !file.endsWith(path.join('types', 'electron.d.ts')),
);
const requestMihomoApiCalls = frontendFiles.flatMap((file) => {
  const source = readText(file);
  return [...source.matchAll(/\brequestMihomoAPI\s*\(/g)].map((match) => ({
    file,
    index: match.index,
  }));
});
check(
  'Frontend business code does not call requestMihomoAPI directly',
  requestMihomoApiCalls.length === 0,
  requestMihomoApiCalls.map(({ file }) => file).join(', '),
);

const sourceFiles = [
  ...listFiles('src', ['.ts', '.tsx', '.js', '.jsx']),
  ...listFiles('src-tauri/src', ['.rs']),
];
const controllerHttpMatches = [];
for (const file of sourceFiles) {
  const source = readText(file);
  for (const match of source.matchAll(/127\.0\.0\.1:909\d/g)) {
    const before = source.slice(0, match.index);
    const inRustTestModule =
      file.endsWith('.rs') && before.lastIndexOf('mod tests') > before.lastIndexOf('\n}');
    if (!inRustTestModule) {
      controllerHttpMatches.push(file);
    }
  }
}
check(
  'No production source references 127.0.0.1:909x controller fallback',
  controllerHttpMatches.length === 0,
  [...new Set(controllerHttpMatches)].join(', '),
);

console.log('Mihomo IPC-only audit');
console.log('');
for (const item of checks) {
  const mark = item.passed ? 'ok' : 'fail';
  const detail = item.detail ? ` (${item.detail})` : '';
  console.log(`${mark}: ${item.name}${detail}`);
}

if (failures.length > 0) {
  console.log('');
  console.error(`${failures.length} audit check(s) failed.`);
  process.exit(1);
}
