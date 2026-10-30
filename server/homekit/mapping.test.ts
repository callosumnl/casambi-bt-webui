import { describe, expect, it } from "vitest";
import { describeLights, levelToPercent, lightState, percentToLevel, planWrites } from "./mapping";
import { colourFixture, fixture } from "./testFixtures";

describe("HomeKit mapping", () => {
  it("shows every lamp, every group and room with lamps, and no switches", () => {
    expect(describeLights(fixture())).toEqual([
      { key: "unit:uuid-1", kind: "unit", id: 1, name: "Lamp 1", dimmable: true, temperature: null, color: false },
      { key: "unit:uuid-2", kind: "unit", id: 2, name: "Lamp 2", dimmable: true, temperature: null, color: false },
      { key: "unit:uuid-3", kind: "unit", id: 3, name: "Lamp 3", dimmable: false, temperature: null, color: false },
      { key: "group:net:7", kind: "group", id: 7, name: "Eiland keuken", dimmable: true, temperature: null, color: false },
      { key: "room:1", kind: "room", id: 1, name: "Woonkamer", dimmable: true, temperature: null, color: false },
    ]);
  });

  it("reports on at the average level of the lit lamps, and No Response when unreachable", () => {
    expect(lightState({ kind: "room", id: 1 }, fixture())).toMatchObject({ available: true, on: true, brightness: 75 });
    expect(lightState({ kind: "unit", id: 3 }, fixture())).toMatchObject({ available: true, on: false, brightness: null });
    expect(lightState({ kind: "unit", id: 1 }, fixture({ connected: false }))).toMatchObject({ available: false });
    const offline = fixture(); offline.units[0].state.online = false;
    expect(lightState({ kind: "unit", id: 1 }, offline)).toMatchObject({ available: false });
    expect(lightState({ kind: "group", id: 7 }, offline)).toMatchObject({ available: true, on: true, brightness: 50 });
  });

  it("converts between Casambi levels and HomeKit percentages without turning a lit lamp to 0", () => {
    expect(levelToPercent(255)).toBe(100);
    expect(levelToPercent(1)).toBe(1);
    expect(levelToPercent(0)).toBe(0);
    expect(percentToLevel(100)).toBe(255);
    expect(percentToLevel(1)).toBe(3);
    expect(percentToLevel(0)).toBe(0);
  });

  it("plans writes as few Casambi commands as possible", () => {
    const snapshot = fixture();
    // A Home room switched off lamp by lamp: one group command.
    expect(planWrites([{ unitIds: [1], write: { on: false } }, { unitIds: [2], write: { on: false } }], snapshot)).toEqual([{ targetType: "group", targetId: 7, operation: "off" }]);
    // On + Brightness for one lamp: one level.
    expect(planWrites([{ unitIds: [1], write: { on: true, brightness: 40 } }], snapshot)).toEqual([{ targetType: "unit", targetId: 1, operation: "set_level", value: 102 }]);
    // On alone uses Casambi's on, which restores the last level; brightness 0 is off.
    expect(planWrites([{ unitIds: [1, 2, 3], write: { on: true } }], snapshot)).toEqual([{ targetType: "network", targetId: null, operation: "on" }]);
    expect(planWrites([{ unitIds: [3], write: { brightness: 0 } }], snapshot)).toEqual([{ targetType: "unit", targetId: 3, operation: "off" }]);
    // A later write for the same lamp wins.
    expect(planWrites([{ unitIds: [1, 2], write: { on: true } }, { unitIds: [2], write: { on: false } }], snapshot)).toEqual([
      { targetType: "unit", targetId: 1, operation: "on" }, { targetType: "unit", targetId: 2, operation: "off" },
    ]);
  });

  it("describes colour temperature ranges and colour, also for groups of mixed lamps", () => {
    const lights = describeLights(colourFixture());
    expect(lights.find(light => light.key === "unit:uuid-11")).toMatchObject({ temperature: { minMired: 154, maxMired: 370 }, color: false });
    expect(lights.find(light => light.key === "unit:uuid-12")).toMatchObject({ temperature: { minMired: 154, maxMired: 370 }, color: true });
    expect(lights.find(light => light.key === "unit:uuid-13")).toMatchObject({ temperature: null, color: true });
    expect(lights.find(light => light.key === "group:net:20")).toMatchObject({ temperature: { minMired: 154, maxMired: 370 }, color: true });
  });

  it("reports colour temperature and the colour each lamp shows", () => {
    const snapshot = colourFixture();
    expect(lightState({ kind: "unit", id: 11 }, snapshot)).toMatchObject({ mired: 250 });
    // A white lamp also reports the hue and saturation of its white, so Apple Home does not draw it in colour.
    expect(lightState({ kind: "unit", id: 11 }, snapshot).saturation).toBeLessThan(30);
    expect(lightState({ kind: "unit", id: 12 }, snapshot)).toMatchObject({ hue: 0, saturation: 100 });
    expect(lightState({ kind: "unit", id: 13 }, snapshot)).toMatchObject({ on: false, saturation: 0 });
  });

  it("sends each lamp a colour in the form it takes, before switching it on", () => {
    const snapshot = colourFixture();
    // Red to the whole group: RGB to lamp 12, XY to lamp 13; lamp 11 only does white and is left alone.
    expect(planWrites([{ unitIds: [11, 12, 13], write: { on: true, hue: 0, saturation: 100 } }], snapshot)).toEqual([
      { targetType: "unit", targetId: 12, operation: "set_color", value: [255, 0, 0] },
      { targetType: "unit", targetId: 13, operation: "set_xy", value: [0.6401, 0.33] },
      { targetType: "network", targetId: null, operation: "on" },
    ]);
    // A colour temperature: kelvin for white lamps (within their range), the matching white for colour-only lamps.
    const warm = planWrites([{ unitIds: [11, 12, 13], write: { mired: 500 } }], snapshot);
    expect(warm.slice(0, 1)).toEqual([{ targetType: "group", targetId: 21, operation: "set_temperature", value: 2700 }]);
    expect(warm[1]).toMatchObject({ targetType: "unit", targetId: 13, operation: "set_xy" });
  });

  it("leaves out duplicates: single-lamp groups and rooms, and rooms with exactly a group's lamps", () => {
    const snapshot = fixture({
      groups: [{ id: 7, name: "Eiland", unitIds: [1, 2, 4] }, { id: 9, name: "Solo", unitIds: [3] }],
      rooms: [{ id: 1, name: "Keuken", sortOrder: 0, defaultBrightnessPercent: 100 }, { id: 2, name: "Hal", sortOrder: 1, defaultBrightnessPercent: 100 }],
    });
    snapshot.units[2].roomId = 2;
    expect(describeLights(snapshot).map(light => light.key)).toEqual(["unit:uuid-1", "unit:uuid-2", "unit:uuid-3", "group:net:7"]);
  });
});
