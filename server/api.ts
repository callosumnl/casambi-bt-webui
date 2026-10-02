import { Router, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { authenticate, issueToken, Principal, requireAuth } from "./auth";
import { CasambiService } from "./casambi/service";
import { controlRequestSchema } from "./casambi/types";
import { EventHub } from "./events";
import { AwayDateSet, LocalStore, Role, ScheduleRecord } from "./store";
import { DurableScheduler, nextRunAt, validateCron } from "./scheduler";
import { SolarSchedule, validateSolarLocation, validateSolarSchedule } from "./solar";
import { switchRuleSchema } from "./switchRules";

type Dependencies = { store: LocalStore; service: CasambiService; events: EventHub; scheduler: DurableScheduler };
type AsyncRoute = (request: Request, response: Response) => Promise<void>;
const roleSchema = z.enum(["admin", "user"]);
const credentialsSchema = z.object({ username: z.string().trim().min(3).max(64).regex(/^[a-z0-9._-]+$/i), password: z.string().min(12).max(256) });
const configSchema = z.object({ networkAddress: z.string().trim().min(1).max(128).nullable().optional(), networkUuid: z.string().trim().max(128).nullable().optional(), apiKey: z.string().max(512).nullable().optional(), networkPassword: z.string().max(512).nullable().optional(), btAdapter: z.string().trim().max(128).nullable().optional(), forceOffline: z.boolean().optional(), pollingEnabled: z.boolean().optional(), pollingIntervalSeconds: z.number().int().min(5).max(3600).optional(), solarLatitude: z.number().min(-90).max(90).nullable().optional(), solarLongitude: z.number().min(-180).max(180).nullable().optional() });
const solarSchema = z.object({ event: z.enum(["sunrise", "sunset"]), offsetMinutes: z.number().int().min(-180).max(180) });
const holidayDatesSchema = z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).max(120);
const awayDateSetSchema = z.object({ name: z.string().trim().min(1).max(96), dates: holidayDatesSchema.min(1) });
const scheduleSchema = z.object({ name: z.string().trim().min(1).max(96), cronExpression: z.string().trim().min(9).max(128).optional(), timezone: z.string().trim().min(1).max(80), command: controlRequestSchema, solar: solarSchema.nullable().optional(), holidayDates: holidayDatesSchema.default([]), awayDateSetId: z.number().int().positive().nullable().optional(), enabled: z.boolean().default(true) });

