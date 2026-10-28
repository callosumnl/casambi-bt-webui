# REST API Reference

All application endpoints begin with `/api/v1`. The complete, machine-readable description is the OpenAPI 3.1 document at **`GET /api/v1/openapi.json`** (public; import it into Postman, Insomnia, or Swagger UI). Admins can browse it in the web UI under **API**, with request schemas, examples, and `curl` commands. A test keeps it in sync with the routes. Send either an `Authorization: Bearer <JWT>` header obtained from `/auth/login`, or an `X-API-Key: <key>` header. API keys are scoped to the `admin` or `user` role chosen when the key is created. Authentication failures return `401`; an authenticated principal without the `admin` role receives `403` for administrative routes.

Errors return `{ "error": { "code", "message", "fields"? }, "requestId" }`: `401` unauthenticated, `403` wrong role, `404` unknown id, `409` name already in use or item still in use, `422` invalid request (including values out of range, e.g. levels outside 0-255), `429` more than 240 requests per minute from one client, `500` unexpected failure.

> The service exposes only operations supplied by the connected fixture’s reported Casambi capabilities. Call `GET /devices` before sending a dimming, colour, temperature, vertical, white, slider, or CIE XY command.

| Method | Path | Role | Purpose |
| --- | --- | --- | --- |
| `GET` | `/health` | Public | Reports service status and whether first-run bootstrap is needed. |
| `GET` | `/openapi.json` | Public | The OpenAPI 3.1 description of this API. |
| `POST` | `/auth/bootstrap` | Public, first run only | Creates the first `admin` and returns a JWT. Requires `setupCode`, the one-time code printed by `deploy/install.sh`. |
| `POST` | `/auth/login` | Public | Returns an eight-hour JWT for a local `admin` or `user`. At most 10 failed attempts per 5 minutes per address (then 429). |
| `GET` | `/auth/me` | user | Returns the resolved principal. |
| `POST` | `/auth/event-ticket` | user (signed in) | Returns a 60-second ticket that only opens `/events?ticket=…`. |
| `GET` | `/events` | user | Streams `bridge`, `connection.status`, `unit.state`, `network.snapshot`, `switch`, `switch_rule.executed`, `switch_rule.failed`, `local_scenes.changed`, `schedule.executed`, `schedule.failed`, and `schedule.skipped_holiday` SSE events. |
| `GET` | `/network` | user | Returns the last known connection status, units, groups, scenes, rooms, and local metadata immediately; `?fresh=1` waits for a new bridge snapshot instead. `/devices`, `/groups`, `/scenes`, and `/sensors` also serve the last known state. The `connection` field is `{ phase }`, where `phase` is `idle`, `connecting` (with `attempt`), `connected`, `retrying` (with `attempt`, `nextRetryAt`, and `lastError`), or `failed` (with `lastError`); `connection.status` events carry the same object whenever it changes. |
| `GET` | `/devices`, `/groups`, `/scenes`, `/sensors`, `/rooms` | user | Returns the named entity collection. |
| `POST` | `/control` | user | Runs any supported control request. |
| `POST` | `/devices/:id/on`, `/devices/:id/off` | user | Convenience lamp on/off controls. |
| `POST` | `/scenes/:id/activate` | user | Activates an upstream Casambi scene. |
| `GET`, `POST` | `/local-scenes` | user | Lists saved scenes, or saves the current setting of a scope as a new scene: `{ name, scope: { type: "group" \| "room" \| "network", id } }` (`id` is `null` for `network`). |
| `POST` | `/local-scenes/:id/capture` | user | Updates a saved scene to the current setting of its scope. |
| `PATCH`, `DELETE` | `/local-scenes/:id` | user | Renames (`{ name }`) or deletes a saved scene; deleting one that timers or switch rules use returns `409`. |
| `POST` | `/local-scenes/:id/apply` | user | Applies a saved scene, optionally with `{ fadeDurationMs }` (0–60,000). |
| `POST` | `/rooms/:id/apply-default` | user | Applies the room’s saved default brightness; an optional `fadeDurationMs` from 0 to 60,000 enables a smooth transition. |
| `GET`, `POST` | `/schedules` | user | Lists permitted schedules, including `nextRunAt`, or creates a timer owned by the caller. |
| `PATCH`, `DELETE` | `/schedules/:id` | owner or admin | Edits (only the fields sent) or deletes a timer. |
| `GET` | `/away-date-sets` | user | Lists shared away-date sets for the timer form. |
| `GET`, `PUT` | `/admin/config` | admin | Reads safe settings or saves encrypted bridge configuration, including bounded polling enablement and interval. |
| `GET` | `/admin/diagnostics` | admin | The system check: Bluetooth service and adapter, Wi-Fi interference (2.4 GHz Wi-Fi shares the Pi's radio with Bluetooth), the Casambi connection and last connect, Bluetooth command times, clock, location, storage, temperature, and power, each `ok`/`warn`/`fail`/`info` with advice; plus versions. Checks that cannot be read report `info`. |
| `GET` | `/admin/diagnostics/bundle` | admin | The same as a downloadable JSON file, with the facts behind the checks, the worker state, the safe configuration, and the last 300 audit entries. No passwords or keys. |
| `POST` | `/admin/backup` | admin | Body `{ passphrase }` (at least 10 characters). Returns one file with all data (accounts, API keys, Casambi settings including the network password, rooms, names, timers, scenes, switch rules, away dates, audit log), encrypted with the passphrase (scrypt, AES-256-GCM) so it can be restored on another Pi. |
| `POST` | `/admin/restore` | admin | Body: the backup file as `application/octet-stream`; header `X-Backup-Passphrase`. Replaces all data, re-encrypts the Casambi secrets with this Pi's key, ends every session, reloads timers, and reconnects. |
| `GET` | `/admin/update` | admin | Update status: whether updates from the app are set up, the running version, open requests, and what `deploy/update.sh` last reported (`state`, current and latest commit, new changes, log tail after an update). |
| `POST` | `/admin/update/check`, `/admin/update/apply` | admin | Ask the Pi to check for, or install, an update in the background (`202`); poll `GET /admin/update`. Installing restarts the service; a failed update restores the previous version. |
| `GET` | `/admin/notifications` | admin | The 50 newest notifications (`kind`, `severity`, `title`, `message`, `createdAt`, `readAt`), the unread count, and whether a webhook is set (with its host only; the URL itself is never returned). Problems reported: the Bluetooth connection down for 5 minutes (and its recovery), timers that fail or cannot run, and failed updates. |
| `POST` | `/admin/notifications/read` | admin | Marks all notifications read (`204`). |
| `PUT` | `/admin/notifications/webhook` | admin | Body `{ url }`: an `http(s)` URL that receives every new notification as a JSON POST (`text`, `title`, `message`, `severity`, `kind`, `at`, `host`; redirects are not followed), or `""`/`null` to turn it off. |
| `POST` | `/admin/notifications/test` | admin | Sends a test notification to the webhook and returns `{ ok, status, message }`. |
| `GET` | `/admin/server-settings` | admin | The port and reverse-proxy setting the service runs with, whether changing them from the app is set up, whether a change is being applied, what `deploy/apply-settings.sh` last reported (`state`: `applying`, `applied`, `rolled_back`, `failed`; `message`), and the read-only settings from `/etc/casambi-bt-webui.env`. |
| `PUT` | `/admin/server-settings` | admin | Body `{ port, trustProxy }` (port 1024–65535). Asks the Pi to write them to the env file and restart (`202`). If the app does not answer on the new port within a minute, the previous settings are restored. After a port change, open the app on the new port and sign in again there. |
| `GET` | `/admin/discovery` | admin | Scans nearby Casambi networks for 5 s: `[{ address, rssi }]`, strongest signal first (`rssi` in dBm, `null` when it could not be measured). |
| `POST` | `/admin/connect`, `/admin/disconnect` | admin | Connects or disconnects the live Bluetooth bridge. |
| `POST` | `/admin/rooms` | admin | Creates a local room with a default brightness. |
| `PATCH`, `DELETE` | `/admin/rooms/:id` | admin | Renames (`{ name }`) or deletes a room. Deleting a room that timers, switch rules, or scenes use returns `409` naming them. |
| `PUT` | `/admin/rooms/:id/default-brightness` | admin | Updates a room’s 0–100 default brightness percentage. |
| `POST` | `/admin/rooms/from-groups` | admin | Creates a room for each Casambi group (reusing rooms with the same name) and places the group's units in it; units already in a room stay. Returns `{ created, assigned, rooms }`. |
| `PUT` | `/admin/devices/room` | admin | Moves many units (`unitIds`, up to 1,000) into one room, or out of every room with `roomId: null`, keeping their custom names. |
| `PUT` | `/admin/devices/:id/metadata` | admin | Sets a unit's custom name and/or room; fields left out keep their value, and an empty name restores the Casambi name. |
| `GET`, `POST` | `/admin/away-date-sets` | admin | Lists or creates shared away-date sets. |
| `PATCH`, `DELETE` | `/admin/away-date-sets/:id` | admin | Updates a set (name, dates) or deletes it, detaching it from its timers. |
| `GET`, `POST` | `/admin/users` | admin | Lists or creates local accounts. |
| `PATCH`, `DELETE` | `/admin/users/:id` | admin | Changes the role and/or sets a new password (`{ role?, password? }`), or deletes the account; its timers move to the deleting admin. You cannot delete your own account or the last admin. |
| `GET`, `POST`, `DELETE` | `/admin/api-keys`, `/admin/api-keys/:id` | admin | Lists metadata, generates once-visible API keys (optionally valid for `expiresInDays`), and revokes keys. |
| `GET` | `/admin/audit` | admin | Recent audit entries, newest first: `?limit=` (1-500, default 100) and `?action=` (prefix, e.g. `bridge.`). The log keeps the latest 20,000 everyday entries (light commands, switch presses, executed timers, bridge diagnostics) and, separately, the latest 20,000 of everything else, so heavy use cannot push sign-in and administration events out. |
| `GET` | `/admin/worker` | admin | Returns the Python worker's state from its supervisor: `running`, `pid`, `busy` (`command`, `forMs`), `lastAnswerAt`, `restarts`, and `bluetooth`: how long casambi-bt took to send recent light commands over Bluetooth (`commands` since start, `recent` in the summary (up to 200), `lastMs`, `medianMs`, `p95Ms`, `maxMs`), or `null` before the first one. Never waits on the worker, so it answers even when the worker is stuck. |
| `POST` | `/admin/worker/restart` | admin | Restarts the worker (SIGTERM, then SIGKILL after 8 s), or starts it if it is not running; returns `202` with the worker state. A connected network reconnects automatically about 15 s later. |
| `GET` | `/admin/switch-activity` | admin | Returns the 50 most recent switch messages, newest first. |
| `GET`, `POST` | `/admin/switch-rules` | admin | Lists or creates physical switch rules. |
| `PATCH`, `DELETE` | `/admin/switch-rules/:id` | admin | Updates or deletes a switch rule. |

## Authentication examples

```bash
curl -sS -X POST http://raspberrypi.local:3000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"operator","password":"your-password"}'
```

```bash
curl -sS http://raspberrypi.local:3000/api/v1/network \
  -H 'Authorization: Bearer YOUR_JWT'
```

## Generic control request

The `/control` body has `targetType`, optional `targetId`, `operation`, optional `value`, and optional `fadeDurationMs`. `targetType` is one of `unit`, `group`, `room`, `scene` (stored in the Casambi network), `local_scene` (saved on the Pi), or `network`. The operations are `on`, `off`, `set_level`, `set_temperature`, `set_color`, `set_white`, `set_vertical`, `set_slider`, `set_xy`, and `activate_scene`. Scene and saved-scene targets accept only `activate_scene`; a saved scene also accepts `fadeDurationMs`. For `on`, `off`, and `set_level`, `fadeDurationMs` may be an integer from 0 to 60,000. The response is the updated network snapshot; send `Prefer: return=minimal` to receive `204 No Content` instead when the same snapshot already arrives over the event stream. While an absolute-value command (`set_level`, `set_temperature`, `set_color`, `set_white`, `set_vertical`, `set_slider`, `set_xy`) for a target is still waiting in the bridge queue, a newer one for the same target and operation replaces it, and both requests receive the result of the newer value. Commands that cover several lamps are planned as few Bluetooth commands as possible: a room, a saved scene, or a fade step whose lamps are every lamp in the network becomes one network command; otherwise every Casambi group that lies entirely inside the set is sent as one group command, and only the remaining lamps get one command each. Lamps in a saved scene or fade are planned together when they share a level (and, for scenes, a colour temperature).

```bash
# Set lamp 4 to 65% in upstream 0–255 brightness units with a 1.2-second fade.
curl -sS -X POST http://raspberrypi.local:3000/api/v1/control \
  -H 'Authorization: Bearer YOUR_JWT' -H 'Content-Type: application/json' \
  -d '{"targetType":"unit","targetId":4,"operation":"set_level","value":166,"fadeDurationMs":1200}'

# Activate scene 3.
curl -sS -X POST http://raspberrypi.local:3000/api/v1/scenes/3/activate \
  -H 'X-API-Key: YOUR_USER_OR_ADMIN_KEY'
```

## Timers and scheduling

In the WebUI, create a timer by choosing a **time**, explicit repeat days, time zone, lighting target, action, brightness, and optional fade. Choose **Every day**, **Weekdays**, **Weekends**, or **Pick days** and select the exact day buttons. You can instead choose **sunrise** or **sunset** and a whole-minute offset from 180 minutes before to 180 minutes after the event. The interface translates everyday choices into the durable scheduler format automatically, so users do not need to write cron syntax. The Raspberry Pi service reloads persisted timers at startup and runs them through the same validated control pathway used by the API.

Every timer can include up to 120 explicit `holidayDates` in `YYYY-MM-DD` format. These are personal away dates, not a downloaded regional holiday calendar. A date is compared in the timer’s IANA time zone; a matching run is skipped, a `schedule.skipped_holiday` event is recorded, and `nextRunAt` advances to the following eligible trigger. This makes it safe to keep routine lighting timers enabled while you are away.

An `admin` can also create a reusable away-date set in **Admin → Away-date sets** and apply it to multiple selected timers. Each set has a name and one or more ISO dates. An assigned timer combines its own `holidayDates` with the set’s dates; when the set is edited, its linked timers calculate their next run from the new shared dates automatically. `GET /away-date-sets` is available to authenticated users for timer selection, while creation, modification, and deletion use the admin endpoints below.

```bash
# Create a shared away period as an administrator.
curl -sS -X POST http://raspberrypi.local:3000/api/v1/admin/away-date-sets \
  -H 'Authorization: Bearer ADMIN_JWT' -H 'Content-Type: application/json' \
  -d '{"name":"Summer break","dates":["2026-08-17","2026-08-18","2026-08-19"]}'

# Apply the returned set ID to an existing timer.
curl -sS -X PATCH http://raspberrypi.local:3000/api/v1/schedules/12 \
  -H 'Authorization: Bearer YOUR_JWT' -H 'Content-Type: application/json' \
  -d '{"awayDateSetId":4}'
```

Before using a solar timer, an `admin` saves the lighting site’s latitude and longitude in **Admin → Casambi Link**. Solar times are calculated locally with the bundled SunCalc algorithm; no web service or live location request is used. Each `GET /schedules` result includes `nextRunAt`, an ISO 8601 timestamp calculated from the active configuration. Solar schedules re-evaluate after every run so seasonal daylight changes are reflected automatically. [1]

For API integrations, the schedule payload continues to accept a five-field `cronExpression` and an IANA time zone. Include `fadeDurationMs` inside an `on`, `off`, or `set_level` command to request a transition of up to 60 seconds. The upstream method is `setLevel(target, level)` and does not expose a native transition argument, so this application performs ordered level steps: each pass sets the level for the time that has passed, at most 60 passes at least 200 ms apart. A pass over many lamps with different levels takes longer, so such a fade takes fewer, coarser passes rather than running far past its duration. An interrupted service restart stops an in-progress fade. [2]

```bash
curl -sS -X POST http://raspberrypi.local:3000/api/v1/schedules \
  -H 'Authorization: Bearer YOUR_JWT' -H 'Content-Type: application/json' \
  -d '{
    "name":"Weekday close",
    "cronExpression":"30 22 * * 1-5",
    "timezone":"Europe/Amsterdam",
    "holidayDates":["2026-12-25","2026-12-26"],
    "enabled":true,
    "command":{"targetType":"network","operation":"off","fadeDurationMs":5000}
  }'
```

### Solar timer request

Solar schedules use `solar` in place of a meaningful fixed `cronExpression`; API clients may omit `cronExpression` when `solar` is provided. A compatibility placeholder is stored internally for existing schedule records.

```bash
# Fade a room on 15 minutes before the locally configured sunset.
curl -sS -X POST http://raspberrypi.local:3000/api/v1/schedules \
  -H 'Authorization: Bearer YOUR_JWT' -H 'Content-Type: application/json' \
  -d '{
    "name":"Welcome home",
    "timezone":"Europe/Amsterdam",
    "solar":{"event":"sunset","offsetMinutes":-15},
    "enabled":true,
    "command":{"targetType":"room","targetId":4,"operation":"on","fadeDurationMs":1200}
  }'
```

## Room default presets

An administrator can store a preferred brightness for a local room and any authenticated user can apply it. The saved percentage is converted to the upstream 0–255 level only at the bridge boundary.

```bash
# Set the Gallery room's default to 65%.
curl -sS -X PUT http://raspberrypi.local:3000/api/v1/admin/rooms/4/default-brightness \
  -H 'Authorization: Bearer ADMIN_JWT' -H 'Content-Type: application/json' \
  -d '{"defaultBrightnessPercent":65}'

# Apply the stored Gallery default over 800 ms.
curl -sS -X POST http://raspberrypi.local:3000/api/v1/rooms/4/apply-default \
  -H 'Authorization: Bearer YOUR_JWT' -H 'Content-Type: application/json' \
  -d '{"fadeDurationMs":800}'
```

## Live events

`EventSource` cannot send headers, so browser clients first get a one-minute ticket with `POST /auth/event-ticket` and pass it as `?ticket=`; the ticket only opens the stream, so it is harmless in logs once it expires. Fetch a new one whenever the stream has to be reopened. Other clients send the `Authorization: Bearer` or `X-API-Key` header to `/events` directly.

```javascript
const { ticket } = await (await fetch("/api/v1/auth/event-ticket", { method: "POST", headers: { Authorization: `Bearer ${jwt}` } })).json();
const source = new EventSource(`/api/v1/events?ticket=${encodeURIComponent(ticket)}`);
source.addEventListener("unit.state", event => console.log(JSON.parse(event.data)));
```

## Physical switches

Every button message a Casambi switch reports is published as a `switch` SSE event and kept in `GET /admin/switch-activity`: `{ unitId, button, trigger, raw, at }`. Upstream reports each action twice. The type `0x08` message's press/release label comes from one bit of a sequence counter and is unreliable, so only the type `0x10` message's state becomes a `trigger`: `tap` (released after a short press), `hold` (about 0.7 s into a long press), or `release_after_hold`. Other messages have `trigger: null` and are raw activity for diagnosis only; `raw` keeps `messageType`, `event`, `action`, `flags`, and hex `extraData`. Presses with a trigger are audited as `switch.pressed`.

A switch rule runs a lighting command when a matching button is used:

```json
{ "name": "Eiland toggle", "unitId": 2, "button": 4, "trigger": "tap", "command": { "targetType": "unit", "targetId": 1, "operation": "toggle" }, "enabled": true }
```

`command` is any `/control` request, or `toggle` for a `unit`, `group`, `room`, or `network`, which turns the target off when any of its lamps is on and on otherwise. Presses are handled one at a time through the same control path as the API, so consecutive toggles alternate. A press that arrives while a rule is still fading stops that fade at its next step, and at most 10 presses wait behind a running rule; further ones are ignored and audited. Each run is audited as `switch_rule.executed` or `switch_rule.failed`. Rules run in addition to whatever the button already does in the Casambi app.

## Sensor telemetry and polling

`GET /sensors` flattens the `state.sensors` entries reported by fixtures into records containing `deviceId`, `deviceName`, `label`, `value`, and `unit`. The bridge preserves live upstream SENSOR bitfields from subsequent state packets before the upstream parser discards them. Because fixture-specific engineering-unit conversion is not documented by the upstream library, extracted values are labelled `raw`. A `null` value means no post-connection state packet has yet carried that sensor control; it never represents a fabricated measurement. [2]

An `admin` may set `pollingEnabled` and `pollingIntervalSeconds` in `PUT /admin/config`. The interval must be from 5 to 3,600 seconds. Polling requests a fresh snapshot through the same serialized bridge channel used by control commands; failures are recorded in the audit log and retry with capped exponential backoff.

### Bluetooth write mode (experimental)

casambi-bt sends every command as a Bluetooth write *with* response: each command waits for the connected Casambi unit to acknowledge it (about 110 ms per command was measured on a Raspberry Pi). Setting `fastWrites: true` in `PUT /admin/config` sends commands as writes *without* response instead; it is applied to the open connection without reconnecting. The worker only switches when the Casambi characteristic supports unacknowledged writes and one fits a whole command; otherwise it keeps the default and says why in the audit log (`bridge.diagnostic`). The key exchange always uses acknowledged writes. Compare the two modes with `GET /admin/worker`, whose `bluetooth` summary restarts when the mode changes, and turn the setting off if lamps miss commands.

Every connect also writes one `bridge.diagnostic` entry that splits its duration into the Bluetooth scan, the Casambi cloud and cache step, the Bluetooth connection, the key exchange, and authentication. The Bluetooth connection part lists bleak_retry_connector's attempts with BlueZ's reason for each failed one, and whether a connection BlueZ still had open was closed first. A failed connect writes the same breakdown, up to the step that failed, and its error names the reason the Bluetooth connection could not be opened.

## References

[1]: https://github.com/mourner/suncalc "SunCalc local solar-time calculation library"
[2]: https://github.com/lkempf/casambi-bt "lkempf/casambi-bt upstream library"
