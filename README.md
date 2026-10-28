# Casambi BT WebGUI

**Casambi BT WebGUI** is a self-hosted lighting-control appliance for a Raspberry Pi. It places a cyberpunk-styled React interface, a JWT- and API-key-protected REST API, a local SQLite configuration store, durable timer rules, and a supervised Node.js-to-Python Bluetooth bridge behind one local service. The Python bridge uses [`lkempf/casambi-bt`](https://github.com/lkempf/casambi-bt), which must be treated as an unofficial, alpha-quality Casambi protocol implementation. [1]

[![Buy me a coffee on Ko-fi](https://img.shields.io/badge/Ko--fi-Buy%20me%20a%20coffee-FF5E5B?logo=ko-fi&logoColor=white)](https://ko-fi.com/callosum/)

> **Disclaimer:** Casambi BT WebGUI is an independent, source-available hobby project. It is not affiliated with, endorsed by, or supported by Casambi Technologies. "Casambi" is a trademark of Casambi Technologies and is used here only to describe the lighting system this software works with. The Bluetooth protocol support comes from the unofficial [`casambi-bt`](https://github.com/lkempf/casambi-bt) library; use this software at your own risk.

Sign in with a local account. The initial `admin` account is created in the browser with a one-time setup code that the installer prints.

> Run this on a trusted local network. A lighting controller has physical-world effects. Do not expose it directly to the public internet; place it behind a VPN or a carefully configured HTTPS reverse proxy if remote access is needed.

## What is included

| Capability | Implementation |
| --- | --- |
| Casambi Bluetooth bridge | Node.js supervises a long-lived Python JSON-lines subprocess that owns `casambi-bt` discovery, connection, controls, and callbacks. |
| User Dashboard | Compact status line, then group, room, and all-lights controls with their scenes, then individual lamps with capability-aware brightness and temperature. Switches and sensors are not listed as lamps. |
| Scenes | Save the current setting of a group, room, or all lights as a named scene, apply it with one tap, update it to the current lights, and use it in timers and switch rules. Scenes stored in the Casambi network can be activated too. |
| Admin Panel | Casambi connection settings, discovery, connect/disconnect, Bluetooth worker state and restart, unit names and rooms, rooms (rename, default brightness, delete), local accounts (create, role, new password, delete), REST API keys (create, list, revoke), shared away-date sets, switch rules, and the audit log. |
| Timers and polling | SQLite-backed timers at a time on chosen days or at sunrise/sunset (±180 min) in IANA time zones, with away dates and shared away-date sets, optional fades, and saved scenes as targets; plus configurable 5–3,600 second state polling. |
| Physical switches | Live switch activity and switch rules: a tap, hold, or release-after-hold of a Casambi button can toggle, switch, dim, or apply a scene. |
| REST and real time | Versioned REST API with JWT or API-key authentication, described by an OpenAPI 3.1 document at `/api/v1/openapi.json` and browsable in the web UI under **API**; Server-Sent Events for live state, connection, switch, and timer updates. |
| Security | Local `admin`/`user` roles, password hashes, short-lived JWTs, revocable hashed API keys, encrypted Casambi credentials, input validation, and audit records. |

## Requirements

The target device needs Raspberry Pi OS 64-bit, a working Bluetooth adapter, Python 3.11 or newer, and Node.js 22 or newer. The application uses Node’s built-in SQLite implementation to avoid an additional native database module; the current Node 22 runtime emits an experimental API warning, so deploy a current Node LTS release and re-run the test suite after a Node upgrade. The upstream Python package requires Python 3.11 or newer and its documented dependencies include Bleak, cryptography, HTTPX, and AnyIO. [1]

The connected Casambi network must be configured to accept the Bluetooth workflow. The upstream project specifically warns that its protocol implementation is incomplete and tested against a small network; validate all fixture types, scenes, and controls in a non-critical environment before relying on automation. [1]

## Raspberry Pi installation

On a fresh Raspberry Pi 5 (or 4) with **Raspberry Pi OS 64-bit** (Bookworm or newer), sign in with your normal account and run:

```bash
sudo apt update && sudo apt install -y git
sudo git clone https://github.com/callosumnl/casambi-bt-webui.git /opt/casambi-bt-webui
/opt/casambi-bt-webui/deploy/install.sh
```

That single installer sets up everything and can be run again at any time:

- system packages (Python 3 with venv, build tools, BlueZ, rfkill) and **Node.js 22** from the NodeSource apt repository when the installed Node.js is older (the repository's signing key is checked against a pinned fingerprint first);
- the checkout handed to your account (also after `sudo git clone`), so later updates never hit root-owned files;
- a least-privilege `casambi` service account in the `bluetooth` group, and its data directory `/var/lib/casambi-bt-webui/` (database and the upstream `casambi-bt-store` cache);
- Bluetooth unblocked and the `bluetooth` service enabled;
- `avahi-daemon`, so the Pi is reachable as `http://<hostname>.local:3000` and announces the web app to apps and browsers that list local (Bonjour) services;
- the Python bridge environment (`.venv`) and the web application build, both owned by your account;
- `/etc/casambi-bt-webui.env` with **freshly generated, unique secrets** on the first run; later runs keep it and only add settings introduced by newer versions;
- the systemd service, enabled at boot and restarted on the new build, followed by a check that the web interface answers.

Run the installer as your normal account, not with `sudo`; it asks for `sudo` itself where needed (started with `sudo` it still builds as the checkout's owner). It prints the address to open, for example `http://casambi.local:3000`, and on a fresh install a one-time setup code: enter it in the browser to create the initial `admin` account (it is also in `/var/lib/casambi-bt-webui/setup-code` until the admin exists). The setup wizard then opens and walks through checking the Pi, finding and connecting the Casambi network (enter its **network password**), creating a room for each Casambi group, and the location for sunrise and sunset timers; run it again any time from Admin → **SETUP WIZARD**. The current upstream library's connection method uses the address and password; the WebUI stores UUID, adapter, and optional API-key metadata for administration and future upstream support without claiming that `casambi-bt` currently consumes each of those fields. [1]

Settings live in `/etc/casambi-bt-webui.env`; change them with `sudoedit /etc/casambi-bt-webui.env` and restart the service. Never change `CASAMBI_ENCRYPTION_KEY` after the first start: stored Casambi credentials would become unreadable.

## Operations and recovery

| Task | Command or action |
| --- | --- |
| Find the Pi | `http://<hostname>.local:3000` (for example `http://casambi.local:3000`). The system check and the end of `install.sh` show the IP address and the device (MAC) address to reserve in your router, so the IP address never changes. |
| Check the system | Admin → **SYSTEM CHECK** (or **DIAGNOSE** in the desktop menu): Bluetooth, Wi-Fi interference, the Casambi connection, clock, storage, temperature, and power, with advice. **DOWNLOAD DIAGNOSTICS FILE** gives one file to share when asking for help; it contains no passwords or keys. |
| Restart after a settings change | `sudo systemctl restart casambi-bt-webui` |
| Inspect service logs | `sudo journalctl -u casambi-bt-webui.service -n 200 --no-pager` |
| Language | The interface is in English or Dutch: it follows the browser's language, and the **NL**/**EN** button at the top switches it (remembered per browser). Messages from the Pi itself, such as errors and system check advice, stay English. |
| Notifications | The bell at the top shows problems that need you: the Bluetooth connection down for 5 minutes, timers that fail or cannot run, and failed updates. Admin → **NOTIFICATIONS** lists them; set a **WEBHOOK URL** (Home Assistant, ntfy, Slack, n8n, …) to get them elsewhere too. |
| Port or reverse proxy | Admin → **SERVER**: change the port or turn on **BEHIND A REVERSE PROXY**, then **SAVE AND RESTART**. If the app does not come back on the new port, the previous settings are restored automatically. Other settings are in `/etc/casambi-bt-webui.env` (restart the service after editing it). |
| Update | Admin → **UPDATES**: **CHECK FOR UPDATES**, then **UPDATE NOW**. The Pi also checks once a day by itself. A failed update restores the previous version automatically. By hand: `cd /opt/casambi-bt-webui && git pull && ./deploy/install.sh` (also needed once on installs from before updates from the app existed). |
| Back up | Admin → **BACKUP AND RESTORE** → **DOWNLOAD BACKUP**: one file with all accounts, settings (including the Casambi network password), rooms, names, timers, scenes, switch rules, and the audit log, encrypted with a passphrase you choose. Keep the passphrase; it cannot be recovered. |
| Restore (also on a new Pi) | On the new Pi, create a temporary admin in the setup screen, then Admin → **BACKUP AND RESTORE** → **RESTORE BACKUP** with the file and its passphrase. Everyone signs in again with an account from the backup. |
| Development without hardware | Set `CASAMBI_MOCK_MODE=true`, then run `pnpm dev`; mock fixtures are clearly marked development-only. |

### Troubleshooting `EACCES` during `pnpm build`

If a manual `pnpm install` or `pnpm build` fails with `EACCES: permission denied` in `node_modules` (for example `node_modules/.vite-temp`), something was once run as root in the checkout. Run the installer, which gives the checkout back to your account and rebuilds:

```bash
cd /opt/casambi-bt-webui && ./deploy/install.sh
```

Never prefix `pnpm` with `sudo`.

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

See [the REST API reference](docs/API.md) for endpoints and `curl` examples, [the architecture document](docs/ARCHITECTURE.md) for bridge, storage, security, and scheduling design details, and [the development guide](docs/DEVELOPMENT.md) for commands and conventions when changing the code.

## GitHub workflow

The repository is configured for the intended private GitHub destination. To publish local changes manually after validation, use a normal reviewable Git workflow.

```bash
git status
git add .
git commit -m "Describe the change"
git push origin main
```

## Buy me a coffee ☕

This project grew out of many evenings, a lot of testing in a dark living room, and the occasional "why is the hallway lamp blinking?". If it saves you time, or you smile when your lights come on at sunset all by themselves, you can say thanks on [Ko-fi](https://ko-fi.com/callosum/). Every coffee keeps the updates coming. 💡

## License

Casambi BT WebGUI is licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE): you may use, change, and share it for noncommercial purposes, such as personal use, education, research, charities, and public institutions. Commercial use needs permission from me (info @ callosum nl). See [NOTICE](NOTICE) for the copyright and trademark notice. It depends on [`casambi-bt`](https://github.com/lkempf/casambi-bt) by [lkempf](https://github.com/lkempf), which is also licensed under the Apache License 2.0 and is installed as a separate package.

## References

[1]: https://github.com/lkempf/casambi-bt "lkempf/casambi-bt upstream library"
