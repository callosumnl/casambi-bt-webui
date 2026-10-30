# HomeKit compatibility plan

Status: phases 1 (bridge, pairing, admin panel) and 2 (lamps, groups and rooms) are implemented; colour is next.

## Goal

Make the Casambi lamps, scenes and switches that the Pi already controls show up in Apple Home, with live state and
Siri, without a cloud service and without asking users to install anything besides this appliance.

## Approach: embed HAP-NodeJS, the way Homebridge does

Homebridge is a thin host around [`hap-nodejs`](https://github.com/homebridge/HAP-NodeJS) (Apache-2.0): it publishes
one **bridge accessory** over mDNS, and plugins add **bridged accessories** whose **services** (Lightbulb, Switch, …)
and **characteristics** (On, Brightness, …) are wired to a device with `onGet`/`onSet` handlers and pushed with
`updateCharacteristic`. We apply exactly those principles, but host them inside our own Node process:

| Option | How | Verdict |
| --- | --- | --- |
| **A. Built-in HomeKit bridge (recommended)** | `hap-nodejs` runs in the existing service, next to the scheduler and switch rules, and calls `CasambiService` directly. | Fits the single-service appliance model: one installer, one backup, one admin UI, no second process, no API key. |
| B. Homebridge plugin | Separate npm package `homebridge-casambi-bt-webui` that talks to our REST API with an API key and listens to `/api/v1/events`. | Useful for people who already run Homebridge. Can be added later on top of the same mapping module (phase 6). |

Running two HomeKit bridges for the same lamps is never useful, so the docs must tell users to pick one.

## Architecture

```
Apple Home ──HAP (TCP, encrypted)──► HomeKitBridge (server/homekit/)
                                       │  onSet → coalescing write queue → CasambiService.control(…, "homekit")
                                       │  onGet → CasambiService.cachedSnapshot()  (never waits on Bluetooth)
                                       ◄─ CasambiService state listeners → updateCharacteristic
mDNS (_hap._tcp) via avahi-daemon (already installed) or @homebridge/ciao
```

New module `server/homekit/`:

| File | Responsibility |
| --- | --- |
| `bridge.ts` | `HomeKitBridge` class: settings, start/stop/publish/unpublish the HAP bridge, pairing events, reset; later also syncing accessories with the snapshot. (Done.) |
| `identity.ts` | Device id, setup code and setup id generation; HomeKit name sanitising. (Done.) |
| `mapping.ts` | Pure functions: Casambi unit → HomeKit services; 0–255 ↔ 0–100 %, Kelvin ↔ mireds, RGB/XY ↔ hue/saturation; name sanitising. Shared with a later Homebridge plugin. |
| `writeQueue.ts` | Coalesces characteristic writes per unit and across units, then plans them with `planTargets`. |

Changes to existing code:

- `CasambiService`: add `onStateChange(listener)` (like `onSwitchPress`) fired from `handleBridgeEvent` for
  `unit.state`, after every new snapshot, and on connection changes, so HomeKit does not have to tap the SSE hub.
- `server/_core/index.ts`: construct `HomeKitBridge` after `casambi.initialize()`, stop it in `shutdown()` (unpublish
  mDNS cleanly).
- `store.ts`: `homekit_exposure` table (unit/scene/group id, exposed flag) or a column in `unit_metadata`.
- `api.ts` + `openapi.ts` + `apiSchemas.ts`: admin endpoints (below).
- Client: an Admin → **HOMEKIT** panel and Dutch strings in `client/src/lib/i18n/nl/`.

## Accessory mapping

Stable identity is essential, otherwise Home loses rooms, names and automations: accessory UUID =
`hap.uuid.generate("casambi:<network id>:unit:<unit uuid>")` (scene: `…:scene:<id>`, local scene:
`…:local_scene:<id>`). Never derive it from names or array positions.

| Casambi entity | HomeKit | Characteristics |
| --- | --- | --- |
| Lamp with `onoff` only | Lightbulb | On |
| Lamp with `dimmer` | Lightbulb | On, Brightness (0–100 % ↔ 0–255, reuse `client/src/lib/brightness.ts` rules) |
| Lamp with `temperature` | Lightbulb | + ColorTemperature in mireds, min/max from the capability's Kelvin range (HomeKit allows 140–500) |
| Lamp with `rgb` / `xy` | Lightbulb | + Hue, Saturation (HSV ↔ RGB / CIE xy) |
| Casambi switch (button unit) | StatelessProgrammableSwitch per button (later phase) | ProgrammableSwitchEvent: `tap` → SINGLE_PRESS, `hold` → LONG_PRESS (from `onSwitchPress`) |
| Casambi scene and local scene | Switch, momentary (turns itself off after 1 s, Homebridge convention) | On |
| Casambi group / local room (exposed by default) | Lightbulb | On, Brightness; one Bluetooth command instead of many |
| Sensors | not exposed in v1 | values are `raw` without documented units |

Every accessory gets an AccessoryInformation service (Manufacturer, Model, SerialNumber = unit uuid,
FirmwareRevision) and the custom name from `unit_metadata`, set via `ConfiguredName` and sanitised to HomeKit's naming
rules (must start and end with a letter or digit).

## Behaviour rules

- **Reads never touch Bluetooth.** `onGet` answers from `cachedSnapshot()`. When the network is disconnected or a unit
  is `online: false`, throw `HapStatusError(SERVICE_COMMUNICATION_FAILURE)` so Home shows "No Response" instead of
  stale values.
- **Writes are coalesced.** Home sends `On` and `Brightness` (and Hue then Saturation) as separate writes, and a room
  or scene in Home sends one write per lamp. Collect writes for ~75 ms, merge per unit (brightness 0 → off, Hue +
  Saturation → one `set_color`), bucket lamps by target value with `bucketBy`, and send each bucket through
  `planTargets` so "Living room off" becomes one group or network command, not ten Bluetooth writes.
- **On restores the last level.** HomeKit expects On to return to the previous brightness. Casambi's own `on`
  command already restores each lamp's last level, so On maps to `on` and Off to `off`; only a Brightness write sends
  `set_level`.
- **Everything goes through `CasambiService.control`** with actor `homekit`, so audit, room expansion, fade
  interruption and SSE updates keep working, and the web UI shows HomeKit changes live.
- **Pushes:** `onStateChange` → `updateCharacteristic` only for values that changed, rate-limited, to avoid flooding
  HAP connections during polling or fades.
- **Topology changes:** on a new snapshot, add accessories for new units and remove ones that disappeared (after a
  grace period, so a temporary Bluetooth gap does not delete them and wipe the user's Home setup).
- HomeKit allows at most 149 bridged accessories; refuse to expose more and say so in the admin panel.

## Settings, pairing and security

Stored in the `settings` table, managed by admins only:

| Setting | Default |
| --- | --- |
| `homekit.enabled` | off |
| `homekit.name` | "Casambi-bt-webui" (changeable in Admin → HOMEKIT) |
| `homekit.port` | 51827 (Homebridge uses 51826; avoids a clash if both run on one Pi) |
| `homekit.username` | random MAC-style id, generated once |
| `homekit.pincode` | random 8-digit code, generated once; never one of HomeKit's disallowed codes (e.g. 12345678, 11111111). Stored as a plain app setting: encrypted settings are re-keyed only for the Casambi secrets on a restore, and the code is useless without HAP's keys in the storage folder |
| `homekit.setupId` | random 4 characters, for the QR code |
| `homekit.exposeGroups`, per-entity exposure | everything on, groups and rooms included |

- Admin panel shows status (published / paired / number of controllers), the setup code and a QR code
  (`accessory.setupURI()`, rendered client-side), exposure toggles, and **RESET PAIRING** (new username + pincode;
  everyone has to re-add the bridge).
- Enabling, disabling and exposure changes apply at runtime: unpublish / republish without restarting the service.
- HAP itself is end-to-end encrypted (SRP pairing + ChaCha20-Poly1305); the setup code is the only secret, so it is
  shown to admins only and every pair/unpair is written to the audit log.
- Anyone in the Apple Home gets full lighting control, comparable to a `user` account; the panel says so.
- Home shows "Uncertified accessory" when adding the bridge, as with Homebridge; document it.
- Demo mode never starts HomeKit.

New admin API (OpenAPI document and its sync test updated):

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v1/admin/homekit` | settings, status, setup code, setup URI |
| PUT | `/api/v1/admin/homekit` | enable/disable, name, port, exposure |
| POST | `/api/v1/admin/homekit/reset` | reset pairing |

## Deployment

- Dependency: `hap-nodejs` 0.14.x, the current stable release that Homebridge 1.x uses (pure JavaScript; no native build on the Pi). In `NOTICE`. (Done.)
- mDNS: Raspberry Pi OS already runs `avahi-daemon` (the installer sets it up), so use HAP-NodeJS's **avahi
  advertiser** over D-Bus, with `@homebridge/ciao` as fallback when avahi is not available. Same choice Homebridge
  recommends on Linux. The systemd unit already allows `AF_UNIX` and `AF_INET/6`; verify that the `casambi` user may
  publish via avahi's D-Bus API.
- HAP persistence (pairings, accessory ids) goes to `/var/lib/casambi-bt-webui/homekit/`, which is already writable
  under `ProtectSystem=strict`.
- Backups: include the HomeKit settings and HAP pairing files, so a restore on a new Pi keeps the Home setup. Until
  then a restored Pi notices that HAP's keys are missing and becomes a new bridge in Home (phase 1 does this).
- Firewall/router note in the README: the HAP port must be reachable on the LAN, and iPhone and Pi must be on the
  same network (or a Home hub must be present for remote access).
- The system check (`server/diagnostics.ts`) gets a HomeKit line: published, port listening, mDNS advertiser.

## Testing

- Unit tests for `mapping.ts` (scales, Kelvin/mireds edges, colour round-trips, name sanitising) and `writeQueue.ts`
  (merging, bucketing, plan with groups and network, last-level restore) using a fake service, like the existing
  bridge tests.
- `HomeKitBridge` tests with a fake `CasambiService`: accessories created/removed/renamed, "No Response" when
  offline, updates pushed, switch presses mapped to events, exposure toggles.
- API tests for the new endpoints (admin only, pincode never in the audit log).
- Manual end-to-end: `CASAMBI_MOCK_MODE=true pnpm dev`, pair an iPhone, check lamps, scenes, Siri, and that changes
  in the web UI appear in Home and vice versa; then on the Pi with real hardware (`scripts/verify-live-bridge.mjs`).

## Phases

1. **Foundation (done):** `hap-nodejs`, settings, `HomeKitBridge` publishing an empty bridge, pairing, admin panel with
   QR code, enable/disable, reset, audit. An iPhone can add the bridge.
2. **Lamps, groups and rooms (done):** on/off and brightness for lamps, Casambi groups and local rooms, read from the
   cache, state pushes, "No Response" when offline, write coalescing with `planTargets`, and a cached accessory list so
   Apple Home keeps its setup across restarts and disconnects (`server/homekit/mapping.ts`, `lights.ts`).
3. **Colour:** colour temperature and hue/saturation where capabilities allow.
4. **Scenes:** momentary scene switches (network and local scenes); exposure toggles.
5. **Operations:** backup/restore of pairing, system check line, Dutch strings for new texts.
6. **Wall switches:** Casambi buttons as programmable switches for Home automations.
7. **Optional Homebridge plugin:** for existing Homebridge users, reusing `mapping.ts` over REST + SSE with an API key.

## Decisions

- Groups and rooms are exposed by default.
- Casambi's `on` restores the last brightness; no bookkeeping on our side.
- Lamp control comes before wall switches.

## Open questions

- Which button numbers and triggers do real Casambi switches report reliably enough for HomeKit automations? (Phase 6.)
- May the `casambi` service user publish through avahi's D-Bus API on Raspberry Pi OS? Verify on the Pi; HAP-NodeJS
  falls back to bonjour-hap if not.
