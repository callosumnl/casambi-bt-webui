#!/usr/bin/env bash
# Installs or updates Casambi BT WebGUI on Raspberry Pi OS (64-bit, Bookworm or newer).
#
#   Fresh Pi:  sudo git clone https://github.com/callosumnl/casambi-bt-webui.git /opt/casambi-bt-webui
#              /opt/casambi-bt-webui/deploy/install.sh
#   Update:    cd /opt/casambi-bt-webui && git pull && ./deploy/install.sh
#
# Run it as your normal account; it uses sudo where root is needed. It is safe to run again at any time:
# existing settings and secrets are kept, and the service is restarted on the new build.
set -euo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
SERVICE_USER="${SERVICE_USER:-casambi}"
DATA_DIR=/var/lib/casambi-bt-webui
ENV_FILE=/etc/casambi-bt-webui.env
UNIT_FILE=/etc/systemd/system/casambi-bt-webui.service
NODE_MAJOR=22
# Never stop for a question: corepack would ask before downloading pnpm, apt before changing config.
export DEBIAN_FRONTEND=noninteractive COREPACK_ENABLE_DOWNLOAD_PROMPT=0

step() { printf '\n==> %s\n' "$*"; }
die() { printf '\nError: %s\n' "$*" >&2; exit 1; }

[[ -f "$APP_DIR/package.json" ]] || die "No checkout found at $APP_DIR. Clone the repository there or set APP_DIR."
[[ "$(uname -m)" == "aarch64" ]] || echo "Warning: this installer targets 64-bit Raspberry Pi OS (aarch64); found $(uname -m)." >&2

step "Installing system packages"
sudo apt-get update -qq
sudo apt-get install -y -qq git curl ca-certificates python3 python3-venv python3-dev build-essential bluez rfkill >/dev/null
python3 -c 'import sys; sys.exit(sys.version_info < (3, 11))' || die "Python 3.11 or newer is required; found $(python3 --version)."

node_major() { command -v node >/dev/null 2>&1 && node -p 'process.versions.node.split(".")[0]' || echo 0; }
if [[ "$(node_major)" -lt "$NODE_MAJOR" ]]; then
  # Raspberry Pi OS ships an older Node.js; NodeSource provides current arm64 builds.
  step "Installing Node.js $NODE_MAJOR"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash - >/dev/null
  sudo apt-get install -y -qq nodejs >/dev/null
fi
[[ "$(node_major)" -ge "$NODE_MAJOR" ]] || die "Node.js $NODE_MAJOR or newer is required; found $(node --version 2>/dev/null || echo none)."
NODE_BIN="$(command -v node)"
# Node.js 25+ no longer bundles corepack (which provides the pinned pnpm); install it when missing.
command -v corepack >/dev/null 2>&1 || sudo env "PATH=$PATH" npm install --global --silent corepack
# corepack writes its pnpm shim next to node, which needs root for a system-wide Node.js.
corepack enable 2>/dev/null || sudo env "PATH=$PATH" corepack enable

step "Preparing the checkout"
# The Python environment, node_modules, and dist/ belong to the checkout's owner, even when this script is
# started with sudo: root-owned build files make every later update fail with EACCES. A checkout made with
# `sudo git clone` is handed to the account running this installer.
BUILD_USER="$(stat -c %U "$APP_DIR")"
INVOKER="${SUDO_USER:-$(id -un)}"
if [[ "$BUILD_USER" == "root" && "$INVOKER" != "root" ]]; then BUILD_USER="$INVOKER"; fi
[[ "$BUILD_USER" != "root" ]] || echo "Warning: building as root. Run this installer from your normal account instead." >&2
BUILD_GROUP="$(id -gn "$BUILD_USER")"
sudo chown -R "$BUILD_USER:$BUILD_GROUP" "$APP_DIR"
as_build_user() {
  if [[ "$(id -un)" == "$BUILD_USER" ]]; then "$@"
  else sudo -u "$BUILD_USER" -H env "PATH=$PATH" COREPACK_ENABLE_DOWNLOAD_PROMPT=0 "$@"; fi
}

step "Creating the service account and data directory"
id -u "$SERVICE_USER" >/dev/null 2>&1 || sudo useradd --system --home-dir "$DATA_DIR" --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
sudo usermod -aG bluetooth "$SERVICE_USER"
sudo install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_USER" "$DATA_DIR"
sudo install -d -m 0700 -o "$SERVICE_USER" -g "$SERVICE_USER" "$DATA_DIR/casambi-bt-store"
# Repair files that an earlier manual run as root may have left in the data directory.
sudo chown -R "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR"
sudo -u "$SERVICE_USER" test -r "$APP_DIR/package.json" \
  || die "The $SERVICE_USER account cannot read $APP_DIR. Home directories are private on Raspberry Pi OS; clone into /opt/casambi-bt-webui instead."

step "Enabling Bluetooth"
sudo rfkill unblock bluetooth 2>/dev/null || true
sudo systemctl enable --now bluetooth.service >/dev/null 2>&1 || echo "Warning: could not start the bluetooth service." >&2

