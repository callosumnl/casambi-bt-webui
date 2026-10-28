import express from "express";
import request from "supertest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiErrorHandler, classifyError, createCasambiApi } from "./api";
import { CasambiService } from "./casambi/service";
import { EventHub } from "./events";
import { DurableScheduler } from "./scheduler";
import { SetupCode } from "./setupCode";
import type { Probes } from "./diagnostics";
import { Updater } from "./updates";
import { ServerSettingsHelper } from "./serverSettings";
import { Notifier } from "./notifications";
import { LocalStore } from "./store";
import { existsSync } from "fs";

const folders: string[] = [];
const stores = new WeakMap<object, LocalStore>();
const instanceStore = (instance: object) => stores.get(instance)!;
/** Answers every system probe with "not available", so tests never run real system commands. */
const noProbes: Probes = { run: async () => null, read: async () => null, list: async () => [], diskSpace: async () => null, network: () => ({ hostname: "", interfaces: {} }) };
function app(options: { setupCode?: (folder: string) => SetupCode; groups?: Array<{ id: number; name: string; unitIds: number[] }>; updaterState?: (folder: string) => string } = {}) {
  const folder = mkdtempSync(join(tmpdir(), "casambi-api-")); folders.push(folder);
  const store = new LocalStore(join(folder, "state.db"), "test-key"); const events = new EventHub();
  const service = { captureLightScene: (name: string, scope: { type: "group" | "room" | "network"; id: number | null }) => store.createLightScene(name, scope, [{ unitId: 1, level: 128, temperature: null }]), recaptureLightScene: (id: number) => store.updateLightScene(id, { lamps: [{ unitId: 1, level: 64, temperature: null }] }), snapshot: async () => ({ connected: false, network: null, units: [], groups: [], scenes: [], rooms: [], updatedAt: new Date().toISOString() }), workerState: () => ({ running: true, pid: 4242, busy: null, lastAnswerAt: null, restarts: 0 }), restartWorker: () => ({ running: false, pid: null, busy: null, lastAnswerAt: null, restarts: 1 }), recentSwitchActivity: () => [{ unitId: 2, button: 4, trigger: "tap", raw: {}, at: "2026-09-24T19:17:33.564Z" }], cachedSnapshot: () => ({ connected: false, network: null, units: [], groups: options.groups ?? [], scenes: [], rooms: [], updatedAt: new Date().toISOString(), connection: { phase: "idle" } }), control: async () => ({ connected: false, network: null, units: [], groups: [], scenes: [], updatedAt: new Date().toISOString() }), discover: async () => [], connect: async () => ({}), disconnect: async () => ({}), saveConfiguration: (input: Record<string, unknown>) => store.saveCasambiConfig({ ...store.getCasambiConfig(), ...input }) } as unknown as CasambiService;
  const scheduler = { reload: () => undefined } as unknown as DurableScheduler;
  const instance = express(); instance.use(express.json()); instance.use("/api/v1", createCasambiApi({ store, service, events, scheduler, setupCode: options.setupCode?.(folder), probes: noProbes, updater: new Updater(join(folder, "data"), options.updaterState?.(folder) ?? join(folder, "no-updater")), serverSettings: new ServerSettingsHelper(join(folder, "data"), options.updaterState?.(folder) ?? join(folder, "no-updater")), notifier: new Notifier(store, events, { connection: () => ({ phase: "idle" }), update: () => ({}), post: async () => ({ status: 502 }) }) })); instance.use("/api/v1", apiErrorHandler); stores.set(instance, store); return instance;
}
afterEach(() => folders.splice(0).forEach(folder => rmSync(folder, { recursive: true, force: true })));

