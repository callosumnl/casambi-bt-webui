#!/usr/bin/env bash
# Checks for or applies an update of Casambi BT WebGUI. systemd starts it as root
# (casambi-bt-webui-update@check|apply.service) when the web app asks or once a day.
#
#   update.sh check   fetch, then report how far the checkout is behind its upstream branch
#   update.sh apply   the same, then fast-forward and run deploy/install.sh; on failure, go
#                     back to the previous commit and install that again
#
# The web app only creates a request file; nothing it writes is read or executed here. Status
# goes to a root-owned directory the service can read but not write, so the service cannot point
# this script at another file.
set -euo pipefail

MODE="${1:-}"
[[ "$MODE" == check || "$MODE" == apply ]] || { echo "usage: $0 check|apply" >&2; exit 2; }
APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

# A merge rewrites this file while bash is still reading it; run from a copy instead.
if [[ -z "${UPDATE_FROM_COPY:-}" ]]; then
  copy="$(mktemp)"
  cp "${BASH_SOURCE[0]}" "$copy"
  APP_DIR="$APP_DIR" UPDATE_FROM_COPY="$copy" exec bash "$copy" "$@"
fi
trap 'rm -f "$UPDATE_FROM_COPY"' EXIT

REQUEST_DIR="${REQUEST_DIR:-/var/lib/casambi-bt-webui/update}"
STATE_DIR="${STATE_DIR:-/var/lib/casambi-bt-webui-updater}"
INSTALL="${INSTALL:-$APP_DIR/deploy/install.sh}"
LOG="$STATE_DIR/update.log"

rm -f "$REQUEST_DIR/$MODE-request"
mkdir -p "$STATE_DIR"
chmod 0755 "$STATE_DIR"
# One check or update at a time (flock is Linux-only; development machines run without it).
if command -v flock >/dev/null 2>&1; then exec 9>"$STATE_DIR/lock"; flock 9; fi

OWNER="$(stat -c %U "$APP_DIR" 2>/dev/null || stat -f %Su "$APP_DIR")"
as_owner() { if [[ "$(id -un)" == "$OWNER" ]]; then "$@"; else runuser -u "$OWNER" -- "$@"; fi; }
repo() { as_owner git -C "$APP_DIR" "$@"; }
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# Merges the given fields into status.json (written atomically, mode 0644). Values come in as
# environment variables, so no text from git or the log is ever interpreted by the shell.
write_status() {
  STATUS_FILE="$STATE_DIR/status.json" LOG_FILE="$LOG" STATUS_FIELDS="$*" python3 - <<'PY'
import json, os, tempfile
path = os.environ["STATUS_FILE"]
try:
    with open(path) as handle:
        data = json.load(handle)
except Exception:
    data = {}
for field in os.environ["STATUS_FIELDS"].split():
    value = os.environ.get(f"S_{field}")
    if field in ("behind",):
        data[field] = int(value) if value else None
    elif field == "changes":
        data[field] = [line for line in (value or "").split("\n") if line][:20]
    elif field == "logTail":
        try:
            with open(os.environ["LOG_FILE"], errors="replace") as handle:
                data[field] = "".join(handle.readlines()[-40:])
        except OSError:
            data[field] = None
    else:
        data[field] = value if value else None
handle, temporary = tempfile.mkstemp(dir=os.path.dirname(path))
with os.fdopen(handle, "w") as out:
    json.dump(data, out, indent=2)
os.chmod(temporary, 0o644)
os.replace(temporary, path)
PY
}

fail() { S_state=failed S_message="$1" S_finishedAt="$(now)" write_status state message finishedAt; exit 1; }

S_state=checking S_message="" S_startedAt="$(now)" write_status state message startedAt
branch="$(repo rev-parse --abbrev-ref HEAD)"
[[ "$branch" != HEAD ]] || fail "The checkout is not on a branch, so there is nothing to update to. Check out a branch (for example main) to enable updates."
if ! repo diff --quiet HEAD; then fail "The checkout has local changes; updating could lose them. Commit or undo them first (git -C $APP_DIR status)."; fi
upstream="$(repo rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || echo "origin/$branch")"
if ! fetch_error="$(repo fetch --quiet "${upstream%%/*}" 2>&1)"; then fail "Could not reach the update source: ${fetch_error:-git fetch failed}"; fi

current="$(repo rev-parse HEAD)"
latest="$(repo rev-parse "$upstream")"
behind="$(repo rev-list --count "HEAD..$upstream")"
changes="$(repo log --format=%s -n 20 "HEAD..$upstream")"
S_current="$current" S_currentSubject="$(repo log -1 --format=%s HEAD)" S_latest="$latest" S_latestSubject="$(repo log -1 --format=%s "$upstream")" \
  S_behind="$behind" S_changes="$changes" S_checkedAt="$(now)" write_status current currentSubject latest latestSubject behind changes checkedAt

if [[ "$behind" == 0 ]]; then
  S_state=up_to_date S_message="This is the latest version." S_finishedAt="$(now)" write_status state message finishedAt
  exit 0
fi
if [[ "$MODE" == check ]]; then
  S_state=available S_message="$behind new change(s) available." S_finishedAt="$(now)" write_status state message finishedAt
  exit 0
fi

: >"$LOG"
S_state=updating S_message="Updating from ${current:0:7} to ${latest:0:7}…" write_status state message
if repo merge --ff-only "$upstream" >>"$LOG" 2>&1 && "$INSTALL" >>"$LOG" 2>&1; then
  S_state=updated S_message="Updated to ${latest:0:7}." S_current="$latest" S_currentSubject="$(repo log -1 --format=%s HEAD)" S_behind=0 S_changes="" S_finishedAt="$(now)" \
    write_status state message current currentSubject behind changes finishedAt logTail
  exit 0
fi

echo "== Update failed; restoring ${current:0:7} ==" >>"$LOG"
S_state=rolling_back S_message="The update failed; restoring ${current:0:7}…" write_status state message logTail
if repo reset --hard "$current" >>"$LOG" 2>&1 && "$INSTALL" >>"$LOG" 2>&1; then
  S_state=rolled_back S_message="The update failed, so ${current:0:7} was restored and is running again. The log below shows why." S_finishedAt="$(now)" write_status state message finishedAt logTail
else
  S_state=failed S_message="The update failed and restoring ${current:0:7} failed too. Run $APP_DIR/deploy/install.sh by hand." S_finishedAt="$(now)" write_status state message finishedAt logTail
fi
exit 1