step "Installing the Python Bluetooth bridge"
as_build_user python3 -m venv "$APP_DIR/.venv"
as_build_user "$APP_DIR/.venv/bin/pip" install --quiet --upgrade pip
as_build_user "$APP_DIR/.venv/bin/pip" install --quiet -r "$APP_DIR/requirements.txt"

step "Building the web application"
cd "$APP_DIR"
# confirmModulesPurge=false: pnpm otherwise asks before rebuilding node_modules made by another pnpm setup.
as_build_user pnpm install --frozen-lockfile --config.confirm-modules-purge=false
as_build_user pnpm build
sudo -u "$SERVICE_USER" test -r "$APP_DIR/dist/index.js" || die "The $SERVICE_USER account cannot read the build output in $APP_DIR/dist."

step "Writing $ENV_FILE"
secret() { python3 -c 'import secrets; print(secrets.token_urlsafe(48))'; }
if ! sudo test -f "$ENV_FILE"; then
  # A first install gets fresh, unique secrets. An older checkout-local .env is migrated instead, because
  # replacing CASAMBI_ENCRYPTION_KEY would make previously stored Casambi credentials unreadable.
  source_env="$(mktemp)"
  if [[ -f "$APP_DIR/.env" ]]; then cp "$APP_DIR/.env" "$source_env"; echo "Migrating settings from $APP_DIR/.env."
  else
    sed -e "s|^CASAMBI_ENCRYPTION_KEY=.*|CASAMBI_ENCRYPTION_KEY=$(secret)|" \
        -e "s|^CASAMBI_JWT_SECRET=.*|CASAMBI_JWT_SECRET=$(secret)|" \
        "$APP_DIR/deploy/environment.template" > "$source_env"
  fi
  sed -i -e "s|^CASAMBI_PYTHON_COMMAND=.*|CASAMBI_PYTHON_COMMAND=$APP_DIR/.venv/bin/python|" "$source_env"
  sudo install -m 0640 -o root -g "$SERVICE_USER" "$source_env" "$ENV_FILE"
  rm -f "$source_env"
fi
# Keep existing settings and secrets; only add settings that newer versions introduced (also after a migration).
while IFS= read -r line; do
  [[ "$line" =~ ^[A-Z_]+= ]] || continue
  key="${line%%=*}"
  line="${line//\/opt\/casambi-bt-webui/$APP_DIR}"
  sudo grep -q "^$key=" "$ENV_FILE" || { echo "$line" | sudo tee -a "$ENV_FILE" >/dev/null; echo "Added $key."; }
done < "$APP_DIR/deploy/environment.template"
sudo chown root:"$SERVICE_USER" "$ENV_FILE"
sudo chmod 0640 "$ENV_FILE"
if sudo grep -q "^CASAMBI_MOCK_MODE=true" "$ENV_FILE" || ! sudo grep -q "^NODE_ENV=production" "$ENV_FILE"; then
  echo "Warning: $ENV_FILE enables development settings (CASAMBI_MOCK_MODE=true or NODE_ENV other than production). A Pi needs CASAMBI_MOCK_MODE=false and NODE_ENV=production." >&2
fi
if sudo grep -q "^CASAMBI_[A-Z_]*=replace-with" "$ENV_FILE"; then
  echo "Warning: $ENV_FILE still contains a placeholder secret. Replace it with: sudoedit $ENV_FILE" >&2
fi

step "Installing and restarting the service"
# The unit template assumes /opt/casambi-bt-webui, /usr/bin/node, and the casambi account; adapt it to this machine.
unit="$(mktemp)"
sed -e "s|/opt/casambi-bt-webui|$APP_DIR|g" -e "s|/usr/bin/node|$NODE_BIN|" \
    -e "s|^User=.*|User=$SERVICE_USER|" -e "s|^Group=.*|Group=$SERVICE_USER|" \
    "$APP_DIR/deploy/casambi-bt-webui.service" > "$unit"
sudo install -m 0644 "$unit" "$UNIT_FILE"
rm -f "$unit"
sudo systemctl daemon-reload
sudo systemctl enable casambi-bt-webui.service >/dev/null 2>&1
# restart, not `enable --now`: a running service must pick up the new build.
sudo systemctl restart casambi-bt-webui.service

step "Checking that the web interface answers"
port="$(sudo sed -n 's/^PORT=//p' "$ENV_FILE" | tail -n 1)"; port="${port:-3000}"
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$port/api/v1/health" >/dev/null 2>&1; then
    printf '\nCasambi BT WebGUI is running. Open it in a browser on your network:\n'
    for address in $(hostname -I 2>/dev/null); do [[ "$address" == *:* ]] || printf '  http://%s:%s\n' "$address" "$port"; done
    printf '  http://%s.local:%s\n\nThe first visitor creates the admin account.\n' "$(hostname)" "$port"
    exit 0
  fi
  sleep 1
done
sudo journalctl -u casambi-bt-webui.service -n 40 --no-pager >&2 || true
die "The service did not answer on port $port within 60 seconds. See the log above."
