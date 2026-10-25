import { EventEmitter } from "events";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventHub } from "../events";
import { LocalStore } from "../store";
import { CasambiService, summarizeDiagnostic } from "./service";
import type { NetworkSnapshot } from "./types";

const folders: string[] = [];
function store(): LocalStore { const folder = mkdtempSync(join(tmpdir(), "casambi-fade-")); folders.push(folder); return new LocalStore(join(folder, "state.db"), "test-key"); }
afterEach(() => folders.splice(0).forEach(folder => rmSync(folder, { recursive: true, force: true })));

class FakeBridge extends EventEmitter {
  public commands: Array<Record<string, unknown>> = [];
  public latestKeys: string[] = [];
  public configureCalls = 0;
  public snapshotCalls = 0;
  /** Error messages the next `configure` calls reject with, in order. */
  public configureFailures: string[] = [];
  start(): void {}
  public restartCalls = 0;
  restart(): void { this.restartCalls += 1; this.emit("event", { type: "bridge", state: "unavailable" }); }
  state() { return { running: true, pid: 42, busy: null, lastAnswerAt: null, restarts: this.restartCalls }; }
  public readonly network: NetworkSnapshot = { connected: true, network: { id: "test", name: "Test" }, groups: [], scenes: [], updatedAt: new Date().toISOString(), units: [
    { id: 1, uuid: "one", address: "one", name: "One", capabilities: [{ type: "dimmer", min: 0, max: 255, readOnly: false }], state: { dimmer: 0, sensors: [], on: false, online: true } },
    { id: 2, uuid: "two", address: "two", name: "Two", capabilities: [{ type: "dimmer", min: 0, max: 255, readOnly: false }], state: { dimmer: 0, sensors: [], on: false, online: true } },
  ] };

  async snapshot(): Promise<NetworkSnapshot> { this.snapshotCalls += 1; return structuredClone(this.network); }
  async execute<T>(command: string, payload: Record<string, unknown>): Promise<T> {
    if (command === "configure") {
      this.configureCalls += 1;
      const failure = this.configureFailures.shift();
      if (failure) throw new Error(failure);
      return structuredClone(this.network) as T;
    }
    if (command === "disconnect") return structuredClone({ ...this.network, connected: false }) as T;
    this.commands.push(payload);
    if (payload.operation === "set_level") {
      const unit = this.network.units.find(item => item.id === Number(payload.targetId));
      if (unit) { unit.state.dimmer = Number(payload.value); unit.state.on = Number(payload.value) > 0; }
    }
    return structuredClone(this.network) as T;
  }
  async executeLatest<T>(key: string, command: string, payload: Record<string, unknown>): Promise<T> { this.latestKeys.push(key); return this.execute<T>(command, payload); }
}

describe("CasambiService fade controls", () => {
  it("applies a room preset through bounded level commands for each assigned fixture", async () => {
    const database = store();
    const room = database.createRoom("Gallery", 50);
    database.setUnitMetadata(1, null, room.id);
    database.setUnitMetadata(2, null, room.id);
    const bridge = new FakeBridge();
    const service = new CasambiService(database, bridge as never, new EventHub());

    const snapshot = await service.applyRoomPreset(room.id, "tester", 1);

    expect(bridge.commands).toHaveLength(2);
    expect(bridge.commands).toEqual(expect.arrayContaining([
      expect.objectContaining({ targetId: 1, operation: "set_level", value: 128 }),
      expect.objectContaining({ targetId: 2, operation: "set_level", value: 128 }),
    ]));
    expect(snapshot.units.every(unit => unit.state.dimmer === 128)).toBe(true);
  });

  it("sends a room as one group command when a Casambi group has exactly the room's lamps", async () => {
    const database = store();
    const room = database.createRoom("Gallery", 50);
    database.setUnitMetadata(1, null, room.id);
    database.setUnitMetadata(2, null, room.id);
    const bridge = new FakeBridge();
    bridge.network.groups = [{ id: 7, name: "Partial", unitIds: [1] }, { id: 9, name: "Gallery", unitIds: [2, 1] }];
    const service = new CasambiService(database, bridge as never, new EventHub());
    await service.snapshot();

    await service.control({ targetType: "room", targetId: room.id, operation: "set_level", value: 200 }, "tester");

    expect(bridge.commands).toEqual([expect.objectContaining({ targetType: "group", targetId: 9, operation: "set_level", value: 200 })]);
    expect(bridge.latestKeys).toEqual(["group:9:set_level"]);
  });

  it("falls back to one command per lamp when no group matches the room", async () => {
    const database = store();
    const room = database.createRoom("Gallery", 50);
    database.setUnitMetadata(1, null, room.id);
    database.setUnitMetadata(2, null, room.id);
    const bridge = new FakeBridge();
    bridge.network.groups = [{ id: 7, name: "Partial", unitIds: [1] }];
    const service = new CasambiService(database, bridge as never, new EventHub());
    await service.snapshot();

    await service.control({ targetType: "room", targetId: room.id, operation: "on" }, "tester");

    expect(bridge.commands).toEqual([expect.objectContaining({ targetType: "unit", targetId: 1 }), expect.objectContaining({ targetType: "unit", targetId: 2 })]);
    expect(bridge.latestKeys).toEqual([]); // "on" is not an absolute value, so it is never merged.
  });
});

