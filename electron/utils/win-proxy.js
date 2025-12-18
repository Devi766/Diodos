/**
 * Windows 系统代理管理模块
 * 使用自研 sysproxy.exe 工具设置系统代理
 */

const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// 注册表路径（用于读取当前代理状态的备用方案）
const INTERNET_SETTINGS_PATH = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

// 默认绕过列表
const DEFAULT_BYPASS = 'localhost;127.*;192.168.*;10.*;172.16.*;172.17.*;172.18.*;172.19.*;172.20.*;172.21.*;172.22.*;172.23.*;172.24.*;172.25.*;172.26.*;172.27.*;172.28.*;172.29.*;172.30.*;172.31.*;<local>';

/**
 * 获取当前系统架构对应的 sysproxy.exe 文件名
 */
function getSysproxyFilename() {
  const arch = os.arch();
  switch (arch) {
    case 'x64':
      return 'sysproxy-x64.exe';
    case 'ia32':
    case 'x86':
      return 'sysproxy-x86.exe';
    case 'arm64':
      return 'sysproxy-arm64.exe';
    default:
      // 默认使用 x64
      return 'sysproxy-x64.exe';
  }
}

/**
 * 获取 sysproxy.exe 路径
 * 优先级：架构特定版本 > 通用版本
 */
function getSysproxyPath() {
  const archFilename = getSysproxyFilename();
  const genericFilename = 'sysproxy.exe';

  // 按优先级排列的搜索路径
  const searchDirs = [
    // 开发环境
    path.join(process.cwd(), 'tools'),
    // 生产环境
    process.resourcesPath ? path.join(process.resourcesPath, 'tools') : null,
    // 通过 __dirname 查找
    path.join(__dirname, '..', '..', 'tools')
  ].filter(Boolean);

  // 先尝试架构特定版本
  for (const dir of searchDirs) {
    const archPath = path.join(dir, archFilename);
    if (fs.existsSync(archPath)) {
      return archPath;
    }
  }

  // 再尝试通用版本
  for (const dir of searchDirs) {
    const genericPath = path.join(dir, genericFilename);
    if (fs.existsSync(genericPath)) {
      return genericPath;
    }
  }

  return null;
}

/**
 * 执行 sysproxy.exe 命令
 */
function runSysproxy(args) {
  const sysproxyPath = getSysproxyPath();

  if (!sysproxyPath) {
    // 如果找不到 sysproxy.exe，回退到 PowerShell 方案
    console.warn('[WinProxy] sysproxy.exe 未找到，使用 PowerShell 方案');
    return runSysproxyFallback(args);
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(sysproxyPath, args, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ success: true, stdout, stderr });
      } else {
        reject(new Error(`sysproxy.exe 退出码 ${code}: ${stderr || stdout}`));
      }
    });

    proc.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * PowerShell 回退方案（当 sysproxy.exe 不存在时使用）
 */
async function runSysproxyFallback(args) {
  const cmd = args[0];

  switch (cmd) {
    case 'global': {
      const server = args[1];
      const bypass = args[2] || DEFAULT_BYPASS;

      // 使用 reg 命令设置代理
      execSync(`reg add "${INTERNET_SETTINGS_PATH}" /v ProxyEnable /t REG_DWORD /d 1 /f`, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      });
      execSync(`reg add "${INTERNET_SETTINGS_PATH}" /v ProxyServer /t REG_SZ /d "${server}" /f`, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      });
      execSync(`reg add "${INTERNET_SETTINGS_PATH}" /v ProxyOverride /t REG_SZ /d "${bypass.replace(/"/g, '\\"')}" /f`, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      });
      try {
        execSync(`reg delete "${INTERNET_SETTINGS_PATH}" /v AutoConfigURL /f`, {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true
        });
      } catch {}

      await refreshProxySettingsPowerShell();
      return { success: true, stdout: `已启用全局代理: ${server}` };
    }

    case 'pac': {
      const pacUrl = args[1];

      execSync(`reg add "${INTERNET_SETTINGS_PATH}" /v ProxyEnable /t REG_DWORD /d 0 /f`, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      });
      execSync(`reg add "${INTERNET_SETTINGS_PATH}" /v AutoConfigURL /t REG_SZ /d "${pacUrl}" /f`, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      });

      await refreshProxySettingsPowerShell();
      return { success: true, stdout: `已启用 PAC 代理: ${pacUrl}` };
    }

    case 'off':
    case 'set': {
      execSync(`reg add "${INTERNET_SETTINGS_PATH}" /v ProxyEnable /t REG_DWORD /d 0 /f`, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      });
      try {
        execSync(`reg delete "${INTERNET_SETTINGS_PATH}" /v AutoConfigURL /f`, {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true
        });
      } catch {}

      await refreshProxySettingsPowerShell();
      return { success: true, stdout: '已关闭系统代理' };
    }

    default:
      throw new Error(`未知命令: ${cmd}`);
  }
}

