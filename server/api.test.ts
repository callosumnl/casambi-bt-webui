import express from "express";
import request from "supertest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { classifyError, createCasambiApi } from "./api";
import { CasambiService } from "./casambi/service";
import { EventHub } from "./events";
import { DurableScheduler } from "./scheduler";
import { LocalStore } from "./store";

const folders: string[] = [];
function app() {
  const folder = mkdtempSync(join(tmpdir(), "casambi-api-")); folders.push(folder);
  const store = new LocalStore(join(folder, "state.db"), "test-key"); const events = new EventHub();
  const service = { captureLightScene: (name: string, scope: { type: "group" | "room" | "network"; id: number | null }) => store.createLightScene(name, scope, [{ unitId: 1, level: 128, temperature: null }]), recaptureLightScene: (id: number) => store.updateLightScene(id, { lamps: [{ unitId: 1, level: 64, temperature: null }] }), snapshot: async () => ({ connected: false, network: null, units: [], groups: [], scenes: [], rooms: [], updatedAt: new Date().toISOString() }), workerState: () => ({ running: true, pid: 4242, busy: null, lastAnswerAt: null, restarts: 0 }), restartWorker: () => ({ running: false, pid: null, busy: null, lastAnswerAt: null, restarts: 1 }), recentSwitchActivity: () => [{ unitId: 2, button: 4, trigger: "tap", raw: {}, at: "2026-09-24T19:17:33.564Z" }], cachedSnapshot: () => ({ connected: false, network: null, units: [], groups: [], scenes: [], rooms: [], updatedAt: new Date().toISOString() }), control: async () => ({ connected: false, network: null, units: [], groups: [], scenes: [], updatedAt: new Date().toISOString() }), discover: async () => [], connect: async () => ({}), disconnect: async () => ({}), saveConfiguration: (input: Record<string, unknown>) => store.saveCasambiConfig({ ...store.getCasambiConfig(), ...input }) } as unknown as CasambiService;
  const scheduler = { reload: () => undefined } as unknown as DurableScheduler;
  const instance = express(); instance.use(express.json()); instance.use("/api/v1", createCasambiApi({ store, service, events, scheduler })); return instance;
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

  it("creates a reusable away-date set and attaches it to a timer", async () => {
    const instance = app();
    const admin = await request(instance).post("/api/v1/auth/bootstrap").send({ username: "admin", password: "this-is-a-strong-password" });
    const auth = { Authorization: `Bearer ${admin.body.token}` };
    const set = await request(instance).post("/api/v1/admin/away-date-sets").set(auth).send({ name: "Summer break", dates: ["2026-08-17", "2026-08-18"] }).expect(201);
    const timer = await request(instance).post("/api/v1/schedules").set(auth).send({ name: "Welcome", cronExpression: "0 18 * * *", timezone: "Europe/Amsterdam", awayDateSetId: set.body.id, enabled: true, command: { targetType: "network", operation: "on" } }).expect(201);
    expect(timer.body.awayDateSet).toMatchObject({ id: set.body.id, name: "Summer break", dates: ["2026-08-17", "2026-08-18"] });
    expect((await request(instance).get("/api/v1/away-date-sets").set(auth).expect(200)).body).toHaveLength(1);
  });
});
