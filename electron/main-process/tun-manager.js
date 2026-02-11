/**
 * Cross‑platform TUN manager (macOS/Linux/Windows)
 *
 * Goals (Sparkle‑like UX):
 * 1) Structured permission probe before enabling TUN
 * 2) One‑time authorization flow, prefer custom kernel path when provided
 * 3) Start/Stop with verification; rollback on failure
 * 4) Windows: Service mode (default) or Task Scheduler mode
 */

module.exports = function initTunManager(context) {
  const { fs, path, spawn, execSync } = context;
  const { promisify } = require('util');
  const { execFile, execFileSync } = require('child_process');
  const execFilePromise = promisify(execFile);
  const crypto = require('crypto');

  const isMac = process.platform === 'darwin';
  const isLinux = process.platform === 'linux';
  const isWindows = process.platform === 'win32';

  // Windows 服务模块（延迟加载）
  let coreServiceModule = null;
  let serviceIpcModule = null;

  function getCoreService() {
    if (!isWindows) return null;
    if (!coreServiceModule) {
      try {
        coreServiceModule = require('./core-service');
      } catch (e) {
        console.warn('[TunManager] Failed to load core-service module:', e.message);
      }
    }
    return coreServiceModule?.coreService;
  }

  function getServiceIpc() {
    if (!isWindows) return null;
    if (!serviceIpcModule) {
      try {
        serviceIpcModule = require('./service-ipc');
      } catch (e) {
        console.warn('[TunManager] Failed to load service-ipc module:', e.message);
      }
    }
    return serviceIpcModule?.defaultIpc;
  }

  // 获取 TUN 权限提升模式设置
  function getTunElevationMode() {
    try {
      return context.dbManager?.getSetting('tun_elevation_mode', 'service') || 'service';
    } catch {
      return 'service';
    }
  }

  // 设置 TUN 权限提升模式
  function setTunElevationMode(mode) {
    try {
      context.dbManager?.setSetting('tun_elevation_mode', mode);
    } catch (e) {
      console.error('[TunManager] Failed to save elevation mode:', e);
    }
  }

  // 将技术性错误转换为用户友好的提示
  function getUserFriendlyError(error, operation = 'authorization') {
    const errStr = String(error?.message || error || '');
    const errCode = error?.code;

    // 用户取消授权
    if (errCode === -128 || /user cancel|cancelled|canceled/i.test(errStr)) {
      return '授权已取消';
    }

    // 权限被拒绝
    if (/permission denied|not permitted|authentication failed/i.test(errStr)) {
      return '授权失败，请确保输入了正确的管理员密码';
    }

    // 通用错误提示，不暴露技术细节
    if (operation === 'authorization') {
      return '授权失败，请重试';
    } else if (operation === 'toggle') {
      return 'TUN 模式切换失败，请重试';
    }
    return '操作失败，请重试';
  }

  // AppleScript helpers (macOS)
  function escapeForShell(p) {
    return String(p).replace(/'/g, "'\\''");
  }

  function buildASAuthorize(targetDir, targetPath) {
    const escTargetDir = escapeForShell(targetDir);
    const escTarget = escapeForShell(targetPath);

    return `do shell script "mkdir -p '${escTargetDir}' && xattr -d com.apple.quarantine '${escTarget}' 2>/dev/null || true && chown root:wheel '${escTarget}' && chmod u+s '${escTarget}'" with administrator privileges`;
  }

  function getSystemKernelPath() {
    const systemDir = '/Library/Application Support/Flycast';
    const systemPath = path.join(systemDir, 'mihomo');
    return systemPath;
  }

  function getKernelPath() {
    if (isMac) {
      const systemPath = getSystemKernelPath();
      if (fs.existsSync(systemPath)) {
        const st = statInfo(systemPath);
        if (st.uid === 0 && st.isSetuid) {
          console.log('[TunManager] Using authorized system kernel:', systemPath);
          return systemPath;
        }
      }
    }

    try {
      const kernelPath = context.mihomoService?.findMihomoExecutable?.();
      if (kernelPath && fs.existsSync(kernelPath)) {
        console.log('[TunManager] Using kernel path:', kernelPath);
        return kernelPath;
      }
    } catch (e) {
      console.error('[TunManager] Failed to get kernel path from mihomoService:', e);
    }

    try {
      if (typeof context.getKernelExecutablePath === 'function') {
        const kernelPath = context.getKernelExecutablePath();
        if (kernelPath && fs.existsSync(kernelPath)) {
          console.log('[TunManager] Using kernel path from context:', kernelPath);
          return kernelPath;
        }
      }
    } catch {}

    console.warn('[TunManager] No kernel path found');
    return '';
  }

  function getSourceKernelPath() {
    try {
      const kernelPath = context.mihomoService?.findMihomoExecutable?.();
      if (kernelPath && fs.existsSync(kernelPath)) {
        return kernelPath;
      }
    } catch (e) {
      console.error('[TunManager] Failed to get kernel path from mihomoService:', e);
    }

    try {
      if (typeof context.getKernelExecutablePath === 'function') {
        const kernelPath = context.getKernelExecutablePath();
        if (kernelPath && fs.existsSync(kernelPath)) {
          return kernelPath;
        }
      }
    } catch {}

    return '';
  }

  function statInfo(file) {
    try {
      const s = fs.statSync(file);
      const mode = s.mode & 0o7777;
      return {
        exists: true,
        uid: s.uid,
        gid: s.gid,
        mode,
        isSetuid: !!(mode & 0o4000),
        isExec: !!(mode & 0o111)
      };
    } catch {
      return { exists: false };
    }
  }

  function hasQuarantine(file) {
    if (!isMac) return false;
    try {
      execSync(`xattr -p com.apple.quarantine "${file}"`, { stdio: 'ignore' });
      return true;
    } catch { return false; }
  }

  function isTunActive() {
    try {
      if (isMac) {
        const out = execSync('/sbin/ifconfig -l', { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
        return /\butun\d+\b/.test(out);
      }
      if (isLinux) {
        const out = execSync('ip link show', { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
        return /(mihomo|tun\d+)/.test(out);
      }
      return false;
    } catch { return false; }
  }

  function getActiveNetworkService() {
    if (!isMac) return null;
    try {
      const route = execSync('route -n get default', { encoding: 'utf8' });
      const match = route.match(/interface:\s+(\S+)/);
      if (!match) return null;
      const iface = match[1];
      const services = execSync('networksetup -listallnetworkservices', { encoding: 'utf8' });
      const serviceLines = services.split('\n').filter(l => l && !l.startsWith('*'));
      for (const service of serviceLines) {
        try {
          const hw = execSync(`networksetup -listallhardwareports | grep -A 1 "${service}"`, { encoding: 'utf8' });
          if (hw.includes(iface)) return service;
        } catch {}
      }
      return serviceLines[0] || 'Wi-Fi';
    } catch {
      return 'Wi-Fi';
    }
  }

  async function setSystemDns(dns) {
    if (!isMac) return { success: false, reason: 'not_mac' };
    const service = getActiveNetworkService();
    if (!service) return { success: false, reason: 'no_service' };

    const userDataPath = context.get('userDataPath');
    const dnsBackupFile = path.join(userDataPath, '.original_dns.txt');

    // 备份当前 DNS
    try {
      const current = execSync(`networksetup -getdnsservers "${service}"`, { encoding: 'utf8' }).trim();
      if (current && !current.includes('error') && current !== dns) {
        fs.writeFileSync(dnsBackupFile, current, 'utf8');
      }
    } catch {}

    // 只通过 service 设置 DNS（无需密码）
    // 如果 service 不可用，则依赖 TUN 的 DNS 劫持，不弹密码框
    try {
      const serviceManager = context.serviceManager;
      const useService = serviceManager && await serviceManager.isServiceRunning();

      if (useService) {
        const result = await serviceManager.setSystemDns(service, dns);
        if (result.success) {
          console.log('[TunManager] System DNS set via service (no password needed)');
          return { success: true, via: 'service' };
        }
        console.warn('[TunManager] Service setDns failed, will rely on DNS hijacking');
        return { success: false, reason: 'service_failed', fallback: 'dns_hijack' };
      }

      // Service 不可用，不弹密码框，依赖 TUN 的 DNS 劫持
      console.log('[TunManager] Service not running, relying on TUN DNS hijacking (no password needed)');
      return { success: false, reason: 'no_service', fallback: 'dns_hijack' };
    } catch (e) {
      console.error('[TunManager] Failed to set DNS:', e);
      return { success: false, reason: 'error', error: e.message };
    }
  }

  async function restoreSystemDns() {
    if (!isMac) return { success: false, reason: 'not_mac' };
    const service = getActiveNetworkService();
    if (!service) return { success: false, reason: 'no_service' };

    const userDataPath = context.get('userDataPath');
    const dnsBackupFile = path.join(userDataPath, '.original_dns.txt');

    if (!fs.existsSync(dnsBackupFile)) {
      console.log('[TunManager] No DNS backup file, nothing to restore');
      return { success: false, reason: 'no_backup' };
    }

    try {
      const original = fs.readFileSync(dnsBackupFile, 'utf8').trim();
      const serviceManager = context.serviceManager;
      const useService = serviceManager && await serviceManager.isServiceRunning();

      if (useService) {
        const dns = original || 'empty';
        const result = await serviceManager.setSystemDns(service, dns);
        if (result.success) {
          fs.unlinkSync(dnsBackupFile);
          console.log('[TunManager] System DNS restored via service (no password needed)');
          return { success: true, via: 'service' };
        }
        console.warn('[TunManager] Service restore DNS failed');
      }

      // Service 不可用，不弹密码框
      // DNS 会在用户重启系统或手动修改后自动恢复
      console.log('[TunManager] Service not running, DNS will restore naturally (no password needed)');
      // 删除备份文件，避免下次误恢复
      try {
        fs.unlinkSync(dnsBackupFile);
      } catch {}
      return { success: false, reason: 'no_service', note: 'dns_will_restore_naturally' };
    } catch (e) {
      console.error('[TunManager] Failed to restore DNS:', e);
      return { success: false, reason: 'error', error: e.message };
    }
  }

  async function waitForTun(expected, timeoutMs = 5000) {
    const start = Date.now();
    const step = 200;
    while (Date.now() - start < timeoutMs) {
      if (isTunActive() === expected) return true;
      await new Promise((r) => setTimeout(r, step));
    }
    return false;
  }

  /**
   * Probe authorization via lightweight kernel run.
   * No routing/DNS change to avoid side effects.
   */
  async function probeAuthorization(kernelPath) {
    const result = { ok: false, issues: [], details: {} };
    if (!kernelPath || !fs.existsSync(kernelPath)) {
      result.issues.push('kernel_not_found');
      return result;
    }

    const st = statInfo(kernelPath);
    result.details.stat = st;
    if (false && isMac) { // legacy block disabled; robust mac flow handled above
      if (hasQuarantine(kernelPath)) result.issues.push('quarantine_present');
      if (st.uid !== 0) result.issues.push('owner_not_root');
      // wheel gid is 0 on macOS
      if (st.gid !== 0) result.issues.push('group_not_wheel');
      if (!st.isSetuid) result.issues.push('suid_missing');
    } else if (isLinux) {
      try {
        const cap = execSync(`getcap "${kernelPath}" || true`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
        if (!/cap_net_admin/i.test(cap)) result.issues.push('cap_net_admin_missing');
      } catch { result.issues.push('cap_check_failed'); }
    }

    // Functional probe: run kernel with minimal config (no routing changes)
    const userDataPath = context.get('userDataPath');
    const probeDir = path.join(userDataPath, 'mihomo-probe');
    try { fs.mkdirSync(probeDir, { recursive: true }); } catch {}
    const probeConfig = path.join(probeDir, 'config.yaml');
    const yaml = context.yaml;
    const conf = {
      'mixed-port': 0,
      'allow-lan': false,
      'log-level': 'info',
      tun: {
        enable: true,
        stack: 'system',
        'auto-route': false,
        'auto-redirect': false,
        'auto-detect-interface': false,
        'dns-hijack': []
      }
    };
    try { fs.writeFileSync(probeConfig, yaml.dump(conf), 'utf8'); } catch {}

    let ok = false;
    try {
      const args = ['-d', probeDir, '-f', probeConfig];
      const child = spawn(kernelPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      const logs = [];
      const err = [];
      const onData = (b) => logs.push(b.toString());
      const onErr = (b) => err.push(b.toString());
      child.stdout.on('data', onData);
      child.stderr.on('data', onErr);

      // Wait up to 1500ms for a clear signal
      await new Promise((resolve) => setTimeout(resolve, 1500));
      try { child.kill(); } catch {}

      const text = (logs.join('') + err.join('')).toLowerCase();
      if (/operation not permitted|permission denied|tun .* error/.test(text)) {
        result.issues.push('kernel_denied_start_tun');
      } else if (/tun|utun|stack:/.test(text) || isTunActive()) {
        ok = true;
      } else {
        // Unknown – keep metadata‑based decision
      }
    } catch (e) {
      result.issues.push('probe_failed');
      result.details.probeError = e?.message || String(e);
    }

    // If functional probe says ok, prefer it
    if (ok) {
      console.log('[TunManager] Functional probe passed');
      result.ok = true;
      return result;
    }

    // Else fall back to metadata heuristic
    if (isMac) {
      // 简化检查：只检查uid和setuid位
      result.ok = st.uid === 0 && st.isSetuid;
      console.log('[TunManager] Metadata check:', {
        uid: st.uid,
        gid: st.gid,
        isSetuid: st.isSetuid,
        ok: result.ok
      });
    } else if (isLinux) {
      try {
        const cap = execSync(`getcap "${kernelPath}" || true`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
        result.ok = /cap_net_admin/i.test(cap) || (st.uid === 0 && st.isSetuid);
      } catch { result.ok = st.uid === 0 && st.isSetuid; }
    }
    return result;
  }

  async function grantPermissions(opts = {}) {
    const { preferCustom = true } = opts;

    if (isMac) {
      try {
        const sourceKernelPath = getSourceKernelPath();

        if (!sourceKernelPath || !fs.existsSync(sourceKernelPath)) {
          console.error('[TunManager] Source kernel not found');
          return { success: false, error: '未找到内核文件' };
        }

        console.log('[TunManager] Source kernel at:', sourceKernelPath);

        const serviceManager = context.serviceManager;
        const useService = serviceManager && await serviceManager.isServiceRunning();

        const systemDir = '/Library/Application Support/Flycast';
        const systemPath = getSystemKernelPath();

        const existingProbe = await probeAuthorization(systemPath);
        const needsCopy = !fs.existsSync(systemPath) ||
                         (fs.existsSync(systemPath) &&
                          fs.readFileSync(sourceKernelPath).compare(fs.readFileSync(systemPath)) !== 0);

        // 只有权限OK且版本一致才跳过，否则必须重新复制并授权
        if (existingProbe.ok && !needsCopy) {
          console.log('[TunManager] System kernel already authorized and up-to-date');
          return { success: true, message: 'Kernel already authorized' };
        }

        if (useService) {
          console.log('[TunManager] Using service mode for authorization');

          if (needsCopy) {
            const os = require('os');
            const tmpPath = path.join(os.tmpdir(), 'flycast-mihomo-' + crypto.randomBytes(8).toString('hex'));
            try {
              fs.copyFileSync(sourceKernelPath, tmpPath);
              fs.chmodSync(tmpPath, 0o755);

              const escTmp = escapeForShell(tmpPath);
              const escTargetDir = escapeForShell(systemDir);
              const escTarget = escapeForShell(systemPath);
              const moveScript = `do shell script "mkdir -p '${escTargetDir}' && mv -f '${escTmp}' '${escTarget}'" with administrator privileges`;
              await execFilePromise('osascript', ['-e', moveScript]);
            } catch (copyErr) {
              console.warn('[TunManager] Copy to tmp failed:', copyErr);
              try { fs.unlinkSync(tmpPath); } catch {}
            }
          }

          const result = await serviceManager.authorizeBinary(systemPath);
          if (result.success) {
            console.log('[TunManager] Kernel authorized via service');
            return { success: true, message: 'Kernel authorized' };
          }
          console.warn('[TunManager] Service authorization failed, falling back to osascript');
        }

        console.log('[TunManager] Using osascript to copy and authorize kernel');

        const os = require('os');
        const tmpPath = path.join(os.tmpdir(), 'flycast-mihomo-' + crypto.randomBytes(8).toString('hex'));
        try {
          fs.copyFileSync(sourceKernelPath, tmpPath);
          fs.chmodSync(tmpPath, 0o755);

          const escTmp = escapeForShell(tmpPath);
          const escTargetDir = escapeForShell(systemDir);
          const escTarget = escapeForShell(systemPath);

          const combinedScript = `do shell script "mkdir -p '${escTargetDir}' && mv -f '${escTmp}' '${escTarget}' && xattr -d com.apple.quarantine '${escTarget}' 2>/dev/null || true && chown root:wheel '${escTarget}' && chmod u+s '${escTarget}'" with administrator privileges`;
          await execFilePromise('osascript', ['-e', combinedScript]);

          try { fs.unlinkSync(tmpPath); } catch {}
        } catch (copyErr) {
          console.error('[TunManager] Copy and authorize failed:', copyErr);
          try { fs.unlinkSync(tmpPath); } catch {}
          throw copyErr;
        }

        const st = statInfo(systemPath);
        const quarantine = hasQuarantine(systemPath);
        console.log('[TunManager] After authorization, kernel stat:', {
          path: systemPath,
          exists: st.exists,
          uid: st.uid,
          gid: st.gid,
          mode: st.mode?.toString(8),
          isSetuid: st.isSetuid,
          hasQuarantine: quarantine
        });

        const probe = await probeAuthorization(systemPath);
        if (probe.ok) {
          console.log('[TunManager] Kernel authorized successfully');
          return { success: true, message: 'Kernel authorized' };
        }

        console.error('[TunManager] Authorization probe failed:', probe.issues);
        return { success: false, error: '授权验证失败，请重试' };
      } catch (e) {
        console.error('[TunManager] Grant permissions failed:', e);
        return { success: false, error: getUserFriendlyError(e, 'authorization') };
      }
    }

    if (isLinux) {
      try {
        const kernelPath = getKernelPath();
        if (!kernelPath || !fs.existsSync(kernelPath)) {
          console.error('[TunManager] Kernel not found');
          return { success: false, error: '未找到内核文件' };
        }

        const serviceManager = context.serviceManager;
        const useService = serviceManager && await serviceManager.isServiceRunning();

        if (useService) {
          console.log('[TunManager] Using service mode for authorization on Linux');
          const result = await serviceManager.authorizeBinary(kernelPath);
          if (result.success) {
            console.log('[TunManager] Kernel authorized via service');
            return { success: true, message: 'Kernel authorized' };
          }
          console.warn('[TunManager] Service authorization failed, falling back to pkexec');
        }

        try {
          execFileSync('pkexec', ['setcap', 'cap_net_admin,cap_net_bind_service=+eip', kernelPath], { stdio: 'ignore' });
        } catch {
          try {
            execFileSync('pkexec', ['chown', 'root:root', kernelPath], { stdio: 'ignore' });
            execFileSync('pkexec', ['chmod', '+sx', kernelPath], { stdio: 'ignore' });
          } catch (e) {
            return { success: false, error: getUserFriendlyError(e, 'authorization') };
          }
        }
        const probe = await probeAuthorization(kernelPath);
        return probe.ok ? { success: true } : { success: false, error: '授权验证失败，请重试' };
      } catch (e) {
        console.error('[TunManager] Grant permissions failed:', e);
        return { success: false, error: getUserFriendlyError(e, 'authorization') };
      }
    }

    // Windows 平台：使用服务模式或计划任务模式
    if (isWindows) {
      try {
        const elevationMode = getTunElevationMode();
        console.log('[TunManager] Windows elevation mode:', elevationMode);

        if (elevationMode === 'service') {
          // 服务模式
          const coreService = getCoreService();
          if (!coreService) {
            console.warn('[TunManager] Core service module not available, falling back to task mode');
            setTunElevationMode('task');
            return await grantPermissionsViaTask();
          }

          // 检查服务是否已安装
          const isInstalled = await coreService.isInstalled();
          if (isInstalled) {
            // 服务已安装，检查是否正在运行
            const isRunning = await coreService.isRunning();
            if (isRunning) {
              console.log('[TunManager] Windows service already running');
              return { success: true, message: '服务已运行', mode: 'service' };
            }

            // 启动服务
            const startResult = await coreService.start();
            if (startResult.success) {
              console.log('[TunManager] Windows service started');
              return { success: true, message: '服务已启动', mode: 'service' };
            }
          }

          // 安装服务
          console.log('[TunManager] Installing Windows service...');
          const kernelPath = getKernelPath();
          const installResult = await coreService.install({ corePath: kernelPath });

          if (installResult.success) {
            console.log('[TunManager] Windows service installed successfully');
            return { success: true, message: '服务安装成功', mode: 'service' };
          }

          console.warn('[TunManager] Service installation failed:', installResult.error);
          console.log('[TunManager] Falling back to task scheduler mode');
          return await grantPermissionsViaTask();
        } else {
          // 计划任务模式
          return await grantPermissionsViaTask();
        }
      } catch (e) {
        console.error('[TunManager] Windows grant permissions failed:', e);
        return { success: false, error: getUserFriendlyError(e, 'authorization') };
      }
    }

    return { success: false, error: '不支持的操作系统' };
  }

  // Windows 计划任务授权模式
  async function grantPermissionsViaTask() {
    try {
      const PermissionManager = require('./permission-manager');
      const permissionManager = new PermissionManager();

      // 检查任务是否已存在
      const taskExists = await permissionManager.checkElevateTask();
      if (taskExists) {
        console.log('[TunManager] Elevated task already exists');
        return { success: true, message: '计划任务已存在', mode: 'task' };
      }

      // 创建计划任务
      console.log('[TunManager] Creating elevated task...');
      const created = await permissionManager.createElevateTask();
      if (created) {
        console.log('[TunManager] Elevated task created successfully');
        return { success: true, message: '计划任务创建成功', mode: 'task' };
      }

      return { success: false, error: '创建计划任务失败' };
    } catch (e) {
      console.error('[TunManager] Task scheduler authorization failed:', e);
      return { success: false, error: getUserFriendlyError(e, 'authorization') };
    }
  }

  async function checkKernelUpdate() {
    if (!isMac && !isLinux) return { needsUpdate: false };

    const sourceKernelPath = getSourceKernelPath();
    const systemPath = getSystemKernelPath();

    if (!sourceKernelPath || !fs.existsSync(sourceKernelPath)) {
      return { needsUpdate: false };
    }

    if (!fs.existsSync(systemPath)) {
      return { needsUpdate: true, reason: 'system_kernel_missing' };
    }

    try {
      const sourceContent = fs.readFileSync(sourceKernelPath);
      const systemContent = fs.readFileSync(systemPath);

      if (sourceContent.compare(systemContent) !== 0) {
        const sourceStat = fs.statSync(sourceKernelPath);
        const systemStat = fs.statSync(systemPath);
        console.log('[TunManager] Kernel update detected:', {
          source: { path: sourceKernelPath, size: sourceStat.size, mtime: sourceStat.mtime },
          system: { path: systemPath, size: systemStat.size, mtime: systemStat.mtime }
        });
        return { needsUpdate: true, reason: 'kernel_updated' };
      }
    } catch (e) {
      console.warn('[TunManager] Failed to compare kernels:', e);
    }

    return { needsUpdate: false };
  }

  async function autoSyncKernel() {
    const updateCheck = await checkKernelUpdate();
    if (!updateCheck.needsUpdate) {
      return { success: true, synced: false };
    }

    console.log('[TunManager] Auto-syncing custom kernel to system directory...');
    const serviceManager = context.serviceManager;
    const useService = serviceManager && await serviceManager.isServiceRunning();

    if (useService) {
      console.log('[TunManager] Using service mode for password-free sync');
      const result = await grantPermissions();
      if (result.success) {
        console.log('[TunManager] Kernel synced successfully via service');
        return { success: true, synced: true, viaService: true };
      }
    }

    return { success: false, needsManualAuth: true, reason: updateCheck.reason };
  }

  async function toggleTun(enabled) {
    try {
      if (enabled) {
        if (isWindows) {
          console.log('[TunManager] Windows detected, checking permission for TUN toggle...');

          // 复用统一的权限检查逻辑
          const perm = await checkPermission();
          if (!perm || !perm.success || !perm.hasPermission) {
            const details = perm?.details || {};
            const serviceInfo = details.service || {};
            const isInstalled = serviceInfo.installed;
            const isRunning = serviceInfo.running;
            const isAdmin = details.isAdmin;

            // 优先给出更友好的提示
            if (isInstalled === false) {
              return { success: false, error: 'TUN 服务未安装，请在 TUN 设置页面安装服务，或以管理员身份运行 FlyClash' };
            }
            if (isInstalled && isRunning === false) {
              return { success: false, error: 'TUN 服务未运行，请在 TUN 设置页面启动服务，或以管理员身份运行 FlyClash' };
            }
            if (!isAdmin && !isRunning) {
              return { success: false, error: 'TUN 模式需要服务模式或以管理员身份运行 FlyClash' };
            }

            return { success: false, error: 'TUN 模式缺少必要权限，请先完成授权' };
          }
        } else {
          console.log('[TunManager] Toggling TUN to enabled, checking authorization...');

          if (isMac) {
            // macOS: 检查系统内核权限 + 版本一致性
            const systemKernelPath = getSystemKernelPath();
            const sourceKernelPath = getSourceKernelPath();
            let authorized = false;

            if (fs.existsSync(systemKernelPath)) {
              const systemProbe = await probeAuthorization(systemKernelPath);
              // 权限OK且版本一致才算授权通过
              let versionMatch = true;
              if (sourceKernelPath && fs.existsSync(sourceKernelPath)) {
                try {
                  versionMatch = fs.readFileSync(sourceKernelPath).compare(fs.readFileSync(systemKernelPath)) === 0;
                } catch {}
              }
              authorized = systemProbe.ok && versionMatch;
              console.log('[TunManager] System kernel check:', {
                probeOk: systemProbe.ok, versionMatch, authorized
              });
            }

            if (!authorized) {
              console.warn('[TunManager] macOS kernel not authorized or outdated');
              return { success: false, error: '缺少必要权限或内核已更新，请先进行授权', needsAuth: true };
            }
          } else if (isLinux) {
            // Linux: 直接检查当前内核权限
            const kernelPath = getKernelPath();
            const probe = await probeAuthorization(kernelPath);
            console.log('[TunManager] Linux kernel authorization probe:', {
              path: kernelPath, ok: probe.ok, issues: probe.issues
            });

            if (!probe.ok) {
              console.warn('[TunManager] Missing permissions, cannot enable TUN');
              return { success: false, error: '缺少必要权限，请先进行授权' };
            }
          }

          console.log('[TunManager] Authorization check passed, proceeding to enable TUN');
        }
      }

      const updateUserSettingsRaw = context.updateUserSettingsRaw;
      if (!updateUserSettingsRaw) return { success: false, error: 'TUN 模式切换失败' };

      const savedTun = context.dbManager.getSetting('tunConfig', null);
      const baseTun = savedTun ? {
        enable: enabled,
        device: savedTun.device,
        stack: savedTun.stack,
        'auto-route': savedTun.autoRoute,
        'auto-redirect': savedTun.autoRedirect,
        'auto-detect-interface': savedTun.autoDetectInterface,
        'dns-hijack': savedTun.dnsHijack,
        'strict-route': savedTun.strictRoute,
        'route-exclude-address': savedTun.routeExcludeAddress,
        mtu: savedTun.mtu,
        ...(isMac && savedTun.autoSetDNS !== undefined ? { 'auto-set-dns': savedTun.autoSetDNS } : {})
      } : {
        enable: enabled,
        device: isMac ? 'utun' : 'mihomo',
        stack: 'system',
        'auto-route': true,
        'auto-redirect': false,
        'auto-detect-interface': true,
        'dns-hijack': ['any:53'],
        'strict-route': false,
        'route-exclude-address': [],
        mtu: 1500,
        ...(isMac ? { 'auto-set-dns': true } : {})
      };

      const updatePayload = { tun: baseTun };

      if (enabled) {
        const currentSettings = context.getUserSettings();
        const currentDns = currentSettings.dns || {};
        const currentMode = currentDns['enhanced-mode'];

        if (!currentMode || currentMode === 'fake-ip') {
          const ipv6 = currentSettings.ipv6 || false;
          updatePayload.dns = {
            enable: true,
            ipv6: ipv6,
            'enhanced-mode': 'fake-ip',
            'fake-ip-range': '198.18.0.1/16',
            ...currentDns
          };
        }
      }

      updateUserSettingsRaw(updatePayload);

      // 持久化当前 TUN 开关状态（用于记忆上次状态）
      if (context.setTunModeEnabled) {
        context.setTunModeEnabled(enabled);
      }
      if (context.state) {
        context.state.tunModeEnabled = enabled;
      }

      // 检查运行模式
      const { getRunningMode, RunningMode, isRunning } = require('../utils/running-mode');
      const runningMode = getRunningMode();
      console.log('[TunManager] Current running mode:', runningMode);

      // 如果内核没有运行，只更新配置状态
      if (!isRunning() && !context.state.mihomoProcess) {
        console.log('[TunManager] Kernel not running, config updated only');
        return { success: true, pending: true };
      }

      // 检查配置文件路径
      if (!context.state.configFilePath) {
        console.log('[TunManager] No config file path, config updated only');
        return { success: true, pending: true };
      }

      // 重启内核（服务模式和 sidecar 模式都通过 mihomoService 处理）
      const ok = await context.mihomoService?.restartMihomo?.(context.state.configFilePath);
      if (!ok) {
        // rollback
        updateUserSettingsRaw({ tun: { enable: false } });
        // 启动失败时才回滚 tunModeEnabled（只在本次是启用操作时）
        if (enabled) {
          if (context.setTunModeEnabled) {
            context.setTunModeEnabled(false);
          }
          if (context.state) {
            context.state.tunModeEnabled = false;
          }
        }
        return { success: false, error: '内核重启失败，请检查配置' };
      }

      // Verify runtime
      if (enabled && !isWindows) {
        const ready = await waitForTun(true, 6000);
        if (!ready) {
          updateUserSettingsRaw({ tun: { enable: false } });
          // TUN 接口启动失败，回滚授权状态
          if (context.setTunModeEnabled) {
            context.setTunModeEnabled(false);
          }
          if (context.state) {
            context.state.tunModeEnabled = false;
          }
          return { success: false, error: 'TUN 模式启动失败，请重试' };
        }

        // 尝试设置系统 DNS（仅通过 service，不弹密码框）
        if (isMac) {
          console.log('[TunManager] Attempting to set system DNS for TUN mode...');
          const dnsResult = await setSystemDns('198.18.0.1');
          if (dnsResult.success) {
            console.log('[TunManager] ✓ System DNS set to 198.18.0.1 via service');
          } else {
            console.log('[TunManager] ℹ DNS not set via system (using TUN DNS hijacking):', dnsResult.reason);
            // 这是正常的，TUN 的 DNS 劫持会处理所有 DNS 请求
          }
        }
      } else if (!enabled && !isWindows) {
        // 禁用 TUN 时恢复原始 DNS（仅通过 service，不弹密码框）
        if (isMac) {
          console.log('[TunManager] Attempting to restore original system DNS...');
          const restoreResult = await restoreSystemDns();
          if (restoreResult.success) {
            console.log('[TunManager] ✓ System DNS restored via service');
          } else {
            console.log('[TunManager] ℹ DNS not restored via service:', restoreResult.reason);
            // DNS 会在用户下次手动修改或重启系统后自动恢复
          }
        }
        await waitForTun(false, 4000); // best effort
      }

      return { success: true };
    } catch (e) {
      return { success: false, error: getUserFriendlyError(e, 'toggle') };
    }
  }

  async function checkPermission() {
    try {
      if (isMac) {
        // 优先检查系统内核是否已授权
        const systemKernelPath = getSystemKernelPath();
        console.log('[TunManager] Checking permission...');
        console.log('[TunManager] System kernel path:', systemKernelPath);

        if (fs.existsSync(systemKernelPath)) {
          const systemProbe = await probeAuthorization(systemKernelPath);
          console.log('[TunManager] System kernel probe result:', {
            path: systemKernelPath,
            ok: systemProbe.ok,
            issues: systemProbe.issues
          });

          if (systemProbe.ok) {
            console.log('[TunManager] ✓ System kernel is authorized');
            return {
              success: true,
              hasPermission: true,
              details: { path: systemKernelPath, type: 'system' }
            };
          }
        }

        // 系统内核不可用，检查当前内核
        const kernelPath = getKernelPath();
        console.log('[TunManager] Checking current kernel:', kernelPath);
        const probe = await probeAuthorization(kernelPath);
        console.log('[TunManager] Current kernel probe result:', {
          ok: probe.ok,
          issues: probe.issues
        });

        return {
          success: true,
          hasPermission: probe.ok,
          details: { path: kernelPath, type: 'current' }
        };
      }

      if (isLinux) {
        const kernelPath = getKernelPath();
        let ok = false;
        try {
          const cap = execSync(`getcap "${kernelPath}" || true`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
          ok = /cap_net_admin/i.test(cap);
        } catch {}
        const st = statInfo(kernelPath);
        if (!ok) ok = st.exists && st.uid === 0 && st.isSetuid;
        return { success: true, hasPermission: ok, details: { path: kernelPath, stat: st } };
      }

      // Windows 平台：综合检查服务状态和管理员权限
      if (isWindows) {
        const elevationMode = getTunElevationMode();
        console.log('[TunManager] Windows checking permission, mode:', elevationMode);

        let isInstalled = false;
        let isRunning = false;
        let taskExists = false;
        let isAdmin = false;

        // 服务状态
        const coreService = getCoreService();
        if (coreService) {
          try {
            isInstalled = await coreService.isInstalled();
            isRunning = isInstalled ? await coreService.isRunning() : false;
          } catch (e) {
            console.warn('[TunManager] Windows service status check failed:', e.message);
          }
        }

        // 计划任务 / 管理员状态
        try {
          const PermissionManager = require('./permission-manager');
          const permissionManager = new PermissionManager();
          taskExists = await permissionManager.checkElevateTask();
          isAdmin = await permissionManager.checkAdminPrivileges();
        } catch (e) {
          console.warn('[TunManager] Windows task/admin status check failed:', e.message);
        }

        const hasServicePermission = isInstalled && isRunning;
        const hasAdminPermission = isAdmin;
        const hasPermission = hasServicePermission || hasAdminPermission;

        const details = {
          mode: hasServicePermission
            ? 'service'
            : hasAdminPermission
              ? 'admin'
              : elevationMode === 'task'
                ? 'task'
                : 'none',
          service: { installed: isInstalled, running: isRunning },
          task: { exists: taskExists },
          isAdmin
        };

        const extra = {};
        if (!hasServicePermission && elevationMode === 'service') {
          if (!isInstalled) {
            extra.needsInstall = true;
          } else if (!isRunning) {
            extra.needsStart = true;
          }
        }

        return {
          success: true,
          hasPermission,
          details,
          ...extra
        };
      }

      return { success: false, hasPermission: false };
    } catch (e) {
      console.error('[TunManager] checkPermission failed:', e);
      return { success: false, hasPermission: false, error: '权限检查失败' };
    }
  }

  // Windows 服务管理函数
  async function installService(options = {}) {
    if (!isWindows) {
      return { success: false, error: '仅支持 Windows 平台' };
    }

    const coreService = getCoreService();
    if (!coreService) {
      return { success: false, error: '服务模块不可用' };
    }

    const kernelPath = options.corePath || getKernelPath();
    return await coreService.install({ corePath: kernelPath });
  }

  async function uninstallService() {
    if (!isWindows) {
      return { success: false, error: '仅支持 Windows 平台' };
    }

    const coreService = getCoreService();
    if (!coreService) {
      return { success: false, error: '服务模块不可用' };
    }

    return await coreService.uninstall();
  }

  async function startService() {
    if (!isWindows) {
      return { success: false, error: '仅支持 Windows 平台' };
    }

    const coreService = getCoreService();
    if (!coreService) {
      return { success: false, error: '服务模块不可用' };
    }

    return await coreService.start();
  }

  async function stopService() {
    if (!isWindows) {
      return { success: false, error: '仅支持 Windows 平台' };
    }

    const coreService = getCoreService();
    if (!coreService) {
      return { success: false, error: '服务模块不可用' };
    }

    return await coreService.stop();
  }

  async function getServiceStatus() {
    if (!isWindows) {
      return { installed: false, running: false, mode: null };
    }

    const coreService = getCoreService();
    if (!coreService) {
      return { installed: false, running: false, mode: 'task' };
    }

    const installed = await coreService.isInstalled();
    const running = installed ? await coreService.isRunning() : false;
    const mode = getTunElevationMode();

    return { installed, running, mode };
  }

  context.tunManager = {
    getKernelPath,
    probeAuthorization,
    grantPermissions,
    grantPermissionsViaTask,
    toggleTun,
    checkPermission,
    isTunActive,
    checkKernelUpdate,
    autoSyncKernel,
    setSystemDns,
    restoreSystemDns,
    // Windows 服务相关
    getTunElevationMode,
    setTunElevationMode,
    installService,
    uninstallService,
    startService,
    stopService,
    getServiceStatus
  };

  return context.tunManager;
};
