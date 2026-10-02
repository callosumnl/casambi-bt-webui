# REST API Reference

All application endpoints begin with `/api/v1`. Send either an `Authorization: Bearer <JWT>` header obtained from `/auth/login`, or an `X-API-Key: <key>` header. API keys are scoped to the `admin` or `user` role chosen when the key is created. Authentication failures return `401`; an authenticated principal without the `admin` role receives `403` for administrative routes.

> The service exposes only operations supplied by the connected fixture’s reported Casambi capabilities. Call `GET /devices` before sending a dimming, colour, temperature, vertical, white, slider, or CIE XY command.

| Method | Path | Role | Purpose |
| --- | --- | --- | --- |
| `GET` | `/health` | Public | Reports service status and whether first-run bootstrap is needed. |
| `POST` | `/auth/bootstrap` | Public, first run only | Creates the first `admin` and returns a JWT. |
| `POST` | `/auth/login` | Public | Returns an eight-hour JWT for a local `admin` or `user`. |
| `GET` | `/auth/me` | user | Returns the resolved principal. |
| `GET` | `/events` | user | Streams `bridge`, `connection.status`, `unit.state`, `network.snapshot`, `switch`, `switch_rule.executed`, `switch_rule.failed`, `schedule.executed`, and `schedule.failed` SSE events. |
| `GET` | `/network` | user | Returns the last known connection status, units, groups, scenes, rooms, and local metadata immediately; `?fresh=1` waits for a new bridge snapshot instead. `/devices`, `/groups`, `/scenes`, and `/sensors` also serve the last known state. The `connection` field is `{ phase }`, where `phase` is `idle`, `connecting` (with `attempt`), `connected`, `retrying` (with `attempt`, `nextRetryAt`, and `lastError`), or `failed` (with `lastError`); `connection.status` events carry the same object whenever it changes. |
| `GET` | `/devices`, `/groups`, `/scenes`, `/sensors`, `/rooms` | user | Returns the named entity collection. |
| `POST` | `/control` | user | Runs any supported control request. |
| `POST` | `/devices/:id/on`, `/devices/:id/off` | user | Convenience lamp on/off controls. |
| `POST` | `/scenes/:id/activate` | user | Activates an upstream Casambi scene. |
| `POST` | `/rooms/:id/apply-default` | user | Applies the room’s saved default brightness; an optional `fadeDurationMs` from 0 to 60,000 enables a smooth transition. |
| `GET`, `POST` | `/schedules` | user | Lists permitted schedules, including `nextRunAt`, or creates a timer owned by the caller. |
| `PATCH`, `DELETE` | `/schedules/:id` | owner or admin | Edits or deletes a timer. |
| `GET`, `PUT` | `/admin/config` | admin | Reads safe settings or saves encrypted bridge configuration, including bounded polling enablement and interval. |
| `GET` | `/admin/discovery` | admin | Scans nearby Casambi networks. |
| `POST` | `/admin/connect`, `/admin/disconnect` | admin | Connects or disconnects the live Bluetooth bridge. |
| `POST`, `DELETE` | `/admin/rooms`, `/admin/rooms/:id` | admin | Creates or removes local room metadata, including a 0–100 default brightness percentage. |
| `PUT` | `/admin/rooms/:id/default-brightness` | admin | Updates a room’s 0–100 default brightness percentage. |
| `PUT` | `/admin/devices/:id/metadata` | admin | Sets a local custom name and room assignment. |
| `GET`, `POST`, `PATCH` | `/admin/users`, `/admin/users/:id` | admin | Manages local `admin` and `user` accounts. |
| `GET`, `POST`, `DELETE` | `/admin/api-keys`, `/admin/api-keys/:id` | admin | Lists metadata, generates once-visible API keys, and revokes keys. |
| `GET` | `/admin/audit` | admin | Reads recent non-secret audit entries. |
| `GET` | `/admin/worker` | admin | Returns the Python worker's state from its supervisor: `running`, `pid`, `busy` (`command`, `forMs`), `lastAnswerAt`, and `restarts`. Never waits on the worker, so it answers even when the worker is stuck. |
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

