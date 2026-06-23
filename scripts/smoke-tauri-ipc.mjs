import { spawn, execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const timeoutMs = Number(process.env.FLYCLASH_SMOKE_TIMEOUT_MS || 30000);
const productIdentifier = 'com.flyclash.desktop';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const yamlPath = (file) => file.replaceAll('\\', '/');

const smokeConfigContent = ({ proxyProviderPath, ruleProviderPath }) => `mixed-port: 7890
allow-lan: false
mode: rule
log-level: info
ipv6: false
dns:
  enable: false
proxies: []
proxy-groups:
  - name: PROXY
    type: select
    proxies:
      - DIRECT
      - REJECT
    use:
      - smoke-provider
proxy-providers:
  smoke-provider:
    type: file
    path: ${yamlPath(proxyProviderPath)}
    health-check:
      enable: false
      url: https://www.gstatic.com/generate_204
      interval: 300
rule-providers:
  smoke-rule-provider:
    type: file
    behavior: classical
    path: ${yamlPath(ruleProviderPath)}
    interval: 300
rules:
  - RULE-SET,smoke-rule-provider,PROXY
  - MATCH,PROXY
`;

const smokeProxyProviderContent = `proxies:
  - name: smoke-http
    type: http
    server: 127.0.0.1
    port: 9
`;

const smokeRuleProviderContent = `payload:
  - DOMAIN-SUFFIX,example.com,PROXY
`;

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

const extractControllerSocketPath = (commandLine) => {
  const pipeMatch = commandLine.match(/-ext-ctl-pipe\s+((?:\\\\\.\\pipe\\|\/\/\.\/pipe\/)\S+)/i);
  if (pipeMatch) {
    return pipeMatch[1].replaceAll('/', '\\');
  }

  const unixMatch = commandLine.match(/-ext-ctl-unix\s+(\S+)/i);
  if (unixMatch) return unixMatch[1];

  throw new Error(`Could not find mihomo IPC controller socket in command line: ${commandLine}`);
};

const parseHttpResponse = (buffer) => {
  const headerEnd = buffer.indexOf('\r\n\r\n');
  if (headerEnd < 0) return null;

  const headerText = buffer.slice(0, headerEnd).toString('utf8');
  const [statusLine, ...headerLines] = headerText.split('\r\n');
  const statusMatch = statusLine.match(/^HTTP\/\d(?:\.\d)?\s+(\d+)/i);
  if (!statusMatch) {
    throw new Error(`Invalid HTTP response over IPC: ${statusLine}`);
  }

  const headers = new Map();
  for (const line of headerLines) {
    const separator = line.indexOf(':');
    if (separator > 0) {
      headers.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
    }
  }

  const bodyStart = headerEnd + 4;
  if ((headers.get('transfer-encoding') || '').toLowerCase().includes('chunked')) {
    const bodyBuffer = buffer.slice(bodyStart);
    const decoded = decodeChunkedBody(bodyBuffer);
    if (!decoded) return null;
    return responseFromBody(Number(statusMatch[1]), headers, decoded.toString('utf8'));
  }

  const contentLength = Number(headers.get('content-length') || 0);
  if (buffer.length < bodyStart + contentLength) return null;

  const bodyText = buffer.slice(bodyStart, bodyStart + contentLength).toString('utf8');
  return responseFromBody(Number(statusMatch[1]), headers, bodyText);
};

const responseFromBody = (status, headers, bodyText) => {
  let data = null;
  if (bodyText.trim()) {
    try {
      data = JSON.parse(bodyText);
    } catch {
      data = bodyText;
    }
  }

  return {
    status,
    headers: Object.fromEntries(headers),
    text: bodyText,
    data,
  };
};

const decodeChunkedBody = (buffer) => {
  let offset = 0;
  const chunks = [];

  while (offset < buffer.length) {
    const lineEnd = buffer.indexOf('\r\n', offset);
    if (lineEnd < 0) return null;
    const sizeText = buffer.slice(offset, lineEnd).toString('ascii').split(';')[0].trim();
    const size = Number.parseInt(sizeText, 16);
    if (!Number.isFinite(size)) {
      throw new Error(`Invalid chunk size in IPC response: ${sizeText}`);
    }
    offset = lineEnd + 2;
    if (size === 0) {
      if (buffer.length < offset + 2) return null;
      return Buffer.concat(chunks);
    }
    if (buffer.length < offset + size + 2) return null;
    chunks.push(buffer.slice(offset, offset + size));
    offset += size + 2;
  }

  return null;
};

const ipcRequest = (socketPath, method, requestPath, body) =>
  new Promise((resolve, reject) => {
    const bodyText = body === undefined ? '' : JSON.stringify(body);
    const request = [
      `${method} ${requestPath} HTTP/1.1`,
      'Host: mihomo.local',
      'Connection: close',
      'Accept: application/json',
      bodyText ? 'Content-Type: application/json' : '',
      bodyText ? `Content-Length: ${Buffer.byteLength(bodyText)}` : '',
      '',
      bodyText,
    ].filter((line, index, items) => line || index >= items.length - 2).join('\r\n');

    const socket = net.connect(socketPath);
    const chunks = [];
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timed out waiting for IPC response: ${method} ${requestPath}`));
    }, 8000);

    socket.on('connect', () => {
      socket.write(request);
    });
    socket.on('data', (chunk) => {
      chunks.push(chunk);
      const parsed = parseHttpResponse(Buffer.concat(chunks));
      if (parsed) {
        clearTimeout(timer);
        socket.end();
        resolve(parsed);
      }
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on('close', () => {
      const parsed = parseHttpResponse(Buffer.concat(chunks));
      if (parsed) {
        clearTimeout(timer);
        resolve(parsed);
      }
    });
  });

const parseWebSocketFrame = (buffer) => {
  if (buffer.length < 2) return null;
  const opcode = buffer[0] & 0x0f;
  let length = buffer[1] & 0x7f;
  let offset = 2;

  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null;
    const high = buffer.readUInt32BE(offset);
    const low = buffer.readUInt32BE(offset + 4);
    length = high * 2 ** 32 + low;
    offset += 8;
  }

  const masked = (buffer[1] & 0x80) !== 0;
  let mask;
  if (masked) {
    if (buffer.length < offset + 4) return null;
    mask = buffer.slice(offset, offset + 4);
    offset += 4;
  }

  if (buffer.length < offset + length) return null;
  const payload = Buffer.from(buffer.slice(offset, offset + length));
  if (mask) {
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] ^= mask[index % 4];
    }
  }

  return {
    opcode,
    text: payload.toString('utf8'),
    consumed: offset + length,
  };
};

const ipcWebSocket = (socketPath, requestPath, { waitForMessage = true } = {}) =>
  new Promise((resolve, reject) => {
    const key = randomBytes(16).toString('base64');
    const request = [
      `GET ${requestPath} HTTP/1.1`,
      'Host: mihomo.local',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13',
      '',
      '',
    ].join('\r\n');

    const socket = net.connect(socketPath);
    let buffer = Buffer.alloc(0);
    let upgraded = false;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timed out waiting for IPC WebSocket: ${requestPath}`));
    }, waitForMessage ? 8000 : 3000);

    socket.on('connect', () => {
      socket.write(request);
    });
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd < 0) return;
        const headerText = buffer.slice(0, headerEnd).toString('utf8');
        const statusMatch = headerText.match(/^HTTP\/\d(?:\.\d)?\s+(\d+)/i);
        if (!statusMatch || Number(statusMatch[1]) !== 101) {
          clearTimeout(timer);
          socket.destroy();
          reject(new Error(`WebSocket ${requestPath} did not upgrade: ${headerText}`));
          return;
        }
        upgraded = true;
        buffer = buffer.slice(headerEnd + 4);
        if (!waitForMessage) {
          clearTimeout(timer);
          socket.end();
          resolve({ upgraded: true, text: null });
          return;
        }
      }

      const frame = parseWebSocketFrame(buffer);
      if (frame && frame.opcode === 1) {
        clearTimeout(timer);
        socket.end();
        resolve({ upgraded: true, text: frame.text });
      }
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

