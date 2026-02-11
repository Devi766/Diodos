const { execSync } = require('child_process');
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

function shellEscape(arg) {
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Windows 权限管理器
 * 负责创建和管理 Windows 计划任务以获取管理员权限
 */
class PermissionManager {
  constructor() {
    // 任务名称
    this.taskName = 'FlyClash-Elevated';
    
    // 任务目录 - 存储在用户数据目录
    this.taskDir = path.join(app.getPath('userData'), 'task');
    
    // 确保任务目录存在
    this.ensureTaskDir();
  }

  /**
   * 确保任务目录存在
   */
  ensureTaskDir() {
    if (!fs.existsSync(this.taskDir)) {
      fs.mkdirSync(this.taskDir, { recursive: true });
    }
  }

  /**
   * 获取当前应用的可执行文件路径
   */
  getExePath() {
    return process.execPath;
  }

  /**
   * 生成计划任务 XML 配置
   */
  getElevateTaskXml() {
    const exePath = this.getExePath();
    const username = os.userInfo().username;
    
    return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>FlyClash Elevated Task</Description>
  </RegistrationInfo>
  <Triggers />
  <Principals>
    <Principal id="Author">
      <UserId>${escapeXml(username)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>4</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${escapeXml(exePath)}</Command>
    </Exec>
  </Actions>
</Task>`;
  }

  /**
   * 创建计划任务（同步）
   */
  createElevateTaskSync() {
    try {
      // 生成 XML 配置
      const xml = this.getElevateTaskXml();
      const xmlPath = path.join(this.taskDir, `${this.taskName}.xml`);

      // 写入 XML 文件（必须是 UTF-16LE 带 BOM）
      // \ufeff 是 BOM 标记，schtasks.exe 需要它来正确识别编码
      fs.writeFileSync(xmlPath, Buffer.from(`\ufeff${xml}`, 'utf16le'));

      console.log('[PermissionManager] XML written to:', xmlPath);
      console.log('[PermissionManager] ExePath:', this.getExePath());

      // 创建计划任务
      const cmd = `%SystemRoot%\\System32\\schtasks.exe /create /tn "${this.taskName}" /xml "${xmlPath}" /f`;
      console.log('[PermissionManager] Executing:', cmd);

      const result = execSync(cmd, { stdio: 'pipe', encoding: 'utf8' });
      console.log('[PermissionManager] schtasks output:', result);

      console.log('[PermissionManager] Elevated task created:', this.taskName);
      return true;
    } catch (error) {
      console.error('[PermissionManager] Failed to create elevated task:', error.message);
      if (error.stderr) {
        console.error('[PermissionManager] stderr:', error.stderr.toString());
      }
      if (error.stdout) {
        console.error('[PermissionManager] stdout:', error.stdout.toString());
      }
      throw error;
    }
  }

  /**
   * 创建计划任务（异步，兼容旧调用）
   */
  async createElevateTask() {
    return this.createElevateTaskSync();
  }

  /**
   * 检查计划任务是否存在（同步）
   */
  checkElevateTaskSync() {
    try {
      const result = execSync(
        `%SystemRoot%\\System32\\schtasks.exe /query /tn "${this.taskName}"`,
        { stdio: 'pipe', encoding: 'utf8' }
      );
      return result.includes(this.taskName);
    } catch {
      return false;
    }
  }

  /**
   * 检查计划任务是否存在（异步）
   */
  async checkElevateTask() {
    return this.checkElevateTaskSync();
  }

  /**
   * 删除计划任务
   */
  async deleteElevateTask() {
    try {
      execSync(
        `%SystemRoot%\\System32\\schtasks.exe /delete /tn "${this.taskName}" /f`,
        { stdio: 'pipe' }
      );
      console.log('[PermissionManager] Elevated task deleted:', this.taskName);
    } catch (error) {
      console.error('[PermissionManager] Failed to delete elevated task:', error.message);
      throw error;
    }
  }

  /**
   * 检查当前进程是否有管理员权限
   */
  checkAdminPrivilegesSync() {
    if (process.platform !== 'win32') {
      // 非 Windows 平台由其他逻辑决定权限
      return false;
    }

    // 优先使用 PowerShell 判断当前用户是否在 Administrators 组
    try {
      const output = execSync(
        'powershell -NoProfile -NonInteractive -Command "[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)"',
        { stdio: ['ignore', 'pipe', 'ignore'] }
      )
        .toString()
        .trim()
        .toLowerCase();

      if (output === 'true') {
        return true;
      }
    } catch (e) {
      // PowerShell 失败时回退到 net session 检测
      console.warn('[PermissionManager] PowerShell admin check failed, fallback to net session:', e.message);
    }

    try {
      execSync('net session', { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 检查当前进程是否有管理员权限（异步包装）
   */
  async checkAdminPrivileges() {
    return this.checkAdminPrivilegesSync();
  }

  /**
   * 通过计划任务以管理员权限运行应用
   */
  async runAsAdmin() {
    try {
      // 检查任务是否存在
      if (!this.checkElevateTaskSync()) {
        throw new Error('Elevated task does not exist. Please create it first.');
      }

      // 运行计划任务
      execSync(
        `%SystemRoot%\\System32\\schtasks.exe /run /tn "${this.taskName}"`,
        { stdio: 'pipe' }
      );

      console.log('[PermissionManager] Running as admin via task:', this.taskName);
      console.log('[PermissionManager] Waiting for new instance to start...');

      // 等待新实例启动后再退出当前进程
      // 延迟 2 秒，给计划任务足够的时间启动新实例
      await new Promise(resolve => setTimeout(resolve, 2000));

      console.log('[PermissionManager] Quitting current instance...');
      // 退出当前进程
      app.quit();
    } catch (error) {
      console.error('[PermissionManager] Failed to run as admin:', error.message);
      throw error;
    }
  }

  /**
   * 授予核心文件权限（macOS/Linux）
   */
  async grantCorePermission() {
    if (process.platform === 'win32') {
      // Windows 平台不需要此操作
      return;
    }

    const { promisify } = require('util');
    const { exec, execFile } = require('child_process');
    const execPromise = promisify(exec);
    const execFilePromise = promisify(execFile);

    // 获取核心文件路径
    const corePath = this.getCorePath();

    try {
      if (process.platform === 'darwin') {
        const escaped = shellEscape(corePath);
        const script = `do shell script "chown root:admin ${escaped} && chmod +sx ${escaped}" with administrator privileges`;
        await execFilePromise('osascript', ['-e', script]);
      } else if (process.platform === 'linux') {
        // 优先尝试为内核设置能力, 失败则回退到 setuid root
        try {
          await execFilePromise('pkexec', ['setcap', 'cap_net_admin,cap_net_bind_service=+eip', corePath]);
          console.log('[PermissionManager] Linux capabilities granted via setcap');
        } catch (capError) {
          console.warn('[PermissionManager] setcap failed, falling back to setuid root:', capError?.message || capError);
          await execFilePromise('pkexec', ['chown', 'root:root', corePath]);
          await execFilePromise('pkexec', ['chmod', '+sx', corePath]);
          console.log('[PermissionManager] Linux setuid root applied');
        }
      }
      console.log('[PermissionManager] Core permission granted');
    } catch (error) {
      console.error('[PermissionManager] Failed to grant core permission:', error);
      throw error;
    }
  }

  /**
   * 检查核心文件权限（macOS/Linux）
   */
  async checkCorePermission() {
    if (process.platform === 'win32') {
      // Windows 平台检查管理员权限
      return await this.checkAdminPrivileges();
    }

    const { promisify } = require('util');
    const { exec } = require('child_process');
    const execPromise = promisify(exec);
    const corePath = this.getCorePath();

    try {
      if (process.platform === 'darwin') {
        const { stdout } = await execPromise(`ls -l "${corePath}"`);
        const permissions = stdout.trim().split(/\s+/)[0];
        return permissions.includes('s') || permissions.includes('S');
      }
      // Linux: 先检查 capabilities, 再检查 setuid
      try {
        const { stdout: capOut } = await execPromise(`getcap "${corePath}" || true`);
        if (capOut && /cap_net_admin/i.test(capOut)) {
          return true;
        }
      } catch {}
      const { stdout } = await execPromise(`ls -l "${corePath}"`);
      const permissions = stdout.trim().split(/\s+/)[0];
      return permissions.includes('s') || permissions.includes('S');
    } catch (error) {
      console.error('[PermissionManager] Failed to check core permission:', error);
      return false;
    }
  }

  /**
   * 撤销核心文件权限（macOS/Linux）
   */
  async revokeCorePermission() {
    if (process.platform === 'win32') {
      // Windows 平台不需要此操作
      return;
    }

    const { promisify } = require('util');
    const { exec, execFile } = require('child_process');
    const execPromise = promisify(exec);
    const execFilePromise = promisify(execFile);
    const corePath = this.getCorePath();

    try {
      if (process.platform === 'darwin') {
        const escaped = shellEscape(corePath);
        const script = `do shell script "chmod a-s ${escaped}" with administrator privileges`;
        await execFilePromise('osascript', ['-e', script]);
      } else if (process.platform === 'linux') {
        try {
          await execFilePromise('pkexec', ['setcap', '-r', corePath]);
        } catch {
          await execFilePromise('pkexec', ['chmod', 'a-s', corePath]);
        }
      }
      console.log('[PermissionManager] Core permission revoked');
    } catch (error) {
      console.error('[PermissionManager] Failed to revoke core permission:', error);
      throw error;
    }
  }

  /**
   * 获取核心文件路径
   */
  getCorePath() {
    const isWin = process.platform === 'win32';
    const isMac = process.platform === 'darwin';
    const isLinux = process.platform === 'linux';

    // 0) 优先读取用户设置的自定义内核路径
    try {
      const prefPath = path.join(app.getPath('userData'), 'kernel-config.json');
      if (fs.existsSync(prefPath)) {
        const pref = JSON.parse(fs.readFileSync(prefPath, 'utf8')) || {};
        const customPath = pref?.customPath ? String(pref.customPath).trim() : '';
        if (customPath && fs.existsSync(customPath)) {
          return customPath;
        }
      }
    } catch {}

    // 搜索 cores 目录（与运行时启动一致）
    const roots = [
      path.join(process.resourcesPath || '', 'cores'),
      path.join(app.getAppPath(), 'cores'),
      path.join(process.cwd(), 'cores')
    ];

    for (const root of roots) {
      try {
        if (!fs.existsSync(root)) continue;
        const files = fs.readdirSync(root);
        let candidates = files.filter((file) => file.toLowerCase().includes('mihomo'));
        if (isWin) candidates = candidates.filter((f) => f.endsWith('.exe'));
        if (isMac) candidates = candidates.filter((f) => f.toLowerCase().includes('darwin'));
        if (isLinux) candidates = candidates.filter((f) => f.toLowerCase().includes('linux'));

        // 尝试匹配架构
        const arch = process.arch;
        const archFiltered = candidates.filter((file) => {
          const lower = file.toLowerCase();
          if (arch === 'x64' || arch === 'amd64') return lower.includes('amd64') || lower.includes('x64');
          if (arch === 'arm64') return lower.includes('arm64');
          if (arch === 'ia32' || arch === 'x86') return lower.includes('386') || lower.includes('ia32') || lower.includes('x86');
          return true;
        });

        const pick = archFiltered[0] || candidates[0];
        if (pick) {
          return path.join(root, pick);
        }
      } catch {}
    }

    // 回退到通用路径（可能在 dev extra/sidecar）
    const genericName = isWin ? 'mihomo.exe' : 'mihomo';
    const fallbacks = [
      path.join(process.resourcesPath || '', 'extra', 'sidecar', genericName),
      path.join(app.getAppPath(), '..', 'extra', 'sidecar', genericName),
      path.join(process.resourcesPath || '', genericName)
    ];
    for (const p of fallbacks) {
      if (fs.existsSync(p)) return p;
    }

    // 最后回退: 优先尝试历史的 cores 目录；仅当路径存在时返回
    try {
      const legacyCores = path.join(process.resourcesPath || path.join(app.getAppPath(), '..'), 'cores', genericName);
      if (fs.existsSync(legacyCores)) return legacyCores;
      const legacyCore = path.join(process.resourcesPath || path.join(app.getAppPath(), '..'), 'core', genericName);
      if (fs.existsSync(legacyCore)) return legacyCore;
    } catch {}
    // 未找到有效路径
    return '';
  }
}

module.exports = PermissionManager;
