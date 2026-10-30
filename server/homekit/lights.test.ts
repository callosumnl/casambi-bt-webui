import * as hap from "hap-nodejs";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import type { ControlRequest, SwitchPress } from "../casambi/types";
import { LocalStore } from "../store";
import { HomeKitLights, LightingSource } from "./lights";
import { colourFixture, fixture } from "../lighting/testFixtures";
import type { LightingSnapshot } from "../lighting/model";

const folders: string[] = [];
const closers: Array<() => void> = [];
afterEach(() => { closers.splice(0).forEach(close => close()); folders.splice(0).forEach(folder => rmSync(folder, { recursive: true, force: true })); });

function newStore(): LocalStore {
  const folder = mkdtempSync(join(tmpdir(), "casambi-homekit-lights-")); folders.push(folder);
  return new LocalStore(join(folder, "state.db"), "test-key");
}

/** A Casambi service that applies on/off/level commands to its snapshot, like the real one does. */
function fakeSource(snapshot: LightingSnapshot, options: { fail?: boolean } = {}) {
  const sent: ControlRequest[] = [];
  const listeners: Array<() => void> = [];
  const presses: Array<(press: SwitchPress) => void> = [];
  const source: LightingSource & { snapshot: LightingSnapshot } = {
    snapshot,
    cachedSnapshot: () => source.snapshot,
    onStateChange: listener => { listeners.push(listener); },
    onSwitchPress: listener => { presses.push(listener); },
    async control(command) {
      if (options.fail) throw new Error("Bluetooth is busy.");
      sent.push(command);
    },
  };
  return { source, sent, changed: () => listeners.forEach(listener => listener()), press: (press: Omit<SwitchPress, "raw">) => presses.forEach(listener => listener({ ...press, raw: {} })) };
}

function fakeHost() {
  const accessories: hap.Accessory[] = [];
  return {
    accessories,
    addAccessories: (added: hap.Accessory[]) => { accessories.push(...added); },
    removeAccessories: (removed: hap.Accessory[]) => { for (const accessory of removed) accessories.splice(accessories.indexOf(accessory), 1); },
    find: (key: string) => accessories.find(accessory => accessory.getService(hap.Service.AccessoryInformation)!.getCharacteristic(hap.Characteristic.SerialNumber).value === key)!,
  };
}

const lightsFor = (store: LocalStore, source: LightingSource, now = () => Date.now()) => {
  const lights = new HomeKitLights(store, source, { flushMs: 5, removeAfterMs: 60_000, writeTimeoutMs: 1_000, now });
  closers.push(() => lights.close());
  return lights;
};
const bulb = (accessory: hap.Accessory) => accessory.getService(hap.Service.Lightbulb)!;
const characteristic = (accessory: hap.Accessory, type: typeof hap.Characteristic.On | typeof hap.Characteristic.Brightness) => bulb(accessory).getCharacteristic(type);
const keys = (host: ReturnType<typeof fakeHost>) => host.accessories.map(accessory => accessory.getService(hap.Service.AccessoryInformation)!.getCharacteristic(hap.Characteristic.SerialNumber).value).sort();

