# TUN Mode Improvements for macOS and Linux

## Important Fix for macOS Permission Error

**Problem:** macOS security prevents:
1. Modifying file ownership/permissions in user directories, even with admin privileges via osascript
2. Using `cp` command to copy files from user directories to system directories with osascript

**Solution:** The authorization process now uses a two-step approach:
1. **Node.js Copy to /tmp**: First, use Node.js `fs.copyFileSync()` to copy the kernel to `/tmp` (no admin privileges needed)
2. **Privileged Move**: Use osascript with admin privileges to move the file from `/tmp` to `/Library/Application Support/Flycast/mihomo`
3. **Authorize**: Use osascript with admin privileges to set proper ownership (root:wheel) and setuid bit
4. **Use System Copy**: All TUN operations use the authorized system copy at `/Library/Application Support/Flycast/mihomo`

This two-step approach bypasses macOS security restrictions:
- `/tmp` is world-writable, so Node.js can copy there without privileges
- Moving from `/tmp` to system directory works with osascript admin privileges
- Once in system directory, ownership and permissions can be modified

## Changes Made

### 1. TUN Configuration Auto-Enhancement

**File: `electron/main-process/tun-manager.js`**

- Modified `toggleTun()` function to automatically configure DNS when enabling TUN mode
- Automatically sets DNS to fake-ip mode with range 198.18.0.1/16
- Automatically manages system DNS (223.6.6.6 on macOS when TUN is enabled)
- Backs up and restores original DNS settings when TUN is disabled

### 2. Service Mode Implementation

**New Files:**
- `electron/service/service-helper.js` - Service daemon that runs with root privileges
- `electron/service/install-service.sh` - macOS service installation script
- `electron/service/uninstall-service.sh` - macOS service uninstallation script
- `electron/service/install-service-linux.sh` - Linux service installation script
- `electron/service/uninstall-service-linux.sh` - Linux service uninstallation script
- `electron/main-process/service-manager.js` - Service manager for IPC communication

**How Service Mode Works:**

macOS:
- Uses launchd to run service-helper as a persistent daemon
- Service listens on /tmp/flycast-service.sock
- First installation requires admin password via osascript
- After installation, authorization and DNS changes happen without password prompts
- Uses HMAC secret for authentication between app and service

Linux:
- Uses systemd to run service-helper as a persistent daemon
- Service listens on /tmp/flycast-service.sock
- Installation uses pkexec for privilege escalation
- After installation, no password required for operations

**Benefits:**
- Only need to enter password ONCE when installing service
- All subsequent TUN enable/disable operations are password-free
- Kernel authorization is done by the privileged service
- System DNS changes are done by the privileged service

### 3. Integration with Existing Code

**Modified Files:**
- `electron/main.js` - Added service-manager initialization and IPC handlers
- `electron/preload.js` - Added service-related API exports
- `electron/main-process/tun-manager.js` - Integrated service manager for authorization and DNS

**New IPC Handlers:**
- `service-is-running` - Check if service is running
- `service-install` - Install the privileged service
- `service-uninstall` - Uninstall the privileged service

**Service Manager API:**
- `isServiceRunning()` - Check service status
- `installService()` - Install service (requires admin password)
- `uninstallService()` - Uninstall service (requires admin password)
- `authorizeBinary(binPath)` - Authorize mihomo binary (no password if service running)
- `setSystemDns(service, dns)` - Set system DNS (no password if service running)

### 4. Fallback Mechanism

The implementation includes automatic fallback:
- If service is not installed or not running, falls back to osascript method
- Each operation checks service availability before attempting to use it
- No breaking changes to existing functionality

## Usage Flow

### First Time Setup:
1. User enables TUN mode
2. App checks if service is installed
3. If not installed, prompts to install service (requires admin password)
4. Service installs and starts as daemon
5. App uses service to authorize kernel and set DNS (no more passwords needed)

### Subsequent Usage:
1. User enables/disables TUN mode
2. App communicates with running service via IPC socket
3. Service performs privileged operations (kernel auth, DNS changes)
4. No password prompts required

## Files Modified

- electron/main.js
- electron/preload.js
- electron/main-process/tun-manager.js

## Files Created

- electron/service/service-helper.js
- electron/service/install-service.sh
- electron/service/uninstall-service.sh
- electron/service/install-service-linux.sh
- electron/service/uninstall-service-linux.sh
- electron/main-process/service-manager.js

## Testing

To test the implementation:

1. Build the application
2. Run the application
3. Try to enable TUN mode
4. If prompted, install the service (enter admin password once)
5. TUN should enable without additional password prompts
6. Disable and re-enable TUN - should work without password
7. Check that DNS is automatically configured when TUN is enabled
8. Check that DNS is restored when TUN is disabled
