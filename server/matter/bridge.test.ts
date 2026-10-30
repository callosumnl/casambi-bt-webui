import express from "express";
import request from "supertest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { apiErrorHandler, createCasambiApi } from "../api";
import { CasambiService } from "../casambi/service";
import { EventHub } from "../events";
import { DurableScheduler } from "../scheduler";
import { LocalStore } from "../store";
import { DEFAULT_MATTER_NAME, DEFAULT_MATTER_PORT, DEFAULT_PRODUCT_ID, DEFAULT_VENDOR_ID, MatterBridge } from "./bridge";
import { fabricOwner, generateNodeId, generatePasscode, isValidPasscode, matterLabel } from "./identity";
import { shortId, startError } from "./runtime";
import type { MatterFabric, MatterHost, MatterNodeConfig, MatterRuntime } from "./runtime";

const folders: string[] = [];
afterEach(() => folders.splice(0).forEach(folder => rmSync(folder, { recursive: true, force: true })));
function newStore(): LocalStore {
  const folder = mkdtempSync(join(tmpdir(), "casambi-matter-")); folders.push(folder);
  return new LocalStore(join(folder, "state.db"), "test-key");
}

/** An in-memory stand-in for matter.js that records nodes and lets a test commission one. */
function fakeRuntime(options: { busyPorts?: number[]; failStart?: string } = {}) {
  const created: MatterNodeConfig[] = [];
  const hosts: Array<MatterHost & { commission: (vendorId: number) => void; running: boolean; windows: number }> = [];
  const runtime: MatterRuntime = {
    async create(config) {
      created.push(config);
      let fabrics: MatterFabric[] = [];
      const listeners: Array<(index: number, action: "added" | "deleted" | "updated") => void> = [];
      const host = {
        running: false, windows: 0,
        async start() { if (options.failStart) throw new Error(options.failStart); host.running = true; },
        async close() { host.running = false; },
        pairingCodes: () => ({ manualPairingCode: `3488${config.passcode}`.slice(0, 11), qrPairingCode: `MT:${config.discriminator}` }),
        commissioned: () => fabrics.length > 0,
        fabrics: () => fabrics,
        async openPairingWindow() { host.windows += 1; },
        async removeFabric(index: number) { fabrics = fabrics.filter(fabric => fabric.index !== index); listeners.forEach(listener => listener(index, "deleted")); },
        async reset() { fabrics = []; },
        onFabricsChanged: (listener: (index: number, action: "added" | "deleted" | "updated") => void) => { listeners.push(listener); },
        aggregator: () => { throw new Error("not in these tests"); },
        commission(vendorId: number) { const index = fabrics.length + 1; fabrics = [...fabrics, { index, label: "", vendorId }]; listeners.forEach(listener => listener(index, "added")); },
      };
      hosts.push(host as never);
      return host as never;
    },
    portAvailable: async port => !(options.busyPorts ?? []).includes(port),
  };
  return { runtime, created, hosts };
}

let clock = 1_000_000;
const bridgeFor = (store: LocalStore, runtime: MatterRuntime) => new MatterBridge(store, runtime, () => clock);
const on = { enabled: true, name: "Casambi", port: 5540, vendorId: DEFAULT_VENDOR_ID, productId: DEFAULT_PRODUCT_ID };

describe("Matter identity", () => {
  it("makes valid setup passcodes and names", () => {
    for (let i = 0; i < 200; i += 1) expect(isValidPasscode(generatePasscode())).toBe(true);
    expect(isValidPasscode(12345678)).toBe(false);
    expect(isValidPasscode(11111111)).toBe(false);
    expect(matterLabel("  Huis   (licht)  ", "x")).toBe("Huis (licht)");
    expect(matterLabel("a".repeat(40), "x")).toHaveLength(32);
    expect(fabricOwner(0x6006, "")).toBe("Google Home");
    expect(fabricOwner(0x1234, "")).toBe("Vendor 0x1234");
    expect(fabricOwner(0x1384, "")).toBe("iPhone (Apple keychain)");
  });
});