describe("HomeKit lights", () => {
  it("shows lamps, groups, and rooms as lights with stable ids and the right characteristics", async () => {
    const store = newStore(); const { source } = fakeSource(fixture()); const host = fakeHost();
    const lights = lightsFor(store, source);
    lights.attach(host);
    expect(keys(host)).toEqual(["group:net:7", "room:1", "unit:uuid-1", "unit:uuid-2", "unit:uuid-3"]);
    expect(lights.status()).toEqual({ lights: 5, notShown: 0 });
    const room = host.find("room:1");
    expect(room.UUID).toBe(hap.uuid.generate("casambi-bt-webui:room:1"));
    expect(bulb(room).getCharacteristic(hap.Characteristic.ConfiguredName).value).toBe("Woonkamer");
    // HomeKit's naming rule: "Eiland (keuken)" loses the characters HomeKit does not allow.
    expect(bulb(host.find("group:net:7")).getCharacteristic(hap.Characteristic.ConfiguredName).value).toBe("Eiland keuken");
    expect(await characteristic(room, hap.Characteristic.On).handleGetRequest()).toBe(true);
    expect(await characteristic(room, hap.Characteristic.Brightness).handleGetRequest()).toBe(75);
    expect(bulb(host.find("unit:uuid-3")).testCharacteristic(hap.Characteristic.Brightness)).toBe(false);
  });

  it("answers No Response while disconnected, but keeps every light so Apple Home keeps its setup", async () => {
    const store = newStore(); const first = fakeSource(fixture());
    lightsFor(store, first.source).attach(fakeHost());
    // A restart while Bluetooth is still connecting: the cached list is published anyway.
    const { source } = fakeSource(fixture({ connected: false, network: null, units: [], groups: [] }));
    const host = fakeHost();
    lightsFor(store, source).attach(host);
    expect(host.accessories).toHaveLength(5);
    await expect(characteristic(host.find("unit:uuid-1"), hap.Characteristic.On).handleGetRequest()).rejects.toBe(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    await expect(characteristic(host.find("unit:uuid-1"), hap.Characteristic.On).handleSetRequest(true)).rejects.toBe(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  });

  it("collects writes and sends them as planned Casambi commands", async () => {
    const store = newStore(); const { source, sent } = fakeSource(fixture()); const host = fakeHost();
    lightsFor(store, source).attach(host);
    // Apple Home sends On and Brightness separately, and a room per lamp.
    await Promise.all([
      characteristic(host.find("unit:uuid-1"), hap.Characteristic.On).handleSetRequest(false),
      characteristic(host.find("unit:uuid-2"), hap.Characteristic.On).handleSetRequest(false),
    ]);
    expect(sent).toEqual([{ targetType: "group", targetId: 7, operation: "off" }]);
    sent.length = 0;
    await Promise.all([
      characteristic(host.find("room:1"), hap.Characteristic.On).handleSetRequest(true),
      characteristic(host.find("room:1"), hap.Characteristic.Brightness).handleSetRequest(40),
    ]);
    // Room 1 holds every lamp, so this is one network command.
    expect(sent).toEqual([{ targetType: "network", targetId: null, operation: "set_level", value: 102 }]);
  });

  it("reports a failed command as No Response and audits it", async () => {
    const store = newStore(); const { source } = fakeSource(fixture(), { fail: true }); const host = fakeHost();
    lightsFor(store, source).attach(host);
    await expect(characteristic(host.find("unit:uuid-1"), hap.Characteristic.On).handleSetRequest(false)).rejects.toBe(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    expect(store.auditSince(0, ["homekit.control_failed"])).toHaveLength(1);
  });

  it("pushes state changes to HomeKit", async () => {
    const store = newStore(); const { source } = fakeSource(fixture()); const host = fakeHost();
    const lights = lightsFor(store, source);
    lights.attach(host);
    const on = characteristic(host.find("unit:uuid-1"), hap.Characteristic.On);
    const brightness = characteristic(host.find("unit:uuid-1"), hap.Characteristic.Brightness);
    expect(on.value).toBe(true);
    source.snapshot = fixture(); source.snapshot.units[0].state.dimmer = 51;
    lights.sync();
    expect(brightness.value).toBe(20);
    source.snapshot = fixture(); source.snapshot.units[0].state.on = false;
    lights.sync();
    expect(on.value).toBe(false);
    source.snapshot = fixture({ connected: false });
    lights.sync();
    expect(on.statusCode).toBe(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  });

  it("adds new lights, renames, removes a deleted room at once and a missing lamp after a grace period", () => {
    let now = 1_000;
    const store = newStore(); const { source } = fakeSource(fixture()); const host = fakeHost();
    const lights = lightsFor(store, source, () => now);
    lights.attach(host);
    // Room 1 is deleted, lamps 1 and 3 move to the new room 2, and lamp 2 disappears, which leaves group 7 with
    // one lamp: a duplicate of that lamp from then on.
    const snapshot = fixture({ rooms: [{ id: 2, name: "Hal", sortOrder: 1, defaultBrightnessPercent: 100 }] });
    snapshot.units = snapshot.units.filter(unit => unit.id !== 2);
    snapshot.units[0].name = "Leeslamp";
    snapshot.units[0].roomId = 2;
    snapshot.units[1].roomId = 2;
    source.snapshot = snapshot;
    lights.sync();
    expect(keys(host)).toEqual(["group:net:7", "room:2", "unit:uuid-1", "unit:uuid-2", "unit:uuid-3"]);
    expect(bulb(host.find("unit:uuid-1")).getCharacteristic(hap.Characteristic.ConfiguredName).value).toBe("Leeslamp");
    now += 60_000;
    lights.sync();
    expect(keys(host)).toEqual(["room:2", "unit:uuid-1", "unit:uuid-3"]);
    // The list survives a restart.
    const restarted = fakeHost();
    lightsFor(store, fakeSource(fixture({ connected: false, network: null })).source).attach(restarted);
    expect(keys(restarted)).toEqual(["room:2", "unit:uuid-1", "unit:uuid-3"]);
  });

  it("adds colour temperature and colour where lamps take them, and sends the colour HomeKit picks", async () => {
    const store = newStore(); const { source, sent } = fakeSource(colourFixture()); const host = fakeHost();
    lightsFor(store, source).attach(host);
    const white = bulb(host.find("unit:uuid-11"));
    expect(white.getCharacteristic(hap.Characteristic.ColorTemperature).props).toMatchObject({ minValue: 154, maxValue: 370 });
    expect(white.getCharacteristic(hap.Characteristic.ColorTemperature).value).toBe(250);
    expect(white.testCharacteristic(hap.Characteristic.Hue)).toBe(false);
    const mixed = host.find("unit:uuid-12");
    expect(bulb(mixed).getCharacteristic(hap.Characteristic.Saturation).value).toBe(100);
    // Hue alone keeps the current saturation; it becomes one RGB command.
    await bulb(mixed).getCharacteristic(hap.Characteristic.Hue).handleSetRequest(240);
    expect(sent).toEqual([{ targetType: "unit", targetId: 12, operation: "set_color", value: [0, 0, 255] }]);
    sent.length = 0;
    // A colour temperature picked right after a colour replaces it.
    await Promise.all([
      bulb(mixed).getCharacteristic(hap.Characteristic.Hue).handleSetRequest(120),
      bulb(mixed).getCharacteristic(hap.Characteristic.ColorTemperature).handleSetRequest(370),
    ]);
    expect(sent).toEqual([{ targetType: "unit", targetId: 12, operation: "set_temperature", value: 2703 }]);
  });

  it("removes a room at once when it becomes a duplicate of a Casambi group", () => {
    const store = newStore(); const { source } = fakeSource(fixture()); const host = fakeHost();
    const lights = lightsFor(store, source);
    lights.attach(host);
    expect(keys(host)).toContain("room:1");
    // Lamp 3 leaves room 1, which then holds exactly the lamps of group 7.
    const snapshot = fixture(); delete snapshot.units[2].roomId;
    source.snapshot = snapshot;
    lights.sync();
    expect(keys(host)).toEqual(["group:net:7", "unit:uuid-1", "unit:uuid-2", "unit:uuid-3"]);
  });

  it("activates a scene from its switch, which turns itself off again", async () => {
    const store = newStore(); const { source, sent } = fakeSource(fixture({ scenes: [{ id: 5, name: "Avond" }] })); const host = fakeHost();
    const saved = store.createLightScene("Lezen", { type: "network", id: null }, [{ unitId: 1, level: 200, temperature: null }]);
    lightsFor(store, source).attach(host);
    const casambiScene = host.find("scene:net:5");
    expect(casambiScene.category).toBe(hap.Categories.SWITCH);
    const on = casambiScene.getService(hap.Service.Switch)!.getCharacteristic(hap.Characteristic.On);
    await on.handleSetRequest(true);
    expect(sent).toEqual([{ targetType: "scene", targetId: 5, operation: "activate_scene" }]);
    expect(await on.handleGetRequest()).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 1_100));
    expect(on.value).toBe(false);
    expect(await on.handleGetRequest()).toBe(false);
    await host.find(`local_scene:${saved.id}`).getService(hap.Service.Switch)!.getCharacteristic(hap.Characteristic.On).handleSetRequest(true);
    expect(sent[1]).toEqual({ targetType: "local_scene", targetId: saved.id, operation: "activate_scene" });
  });

  it("removes a deleted saved scene at once", () => {
    const store = newStore(); const { source } = fakeSource(fixture()); const host = fakeHost();
    const saved = store.createLightScene("Lezen", { type: "network", id: null }, []);
    const lights = lightsFor(store, source);
    lights.attach(host);
    expect(keys(host)).toContain(`local_scene:${saved.id}`);
    store.deleteLightScene(saved.id);
    lights.sync();
    expect(keys(host)).not.toContain(`local_scene:${saved.id}`);
  });

  it("hides what an administrator unticks, also after a restart, and shows it again", () => {
    const store = newStore(); const { source } = fakeSource(fixture()); const host = fakeHost();
    const lights = lightsFor(store, source);
    lights.attach(host);
    lights.setHidden(["unit:uuid-3", "room:1"]);
    expect(keys(host)).toEqual(["group:net:7", "unit:uuid-1", "unit:uuid-2"]);
    expect(lights.catalog()).toEqual(expect.arrayContaining([{ key: "unit:uuid-3", kind: "unit", name: "Lamp 3", shown: false }, { key: "unit:uuid-1", kind: "unit", name: "Lamp 1", shown: true }]));
    const restarted = fakeHost();
    const again = lightsFor(store, fakeSource(fixture()).source);
    again.attach(restarted);
    expect(keys(restarted)).toEqual(["group:net:7", "unit:uuid-1", "unit:uuid-2"]);
    again.setHidden([]);
    expect(keys(restarted)).toEqual(["group:net:7", "room:1", "unit:uuid-1", "unit:uuid-2", "unit:uuid-3"]);
  });

  it("learns a wall switch's buttons from presses and passes taps and holds on as HomeKit button events", () => {
    const store = newStore(); const { source, press } = fakeSource(fixture()); const host = fakeHost();
    const lights = lightsFor(store, source);
    lights.attach(host);
    expect(keys(host)).not.toContain("switch:uuid-4");
    press({ unitId: 4, button: 1, trigger: "tap" });
    const first = host.find("switch:uuid-4");
    expect(first.category).toBe(hap.Categories.PROGRAMMABLE_SWITCH);
    expect(store.auditSince(0, ["homekit.button_learned"])).toHaveLength(1);
    press({ unitId: 4, button: 3, trigger: "hold" });
    const remote = host.find("switch:uuid-4");
    const button = (number: number) => remote.getServiceById(hap.Service.StatelessProgrammableSwitch, `button-${number}`)!;
    expect(remote.services.filter(service => service.UUID === hap.Service.StatelessProgrammableSwitch.UUID)).toHaveLength(2);
    expect(button(3).getCharacteristic(hap.Characteristic.ServiceLabelIndex).value).toBe(2);
    press({ unitId: 4, button: 1, trigger: "tap" });
    expect(button(1).getCharacteristic(hap.Characteristic.ProgrammableSwitchEvent).value).toBe(hap.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS);
    press({ unitId: 4, button: 3, trigger: "hold" });
    expect(button(3).getCharacteristic(hap.Characteristic.ProgrammableSwitchEvent).value).toBe(hap.Characteristic.ProgrammableSwitchEvent.LONG_PRESS);
    // The release after a hold, and raw activity without a trigger, are not presses.
    press({ unitId: 4, button: 5, trigger: "release_after_hold" });
    press({ unitId: 4, button: 6, trigger: null });
    expect(remote.services.filter(service => service.UUID === hap.Service.StatelessProgrammableSwitch.UUID)).toHaveLength(2);
    // The learned buttons survive a restart, also while the network is still connecting.
    const restarted = fakeHost();
    lightsFor(store, fakeSource(fixture({ connected: false, network: null })).source).attach(restarted);
    expect(restarted.find("switch:uuid-4").services.filter(service => service.UUID === hap.Service.StatelessProgrammableSwitch.UUID)).toHaveLength(2);
  });
});