describe("CasambiService connection resilience", () => {
  afterEach(() => { vi.useRealTimers(); });

  function configured(): LocalStore {
    const database = store();
    database.saveCasambiConfig({ ...database.getCasambiConfig(), networkAddress: "AB:CD:EF:01:23:45", networkPassword: "network-secret" });
    return database;
  }
  const actions = (database: LocalStore) => database.recentAudit().map(entry => entry.action).reverse();

  it("retries a failed startup connect with growing delays until it succeeds", async () => {
    vi.useFakeTimers();
    const database = configured(); const bridge = new FakeBridge();
    bridge.configureFailures = ["RuntimeError: endpoint not found", "RuntimeError: endpoint not found"];
    const service = new CasambiService(database, bridge as never, new EventHub());
    await service.initialize(); await vi.advanceTimersByTimeAsync(0);
    expect(bridge.configureCalls).toBe(1);
    expect(service.cachedSnapshot().connection).toEqual({ phase: "retrying", attempt: 1, nextRetryAt: new Date(Date.now() + 15_000).toISOString(), lastError: "RuntimeError: endpoint not found" });
    await vi.advanceTimersByTimeAsync(14_999); expect(bridge.configureCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(1); expect(bridge.configureCalls).toBe(2);
    expect(service.cachedSnapshot().connection).toMatchObject({ phase: "retrying", attempt: 2 });
    await vi.advanceTimersByTimeAsync(30_000); expect(bridge.configureCalls).toBe(3);
    expect(service.cachedSnapshot().connected).toBe(true);
    expect(service.cachedSnapshot().connection).toEqual({ phase: "connected" });
    await vi.advanceTimersByTimeAsync(600_000); expect(bridge.configureCalls).toBe(3);
    expect(actions(database).filter(action => action === "bridge.startup_connect_failed")).toHaveLength(2);
    // Each attempt records how long it took; the successful third one is logged too.
    const entries = database.recentAudit().reverse().filter(entry => entry.action.startsWith("bridge.")).map(entry => ({ action: entry.action, ...entry.detail }));
    expect(entries.filter(entry => entry.action === "bridge.startup_connect_failed").map(entry => entry.attempt)).toEqual([1, 2]);
    expect(entries.every(entry => typeof entry.durationMs === "number")).toBe(true);
    expect(entries.find(entry => entry.action === "bridge.connected")).toMatchObject({ reason: "startup", attempt: 3 });
  });

  it("reconnects after an unexpected drop, but never after a manual disconnect", async () => {
    vi.useFakeTimers();
    const database = configured(); const bridge = new FakeBridge();
    const service = new CasambiService(database, bridge as never, new EventHub());
    await service.initialize(); await vi.advanceTimersByTimeAsync(0);
    expect(bridge.configureCalls).toBe(1);

    bridge.emit("event", { type: "bridge", state: "disconnected" });
    expect(service.cachedSnapshot().connected).toBe(false);
    expect(service.cachedSnapshot().connection).toMatchObject({ phase: "retrying", attempt: 1, lastError: "The Bluetooth connection was lost." });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(bridge.configureCalls).toBe(2);
    expect(actions(database)).toEqual(expect.arrayContaining(["bridge.connection_lost"]));
    expect(database.recentAudit().find(entry => entry.action === "bridge.connected")?.detail).toMatchObject({ reason: "reconnect", attempt: 2 }); // The drop counts as the first failure, as in the status bar.

    await service.disconnect();
    expect(service.cachedSnapshot().connection).toEqual({ phase: "idle" });
    bridge.emit("event", { type: "bridge", state: "disconnected" });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(bridge.configureCalls).toBe(2);
  });

  it("reconnects about 15 s after a manual worker restart, even during a long backoff", async () => {
    vi.useFakeTimers();
    const database = configured(); const bridge = new FakeBridge();
    bridge.configureFailures = Array.from({ length: 4 }, () => "Casambi bridge command 'configure' timed out.");
    const service = new CasambiService(database, bridge as never, new EventHub());
    await service.initialize(); await vi.advanceTimersByTimeAsync(15_000 + 30_000 + 60_000);
    expect(bridge.configureCalls).toBe(4);
    expect(service.cachedSnapshot().connection).toMatchObject({ phase: "retrying", attempt: 4 }); // Next retry in 120 s.

    expect(service.restartWorker("admin")).toMatchObject({ running: true, restarts: 1 });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(bridge.configureCalls).toBe(5);
    expect(service.cachedSnapshot().connection).toEqual({ phase: "connected" });
    expect(database.recentAudit().some(entry => entry.action === "bridge.worker_restart_requested" && entry.actor === "admin")).toBe(true);
  });

  it("reconnects when the address or password changes while connected, not for other settings", async () => {
    const database = configured(); const bridge = new FakeBridge();
    const service = new CasambiService(database, bridge as never, new EventHub());
    await service.connect();
    service.saveConfiguration({ pollingEnabled: false, solarLatitude: 52 });
    await new Promise(resolve => setImmediate(resolve));
    expect(bridge.configureCalls).toBe(1);
    service.saveConfiguration({ networkPassword: "a-new-network-password" });
    await new Promise(resolve => setImmediate(resolve));
    expect(bridge.configureCalls).toBe(2);
    await service.disconnect();
    service.saveConfiguration({ networkPassword: "yet-another-password" });
    await new Promise(resolve => setImmediate(resolve));
    expect(bridge.configureCalls).toBe(2);
  });

  it("stops retrying when the network password is rejected", async () => {
    vi.useFakeTimers();
    const database = configured(); const bridge = new FakeBridge();
    bridge.configureFailures = ["AuthenticationError: Login failed"];
    const service = new CasambiService(database, bridge as never, new EventHub());
    await service.initialize(); await vi.advanceTimersByTimeAsync(600_000);
    expect(bridge.configureCalls).toBe(1);
    expect(service.cachedSnapshot().connection).toEqual({ phase: "failed", lastError: "AuthenticationError: Login failed" });
  });

  it("serves the cached state without queueing a bridge snapshot", async () => {
    const database = configured(); const bridge = new FakeBridge();
    const service = new CasambiService(database, bridge as never, new EventHub());
    await service.connect();
    const cached = service.cachedSnapshot();
    expect(cached.connected).toBe(true);
    expect(cached.units.map(unit => unit.id)).toEqual([1, 2]);
    expect(bridge.snapshotCalls).toBe(0);
  });
});

describe("CasambiService switch activity", () => {
  it("records every switch message, audits only triggers, and notifies listeners", () => {
    const database = store(); const bridge = new FakeBridge();
    const service = new CasambiService(database, bridge as never, new EventHub());
    const heard: Array<string | null> = [];
    service.onSwitchPress(press => heard.push(press.trigger));

    bridge.emit("event", { type: "switch", press: { unitId: 2, button: 4, trigger: null, raw: { messageType: 8 } } });
    bridge.emit("event", { type: "switch", press: { unitId: 2, button: 4, trigger: "tap", raw: { messageType: 16 } } });

    expect(heard).toEqual([null, "tap"]);
    expect(service.recentSwitchActivity().map(press => press.trigger)).toEqual(["tap", null]);
    expect(service.recentSwitchActivity()[0].at).toEqual(expect.any(String));
    const pressed = database.recentAudit().filter(entry => entry.action === "switch.pressed");
    expect(pressed.map(entry => entry.detail)).toEqual([{ unitId: 2, button: 4, trigger: "tap" }]);
  });
});

describe("summarizeDiagnostic", () => {
  it("keeps short diagnostics unchanged", () => {
    expect(summarizeDiagnostic("Failed to discover client.")).toBe("Failed to discover client.");
  });

  it("keeps a long traceback's first line and final exception instead of its head", () => {
    const traceback = ["Failed to find client.", "Traceback (most recent call last):", ...Array.from({ length: 40 }, (_, index) => `  File "/opt/venv/site-packages/module_${index}.py", line ${index}, in connect`), "bleak.exc.BleakDeviceNotFoundError: Device with address AB:CD:EF:01:23:45 was not found."].join("\n");
    const summary = summarizeDiagnostic(traceback);
    expect(summary.length).toBeLessThanOrEqual(600);
    expect(summary.startsWith("Failed to find client.\n…\n")).toBe(true);
    expect(summary.endsWith("Device with address AB:CD:EF:01:23:45 was not found.")).toBe(true);
  });

  it("stores the summarized form when the worker writes to stderr", () => {
    const database = store(); const bridge = new FakeBridge();
    new CasambiService(database, bridge as never, new EventHub());
    bridge.emit("diagnostic", `Failed to find client.\n${"x".repeat(2_000)}\nBleakDeviceNotFoundError: not found`);
    const detail = database.recentAudit().find(entry => entry.action === "bridge.diagnostic")?.detail as { detail: string };
    expect(detail.detail.endsWith("BleakDeviceNotFoundError: not found")).toBe(true);
  });
});

describe("CasambiService light scenes", () => {
  const lamp = [{ type: "dimmer", min: 0, max: 255, readOnly: false }, { type: "temperature", min: 2700, max: 6500, readOnly: false }];
  async function setup() {
    const database = store(); const bridge = new FakeBridge();
    bridge.network.units[0] = { ...bridge.network.units[0], capabilities: lamp, state: { dimmer: 200, temperature: 3000, sensors: [], on: true, online: true } };
    bridge.network.units[1] = { ...bridge.network.units[1], capabilities: lamp, state: { dimmer: 90, temperature: 4000, sensors: [], on: false, online: true } };
    bridge.network.units.push({ id: 9, uuid: "nine", address: "nine", name: "Wall switch", capabilities: [], state: { sensors: [], on: false, online: true } });
    bridge.network.groups = [{ id: 5, name: "Kitchen", unitIds: [1, 2, 9] }];
    database.saveCasambiConfig({ ...database.getCasambiConfig(), networkAddress: "AB:CD:EF:01:23:45", networkPassword: "network-secret" });
    const service = new CasambiService(database, bridge as never, new EventHub());
    await service.connect();
    bridge.commands = [];
    return { database, bridge, service };
  }

  it("captures each lamp of a group, leaving out switches and storing off lamps as level 0", async () => {
    const { service } = await setup();
    const scene = service.captureLightScene("Dinner", { type: "group", id: 5 });
    expect(scene).toMatchObject({ name: "Dinner", scope: { type: "group", id: 5 } });
    expect(scene.lamps).toEqual([{ unitId: 1, level: 200, temperature: 3000 }, { unitId: 2, level: 0, temperature: 4000 }]);
  });

  it("restores temperature first, then each lamp's own level", async () => {
    const { service, bridge } = await setup();
    const scene = service.captureLightScene("Dinner", { type: "group", id: 5 });
    await service.applyLightScene(scene.id, "tester");
    expect(bridge.commands).toEqual([
      { targetType: "unit", targetId: 1, operation: "set_temperature", value: 3000 },
      { targetType: "unit", targetId: 1, operation: "set_level", value: 200 },
      { targetType: "unit", targetId: 2, operation: "set_level", value: 0 },
    ]);
  });

  it("applies a scene through the normal control path, with a fade, for timers and switch rules", async () => {
    const { service, bridge, database } = await setup();
    const scene = service.captureLightScene("Dinner", { type: "group", id: 5 });
    bridge.network.units[0].state = { ...bridge.network.units[0].state, dimmer: 0, on: false };
    await service.snapshot();
    const snapshot = await service.control({ targetType: "local_scene", targetId: scene.id, operation: "activate_scene", fadeDurationMs: 1 }, "timer");
    expect(snapshot.units.find(unit => unit.id === 1)?.state.dimmer).toBe(200);
    expect(database.recentAudit().find(entry => entry.action === "lighting.scene_applied")?.detail).toEqual({ sceneId: scene.id, fadeDurationMs: 1 });
  });

  it("updates a scene to the current setting and rejects a scene without lamps", async () => {
    const { service, bridge } = await setup();
    const scene = service.captureLightScene("Dinner", { type: "group", id: 5 });
    bridge.network.units[1].state = { ...bridge.network.units[1].state, on: true, dimmer: 150 };
    await service.snapshot();
    expect(service.recaptureLightScene(scene.id).lamps[1]).toEqual({ unitId: 2, level: 150, temperature: 4000 });
    bridge.network.groups.push({ id: 6, name: "Switches", unitIds: [9] });
    await service.snapshot();
    expect(() => service.captureLightScene("Empty", { type: "group", id: 6 })).toThrow("At least one connected lamp is required for a scene.");
    await expect(service.applyLightScene(999, "tester")).rejects.toThrow("Scene does not exist.");
  });
});

