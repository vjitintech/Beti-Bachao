#!/usr/bin/env bash
# Starts Beti Bachao inside a GitHub Codespace and makes port 8080 public so
# phones can open it. Data is kept in the Codespace (outside the git repo).
set -u
cd "$(dirname "$0")/.."
DATA_DIR=/workspaces/.beti-bachao-data
mkdir -p "$DATA_DIR"
pkill -f "node server/server.js" 2>/dev/null || true
DATA_FILE="$DATA_DIR/db.json" COOKIE_SECURE=true TRUST_PROXY=true PORT=8080 \
  nohup node server/server.js > /tmp/beti-bachao.log 2>&1 &
sleep 3
gh codespace ports visibility 8080:public -c "$CODESPACE_NAME" >/dev/null 2>&1 || true
LINK="https://${CODESPACE_NAME}-8080.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}"
{
  echo "=================================================================="
  echo " Beti Bachao is running."
  echo " Open on any phone:  $LINK"
  grep -h "\[setup\]" /tmp/beti-bachao.log | sed 's/^/ /'
  echo " (If the phone says 'not found', open the PORTS tab, right-click"
  echo "  port 8080 → Port Visibility → Public.)"
  echo "=================================================================="
} | tee "$DATA_DIR/START_HERE.txt"
