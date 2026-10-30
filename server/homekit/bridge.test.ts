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
import { DEFAULT_HOMEKIT_NAME, DEFAULT_HOMEKIT_PORT, defaultAdvertiser, HapHost, HapRuntime, HomeKitBridge } from "./bridge";

const folders: string[] = [];
afterEach(() => folders.splice(0).forEach(folder => rmSync(folder, { recursive: true, force: true })));

function newStore(): LocalStore {
  const folder = mkdtempSync(join(tmpdir(), "casambi-homekit-")); folders.push(folder);
  return new LocalStore(join(folder, "state.db"), "test-key");
}

/** An in-memory stand-in for HAP-NodeJS that records what was published and lets a test pair a controller. */
function fakeRuntime(options: { busyPorts?: number[]; failPublish?: string } = {}) {
  const stored = new Set<string>();
  const published: Array<{ name: string; username: string; pincode: string; setupId: string; port: number; advertiser: string }> = [];
  const hosts: Array<HapHost & { pair: () => void; live: boolean }> = [];
  const runtime: HapRuntime = {
    create(name, username) {
      const listeners: Record<string, Array<() => void>> = {};
      let pairings = 0;
      const host = {
        live: false,
        async publish(info: Parameters<HapHost["publish"]>[0]) {
          if (options.failPublish) throw new Error(options.failPublish);
          stored.add(username); published.push({ name, username, pincode: info.pincode, setupId: info.setupId, port: info.port, advertiser: info.advertiser });
          host.live = true; listeners.advertised?.forEach(listener => listener());
        },
        async unpublish() { host.live = false; },
        addAccessories() { /* No lights in these tests. */ },
        removeAccessories() { /* No lights in these tests. */ },
        async destroy() { host.live = false; stored.delete(username); },
        setupUri: () => (host.live ? `X-HM://TEST${username}` : null),
        pairings: () => pairings,
        on(event: string, listener: () => void) { (listeners[event] ??= []).push(listener); },
        pair() { pairings += 1; listeners.paired?.forEach(listener => listener()); },
      };
      hosts.push(host);
      return host;
    },
    hasStoredIdentity: username => stored.has(username),
    forgetIdentity: username => { stored.delete(username); },
    portAvailable: async port => !(options.busyPorts ?? []).includes(port),
  };
  return { runtime, published, hosts, stored };
}

const bridgeFor = (store: LocalStore, runtime: HapRuntime) => new HomeKitBridge(store, runtime, { appPort: () => 3000, advertiser: "ciao" });
const auditActions = (store: LocalStore) => store.auditSince(0, ["homekit.settings_changed", "homekit.paired", "homekit.pairing_reset", "homekit.publish_failed"]);

