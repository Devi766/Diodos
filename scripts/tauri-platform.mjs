#!/usr/bin/env node
/**
 * Merge platform-specific Tauri config overlays for macOS / Windows.
 *
 * Tauri only auto-loads `tauri.conf.json`. Platform files such as
 * `tauri.macos.conf.json` must be passed with `--config`.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);

if (args.length === 0) {
  console.error('Usage: node scripts/tauri-platform.mjs <dev|build|...> [tauri args...]');
  process.exit(1);
}

const platform = process.platform;
const overlayName =
  platform === 'darwin'
    ? 'tauri.macos.conf.json'
    : platform === 'win32'
      ? 'tauri.windows.conf.json'
      : null;

const overlayPath = overlayName
  ? path.join(root, 'src-tauri', overlayName)
  : null;

const tauriArgs = [...args];
if (overlayPath && fs.existsSync(overlayPath)) {
  // Insert after the subcommand (dev/build/...) so both `tauri dev` and
  // `tauri build --bundles dmg` keep working.
  const insertAt = 1;
  tauriArgs.splice(insertAt, 0, '--config', overlayPath);
  console.log(`[tauri-platform] merging ${path.relative(root, overlayPath)}`);
} else if (overlayName) {
  console.warn(`[tauri-platform] overlay not found: ${overlayName}`);
}

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const child = spawn(npmCmd, ['exec', '--', 'tauri', ...tauriArgs], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: process.env,
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
