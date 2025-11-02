#!/bin/bash

SERVICE_FILE="/etc/systemd/system/flycast-service.service"
SERVICE_DIR="/opt/flycast"
SOCKET_PATH="/tmp/flycast-service.sock"

pkexec bash -c "
  systemctl stop flycast-service 2>/dev/null || true &&
  systemctl disable flycast-service 2>/dev/null || true &&
  rm -f '$SERVICE_FILE' &&
  systemctl daemon-reload &&
  rm -rf '$SERVICE_DIR' &&
  rm -f '$SOCKET_PATH'
"

echo "Service uninstalled successfully"
exit 0
