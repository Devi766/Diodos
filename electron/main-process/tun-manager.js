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

  const isMac = process.platform === 'darwin';
  const isLinux = process.platform === 'linux';

  function getKernelPath() {
    try {
      if (typeof context.getKernelExecutablePath === 'function') {
        const p = context.getKernelExecutablePath();
        if (p && fs.existsSync(p)) return p;
      }
    } catch {}
    try {
      const p = context.mihomoService?.getKernelPath?.();
      if (p && fs.existsSync(p)) return p;
    } catch {}
    try {
      // Fallback to permissionManager scan
      const PermissionManager = require('./permission-manager');
      const pm = new PermissionManager();
      const p = pm.getCorePath();
      if (p && fs.existsSync(p)) return p;
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
    if (isMac) {
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
      result.ok = true;
      return result;
    }

    // Else fall back to metadata heuristic
    if (isMac) {
      result.ok = st.uid === 0 && st.gid === 0 && st.isSetuid && !hasQuarantine(kernelPath);
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
    let kernelPath = getKernelPath();
    if (!kernelPath || !fs.existsSync(kernelPath)) {
      return { success: false, error: 'Kernel path not found' };
    }

    if (isMac) {
      const escape = (s) => String(s).replace(/([\\`"$])/g, '\\$1').replace(/ /g, '\\ ');
      // If user explicitly chose custom path, authorize in place
      try {
        const pref = context.kernelPreference || (typeof context.loadKernelPreference === 'function' ? context.loadKernelPreference() : {});
        const isUserCustom = preferCustom && pref && pref.customPath && fs.existsSync(pref.customPath) && path.resolve(pref.customPath) === path.resolve(kernelPath);
        if (isUserCustom) {
          const as = `do shell script \"xattr -d com.apple.quarantine ${escape(kernelPath)} || true && chown root:wheel ${escape(kernelPath)} && chmod u+s ${escape(kernelPath)}\" with administrator privileges`;
          execSync(`osascript -e '${as}'`, { stdio: 'ignore' });
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
      execSync(`osascript -e '${as}'`, { stdio: 'ignore' });
      try { context.saveKernelPreference?.({ customPath: targetPath }); } catch {}
      const probe2 = await probeAuthorization(targetPath);
      if (probe2.ok) return { success: true, message: 'Installed and authorized system kernel' };
      return { success: false, error: 'Authorization did not pass probe' };
    }

    if (isLinux) {
      try {
        execSync(`pkexec setcap cap_net_admin,cap_net_bind_service=+eip "${kernelPath}"`, { stdio: 'ignore' });
      } catch {
        try {
          execSync(`pkexec chown root:root "${kernelPath}"`, { stdio: 'ignore' });
          execSync(`pkexec chmod +sx "${kernelPath}"`, { stdio: 'ignore' });
        } catch (e) {
          return { success: false, error: e?.message || String(e) };
        }
      }
      const probe = await probeAuthorization(kernelPath);
      return probe.ok ? { success: true } : { success: false, error: 'Authorization did not pass probe' };
    }

    return { success: false, error: 'Unsupported platform' };
  }

  async function toggleTun(enabled) {
    try {
      if (enabled) {
        const kernelPath = getKernelPath();
        const probe = await probeAuthorization(kernelPath);
        if (!probe.ok) {
          return { success: false, error: 'Permission missing. Please grant TUN permissions first.' };
        }
      }

      const updateUserSettingsRaw = context.updateUserSettingsRaw;
      if (!updateUserSettingsRaw) return { success: false, error: 'Settings handler not available' };

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
        return { success: false, error: 'Kernel restart failed' };
      }

      // Verify runtime
      if (enabled) {
        const ready = await waitForTun(true, 6000);
        if (!ready) {
          updateUserSettingsRaw({ tun: { enable: false } });
          return { success: false, error: 'TUN did not become active' };
        }
      } else {
        await waitForTun(false, 4000); // best effort
      }

      return { success: true };
    } catch (e) {
      return { success: false, error: e?.message || String(e) };
    }
  }

  async function checkPermission() {
    const kernelPath = getKernelPath();
    const probe = await probeAuthorization(kernelPath);
    return { success: true, hasPermission: !!probe.ok, details: probe };
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

