#!/bin/bash

SERVICE_FILE="/etc/systemd/system/flycast-service.service"
SERVICE_DIR="/opt/flycast"
SERVICE_PATH="$SERVICE_DIR/service-helper"
NODE_PATH="/usr/bin/node"

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

pkexec bash -c "
  mkdir -p '$SERVICE_DIR' &&
  cp '$SOURCE_SCRIPT' '$SERVICE_PATH' &&
  chmod +x '$SERVICE_PATH' &&
  cat > '$SERVICE_FILE' <<EOF
[Unit]
Description=Flycast Service Helper
After=network.target

[Service]
Type=simple
ExecStart=$NODE_PATH $SERVICE_PATH
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload &&
  systemctl enable flycast-service &&
  systemctl start flycast-service
"

if [ $? -eq 0 ]; then
  sleep 1
  if systemctl is-active --quiet flycast-service; then
    echo "Service installed successfully"
    exit 0
  else
    echo "Service installation failed"
    exit 1
  fi
else
  echo "Installation failed"
  exit 1
fi
