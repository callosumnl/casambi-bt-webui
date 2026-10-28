#!/usr/bin/env bash
# Applies the server settings an admin changed in the web app: the port and whether to trust a reverse
# proxy. systemd starts it as root (casambi-bt-webui-settings.service) when the app drops a request.
#
# The request is the only input from the unprivileged service, so it is read with care: no symlinks, at
# most 4 KB, exactly two known fields with strict types. The change is checked by restarting the service
# and waiting for it to answer on the new port; if it does not, the previous settings are restored.
set -euo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
REQUEST="${REQUEST:-/var/lib/casambi-bt-webui/settings/request.json}"
STATE_DIR="${STATE_DIR:-/var/lib/casambi-bt-webui-updater}"
ENV_FILE="${ENV_FILE:-/etc/casambi-bt-webui.env}"
AVAHI_FILE="${AVAHI_FILE:-/etc/avahi/services/casambi-bt-webui.service}"
SERVICE="${SERVICE:-casambi-bt-webui.service}"
RESTART="${RESTART:-systemctl restart $SERVICE}"
HEALTH_SECONDS="${HEALTH_SECONDS:-60}"

mkdir -p "$STATE_DIR"
status() { STATE="$1" MESSAGE="$2" python3 -c 'import json, os, datetime; path = os.path.join(os.environ["STATE_DIR"], "settings-status.json"); tmp = path + ".tmp"; json.dump({"state": os.environ["STATE"], "message": os.environ["MESSAGE"], "at": datetime.datetime.now(datetime.timezone.utc).isoformat()}, open(tmp, "w")); os.chmod(tmp, 0o644); os.replace(tmp, path)'; }
export STATE_DIR

# Read and validate the request, then delete it (the path unit would start this script again otherwise).
if ! values="$(REQUEST="$REQUEST" python3 - <<'PY'
import json, os, sys
path = os.environ["REQUEST"]
try:
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor) as handle:
        text = handle.read(4097)
except OSError:
    sys.exit("The settings request could not be read.")
try:
    request = json.loads(text) if len(text) <= 4096 else None
except ValueError:
    request = None
if not isinstance(request, dict) or set(request) != {"port", "trustProxy"}:
    sys.exit("The settings request is invalid.")
port, trust = request["port"], request["trustProxy"]
if type(port) is not int or not 1024 <= port <= 65535 or type(trust) is not bool:
    sys.exit("The settings request is invalid.")
print(port, "true" if trust else "false")
PY
)"; then
  rm -f "$REQUEST"
  status failed "The settings request was rejected as invalid."
  exit 1
fi
read -r new_port new_trust <<<"$values"
# Report "applying" before the request disappears, so the app never sees neither (and an old result instead).
status applying "Restarting on port $new_port…"
rm -f "$REQUEST"

current_port="$(grep -E '^PORT=' "$ENV_FILE" | tail -n 1 | cut -d= -f2)"; current_port="${current_port:-3000}"
if [[ "$new_port" != "$current_port" ]] && ss -ltnH "sport = :$new_port" 2>/dev/null | grep -q .; then
  status failed "Port $new_port is already in use by another program; the settings were not changed."
  exit 1
fi

backup="$(mktemp)"
cp -p "$ENV_FILE" "$backup"
avahi_backup=""
if [[ -f "$AVAHI_FILE" ]]; then avahi_backup="$(mktemp)"; cp -p "$AVAHI_FILE" "$avahi_backup"; fi
restore() {
  cp -p "$backup" "$ENV_FILE"
  if [[ -n "$avahi_backup" ]]; then cp -p "$avahi_backup" "$AVAHI_FILE"; fi
}
trap 'rm -f "$backup" "${avahi_backup:-}"' EXIT

# Set PORT and CASAMBI_TRUST_PROXY in place (a commented-out "# KEY=" line is replaced too, a missing one
# appended), keeping the file's other lines, owner, and mode; then the port in the avahi announcement.
ENV_FILE="$ENV_FILE" AVAHI_FILE="$AVAHI_FILE" NEW_PORT="$new_port" NEW_TRUST="$new_trust" python3 - <<'PY'
import os, re
values = {"PORT": os.environ["NEW_PORT"], "CASAMBI_TRUST_PROXY": os.environ["NEW_TRUST"]}
path = os.environ["ENV_FILE"]
lines = open(path).read().splitlines()
for key, value in values.items():
    pattern = re.compile(rf"^#? ?{key}=")
    matches = [index for index, line in enumerate(lines) if pattern.match(line)]
    if matches:
        for index in matches:
            lines[index] = f"{key}={value}"
    else:
        lines.append(f"{key}={value}")
with open(path, "w") as handle:  # Writing in place keeps the file's owner and mode.
    handle.write("\n".join(lines) + "\n")
avahi = os.environ["AVAHI_FILE"]
if os.path.isfile(avahi):
    text = open(avahi).read()
    with open(avahi, "w") as handle:
        handle.write(re.sub(r"<port>\d+</port>", f"<port>{values['PORT']}</port>", text))
PY

answers() {
  for _ in $(seq 1 "$HEALTH_SECONDS"); do
    if curl -fsS "http://127.0.0.1:$1/api/v1/health" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

$RESTART
if answers "$new_port"; then
  proxy_note=""
  if [[ "$new_trust" == true ]]; then proxy_note=", trusting the reverse proxy's client addresses"; fi
  status applied "Saved. The app now runs on port $new_port$proxy_note."
  exit 0
fi

restore
$RESTART
if answers "$current_port"; then
  status rolled_back "The app did not start on port $new_port, so the previous settings (port $current_port) were restored."
else
  status failed "The app did not start with the new settings, and not with the restored ones either. Check: journalctl -u $SERVICE"
fi
exit 1
