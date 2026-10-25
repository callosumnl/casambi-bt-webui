#!/usr/bin/env bash
# Installs the application from a checked-out repository on a Raspberry Pi.
# Run it as the account that owns the checkout (not with sudo); it uses sudo itself where root is needed.
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

# The Python environment, node_modules, and build output belong to the checkout's owner, even if this
# script is started with sudo. Root-owned copies make later updates fail, e.g. `pnpm build` with
# "EACCES: permission denied ... node_modules/.vite-temp".
BUILD_USER="$(stat -c %U "$APP_DIR")"
BUILD_GROUP="$(id -gn "$BUILD_USER")"
as_build_user() {
  if [[ "$(id -un)" == "$BUILD_USER" ]]; then "$@"; else sudo -u "$BUILD_USER" -H env "PATH=$PATH" "$@"; fi
}
if [[ "$BUILD_USER" == "root" ]]; then
  echo "Warning: $APP_DIR is owned by root, so it will be built as root. Give it to your own account first: sudo chown -R \"\$USER\":\"\$USER\" $APP_DIR" >&2
fi
# Repair files that an earlier run as root left behind.
sudo chown -R "$BUILD_USER:$BUILD_GROUP" "$APP_DIR"

sudo useradd --system --home /var/lib/casambi-bt-webui --shell /usr/sbin/nologin "$SERVICE_USER" 2>/dev/null || true
if getent group bluetooth >/dev/null; then
  sudo usermod -aG bluetooth "$SERVICE_USER"
fi
sudo install -d -o "$SERVICE_USER" -g "$SERVICE_USER" /var/lib/casambi-bt-webui
sudo install -d -m 0700 -o "$SERVICE_USER" -g "$SERVICE_USER" /var/lib/casambi-bt-webui/casambi-bt-store
as_build_user python3 -m venv "$APP_DIR/.venv"
as_build_user "$APP_DIR/.venv/bin/pip" install --upgrade pip
as_build_user "$APP_DIR/.venv/bin/pip" install -r "$APP_DIR/requirements.txt"
# corepack writes its pnpm shim next to node, which may need root for a system-wide Node.js.
corepack enable 2>/dev/null || sudo env "PATH=$PATH" corepack enable
cd "$APP_DIR"
as_build_user pnpm install --frozen-lockfile
as_build_user pnpm build
sudo install -m 0640 -o root -g "$SERVICE_USER" "$APP_DIR/.env" /etc/casambi-bt-webui.env
sudo install -m 0644 "$APP_DIR/deploy/casambi-bt-webui.service" /etc/systemd/system/casambi-bt-webui.service
sudo systemctl daemon-reload
sudo systemctl enable --now casambi-bt-webui.service
sudo systemctl status casambi-bt-webui.service --no-pager
