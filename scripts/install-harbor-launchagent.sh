#!/bin/zsh
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="$(command -v node)"
AGENT_DIR="$HOME/Library/LaunchAgents"
AGENT_PATH="$AGENT_DIR/com.harbor.local-bridge.plist"
LOG_DIR="$PROJECT_DIR/.harbor/logs"

mkdir -p "$AGENT_DIR" "$LOG_DIR"
npm --prefix "$PROJECT_DIR" run messages:build >/dev/null

cat > "$AGENT_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.harbor.local-bridge</string>
  <key>ProgramArguments</key>
  <array><string>$NODE_BIN</string><string>$PROJECT_DIR/harbor-local-bridge.mjs</string></array>
  <key>WorkingDirectory</key><string>$PROJECT_DIR</string>
  <key>EnvironmentVariables</key><dict><key>HARBOR_AUTO_INGEST_ENABLED</key><string>1</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG_DIR/bridge.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/bridge.error.log</string>
</dict>
</plist>
PLIST

launchctl bootout "gui/$(id -u)/com.harbor.local-bridge" 2>/dev/null || true
for _ in {1..20}; do
  if ! /usr/sbin/lsof -nP -iTCP:4317 -sTCP:LISTEN >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done
if /usr/sbin/lsof -nP -iTCP:4317 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port 4317 is already used by another local process. Stop the manually started bridge, then retry." >&2
  exit 1
fi
launchctl bootstrap "gui/$(id -u)" "$AGENT_PATH"
for _ in {1..40}; do
  HEALTH_STATUS="$(/usr/bin/curl --silent --max-time 1 --output /dev/null --write-out '%{http_code}' http://127.0.0.1:4317/health || true)"
  if [[ "$HEALTH_STATUS" == "200" || "$HEALTH_STATUS" == "503" ]]; then
    echo "Zoid Bank bridge installed and kept alive at http://127.0.0.1:4317"
    exit 0
  fi
  sleep 0.25
done

echo "The Zoid Bank bridge was loaded but did not become ready. Check $LOG_DIR/bridge.error.log." >&2
exit 1
