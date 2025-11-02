#!/bin/bash

PLIST_PATH="/Library/LaunchDaemons/com.flycast.service.plist"
SERVICE_DIR="/Library/Application Support/Flycast"
SOCKET_PATH="/tmp/flycast-service.sock"

if [ -f "$PLIST_PATH" ]; then
  sudo launchctl unload "$PLIST_PATH" 2>/dev/null || true
  sudo rm -f "$PLIST_PATH"
fi

if [ -d "$SERVICE_DIR" ]; then
  sudo rm -rf "$SERVICE_DIR"
fi

if [ -e "$SOCKET_PATH" ]; then
  sudo rm -f "$SOCKET_PATH"
fi

echo "Service uninstalled successfully"
exit 0
