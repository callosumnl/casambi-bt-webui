# Development guide

How the code is organised, the commands to build and test it, and the conventions to follow when changing it.

## What this is

A self-hosted Casambi lighting-control appliance for a Raspberry Pi: one Node.js (Express) process serves a React UI, a versioned REST API (`/api/v1`), an SSE event stream, and a cron/solar scheduler, and supervises a long-lived Python subprocess that talks Bluetooth via the unofficial, alpha-quality [`casambi-bt`](https://github.com/lkempf/casambi-bt) library. Real hardware is never touched by tests. See `docs/ARCHITECTURE.md` and `docs/API.md` for full design and endpoint reference.

## Commands

```bash
pnpm install
pnpm check                      # tsc --noEmit (test files are excluded from tsconfig)
pnpm test                       # vitest run (server/**/*.test.ts + client/**/*.test.ts)
pnpm vitest run server/store.test.ts          # single file
pnpm vitest run -t "name of test"             # single test by name
pnpm build                      # vite build (client) + esbuild server -> dist/
CASAMBI_MOCK_MODE=true pnpm dev # tsx watch server/_core/index.ts with Vite middleware
./scripts/validate-package.sh   # build + twine check + smoke test the Python companion wheel (what CI runs)
CASAMBI_JWT='…' node scripts/verify-live-bridge.mjs  # hardware smoke test, only on a connected Pi
```

- Node 22+ is required: the store uses the built-in `node:sqlite` (`DatabaseSync`), loaded via `createRequire` and marked `ssr.external` in `vitest.config.ts`.
- `server/casambi/casambi_worker.test.ts` spawns `python3` on the real worker script, so a Python 3.11+ interpreter must be on PATH for the full suite.
- `pnpm build` and `validate-package.sh` both write to `dist/`, and the Python script deletes it first.

## Architecture

**Request path:** `server/_core/index.ts` wires everything together: `LocalStore` (SQLite) → `EventHub` (SSE) → `JsonLineCasambiBridge` (Python supervisor) → `CasambiService` → `DurableScheduler`, then mounts `createCasambiApi` from `server/api.ts` at `/api/v1`. The scheduler runs commands through `casambi.control()`, the same validated path the REST API uses.

**Manus template scaffolding vs. the real app:** The repo started from a Manus web template. `server/_core/*` (OAuth, tRPC, `systemRouter`, LLM/map/storage/voice helpers), `server/routers.ts`, `server/db.ts`, `drizzle/` (MySQL), `client/src/lib/trpc.ts`, `client/src/_core/`, `ComponentShowcase.tsx`, and `AIChatBox.tsx` are template leftovers, and most of them aren't used by the appliance. The real application is:
- `server/api.ts`: REST routes with zod validation. The `route()` wrapper maps `ZodError` to 422, and maps errors by message text ("does not exist" to 404, "required"/"invalid" to 422). Keep error messages consistent with that mapping.
- `server/store.ts`: the single SQLite repository (users, API keys, encrypted Casambi config, rooms, unit metadata, schedules, away-date sets, audit log). There are no migrations framework or Drizzle here. The schema lives in this file.
- `server/auth.ts`: JWT (`CASAMBI_JWT_SECRET`) and `X-API-Key` auth, with `admin`/`user` roles.
- `server/scheduler.ts` + `server/solar.ts`: five-field cron evaluated each minute with a `lastRunKey` idempotency guard. There are also sunrise/sunset schedules with offsets (suncalc, which needs admin-configured lat/long), per-timer holiday dates, and reusable away-date sets.
- `client/src/lib/localApi.ts`: the typed fetch client and session storage (localStorage). The client does **not** use tRPC.

**Python bridge protocol** (`server/casambi/bridge.ts` ↔ `casambi_worker.py`): newline-delimited JSON over stdio. Each command (`discover`, `configure`, `connect`, `disconnect`, `snapshot`, `control`, `ping`) carries a UUID `id` and gets exactly one `{id, ok, result|error}` response. Unsolicited `{event: …}` envelopes carry state, switch, and connection changes. Node serializes commands (one at a time, which keeps BLE writes ordered), puts a timeout on each one, and restarts the child with capped exponential backoff. `CasambiService.runControl` sends absolute-value operations through `executeLatest`, which replaces an unsent value only when it's the last command in the queue, so newer slider values supersede older ones without reordering anything. Shared types and `controlRequestSchema` are in `server/casambi/types.ts`. `CasambiService` overlays local custom names and rooms on bridge snapshots, because upstream has no room model.

**Mock mode:** `bridge.ts` passes `--mock` to the worker only when `CASAMBI_MOCK_MODE=true` is set explicitly; `NODE_ENV` never enables it. The app is only ever deployed to a real Pi (there is no test/acceptance environment), so a missing flag must mean real Bluetooth. Tests don't need the flag: they inject a fake bridge or `createChild`.

**Scenes:** besides scenes stored in the Casambi network (`targetType: "scene"`), users save scenes on the Pi: the captured level and colour temperature of each lamp in a group, room, or the whole network (`light_scenes` table, `/local-scenes` routes). `CasambiService.control` handles `targetType: "local_scene"` itself (it never reaches the worker), so timers and switch rules can activate saved scenes, with an optional fade. Lamps are units with a controllable capability (`isLampUnit` / client `isLamp`); switches and sensors are excluded from lamp lists and target pickers.

**Units/conventions:**
- The UI shows brightness as 0–100%, while Casambi commands use 0–255. Convert with `client/src/lib/brightness.ts`.
- The friendly timer form (`friendlySchedule.ts`) is translated into cron for the backend. The REST API still accepts raw `cronExpression`.
- Casambi secrets are encrypted at rest with `CASAMBI_ENCRYPTION_KEY`. Changing that key makes the stored secrets unreadable.
- Path aliases are `@/` → `client/src`, `@shared/` → `shared`.

## Deployment notes

- `deploy/install.sh` installs to `/opt/casambi-bt-webui`, which is read-only to the service. Run it as the checkout's owner (it uses `sudo` itself); it builds `.venv`, `node_modules`, and `dist/` as that owner even when started with `sudo`, because root-owned build files break later updates (`EACCES` in `node_modules/.vite-temp`). It runs as the `casambi` user (member of the `bluetooth` group) and keeps runtime data in `/var/lib/casambi-bt-webui/` (`CASAMBI_DB_PATH`, and `CASAMBI_CACHE_PATH` for the upstream `casambi-bt-store` cache). Env template: `deploy/environment.template`.
- The unit and env templates are duplicated under `src/casambi_bt_webui/templates/` for the Python companion package (`casambi-bt-webui doctor|systemd-template|write-templates`). Keep both copies identical; `scripts/validate-package.sh` (CI) fails on any drift.
- Upstream quirk: the bridge keeps the `BLEDevice` from its immediate discovery scan, because otherwise upstream re-looks it up in the BlueZ cache, where the entry may have expired.