/** Wraps async routes in a stable JSON error response. */
function route(handler: AsyncRoute) {
  return (request: Request, response: Response) => void handler(request, response).catch(error => {
    if (error instanceof z.ZodError) {
      response.status(422).json({ error: { code: "VALIDATION_ERROR", message: "Request validation failed.", fields: error.flatten() }, requestId: response.locals.requestId });
      return;
    }
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    const status = message.includes("does not exist") || message.includes("does not exist") ? 404 : message.includes("required") || message.includes("invalid") ? 422 : 500;
    response.status(status).json({ error: { code: status === 422 ? "VALIDATION_ERROR" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR", message }, requestId: response.locals.requestId });
  });
}

function parsed<T>(schema: z.ZodType<T>, input: unknown): T { return schema.parse(input); }
function principal(response: Response): Principal { return response.locals.principal as Principal; }
function assertScheduleAccess(schedule: { ownerUserId: number }, actor: Principal): void { if (actor.role !== "admin" && schedule.ownerUserId !== actor.id) throw new Error("Schedule does not exist."); }
function serializeSchedule(schedule: ScheduleRecord, store: LocalStore) { let nextRun: Date | null = null; try { nextRun = nextRunAt(schedule, store.getCasambiConfig()); } catch { /* Invalid/missing solar configuration remains visible without claiming a run time. */ } return { ...schedule, nextRunAt: nextRun?.toISOString() ?? null }; }
function validateSolarForStore(solar: SolarSchedule | null | undefined, store: LocalStore): void { if (!solar) return; validateSolarSchedule(solar); const config = store.getCasambiConfig(); validateSolarLocation({ latitude: config.solarLatitude ?? undefined, longitude: config.solarLongitude ?? undefined }); }
function normalizeHolidayDates(dates: string[]): string[] { return Array.from(new Set(dates.map(date => { const parsed = new Date(`${date}T00:00:00.000Z`); if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) throw new Error("Holiday dates must be valid ISO calendar dates."); return date; }))).sort(); }
function assertAwayDateSet(id: number | null | undefined, store: LocalStore): AwayDateSet | null { if (id == null) return null; const set = store.getAwayDateSet(id); if (!set) throw new Error("Away-date set does not exist."); return set; }

/** Registers the complete versioned Raspberry Pi REST API. */
export function createCasambiApi({ store, service, events, scheduler }: Dependencies): Router {
  const api = Router();
  api.use(rateLimit({ windowMs: 60_000, limit: 240, standardHeaders: "draft-8", legacyHeaders: false }));
  api.use((_request, response, next) => { response.locals.requestId = crypto.randomUUID(); next(); });

  api.get("/health", (_request, response) => response.json({ status: "ok", bootstrapRequired: store.needsBootstrap(), eventClients: events.clientCount }));
  api.post("/auth/bootstrap", route(async (request, response) => {
    if (!store.needsBootstrap()) { response.status(409).json({ error: { code: "BOOTSTRAP_COMPLETE", message: "An administrator already exists." } }); return; }
    const input = parsed(credentialsSchema, request.body); const user = store.createUser(input.username, input.password, "admin"); store.audit(user.username, "auth.bootstrap", {});
    response.status(201).json({ token: await issueToken(user), user });
  }));
  api.post("/auth/login", route(async (request, response) => {
    const input = parsed(credentialsSchema, request.body); const user = store.verifyUser(input.username, input.password);
    if (!user) { response.status(401).json({ error: { code: "INVALID_CREDENTIALS", message: "Username or password is invalid." } }); return; }
    store.audit(user.username, "auth.login", {}); response.json({ token: await issueToken(user), user });
  }));

  api.get("/auth/me", requireAuth(store), (request, response) => response.json({ principal: principal(response) }));
  api.get("/events", route(async (request, response) => {
    const token = typeof request.query.access_token === "string" ? request.query.access_token : null;
    if (token) request.headers.authorization = `Bearer ${token}`;
    const actor = await authenticate(request, store);
    if (!actor) { response.status(401).json({ error: { code: "UNAUTHORIZED", message: "A valid event token is required." } }); return; }
    const remove = events.add(response); request.on("close", remove);
  }));

  // Read routes serve the cached state so they never wait behind a slow Bluetooth connect; `/network?fresh=1` asks the bridge.
  api.get("/network", requireAuth(store), route(async (request, response) => { response.json(request.query.fresh === "1" ? await service.snapshot() : service.cachedSnapshot()); }));
  api.get("/devices", requireAuth(store), route(async (_request, response) => { response.json(service.cachedSnapshot().units); }));
  api.get("/groups", requireAuth(store), route(async (_request, response) => { response.json(service.cachedSnapshot().groups); }));
  api.get("/scenes", requireAuth(store), route(async (_request, response) => { response.json(service.cachedSnapshot().scenes); }));
  api.get("/sensors", requireAuth(store), route(async (_request, response) => { response.json(service.cachedSnapshot().units.flatMap(unit => unit.state.sensors.map(sensor => ({ deviceId: unit.id, deviceName: unit.name, ...sensor })))); }));
  api.get("/rooms", requireAuth(store), (request, response) => response.json(store.listRooms()));
  api.post("/rooms/:id/apply-default", requireAuth(store), route(async (request, response) => {
    const input = parsed(z.object({ fadeDurationMs: z.number().int().min(0).max(60_000).optional() }), request.body || {});
    response.json(await service.applyRoomPreset(Number(request.params.id), principal(response).name, input.fadeDurationMs || 0));
  }));
  // `Prefer: return=minimal` skips the snapshot body for clients that already receive it over the SSE stream.
  api.post("/control", requireAuth(store), route(async (request, response) => { const command = parsed(controlRequestSchema, request.body); const snapshot = await service.control(command, principal(response).name); if (/\breturn=minimal\b/.test(request.get("Prefer") || "")) { response.status(204).set("Preference-Applied", "return=minimal").end(); return; } response.json(snapshot); }));
  api.post("/devices/:id/on", requireAuth(store), route(async (request, response) => { response.json(await service.control({ targetType: "unit", targetId: Number(request.params.id), operation: "on" }, principal(response).name)); }));
  api.post("/devices/:id/off", requireAuth(store), route(async (request, response) => { response.json(await service.control({ targetType: "unit", targetId: Number(request.params.id), operation: "off" }, principal(response).name)); }));
  api.post("/scenes/:id/activate", requireAuth(store), route(async (request, response) => { response.json(await service.control({ targetType: "scene", targetId: Number(request.params.id), operation: "activate_scene" }, principal(response).name)); }));

  api.get("/schedules", requireAuth(store), (_request, response) => { const actor = principal(response); response.json(store.listSchedules().filter(schedule => actor.role === "admin" || schedule.ownerUserId === actor.id).map(schedule => serializeSchedule(schedule, store))); });
  api.post("/schedules", requireAuth(store), route(async (request, response) => { const input = parsed(scheduleSchema, request.body); const cronExpression = input.cronExpression ?? "0 0 * * *"; if (!input.solar) validateCron(cronExpression, input.timezone); validateSolarForStore(input.solar, store); const awayDateSet = assertAwayDateSet(input.awayDateSetId, store); const schedule = store.createSchedule({ name: input.name, cronExpression, timezone: input.timezone, command: input.command, solar: input.solar ?? null, holidayDates: normalizeHolidayDates(input.holidayDates), awayDateSetId: awayDateSet?.id ?? null, awayDateSet, enabled: input.enabled, ownerUserId: principal(response).id }); scheduler.reload(); store.audit(principal(response).name, "schedule.created", { scheduleId: schedule.id, solar: schedule.solar, holidayDates: schedule.holidayDates, awayDateSetId: schedule.awayDateSetId }); response.status(201).json(serializeSchedule(schedule, store)); }));
  api.patch("/schedules/:id", requireAuth(store), route(async (request, response) => { const current = store.getSchedule(Number(request.params.id)); if (!current) throw new Error("Schedule does not exist."); assertScheduleAccess(current, principal(response)); const input = parsed(scheduleSchema.partial(), request.body); const solar = input.solar === undefined ? current.solar : input.solar; const cronExpression = input.cronExpression ?? current.cronExpression; const timezone = input.timezone ?? current.timezone; const holidayDates = input.holidayDates === undefined ? current.holidayDates : normalizeHolidayDates(input.holidayDates); const awayDateSetId = input.awayDateSetId === undefined ? current.awayDateSetId : assertAwayDateSet(input.awayDateSetId, store)?.id ?? null; if (!solar) validateCron(cronExpression, timezone); validateSolarForStore(solar, store); const schedule = store.updateSchedule(current.id, { ...input, cronExpression, timezone, solar: solar ?? null, holidayDates, awayDateSetId }); scheduler.reload(); response.json(serializeSchedule(schedule, store)); }));
  api.delete("/schedules/:id", requireAuth(store), route(async (request, response) => { const current = store.getSchedule(Number(request.params.id)); if (!current) throw new Error("Schedule does not exist."); assertScheduleAccess(current, principal(response)); store.deleteSchedule(current.id); scheduler.reload(); response.status(204).send(); }));
  api.get("/away-date-sets", requireAuth(store), (_request, response) => response.json(store.listAwayDateSets()));

  api.get("/admin/config", requireAuth(store, "admin"), (_request, response) => response.json(store.getSafeCasambiConfig()));
  api.put("/admin/config", requireAuth(store, "admin"), route(async (request, response) => { const input = parsed(configSchema, request.body); if ("solarLatitude" in input || "solarLongitude" in input) { const current = store.getCasambiConfig(); const latitude = input.solarLatitude === undefined ? current.solarLatitude : input.solarLatitude; const longitude = input.solarLongitude === undefined ? current.solarLongitude : input.solarLongitude; if (latitude !== null || longitude !== null) validateSolarLocation({ latitude: latitude ?? undefined, longitude: longitude ?? undefined }); } service.saveConfiguration(input); scheduler.reload(); store.audit(principal(response).name, "config.updated", {}); response.json(store.getSafeCasambiConfig()); }));
  api.get("/admin/discovery", requireAuth(store, "admin"), route(async (_request, response) => { response.json(await service.discover()); }));
  api.get("/admin/worker", requireAuth(store, "admin"), (_request, response) => response.json(service.workerState()));
  api.post("/admin/worker/restart", requireAuth(store, "admin"), route(async (_request, response) => { response.status(202).json(service.restartWorker(principal(response).name)); }));
  api.post("/admin/connect", requireAuth(store, "admin"), route(async (_request, response) => { response.json(await service.connect()); }));
  api.post("/admin/disconnect", requireAuth(store, "admin"), route(async (_request, response) => { response.json(await service.disconnect()); }));
  api.post("/admin/rooms", requireAuth(store, "admin"), route(async (request, response) => { const input = parsed(z.object({ name: z.string().trim().min(1).max(96), defaultBrightnessPercent: z.number().int().min(0).max(100).default(100) }), request.body); response.status(201).json(store.createRoom(input.name, input.defaultBrightnessPercent)); }));
  api.put("/admin/rooms/:id/default-brightness", requireAuth(store, "admin"), route(async (request, response) => { const input = parsed(z.object({ defaultBrightnessPercent: z.number().int().min(0).max(100) }), request.body); const room = store.setRoomDefaultBrightness(Number(request.params.id), input.defaultBrightnessPercent); store.audit(principal(response).name, "room.default_brightness.updated", { roomId: room.id, defaultBrightnessPercent: room.defaultBrightnessPercent }); response.json(room); }));
  api.delete("/admin/rooms/:id", requireAuth(store, "admin"), (request, response) => { store.deleteRoom(Number(request.params.id)); response.status(204).send(); });
  api.get("/admin/away-date-sets", requireAuth(store, "admin"), (_request, response) => response.json(store.listAwayDateSets()));
  api.post("/admin/away-date-sets", requireAuth(store, "admin"), route(async (request, response) => { const input = parsed(awayDateSetSchema, request.body); const set = store.createAwayDateSet(input.name, normalizeHolidayDates(input.dates)); scheduler.reload(); store.audit(principal(response).name, "away_date_set.created", { setId: set.id, name: set.name }); response.status(201).json(set); }));
  api.patch("/admin/away-date-sets/:id", requireAuth(store, "admin"), route(async (request, response) => { const input = parsed(awayDateSetSchema.partial(), request.body); const patch = { ...(input.name === undefined ? {} : { name: input.name }), ...(input.dates === undefined ? {} : { dates: normalizeHolidayDates(input.dates) }) }; const set = store.updateAwayDateSet(Number(request.params.id), patch); scheduler.reload(); store.audit(principal(response).name, "away_date_set.updated", { setId: set.id, name: set.name }); response.json(set); }));
  api.delete("/admin/away-date-sets/:id", requireAuth(store, "admin"), route(async (request, response) => { store.deleteAwayDateSet(Number(request.params.id)); scheduler.reload(); store.audit(principal(response).name, "away_date_set.deleted", { setId: Number(request.params.id) }); response.status(204).send(); }));
  api.put("/admin/devices/:id/metadata", requireAuth(store, "admin"), route(async (request, response) => { const input = parsed(z.object({ customName: z.string().trim().max(128).nullable(), roomId: z.number().int().positive().nullable() }), request.body); store.setUnitMetadata(Number(request.params.id), input.customName, input.roomId); response.status(204).send(); }));
  api.get("/admin/users", requireAuth(store, "admin"), (_request, response) => response.json(store.listUsers()));
  api.post("/admin/users", requireAuth(store, "admin"), route(async (request, response) => { const input = parsed(credentialsSchema.extend({ role: roleSchema }), request.body); response.status(201).json(store.createUser(input.username, input.password, input.role)); }));
  api.patch("/admin/users/:id", requireAuth(store, "admin"), route(async (request, response) => { const input = parsed(z.object({ role: roleSchema }), request.body); response.json(store.setUserRole(Number(request.params.id), input.role)); }));
  api.get("/admin/api-keys", requireAuth(store, "admin"), (_request, response) => response.json(store.listApiKeys()));
  api.post("/admin/api-keys", requireAuth(store, "admin"), route(async (request, response) => { const input = parsed(z.object({ label: z.string().trim().min(1).max(96), role: roleSchema }), request.body); const key = store.createApiKey(input.label, input.role); store.audit(principal(response).name, "api_key.created", { id: key.id, label: key.label, role: key.role }); response.status(201).json(key); }));
  api.delete("/admin/api-keys/:id", requireAuth(store, "admin"), (request, response) => { store.revokeApiKey(Number(request.params.id)); store.audit(principal(response).name, "api_key.revoked", { id: Number(request.params.id) }); response.status(204).send(); });
  api.get("/admin/audit", requireAuth(store, "admin"), (_request, response) => response.json(store.recentAudit()));
  api.get("/admin/switch-activity", requireAuth(store, "admin"), (_request, response) => response.json(service.recentSwitchActivity()));
  api.get("/admin/switch-rules", requireAuth(store, "admin"), (_request, response) => response.json(store.listSwitchRules()));
  api.post("/admin/switch-rules", requireAuth(store, "admin"), route(async (request, response) => { const input = parsed(switchRuleSchema, request.body); const rule = store.createSwitchRule(input); store.audit(principal(response).name, "switch_rule.created", { ruleId: rule.id }); response.status(201).json(rule); }));
  api.patch("/admin/switch-rules/:id", requireAuth(store, "admin"), route(async (request, response) => { const input = parsed(switchRuleSchema.partial(), request.body); const rule = store.updateSwitchRule(Number(request.params.id), input); store.audit(principal(response).name, "switch_rule.updated", { ruleId: rule.id }); response.json(rule); }));
  api.delete("/admin/switch-rules/:id", requireAuth(store, "admin"), route(async (request, response) => { store.deleteSwitchRule(Number(request.params.id)); store.audit(principal(response).name, "switch_rule.deleted", { ruleId: Number(request.params.id) }); response.status(204).send(); }));

  api.use((error: unknown, _request: Request, response: Response, _next: unknown) => {
    if (error instanceof z.ZodError) return response.status(422).json({ error: { code: "VALIDATION_ERROR", message: "Request validation failed.", fields: error.flatten() } });
    return response.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Unexpected API error." } });
  });
  return api;
}
