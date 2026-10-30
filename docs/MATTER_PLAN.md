# Matter / Google Home plan

Status: phases 0 (spike), 1 (shared lighting core), 2 (the Matter bridge with pairing and the Google Home tab), 3 (lamps, groups, and rooms), 4 (colour), 5 (scenes and choosing what Google Home shows), and 6 (backup, system check, instructions) are done; phase 7 (wall switches) is optional.

## Goal

Control the Casambi lamps from Google Home and a Google Nest speaker or display ("Hey Google, zet de leeslamp aan"),
locally, without a cloud service of our own. The HomeKit bridge stays as it is.

## Why Matter

Google Home has two ways in for third-party devices: a cloud-to-cloud integration (our own cloud service, OAuth,
Google review) or **Matter**, the local smart-home standard. Matter fits this appliance: the Pi is a **Matter
bridge** on the home network, and a Google Nest speaker or display is the Matter hub that controls it locally. It is
the same model as the HomeKit bridge, with the Matter protocol instead of HAP.

| Option | Verdict |
| --- | --- |
| **Matter bridge in this service (recommended)** | Local, no cloud, no Google review. Uses [matter.js](https://github.com/project-chip/matter.js) (`@matter/main`, Apache-2.0, pure TypeScript, 0.18 at the time of writing), the library behind the Matter support in Homebridge and Home Assistant Matter Hub. |
| Google cloud-to-cloud integration | Needs a public cloud endpoint, account linking, and Google's review. Does not fit a local appliance. |
| Use Home Assistant as the bridge | A whole second system to install and keep running, only for this. |

## What Google needs (outside this code)

- **A Matter hub:** a Google Nest speaker or display, or a Nest Wifi Pro, on the same network as the Pi. Google
  Home controls Matter devices through it locally. Here: a **Google Nest Hub**, which Google lists as a Matter hub;
  phase 0 confirms it on this network.
- **A Google Home Developer Console project** under the same Google account as the Google Home app, with a Matter
  integration for the bridge. Google Home only commissions an **uncertified** Matter device whose vendor and product
  id match such an integration. We use the CSA test vendor id `0xFFF1` with a test product id (for example `0x8000`);
  a test vendor id may not be used in a product that is sold, which this hobby project is not. Creating the project
  is free; the README will have the steps with screenshots.
- **Network:** Matter runs over IPv6 (link-local is enough) and announces itself with mDNS. Raspberry Pi OS has IPv6
  on by default; the router must pass multicast between the Pi and the Nest (same network, no client isolation).

## Architecture

```
Google Home app ─ commissioning (QR code / 11-digit code) ─┐
Google Nest hub ── Matter (UDP 5540, IPv6, encrypted) ─────┤
                                                            ▼
                               MatterBridge (server/matter/) — matter.js ServerNode
                               └ Aggregator endpoint
                                 ├ bridged Dimmable / Color Temperature / Extended Color Light (lamps, groups, rooms)
                                 └ bridged On/Off Plug-in Unit (scenes)
                                          │ reads: cached snapshot · writes: shared write planner
                                          ▼
                               CasambiService (unchanged)
```

Most of the HomeKit work is protocol-neutral and is reused instead of copied:

| Shared (moved to `server/lighting/`) | From |
| --- | --- |
| Which lights exist: lamps, groups, rooms, scenes; stable keys; no duplicates (room = group, single-lamp group/room) | `homekit/mapping.ts` `describeLights` |
| Light state from the cached snapshot (on, level, colour temperature, colour, reachable) | `homekit/mapping.ts` `lightState` |
| Write planning: merge writes, colour before power, one group/network command where possible | `homekit/mapping.ts` `planWrites` |
| Colour conversions (kelvin/mired, RGB, hue/saturation, CIE xy) | `homekit/colour.ts` |
| Cached light list, so the controller keeps its setup while Bluetooth is connecting | `homekit/lights.ts` (the protocol-neutral half) |

`server/matter/` then only holds what is Matter-specific:

| File | Responsibility |
| --- | --- |
| `bridge.ts` | `MatterBridge`: settings, matter.js `ServerNode` with an Aggregator, start/stop, commissioning codes, fabrics (which ecosystems are connected), opening a pairing window, factory reset, audit. |
| `endpoints.ts` | One bridged endpoint per light or scene, with Bridged Device Basic Information (name, `reachable`), On/Off, Level Control, Color Control; maps reads and writes to the shared core. |
| `levels.ts` | Matter units: level 1–254 ↔ Casambi 0–255, mired (same as HomeKit), hue and saturation 0–254, xy 0–65279. |

### Mapping to Matter device types

| Casambi | Matter device type | Clusters |
| --- | --- | --- |
| On/off lamp | On/Off Light | On/Off |
| Dimmable lamp | Dimmable Light | On/Off, Level Control |
| Tunable white lamp | Color Temperature Light | + Color Control (colour temperature, within the lamp's kelvin range) |
| RGB / XY lamp | Extended Color Light | + Color Control (hue/saturation and xy) |
| Group, room | Same as the richest lamp in it | One Casambi command for the whole group |
| Scene (Casambi or saved on the Pi) | On/Off Plug-in Unit, momentary | "Hey Google, zet Avondlicht aan" activates it; it switches itself off after a second |
| Wall switch | Generic Switch (optional, phase 7) | Only if Google Home automations can use it; check first |

Every bridged endpoint gets a stable unique id from the same key HomeKit uses (unit UUID, network + group id, room
id, scene id), so Google keeps names, rooms, and routines across restarts. While Bluetooth is disconnected or a lamp is
offline, `reachable` is false and Google shows it as offline, the equivalent of HomeKit's "No Response".

## Settings, pairing and security

The Google Home configuration is **completely separate from HomeKit**: its own on/off, name, port, pairing,
connected ecosystems, list of what is shown, and its own section in backups and the system check. Turning HomeKit off,
resetting its pairing, or hiding a lamp there changes nothing in Google Home, and the other way around. Only the code
that turns Casambi state into lights (the shared core) is shared, not any setting.

| Setting | Default |
| --- | --- |
| `matter.enabled` | off |
| `matter.name` | "Casambi-bt-webui" |
| `matter.port` | 5540 (the Matter default) |
| `matter.passcode`, `matter.discriminator` | random, generated once; never one of Matter's forbidden passcodes (00000000, 11111111, …, 12345678, 87654321) |
| `matter.vendorId`, `matter.productId` | `0xFFF1`, `0x8000`; changeable, to match the Developer Console integration |
| `matter.hidden` | what Google Home should not show; starts with everything shown |

- matter.js keeps the node's keys and the fabrics (one per ecosystem that added the bridge) in
  `/var/lib/casambi-bt-webui/matter/`, which the service may write.
- Commissioning is **on-network** (Bluetooth commissioning is not needed, and the Pi's Bluetooth belongs to Casambi).
- The Admin page gets a **MATTER** tab: on/off, name, vendor/product id, the QR code and the 11-digit manual pairing
  code, the connected ecosystems (Google Home, and others if added) with **REMOVE**, **OPEN PAIRING WINDOW** (to add a
  second ecosystem; Matter allows several), **RESET** (all fabrics gone), and the IN GOOGLE HOME list.
- Pairing codes are shown to admins only and never written to the audit log; commissioning, fabric changes, and
  resets are audited.
- Matter traffic is encrypted and authenticated (certificate-based sessions); the setup passcode is the only secret
  needed to add the bridge, and only while a pairing window is open.

**Apple Home and Matter at the same time:** Apple Home could add the Matter bridge too, but then every lamp appears
twice (via HAP and via Matter). The panel will say to use the HomeKit bridge for Apple Home and the Matter bridge for
Google Home.

## Deployment

- Dependency: `@matter/main` (pure TypeScript; no native build on the Pi). In `NOTICE`.
- Ports: UDP 5540 for Matter, UDP 5353 for mDNS. matter.js runs its own mDNS responder; it has to work next to
  avahi on the Pi (Home Assistant Matter Hub does the same), which phase 0 checks.
- The systemd unit already allows `AF_INET6` and the data directory; no change expected.
- Backups carry the Matter storage, so a restore (also on another Pi) keeps the bridge in Google Home, as in HomeKit
  phase 5.
- The system check gets a Matter line: IPv6 address present, announced, commissioned fabrics, reachable from the
  hub (last controller contact).

## Testing

- The shared core keeps its tests; HomeKit tests must stay green after the move.
- `levels.ts` unit tests (level, mired, hue/saturation, xy edges).
- `MatterBridge` and endpoints tested in-process with matter.js's own commissioning controller: commission over
  loopback, read and write On/Off, Level, Color Control, see `reachable` change, scene auto-off, hidden endpoints
  removed, settings and reset.
- End-to-end on the Pi with the real Google Nest: commission in the Google Home app, voice commands in Dutch,
  routines, restart and Bluetooth reconnect, restore of a backup.

## Phase 0 runbook

`scripts/matter-spike.mjs` is a throw-away Matter bridge with test lamps; it does not touch the running service.
Checked on a Mac with matter.js's own controller: commissioning over the network, the bridged lamps with their names,
On/Off and Level commands, and forwarding to a Casambi unit through the REST API.

1. **Google Home Developer Console** (<https://console.home.google.com>), signed in with the Google account of the
   Google Home app: create a project, add a **Matter** integration, choose the test vendor id (`0xFFF1`), product id
   `0x8000`, and a bridge (or light) device type. The labels in the console may differ slightly.
2. **On the Pi**, as the normal user (not `casambi`), in a separate folder:
   ```
   mkdir -p ~/matter-spike-src && cd ~/matter-spike-src
   npm install @matter/main@0.18.0 qrcode@1.5.4
   ```
   Copy `scripts/matter-spike.mjs` there (for example with `scp` from a computer with this repository), then run
   `node matter-spike.mjs`. It prints a QR code and an 11-digit setup code. UDP port 5540 must be free.
3. **Google Home app:** + → Device → Matter device (the exact wording varies), scan the QR code or type the setup
   code, accept the warning about an uncertified device, and pick a room. Then: "Hey Google, zet testlamp aan".
4. **A real lamp:** create a REST API key under Admin → Access, look up the unit id with
   `curl -s -H "X-API-Key: <key>" http://localhost:3000/api/v1/network`, and start the spike with
   `--api http://localhost:3000 --api-key <key> --unit <id>`.
5. **Scale:** remove the test bridge from Google Home, delete `~/matter-spike`, and start again with `--lamps 60`
   (about lamps + groups + rooms + scenes of a real network).
6. **Clean up:** remove the bridge from Google Home, stop the script, delete `~/matter-spike` and `~/matter-spike-src`,
   and revoke the API key.

Report: whether commissioning succeeded (or the exact error), whether the voice command worked, how quickly the lamp
reacted, and how Google Home handled 60 lamps.

## Phases

0. **Spike (go/no-go):** on the Pi, a matter.js bridge with one dimmable mock light. Create the Developer Console
   project and integration, commission it in Google Home, and say "Hey Google, zet de testlamp aan". Confirms the
   Nest is a Matter hub, IPv6/mDNS on the network, and matter.js next to avahi. Nothing is merged before this works.
1. **Shared lighting core (done):** `server/lighting/` holds the model (`model.ts`: which lights, their state, write
   planning, with each platform's naming rule passed in), colour conversions (`colour.ts`), the per-platform list of
   what is shown (`registry.ts`: settings under `<prefix>.lights`, `.hidden`, `.buttons`, removal rules), and write
   batching (`writes.ts`). `HomeKitLights` only builds HAP accessories on top; HomeKit behaves exactly as before.
2. **Matter bridge (done):** `server/matter/` (`bridge.ts`, `runtime.ts`, `identity.ts`): settings under `matter.*`,
   storage in `matter/` next to the database, setup code and QR code, Admin → GOOGLE HOME / MATTER with the connected apps,
   a 15-minute pairing window for another app, removing one app, reset, and audit. matter.js logs at "warn", so the
   setup code never reaches the service log.
3. **Lamps, groups and rooms (done):** `server/matter/lights.ts` and `devices.ts`: an On/Off Light or Dimmable Light
   per lamp, Casambi group, and room (no duplicates), with their own list under `matter.*`; state pushed as it changes
   (`reachable` false while Bluetooth is down or a lamp is offline); Google Home's commands go through the shared write
   batcher as actor `matter` (on + level merged, group commands), with the Casambi level 0–255 passed through instead
   of whole percents; level transitions are instant, so one command per change reaches Casambi.
4. **Colour (done):** a white lamp is a Color Temperature Light (its kelvin range as mired), a colour lamp an Extended
   Color Light with hue/saturation, xy, and colour temperature; Matter's colour mode follows what the lamp shows (the
   shared light state now says so). Colour commands go through the shared planner, so each lamp gets kelvin, RGB, or
   xy, and colour transitions are instant (matter.js's default).
5. **Scenes and choosing what Google Home shows (done):** Casambi scenes and saved scenes are On/Off Plug-in Units that
   activate the scene and switch themselves off after a second (as plug-in units, "all lights off" leaves them alone);
   Admin → GOOGLE HOME / MATTER → IN GOOGLE HOME chooses what Google Home shows (`matter.hidden`, separate from
   HomeKit's list; `PUT /admin/matter/accessories`). The panel is shared with HomeKit's.
6. **Operations (done):** backups carry the Matter node's storage (keys, fabrics, endpoint numbers; the lock files
   excepted), so a restore, also on another Pi, keeps the bridge in Google Home; the system check has a Google Home
   (Matter) line with advice for a busy port and missing IPv6; the Admin tab has a "How do I connect Google Home?"
   window with the five steps and links to the Developer Console and Google's help; the README has the same steps.
7. **Optional, wall switches:** as Matter Generic Switch, if Google Home automations can use them.

## Decisions

- **Phase 0 result (2026-10-30):** on the Pi, the Google Home app commissioned the matter.js test bridge (test vendor
  id `0xFFF1`, product id `0x8000`, Developer Console integration) through the Google Nest Hub, and "Hey Google"
  switched and dimmed the test lamp and, through the REST API, the real Casambi lamp "Eiland", quickly. matter.js's
  mDNS ran next to avahi on `eth0` without trouble. The spike did not report state back (Google kept its own last
  level) and sent on and level as two Casambi commands; the real bridge reports state and merges them. The scale test
  with 60 lamps was skipped: the network has one lamp.
- Matter hub: a Google Nest Hub.
- The Google Home (Matter) configuration is fully separate from HomeKit; its list of what is shown starts with
  everything.

## Open questions

- Does Google Home accept a bridge with as many endpoints as your network has (lamps + groups + rooms + scenes)?
  The spike adds a realistic number.
- Do Google Home routines support Matter Generic Switch presses (phase 7)?
