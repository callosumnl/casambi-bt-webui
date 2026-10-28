import express, { NextFunction, Router, Request, Response } from "express";
import { writeFileSync, rmSync } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";
import { openBackup, sealBackup } from "./backup";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { authenticate, authenticateEventTicket, issueEventTicket, issueToken, Principal, requireAuth } from "./auth";
import { CasambiService } from "./casambi/service";
import { controlRequestSchema } from "./casambi/types";
import { EventHub } from "./events";
import { AwayDateSet, LocalStore, Role, ScheduleRecord } from "./store";
import { DurableScheduler, nextRunAt, validateCron, validateTimezone } from "./scheduler";
import { SolarSchedule, validateSolarLocation, validateSolarSchedule } from "./solar";
import { switchRulePatchSchema, switchRuleSchema } from "./switchRules";
import { openApiDocument } from "./openapi";
import { SetupCode } from "./setupCode";
import { Updater, UpdateMode } from "./updates";
import { ServerSettingsHelper } from "./serverSettings";
import { AppFacts, appVersion, evaluateChecks, gatherSystemFacts, Probes, systemProbes } from "./diagnostics";
import { apiKeyCreateSchema, awayDateSetSchema, backupCreateSchema, bootstrapSchema, serverSettingsSchema, configSchema, credentialsSchema, deviceMetadataSchema, deviceRoomsSchema, fadeBodySchema, roomCreateSchema, roomDefaultBrightnessSchema, sceneCreateSchema, sceneRenameSchema, scheduleSchema, schedulePatchSchema, userCreateSchema, userUpdateSchema, roomRenameSchema, auditQuerySchema } from "./apiSchemas";

/**
 * `setupCode`, when set, must accompany the first-admin request, so a stranger on the network cannot claim a fresh install.
 * `probes` read the system for the diagnostics, `updater` requests updates, and `serverSettings` requests env-file
 * changes; tests replace all three.
 */
type Dependencies = { store: LocalStore; service: CasambiService; events: EventHub; scheduler: DurableScheduler; setupCode?: SetupCode; probes?: Probes; updater?: Updater; serverSettings?: ServerSettingsHelper };
type AsyncRoute = (request: Request, response: Response) => Promise<void>;

/** Wraps async routes in a stable JSON error response. */
function route(handler: AsyncRoute) {
  return (request: Request, response: Response) => void handler(request, response).catch(error => {
    if (error instanceof z.ZodError) {
      response.status(422).json({ error: { code: "VALIDATION_ERROR", message: "Request validation failed.", fields: error.flatten() }, requestId: response.locals.requestId });
      return;
    }
    const { status, code, message } = classifyError(error);
    response.status(status).json({ error: { code, message }, requestId: response.locals.requestId });
  });
}

/**
 * Maps a thrown error to an HTTP status. Domain errors are plain Errors whose wording says what went wrong:
 * "does not exist" → 404; a rule the request broke ("required", "invalid", "must …", "cannot …") → 422.
 * SQLite constraint errors become 409/422 with a readable message instead of leaking SQL text.
 */
export function classifyError(error: unknown): { status: number; code: string; message: string } {
  const message = error instanceof Error ? error.message : "Unexpected server error.";
  if (message.includes("UNIQUE constraint failed")) return { status: 409, code: "CONFLICT", message: "That name is already in use." };
  if (message.includes("FOREIGN KEY constraint failed")) return { status: 422, code: "VALIDATION_ERROR", message: "A referenced item does not exist." };
  // Plain Errors are written for people (including the bridge's connection errors). Anything else — a TypeError, a
  // SQLite or system error with a `code` — is an internal detail: log it here and keep it out of the response.
  if (!(error instanceof Error) || error.constructor !== Error || "code" in error) {
    console.error(error);
    return { status: 500, code: "INTERNAL_ERROR", message: "Unexpected server error." };
  }
  if (message.includes("does not exist")) return { status: 404, code: "NOT_FOUND", message };
  if (message.includes("is used by")) return { status: 409, code: "IN_USE", message };
  if (message.includes("is busy")) return { status: 503, code: "BUSY", message };
  if (/\b(required|invalid|must|cannot|has no assigned lamps)\b/i.test(message)) return { status: 422, code: "VALIDATION_ERROR", message };
  return { status: 500, code: "INTERNAL_ERROR", message };
}