describe("HomeKit bridge", () => {
  it("stays off until an administrator turns it on, with a stable identity", async () => {
    const store = newStore(); const { runtime, published } = fakeRuntime();
    const bridge = bridgeFor(store, runtime);
    await bridge.start();
    expect(published).toEqual([]);
    const status = bridge.status();
    expect(status).toMatchObject({ enabled: false, name: DEFAULT_HOMEKIT_NAME, port: DEFAULT_HOMEKIT_PORT, state: "disabled", setupUri: null, pairings: 0 });
    expect(status.pincode).toMatch(/^\d{3}-\d{2}-\d{3}$/);
    expect(bridge.status().pincode).toBe(status.pincode);
  });

  it("publishes, keeps its device id across restarts, and records pairings", async () => {
    const store = newStore(); const { runtime, published, hosts } = fakeRuntime();
    const bridge = bridgeFor(store, runtime);
    const status = await bridge.update({ enabled: true, name: "Huis (licht)!", port: 51900 }, "admin");
    expect(status).toMatchObject({ enabled: true, name: "Huis licht", port: 51900, state: "published", advertised: true, advertiser: "ciao" });
    expect(status.setupUri).toMatch(/^X-HM:\/\//);
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ name: "Huis licht", port: 51900, pincode: status.pincode });
    hosts[0].pair();
    expect(bridge.status().pairings).toBe(1);

    await bridge.stop();
    expect(hosts[0].live).toBe(false);
    const restarted = bridgeFor(store, runtime);
    await restarted.start();
    expect(published).toHaveLength(2);
    expect(published[1].username).toBe(published[0].username);
    expect(published[1].pincode).toBe(published[0].pincode);
    const actions = auditActions(store);
    expect(actions.map(entry => entry.action)).toEqual(["homekit.settings_changed", "homekit.paired"]);
    expect(JSON.stringify(actions)).not.toContain(status.pincode);
  });

  it("starts over with a new device id when HAP's keys for the old one are gone", async () => {
    const store = newStore(); const first = fakeRuntime();
    await bridgeFor(store, first.runtime).update({ enabled: true, name: "Casambi", port: 51900 }, "admin");
    // A restore on another Pi: the settings came along, HAP's storage folder did not.
    const second = fakeRuntime();
    await bridgeFor(store, second.runtime).start();
    expect(second.published[0].username).not.toBe(first.published[0].username);
  });

  it("resets pairing to a new device id and setup code and republishes", async () => {
    const store = newStore(); const { runtime, published, stored } = fakeRuntime();
    const bridge = bridgeFor(store, runtime);
    const before = await bridge.update({ enabled: true, name: "Casambi", port: 51900 }, "admin");
    const after = await bridge.resetPairing("admin");
    expect(stored.has(published[0].username)).toBe(false);
    expect(published).toHaveLength(2);
    expect(published[1].username).not.toBe(published[0].username);
    expect(after.pincode).not.toBe(before.pincode);
    expect(after.state).toBe("published");
    expect(auditActions(store).map(entry => entry.action)).toContain("homekit.pairing_reset");
  });

  it("reports a busy port or a failed publish instead of crashing, and refuses the web app's port", async () => {
    const store = newStore();
    const busy = await bridgeFor(store, fakeRuntime({ busyPorts: [51900] }).runtime).update({ enabled: true, name: "Casambi", port: 51900 }, "admin");
    expect(busy).toMatchObject({ state: "failed", error: "Port 51900 is already in use.", setupUri: null });
    const failed = await bridgeFor(store, fakeRuntime({ failPublish: "no network" }).runtime).update({ enabled: true, name: "Casambi", port: 51901 }, "admin");
    expect(failed).toMatchObject({ state: "failed", error: "no network" });
    await expect(bridgeFor(store, fakeRuntime().runtime).update({ enabled: true, name: "Casambi", port: 3000 }, "admin")).rejects.toThrow("must differ");
    const off = await bridgeFor(store, fakeRuntime().runtime).update({ enabled: false, name: "Casambi", port: 51901 }, "admin");
    expect(off).toMatchObject({ state: "disabled", error: null });
  });

  it("uses avahi on Linux and ciao elsewhere, unless overridden", () => {
    expect(defaultAdvertiser("linux", undefined)).toBe("avahi");
    expect(defaultAdvertiser("darwin", undefined)).toBe("ciao");
    expect(defaultAdvertiser("linux", "ciao")).toBe("ciao");
    expect(defaultAdvertiser("linux", "nonsense")).toBe("avahi");
  });
});

describe("HomeKit admin API", () => {
  function app(withHomekit = true) {
    const store = newStore();
    const homekit = withHomekit ? bridgeFor(store, fakeRuntime().runtime) : undefined;
    const instance = express(); instance.use(express.json());
    instance.use("/api/v1", createCasambiApi({ store, service: {} as CasambiService, events: new EventHub(), scheduler: { reload: () => undefined } as unknown as DurableScheduler, homekit }));
    instance.use("/api/v1", apiErrorHandler);
    return instance;
  }
  const signIn = async (instance: express.Express) => {
    const admin = await request(instance).post("/api/v1/auth/bootstrap").send({ username: "admin", password: "this-is-a-strong-password" }).expect(201);
    return { Authorization: `Bearer ${admin.body.token}` };
  };

  it("turns the bridge on and returns a QR code to pair with", async () => {
    const instance = app(); const auth = await signIn(instance);
    const off = await request(instance).get("/api/v1/admin/homekit").set(auth).expect(200);
    expect(off.body).toMatchObject({ enabled: false, state: "disabled", qrSvg: null });
    const on = await request(instance).put("/api/v1/admin/homekit").set(auth).send({ enabled: true, name: "Casambi", port: 51900 }).expect(200);
    expect(on.body).toMatchObject({ enabled: true, state: "published" });
    expect(on.body.qrSvg).toContain("<svg");
    await request(instance).put("/api/v1/admin/homekit").set(auth).send({ enabled: true, name: "", port: 80 }).expect(422);
    const reset = await request(instance).post("/api/v1/admin/homekit/reset").set(auth).expect(200);
    expect(reset.body.pincode).not.toBe(on.body.pincode);
  });

  it("refuses when the server has no HomeKit bridge", async () => {
    const instance = app(false); const auth = await signIn(instance);
    await request(instance).get("/api/v1/admin/homekit").set(auth).expect(422);
    await request(instance).put("/api/v1/admin/homekit/accessories").set(auth).send({ hidden: [] }).expect(422);
  });
});
