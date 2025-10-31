const { execSync } = require('child_process');
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

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
      <UserId>${username}</UserId>
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
      <Command>${exePath}</Command>
    </Exec>
  </Actions>
</Task>`;
  }

  /**
   * 创建计划任务
   */
  async createElevateTask() {
    try {
      // 生成 XML 配置
      const xml = this.getElevateTaskXml();
      const xmlPath = path.join(this.taskDir, `${this.taskName}.xml`);
      
      // 写入 XML 文件
      fs.writeFileSync(xmlPath, xml, 'utf16le');
      
      // 创建计划任务
      execSync(
        `%SystemRoot%\\System32\\schtasks.exe /create /tn "${this.taskName}" /xml "${xmlPath}" /f`,
        { stdio: 'pipe' }
      );
      
      console.log('[PermissionManager] Elevated task created:', this.taskName);
      return true;
    } catch (error) {
      console.error('[PermissionManager] Failed to create elevated task:', error.message);
      throw error;
    }
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
  async checkAdminPrivileges() {
    try {
      // 使用 net session 命令检查管理员权限
      execSync('net session', { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
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
        const shell = `chown root:admin ${corePath.replace(' ', '\\\\ ')}\nchmod +sx ${corePath.replace(' ', '\\\\ ')}`;
        const command = `do shell script "${shell}" with administrator privileges`;
        await execPromise(`osascript -e '${command}'`);
      } else if (process.platform === 'linux') {
        await execFilePromise('pkexec', ['chown', 'root:root', corePath]);
        await execFilePromise('pkexec', ['chmod', '+sx', corePath]);
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
        const shell = `chmod a-s ${corePath.replace(' ', '\\\\ ')}`;
        const command = `do shell script "${shell}" with administrator privileges`;
        await execPromise(`osascript -e '${command}'`);
      } else if (process.platform === 'linux') {
        await execFilePromise('pkexec', ['chmod', 'a-s', corePath]);
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
    // 根据平台返回核心文件路径
    const resourcesPath = process.resourcesPath || path.join(app.getAppPath(), '..');
    const coreName = process.platform === 'win32' ? 'mihomo.exe' : 'mihomo';
    return path.join(resourcesPath, 'core', coreName);
  }
}

module.exports = PermissionManager;

