#!/usr/bin/env node

const net = require('net');
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const crypto = require('crypto');

const SOCKET_PATH = '/tmp/flycast-service.sock';
const STATE_FILE = path.join(process.env.HOME, '.config', 'flycast', 'service-state.json');
const LOG_FILE = '/tmp/flycast-service.log';

function log(...args) {
  const msg = `[${new Date().toISOString()}] ${args.join(' ')}\n`;
  fs.appendFileSync(LOG_FILE, msg);
  console.log(...args);
}

function ensureStateDir() {
  const dir = path.dirname(STATE_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch (e) {
    log('Failed to load state:', e);
  }
  return { secret: crypto.randomBytes(32).toString('hex') };
}

function saveState(state) {
  try {
    ensureStateDir();
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
    fs.chmodSync(STATE_FILE, 0o600);
  } catch (e) {
    log('Failed to save state:', e);
  }
}

const state = loadState();
if (!state.secret) {
  state.secret = crypto.randomBytes(32).toString('hex');
  saveState(state);
}

function verifyAuth(data) {
  if (!data.secret || data.secret !== state.secret) {
    return false;
  }
  return true;
}

function authorizeBinary(binPath) {
  try {
    if (!fs.existsSync(binPath)) {
      return { success: false, error: 'Binary not found' };
    }

    const isMac = process.platform === 'darwin';
    const isLinux = process.platform === 'linux';

    if (isMac) {
      execSync(`xattr -d com.apple.quarantine "${binPath}" 2>/dev/null || true`, { stdio: 'ignore' });
      execSync(`chown root:wheel "${binPath}"`, { stdio: 'ignore' });
      execSync(`chmod u+s "${binPath}"`, { stdio: 'ignore' });

      const stat = fs.statSync(binPath);
      const mode = stat.mode & 0o7777;
      const isSetuid = !!(mode & 0o4000);

      if (stat.uid === 0 && isSetuid) {
        return { success: true };
      }
    } else if (isLinux) {
      try {
        execSync(`setcap cap_net_admin,cap_net_bind_service=+eip "${binPath}"`, { stdio: 'ignore' });
        return { success: true };
      } catch {
        execSync(`chown root:root "${binPath}"`, { stdio: 'ignore' });
        execSync(`chmod +sx "${binPath}"`, { stdio: 'ignore' });

        const stat = fs.statSync(binPath);
        const mode = stat.mode & 0o7777;
        const isSetuid = !!(mode & 0o4000);

        if (stat.uid === 0 && isSetuid) {
          return { success: true };
        }
      }
    }

    return { success: false, error: 'Authorization verification failed' };
  } catch (e) {
    log('authorizeBinary error:', e);
    return { success: false, error: e.message };
  }
}

function setDns(service, dns) {
  try {
    execSync(`networksetup -setdnsservers "${service}" ${dns}`, { stdio: 'ignore' });
    return { success: true };
  } catch (e) {
    log('setDns error:', e);
    return { success: false, error: e.message };
  }
}

function handleRequest(data, callback) {
  if (!verifyAuth(data)) {
    return callback({ success: false, error: 'Invalid secret' });
  }

  const { command, params } = data;

  switch (command) {
    case 'authorize':
      return callback(authorizeBinary(params.binPath));

    case 'setdns':
      return callback(setDns(params.service, params.dns));

    case 'ping':
      return callback({ success: true, message: 'pong' });

    default:
      return callback({ success: false, error: 'Unknown command' });
  }
}

function startServer() {
  if (fs.existsSync(SOCKET_PATH)) {
    try {
      fs.unlinkSync(SOCKET_PATH);
    } catch (e) {
      log('Failed to remove old socket:', e);
    }
  }

  const server = net.createServer((socket) => {
    let buffer = '';

    socket.on('data', (chunk) => {
      buffer += chunk.toString();

      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const data = JSON.parse(line);
          handleRequest(data, (response) => {
            socket.write(JSON.stringify(response) + '\n');
          });
        } catch (e) {
          log('Parse error:', e);
          socket.write(JSON.stringify({ success: false, error: 'Invalid JSON' }) + '\n');
        }
      }
    });

    socket.on('error', (err) => {
      log('Socket error:', err);
    });
  });

  server.listen(SOCKET_PATH, () => {
    log('Service started on', SOCKET_PATH);
    try {
      fs.chmodSync(SOCKET_PATH, 0o666);
    } catch (e) {
      log('Failed to chmod socket:', e);
    }
  });

  server.on('error', (err) => {
    log('Server error:', err);
    process.exit(1);
  });

  process.on('SIGTERM', () => {
    log('Received SIGTERM, shutting down');
    server.close();
    if (fs.existsSync(SOCKET_PATH)) {
      fs.unlinkSync(SOCKET_PATH);
    }
    process.exit(0);
  });

  process.on('SIGINT', () => {
    log('Received SIGINT, shutting down');
    server.close();
    if (fs.existsSync(SOCKET_PATH)) {
      fs.unlinkSync(SOCKET_PATH);
    }
    process.exit(0);
  });
}

if (process.getuid() !== 0) {
  console.error('Service must run as root');
  process.exit(1);
}

log('Starting Flycast Service Helper');
startServer();