/**
 * 使用 PowerShell 刷新代理设置
 */
async function refreshProxySettingsPowerShell() {
  return new Promise((resolve) => {
    const psScript = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class WinINet {
    [DllImport("wininet.dll", SetLastError = true)]
    public static extern bool InternetSetOption(IntPtr hInternet, int dwOption, IntPtr lpBuffer, int dwBufferLength);
    public static void RefreshProxy() {
        InternetSetOption(IntPtr.Zero, 39, IntPtr.Zero, 0);
        InternetSetOption(IntPtr.Zero, 37, IntPtr.Zero, 0);
    }
}
"@
[WinINet]::RefreshProxy()
`;

    const proc = spawn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-Command', psScript
    ], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const timeout = setTimeout(() => {
      try { proc.kill(); } catch {}
      resolve();
    }, 5000);

    proc.on('close', () => {
      clearTimeout(timeout);
      resolve();
    });

    proc.on('error', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

/**
 * Windows 系统代理管理类
 */
class WinProxy {
  constructor() {
    this.regPath = INTERNET_SETTINGS_PATH;
    this.defaultBypass = DEFAULT_BYPASS;
  }

  /**
   * 启用全局系统代理
   * @param {string} host - 代理主机地址
   * @param {number} port - 代理端口
   * @param {string} [bypass] - 绕过列表（可选）
   */
  async enable(host, port, bypass) {
    const proxyServer = `${host}:${port}`;
    const proxyOverride = bypass || this.defaultBypass;

    try {
      await runSysproxy(['global', proxyServer, proxyOverride]);
      console.log(`[WinProxy] 系统代理已启用: ${proxyServer}`);
      return { success: true, proxy: proxyServer };
    } catch (error) {
      console.error('[WinProxy] 启用系统代理失败:', error.message);
      throw error;
    }
  }

  /**
   * 禁用系统代理
   */
  async disable() {
    try {
      await runSysproxy(['off']);
      console.log('[WinProxy] 系统代理已禁用');
      return { success: true };
    } catch (error) {
      console.error('[WinProxy] 禁用系统代理失败:', error.message);
      throw error;
    }
  }

  /**
   * 设置 PAC 代理
   * @param {string} pacUrl - PAC 文件 URL
   */
  async enablePac(pacUrl) {
    try {
      await runSysproxy(['pac', pacUrl]);
      console.log(`[WinProxy] PAC 代理已启用: ${pacUrl}`);
      return { success: true, pacUrl };
    } catch (error) {
      console.error('[WinProxy] 启用 PAC 代理失败:', error.message);
      throw error;
    }
  }

  /**
   * 获取当前系统代理设置
   * @returns {Promise<{enabled: boolean, host: string|null, port: number|null, bypass: string|null}>}
   */
  async getCurrent() {
    try {
      let enabled = false;
      let proxyServer = '';
      let bypass = '';
      let pacUrl = '';

      try {
        const enableResult = execSync(`reg query "${this.regPath}" /v ProxyEnable`, {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true
        });
        const enableMatch = enableResult.match(/ProxyEnable\s+REG_DWORD\s+0x([0-9a-fA-F]+)/);
        enabled = enableMatch && parseInt(enableMatch[1], 16) === 1;
      } catch {}

      try {
        const serverResult = execSync(`reg query "${this.regPath}" /v ProxyServer`, {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true
        });
        const serverMatch = serverResult.match(/ProxyServer\s+REG_SZ\s+(.+)/);
        proxyServer = serverMatch ? serverMatch[1].trim() : '';
      } catch {}

      try {
        const bypassResult = execSync(`reg query "${this.regPath}" /v ProxyOverride`, {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true
        });
        const bypassMatch = bypassResult.match(/ProxyOverride\s+REG_SZ\s+(.+)/);
        bypass = bypassMatch ? bypassMatch[1].trim() : '';
      } catch {}

      try {
        const pacResult = execSync(`reg query "${this.regPath}" /v AutoConfigURL`, {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true
        });
        const pacMatch = pacResult.match(/AutoConfigURL\s+REG_SZ\s+(.+)/);
        pacUrl = pacMatch ? pacMatch[1].trim() : '';
      } catch {}

      let host = null;
      let port = null;
      if (proxyServer) {
        const parts = proxyServer.split(':');
        host = parts[0] || null;
        port = parts[1] ? parseInt(parts[1], 10) : null;
      }

      return { enabled, host, port, bypass, proxyServer, pacUrl };
    } catch (error) {
      console.error('[WinProxy] 获取代理设置失败:', error.message);
      return { enabled: false, host: null, port: null, bypass: null, proxyServer: null, pacUrl: null };
    }
  }
}

/**
 * 代理守卫类
 * 定期检查系统代理设置，如果被修改则自动恢复
 */
class ProxyGuard {
  constructor(winProxy, options = {}) {
    this.winProxy = winProxy;
    this.interval = options.interval || 10000;
    this.timer = null;
    this.running = false;
    this.expectedConfig = null;
    this.onRestored = options.onRestored || null;
  }

  start(host, port, bypass) {
    if (this.running) {
      console.log('[ProxyGuard] 已经在运行中');
      return;
    }

    this.expectedConfig = {
      host,
      port,
      bypass: bypass || DEFAULT_BYPASS,
      proxyServer: `${host}:${port}`
    };

    this.running = true;
    this.timer = setInterval(() => this.check(), this.interval);

    console.log(`[ProxyGuard] 代理守卫已启动，检查间隔: ${this.interval}ms`);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;
    this.expectedConfig = null;

    console.log('[ProxyGuard] 代理守卫已停止');
  }

  updateExpectedConfig(host, port, bypass) {
    if (this.expectedConfig) {
      this.expectedConfig = {
        host,
        port,
        bypass: bypass || this.expectedConfig.bypass,
        proxyServer: `${host}:${port}`
      };
      console.log(`[ProxyGuard] 期望配置已更新: ${this.expectedConfig.proxyServer}`);
    }
  }

  async check() {
    if (!this.running || !this.expectedConfig) {
      return;
    }

    try {
      const current = await this.winProxy.getCurrent();

      const needsRestore =
        !current.enabled ||
        current.host !== this.expectedConfig.host ||
        current.port !== this.expectedConfig.port;

      if (needsRestore) {
        console.log('[ProxyGuard] 检测到代理设置被修改，正在恢复...');
        console.log(`[ProxyGuard] 当前: enabled=${current.enabled}, ${current.proxyServer}`);
        console.log(`[ProxyGuard] 期望: enabled=true, ${this.expectedConfig.proxyServer}`);

        await this.winProxy.enable(
          this.expectedConfig.host,
          this.expectedConfig.port,
          this.expectedConfig.bypass
        );

        console.log('[ProxyGuard] 代理设置已恢复');

        if (this.onRestored) {
          this.onRestored(this.expectedConfig);
        }
      }
    } catch (error) {
      console.error('[ProxyGuard] 检查代理设置时出错:', error);
    }
  }

  isRunning() {
    return this.running;
  }

  setInterval(interval) {
    this.interval = interval;

    if (this.running && this.expectedConfig) {
      clearInterval(this.timer);
      this.timer = setInterval(() => this.check(), this.interval);
      console.log(`[ProxyGuard] 检查间隔已更新: ${this.interval}ms`);
    }
  }
}

// 创建单例实例
const winProxy = new WinProxy();
const proxyGuard = new ProxyGuard(winProxy);

module.exports = {
  WinProxy,
  ProxyGuard,
  winProxy,
  proxyGuard,
  DEFAULT_BYPASS,
  getSysproxyPath
};