const expectStatus = (response, requestName, statuses = [200, 204]) => {
  if (!statuses.includes(response.status)) {
    throw new Error(`${requestName} returned ${response.status}: ${response.text}`);
  }
  return response.data;
};

const writeSmokeConfig = (mihomoHomeDir) => {
  const dir = path.join(mihomoHomeDir, 'smoke');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `mihomo-smoke-${process.pid}.yaml`);
  const proxyProviderPath = path.join(dir, `smoke-provider-${process.pid}.yaml`);
  const ruleProviderPath = path.join(dir, `smoke-rule-provider-${process.pid}.yaml`);
  fs.writeFileSync(proxyProviderPath, smokeProxyProviderContent, 'utf8');
  fs.writeFileSync(ruleProviderPath, smokeRuleProviderContent, 'utf8');
  fs.writeFileSync(file, smokeConfigContent({ proxyProviderPath, ruleProviderPath }), 'utf8');
  return { file, proxyProviderPath, ruleProviderPath };
};

const verifyControllerApi = async (socketPath, mihomoHomeDir) => {
  const smokeFiles = writeSmokeConfig(mihomoHomeDir);
  const configFile = smokeFiles.file;
  const endpoints = [];

  const version = expectStatus(await ipcRequest(socketPath, 'GET', '/version'), 'GET /version');
  if (!version || typeof version.version !== 'string') {
    throw new Error(`GET /version did not return a version payload: ${JSON.stringify(version)}`);
  }
  endpoints.push(`version=${version.version}`);

  expectStatus(
    await ipcRequest(socketPath, 'PUT', '/configs?force=true', { path: configFile }),
    'PUT /configs',
  );

  const initialConfig = expectStatus(await ipcRequest(socketPath, 'GET', '/configs'), 'GET /configs');
  if (!['rule', 'global', 'direct'].includes(String(initialConfig?.mode).toLowerCase())) {
    throw new Error(`GET /configs returned an unexpected mode: ${JSON.stringify(initialConfig)}`);
  }
  endpoints.push(`mode=${initialConfig.mode}`);

  expectStatus(await ipcRequest(socketPath, 'PATCH', '/configs', { mode: 'global' }), 'PATCH /configs mode=global');
  const globalConfig = expectStatus(await ipcRequest(socketPath, 'GET', '/configs'), 'GET /configs after global');
  if (String(globalConfig?.mode).toLowerCase() !== 'global') {
    throw new Error(`PATCH /configs did not switch to global: ${JSON.stringify(globalConfig)}`);
  }

  expectStatus(await ipcRequest(socketPath, 'PATCH', '/configs', { mode: 'rule' }), 'PATCH /configs mode=rule');
  const ruleConfig = expectStatus(await ipcRequest(socketPath, 'GET', '/configs'), 'GET /configs after rule');
  if (String(ruleConfig?.mode).toLowerCase() !== 'rule') {
    throw new Error(`PATCH /configs did not restore rule mode: ${JSON.stringify(ruleConfig)}`);
  }
  endpoints.push('modeSwitch=global->rule');

  const proxies = expectStatus(await ipcRequest(socketPath, 'GET', '/proxies'), 'GET /proxies');
  const proxyGroup = proxies?.proxies?.PROXY;
  if (!proxyGroup || !Array.isArray(proxyGroup.all) || !proxyGroup.all.includes('DIRECT')) {
    throw new Error(`GET /proxies did not return the smoke PROXY group: ${JSON.stringify(proxies)}`);
  }
  endpoints.push(`proxyGroup=${proxyGroup.name || 'PROXY'}`);

  expectStatus(await ipcRequest(socketPath, 'PUT', '/proxies/PROXY', { name: 'REJECT' }), 'PUT /proxies/PROXY REJECT');
  const rejectedProxy = expectStatus(await ipcRequest(socketPath, 'GET', '/proxies/PROXY'), 'GET /proxies/PROXY after REJECT');
  if (rejectedProxy?.now !== 'REJECT') {
    throw new Error(`PUT /proxies/PROXY did not select REJECT: ${JSON.stringify(rejectedProxy)}`);
  }
  expectStatus(await ipcRequest(socketPath, 'PUT', '/proxies/PROXY', { name: 'DIRECT' }), 'PUT /proxies/PROXY DIRECT');
  endpoints.push('selectNode=REJECT->DIRECT');

  const rules = expectStatus(await ipcRequest(socketPath, 'GET', '/rules'), 'GET /rules');
  if (!Array.isArray(rules?.rules) || rules.rules.length === 0) {
    throw new Error(`GET /rules did not return smoke rules: ${JSON.stringify(rules)}`);
  }
  endpoints.push(`rules=${rules.rules.length}`);

  const connections = expectStatus(await ipcRequest(socketPath, 'GET', '/connections'), 'GET /connections');
  if (connections?.connections !== null && !Array.isArray(connections?.connections)) {
    throw new Error(`GET /connections did not return a connections array: ${JSON.stringify(connections)}`);
  }
  expectStatus(await ipcRequest(socketPath, 'DELETE', '/connections'), 'DELETE /connections');
  endpoints.push(`connections=${Array.isArray(connections.connections) ? connections.connections.length : 0}`);

  const proxyProviders = expectStatus(await ipcRequest(socketPath, 'GET', '/providers/proxies'), 'GET /providers/proxies');
  if (!proxyProviders || typeof proxyProviders.providers !== 'object') {
    throw new Error(`GET /providers/proxies returned unexpected payload: ${JSON.stringify(proxyProviders)}`);
  }
  if (!proxyProviders.providers['smoke-provider']) {
    throw new Error(`GET /providers/proxies did not include smoke-provider: ${JSON.stringify(proxyProviders)}`);
  }
  expectStatus(
    await ipcRequest(socketPath, 'PUT', '/providers/proxies/smoke-provider'),
    'PUT /providers/proxies/smoke-provider',
  );

  const ruleProviders = expectStatus(await ipcRequest(socketPath, 'GET', '/providers/rules'), 'GET /providers/rules');
  if (!ruleProviders || typeof ruleProviders.providers !== 'object') {
    throw new Error(`GET /providers/rules returned unexpected payload: ${JSON.stringify(ruleProviders)}`);
  }
  if (!ruleProviders.providers['smoke-rule-provider']) {
    throw new Error(`GET /providers/rules did not include smoke-rule-provider: ${JSON.stringify(ruleProviders)}`);
  }
  expectStatus(
    await ipcRequest(socketPath, 'PUT', '/providers/rules/smoke-rule-provider'),
    'PUT /providers/rules/smoke-rule-provider',
  );
  endpoints.push(`providers=${Object.keys(proxyProviders.providers).length}/${Object.keys(ruleProviders.providers).length}, providerUpdate=ok`);

  const trafficFrame = await ipcWebSocket(socketPath, '/traffic');
  const traffic = JSON.parse(trafficFrame.text);
  if (!Number.isFinite(Number(traffic?.up)) || !Number.isFinite(Number(traffic?.down))) {
    throw new Error(`WebSocket /traffic returned unexpected payload: ${trafficFrame.text}`);
  }
  endpoints.push('trafficStream=ok');

  const connectionsFrame = await ipcWebSocket(socketPath, '/connections');
  const streamedConnections = JSON.parse(connectionsFrame.text);
  if (!('connections' in streamedConnections)) {
    throw new Error(`WebSocket /connections returned unexpected payload: ${connectionsFrame.text}`);
  }
  endpoints.push('connectionsStream=ok');

  await ipcWebSocket(socketPath, '/logs?level=info', { waitForMessage: false });
  endpoints.push('logsStream=upgrade');

  fs.rmSync(configFile, { force: true });
  fs.rmSync(smokeFiles.proxyProviderPath, { force: true });
  fs.rmSync(smokeFiles.ruleProviderPath, { force: true });
  return { configFile, endpoints, configCleaned: true };
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
    const socketPath = extractControllerSocketPath(commandLine);
    const controllerApi = await verifyControllerApi(socketPath, path.dirname(config.file));

    console.log('Tauri IPC smoke passed');
    console.log(`flyclashPid: ${child.pid}`);
    console.log(`mihomoPid: ${mihomo.ProcessId}`);
    console.log(`mihomoCommand: ${commandLine}`);
    console.log(`controllerSocket: ${socketPath}`);
    console.log(`controllerApi: ${controllerApi.endpoints.join(', ')}`);
    console.log(`smokeConfig: ${controllerApi.configFile}`);
    console.log(`smokeConfigCleaned: ${controllerApi.configCleaned}`);
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