/** Refuses to delete a room or saved scene that timers, switch rules, or scenes still point at. */
/** Names only what the caller may see: admins get every item, other users their own timers and a count of the rest. */
function assertUnused(store: LocalStore, target: { type: "room" | "local_scene"; id: number }, label: string, actor: Principal): void {
  const usage = store.usageOf(target);
  if (!usage.length) return;
  const visible = actor.role === "admin" ? usage : usage.filter(item => actor.kind === "user" && item.ownerUserId === actor.id);
  const hidden = usage.length - visible.length;
  const names = [...visible.map(item => item.label), ...(hidden ? [`${hidden} ${hidden === 1 ? "item" : "items"} managed by other accounts`] : [])];
  throw new Error(`This ${label} is used by ${names.join(", ")}. Change or delete those first.`);
}

function parsed<T>(schema: z.ZodType<T>, input: unknown): T { return schema.parse(input); }
function principal(response: Response): Principal { return response.locals.principal as Principal; }
function assertScheduleAccess(schedule: { ownerUserId: number }, actor: Principal): void { if (actor.role !== "admin" && !(actor.kind === "user" && schedule.ownerUserId === actor.id)) throw new Error("Schedule does not exist."); }
/** The account that owns a new timer. An API key is not an account: admin keys file timers under the first admin. */
function scheduleOwnerId(actor: Principal, store: LocalStore): number {
  if (actor.kind === "user") return actor.id;
  const admin = actor.role === "admin" ? store.listUsers().find(user => user.role === "admin") : undefined;
  if (!admin) throw new Error("A user-role API key cannot create timers; use an admin API key or sign in.");
  return admin.id;
}
function serializeSchedule(schedule: ScheduleRecord, store: LocalStore) { let nextRun: Date | null = null; try { nextRun = nextRunAt(schedule, store.getCasambiConfig()); } catch { /* Invalid/missing solar configuration remains visible without claiming a run time. */ } return { ...schedule, nextRunAt: nextRun?.toISOString() ?? null }; }
function validateSolarForStore(solar: SolarSchedule | null | undefined, store: LocalStore): void { if (!solar) return; validateSolarSchedule(solar); const config = store.getCasambiConfig(); validateSolarLocation({ latitude: config.solarLatitude ?? undefined, longitude: config.solarLongitude ?? undefined }); }
function normalizeHolidayDates(dates: string[]): string[] { return Array.from(new Set(dates.map(date => { const parsed = new Date(`${date}T00:00:00.000Z`); if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) throw new Error("Holiday dates must be valid ISO calendar dates."); return date; }))).sort(); }
function assertAwayDateSet(id: number | null | undefined, store: LocalStore): AwayDateSet | null { if (id == null) return null; const set = store.getAwayDateSet(id); if (!set) throw new Error("Away-date set does not exist."); return set; }

