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

Node serializes bridge commands to preserve Bluetooth request ordering, applies bounded command timeouts, tracks pending commands by ID, and broadcasts structured failure information without losing the service process. If the child process exits unexpectedly, the supervisor rejects pending requests, publishes an unavailable status, and restarts it with capped exponential backoff. The Python worker performs one reconnect attempt through the upstream library and reports a normalized error object rather than leaking tracebacks over the protocol.

The bridge has an explicit `CASAMBI_MOCK_MODE` development mode. It uses deterministic in-memory units only when this flag is enabled; production mode never substitutes invented devices. This allows tests and interface development without a Bluetooth controller, while preserving a clear boundary between simulated and live data.

## Authorization model

Local accounts have exactly the requested role labels: **admin** and **user**. A password login produces a short-lived signed JWT. The REST API accepts that token in an `Authorization: Bearer` header. API keys are generated once, retained only as SHA-256 digests, scoped to `admin` or `user`, independently revocable, and authenticated through an `X-API-Key` header. Browser-side access uses the same JWT and receives an SSE token via the authorization header where supported or through a same-origin query parameter with a short expiry.

| Principal | Allowed actions |
| --- | --- |
| `admin` | Casambi configuration, discovery, connection control, metadata and room management, users, API keys, all schedules, and all lighting control. |
| `user` | Read live network data, control lamps/groups/rooms/scenes, and create or manage permitted timers. |
| API key | Operations permitted by its stored `admin` or `user` scope. |

## Scheduling model

On the Raspberry Pi, the service owns a durable SQLite-backed scheduler. It evaluates validated five-field cron expressions once per minute with an idempotency guard (`last_run_key`) so a rule cannot execute twice in the same minute. Startup immediately reloads enabled rules. Each execution uses the same validated control pathway as the REST API and writes an audit event. The implementation intentionally avoids relying on browser timers or external cloud scheduling.

The web-project scaffold contains a managed scheduler for its hosted preview, but it is not the production mechanism because the explicit deployment target is a Raspberry Pi and the Bluetooth bridge requires a local operating-system runtime.

## API and live-event design

REST endpoints are grouped under `/api/v1`. Every protected endpoint returns JSON errors with a stable `code`, human-readable `message`, and request `id`. The server publishes `bridge`, `unit.state`, `switch`, `schedule.executed`, and `schedule.failed` events to `/api/v1/events`. Clients request a current snapshot first, then reconcile real-time events by entity ID and timestamp.

The complete endpoint catalog and request examples are maintained in [`docs/API.md`](API.md). A health route reports storage and bridge state without returning any secret material.

## References

[1]: https://github.com/lkempf/casambi-bt "lkempf/casambi-bt"
