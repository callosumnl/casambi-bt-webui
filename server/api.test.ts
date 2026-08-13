import express from "express";
import request from "supertest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { createCasambiApi } from "./api";
import { CasambiService } from "./casambi/service";
import { EventHub } from "./events";
import { DurableScheduler } from "./scheduler";
import { LocalStore } from "./store";

const folders: string[] = [];
function app() {
  const folder = mkdtempSync(join(tmpdir(), "casambi-api-")); folders.push(folder);
  const store = new LocalStore(join(folder, "state.db"), "test-key"); const events = new EventHub();
  const service = { snapshot: async () => ({ connected: false, network: null, units: [], groups: [], scenes: [], rooms: [], updatedAt: new Date().toISOString() }), control: async () => ({ connected: false, network: null, units: [], groups: [], scenes: [], updatedAt: new Date().toISOString() }), discover: async () => [], connect: async () => ({}), disconnect: async () => ({}), saveConfiguration: (input: Record<string, unknown>) => store.saveCasambiConfig({ ...store.getCasambiConfig(), ...input }) } as unknown as CasambiService;
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
    const response = await request(instance).post("/api/v1/schedules").set(auth).send({ name: "Sunset", timezone: "Europe/Amsterdam", solar: { event: "sunset", offsetMinutes: -15 }, enabled: true, command: { targetType: "network", operation: "on" } }).expect(201);
    expect(response.body.solar).toEqual({ event: "sunset", offsetMinutes: -15 });
    expect(new Date(response.body.nextRunAt).getTime()).toBeGreaterThan(Date.now());
  });
});
