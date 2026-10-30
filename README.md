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
| HomeKit | Admin → **HOMEKIT** publishes the Pi as a HomeKit bridge, the way Homebridge does, with a setup code and QR code to add it in the Apple Home app. Every lamp, Casambi group, and room becomes a light there (a room with the same lamps as a group, or a group or room with one lamp, only once), with on/off, brightness, colour temperature, and colour where the lamps support it, and every scene (in the Casambi network or saved on the Pi) becomes a switch, so Siri and Home automations can use them. A Casambi wall switch becomes a HomeKit remote once each of its buttons was pressed: a tap or a hold of a button can then run any Home automation. **IN APPLE HOME** chooses which ones HomeKit shows (see [the HomeKit plan](docs/HOMEKIT_PLAN.md)). |
| Google Home | Admin → **GOOGLE HOME / MATTER** runs the Pi as a Matter bridge, separate from HomeKit, so a Google Nest can switch the lights locally. It needs a free Google Home Developer Console project with a Matter integration (test vendor id `0xFFF1`, product id `0x8000`); see [the Matter plan](docs/MATTER_PLAN.md). Every lamp, Casambi group, and room becomes a light there, with on/off and dimming ("Hey Google, dim de leeslamp naar 30 procent"), with colour temperature and colour where the lamps support them ("Hey Google, maak Eiland blauw"), and every scene becomes a switch ("Hey Google, zet Avondlicht aan"). A Casambi wall switch appears once each of its buttons was pressed; every button is then an automation starter in Google Home (press, long press, release). **IN GOOGLE HOME** chooses what Google Home shows, separately from HomeKit. Paired with an iPhone, the bridge also lists **iPhone (Apple keychain)**: the Google Home app adds it through the iPhone's own Matter connection, so keep it; removing it, also under Settings → General → Matter Accessories on the iPhone, can remove the bridge from Google Home. |
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
| Admin page | **ADMIN** is split into sections, each with its own address: **CONNECTION** (Casambi network, connect, discovery; rarely changed settings and the Bluetooth worker under **ADVANCED**), **ROOMS & LAMPS**, **AUTOMATION** (switch rules, away dates, sunrise and sunset location), **ACCESS** (accounts, REST API keys), **HOMEKIT**, and **SYSTEM** (notifications, updates, backup, server, audit log). |
| Language | The interface is in English or Dutch: it follows the browser's language, and the **NL**/**EN** button at the top switches it (remembered per browser). Messages from the Pi itself, such as errors and system check advice, stay English. |
| Notifications | The bell at the top shows problems that need you: the Bluetooth connection down for 5 minutes, timers that fail or cannot run, and failed updates. Admin → **SYSTEM** → **NOTIFICATIONS** lists them; set a **WEBHOOK URL** (Home Assistant, ntfy, Slack, n8n, …) to get them elsewhere too. |
| HomeKit | Admin → **HOMEKIT**: turn on **PUBLISH AS HOMEKIT BRIDGE**, then in the Home app choose *Add Accessory* and scan the QR code (or type the setup code). iPhone and Pi must be on the same network; the bridge uses TCP port 51827 and mDNS. The Home app calls it an uncertified accessory, as with Homebridge. **RESET PAIRING** forgets every Apple Home that added it. A backup carries the HomeKit pairing, so after a restore (also on another Pi) Apple Home keeps the bridge with its rooms and automations. The system check has a HomeKit line with advice when the bridge cannot start or is not announced on the network. |
| Port or reverse proxy | Admin → **SYSTEM** → **SERVER**: change the port or turn on **BEHIND A REVERSE PROXY**, then **SAVE AND RESTART**. If the app does not come back on the new port, the previous settings are restored automatically. Other settings are in `/etc/casambi-bt-webui.env` (restart the service after editing it). |
| Update | Admin → **SYSTEM** → **UPDATES**: **CHECK FOR UPDATES**, then **UPDATE NOW**. The Pi also checks once a day by itself. A failed update restores the previous version automatically. By hand: `cd /opt/casambi-bt-webui && git pull && ./deploy/install.sh` (also needed once on installs from before updates from the app existed). |
| Back up | Admin → **SYSTEM** → **BACKUP AND RESTORE** → **DOWNLOAD BACKUP**: one file with all accounts, settings (including the Casambi network password), rooms, names, timers, scenes, switch rules, the HomeKit and Google Home (Matter) pairings, and the audit log, encrypted with a passphrase you choose. Keep the passphrase; it cannot be recovered. |
| Restore (also on a new Pi) | On the new Pi, create a temporary admin in the setup screen, then Admin → **SYSTEM** → **BACKUP AND RESTORE** → **RESTORE BACKUP** with the file and its passphrase. Everyone signs in again with an account from the backup. |
| Development without hardware | Set `CASAMBI_MOCK_MODE=true`, then run `pnpm dev`; mock fixtures are clearly marked development-only. |