describe("Matter bridge", () => {
  it("stays off until turned on, then runs with a stable identity and shows the code until it is paired", async () => {
    const store = newStore(); const { runtime, created, hosts } = fakeRuntime();
    const bridge = bridgeFor(store, runtime);
    await bridge.start();
    expect(created).toEqual([]);
    expect(bridge.status()).toMatchObject({ enabled: false, name: DEFAULT_MATTER_NAME, port: DEFAULT_MATTER_PORT, state: "disabled", manualPairingCode: null });
    const running = await bridge.update(on, "admin");
    expect(running).toMatchObject({ state: "running", commissioned: false, fabrics: [] });
    expect(running.manualPairingCode).not.toBeNull();
    hosts[0].commission(0x6006);
    expect(bridge.status()).toMatchObject({ commissioned: true, fabrics: [{ index: 1, owner: "Google Home" }], manualPairingCode: null });
    // A restart keeps the node id, passcode, and discriminator, so Google Home keeps the bridge.
    await bridge.stop();
    await bridgeFor(store, runtime).start();
    expect(created[1]).toEqual(created[0]);
    const audit = store.auditSince(0, ["matter.settings_changed", "matter.fabric_added"]);
    expect(audit.map(entry => entry.action)).toEqual(["matter.settings_changed", "matter.fabric_added"]);
    expect(JSON.stringify(audit)).not.toContain(String(created[0].passcode));
  });

  it("opens a pairing window for another app, removes one app, and resets", async () => {
    const store = newStore(); const { runtime, hosts } = fakeRuntime();
    const bridge = bridgeFor(store, runtime);
    await bridge.update(on, "admin");
    await expect(bridge.openPairingWindow("admin")).rejects.toThrow("not paired yet");
    hosts[0].commission(0x6006);
    const open = await bridge.openPairingWindow("admin");
    expect(hosts[0].windows).toBe(1);
    expect(open.pairingWindowUntil).not.toBeNull();
    expect(open.manualPairingCode).not.toBeNull();
    clock += 16 * 60_000;
    expect(bridge.status()).toMatchObject({ pairingWindowUntil: null, manualPairingCode: null });
    hosts[0].commission(0x1349);
    expect((await bridge.removeFabric(2, "admin")).fabrics).toEqual([{ index: 1, owner: "Google Home", vendorId: 0x6006 }]);
    await expect(bridge.removeFabric(9, "admin")).rejects.toThrow("does not exist");
    expect(await bridge.reset("admin")).toMatchObject({ commissioned: false, fabrics: [] });
    expect(store.auditSince(0, ["matter.pairing_window_opened", "matter.fabric_removed", "matter.reset"]).map(entry => entry.action)).toEqual(["matter.pairing_window_opened", "matter.fabric_removed", "matter.reset"]);
  });

  it("reports a busy port or a failed start instead of crashing", async () => {
    const store = newStore();
    expect(await bridgeFor(store, fakeRuntime({ busyPorts: [5540] }).runtime).update(on, "admin")).toMatchObject({ state: "failed", error: "UDP port 5540 is already in use." });
    expect(await bridgeFor(store, fakeRuntime({ failStart: "no IPv6" }).runtime).update(on, "admin")).toMatchObject({ state: "failed", error: "no IPv6" });
    await expect(bridgeFor(store, fakeRuntime().runtime).reset("admin")).rejects.toThrow("must be turned on");
    expect(await bridgeFor(store, fakeRuntime().runtime).update({ ...on, enabled: false }, "admin")).toMatchObject({ state: "disabled", error: null });
  });

  it("keeps its settings apart from HomeKit's", async () => {
    const store = newStore();
    await bridgeFor(store, fakeRuntime().runtime).update(on, "admin");
    expect(store.appSetting("homekit.enabled")).toBeNull();
    expect(store.appSetting("matter.enabled")).toBe("true");
  });
});

describe("Matter admin API", () => {
  function app(withMatter = true) {
    const store = newStore();
    const fake = fakeRuntime();
    const matter = withMatter ? bridgeFor(store, fake.runtime) : undefined;
    const instance = express(); instance.use(express.json());
    instance.use("/api/v1", createCasambiApi({ store, service: {} as CasambiService, events: new EventHub(), scheduler: { reload: () => undefined } as unknown as DurableScheduler, matter }));
    instance.use("/api/v1", apiErrorHandler);
    return { instance, fake };
  }
  const signIn = async (instance: express.Express) => {
    const admin = await request(instance).post("/api/v1/auth/bootstrap").send({ username: "admin", password: "this-is-a-strong-password" }).expect(201);
    return { Authorization: `Bearer ${admin.body.token}` };
  };

  it("turns the bridge on and returns a QR code, then manages connected apps", async () => {
    const { instance, fake } = app(); const auth = await signIn(instance);
    expect((await request(instance).get("/api/v1/admin/matter").set(auth).expect(200)).body).toMatchObject({ state: "disabled", qrSvg: null });
    const running = await request(instance).put("/api/v1/admin/matter").set(auth).send(on).expect(200);
    expect(running.body.qrSvg).toContain("<svg");
    await request(instance).put("/api/v1/admin/matter").set(auth).send({ ...on, name: "" }).expect(422);
    fake.hosts[0].commission(0x6006);
    await request(instance).post("/api/v1/admin/matter/pairing-window").set(auth).expect(200);
    expect((await request(instance).delete("/api/v1/admin/matter/fabrics/1").set(auth).expect(200)).body.fabrics).toEqual([]);
    await request(instance).delete("/api/v1/admin/matter/fabrics/1").set(auth).expect(404);
    await request(instance).post("/api/v1/admin/matter/reset").set(auth).expect(200);
  });

  it("refuses when the server has no Matter bridge", async () => {
    const { instance } = app(false); const auth = await signIn(instance);
    await request(instance).get("/api/v1/admin/matter").set(auth).expect(422);
  });
});

describe("Matter runtime helpers", () => {
  it("fits ids into Matter's 32 characters and reports the real cause of a failed start", () => {
    expect(shortId(generateNodeId())).toMatch(/^[0-9a-f]{32}$/);
    const failed = Object.assign(new Error("Behaviors have errors"), { errors: [new Error("Error initializing node.basicInformation Error: Validating uniqueId: too long")] });
    expect(startError(failed)).toBe("Validating uniqueId: too long");
    expect(startError(new Error("no IPv6"))).toBe("no IPv6");
  });
});