The `/control` body has `targetType`, optional `targetId`, `operation`, optional `value`, and optional `fadeDurationMs`. `targetType` is one of `unit`, `group`, `room`, `scene`, or `network`. The operations are `on`, `off`, `set_level`, `set_temperature`, `set_color`, `set_white`, `set_vertical`, `set_slider`, `set_xy`, and `activate_scene`. Scene targets accept only `activate_scene`. For `on`, `off`, and `set_level`, `fadeDurationMs` may be an integer from 0 to 60,000. The response is the updated network snapshot; send `Prefer: return=minimal` to receive `204 No Content` instead when the same snapshot already arrives over the event stream. While an absolute-value command (`set_level`, `set_temperature`, `set_color`, `set_white`, `set_vertical`, `set_slider`, `set_xy`) for a target is still waiting in the bridge queue, a newer one for the same target and operation replaces it, and both requests receive the result of the newer value. Room targets whose lamps exactly match a Casambi group are sent as one group command.

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

For API integrations, the schedule payload continues to accept a five-field `cronExpression` and an IANA time zone. Include `fadeDurationMs` inside an `on`, `off`, or `set_level` command to request a transition of up to 60 seconds. The upstream method is `setLevel(target, level)` and does not expose a native transition argument, so this application performs ordered 200 ms level steps; an interrupted service restart stops an in-progress fade. [2]

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

Browser clients can use `EventSource` with the login token in a same-origin query parameter. Non-browser integrations should prefer polling `/network` or use a reverse proxy that supports passing authorization headers to an SSE endpoint.

```javascript
const source = new EventSource(`/api/v1/events?access_token=${encodeURIComponent(jwt)}`);
source.addEventListener("unit.state", event => console.log(JSON.parse(event.data)));
```

## Physical switches

Every button message a Casambi switch reports is published as a `switch` SSE event and kept in `GET /admin/switch-activity`: `{ unitId, button, trigger, raw, at }`. Upstream reports each action twice. The type `0x08` message's press/release label comes from one bit of a sequence counter and is unreliable, so only the type `0x10` message's state becomes a `trigger`: `tap` (released after a short press), `hold` (about 0.7 s into a long press), or `release_after_hold`. Other messages have `trigger: null` and are raw activity for diagnosis only; `raw` keeps `messageType`, `event`, `action`, `flags`, and hex `extraData`. Presses with a trigger are audited as `switch.pressed`.

A switch rule runs a lighting command when a matching button is used:

```json
{ "name": "Eiland toggle", "unitId": 2, "button": 4, "trigger": "tap", "command": { "targetType": "unit", "targetId": 1, "operation": "toggle" }, "enabled": true }
```

`command` is any `/control` request, or `toggle` for a `unit`, `group`, `room`, or `network`, which turns the target off when any of its lamps is on and on otherwise. Presses are handled one at a time through the same control path as the API, so consecutive toggles alternate. Each run is audited as `switch_rule.executed` or `switch_rule.failed`. Rules run in addition to whatever the button already does in the Casambi app.

## Sensor telemetry and polling

`GET /sensors` flattens the `state.sensors` entries reported by fixtures into records containing `deviceId`, `deviceName`, `label`, `value`, and `unit`. The bridge preserves live upstream SENSOR bitfields from subsequent state packets before the upstream parser discards them. Because fixture-specific engineering-unit conversion is not documented by the upstream library, extracted values are labelled `raw`. A `null` value means no post-connection state packet has yet carried that sensor control; it never represents a fabricated measurement. [2]

An `admin` may set `pollingEnabled` and `pollingIntervalSeconds` in `PUT /admin/config`. The interval must be from 5 to 3,600 seconds. Polling requests a fresh snapshot through the same serialized bridge channel used by control commands; failures are recorded in the audit log and retry with capped exponential backoff.

## References

[1]: https://github.com/mourner/suncalc "SunCalc local solar-time calculation library"
[2]: https://github.com/lkempf/casambi-bt "lkempf/casambi-bt upstream library"