### Google Home: the Developer Console project

Google Home adds an uncertified Matter device only when the Google account of the Google Home app has a matching
integration in the Google Home Developer Console. It is free and takes a few minutes, once:

1. Open <https://console.home.google.com> with the Google account you use in the Google Home app.
2. Create a project (any name, for example "Casambi").
3. Add a **Matter** integration. Choose the test vendor id **0xFFF1**, product id **0x8000**, and a bridge (or light)
   device type. The labels in the console may differ slightly.
4. On the Pi: Admin → **GOOGLE HOME / MATTER**, turn on **RUN THE MATTER BRIDGE**, and save. The vendor and product id
   under **ADVANCED** must be the same as in the console.
5. In the Google Home app: **+** → **Device** → **Matter device**, scan the QR code from the Admin page, accept the
   warning about an uncertified device, and pick a room. Lamps of a bridge can land under "not in a room"; give them
   a room in their settings.

The Pi needs IPv6 (on by default on Raspberry Pi OS), and the Google Nest must be on the same network. Paired with an
iPhone, keep **iPhone (Apple keychain)** in the list of connected apps. Backups carry the Matter pairing, so a restore,
also on another Pi, keeps the bridge in Google Home.

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

## Feature boundary

The upstream library directly provides units, groups, scenes, fixture control types, unit state callbacks, and physical switch events. It does **not** currently expose rooms as a first-class model; rooms, custom names, and local assignments are therefore stored in the Pi’s SQLite database. The bridge additionally captures SENSOR bitfields from subsequent upstream state packets before the upstream parser discards them. These live readings are intentionally labelled `raw` because fixture-specific engineering-unit conversion is not documented by the upstream package. The interface and REST API mirror every upstream entity that can be obtained through the current library, and they display controls only where a connected fixture reports that capability. [1]

See [the REST API reference](docs/API.md) for endpoints and `curl` examples, [the architecture document](docs/ARCHITECTURE.md) for bridge, storage, security, and scheduling design details, and [the development guide](docs/DEVELOPMENT.md) for commands and conventions when changing the code.

## Buy me a coffee ☕

This project grew out of many evenings, a lot of testing in a dark living room, and the occasional "why is the hallway lamp blinking?". If it saves you time, or you smile when your lights come on at sunset all by themselves, you can say thanks on [Ko-fi](https://ko-fi.com/callosum/). Every coffee keeps the updates coming. 💡

## License

Casambi BT WebGUI is licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE): you may use, change, and share it for noncommercial purposes, such as personal use, education, research, charities, and public institutions. Commercial use needs permission from me (info @ callosum nl). See [NOTICE](NOTICE) for the copyright and trademark notice. It depends on [`casambi-bt`](https://github.com/lkempf/casambi-bt) by [lkempf](https://github.com/lkempf), which is also licensed under the Apache License 2.0 and is installed as a separate package.

## References

[1]: https://github.com/lkempf/casambi-bt "lkempf/casambi-bt upstream library"
