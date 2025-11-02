const net = require('net');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFilePromise = promisify(execFile);

const SOCKET_PATH = '/tmp/flycast-service.sock';

module.exports = function initServiceManager(context) {
  const isMac = process.platform === 'darwin';
  const isLinux = process.platform === 'linux';

  function getStateFile() {
    const home = process.env.HOME || process.env.USERPROFILE;
    return path.join(home, '.config', 'flycast', 'service-state.json');
  }

  function loadSecret() {
    try {
      const stateFile = getStateFile();
      if (fs.existsSync(stateFile)) {
        const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        return state.secret;
      }
    } catch (e) {
      console.error('[ServiceManager] Failed to load secret:', e);
    }
    return null;
  }

  async function sendCommand(command, params = {}) {
    return new Promise((resolve, reject) => {
      const secret = loadSecret();
      if (!secret) {
        return reject(new Error('Service not installed or secret not found'));
      }

      const socket = net.createConnection(SOCKET_PATH);
      let response = '';

      socket.on('connect', () => {
        const request = JSON.stringify({ command, params, secret }) + '\n';
        socket.write(request);
      });

      socket.on('data', (data) => {
        response += data.toString();
        if (response.includes('\n')) {
          socket.end();
          try {
            const result = JSON.parse(response.trim());
            resolve(result);
          } catch (e) {
            reject(new Error('Invalid response from service'));
          }
        }
      });

      socket.on('error', (err) => {
        reject(err);
      });

      socket.on('timeout', () => {
        socket.destroy();
        reject(new Error('Service request timeout'));
      });

      socket.setTimeout(5000);
    });
  }

  async function isServiceRunning() {
    if (!isMac && !isLinux) return false;

    try {
      const result = await sendCommand('ping');
      return result.success === true;
    } catch {
      return false;
    }
  }

  async function installService() {
    try {
      const serviceDir = path.join(__dirname, '..', 'service');
      let installScript;

      if (isMac) {
        installScript = path.join(serviceDir, 'install-service.sh');
      } else if (isLinux) {
        installScript = path.join(serviceDir, 'install-service-linux.sh');
      } else {
        return { success: false, error: 'Service mode only supported on macOS and Linux' };
      }

      if (!fs.existsSync(installScript)) {
        return { success: false, error: 'Install script not found' };
      }

      fs.chmodSync(installScript, 0o755);

      if (isMac) {
        const prompt = 'Flycast needs administrator access to install the service helper';
        const command = `do shell script "sudo '${installScript}'" with administrator privileges with prompt "${prompt}"`;
        await execFilePromise('osascript', ['-e', command]);
      } else if (isLinux) {
        await execFilePromise(installScript, []);
      }

      await new Promise(r => setTimeout(r, 2000));

      const running = await isServiceRunning();
      if (running) {
        return { success: true };
      } else {
        return { success: false, error: 'Service installed but not running' };
      }
    } catch (e) {
      console.error('[ServiceManager] Install failed:', e);
      return { success: false, error: e.message };
    }
  }

  async function uninstallService() {
    try {
      const serviceDir = path.join(__dirname, '..', 'service');
      let uninstallScript;

      if (isMac) {
        uninstallScript = path.join(serviceDir, 'uninstall-service.sh');
      } else if (isLinux) {
        uninstallScript = path.join(serviceDir, 'uninstall-service-linux.sh');
      } else {
        return { success: false, error: 'Service mode only supported on macOS and Linux' };
      }

      if (!fs.existsSync(uninstallScript)) {
        return { success: false, error: 'Uninstall script not found' };
      }

      fs.chmodSync(uninstallScript, 0o755);

      if (isMac) {
        const prompt = 'Flycast needs administrator access to uninstall the service helper';
        const command = `do shell script "sudo '${uninstallScript}'" with administrator privileges with prompt "${prompt}"`;
        await execFilePromise('osascript', ['-e', command]);
      } else if (isLinux) {
        await execFilePromise(uninstallScript, []);
      }

      return { success: true };
    } catch (e) {
      console.error('[ServiceManager] Uninstall failed:', e);
      return { success: false, error: e.message };
    }
  }

  async function authorizeBinary(binPath) {
    try {
      const result = await sendCommand('authorize', { binPath });
      return result;
    } catch (e) {
      console.error('[ServiceManager] Authorize failed:', e);
      return { success: false, error: e.message };
    }
  }

  async function setSystemDns(service, dns) {
    try {
      const result = await sendCommand('setdns', { service, dns });
      return result;
    } catch (e) {
      console.error('[ServiceManager] setDns failed:', e);
      return { success: false, error: e.message };
    }
  }

  context.serviceManager = {
    isServiceRunning,
    installService,
    uninstallService,
    authorizeBinary,
    setSystemDns
  };

  return context.serviceManager;
};
