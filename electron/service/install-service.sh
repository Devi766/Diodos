#!/bin/bash

PLIST_PATH="/Library/LaunchDaemons/com.flycast.service.plist"
SERVICE_DIR="/Library/Application Support/Flycast"
SERVICE_PATH="$SERVICE_DIR/service-helper"
NODE_PATH="/usr/local/bin/node"

if [ ! -f "$NODE_PATH" ]; then
  NODE_PATH="$(which node)"
fi

if [ -z "$NODE_PATH" ]; then
  echo "Error: Node.js not found"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOURCE_SCRIPT="$SCRIPT_DIR/service-helper.js"

if [ ! -f "$SOURCE_SCRIPT" ]; then
  echo "Error: service-helper.js not found at $SOURCE_SCRIPT"
  exit 1
fi

sudo mkdir -p "$SERVICE_DIR"
sudo cp "$SOURCE_SCRIPT" "$SERVICE_PATH"
sudo chmod +x "$SERVICE_PATH"

sudo tee "$PLIST_PATH" > /dev/null <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.flycast.service</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NODE_PATH</string>
        <string>$SERVICE_PATH</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardErrorPath</key>
    <string>/tmp/flycast-service-error.log</string>
    <key>StandardOutPath</key>
    <string>/tmp/flycast-service.log</string>
</dict>
</plist>
EOF

sudo launchctl unload "$PLIST_PATH" 2>/dev/null || true
sudo launchctl load "$PLIST_PATH"

sleep 1

if sudo launchctl list | grep -q "com.flycast.service"; then
  echo "Service installed successfully"
  exit 0
else
  echo "Service installation failed"
  exit 1
fi
