import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const timeoutMs = Number(process.env.FLYCLASH_SMOKE_TIMEOUT_MS || 30000);
const productIdentifier = 'com.flyclash.desktop';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const execText = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });

const exePath = () => {
  if (process.platform === 'win32') {
    return path.join(root, 'src-tauri', 'target', 'debug', 'flyclash.exe');
  }
  if (process.platform === 'darwin') {
    return path.join(root, 'src-tauri', 'target', 'debug', 'bundle', 'macos', 'FlyClash.app', 'Contents', 'MacOS', 'FlyClash');
  }
  return path.join(root, 'src-tauri', 'target', 'debug', 'flyclash');
};

const configPath = () => {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), productIdentifier, 'mihomo', 'work-config.yaml');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', productIdentifier, 'mihomo', 'work-config.yaml');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), productIdentifier, 'mihomo', 'work-config.yaml');
};

const windowsProcesses = async () => {
  const script = [
    '$ErrorActionPreference="Stop";',
    'Get-CimInstance Win32_Process |',
    'Where-Object { $_.Name -ieq "flyclash.exe" -or $_.Name -ieq "mihomo.exe" } |',
    'Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Depth 4',
  ].join(' ');
  const text = await execText('powershell.exe', ['-NoProfile', '-Command', script]);
  if (!text.trim()) return [];
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [parsed];
};

const unixProcesses = async () => {
  const text = await execText('ps', ['-axo', 'pid=,comm=,args=']);
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /\bflyclash\b|\bmihomo\b/i.test(line))
    .map((line) => {
      const match = line.match(/^(\d+)\s+(\S+)\s+(.*)$/);
      return match
        ? { ProcessId: Number(match[1]), Name: match[2], CommandLine: match[3] }
        : null;
    })
    .filter(Boolean);
};

const listProcesses = () => (process.platform === 'win32' ? windowsProcesses() : unixProcesses());

const killTree = async (pid) => {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      await execText('taskkill.exe', ['/PID', String(pid), '/T', '/F']);
    } else {
      process.kill(pid, 'SIGTERM');
      await sleep(1000);
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already exited.
      }
    }
  } catch {
    // Best-effort cleanup; the verification result has already been captured.
  }
};

const waitForMihomo = async (flyclashPid) => {
  const start = Date.now();
  const pipePidMarker = String(flyclashPid);
  while (Date.now() - start < timeoutMs) {
    const processes = await listProcesses();
    const mihomo = processes.find((proc) => {
      const commandLine = proc.CommandLine || '';
      if (!/mihomo/i.test(proc.Name || commandLine)) return false;
      if (process.platform === 'win32') {
        return commandLine.includes('\\\\.\\pipe\\') && commandLine.includes(pipePidMarker);
      }
      return commandLine.includes('-ext-ctl-unix') && commandLine.includes('.sock');
    });
    if (mihomo) return { mihomo, processes };
    await sleep(500);
  }
  return { mihomo: null, processes: await listProcesses() };
};

const verifyRuntimeConfig = () => {
  const file = configPath();
  if (!fs.existsSync(file)) {
    throw new Error(`Runtime config was not created: ${file}`);
  }
  const content = fs.readFileSync(file, 'utf8');
  const markers = {
    hasExternalController: /^external-controller\s*:/m.test(content),
    hasSecret: /^secret\s*:/m.test(content),
    hasMixedPort: /^mixed-port\s*:/m.test(content),
    hasMode: /^mode\s*:/m.test(content),
  };
  if (markers.hasExternalController || markers.hasSecret) {
    throw new Error(`Runtime config still contains controller HTTP fields: ${JSON.stringify(markers)}`);
  }
  if (!markers.hasMixedPort || !markers.hasMode) {
    throw new Error(`Runtime config is missing expected base fields: ${JSON.stringify(markers)}`);
  }
  return { file, markers };
};

const main = async () => {
  const exe = exePath();
  if (!fs.existsSync(exe)) {
    throw new Error(`Tauri debug executable not found: ${exe}. Run npm run tauri:build -- --debug first.`);
  }

  const child = spawn(exe, [], {
    cwd: root,
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, RUST_BACKTRACE: '1' },
  });

  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  try {
    await sleep(3000);
    if (child.exitCode !== null) {
      throw new Error(`FlyClash exited early with code ${child.exitCode}: ${stderr.trim()}`);
    }

    const { mihomo } = await waitForMihomo(child.pid);
    if (!mihomo) {
      throw new Error(`Timed out waiting for mihomo IPC sidecar. stderr: ${stderr.trim()}`);
    }

    const config = verifyRuntimeConfig();
    const commandLine = mihomo.CommandLine || '';
    const usesPipe = process.platform === 'win32' && commandLine.includes('-ext-ctl-pipe') && commandLine.includes('\\\\.\\pipe\\');
    const usesUnixSocket = process.platform !== 'win32' && commandLine.includes('-ext-ctl-unix') && commandLine.includes('.sock');
    if (!usesPipe && !usesUnixSocket) {
      throw new Error(`mihomo was not launched with an IPC controller endpoint: ${commandLine}`);
    }

    console.log('Tauri IPC smoke passed');
    console.log(`flyclashPid: ${child.pid}`);
    console.log(`mihomoPid: ${mihomo.ProcessId}`);
    console.log(`mihomoCommand: ${commandLine}`);
    console.log(`runtimeConfig: ${config.file}`);
    console.log(`runtimeMarkers: ${JSON.stringify(config.markers)}`);
  } finally {
    await killTree(child.pid);
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
