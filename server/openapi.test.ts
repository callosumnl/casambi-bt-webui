import express from "express";
import request from "supertest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { createCasambiApi } from "./api";
import { CasambiService } from "./casambi/service";
import { EventHub } from "./events";
import { documentedOperations, openApiDocument } from "./openapi";
import { DurableScheduler } from "./scheduler";
import { LocalStore } from "./store";

const folders: string[] = [];
afterEach(() => folders.splice(0).forEach(folder => rmSync(folder, { recursive: true, force: true })));

function setup() {
  const folder = mkdtempSync(join(tmpdir(), "casambi-openapi-")); folders.push(folder);
  const store = new LocalStore(join(folder, "state.db"), "test-key");
  // Authentication runs before any handler, so the service is never reached in these tests.
  const router = createCasambiApi({ store, service: {} as CasambiService, events: new EventHub(), scheduler: { reload: () => undefined } as unknown as DurableScheduler });
  const app = express(); app.use(express.json()); app.use("/api/v1", router);
  return { app, router, store };
}

type Spec = { paths: Record<string, Record<string, { "x-required-role": string; security: unknown[]; responses: Record<string, unknown> }>>; components: { schemas: Record<string, unknown> } };
const spec = () => openApiDocument() as unknown as Spec;

describe("OpenAPI document", () => {
  it("documents exactly the routes the API registers", () => {
    const { router } = setup();
    const registered = (router.stack as Array<{ route?: { path: string; methods: Record<string, boolean> } }>)
      .filter(layer => layer.route)
      .flatMap(layer => Object.keys(layer.route!.methods).map(method => `${method.toUpperCase()} ${layer.route!.path.replace(/:(\w+)/g, "{$1}")}`));
    expect(new Set(documentedOperations)).toEqual(new Set(registered));
    expect(documentedOperations).toHaveLength(registered.length);
  });

  it("states each route's access rule as the API enforces it", async () => {
    const { app } = setup();
    const admin = await request(app).post("/api/v1/auth/bootstrap").send({ username: "admin", password: "this-is-a-strong-password" }).expect(201);
    await request(app).post("/api/v1/admin/users").set({ Authorization: `Bearer ${admin.body.token}` }).send({ username: "operator", password: "another-strong-password", role: "user" }).expect(201);
    const user = await request(app).post("/api/v1/auth/login").send({ username: "operator", password: "another-strong-password" }).expect(200);
    for (const [path, methods] of Object.entries(spec().paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        const url = `/api/v1${path.replace("{id}", "1")}`;
        const anonymous = await (request(app) as unknown as Record<string, (url: string) => request.Test>)[method](url);
        const role = operation["x-required-role"];
        if (role === "public") expect(anonymous.status, `${method} ${path}`).not.toBe(401);
        else expect(anonymous.status, `${method} ${path}`).toBe(401);
        if (role === "admin") {
          const asUser = await (request(app) as unknown as Record<string, (url: string) => request.Test>)[method](url).set({ Authorization: `Bearer ${user.body.token}` });
          expect(asUser.status, `${method} ${path} as user`).toBe(403);
        }
        expect(operation.security.length === 0, `${method} ${path} security`).toBe(role === "public");
      }
    }
  });

  it("resolves every schema reference and serves the document without signing in", async () => {
    const document = spec();
    const references = Array.from(JSON.stringify(document).matchAll(/"#\/components\/schemas\/([A-Za-z]+)"/g), match => match[1]);
    expect(references.length).toBeGreaterThan(50);
    for (const name of references) expect(document.components.schemas, name).toHaveProperty(name);
    const { app } = setup();
    const served = await request(app).get("/api/v1/openapi.json").expect(200);
    expect(served.body).toMatchObject({ openapi: "3.1.0", info: { title: "Casambi BT WebGUI REST API" } });
    expect(served.body.components.schemas.ControlRequest.properties.targetType.enum).toContain("local_scene");
  });
});
