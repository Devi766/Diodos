/**
 * Cross‑platform TUN manager (macOS/Linux)
 *
 * Goals (Sparkle‑like UX):
 * 1) Structured permission probe before enabling TUN
 * 2) One‑time authorization flow, prefer custom kernel path when provided
 * 3) Start/Stop with verification; rollback on failure
 */

module.exports = function initTunManager(context) {
  const { fs, path, spawn, execSync } = context;
  const { promisify } = require('util');
  const { execFile } = require('child_process');
  const execFilePromise = promisify(execFile);

  const isMac = process.platform === 'darwin';
  const isLinux = process.platform === 'linux';

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
  function asQuotedPath(p) {
    const s = String(p).replace(/\"/g, '\\"');
    // Simply quote the raw path as text for shell; AppleScript will escape it safely
    return `quoted form of \"${s}\"`;
  }
  function buildASAuthorizeCustom(p) {
    const qp = asQuotedPath(p);
    // Wrap each command properly to ensure all steps execute
    // Use subshell for xattr to ensure || true doesn't affect subsequent commands
    return `do shell script ("(xattr -d com.apple.quarantine " & ${qp} & " || true) && chown root:wheel " & ${qp} & " && chmod u+s " & ${qp}) with administrator privileges`;
  }
  function buildASInstallAuthorize(src, dir, dst) {
    const qsrc = asQuotedPath(src);
    const qdir = asQuotedPath(dir);
    const qdst = asQuotedPath(dst);
    return `do shell script ("mkdir -p " & ${qdir} & " && cp -f " & ${qsrc} & " " & ${qdst} & " && (xattr -d com.apple.quarantine " & ${qdst} & " || true) && chown root:wheel " & ${qdst} & " && chmod u+s " & ${qdst}) with administrator privileges`;
  }

  function getSystemKernelPath() {
    // 使用用户目录下的固定路径，作为应用包内内核的授权副本
    const userDataPath = context.get('userDataPath');
    return path.join(userDataPath, 'mihomo-kernel', 'mihomo');
  }

  function isKernelInAppBundle(kernelPath) {
    if (!kernelPath) return false;
    // 检查路径是否在应用包内
    return kernelPath.includes('.app/Contents/Resources') ||
           kernelPath.includes('.app\\Contents\\Resources') ||
           kernelPath.includes(process.resourcesPath);
  }

  function getKernelPath() {
    // 获取用户配置的路径或默认路径
    let kernelPath = '';
    try {
      if (typeof context.getKernelExecutablePath === 'function') {
        kernelPath = context.getKernelExecutablePath();
      }
    } catch {}
    if (!kernelPath || !fs.existsSync(kernelPath)) {
      try {
        kernelPath = context.mihomoService?.getKernelPath?.();
      } catch {}
    }
    if (!kernelPath || !fs.existsSync(kernelPath)) {
      try {
        const PermissionManager = require('./permission-manager');
        const pm = new PermissionManager();
        kernelPath = pm.getCorePath();
      } catch {}
    }

    if (!kernelPath || !fs.existsSync(kernelPath)) {
      console.warn('[TunManager] No kernel path found');
      return '';
    }

    // macOS 特殊处理
    if (isMac) {
      const inAppBundle = isKernelInAppBundle(kernelPath);

      if (inAppBundle) {
        // 应用包内的内核，检查是否有授权的系统副本
        const systemPath = getSystemKernelPath();
        if (fs.existsSync(systemPath)) {
          const st = statInfo(systemPath);
          const quarantine = hasQuarantine(systemPath);
          if (st.exists && st.uid === 0 && st.gid === 0 && st.isSetuid && !quarantine) {
            console.log('[TunManager] Using authorized system copy:', systemPath);
            return systemPath;
          }
        }
        console.log('[TunManager] Using app bundle kernel (needs authorization):', kernelPath);
        return kernelPath;
      } else {
        // 用户自定义路径（应用包外），直接使用
        const st = statInfo(kernelPath);
        const quarantine = hasQuarantine(kernelPath);
        const isAuthorized = st.exists && st.uid === 0 && st.gid === 0 && st.isSetuid && !quarantine;
        console.log('[TunManager] Using custom kernel:', kernelPath, isAuthorized ? '(authorized)' : '(needs authorization)');
        return kernelPath;
      }
    }

    console.log('[TunManager] Using kernel path:', kernelPath);
    return kernelPath;
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
        // mihomo 默认设备名可能是 mihomo 或 tunX，这里做一个宽松匹配
        return /(mihomo|tun\d+)/.test(out);
      }
      return false;
    } catch { return false; }
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
      const quarantine = hasQuarantine(kernelPath);
      result.ok = st.uid === 0 && st.gid === 0 && st.isSetuid && !quarantine;
      console.log('[TunManager] Metadata check:', {
        uid: st.uid,
        gid: st.gid,
        isSetuid: st.isSetuid,
        hasQuarantine: quarantine,
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

    // macOS 授权
    if (isMac) {
      try {
        // 获取当前内核路径
        let kernelPath = null;
        try {
          if (typeof context.getKernelExecutablePath === 'function') {
            kernelPath = context.getKernelExecutablePath();
          }
        } catch {}
        if (!kernelPath || !fs.existsSync(kernelPath)) {
          try {
            kernelPath = context.mihomoService?.getKernelPath?.();
          } catch {}
        }

        if (!kernelPath || !fs.existsSync(kernelPath)) {
          console.error('[TunManager] Kernel not found');
          return { success: false, error: '未找到内核文件' };
        }

        console.log('[TunManager] Kernel path:', kernelPath);

        const inAppBundle = isKernelInAppBundle(kernelPath);
        console.log('[TunManager] Kernel in app bundle:', inAppBundle);

        if (inAppBundle) {
          // 应用包内的内核 → 复制到系统路径并授权
          const systemPath = getSystemKernelPath();
          const systemDir = path.dirname(systemPath);

          console.log('[TunManager] Copying to system path:', systemPath);

          const script = buildASInstallAuthorize(kernelPath, systemDir, systemPath);
          await execFilePromise('osascript', ['-e', script]);

          // 验证授权
          const st = statInfo(systemPath);
          const quarantine = hasQuarantine(systemPath);
          console.log('[TunManager] System kernel stat:', {
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
            console.log('[TunManager] System kernel authorized successfully');
            return { success: true, message: 'System kernel authorized' };
          }

          console.error('[TunManager] Authorization probe failed:', probe.issues);
          return { success: false, error: '授权验证失败，请重试' };
        } else {
          // 用户自定义路径（应用包外） → 直接在原地授权
          console.log('[TunManager] Authorizing custom kernel in place');

          const script = buildASAuthorizeCustom(kernelPath);
          await execFilePromise('osascript', ['-e', script]);

          // 验证授权
          const st = statInfo(kernelPath);
          const quarantine = hasQuarantine(kernelPath);
          console.log('[TunManager] Custom kernel stat:', {
            path: kernelPath,
            uid: st.uid,
            gid: st.gid,
            mode: st.mode?.toString(8),
            isSetuid: st.isSetuid,
            hasQuarantine: quarantine
          });

          const probe = await probeAuthorization(kernelPath);
          if (probe.ok) {
            console.log('[TunManager] Custom kernel authorized successfully');
            return { success: true, message: 'Custom kernel authorized' };
          }

          console.error('[TunManager] Authorization probe failed:', probe.issues);
          return { success: false, error: '授权验证失败，请重试' };
        }
      } catch (e) {
        console.error('[TunManager] Grant permissions failed:', e);
        return { success: false, error: getUserFriendlyError(e, 'authorization') };
      }
    }

    // Legacy macOS flow with buggy escaping (disabled)
    if (false && isMac) {
      const escape = (s) => String(s).replace(/([\\`"$])/g, '\\$1').replace(/ /g, '\\ ');
      // If user explicitly chose custom path, authorize in place
      try {
        const pref = context.kernelPreference || (typeof context.loadKernelPreference === 'function' ? context.loadKernelPreference() : {});
        const isUserCustom = preferCustom && pref && pref.customPath && fs.existsSync(pref.customPath) && path.resolve(pref.customPath) === path.resolve(kernelPath);
        if (isUserCustom) {
          const as = `do shell script \"xattr -d com.apple.quarantine ${escape(kernelPath)} || true && chown root:wheel ${escape(kernelPath)} && chmod u+s ${escape(kernelPath)}\" with administrator privileges`;
          await execFilePromise('osascript', ['-e', as]);
          const probe = await probeAuthorization(kernelPath);
          if (probe.ok) return { success: true, message: 'Authorized custom kernel' };
        }
      } catch (e) {
        // fallback to system install
      }
      // Install into system path once
      const targetDir = '/Library/Application Support/FlyClash';
      const targetPath = `${targetDir}/mihomo`;
      const as = `do shell script \"mkdir -p ${escape(targetDir)} && cp -f ${escape(kernelPath)} ${escape(targetPath)} && xattr -d com.apple.quarantine ${escape(targetPath)} || true && chown root:wheel ${escape(targetPath)} && chmod u+s ${escape(targetPath)}\" with administrator privileges`;
      await execFilePromise('osascript', ['-e', as]);
      try { context.saveKernelPreference?.({ customPath: targetPath }); } catch {}
      const probe2 = await probeAuthorization(targetPath);
      if (probe2.ok) return { success: true, message: 'Installed and authorized system kernel' };
      return { success: false, error: '授权验证失败，请重试' };
    }

    if (isLinux) {
      try {
        execSync(`pkexec setcap cap_net_admin,cap_net_bind_service=+eip "${kernelPath}"`, { stdio: 'ignore' });
      } catch {
        try {
          execSync(`pkexec chown root:root "${kernelPath}"`, { stdio: 'ignore' });
          execSync(`pkexec chmod +sx "${kernelPath}"`, { stdio: 'ignore' });
        } catch (e) {
          return { success: false, error: getUserFriendlyError(e, 'authorization') };
        }
      }
      const probe = await probeAuthorization(kernelPath);
      return probe.ok ? { success: true } : { success: false, error: '授权验证失败，请重试' };
    }

    return { success: false, error: '不支持的操作系统' };
  }

  async function toggleTun(enabled) {
    try {
      if (enabled) {
        console.log('[TunManager] Toggling TUN to enabled, checking authorization...');
        const kernelPath = getKernelPath();
        const probe = await probeAuthorization(kernelPath);
        console.log('[TunManager] Authorization probe result:', { ok: probe.ok, issues: probe.issues });
        if (!probe.ok) {
          console.warn('[TunManager] Missing permissions, cannot enable TUN');
          return { success: false, error: '缺少必要权限，请先进行授权' };
        }
        console.log('[TunManager] Authorization check passed, proceeding to enable TUN');
      }

      const updateUserSettingsRaw = context.updateUserSettingsRaw;
      if (!updateUserSettingsRaw) return { success: false, error: 'TUN 模式切换失败' };

      // Persist tun config (keep user’s saved fields)
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
      updateUserSettingsRaw({ tun: baseTun });

      // Restart kernel via service
      if (!context.state.mihomoProcess || !context.state.configFilePath) {
        // No process yet; reflect target state only
        return { success: true, pending: true };
      }

      const ok = await context.mihomoService?.restartMihomo?.(context.state.configFilePath);
      if (!ok) {
        // rollback
        updateUserSettingsRaw({ tun: { enable: false } });
        return { success: false, error: '内核重启失败，请检查配置' };
      }

      // Verify runtime
      if (enabled) {
        const ready = await waitForTun(true, 6000);
        if (!ready) {
          updateUserSettingsRaw({ tun: { enable: false } });
          return { success: false, error: 'TUN 模式启动失败，请重试' };
        }
      } else {
        await waitForTun(false, 4000); // best effort
      }

      return { success: true };
    } catch (e) {
      return { success: false, error: getUserFriendlyError(e, 'toggle') };
    }
  }

  async function checkPermission() {
    try {
      const kernelPath = getKernelPath();
      const st = statInfo(kernelPath);
      if (isMac) {
        const quarantine = hasQuarantine(kernelPath);
        const ok = st.exists && st.uid === 0 && st.gid === 0 && st.isSetuid && !quarantine;
        console.log('[TunManager] Check permission:', {
          path: kernelPath,
          exists: st.exists,
          uid: st.uid,
          gid: st.gid,
          mode: st.mode?.toString(8),
          isSetuid: st.isSetuid,
          hasQuarantine: quarantine,
          hasPermission: ok
        });
        return { success: true, hasPermission: ok, details: { path: kernelPath, stat: st } };
      }
      if (isLinux) {
        let ok = false;
        try {
          const cap = execSync(`getcap "${kernelPath}" || true`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
          ok = /cap_net_admin/i.test(cap);
        } catch {}
        if (!ok) ok = st.exists && st.uid === 0 && st.isSetuid;
        return { success: true, hasPermission: ok, details: { path: kernelPath, stat: st } };
      }
      return { success: false, hasPermission: false };
    } catch (e) {
      return { success: false, hasPermission: false, error: '权限检查失败' };
    }
  }

  context.tunManager = {
    getKernelPath,
    probeAuthorization,
    grantPermissions,
    toggleTun,
    checkPermission,
    isTunActive
  };

  return context.tunManager;
};
