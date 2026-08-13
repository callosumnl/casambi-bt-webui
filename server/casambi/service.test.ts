import { EventEmitter } from "events";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { EventHub } from "../events";
import { LocalStore } from "../store";
import { CasambiService } from "./service";
import type { NetworkSnapshot } from "./types";

const folders: string[] = [];
function store(): LocalStore { const folder = mkdtempSync(join(tmpdir(), "casambi-fade-")); folders.push(folder); return new LocalStore(join(folder, "state.db"), "test-key"); }
afterEach(() => folders.splice(0).forEach(folder => rmSync(folder, { recursive: true, force: true })));

class FakeBridge extends EventEmitter {
  public commands: Array<Record<string, unknown>> = [];
  private readonly state: NetworkSnapshot = { connected: true, network: { id: "test", name: "Test" }, groups: [], scenes: [], updatedAt: new Date().toISOString(), units: [
    { id: 1, uuid: "one", address: "one", name: "One", capabilities: [], state: { dimmer: 0, sensors: [], on: false, online: true } },
    { id: 2, uuid: "two", address: "two", name: "Two", capabilities: [], state: { dimmer: 0, sensors: [], on: false, online: true } },
  ] };

  async snapshot(): Promise<NetworkSnapshot> { return structuredClone(this.state); }
  async execute<T>(_command: string, payload: Record<string, unknown>): Promise<T> {
    this.commands.push(payload);
    if (payload.operation === "set_level") {
      const unit = this.state.units.find(item => item.id === Number(payload.targetId));
      if (unit) { unit.state.dimmer = Number(payload.value); unit.state.on = Number(payload.value) > 0; }
    }
    return structuredClone(this.state) as T;
  }
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
});