describe("REST API", () => {
  it("bootstraps the first admin once and protects user routes with a JWT", async () => {
    const instance = app();
    const bootstrap = await request(instance).post("/api/v1/auth/bootstrap").send({ username: "admin", password: "this-is-a-strong-password" }).expect(201);
    expect(bootstrap.body.user.role).toBe("admin"); expect(bootstrap.body.token).toEqual(expect.any(String));
    await request(instance).post("/api/v1/auth/bootstrap").send({ username: "second", password: "this-is-a-strong-password" }).expect(409);
    await request(instance).get("/api/v1/network").expect(401);
    await request(instance).get("/api/v1/network").set("Authorization", `Bearer ${bootstrap.body.token}`).expect(200);
  });

  it("prevents a user JWT from reaching admin configuration", async () => {
    const instance = app(); const admin = await request(instance).post("/api/v1/auth/bootstrap").send({ username: "admin", password: "this-is-a-strong-password" });
    await request(instance).post("/api/v1/admin/users").set("Authorization", `Bearer ${admin.body.token}`).send({ username: "operator", password: "another-strong-password", role: "user" }).expect(201);
    const login = await request(instance).post("/api/v1/auth/login").send({ username: "operator", password: "another-strong-password" }).expect(200);
    await request(instance).get("/api/v1/admin/config").set("Authorization", `Bearer ${login.body.token}`).expect(403);
  });

  it("allows an admin to persist a bounded room default brightness", async () => {
    const instance = app();
    const admin = await request(instance).post("/api/v1/auth/bootstrap").send({ username: "admin", password: "this-is-a-strong-password" });
    const auth = { Authorization: `Bearer ${admin.body.token}` };
    const room = await request(instance).post("/api/v1/admin/rooms").set(auth).send({ name: "Studio", defaultBrightnessPercent: 70 }).expect(201);
    expect(room.body).toMatchObject({ name: "Studio", defaultBrightnessPercent: 70 });
    const updated = await request(instance).put(`/api/v1/admin/rooms/${room.body.id}/default-brightness`).set(auth).send({ defaultBrightnessPercent: 45 }).expect(200);
    expect(updated.body).toMatchObject({ id: room.body.id, defaultBrightnessPercent: 45 });
    await request(instance).put(`/api/v1/admin/rooms/${room.body.id}/default-brightness`).set(auth).send({ defaultBrightnessPercent: 101 }).expect(422);
  });

  it("creates a local sunset timer with a computed next run after an admin configures the location", async () => {
    const instance = app();
    const admin = await request(instance).post("/api/v1/auth/bootstrap").send({ username: "admin", password: "this-is-a-strong-password" });
    const auth = { Authorization: `Bearer ${admin.body.token}` };
    await request(instance).put("/api/v1/admin/config").set(auth).send({ solarLatitude: 52.3676, solarLongitude: 4.9041 }).expect(200);
    const response = await request(instance).post("/api/v1/schedules").set(auth).send({ name: "Sunset", timezone: "Europe/Amsterdam", solar: { event: "sunset", offsetMinutes: -15 }, holidayDates: ["2026-12-25", "2026-12-25"], enabled: true, command: { targetType: "network", operation: "on" } }).expect(201);
    expect(response.body.solar).toEqual({ event: "sunset", offsetMinutes: -15 });
    expect(response.body.holidayDates).toEqual(["2026-12-25"]);
    expect(new Date(response.body.nextRunAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("returns the control snapshot unless the client prefers a minimal response", async () => {
    const instance = app();
    const admin = await request(instance).post("/api/v1/auth/bootstrap").send({ username: "admin", password: "this-is-a-strong-password" });
    const auth = { Authorization: `Bearer ${admin.body.token}` };
    const command = { targetType: "unit", targetId: 1, operation: "set_level", value: 128 };
    const full = await request(instance).post("/api/v1/control").set(auth).send(command).expect(200);
    expect(full.body).toMatchObject({ connected: false, units: [] });
    const minimal = await request(instance).post("/api/v1/control").set(auth).set("Prefer", "return=minimal").send(command).expect(204);
    expect(minimal.headers["preference-applied"]).toBe("return=minimal");
  });

  it("lets only an admin manage switch rules and read switch activity", async () => {
    const instance = app();
    const admin = await request(instance).post("/api/v1/auth/bootstrap").send({ username: "admin", password: "this-is-a-strong-password" });
    const auth = { Authorization: `Bearer ${admin.body.token}` };
    await request(instance).post("/api/v1/admin/users").set(auth).send({ username: "operator", password: "another-strong-password", role: "user" }).expect(201);
    const operator = await request(instance).post("/api/v1/auth/login").send({ username: "operator", password: "another-strong-password" });
    const rule = { name: "Eiland", unitId: 2, button: 4, trigger: "tap", command: { targetType: "unit", targetId: 1, operation: "toggle" } };

    await request(instance).post("/api/v1/admin/switch-rules").set({ Authorization: `Bearer ${operator.body.token}` }).send(rule).expect(403);
    await request(instance).post("/api/v1/admin/switch-rules").set(auth).send({ ...rule, trigger: "press" }).expect(422);
    const created = await request(instance).post("/api/v1/admin/switch-rules").set(auth).send(rule).expect(201);
    expect(created.body).toMatchObject({ name: "Eiland", unitId: 2, button: 4, trigger: "tap", enabled: true });
    expect((await request(instance).patch(`/api/v1/admin/switch-rules/${created.body.id}`).set(auth).send({ enabled: false }).expect(200)).body.enabled).toBe(false);
    expect((await request(instance).get("/api/v1/admin/switch-rules").set(auth).expect(200)).body).toHaveLength(1);
    expect((await request(instance).get("/api/v1/admin/switch-activity").set(auth).expect(200)).body[0]).toMatchObject({ unitId: 2, button: 4, trigger: "tap" });
    await request(instance).delete(`/api/v1/admin/switch-rules/${created.body.id}`).set(auth).expect(204);
    await request(instance).delete(`/api/v1/admin/switch-rules/${created.body.id}`).set(auth).expect(404);
  });

  it("lets only an admin read the worker state and restart the worker", async () => {
    const instance = app();
    const admin = await request(instance).post("/api/v1/auth/bootstrap").send({ username: "admin", password: "this-is-a-strong-password" });
    const auth = { Authorization: `Bearer ${admin.body.token}` };
    await request(instance).post("/api/v1/admin/users").set(auth).send({ username: "operator", password: "another-strong-password", role: "user" }).expect(201);
    const operator = await request(instance).post("/api/v1/auth/login").send({ username: "operator", password: "another-strong-password" });
    await request(instance).get("/api/v1/admin/worker").set({ Authorization: `Bearer ${operator.body.token}` }).expect(403);
    await request(instance).post("/api/v1/admin/worker/restart").set({ Authorization: `Bearer ${operator.body.token}` }).expect(403);
    expect((await request(instance).get("/api/v1/admin/worker").set(auth).expect(200)).body).toMatchObject({ running: true, pid: 4242 });
    expect((await request(instance).post("/api/v1/admin/worker/restart").set(auth).expect(202)).body).toMatchObject({ restarts: 1 });
  });

  it("lets a signed-in user save, update, rename, apply, and delete scenes", async () => {
    const instance = app();
    const admin = await request(instance).post("/api/v1/auth/bootstrap").send({ username: "admin", password: "this-is-a-strong-password" });
    const auth = { Authorization: `Bearer ${admin.body.token}` };
    await request(instance).post("/api/v1/local-scenes").set(auth).send({ name: "Dinner", scope: { type: "group", id: null } }).expect(422);
    const created = await request(instance).post("/api/v1/local-scenes").set(auth).send({ name: "Dinner", scope: { type: "group", id: 5 } }).expect(201);
    expect(created.body).toMatchObject({ name: "Dinner", scope: { type: "group", id: 5 }, lamps: [{ unitId: 1, level: 128 }] });
    expect((await request(instance).post(`/api/v1/local-scenes/${created.body.id}/capture`).set(auth).expect(200)).body.lamps[0].level).toBe(64);
    expect((await request(instance).patch(`/api/v1/local-scenes/${created.body.id}`).set(auth).send({ name: "Late dinner" }).expect(200)).body.name).toBe("Late dinner");
    expect((await request(instance).get("/api/v1/local-scenes").set(auth).expect(200)).body).toHaveLength(1);
    await request(instance).post(`/api/v1/local-scenes/${created.body.id}/apply`).set(auth).send({ fadeDurationMs: 800 }).expect(200);
    await request(instance).delete(`/api/v1/local-scenes/${created.body.id}`).set(auth).expect(204);
    await request(instance).delete(`/api/v1/local-scenes/${created.body.id}`).set(auth).expect(404);
  });

  it("maps domain and database errors to 4xx statuses instead of 500", () => {
    expect(classifyError(new Error("Cron expression must contain five fields: minute hour day month weekday."))).toMatchObject({ status: 422 });
    expect(classifyError(new Error("Holiday dates must be valid ISO calendar dates."))).toMatchObject({ status: 422 });
    expect(classifyError(new Error("The room has no assigned lamps."))).toMatchObject({ status: 422 });
    expect(classifyError(new Error("UNIQUE constraint failed: rooms.name"))).toEqual({ status: 409, code: "CONFLICT", message: "That name is already in use." });
    expect(classifyError(new Error("FOREIGN KEY constraint failed"))).toMatchObject({ status: 422, message: "A referenced item does not exist." });
    expect(classifyError(new Error("Scene does not exist."))).toMatchObject({ status: 404 });
    expect(classifyError(new Error("disk I/O error"))).toMatchObject({ status: 500 });
  });

  it("applies a role change immediately, not when the 8 h token expires", async () => {
    const instance = app();
    const admin = await request(instance).post("/api/v1/auth/bootstrap").send({ username: "admin", password: "this-is-a-strong-password" });
    const auth = { Authorization: `Bearer ${admin.body.token}` };
    const second = await request(instance).post("/api/v1/admin/users").set(auth).send({ username: "second", password: "another-strong-password", role: "admin" }).expect(201);
    const login = await request(instance).post("/api/v1/auth/login").send({ username: "second", password: "another-strong-password" }).expect(200);
    await request(instance).get("/api/v1/admin/config").set({ Authorization: `Bearer ${login.body.token}` }).expect(200);
    await request(instance).patch(`/api/v1/admin/users/${second.body.id}`).set(auth).send({ role: "user" }).expect(200);
    await request(instance).get("/api/v1/admin/config").set({ Authorization: `Bearer ${login.body.token}` }).expect(403);
  });

  it("changes only the fields a timer PATCH sends", async () => {
    const instance = app();
    const admin = await request(instance).post("/api/v1/auth/bootstrap").send({ username: "admin", password: "this-is-a-strong-password" });
    const auth = { Authorization: `Bearer ${admin.body.token}` };
    const set = await request(instance).post("/api/v1/admin/away-date-sets").set(auth).send({ name: "Holiday", dates: ["2026-12-24"] }).expect(201);
    const timer = await request(instance).post("/api/v1/schedules").set(auth).send({ name: "Quiet", cronExpression: "0 18 * * *", timezone: "Europe/Amsterdam", holidayDates: ["2026-12-31"], enabled: false, command: { targetType: "network", operation: "on" } }).expect(201);
    const patched = await request(instance).patch(`/api/v1/schedules/${timer.body.id}`).set(auth).send({ awayDateSetId: set.body.id }).expect(200);
    expect(patched.body).toMatchObject({ holidayDates: ["2026-12-31"], enabled: false, awayDateSetId: set.body.id });
  });

  it("rejects bad timers, controls, and duplicates with 4xx statuses", async () => {
    const instance = app();
    const admin = await request(instance).post("/api/v1/auth/bootstrap").send({ username: "admin", password: "this-is-a-strong-password" });
    const auth = { Authorization: `Bearer ${admin.body.token}` };
    await request(instance).put("/api/v1/admin/config").set(auth).send({ solarLatitude: 52.37, solarLongitude: 4.9 }).expect(200);
    await request(instance).post("/api/v1/schedules").set(auth).send({ name: "Mars", timezone: "Mars/Base", solar: { event: "sunset", offsetMinutes: 0 }, command: { targetType: "network", operation: "on" } }).expect(422);
    await request(instance).post("/api/v1/schedules").set(auth).send({ name: "Six", cronExpression: "0 0 18 * * *", timezone: "UTC", command: { targetType: "network", operation: "on" } }).expect(422);
    await request(instance).post("/api/v1/schedules").set(auth).send({ name: "Feb", cronExpression: "0 18 * * *", timezone: "UTC", holidayDates: ["2026-02-30"], command: { targetType: "network", operation: "on" } }).expect(422);
    await request(instance).post("/api/v1/control").set(auth).send({ targetType: "network", operation: "activate_scene" }).expect(422);
    await request(instance).post("/api/v1/control").set(auth).send({ targetType: "unit", targetId: 1, operation: "set_level", value: 300 }).expect(422);
    await request(instance).post("/api/v1/control").set(auth).send({ targetType: "unit", operation: "on" }).expect(422);
    await request(instance).post("/api/v1/admin/rooms").set(auth).send({ name: "Studio" }).expect(201);
    await request(instance).post("/api/v1/admin/rooms").set(auth).send({ name: "Studio" }).expect(409);
    await request(instance).delete("/api/v1/admin/rooms/999").set(auth).expect(404);
  });

  it("keeps API keys from owning or reaching another user's timers", async () => {
    const instance = app();
    const admin = await request(instance).post("/api/v1/auth/bootstrap").send({ username: "admin", password: "this-is-a-strong-password" });
    const auth = { Authorization: `Bearer ${admin.body.token}` };
    await request(instance).post("/api/v1/schedules").set(auth).send({ name: "Admin timer", cronExpression: "0 18 * * *", timezone: "UTC", command: { targetType: "network", operation: "on" } }).expect(201);
    const userKey = await request(instance).post("/api/v1/admin/api-keys").set(auth).send({ label: "Phone", role: "user" }).expect(201);
    expect((await request(instance).get("/api/v1/schedules").set({ "X-API-Key": userKey.body.token }).expect(200)).body).toEqual([]);
    await request(instance).post("/api/v1/schedules").set({ "X-API-Key": userKey.body.token }).send({ name: "Key timer", cronExpression: "0 7 * * *", timezone: "UTC", command: { targetType: "network", operation: "on" } }).expect(422);
    const adminKey = await request(instance).post("/api/v1/admin/api-keys").set(auth).send({ label: "Home Assistant", role: "admin" }).expect(201);
    await request(instance).post("/api/v1/schedules").set({ "X-API-Key": adminKey.body.token }).send({ name: "Key timer", cronExpression: "0 7 * * *", timezone: "UTC", command: { targetType: "network", operation: "on" } }).expect(201);
    await request(instance).delete(`/api/v1/admin/api-keys/${userKey.body.id}`).set(auth).expect(204);
    await request(instance).get("/api/v1/schedules").set({ "X-API-Key": userKey.body.token }).expect(401);
  });

  it("manages accounts: password reset, role change, and deletion that keeps the timers", async () => {
    const instance = app();
    const admin = await request(instance).post("/api/v1/auth/bootstrap").send({ username: "admin", password: "this-is-a-strong-password" });
    const auth = { Authorization: `Bearer ${admin.body.token}` };
    const user = await request(instance).post("/api/v1/admin/users").set(auth).send({ username: "guest", password: "another-strong-password", role: "user" }).expect(201);
    const guest = await request(instance).post("/api/v1/auth/login").send({ username: "guest", password: "another-strong-password" });
    await request(instance).post("/api/v1/schedules").set({ Authorization: `Bearer ${guest.body.token}` }).send({ name: "Guest timer", cronExpression: "0 7 * * *", timezone: "UTC", command: { targetType: "network", operation: "on" } }).expect(201);
    await request(instance).patch(`/api/v1/admin/users/${user.body.id}`).set(auth).send({}).expect(422);
    await request(instance).patch(`/api/v1/admin/users/${user.body.id}`).set(auth).send({ password: "a-brand-new-password" }).expect(200);
    await request(instance).post("/api/v1/auth/login").send({ username: "guest", password: "another-strong-password" }).expect(401);
    await request(instance).post("/api/v1/auth/login").send({ username: "guest", password: "a-brand-new-password" }).expect(200);
    await request(instance).delete(`/api/v1/admin/users/${admin.body.user.id}`).set(auth).expect(422);
    await request(instance).delete(`/api/v1/admin/users/${user.body.id}`).set(auth).expect(204);
    await request(instance).get("/api/v1/auth/me").set({ Authorization: `Bearer ${guest.body.token}` }).expect(401);
    const timers = (await request(instance).get("/api/v1/schedules").set(auth).expect(200)).body;
    expect(timers).toMatchObject([{ name: "Guest timer", ownerUserId: admin.body.user.id }]);
  });

  it("renames rooms and refuses to delete a room or scene that something still uses", async () => {
    const instance = app();
    const admin = await request(instance).post("/api/v1/auth/bootstrap").send({ username: "admin", password: "this-is-a-strong-password" });
    const auth = { Authorization: `Bearer ${admin.body.token}` };
    const room = await request(instance).post("/api/v1/admin/rooms").set(auth).send({ name: "Studio" }).expect(201);
    expect((await request(instance).patch(`/api/v1/admin/rooms/${room.body.id}`).set(auth).send({ name: "Atelier" }).expect(200)).body.name).toBe("Atelier");
    const timer = await request(instance).post("/api/v1/schedules").set(auth).send({ name: "Atelier evening", cronExpression: "0 18 * * *", timezone: "UTC", command: { targetType: "room", targetId: room.body.id, operation: "on" } }).expect(201);
    const refused = await request(instance).delete(`/api/v1/admin/rooms/${room.body.id}`).set(auth).expect(409);
    expect(refused.body.error.message).toBe("This room is used by timer “Atelier evening”. Change or delete those first.");
    await request(instance).delete(`/api/v1/schedules/${timer.body.id}`).set(auth).expect(204);
    await request(instance).delete(`/api/v1/admin/rooms/${room.body.id}`).set(auth).expect(204);
    const scene = await request(instance).post("/api/v1/local-scenes").set(auth).send({ name: "Dinner", scope: { type: "group", id: 5 } }).expect(201);
    await request(instance).post("/api/v1/admin/switch-rules").set(auth).send({ name: "Dinner button", unitId: 2, button: 4, trigger: "tap", command: { targetType: "local_scene", targetId: scene.body.id, operation: "activate_scene" } }).expect(201);
    expect((await request(instance).delete(`/api/v1/local-scenes/${scene.body.id}`).set(auth).expect(409)).body.error.message).toContain("switch rule “Dinner button”");
  });

  it("updates only the device metadata fields that are sent", async () => {
    const instance = app();
    const admin = await request(instance).post("/api/v1/auth/bootstrap").send({ username: "admin", password: "this-is-a-strong-password" });
    const auth = { Authorization: `Bearer ${admin.body.token}` };
    const room = await request(instance).post("/api/v1/admin/rooms").set(auth).send({ name: "Kitchen" }).expect(201);
    await request(instance).put("/api/v1/admin/devices/7/metadata").set(auth).send({ customName: "Island" }).expect(204);
    await request(instance).put("/api/v1/admin/devices/7/metadata").set(auth).send({ roomId: room.body.id }).expect(204);
    await request(instance).put("/api/v1/admin/devices/8/metadata").set(auth).send({ roomId: 999 }).expect(422);
    expect(instanceStore(instance).getUnitMetadata()).toEqual([{ unitId: 7, customName: "Island", roomId: room.body.id }]);
  });

  it("filters and limits the audit log", async () => {
    const instance = app();
    const admin = await request(instance).post("/api/v1/auth/bootstrap").send({ username: "admin", password: "this-is-a-strong-password" });
    const auth = { Authorization: `Bearer ${admin.body.token}` };
    await request(instance).post("/api/v1/admin/rooms").set(auth).send({ name: "A" });
    const entries = (await request(instance).get("/api/v1/admin/audit?action=auth.&limit=5").set(auth).expect(200)).body as Array<{ action: string }>;
    expect(entries.map(entry => entry.action)).toEqual(["auth.bootstrap"]);
    await request(instance).get("/api/v1/admin/audit?limit=9999").set(auth).expect(422);
  });

  it("creates a reusable away-date set and attaches it to a timer", async () => {
    const instance = app();
    const admin = await request(instance).post("/api/v1/auth/bootstrap").send({ username: "admin", password: "this-is-a-strong-password" });
    const auth = { Authorization: `Bearer ${admin.body.token}` };
    const set = await request(instance).post("/api/v1/admin/away-date-sets").set(auth).send({ name: "Summer break", dates: ["2026-08-17", "2026-08-18"] }).expect(201);
    const timer = await request(instance).post("/api/v1/schedules").set(auth).send({ name: "Welcome", cronExpression: "0 18 * * *", timezone: "Europe/Amsterdam", awayDateSetId: set.body.id, enabled: true, command: { targetType: "network", operation: "on" } }).expect(201);
    expect(timer.body.awayDateSet).toMatchObject({ id: set.body.id, name: "Summer break", dates: ["2026-08-17", "2026-08-18"] });
    expect((await request(instance).get("/api/v1/away-date-sets").set(auth).expect(200)).body).toHaveLength(1);
  });

  it("requires the one-time setup code to create the first admin, then deletes it", async () => {
    let code: SetupCode | undefined;
    const instance = app({ setupCode: folder => (code = new SetupCode(folder, true)) });
    expect(existsSync(code!.path)).toBe(true);
    await request(instance).post("/api/v1/auth/bootstrap").send({ username: "admin", password: "this-is-a-strong-password" }).expect(403);
    await request(instance).post("/api/v1/auth/bootstrap").send({ username: "admin", password: "this-is-a-strong-password", setupCode: "0000-0000-0000" }).expect(403);
    await request(instance).post("/api/v1/auth/bootstrap").send({ username: "admin", password: "this-is-a-strong-password", setupCode: code!.reveal().replaceAll("-", "").toLowerCase() }).expect(201);
    expect(existsSync(code!.path)).toBe(false);
  });

  it("signs a user out everywhere when an admin resets their password", async () => {
    const instance = app(); const admin = await request(instance).post("/api/v1/auth/bootstrap").send({ username: "admin", password: "this-is-a-strong-password" });
    const user = await request(instance).post("/api/v1/admin/users").set("Authorization", `Bearer ${admin.body.token}`).send({ username: "operator", password: "another-strong-password", role: "user" }).expect(201);
    const before = await request(instance).post("/api/v1/auth/login").send({ username: "operator", password: "another-strong-password" }).expect(200);
    await request(instance).get("/api/v1/auth/me").set("Authorization", `Bearer ${before.body.token}`).expect(200);
    await request(instance).patch(`/api/v1/admin/users/${user.body.id}`).set("Authorization", `Bearer ${admin.body.token}`).send({ password: "a-brand-new-password" }).expect(200);
    await request(instance).get("/api/v1/auth/me").set("Authorization", `Bearer ${before.body.token}`).expect(401);
    const after = await request(instance).post("/api/v1/auth/login").send({ username: "operator", password: "a-brand-new-password" }).expect(200);
    await request(instance).get("/api/v1/auth/me").set("Authorization", `Bearer ${after.body.token}`).expect(200);
  });

  it("limits failed sign-ins and audits them", async () => {
    const instance = app(); await request(instance).post("/api/v1/auth/bootstrap").send({ username: "admin", password: "this-is-a-strong-password" });
    for (let attempt = 0; attempt < 9; attempt += 1) await request(instance).post("/api/v1/auth/login").send({ username: "admin", password: "not-the-right-password" }).expect(401);
    const limited = await request(instance).post("/api/v1/auth/login").send({ username: "admin", password: "this-is-a-strong-password" }).expect(200);
    expect(limited.body.token).toEqual(expect.any(String));
    await request(instance).post("/api/v1/auth/login").send({ username: "admin", password: "not-the-right-password" }).expect(401);
    const blocked = await request(instance).post("/api/v1/auth/login").send({ username: "admin", password: "this-is-a-strong-password" }).expect(429);
    expect(blocked.body.error.code).toBe("RATE_LIMITED");
    expect(instanceStore(instance).recentAudit(50, "auth.login_failed")).toHaveLength(10);
  });

  it("keeps internal error details out of responses", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(classifyError(new TypeError("Cannot read properties of undefined (reading 'id')"))).toEqual({ status: 500, code: "INTERNAL_ERROR", message: "Unexpected server error." });
    expect(classifyError(Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR" }))).toMatchObject({ message: "Unexpected server error." });
    expect(classifyError(new Error("Casambi bridge command 'connect' timed out."))).toMatchObject({ status: 500, message: "Casambi bridge command 'connect' timed out." });
    expect(classifyError(new Error("The Casambi bridge is busy; try again in a moment."))).toMatchObject({ status: 503, code: "BUSY" });
    expect(logged).toHaveBeenCalledTimes(2); logged.mockRestore();
  });

  it("opens the event stream with a one-minute ticket, never with the session token in the URL", async () => {
    const instance = app(); const admin = await request(instance).post("/api/v1/auth/bootstrap").send({ username: "admin", password: "this-is-a-strong-password" });
    await request(instance).get(`/api/v1/events?ticket=${admin.body.token}`).expect(401);
    await request(instance).get(`/api/v1/events?access_token=${admin.body.token}`).expect(401);
    const ticket = await request(instance).post("/api/v1/auth/event-ticket").set("Authorization", `Bearer ${admin.body.token}`).expect(200);
    expect(ticket.body.expiresInSeconds).toBe(60);
    // A ticket is not a session token.
    await request(instance).get("/api/v1/network").set("Authorization", `Bearer ${ticket.body.ticket}`).expect(401);
    const stream = await new Promise<number>((resolve, reject) => {
      const call = request(instance).get(`/api/v1/events?ticket=${encodeURIComponent(ticket.body.ticket)}`).buffer(false)
        .parse((response, callback) => { resolve(response.statusCode ?? 0); (response as unknown as { destroy(): void }).destroy(); callback(null, null); });
      call.end(error => { if (error && !String(error).includes("aborted") && !String(error).includes("socket hang up")) reject(error); });
    });
    expect(stream).toBe(200);
  });

  it("answers unknown API paths and malformed bodies in JSON", async () => {
    const instance = app();
    const missing = await request(instance).get("/api/v1/netwerk").expect(404);
    expect(missing.body.error.code).toBe("NOT_FOUND");
    const malformed = await request(instance).post("/api/v1/auth/login").set("Content-Type", "application/json").send("{not json").expect(400);
    expect(malformed.body.error.code).toBe("INVALID_JSON");
  });

  it("assigns many units to a room in one request and keeps their custom names", async () => {
    const instance = app(); const admin = await request(instance).post("/api/v1/auth/bootstrap").send({ username: "admin", password: "this-is-a-strong-password" });
    const auth = { Authorization: `Bearer ${admin.body.token}` };
    const room = await request(instance).post("/api/v1/admin/rooms").set(auth).send({ name: "Hall" }).expect(201);
    await request(instance).put("/api/v1/admin/devices/2/metadata").set(auth).send({ customName: "Desk" }).expect(204);
    await request(instance).put("/api/v1/admin/devices/room").set(auth).send({ unitIds: [1, 2, 3], roomId: room.body.id }).expect(204);
    expect(instanceStore(instance).getUnitMetadata().sort((a, b) => a.unitId - b.unitId)).toEqual([
      { unitId: 1, customName: null, roomId: room.body.id }, { unitId: 2, customName: "Desk", roomId: room.body.id }, { unitId: 3, customName: null, roomId: room.body.id },
    ]);
    const missing = await request(instance).put("/api/v1/admin/devices/room").set(auth).send({ unitIds: [4], roomId: 999 }).expect(422);
    expect(missing.body.error.message).toBe("A referenced item does not exist.");
    expect(instanceStore(instance).getUnitMetadata().some(metadata => metadata.unitId === 4)).toBe(false);
  });

  it("runs the system check for admins and gives a diagnostics file without secrets", async () => {
    const instance = app(); const admin = await request(instance).post("/api/v1/auth/bootstrap").send({ username: "admin", password: "this-is-a-strong-password" });
    const auth = { Authorization: `Bearer ${admin.body.token}` };
    await request(instance).put("/api/v1/admin/config").set(auth).send({ networkAddress: "AB:CD:EF:01:23:45", networkPassword: "very-secret-network-pass" }).expect(200);
    await request(instance).post("/api/v1/admin/users").set(auth).send({ username: "operator", password: "another-strong-password", role: "user" }).expect(201);
    const user = await request(instance).post("/api/v1/auth/login").send({ username: "operator", password: "another-strong-password" });
    await request(instance).get("/api/v1/admin/diagnostics").set("Authorization", `Bearer ${user.body.token}`).expect(403);

    const report = await request(instance).get("/api/v1/admin/diagnostics").set(auth).expect(200);
    expect(report.body.checks).toEqual(expect.arrayContaining([expect.objectContaining({ id: "casambi-config", status: "info", detail: "Not connected." })]));
    expect(report.body.versions.node).toBe(process.version);

    const bundle = await request(instance).get("/api/v1/admin/diagnostics/bundle").set(auth).expect(200);
    expect(bundle.headers["content-disposition"]).toMatch(/^attachment; filename="casambi-diagnostics-[\d-]+T[\d-]+\.json"$/);
    expect(bundle.body).toMatchObject({ configuration: { networkAddress: "AB:CD:EF:01:23:45", hasNetworkPassword: true }, audit: expect.any(Array) });
    expect(JSON.stringify(bundle.body)).not.toContain("very-secret-network-pass");
  });

  it("creates a room for each Casambi group and places its units, once", async () => {
    const groups = [{ id: 1, name: "Kitchen", unitIds: [1, 2] }, { id: 2, name: "Downstairs", unitIds: [2, 3, 4] }, { id: 3, name: " ", unitIds: [5] }];
    const instance = app({ groups }); const admin = await request(instance).post("/api/v1/auth/bootstrap").send({ username: "admin", password: "this-is-a-strong-password" });
    const auth = { Authorization: `Bearer ${admin.body.token}` };
    const hall = await request(instance).post("/api/v1/admin/rooms").set(auth).send({ name: "Hall" }).expect(201);
    await request(instance).put("/api/v1/admin/devices/room").set(auth).send({ unitIds: [4], roomId: hall.body.id }).expect(204);

    const first = await request(instance).post("/api/v1/admin/rooms/from-groups").set(auth).expect(201);
    expect(first.body).toMatchObject({ created: 3, assigned: 4 });
    const roomOf = (unitId: number) => first.body.rooms.find((room: { id: number }) => room.id === instanceStore(instance).getUnitMetadata().find(metadata => metadata.unitId === unitId)?.roomId)?.name;
    expect([1, 2, 3, 4, 5].map(roomOf)).toEqual(["Kitchen", "Kitchen", "Downstairs", "Hall", "Group 3"]);

    const again = await request(instance).post("/api/v1/admin/rooms/from-groups").set(auth).expect(201);
    expect(again.body).toMatchObject({ created: 0, assigned: 0 });
    await request(app()).post("/api/v1/admin/rooms/from-groups").expect(401);
  });

  it("refuses to create rooms from groups when the network has none", async () => {
    const instance = app(); const admin = await request(instance).post("/api/v1/auth/bootstrap").send({ username: "admin", password: "this-is-a-strong-password" });
    const refused = await request(instance).post("/api/v1/admin/rooms/from-groups").set("Authorization", `Bearer ${admin.body.token}`).expect(422);
    expect(refused.body.error.message).toBe("No Casambi groups found; a connected network with groups is required.");
  });

  it("requests updates through a file only when the updater is installed, and reports its status", async () => {
    let state = "";
    const instance = app({ updaterState: folder => (state = join(folder, "updater")) });
    const admin = await request(instance).post("/api/v1/auth/bootstrap").send({ username: "admin", password: "this-is-a-strong-password" });
    const auth = { Authorization: `Bearer ${admin.body.token}` };
    expect((await request(instance).get("/api/v1/admin/update").set(auth).expect(200)).body).toMatchObject({ supported: false, status: {} });
    expect((await request(instance).post("/api/v1/admin/update/check").set(auth).expect(422)).body.error.message).toContain("deploy/install.sh must run once");

    mkdirSync(state);
    writeFileSync(join(state, "status.json"), JSON.stringify({ state: "available", behind: 2, changes: ["Second", "Third"] }));
    await request(instance).post("/api/v1/admin/update/apply").set(auth).expect(202);
    const status = await request(instance).get("/api/v1/admin/update").set(auth).expect(200);
    expect(status.body).toMatchObject({ supported: true, pending: { check: false, apply: true }, status: { state: "available", behind: 2, changes: ["Second", "Third"] } });
    expect(instanceStore(instance).recentAudit(5, "update.").map(entry => entry.action)).toEqual(["update.apply_requested"]);

    writeFileSync(join(state, "status.json"), JSON.stringify({ state: "updating" }));
    expect((await request(instance).post("/api/v1/admin/update/apply").set(auth).expect(422)).body.error.message).toBe("An update is already running; it must finish first.");
  });

  it("requests a port or proxy change through a file only when the settings helper is installed", async () => {
    let state = "";
    const instance = app({ updaterState: folder => (state = join(folder, "updater")) });
    const admin = await request(instance).post("/api/v1/auth/bootstrap").send({ username: "admin", password: "this-is-a-strong-password" });
    const auth = { Authorization: `Bearer ${admin.body.token}` };
    expect((await request(instance).get("/api/v1/admin/server-settings").set(auth).expect(200)).body).toMatchObject({ supported: false, pending: false, status: {}, readOnly: { envFile: "/etc/casambi-bt-webui.env" } });
    expect((await request(instance).put("/api/v1/admin/server-settings").set(auth).send({ port: 8080, trustProxy: false }).expect(422)).body.error.message).toContain("deploy/install.sh must run once");

    const requestDirectory = join(state, "..", "data", "settings");
    mkdirSync(requestDirectory, { recursive: true }); mkdirSync(state, { recursive: true });
    await request(instance).put("/api/v1/admin/server-settings").set(auth).send({ port: 80, trustProxy: false }).expect(422);
    await request(instance).put("/api/v1/admin/server-settings").set(auth).send({ port: 8080, trustProxy: true, extra: 1 }).expect(202);
    expect(JSON.parse(readFileSync(join(requestDirectory, "request.json"), "utf8"))).toEqual({ port: 8080, trustProxy: true });
    expect((await request(instance).put("/api/v1/admin/server-settings").set(auth).send({ port: 8081, trustProxy: false }).expect(422)).body.error.message).toBe("A settings change is already being applied; it must finish first.");
    writeFileSync(join(state, "settings-status.json"), JSON.stringify({ state: "applying", message: "Restarting on port 8080…" }));
    expect((await request(instance).get("/api/v1/admin/server-settings").set(auth).expect(200)).body).toMatchObject({ supported: true, pending: true, status: { state: "applying" } });
    expect(instanceStore(instance).recentAudit(5, "server_settings.").map(entry => entry.action)).toEqual(["server_settings.requested"]);
  });

  it("lists notifications for administrators, marks them read, and keeps the webhook URL to itself", async () => {
    const instance = app(); const store = instanceStore(instance);
    const admin = await request(instance).post("/api/v1/auth/bootstrap").send({ username: "admin", password: "this-is-a-strong-password" });
    const auth = { Authorization: `Bearer ${admin.body.token}` };
    store.addNotification({ kind: "timer.failed", severity: "warning", title: 'Timer "Morning" failed', message: "Not connected." });
    expect((await request(instance).get("/api/v1/admin/notifications").set(auth).expect(200)).body).toMatchObject({ unread: 1, notifications: [{ title: 'Timer "Morning" failed', readAt: null }], webhook: { configured: false, host: null } });
    await request(instance).post("/api/v1/admin/notifications/read").set(auth).expect(204);
    await request(instance).put("/api/v1/admin/notifications/webhook").set(auth).send({ url: "file:///etc/passwd" }).expect(422);
    await request(instance).put("/api/v1/admin/notifications/webhook").set(auth).send({ url: "https://ha.example.test/api/webhook/secret-id" }).expect(204);
    const listed = await request(instance).get("/api/v1/admin/notifications").set(auth).expect(200);
    expect(listed.body).toMatchObject({ unread: 0, webhook: { configured: true, host: "ha.example.test" } });
    expect(JSON.stringify(listed.body)).not.toContain("secret-id");
    expect((await request(instance).post("/api/v1/admin/notifications/test").set(auth).expect(200)).body).toEqual({ ok: false, status: 502, message: "The webhook answered 502." });
    await request(instance).put("/api/v1/admin/notifications/webhook").set(auth).send({ url: "" }).expect(204);
    expect((await request(instance).post("/api/v1/admin/notifications/test").set(auth).expect(422)).body.error.message).toBe("A webhook URL is required for a test.");
  });

  it("downloads an encrypted backup and restores it, ending every session", async () => {
    const instance = app(); const admin = await request(instance).post("/api/v1/auth/bootstrap").send({ username: "admin", password: "this-is-a-strong-password" });
    const auth = { Authorization: `Bearer ${admin.body.token}` };
    await request(instance).post("/api/v1/admin/rooms").set(auth).send({ name: "Kitchen" }).expect(201);
    await request(instance).post("/api/v1/admin/backup").set(auth).send({ passphrase: "short" }).expect(422);
    const backup = await request(instance).post("/api/v1/admin/backup").set(auth).send({ passphrase: "keep this passphrase safe" }).buffer(true).parse((response, done) => { const chunks: Buffer[] = []; response.on("data", (chunk: Buffer) => chunks.push(chunk)); response.on("end", () => done(null, Buffer.concat(chunks))); }).expect(200);
    expect(backup.headers["content-disposition"]).toMatch(/^attachment; filename="casambi-backup-\d{4}-\d{2}-\d{2}\.json"$/);
    await request(instance).post("/api/v1/admin/rooms").set(auth).send({ name: "Made after the backup" }).expect(201);

    const upload = (passphrase: string) => request(instance).post("/api/v1/admin/restore").set(auth).set("Content-Type", "application/octet-stream").set("X-Backup-Passphrase", passphrase).send(backup.body as Buffer);
    expect((await upload("not the passphrase").expect(422)).body.error.message).toBe("The backup passphrase is invalid, or the file is damaged.");
    const restored = await upload("keep this passphrase safe").expect(200);
    expect(restored.body).toMatchObject({ restored: { users: 1, rooms: 1 }, signInAgain: true });

    await request(instance).get("/api/v1/auth/me").set(auth).expect(401);
    const again = await request(instance).post("/api/v1/auth/login").send({ username: "admin", password: "this-is-a-strong-password" }).expect(200);
    const rooms = await request(instance).get("/api/v1/rooms").set("Authorization", `Bearer ${again.body.token}`).expect(200);
    expect(rooms.body.map((room: { name: string }) => room.name)).toEqual(["Kitchen"]);
    expect(instanceStore(instance).recentAudit(1)[0].action).toBe("auth.login");
  });
});
