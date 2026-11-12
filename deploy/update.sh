#!/usr/bin/env bash
# Pull the latest version and restart:  sudo bash /opt/beti-bachao/deploy/update.sh
set -euo pipefail
git -C /opt/beti-bachao pull --ff-only
systemctl restart beti-bachao
sleep 2; curl -s http://127.0.0.1:8080/api/v1/health; echo
