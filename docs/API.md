# REST API Reference

All application endpoints begin with `/api/v1`. Send either an `Authorization: Bearer <JWT>` header obtained from `/auth/login`, or an `X-API-Key: <key>` header. API keys are scoped to the `admin` or `user` role chosen when the key is created. Authentication failures return `401`; an authenticated principal without the `admin` role receives `403` for administrative routes.

> The service exposes only operations supplied by the connected fixture’s reported Casambi capabilities. Call `GET /devices` before sending a dimming, colour, temperature, vertical, white, slider, or CIE XY command.

| Method | Path | Role | Purpose |
| --- | --- | --- | --- |
| `GET` | `/health` | Public | Reports service status and whether first-run bootstrap is needed. |
| `POST` | `/auth/bootstrap` | Public, first run only | Creates the first `admin` and returns a JWT. |
| `POST` | `/auth/login` | Public | Returns an eight-hour JWT for a local `admin` or `user`. |
| `GET` | `/auth/me` | user | Returns the resolved principal. |
| `GET` | `/events` | user | Streams `bridge`, `unit.state`, `network.snapshot`, `schedule.executed`, and `schedule.failed` SSE events. |
| `GET` | `/network` | user | Returns connection status, units, groups, scenes, rooms, and local metadata. |
| `GET` | `/devices`, `/groups`, `/scenes`, `/sensors`, `/rooms` | user | Returns the named entity collection. |
| `POST` | `/control` | user | Runs any supported control request. |
| `POST` | `/devices/:id/on`, `/devices/:id/off` | user | Convenience lamp on/off controls. |
| `POST` | `/scenes/:id/activate` | user | Activates an upstream Casambi scene. |
| `POST` | `/rooms/:id/apply-default` | user | Applies the room’s saved default brightness; an optional `fadeDurationMs` from 0 to 60,000 enables a smooth transition. |
| `GET`, `POST` | `/schedules` | user | Lists permitted schedules or creates a timer owned by the caller. |
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

The `/control` body has `targetType`, optional `targetId`, `operation`, optional `value`, and optional `fadeDurationMs`. `targetType` is one of `unit`, `group`, `room`, `scene`, or `network`. The operations are `on`, `off`, `set_level`, `set_temperature`, `set_color`, `set_white`, `set_vertical`, `set_slider`, `set_xy`, and `activate_scene`. Scene targets accept only `activate_scene`. For `on`, `off`, and `set_level`, `fadeDurationMs` may be an integer from 0 to 60,000.

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

In the WebUI, create a timer by choosing a **time**, repeat pattern, optional days, time zone, lighting target, action, brightness, and optional fade. The interface translates these everyday choices into the durable scheduler format automatically, so users do not need to write cron syntax. The Raspberry Pi service reloads persisted timers at startup and runs them through the same validated control pathway used by the API.

For API integrations, the schedule payload continues to accept a five-field `cronExpression` and an IANA time zone. Include `fadeDurationMs` inside an `on`, `off`, or `set_level` command to request a transition of up to 60 seconds. The upstream method is `setLevel(target, level)` and does not expose a native transition argument, so this application performs ordered 200 ms level steps; an interrupted service restart stops an in-progress fade. [1]

```bash
curl -sS -X POST http://raspberrypi.local:3000/api/v1/schedules \
  -H 'Authorization: Bearer YOUR_JWT' -H 'Content-Type: application/json' \
  -d '{
    "name":"Weekday close",
    "cronExpression":"30 22 * * 1-5",
    "timezone":"Europe/Amsterdam",
    "enabled":true,
    "command":{"targetType":"network","operation":"off","fadeDurationMs":5000}
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

## Sensor telemetry and polling

`GET /sensors` flattens the `state.sensors` entries reported by fixtures into records containing `deviceId`, `deviceName`, `label`, `value`, and `unit`. The bridge preserves live upstream SENSOR bitfields from subsequent state packets before the upstream parser discards them. Because fixture-specific engineering-unit conversion is not documented by the upstream library, extracted values are labelled `raw`. A `null` value means no post-connection state packet has yet carried that sensor control; it never represents a fabricated measurement. [1]

An `admin` may set `pollingEnabled` and `pollingIntervalSeconds` in `PUT /admin/config`. The interval must be from 5 to 3,600 seconds. Polling requests a fresh snapshot through the same serialized bridge channel used by control commands; failures are recorded in the audit log and retry with capped exponential backoff.

## References

[1]: https://github.com/lkempf/casambi-bt "lkempf/casambi-bt upstream library"
