# Casambi BT WebUI Architecture

## Deployment model

The production target is a **single Raspberry Pi**. The Node.js process serves the React application, the JWT-authenticated REST API, the Server-Sent Events stream, and the scheduler. It starts one long-lived Python subprocess that imports `casambi-bt`; this subprocess owns Bluetooth interaction and communicates with Node.js over newline-delimited JSON on standard input/output. SQLite stores local users, API keys, Casambi connection settings, room metadata, schedules, and an audit log. Credentials are encrypted at rest using an application secret supplied through the service environment.

| Layer | Responsibility | Availability boundary |
| --- | --- | --- |
| React client | Cyberpunk Admin Panel and User Dashboard; receives live state events. | Browser session |
| Node.js application | Authentication, authorization, REST, validation, audit, scheduling, SSE fan-out, and Python supervision. | systemd service |
| Python bridge | Discovery, connection ownership, Casambi unit/group/scene operations, and state event serialization. | Child process |
| SQLite | Durable local configuration and operational metadata. | Raspberry Pi filesystem |
| Casambi BLE network | Physical lighting controls and asynchronous device status events. | Bluetooth adapter |

## Supported bridge contract

The upstream `casambi-bt` project describes itself as a Bluetooth-based, alpha-quality interface that currently exposes **units, groups, scenes, unit capabilities, switch events, and unit state-change callbacks**. It does not model rooms as a first-class entity. The WebUI therefore stores custom room assignments locally and makes its feature visibility capability-aware. Every unit response includes the supported controls discovered from the upstream `UnitType` model, rather than promising a control that a fixture does not support. [1]

The bridge accepts `discover`, `configure`, `connect`, `disconnect`, `snapshot`, `control`, and `ping` commands. `control` supports the upstream operations `on`, `off`, `set_level`, `set_temperature`, `set_color`, `set_white`, `set_vertical`, `set_slider`, `set_xy`, and `activate_scene`. Each request has a UUID command identifier. The Python process writes a single response for each command and separately emits `event` envelopes for state updates, switch actions, and connection changes.

## Reliability strategy

Node serializes bridge commands to preserve Bluetooth request ordering, applies bounded command timeouts, tracks pending commands by ID, and broadcasts structured failure information without losing the service process. If the child process exits unexpectedly, the supervisor rejects pending requests, publishes an unavailable status, and restarts it with capped exponential backoff. Because the worker handles one command at a time, a command that outlives its timeout means the worker is stuck, and every later command would time out while the process stays alive; the supervisor therefore restarts a worker that misses a timeout (SIGTERM so it can release the BLE link, SIGKILL after 8 s), after which the normal restart and automatic reconnect take over. The Python worker reports a normalized `{ code, message }` error for every failed command (including malformed input) rather than leaking tracebacks over the protocol; before a (re)connect it bounds closing the previous connection (8 s) and the Bluetooth scan (20 s), so a BlueZ call that never returns cannot block it. When the startup connect fails, or an established connection drops or the worker restarts, the Node service retries the connect automatically after 15 s, 30 s, 60 s, and so on, capped at 5 minutes, until it succeeds. A manual Connect or Disconnect cancels pending retries, a manual Disconnect is never undone automatically, and a rejected network password stops the retries until an administrator intervenes. Read endpoints such as `GET /network` serve the last known state, so they never wait behind a connect in the serialized bridge queue. On SIGTERM, SIGINT, or when Node closes its stdin, the Python worker disconnects the upstream connection (bounded to 5 s) before exiting: BlueZ owns a BLE link rather than the process that opened it, so an unclean exit would leave the Pi holding the link and make the next connect attempts fail.

The bridge has an explicit `CASAMBI_MOCK_MODE` development mode. It uses deterministic in-memory units only when this flag is enabled; production mode never substitutes invented devices. This allows interface development without a Bluetooth controller (`CASAMBI_MOCK_MODE=true pnpm dev`), while preserving a clear boundary between simulated and live data. Automated tests do not use it; they inject a fake bridge or worker process.

## Authorization model

Local accounts have exactly the requested role labels: **admin** and **user**. A password login produces a short-lived signed JWT. The REST API accepts that token in an `Authorization: Bearer` header. API keys are generated once, retained only as SHA-256 digests, scoped to `admin` or `user`, independently revocable, and authenticated through an `X-API-Key` header. The role is re-read from the database on every request, so a role change takes effect immediately. Browsers open the SSE stream with the same JWT as the `access_token` query parameter, because `EventSource` cannot set headers. An API key is not an account: admin keys file new timers under the first admin, and user keys cannot own timers. `X-Forwarded-For` is trusted only with `CASAMBI_TRUST_PROXY=true` (behind a reverse proxy), so clients cannot evade the rate limit.

| Principal | Allowed actions |
| --- | --- |
| `admin` | Casambi configuration, discovery, connection control, metadata and room management, users, API keys, all schedules, and all lighting control. |
| `user` | Read live network data, control lamps/groups/rooms/scenes, and create or manage permitted timers. |
| API key | Operations permitted by its stored `admin` or `user` scope. |

## Scheduling model

On the Raspberry Pi, the service owns a durable SQLite-backed scheduler. It evaluates validated five-field cron expressions in the timer's IANA time zone with an idempotency guard (`last_run_key`) so a rule cannot execute twice in the same minute. Sunrise and sunset timers (with an offset of up to ±180 minutes) are computed locally from the administrator-configured location and re-armed after each run. Per-timer away dates and shared away-date sets skip runs on those calendar days. One invalid timer is audited and skipped instead of stopping the others from loading. Startup immediately reloads enabled rules. Each execution uses the same validated control pathway as the REST API and writes an audit event. The implementation intentionally avoids relying on browser timers or external cloud scheduling.

## API and live-event design

REST endpoints are grouped under `/api/v1`. Every endpoint returns JSON errors with a stable `code`, human-readable `message`, and `requestId`. The server publishes `bridge`, `connection.status`, `unit.state`, `network.snapshot`, `switch`, `switch_rule.executed`, `switch_rule.failed`, `local_scenes.changed`, `schedule.executed`, `schedule.failed`, and `schedule.skipped_holiday` events to `/api/v1/events`. Clients request a current snapshot first, then reconcile real-time events by entity ID and timestamp.

The machine-readable endpoint catalog is the OpenAPI 3.1 document served at `/api/v1/openapi.json` (request schemas are generated from the same zod schemas the routes validate with, and a test keeps routes and document in sync); [`docs/API.md`](API.md) has the narrative reference and examples. `GET /health` reports only `status`, `bootstrapRequired`, and the number of live event clients.

## References

[1]: https://github.com/lkempf/casambi-bt "lkempf/casambi-bt"
