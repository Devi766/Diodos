# macOS TUN Mode Authorization Fix

## Problem

Two permission errors encountered on macOS:

### Error 1: Operation not permitted when modifying files in user directory
```
xattr: [Errno 1] Operation not permitted: '/Users/none/Documents/...'
chown: /Users/none/Documents/.../mihomo: Operation not permitted
```

**Cause:** macOS prevents modifying file ownership/permissions in user directories, even with admin privileges.

### Error 2: Operation not permitted when copying from user directory
```
cp: /Users/none/Documents/.../mihomo: Operation not permitted
chown: /Library/Application Support/Flycast/mihomo: No such file or directory
```

**Cause:** macOS security prevents using `cp` command with admin privileges to copy from certain user directories.

## Solution

Implemented a two-step authorization process:

### Step 1: Copy to /tmp (No privileges needed)
```javascript
fs.copyFileSync(sourceKernelPath, tmpPath);
fs.chmodSync(tmpPath, 0o755);
```

### Step 2: Move and authorize (Admin privileges)
```bash
do shell script "mkdir -p '/Library/Application Support/Flycast' &&
                 mv -f '/tmp/flycast-mihomo-...' '/Library/Application Support/Flycast/mihomo'"
                 with administrator privileges

do shell script "xattr -d com.apple.quarantine '/Library/Application Support/Flycast/mihomo' 2>/dev/null || true &&
                 chown root:wheel '/Library/Application Support/Flycast/mihomo' &&
                 chmod u+s '/Library/Application Support/Flycast/mihomo'"
                 with administrator privileges
```

## Why This Works

1. `/tmp` directory is world-writable - Node.js can copy there without privileges
2. `mv` command from `/tmp` to system directory works with admin privileges
3. Once in system directory (`/Library/Application Support/`), can modify ownership and permissions
4. All subsequent TUN operations use the authorized system copy

## Code Changes

**File: electron/main-process/tun-manager.js**

### New Functions:
- `buildASAuthorize(targetDir, targetPath)` - Build AppleScript for authorization only
- `getSystemKernelPath()` - Return system kernel path
- `getSourceKernelPath()` - Return original kernel path

### Modified Functions:
- `getKernelPath()` - Prefer authorized system copy
- `grantPermissions()` - Implement two-step copy/authorize process

### Logic Flow:

```
1. Check if system copy exists and is up-to-date
   ↓
2. If needs copy:
   a. fs.copyFileSync(source, /tmp/flycast-mihomo-TIMESTAMP)
   b. osascript: mv /tmp/... → /Library/Application Support/Flycast/mihomo
   ↓
3. osascript: Authorize system copy (chown root:wheel, chmod u+s)
   ↓
4. Verify authorization
```

## Testing

Run the application and try to enable TUN mode:

1. Should prompt for admin password once
2. File should be copied to `/Library/Application Support/Flycast/mihomo`
3. File should have proper permissions:
   ```bash
   ls -la "/Library/Application Support/Flycast/mihomo"
   # Should show: -rwsr-xr-x  1 root  wheel
   ```
4. TUN mode should enable successfully
5. Subsequent TUN operations use the system copy

## Cleanup (if needed)

```bash
sudo rm -rf "/Library/Application Support/Flycast"
```