/** Registers the complete versioned Raspberry Pi REST API. */
export function createCasambiApi({ store, service, events, scheduler, setupCode, probes = systemProbes, updater = new Updater(store.dataDirectory), serverSettings = new ServerSettingsHelper(store.dataDirectory) }: Dependencies): Router {
  const api = Router();
  api.use(rateLimit({ windowMs: 60_000, limit: 240, standardHeaders: "draft-8", legacyHeaders: false }));
  // Password guessing gets its own, much tighter budget; successful sign-ins do not count against it.
  const signInLimit = rateLimit({ windowMs: 5 * 60_000, limit: 10, skipSuccessfulRequests: true, standardHeaders: "draft-8", legacyHeaders: false,
    message: { error: { code: "RATE_LIMITED", message: "Too many failed sign-in attempts. Try again in a few minutes." } } });
  api.use((_request, response, next) => { response.locals.requestId = crypto.randomUUID(); next(); });

  // Public, so API tools can load it; it describes the routes, never any data.
  api.get("/openapi.json", (_request, response) => response.json(openApiDocument()));
  api.get("/health", (_request, response) => response.json({ status: "ok", bootstrapRequired: store.needsBootstrap(), eventClients: events.clientCount, build: events.build }));
  api.post("/auth/bootstrap", signInLimit, route(async (request, response) => {
    if (!store.needsBootstrap()) { response.status(409).json({ error: { code: "BOOTSTRAP_COMPLETE", message: "An administrator already exists." } }); return; }
    const input = parsed(bootstrapSchema, request.body);
    if (setupCode && !setupCode.matches(input.setupCode ?? "")) { response.status(403).json({ error: { code: "INVALID_SETUP_CODE", message: "The setup code is not correct. deploy/install.sh prints it at the end of the installation." } }); return; }
    const user = store.createUser(input.username, input.password, "admin"); store.audit(user.username, "auth.bootstrap", {}); setupCode?.consume();
    response.status(201).json({ token: await issueToken(user, store), user });
  }));
  api.post("/auth/login", signInLimit, route(async (request, response) => {
    const input = parsed(credentialsSchema, request.body); const user = await store.verifyUser(input.username, input.password);
    if (!user) { store.audit(input.username, "auth.login_failed", { ip: request.ip }); response.status(401).json({ error: { code: "INVALID_CREDENTIALS", message: "Username or password is invalid." } }); return; }
    store.audit(user.username, "auth.login", {}); response.json({ token: await issueToken(user, store), user });
  }));

  api.get("/auth/me", requireAuth(store), (request, response) => response.json({ principal: principal(response) }));
  api.post("/auth/event-ticket", requireAuth(store), route(async (_request, response) => {
    const actor = principal(response);
    if (actor.kind !== "user") throw new Error("An API key cannot get an event ticket; send it in the X-API-Key header to /events instead.");
    response.json({ ticket: await issueEventTicket(actor, store), expiresInSeconds: 60 });
  }));
  api.get("/events", route(async (request, response) => {
    // Browsers pass a one-minute ticket in the URL; other clients use the Authorization or X-API-Key header.
    const ticket = typeof request.query.ticket === "string" ? request.query.ticket : null;
    const actor = ticket ? await authenticateEventTicket(ticket, store) : await authenticate(request, store);
    if (!actor) { response.status(401).json({ error: { code: "UNAUTHORIZED", message: "A valid event token is required." } }); return; }
    const remove = events.add(response, actor); request.on("close", remove);
  }));

  // Read routes serve the cached state so they never wait behind a slow Bluetooth connect; `/network?fresh=1` asks the bridge.
  api.get("/network", requireAuth(store), route(async (request, response) => { response.json(request.query.fresh === "1" ? await service.snapshot() : service.cachedSnapshot()); }));
  api.get("/devices", requireAuth(store), route(async (_request, response) => { response.json(service.cachedSnapshot().units); }));
  api.get("/groups", requireAuth(store), route(async (_request, response) => { response.json(service.cachedSnapshot().groups); }));
  api.get("/scenes", requireAuth(store), route(async (_request, response) => { response.json(service.cachedSnapshot().scenes); }));
  api.get("/sensors", requireAuth(store), route(async (_request, response) => { response.json(service.cachedSnapshot().units.flatMap(unit => unit.state.sensors.map(sensor => ({ deviceId: unit.id, deviceName: unit.name, ...sensor })))); }));
  api.get("/rooms", requireAuth(store), (request, response) => response.json(store.listRooms()));
  api.post("/rooms/:id/apply-default", requireAuth(store), route(async (request, response) => {
    const input = parsed(fadeBodySchema, request.body || {});
    response.json(await service.applyRoomPreset(Number(request.params.id), principal(response).name, input.fadeDurationMs || 0));
  }));
  // `Prefer: return=minimal` skips the snapshot body for clients that already receive it over the SSE stream.
  api.post("/control", requireAuth(store), route(async (request, response) => { const command = parsed(controlRequestSchema, request.body); const snapshot = await service.control(command, principal(response).name); if (/\breturn=minimal\b/.test(request.get("Prefer") || "")) { response.status(204).set("Preference-Applied", "return=minimal").end(); return; } response.json(snapshot); }));
  // Scenes saved on the Pi: the captured setting of a group, room, or all lamps. Any signed-in user may manage them, like timers.
  api.get("/local-scenes", requireAuth(store), (_request, response) => response.json(store.listLightScenes()));
  api.post("/local-scenes", requireAuth(store), route(async (request, response) => { const input = parsed(sceneCreateSchema, request.body); const scene = service.captureLightScene(input.name, input.scope); store.audit(principal(response).name, "scene.created", { sceneId: scene.id }); events.publish("local_scenes.changed", {}); response.status(201).json(scene); }));
  api.post("/local-scenes/:id/capture", requireAuth(store), route(async (request, response) => { const scene = service.recaptureLightScene(Number(request.params.id)); store.audit(principal(response).name, "scene.updated", { sceneId: scene.id }); events.publish("local_scenes.changed", {}); response.json(scene); }));
  api.patch("/local-scenes/:id", requireAuth(store), route(async (request, response) => { const input = parsed(sceneRenameSchema, request.body); const scene = store.updateLightScene(Number(request.params.id), { name: input.name }); events.publish("local_scenes.changed", {}); response.json(scene); }));
  api.delete("/local-scenes/:id", requireAuth(store), route(async (request, response) => { assertUnused(store, { type: "local_scene", id: Number(request.params.id) }, "scene", principal(response)); store.deleteLightScene(Number(request.params.id)); store.audit(principal(response).name, "scene.deleted", { sceneId: Number(request.params.id) }); events.publish("local_scenes.changed", {}); response.status(204).send(); }));
  api.post("/local-scenes/:id/apply", requireAuth(store), route(async (request, response) => { const input = parsed(fadeBodySchema, request.body ?? {}); response.json(await service.control({ targetType: "local_scene", targetId: Number(request.params.id), operation: "activate_scene", ...(input.fadeDurationMs ? { fadeDurationMs: input.fadeDurationMs } : {}) }, principal(response).name)); }));
  api.post("/devices/:id/on", requireAuth(store), route(async (request, response) => { response.json(await service.control({ targetType: "unit", targetId: Number(request.params.id), operation: "on" }, principal(response).name)); }));
  api.post("/devices/:id/off", requireAuth(store), route(async (request, response) => { response.json(await service.control({ targetType: "unit", targetId: Number(request.params.id), operation: "off" }, principal(response).name)); }));
  api.post("/scenes/:id/activate", requireAuth(store), route(async (request, response) => { response.json(await service.control({ targetType: "scene", targetId: Number(request.params.id), operation: "activate_scene" }, principal(response).name)); }));

  api.get("/schedules", requireAuth(store), (_request, response) => { const actor = principal(response); response.json(store.listSchedules().filter(schedule => actor.role === "admin" || (actor.kind === "user" && schedule.ownerUserId === actor.id)).map(schedule => serializeSchedule(schedule, store))); });
  api.post("/schedules", requireAuth(store), route(async (request, response) => { const input = parsed(scheduleSchema, request.body); const cronExpression = input.cronExpression ?? "0 0 * * *"; if (!input.solar) validateCron(cronExpression, input.timezone); validateTimezone(input.timezone); validateSolarForStore(input.solar, store); const awayDateSet = assertAwayDateSet(input.awayDateSetId, store); const schedule = store.createSchedule({ name: input.name, cronExpression, timezone: input.timezone, command: input.command, solar: input.solar ?? null, holidayDates: normalizeHolidayDates(input.holidayDates), awayDateSetId: awayDateSet?.id ?? null, awayDateSet, enabled: input.enabled, ownerUserId: scheduleOwnerId(principal(response), store) }); scheduler.reload(); store.audit(principal(response).name, "schedule.created", { scheduleId: schedule.id, solar: schedule.solar, holidayDates: schedule.holidayDates, awayDateSetId: schedule.awayDateSetId }); response.status(201).json(serializeSchedule(schedule, store)); }));
  api.patch("/schedules/:id", requireAuth(store), route(async (request, response) => { const current = store.getSchedule(Number(request.params.id)); if (!current) throw new Error("Schedule does not exist."); assertScheduleAccess(current, principal(response)); const input = parsed(schedulePatchSchema, request.body); const solar = input.solar === undefined ? current.solar : input.solar; const cronExpression = input.cronExpression ?? current.cronExpression; const timezone = input.timezone ?? current.timezone; const holidayDates = input.holidayDates === undefined ? current.holidayDates : normalizeHolidayDates(input.holidayDates); const awayDateSetId = input.awayDateSetId === undefined ? current.awayDateSetId : assertAwayDateSet(input.awayDateSetId, store)?.id ?? null; if (!solar) validateCron(cronExpression, timezone); validateTimezone(timezone); validateSolarForStore(solar, store); const schedule = store.updateSchedule(current.id, { ...input, cronExpression, timezone, solar: solar ?? null, holidayDates, awayDateSetId }); scheduler.reload(); response.json(serializeSchedule(schedule, store)); }));
  api.delete("/schedules/:id", requireAuth(store), route(async (request, response) => { const current = store.getSchedule(Number(request.params.id)); if (!current) throw new Error("Schedule does not exist."); assertScheduleAccess(current, principal(response)); store.deleteSchedule(current.id); scheduler.reload(); response.status(204).send(); }));
  api.get("/away-date-sets", requireAuth(store), (_request, response) => response.json(store.listAwayDateSets()));

  api.get("/admin/config", requireAuth(store, "admin"), (_request, response) => response.json(store.getSafeCasambiConfig()));
  api.put("/admin/config", requireAuth(store, "admin"), route(async (request, response) => { const input = parsed(configSchema, request.body); if ("solarLatitude" in input || "solarLongitude" in input) { const current = store.getCasambiConfig(); const latitude = input.solarLatitude === undefined ? current.solarLatitude : input.solarLatitude; const longitude = input.solarLongitude === undefined ? current.solarLongitude : input.solarLongitude; if (latitude !== null || longitude !== null) validateSolarLocation({ latitude: latitude ?? undefined, longitude: longitude ?? undefined }); } service.saveConfiguration(input); scheduler.reload(); store.audit(principal(response).name, "config.updated", {}); response.json(store.getSafeCasambiConfig()); }));
  api.get("/admin/discovery", requireAuth(store, "admin"), route(async (_request, response) => { response.json(await service.discover()); }));
  /** Everything the system check looks at; the same data goes into the downloadable diagnostics file. */
  const diagnose = async () => {
    const config = store.getCasambiConfig();
    const worker = service.workerState();
    const connection = service.cachedSnapshot().connection;
    const lastConnect = store.recentAudit(100, "bridge.diagnostic").find(entry => /^(Connected in|Connect failed)/.test(String(entry.detail.detail ?? "")));
    const app: AppFacts = {
      connection: { phase: connection.phase, ...("lastError" in connection && connection.lastError ? { lastError: connection.lastError } : {}) },
      lastConnect: lastConnect ? { detail: String(lastConnect.detail.detail), at: lastConnect.createdAt } : null,
      bluetoothTiming: worker.bluetooth,
      workerRestarts: worker.restarts,
      configured: { networkAddress: Boolean(config.networkAddress), networkPassword: Boolean(config.networkPassword), location: config.solarLatitude !== null && config.solarLongitude !== null },
      solarTimers: store.listSchedules().filter(schedule => schedule.solar).length,
      port: process.env.PORT || "3000",
    };
    const [system, version] = await Promise.all([
      gatherSystemFacts(probes, { adapter: config.btAdapter || "hci0", dataDirectory: store.dataDirectory, pythonCommand: process.env.CASAMBI_PYTHON_COMMAND || "python3" }),
      appVersion(probes),
    ]);
    return { generatedAt: new Date().toISOString(), checks: evaluateChecks(system, app), versions: { app: version.version, commit: version.commit, node: process.version, ...(system.libraries ?? {}) }, system, app, worker };
  };
  api.get("/admin/diagnostics", requireAuth(store, "admin"), route(async (_request, response) => {
    const { generatedAt, checks, versions } = await diagnose();
    response.json({ generatedAt, checks, versions });
  }));
  // One file to hand to whoever helps: the checks with their facts, versions, and recent audit entries. No secrets:
  // the configuration is the same safe view as /admin/config, and audit entries never contain passwords or keys.
  api.get("/admin/diagnostics/bundle", requireAuth(store, "admin"), route(async (_request, response) => {
    const report = await diagnose();
    const bundle = { ...report, configuration: store.getSafeCasambiConfig(), environment: { nodeEnv: process.env.NODE_ENV ?? null, mockMode: process.env.CASAMBI_MOCK_MODE === "true", trustProxy: process.env.CASAMBI_TRUST_PROXY === "true", port: process.env.PORT ?? "3000" }, audit: store.recentAudit(300) };
    response.setHeader("Content-Disposition", `attachment; filename="casambi-diagnostics-${report.generatedAt.slice(0, 19).replace(/:/g, "-")}.json"`);
    response.json(bundle);
  }));
  api.get("/admin/server-settings", requireAuth(store, "admin"), (_request, response) => response.json(serverSettings.current()));
  api.put("/admin/server-settings", requireAuth(store, "admin"), route(async (request, response) => {
    const input = parsed(serverSettingsSchema, request.body);
    serverSettings.request(input);
    store.audit(principal(response).name, "server_settings.requested", input);
    response.status(202).json({ requested: input });
  }));
  api.get("/admin/update", requireAuth(store, "admin"), route(async (_request, response) => {
    response.json({ supported: updater.supported, running: await appVersion(probes), pending: { check: updater.pending("check"), apply: updater.pending("apply") }, status: updater.status() });
  }));
  for (const mode of ["check", "apply"] as UpdateMode[]) {
    api.post(`/admin/update/${mode}`, requireAuth(store, "admin"), route(async (_request, response) => {
      updater.request(mode);
      store.audit(principal(response).name, `update.${mode}_requested`, {});
      response.status(202).json({ requested: mode });
    }));
  }
  api.post("/admin/backup", requireAuth(store, "admin"), route(async (request, response) => {
    const { passphrase } = parsed(backupCreateSchema, request.body);
    const config = store.getCasambiConfig();
    const file = await sealBackup({ database: store.exportDatabase(), secrets: { networkPassword: config.networkPassword, apiKey: config.apiKey }, appVersion: (await appVersion(probes)).version }, passphrase);
    store.audit(principal(response).name, "backup.created", { bytes: file.length });
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Content-Disposition", `attachment; filename="casambi-backup-${new Date().toISOString().slice(0, 10)}.json"`);
    response.send(file);
  }));
  // The file comes as raw bytes (application/octet-stream), past the 1 MB JSON limit; the passphrase in a header.
  api.post("/admin/restore", requireAuth(store, "admin"), express.raw({ type: "application/octet-stream", limit: "64mb" }), route(async (request, response) => {
    const passphrase = request.header("x-backup-passphrase") ?? "";
    if (!Buffer.isBuffer(request.body) || request.body.length === 0) throw new Error("A backup file is required (Content-Type: application/octet-stream).");
    const backup = await openBackup(request.body, passphrase);
    const file = join(store.dataDirectory, `restore-${randomBytes(6).toString("hex")}.db`);
    try {
      writeFileSync(file, backup.database, { mode: 0o600 });
      store.restoreDatabase(file, backup.secrets);
    } finally { for (const suffix of ["", "-wal", "-shm"]) rmSync(`${file}${suffix}`, { force: true }); }
    store.audit(principal(response).name, "backup.restored", { createdAt: backup.createdAt, appVersion: backup.appVersion });
    // Accounts, timers, and settings changed underneath everything that was running.
    events.disconnectAll();
    scheduler.reload();
    const config = store.getCasambiConfig();
    if (config.networkAddress && config.networkPassword) void service.connect().catch(() => { /* connect() reports its own failure. */ });
    response.json({ restored: { createdAt: backup.createdAt, users: store.listUsers().length, rooms: store.listRooms().length, timers: store.listSchedules().length }, signInAgain: true });
  }));
  api.get("/admin/worker", requireAuth(store, "admin"), (_request, response) => response.json(service.workerState()));
  api.post("/admin/worker/restart", requireAuth(store, "admin"), route(async (_request, response) => { response.status(202).json(service.restartWorker(principal(response).name)); }));
  api.post("/admin/connect", requireAuth(store, "admin"), route(async (_request, response) => { response.json(await service.connect()); }));
  api.post("/admin/disconnect", requireAuth(store, "admin"), route(async (_request, response) => { response.json(await service.disconnect()); }));
  // Setup shortcut: a room per Casambi group, so rooms match groups and room commands become single group commands.
  api.post("/admin/rooms/from-groups", requireAuth(store, "admin"), route(async (_request, response) => {
    const groups = service.cachedSnapshot().groups;
    if (groups.length === 0) throw new Error("No Casambi groups found; a connected network with groups is required.");
    const rooms = new Map(store.listRooms().map(room => [room.name.toLowerCase(), room]));
    const placed = new Set(store.getUnitMetadata().filter(metadata => metadata.roomId !== null).map(metadata => metadata.unitId));
    let created = 0; let assigned = 0;
    for (const group of groups) {
      const name = (group.name.trim() || `Group ${group.id}`).slice(0, 96);
      let room = rooms.get(name.toLowerCase());
      if (!room) { room = store.createRoom(name); rooms.set(name.toLowerCase(), room); created += 1; }
      // A unit in several groups goes to the first room; units already in a room stay where they are.
      const free = group.unitIds.filter(unitId => !placed.has(unitId));
      if (free.length) { store.setUnitRooms(free, room.id); free.forEach(unitId => placed.add(unitId)); assigned += free.length; }
    }
    store.audit(principal(response).name, "room.created_from_groups", { created, assigned });
    response.status(201).json({ created, assigned, rooms: store.listRooms() });
  }));
  api.post("/admin/rooms", requireAuth(store, "admin"), route(async (request, response) => { const input = parsed(roomCreateSchema, request.body); response.status(201).json(store.createRoom(input.name, input.defaultBrightnessPercent)); }));
  api.put("/admin/rooms/:id/default-brightness", requireAuth(store, "admin"), route(async (request, response) => { const input = parsed(roomDefaultBrightnessSchema, request.body); const room = store.setRoomDefaultBrightness(Number(request.params.id), input.defaultBrightnessPercent); store.audit(principal(response).name, "room.default_brightness.updated", { roomId: room.id, defaultBrightnessPercent: room.defaultBrightnessPercent }); response.json(room); }));
  api.patch("/admin/rooms/:id", requireAuth(store, "admin"), route(async (request, response) => { const input = parsed(roomRenameSchema, request.body); const room = store.renameRoom(Number(request.params.id), input.name); store.audit(principal(response).name, "room.renamed", { roomId: room.id, name: room.name }); response.json(room); }));
  api.delete("/admin/rooms/:id", requireAuth(store, "admin"), route(async (request, response) => { assertUnused(store, { type: "room", id: Number(request.params.id) }, "room", principal(response)); store.deleteRoom(Number(request.params.id)); store.audit(principal(response).name, "room.deleted", { roomId: Number(request.params.id) }); response.status(204).send(); }));
  api.get("/admin/away-date-sets", requireAuth(store, "admin"), (_request, response) => response.json(store.listAwayDateSets()));
  api.post("/admin/away-date-sets", requireAuth(store, "admin"), route(async (request, response) => { const input = parsed(awayDateSetSchema, request.body); const set = store.createAwayDateSet(input.name, normalizeHolidayDates(input.dates)); scheduler.reload(); store.audit(principal(response).name, "away_date_set.created", { setId: set.id, name: set.name }); response.status(201).json(set); }));
  api.patch("/admin/away-date-sets/:id", requireAuth(store, "admin"), route(async (request, response) => { const input = parsed(awayDateSetSchema.partial(), request.body); const patch = { ...(input.name === undefined ? {} : { name: input.name }), ...(input.dates === undefined ? {} : { dates: normalizeHolidayDates(input.dates) }) }; const set = store.updateAwayDateSet(Number(request.params.id), patch); scheduler.reload(); store.audit(principal(response).name, "away_date_set.updated", { setId: set.id, name: set.name }); response.json(set); }));
  api.delete("/admin/away-date-sets/:id", requireAuth(store, "admin"), route(async (request, response) => { store.deleteAwayDateSet(Number(request.params.id)); scheduler.reload(); store.audit(principal(response).name, "away_date_set.deleted", { setId: Number(request.params.id) }); response.status(204).send(); }));
  // One request for many units, so placing hundreds of lamps in rooms stays well inside the rate limit.
  api.put("/admin/devices/room", requireAuth(store, "admin"), route(async (request, response) => { const input = parsed(deviceRoomsSchema, request.body); store.setUnitRooms(Array.from(new Set(input.unitIds)), input.roomId); store.audit(principal(response).name, "device.rooms_assigned", { count: input.unitIds.length, roomId: input.roomId }); response.status(204).send(); }));
  api.put("/admin/devices/:id/metadata", requireAuth(store, "admin"), route(async (request, response) => { const input = parsed(deviceMetadataSchema, request.body); const id = Number(request.params.id); const current = store.getUnitMetadata().find(metadata => metadata.unitId === id); store.setUnitMetadata(id, input.customName === undefined ? current?.customName ?? null : input.customName, input.roomId === undefined ? current?.roomId ?? null : input.roomId); response.status(204).send(); }));
  api.get("/admin/users", requireAuth(store, "admin"), (_request, response) => response.json(store.listUsers()));
  api.post("/admin/users", requireAuth(store, "admin"), route(async (request, response) => { const input = parsed(userCreateSchema, request.body); response.status(201).json(store.createUser(input.username, input.password, input.role)); }));
  api.patch("/admin/users/:id", requireAuth(store, "admin"), route(async (request, response) => {
    const input = parsed(userUpdateSchema, request.body); const id = Number(request.params.id);
    if (input.role) store.setUserRole(id, input.role);
    if (input.password) store.setUserPassword(id, input.password);
    store.audit(principal(response).name, "user.updated", { userId: id, ...(input.role ? { role: input.role } : {}), passwordReset: Boolean(input.password) });
    // Open event streams keep the role and session they were opened with; make the account reconnect.
    events.disconnect({ kind: "user", id });
    response.json(store.getUserById(id));
  }));
  api.delete("/admin/users/:id", requireAuth(store, "admin"), route(async (request, response) => {
    // The deleted account's timers move to the admin who deletes it (or, for an admin API key, to another admin).
    const actor = principal(response); const id = Number(request.params.id);
    const heir = actor.kind === "user" ? actor.id : store.listUsers().find(user => user.role === "admin" && user.id !== id)?.id;
    if (!heir) throw new Error("At least one admin account must remain.");
    store.deleteUser(id, heir); store.audit(actor.name, "user.deleted", { userId: id, timersMovedTo: heir }); events.disconnect({ kind: "user", id }); response.status(204).send();
  }));
  api.get("/admin/api-keys", requireAuth(store, "admin"), (_request, response) => response.json(store.listApiKeys()));
  api.post("/admin/api-keys", requireAuth(store, "admin"), route(async (request, response) => { const input = parsed(apiKeyCreateSchema, request.body); const key = store.createApiKey(input.label, input.role, input.expiresInDays ?? null); store.audit(principal(response).name, "api_key.created", { id: key.id, label: key.label, role: key.role, expiresAt: key.expiresAt }); response.status(201).json(key); }));
  api.delete("/admin/api-keys/:id", requireAuth(store, "admin"), route(async (request, response) => { store.revokeApiKey(Number(request.params.id)); store.audit(principal(response).name, "api_key.revoked", { id: Number(request.params.id) }); events.disconnect({ kind: "api_key", id: Number(request.params.id) }); response.status(204).send(); }));
  api.get("/admin/audit", requireAuth(store, "admin"), route(async (request, response) => { const query = parsed(auditQuerySchema, request.query); response.json(store.recentAudit(query.limit, query.action)); }));
  api.get("/admin/switch-activity", requireAuth(store, "admin"), (_request, response) => response.json(service.recentSwitchActivity()));
  api.get("/admin/switch-rules", requireAuth(store, "admin"), (_request, response) => response.json(store.listSwitchRules()));
  api.post("/admin/switch-rules", requireAuth(store, "admin"), route(async (request, response) => { const input = parsed(switchRuleSchema, request.body); const rule = store.createSwitchRule(input); store.audit(principal(response).name, "switch_rule.created", { ruleId: rule.id }); response.status(201).json(rule); }));
  api.patch("/admin/switch-rules/:id", requireAuth(store, "admin"), route(async (request, response) => { const input = parsed(switchRulePatchSchema, request.body); const rule = store.updateSwitchRule(Number(request.params.id), input); store.audit(principal(response).name, "switch_rule.updated", { ruleId: rule.id }); response.json(rule); }));
  api.delete("/admin/switch-rules/:id", requireAuth(store, "admin"), route(async (request, response) => { store.deleteSwitchRule(Number(request.params.id)); store.audit(principal(response).name, "switch_rule.deleted", { ruleId: Number(request.params.id) }); response.status(204).send(); }));

  // Anything else under /api/v1 is not an API route: answer in JSON instead of falling through to the web app.
  api.use((_request, response) => { response.status(404).json({ error: { code: "NOT_FOUND", message: "No such API route." } }); });
  api.use(apiErrorHandler);
  return api;
}

/**
 * JSON errors for failures outside `route()`. Mount it after the API as well: express.json() runs before the
 * router, so a malformed or oversized body never reaches the router's own error handler.
 */
export function apiErrorHandler(error: unknown, _request: Request, response: Response, _next: NextFunction): void {
  if (error instanceof z.ZodError) { response.status(422).json({ error: { code: "VALIDATION_ERROR", message: "Request validation failed.", fields: error.flatten() } }); return; }
  const type = (error as { type?: string } | null)?.type;
  if (type === "entity.parse.failed") { response.status(400).json({ error: { code: "INVALID_JSON", message: "The request body is not valid JSON." } }); return; }
  if (type === "entity.too.large") { response.status(413).json({ error: { code: "TOO_LARGE", message: "The request body is too large." } }); return; }
  console.error(error);
  response.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Unexpected API error." } });
}
