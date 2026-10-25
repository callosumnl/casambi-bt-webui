# Casambi BT WebUI

**Casambi BT WebUI** is a self-hosted lighting-control appliance for a Raspberry Pi. It places a cyberpunk-styled React interface, a JWT- and API-key-protected REST API, a local SQLite configuration store, durable timer rules, and a supervised Node.js-to-Python Bluetooth bridge behind one local service. The Python bridge uses [`lkempf/casambi-bt`](https://github.com/lkempf/casambi-bt), which must be treated as an unofficial, alpha-quality Casambi protocol implementation. [1]

Sign in with a local account; the first visitor creates the initial `admin` account.

> Run this on a trusted local network. A lighting controller has physical-world effects. Do not expose it directly to the public internet; place it behind a VPN or a carefully configured HTTPS reverse proxy if remote access is needed.

## What is included

| Capability | Implementation |
| --- | --- |
| Casambi Bluetooth bridge | Node.js supervises a long-lived Python JSON-lines subprocess that owns `casambi-bt` discovery, connection, controls, and callbacks. |
| User Dashboard | Compact status line, then group, room, and all-lights controls with their scenes, then individual lamps with capability-aware brightness and temperature. Switches and sensors are not listed as lamps. |
| Scenes | Save the current setting of a group, room, or all lights as a named scene, apply it with one tap, update it to the current lights, and use it in timers and switch rules. Scenes stored in the Casambi network can be activated too. |
| Admin Panel | Casambi connection configuration, discovery, custom names, rooms, local users, scoped API keys, bridge state, and audit data. |
| Timers and polling | SQLite-backed five-field cron rules in IANA timezones plus configurable 5–3,600 second state polling with capped retry backoff. |
| REST and real time | Versioned authenticated REST API plus Server-Sent Events for state, bridge, and schedule updates. |
| Security | Local `admin`/`user` roles, password hashes, short-lived JWTs, revocable hashed API keys, encrypted Casambi credentials, input validation, and audit records. |

## Requirements

The target device needs Raspberry Pi OS 64-bit, a working Bluetooth adapter, Python 3.11 or newer, and Node.js 22 or newer. The application uses Node’s built-in SQLite implementation to avoid an additional native database module; the current Node 22 runtime emits an experimental API warning, so deploy a current Node LTS release and re-run the test suite after a Node upgrade. The upstream Python package requires Python 3.11 or newer and its documented dependencies include Bleak, cryptography, HTTPX, and AnyIO. [1]

The connected Casambi network must be configured to accept the Bluetooth workflow. The upstream project specifically warns that its protocol implementation is incomplete and tested against a small network; validate all fixture types, scenes, and controls in a non-critical environment before relying on automation. [1]

## Raspberry Pi installation

Clone the repository into the system location and create a dedicated system account. The commands below assume the production deployment uses `/opt/casambi-bt-webui` and a Pi account with `sudo` access.

```bash
sudo apt update
sudo apt install -y git python3 python3-venv build-essential bluetooth bluez
sudo mkdir -p /opt
sudo git clone https://github.com/callosumnl/casambi-bt-webui.git /opt/casambi-bt-webui
sudo chown -R "$USER":"$USER" /opt/casambi-bt-webui
cd /opt/casambi-bt-webui

# Install Node.js 22+ using your distribution’s supported NodeSource or nvm process.
node --version
corepack enable
cp deploy/environment.template .env
chmod 600 .env
```

Edit `.env` before installing the service. Generate **different** high-entropy values for `CASAMBI_ENCRYPTION_KEY` and `CASAMBI_JWT_SECRET`; changing the encryption key later renders previously stored Casambi secrets unreadable. Set `CASAMBI_MOCK_MODE=false` for a physical installation and set `CASAMBI_PYTHON_COMMAND` to the project virtual environment path shown in the example.

```bash
openssl rand -base64 48
nano .env
chmod +x deploy/install.sh
sudo APP_DIR=/opt/casambi-bt-webui ./deploy/install.sh
```

The installer creates a least-privilege `casambi` service user, Python virtual environment, build output, environment file, systemd service, and a protected runtime-data directory. The upstream `casambi-bt` package caches network state in `/var/lib/casambi-bt-webui/casambi-bt-store`; this directory is owned by the service account and is deliberately separate from the read-only application code in `/opt`. Confirm the service is running and watch its logs.

```bash
sudo systemctl status casambi-bt-webui.service
sudo journalctl -u casambi-bt-webui.service -f
```

Open `http://<pi-hostname-or-ip>:3000`. The first visitor must create the initial `admin` account. From the Admin Panel, save the Casambi network address, optional UUID/API key, Bluetooth adapter label, and **network password**, then run discovery or connect. The current upstream library’s connection method uses the address and password; the WebUI stores UUID, adapter, and optional API-key metadata for administration and future upstream support without claiming that `casambi-bt` currently consumes each of those fields. [1]

## Operations and recovery

| Task | Command or action |
| --- | --- |
| Restart after configuration or upgrade | `sudo systemctl restart casambi-bt-webui` |
| Inspect service logs | `sudo journalctl -u casambi-bt-webui.service -n 200 --no-pager` |
| Update code | `git pull && corepack pnpm install --frozen-lockfile && pnpm build && sudo systemctl restart casambi-bt-webui` |
| Back up state | Stop the service and securely copy all of `/var/lib/casambi-bt-webui/`, including the SQLite database and upstream Casambi cache. |
| Restore state | Stop the service, restore `/var/lib/casambi-bt-webui/` with owner `casambi:casambi`, then start the service. |
| Development without hardware | Set `CASAMBI_MOCK_MODE=true`, then run `pnpm dev`; mock fixtures are clearly marked development-only. |

### Troubleshooting a `casambi-bt-store` permission error

If an older installation reports `PermissionError: [Errno 13] Permission denied: '/opt/casambi-bt-webui/casambi-bt-store'` while connecting, the Casambi password has already reached the bridge; the error is the upstream library attempting to create its local cache inside the read-only application directory. Upgrade to a version that includes the dedicated cache path. To recover before upgrading, create the historical cache path for the restricted service account and restart the service:

```bash
sudo install -d -m 0700 -o casambi -g casambi /opt/casambi-bt-webui/casambi-bt-store
sudo systemctl restart casambi-bt-webui.service
```

### Troubleshooting a local BLE endpoint discovery error

An error stating that the Raspberry Pi cannot discover a local BLE endpoint means BlueZ cannot see the configured Casambi network address locally. This is independent of the network password. The bridge deliberately retains the `BLEDevice` object returned by its immediate discovery scan because the upstream library otherwise attempts a second BlueZ cache lookup after network-update work, where a short-lived BlueZ device entry may have expired. Verify discovery using the same restricted service account as the WebUI:

```bash
sudo -u casambi /opt/casambi-bt-webui/.venv/bin/python -c \
  'import asyncio; from CasambiBt import discover; print([device.address for device in asyncio.run(discover())])'
```

Use an address returned by that command. If it returns an empty list, move the Pi or its Bluetooth antenna closer to a powered Casambi unit, ensure the `bluetooth` service is active, and confirm that `id casambi` includes the `bluetooth` group. The installer and service template grant this group automatically; after upgrading an older installation, run `sudo usermod -aG bluetooth casambi`, `sudo systemctl daemon-reload`, and `sudo systemctl restart casambi-bt-webui.service`.

The Python bridge restarts after unexpected exit with capped exponential backoff. Commands are serialized and timeout-bounded so one malformed response cannot permanently block the HTTP service. When an administrator enables polling, the service requests fresh snapshots at the selected interval and backs off after errors. A bridge disconnect publishes state updates to browser clients and is recorded in the audit history without returning secrets.

## Development and testing

Install the JavaScript packages and Python library as above, then run the following from the repository root.

```bash
pnpm install
pnpm check
pnpm test
pnpm build
CASAMBI_MOCK_MODE=true pnpm dev
```

## Python package preparation

The repository is also prepared for a future PyPI distribution named `casambi-bt-webui`. Its wheel is a **Raspberry Pi deployment companion**, not a replacement for the Node.js web application: it provides the `casambi-bt-webui` command for prerequisite diagnostics and for writing non-secret systemd and environment templates. The complete UI and API continue to be deployed from this repository.

```bash
# Available after a future PyPI release, or from a locally built wheel.
casambi-bt-webui doctor
casambi-bt-webui systemd-template
casambi-bt-webui write-templates --directory ./deployment-templates
```

See [the PyPI release guide](docs/PYPI_RELEASE.md) for the build, TestPyPI, Trusted Publishing, and production-release process.

The Vitest suite covers password and API-key handling, encrypted settings, role-protected REST routes, bridge JSON-lines correlation and events, and schedule validation. It deliberately uses a deterministic mock bridge in development; no automated test attempts to address live Bluetooth hardware.

After deploying on a connected Raspberry Pi, run the hardware-facing smoke test to verify the real bridge and any reported SENSOR controls. Obtain an `admin` or `user` JWT from the login endpoint, then run the script locally; it never prints Casambi credentials.

```bash
CASAMBI_JWT='your-jwt' node scripts/verify-live-bridge.mjs
```

## Feature boundary

The upstream library directly provides units, groups, scenes, fixture control types, unit state callbacks, and physical switch events. It does **not** currently expose rooms as a first-class model; rooms, custom names, and local assignments are therefore stored in the Pi’s SQLite database. The bridge additionally captures SENSOR bitfields from subsequent upstream state packets before the upstream parser discards them. These live readings are intentionally labelled `raw` because fixture-specific engineering-unit conversion is not documented by the upstream package. The interface and REST API mirror every upstream entity that can be obtained through the current library, and they display controls only where a connected fixture reports that capability. [1]

See [the REST API reference](docs/API.md) for endpoints and `curl` examples, and [the architecture document](docs/ARCHITECTURE.md) for bridge, storage, security, and scheduling design details.

## GitHub workflow

The repository is configured for the intended private GitHub destination. To publish local changes manually after validation, use a normal reviewable Git workflow.

```bash
git status
git add .
git commit -m "Describe the change"
git push origin main
```

## References

[1]: https://github.com/lkempf/casambi-bt "lkempf/casambi-bt upstream library"
