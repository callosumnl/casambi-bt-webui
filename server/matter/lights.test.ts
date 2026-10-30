import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import type { ControlRequest } from "../casambi/types";
import type { LightDescriptor, LightingSnapshot } from "../lighting/model";
import type { LightingSource } from "../lighting/registry";
import { colourFixture, fixture } from "../lighting/testFixtures";
import { LocalStore } from "../store";
import { DeviceFactory, DeviceHandlers, DeviceState, fromMatterLevel, toMatterLevel } from "./devices";
import { MatterLights } from "./lights";

const folders: string[] = [];
const closers: Array<() => void> = [];
afterEach(() => { closers.splice(0).forEach(close => close()); folders.splice(0).forEach(folder => rmSync(folder, { recursive: true, force: true })); });
function newStore(): LocalStore {
  const folder = mkdtempSync(join(tmpdir(), "casambi-matter-lights-")); folders.push(folder);
  return new LocalStore(join(folder, "state.db"), "test-key");
}

function fakeSource(snapshot: LightingSnapshot) {
  const sent: ControlRequest[] = [];
  const source: LightingSource & { snapshot: LightingSnapshot } = {
    snapshot, cachedSnapshot: () => source.snapshot, onStateChange: () => undefined,
    control: async command => { sent.push(command); },
  };
  return { source, sent };
}

/** Records the devices MatterLights creates, their pushed states, and lets a test send controller commands. */
function fakeFactory() {
  const devices = new Map<string, { descriptor: LightDescriptor; states: DeviceState[]; name: string; removed: boolean; handlers: DeviceHandlers }>();
  const factory: DeviceFactory = {
    async add(descriptor, initial, handlers) {
      const record = { descriptor, states: [initial], name: descriptor.name, removed: false, handlers };
      devices.set(descriptor.key, record);
      return {
        push: async state => { record.states.push(state); },
        rename: async name => { record.name = name; },
        remove: async () => { record.removed = true; devices.delete(descriptor.key); },
      };
    },
  };
  const last = (key: string) => devices.get(key)!.states.at(-1)!;
  return { factory, devices, last };
}

const lightsFor = (store: LocalStore, source: LightingSource, now = () => Date.now()) => {
  const lights = new MatterLights(store, source, { flushMs: 5, removeAfterMs: 60_000, writeTimeoutMs: 1_000, now });
  closers.push(() => lights.close());
  return lights;
};
const settle = () => new Promise(resolve => setTimeout(resolve, 30));

