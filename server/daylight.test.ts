import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import type { UnitSnapshot } from "./casambi/types";
import { Daylight, daylightKelvin } from "./daylight";
import { LocalStore } from "./store";

const folders: string[] = [];
afterEach(() => folders.splice(0).forEach(folder => rmSync(folder, { recursive: true, force: true })));
const AMSTERDAM = { latitude: 52.37, longitude: 4.9 };

describe("daylightKelvin", () => {
  it("is warm at night, coolest around solar noon, and in between in the morning", () => {
    expect(daylightKelvin(new Date("2026-06-21T00:00:00Z"), AMSTERDAM, 2700, 5000)).toBe(2700);
    const noon = daylightKelvin(new Date("2026-06-21T11:40:00Z"), AMSTERDAM, 2700, 5000);
    expect(noon).toBeGreaterThan(4950);
    const morning = daylightKelvin(new Date("2026-06-21T06:00:00Z"), AMSTERDAM, 2700, 5000);
    expect(morning).toBeGreaterThan(2700);
    expect(morning).toBeLessThan(noon);
    expect(daylightKelvin(new Date("2026-12-21T18:00:00Z"), AMSTERDAM, 2700, 5000)).toBe(2700);
  });

  it("follows the sun's height where it does not set", () => {
    const tromso = { latitude: 69.65, longitude: 18.96 };
    expect(daylightKelvin(new Date("2026-06-21T23:00:00Z"), tromso, 2700, 5000)).toBe(5000);
    expect(daylightKelvin(new Date("2026-12-21T11:00:00Z"), tromso, 2700, 5000)).toBe(2700);
  });
});

/** A lamp with adjustable white. */
const lamp = (id: number, state: Partial<UnitSnapshot["state"]>): UnitSnapshot => ({ id, uuid: `u${id}`, address: `a${id}`, name: `Lamp ${id}`, capabilities: [{ type: "dimmer", min: 0, max: 255, readOnly: false }, { type: "temperature", min: 2200, max: 6500, readOnly: false }], state: { on: false, online: true, dimmer: 0, temperature: 3000, colorSource: "temperature", sensors: [], ...state } });

function setup(at = "2026-06-21T11:40:00Z") {
  const folder = mkdtempSync(join(tmpdir(), "casambi-daylight-")); folders.push(folder);
  const store = new LocalStore(join(folder, "state.db"), "key");
  store.saveCasambiConfig({ ...store.getCasambiConfig(), solarLatitude: AMSTERDAM.latitude, solarLongitude: AMSTERDAM.longitude });
  const living = store.createRoom("Living", 80), hall = store.createRoom("Hall", 80);
  store.setUnitMetadata(1, "", living.id); store.setUnitMetadata(2, "", living.id); store.setUnitMetadata(3, "", hall.id);
  const units = [lamp(1, { on: true, dimmer: 200 }), lamp(2, {}), lamp(3, { on: true, dimmer: 100 })];
  const sent: Array<{ unitIds: number[]; kelvin: number }> = [];
  const lighting = {
    wakeUp: false,
    cachedSnapshot: () => ({ connected: true, network: null, units, groups: [], scenes: [], updatedAt: "", rooms: [], connection: { phase: "connected" as const } }),
    adjustTemperature: async (unitIds: number[], kelvin: number) => { sent.push({ unitIds, kelvin }); unitIds.forEach(id => { units.find(unit => unit.id === id)!.state.temperature = kelvin; }); return new Map(unitIds.map(id => [id, kelvin] as [number, number])); },
    wakeUpActive() { return this.wakeUp; },
    onStateChange: () => undefined,
  };
  const daylight = new Daylight(store, lighting, () => new Date(at));
  return { store, units, sent, lighting, daylight, living, hall };
}

describe("Daylight rhythm", () => {
  it("does nothing until rooms are chosen, then sets lamps that are on in those rooms", async () => {
    const { daylight, sent, living } = setup();
    await daylight.tick();
    expect(sent).toEqual([]);
    const status = await daylight.update({ roomIds: [living.id, 999], warmKelvin: 2700, coolKelvin: 5000 }, "chris");
    expect(status.roomIds).toEqual([living.id]);
    expect(sent).toEqual([{ unitIds: [1], kelvin: status.kelvin }]);
    expect(status.rooms.find(room => room.id === living.id)).toMatchObject({ enabled: true, state: "on" });
    // Already right: nothing more is sent.
    await daylight.tick();
    expect(sent).toHaveLength(1);
  });

  it("pauses a room changed by hand until its lamps are off, and leaves colour lamps alone", async () => {
    const { daylight, sent, units, living } = setup();
    await daylight.update({ roomIds: [living.id], warmKelvin: 2700, coolKelvin: 5000 }, "chris");
    units[0].state.temperature = 2700;
    await daylight.tick();
    expect(daylight.status().rooms.find(room => room.id === living.id)?.state).toBe("paused");
    expect(sent).toHaveLength(1);
    // A lamp switched on in the paused room is left alone too.
    Object.assign(units[1].state, { on: true, dimmer: 100, temperature: 2400 });
    await daylight.tick();
    expect(sent).toHaveLength(1);
    // All off: the next switch-on follows the day again.
    units[0].state.on = units[1].state.on = false;
    await daylight.tick();
    units[0].state.on = true;
    units[0].state.colorSource = "rgb";
    units[1].state.on = true;
    await daylight.tick();
    expect(sent.at(-1)).toMatchObject({ unitIds: [2] });
  });

  it("can be resumed by hand, and waits while a wake-up light runs or without a location", async () => {
    const { daylight, sent, units, lighting, living, store } = setup();
    lighting.wakeUp = true;
    await daylight.update({ roomIds: [living.id], warmKelvin: 2700, coolKelvin: 5000 }, "chris");
    expect(sent).toEqual([]);
    lighting.wakeUp = false;
    await daylight.tick();
    units[0].state.temperature = 2300;
    await daylight.tick();
    expect(daylight.status().rooms[0].state).toBe("paused");
    await daylight.resume(living.id, "chris");
    expect(sent.at(-1)).toMatchObject({ unitIds: [1] });
    expect(daylight.status().rooms[0].state).toBe("on");
    store.saveCasambiConfig({ ...store.getCasambiConfig(), solarLatitude: null, solarLongitude: null });
    expect(daylight.status()).toMatchObject({ hasLocation: false, kelvin: null });
    await expect(daylight.update({ roomIds: [], warmKelvin: 5000, coolKelvin: 2700 }, "chris")).rejects.toThrow("must not be warmer");
  });
});
