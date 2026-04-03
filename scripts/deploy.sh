#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# deploy.sh — Deploy YouTube Shorts Agent ke Hetzner CX33 (Ubuntu 22.04)
# Usage: bash scripts/deploy.sh <server_ip> [ssh_user]
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

SERVER_IP="${1:?Masukkan IP server: bash deploy.sh <ip> [user]}"
SSH_USER="${2:-root}"
APP_DIR="/opt/youtube-agent"
SERVICE_NAME="youtube-agent"

echo "🚀 Deploy ke ${SSH_USER}@${SERVER_IP}:${APP_DIR}"

# ─── 1. Server setup ─────────────────────────────────────────────────────────

ssh "${SSH_USER}@${SERVER_IP}" bash << 'REMOTE'
set -euo pipefail
echo "=== Menginstall dependencies sistem ==="

apt-get update -qq
apt-get install -y --no-install-recommends \
  curl wget git ffmpeg python3 python3-pip python3-venv \
  build-essential libsqlite3-dev ca-certificates gnupg

# Node.js 20
if ! command -v node &>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

# yt-dlp
if ! command -v yt-dlp &>/dev/null; then
  wget -q https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -O /usr/local/bin/yt-dlp
  chmod +x /usr/local/bin/yt-dlp
fi

echo "Node: $(node -v), Python: $(python3 --version), FFmpeg: $(ffmpeg -version | head -1)"
REMOTE

# ─── 2. Upload code ───────────────────────────────────────────────────────────

echo "=== Mengupload kode ke server ==="
ssh "${SSH_USER}@${SERVER_IP}" "mkdir -p ${APP_DIR}"

# Sync files (exclude output, cache, logs, node_modules, .env)
rsync -avz --progress \
  --exclude='node_modules' \
  --exclude='.env' \
  --exclude='output/' \
  --exclude='cache/' \
  --exclude='logs/' \
  --exclude='*.db' \
  --exclude='token.json' \
  --exclude='credentials.json' \
  . "${SSH_USER}@${SERVER_IP}:${APP_DIR}/"

# ─── 3. Install dependencies ─────────────────────────────────────────────────

ssh "${SSH_USER}@${SERVER_IP}" bash << REMOTE
set -euo pipefail
cd ${APP_DIR}

echo "=== npm install ==="
npm install --omit=dev

echo "=== Python venv ==="
python3 -m venv venv
source venv/bin/activate
pip install --quiet --upgrade pip
pip install --quiet -r requirements.txt

echo "Dependencies selesai"
REMOTE

# ─── 4. Setup .env ────────────────────────────────────────────────────────────

if [ ! -f .env ]; then
  echo "⚠️  File .env tidak ditemukan. Salin .env.example ke .env dan isi nilainya:"
  echo "   cp .env.example .env && nano .env"
else
  echo "=== Mengupload .env ke server ==="
  scp .env "${SSH_USER}@${SERVER_IP}:${APP_DIR}/.env"
fi

# Upload token.json jika ada (Google Drive auth)
if [ -f token.json ]; then
  scp token.json "${SSH_USER}@${SERVER_IP}:${APP_DIR}/token.json"
  echo "token.json diupload"
fi

# ─── 5. Create systemd service ────────────────────────────────────────────────

ssh "${SSH_USER}@${SERVER_IP}" bash << REMOTE
set -euo pipefail

cat > /etc/systemd/system/${SERVICE_NAME}.service << 'SERVICE'
[Unit]
Description=YouTube Shorts AI Agent
After=network.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=${APP_DIR}
ExecStart=/usr/bin/node src/index.js
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${SERVICE_NAME}

# Environment
EnvironmentFile=${APP_DIR}/.env

# Graceful shutdown timeout
TimeoutStopSec=120

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
systemctl enable ${SERVICE_NAME}
systemctl restart ${SERVICE_NAME}

sleep 3
systemctl status ${SERVICE_NAME} --no-pager | head -20
REMOTE

echo ""
echo "✅ Deploy selesai!"
echo ""
echo "Perintah berguna di server:"
echo "  journalctl -u ${SERVICE_NAME} -f          # Live logs"
echo "  systemctl status ${SERVICE_NAME}           # Status"
echo "  systemctl restart ${SERVICE_NAME}          # Restart"
echo "  systemctl stop ${SERVICE_NAME}             # Stop"
