TUN Mode (macOS/Linux) – Privileged Flow Plan

Overview
- One-time authorization and robust runtime checks inspired by Sparkle’s helper approach.
- Backed by a cross‑platform manager in `electron/main-process/tun-manager.js`.

macOS (preferred)
- Short term: authorize kernel by setting `root:wheel` + `chmod u+s` and clearing quarantine. A functional probe verifies capability.
- Long term: replace SUID with a SMJobBless privileged helper:
  - Helper is installed to `/Library/PrivilegedHelperTools`.
  - Electron main talks to the helper via XPC.
  - Helper performs: copy/authorize kernel, run probe, start/stop TUN, DNS/route fixes.
  - Requires Apple Developer signing and proper entitlements.

Linux
- Prefer `setcap cap_net_admin,cap_net_bind_service=+eip` on the kernel binary via `pkexec`.
- Fallback to `root:root` + `+sx` when capabilities unavailable.
- Functional probe verifies capability before enabling TUN.

Functional Probe
- Launches kernel briefly with minimal `tun.enable=true` (no route/DNS changes) to prove privileges functionally.
- Uses log parsing and interface presence (`utun*` on macOS; `ip link` on Linux) to decide.

Renderer/IPC
- Existing IPC endpoints remain. Internally, `system-integration` delegates to `tun-manager` step‑by‑step.

Next Steps (to reach Sparkle‑grade UX)
1) Add SMJobBless helper project (Objective‑C/XPC) with signed install/uninstall.
2) Move all privileged operations into helper; main process only requests.
3) Add structured status reporting (authorized/installed/version/healthy) exposed to UI.