describe("Matter lights", () => {
  it("converts between Casambi and Matter levels", () => {
    expect(toMatterLevel(255)).toBe(254);
    expect(toMatterLevel(1)).toBe(1);
    expect(fromMatterLevel(254)).toBe(255);
    expect(fromMatterLevel(127)).toBe(128);
  });

  it("adds lamps, groups, and rooms, with on, level, and reachability, and no scenes or switches yet", async () => {
    const store = newStore(); const { source } = fakeSource(fixture({ scenes: [{ id: 5, name: "Avond" }] })); const { factory, devices, last } = fakeFactory();
    const lights = lightsFor(store, source);
    await lights.attach(factory);
    expect(Array.from(devices.keys()).sort()).toEqual(["group:net:7", "room:1", "unit:uuid-1", "unit:uuid-2", "unit:uuid-3"]);
    expect(lights.status()).toEqual({ lights: 5 });
    // Matter keeps the room's name as it is; HomeKit drops the brackets.
    expect(devices.get("group:net:7")!.name).toBe("Eiland (keuken)");
    expect(last("unit:uuid-1")).toMatchObject({ reachable: true, on: true, level: 254 });
    expect(last("unit:uuid-2")).toMatchObject({ reachable: true, on: true, level: 127 });
    expect(last("unit:uuid-3")).toMatchObject({ reachable: true, on: false, level: null });
    expect(lights.catalog().map(entry => entry.kind)).not.toContain("scene");
  });

  it("sends Google Home's commands to Casambi as planned commands, merging on and level", async () => {
    const store = newStore(); const { source, sent } = fakeSource(fixture()); const { factory, devices } = fakeFactory();
    await lightsFor(store, source).attach(factory);
    devices.get("unit:uuid-1")!.handlers.onOn(false);
    devices.get("unit:uuid-2")!.handlers.onOn(false);
    await settle();
    expect(sent).toEqual([{ targetType: "group", targetId: 7, operation: "off" }]);
    sent.length = 0;
    devices.get("unit:uuid-1")!.handlers.onOn(true);
    devices.get("unit:uuid-1")!.handlers.onLevel(127);
    await settle();
    expect(sent).toEqual([{ targetType: "unit", targetId: 1, operation: "set_level", value: 128 }]);
    expect(store.auditSince(0, ["matter.control_failed"])).toHaveLength(0);
  });

  it("pushes state changes, shows unreachable lamps as offline, and keeps the level while a lamp is off", async () => {
    const store = newStore(); const { source } = fakeSource(fixture()); const { factory, devices, last } = fakeFactory();
    const lights = lightsFor(store, source);
    await lights.attach(factory);
    const pushes = devices.get("unit:uuid-1")!.states.length;
    await lights.sync();
    expect(devices.get("unit:uuid-1")!.states).toHaveLength(pushes); // nothing changed, nothing pushed
    source.snapshot = fixture(); source.snapshot.units[0].state.dimmer = 51;
    await lights.sync();
    expect(last("unit:uuid-1")).toMatchObject({ reachable: true, on: true, level: 51 });
    source.snapshot = fixture(); source.snapshot.units[0].state.on = false;
    await lights.sync();
    expect(last("unit:uuid-1")).toMatchObject({ reachable: true, on: false, level: 51 });
    source.snapshot = fixture({ connected: false });
    await lights.sync();
    expect(last("unit:uuid-1")).toMatchObject({ reachable: false });
  });

  it("renames, removes, keeps its list apart from HomeKit's, and survives a restart", async () => {
    let now = 0;
    const store = newStore(); const { source } = fakeSource(fixture()); const { factory, devices } = fakeFactory();
    const lights = lightsFor(store, source, () => now);
    await lights.attach(factory);
    const renamed = fixture(); renamed.units[0].name = "Leeslamp"; renamed.units = renamed.units.filter(unit => unit.id !== 3);
    source.snapshot = renamed;
    await lights.sync();
    expect(devices.get("unit:uuid-1")!.name).toBe("Leeslamp");
    now = 60_000;
    await lights.sync();
    expect(devices.has("unit:uuid-3")).toBe(false);
    expect(store.appSetting("matter.lights")).toContain("Leeslamp");
    expect(store.appSetting("homekit.lights")).toBeNull();
    const restarted = fakeFactory();
    await lightsFor(store, fakeSource(fixture({ connected: false, network: null })).source).attach(restarted.factory);
    expect(restarted.devices.has("unit:uuid-1")).toBe(true);
    expect(restarted.last("unit:uuid-1")).toMatchObject({ reachable: false });
  });

  it("shows white lamps with a colour temperature and colour lamps with colour, in the mode each shows", async () => {
    const store = newStore(); const { source } = fakeSource(colourFixture()); const { factory, devices, last } = fakeFactory();
    await lightsFor(store, source).attach(factory);
    expect(devices.get("unit:uuid-11")!.descriptor).toMatchObject({ temperature: { minMired: 154, maxMired: 370 }, color: false });
    expect(last("unit:uuid-11")).toMatchObject({ mired: 250, hue: null, colorMode: "temperature" });
    // Lamp 12 shows red: hue 0, full saturation (254 in Matter).
    expect(last("unit:uuid-12")).toMatchObject({ hue: 0, saturation: 254, colorMode: "color" });
  });

  it("sends colour temperature, hue and saturation, and xy from Google Home in the form each lamp takes", async () => {
    const store = newStore(); const { source, sent } = fakeSource(colourFixture()); const { factory, devices } = fakeFactory();
    await lightsFor(store, source).attach(factory);
    devices.get("unit:uuid-11")!.handlers.onMired(370);
    await settle();
    expect(sent).toEqual([{ targetType: "unit", targetId: 11, operation: "set_temperature", value: 2703 }]);
    sent.length = 0;
    // Hue and saturation arrive as two changes of one command; they become one colour.
    devices.get("unit:uuid-12")!.handlers.onHueSaturation({ hue: 169 });
    devices.get("unit:uuid-12")!.handlers.onHueSaturation({ saturation: 254 });
    await settle();
    expect(sent).toEqual([{ targetType: "unit", targetId: 12, operation: "set_color", value: [0, 2, 255] }]);
    sent.length = 0;
    devices.get("unit:uuid-13")!.handlers.onXy(0.64, 0.33);
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ targetType: "unit", targetId: 13, operation: "set_xy" });
  });
});
