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
  const service = { snapshot: async () => ({ connected: false, network: null, units: [], groups: [], scenes: [], rooms: [], updatedAt: new Date().toISOString() }), control: async () => ({ connected: false, network: null, units: [], groups: [], scenes: [], updatedAt: new Date().toISOString() }), discover: async () => [], connect: async () => ({}), disconnect: async () => ({}), saveConfiguration: () => undefined } as unknown as CasambiService;
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
});
