#!/usr/bin/env bash
# Beti Bachao — one-time server setup on AWS Lightsail (Ubuntu 24.04).
# Usage (in the Lightsail browser terminal):
#   curl -fsSL https://raw.githubusercontent.com/vjitintech/Beti-Bachao/main/deploy/lightsail-setup.sh | sudo DOMAIN=betibachao24x7.com bash
set -euo pipefail
DOMAIN="${DOMAIN:-betibachao24x7.com}"
APP=/opt/beti-bachao; DATA=/var/lib/beti-bachao; ENVF=/etc/beti-bachao.env
echo "== 1/6 System packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y && apt-get upgrade -y
apt-get install -y curl git ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https postgresql ufw unattended-upgrades
echo "== 2/6 Node.js 22"
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs
echo "== 3/6 Caddy (automatic HTTPS)"
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg --yes
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
apt-get update -y && apt-get install -y caddy
echo "== 4/6 App + data folders"
id betibachao >/dev/null 2>&1 || useradd --system --home "$DATA" --shell /usr/sbin/nologin betibachao
mkdir -p "$DATA" && chown betibachao:betibachao "$DATA" && chmod 700 "$DATA"
if [ -d "$APP/.git" ]; then git -C "$APP" pull --ff-only; else git clone --depth 1 https://github.com/vjitintech/Beti-Bachao.git "$APP"; fi
echo "== 5/6 PostgreSQL database"
if [ ! -f "$ENVF" ]; then
  PW=$(openssl rand -hex 24)
  sudo -u postgres psql -v ON_ERROR_STOP=1 -c "CREATE USER betibachao WITH PASSWORD '$PW';" -c "CREATE DATABASE betibachao OWNER betibachao;"
  cat > "$ENVF" <<ENV
NODE_ENV=production
PORT=8080
TRUST_PROXY=true
COOKIE_SECURE=true
PUBLIC_URL=https://$DOMAIN
DATA_FILE=$DATA/db.json
DATABASE_URL=postgresql://betibachao:$PW@localhost:5432/betibachao
# Copy these from Render > beti-bachao > Environment (same values!):
MEDIA_KEY=
BACKUP_KEY=
# ...and any others you set there (MFA_REQUIRED, SMS_PROVIDER, MSG91_*, FCM_*, APNS_*, VOICE_*, AI_BASE_URL)
ENV
  chmod 600 "$ENVF"
fi
echo "== 6/6 Services"
cat > /etc/systemd/system/beti-bachao.service <<UNIT
[Unit]
Description=Beti Bachao server
After=network-online.target postgresql.service
Wants=network-online.target
[Service]
User=betibachao
WorkingDirectory=$APP
EnvironmentFile=$ENVF
ExecStart=/usr/bin/node server/server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=full
ReadWritePaths=$DATA
[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/caddy/Caddyfile <<CADDY
$DOMAIN {
  encode gzip
  reverse_proxy 127.0.0.1:8080
}
www.$DOMAIN {
  redir https://$DOMAIN{uri} permanent
}
CADDY
# Daily database backup at 02:30 IST (21:00 UTC), keep 14 days
cat > /etc/cron.d/beti-bachao-backup <<CRON
0 21 * * * postgres pg_dump -Fc betibachao > /var/backups/betibachao-\$(date +\%F).dump && find /var/backups -name 'betibachao-*.dump' -mtime +14 -delete
CRON
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable
systemctl daemon-reload && systemctl enable --now beti-bachao && systemctl restart caddy
echo
echo "Done. Next: sudo nano $ENVF  (paste MEDIA_KEY, BACKUP_KEY and your other Render values), then: sudo systemctl restart beti-bachao"
echo "Check: curl -s http://127.0.0.1:8080/api/v1/health"
