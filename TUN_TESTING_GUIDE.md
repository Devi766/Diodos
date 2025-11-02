# TUN Mode Testing Guide

## macOS Testing

### Method 1: Using osascript (No Service Mode)

1. Start the application
2. Navigate to TUN settings
3. Click "Grant Permissions" or enable TUN mode
4. You will be prompted for admin password
5. Password dialog will appear, enter your password
6. The kernel will be copied to `/Library/Application Support/Flycast/mihomo` and authorized
7. TUN mode should enable successfully
8. Check system DNS: `scutil --dns` - should show 223.6.6.6
9. Disable TUN mode - DNS should restore to original

### Method 2: Using Service Mode (Recommended)

1. First, install the service:
   - Use the service install option in settings
   - Enter admin password once
   - Service will install and start

2. Verify service is running:
   ```bash
   sudo launchctl list | grep flycast
   ls -la /tmp/flycast-service.sock
   ```

3. Enable TUN mode:
   - Should work WITHOUT password prompt
   - Kernel authorization happens via service
   - DNS changes happen via service

4. Disable TUN mode:
   - Should work WITHOUT password prompt

5. Try multiple enable/disable cycles:
   - All operations should be password-free

### Verification Commands (macOS)

Check kernel authorization:
```bash
ls -la "/Library/Application Support/Flycast/mihomo"
```
Should show: `-rwsr-xr-x  1 root  wheel`

Check TUN interface:
```bash
ifconfig -l | grep utun
```

Check DNS:
```bash
scutil --dns
```

Check service:
```bash
sudo launchctl list | grep com.flycast.service
```

View service logs:
```bash
tail -f /tmp/flycast-service.log
tail -f /tmp/flycast-service-error.log
```

## Linux Testing

### Method 1: Using pkexec (No Service Mode)

1. Start the application
2. Navigate to TUN settings
3. Click "Grant Permissions" or enable TUN mode
4. pkexec dialog will appear
5. Enter your password
6. Kernel will be authorized with capabilities or setuid
7. TUN mode should enable successfully

### Method 2: Using Service Mode (Recommended)

1. First, install the service:
   - Use the service install option in settings
   - pkexec dialog will appear, enter password once
   - Service will install via systemd

2. Verify service is running:
   ```bash
   systemctl status flycast-service
   ls -la /tmp/flycast-service.sock
   ```

3. Enable TUN mode:
   - Should work WITHOUT password prompt
   - Kernel authorization happens via service

4. Disable TUN mode:
   - Should work WITHOUT password prompt

### Verification Commands (Linux)

Check kernel capabilities:
```bash
getcap /path/to/mihomo
```
Should show: `cap_net_admin,cap_net_bind_service=eip`

Check TUN interface:
```bash
ip link show | grep mihomo
# or
ip link show | grep tun
```

Check service:
```bash
systemctl status flycast-service
```

View service logs:
```bash
journalctl -u flycast-service -f
tail -f /tmp/flycast-service.log
```

## Common Issues

### macOS: "Operation not permitted"

This was the original bug - now fixed by copying to system directory.

If you still see this:
1. Uninstall any previous authorization attempts
2. Remove `/Library/Application Support/Flycast/mihomo` if exists
3. Try again - it should copy and authorize in system directory

### Service Not Starting

macOS:
```bash
sudo launchctl unload /Library/LaunchDaemons/com.flycast.service.plist
sudo launchctl load /Library/LaunchDaemons/com.flycast.service.plist
```

Linux:
```bash
sudo systemctl restart flycast-service
sudo systemctl status flycast-service
```

### DNS Not Changing

Check if service has permission to modify DNS:
```bash
# macOS
networksetup -getdnsservers "Wi-Fi"

# Should show 223.6.6.6 when TUN is enabled
```

### TUN Interface Not Appearing

Check mihomo logs in the application to see any error messages.

Verify kernel has proper permissions (see verification commands above).

## Cleanup (If needed)

### Uninstall Service (macOS)
```bash
sudo launchctl unload /Library/LaunchDaemons/com.flycast.service.plist
sudo rm /Library/LaunchDaemons/com.flycast.service.plist
sudo rm -rf "/Library/Application Support/Flycast"
rm -f /tmp/flycast-service.sock
```

### Uninstall Service (Linux)
```bash
sudo systemctl stop flycast-service
sudo systemctl disable flycast-service
sudo rm /etc/systemd/system/flycast-service.service
sudo systemctl daemon-reload
sudo rm -rf /opt/flycast
rm -f /tmp/flycast-service.sock
```

### Remove Kernel Authorization (macOS)
```bash
sudo rm -rf "/Library/Application Support/Flycast"
```

### Remove Kernel Authorization (Linux)
```bash
sudo setcap -r /path/to/mihomo
```
