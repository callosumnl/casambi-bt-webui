import { EventEmitter } from "events";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventHub } from "../events";
import { LocalStore } from "../store";
import { CasambiService } from "./service";
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
  public readonly state: NetworkSnapshot = { connected: true, network: { id: "test", name: "Test" }, groups: [], scenes: [], updatedAt: new Date().toISOString(), units: [
    { id: 1, uuid: "one", address: "one", name: "One", capabilities: [], state: { dimmer: 0, sensors: [], on: false, online: true } },
    { id: 2, uuid: "two", address: "two", name: "Two", capabilities: [], state: { dimmer: 0, sensors: [], on: false, online: true } },
  ] };

  async snapshot(): Promise<NetworkSnapshot> { this.snapshotCalls += 1; return structuredClone(this.state); }
  async execute<T>(command: string, payload: Record<string, unknown>): Promise<T> {
    if (command === "configure") {
      this.configureCalls += 1;
      const failure = this.configureFailures.shift();
      if (failure) throw new Error(failure);
      return structuredClone(this.state) as T;
    }
    if (command === "disconnect") return structuredClone({ ...this.state, connected: false }) as T;
    this.commands.push(payload);
    if (payload.operation === "set_level") {
      const unit = this.state.units.find(item => item.id === Number(payload.targetId));
      if (unit) { unit.state.dimmer = Number(payload.value); unit.state.on = Number(payload.value) > 0; }
    }
    return structuredClone(this.state) as T;
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
    bridge.state.groups = [{ id: 7, name: "Partial", unitIds: [1] }, { id: 9, name: "Gallery", unitIds: [2, 1] }];
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
    bridge.state.groups = [{ id: 7, name: "Partial", unitIds: [1] }];
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
    expect(actions(database)).toEqual(expect.arrayContaining(["bridge.connection_lost", "bridge.reconnected"]));

    await service.disconnect();
    expect(service.cachedSnapshot().connection).toEqual({ phase: "idle" });
    bridge.emit("event", { type: "bridge", state: "disconnected" });
    await vi.advanceTimersByTimeAsync(600_000);
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
