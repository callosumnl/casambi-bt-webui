#!/usr/bin/env bash
# Installs the application from a checked-out repository on a Raspberry Pi.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/casambi-bt-webui}"
SERVICE_USER="${SERVICE_USER:-casambi}"

if [[ ! -f "$APP_DIR/package.json" ]]; then
  echo "Expected the repository at $APP_DIR. Clone it there or set APP_DIR." >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1 || [[ "$(node -p 'process.versions.node.split(`.`)[0]')" -lt 22 ]]; then
  echo "Node.js 22 or newer is required." >&2
  exit 1
fi

sudo useradd --system --home /var/lib/casambi-bt-webui --shell /usr/sbin/nologin "$SERVICE_USER" 2>/dev/null || true
if getent group bluetooth >/dev/null; then
  sudo usermod -aG bluetooth "$SERVICE_USER"
fi
sudo install -d -o "$SERVICE_USER" -g "$SERVICE_USER" /var/lib/casambi-bt-webui
sudo install -d -m 0700 -o "$SERVICE_USER" -g "$SERVICE_USER" /var/lib/casambi-bt-webui/casambi-bt-store
python3 -m venv "$APP_DIR/.venv"
"$APP_DIR/.venv/bin/pip" install --upgrade pip
"$APP_DIR/.venv/bin/pip" install -r "$APP_DIR/requirements.txt"
corepack enable
cd "$APP_DIR"
pnpm install --frozen-lockfile
pnpm build
sudo install -m 0640 -o root -g "$SERVICE_USER" "$APP_DIR/.env" /etc/casambi-bt-webui.env
sudo install -m 0644 "$APP_DIR/deploy/casambi-bt-webui.service" /etc/systemd/system/casambi-bt-webui.service
sudo systemctl daemon-reload
sudo systemctl enable --now casambi-bt-webui.service
sudo systemctl status casambi-bt-webui.service --no-pager
