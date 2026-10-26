import { describe, expect, it } from "vitest";
import type { Device, NetworkSnapshot } from "./localApi";
import { averageBrightnessPercent, isLamp, parseSceneTarget, sameScope, sceneTargetOptions, lampsByScope } from "./scenes";

const dimmable = [{ type: "dimmer", readOnly: false }];
function unit(id: number, roomId: number | undefined, on: boolean, dimmer: number, capabilities = dimmable): Device {
  return { id, name: `Unit ${id}`, address: `${id}`, capabilities, roomId, state: { dimmer, sensors: [], on, online: true } };
}
const network: NetworkSnapshot = {
  connected: true, network: { id: "n", name: "Home" }, updatedAt: "",
  units: [unit(1, 10, true, 255), unit(2, 10, false, 0), unit(3, 11, true, 51), unit(9, 10, false, 0, [])],
  groups: [{ id: 5, name: "Kitchen", unitIds: [1, 2, 9] }],
  scenes: [{ id: 301, name: "Welcome" }],
  rooms: [{ id: 10, name: "Living", sortOrder: 1, defaultBrightnessPercent: 70 }, { id: 11, name: "Study", sortOrder: 2, defaultBrightnessPercent: 50 }],
};

describe("lamps and scene scopes", () => {
  it("treats units without a controllable capability, such as switches, as non-lamps", () => {
    expect(isLamp(unit(1, undefined, false, 0))).toBe(true);
    expect(isLamp(unit(9, undefined, false, 0, [{ type: "sensor", readOnly: true }]))).toBe(false);
  });

  it("finds the lamps of a group, room, or the whole network, never the switch", () => {
    expect(lampsByScope(network)({ type: "group", id: 5 }).map(lamp => lamp.id)).toEqual([1, 2]);
    expect(lampsByScope(network)({ type: "room", id: 10 }).map(lamp => lamp.id)).toEqual([1, 2]);
    expect(lampsByScope(network)({ type: "network", id: null }).map(lamp => lamp.id)).toEqual([1, 2, 3]);
    expect(sameScope({ type: "room", id: 10 }, { type: "room", id: 10 })).toBe(true);
    expect(sameScope({ type: "room", id: 10 }, { type: "group", id: 10 })).toBe(false);
  });

  it("averages the brightness of the lamps that are on", () => {
    expect(averageBrightnessPercent(lampsByScope(network)({ type: "network", id: null }))).toBe(60);
    expect(averageBrightnessPercent([unit(2, 10, false, 0)])).toBe(0);
  });
});

describe("scene targets for timers and switch rules", () => {
  it("lists saved scenes with their group name and Casambi scenes, as type:id values", () => {
    const options = sceneTargetOptions(network, [{ id: 3, name: "Dinner", scope: { type: "group", id: 5 }, lamps: [] }, { id: 4, name: "Evening", scope: { type: "network", id: null }, lamps: [] }]);
    expect(options).toEqual([
      { value: "local_scene:3", label: "Dinner · Kitchen" },
      { value: "local_scene:4", label: "Evening · All lights" },
      { value: "scene:301", label: "Welcome · Casambi" },
    ]);
    expect(parseSceneTarget("local_scene:3")).toEqual({ targetType: "local_scene", targetId: 3 });
    expect(parseSceneTarget("scene:301")).toEqual({ targetType: "scene", targetId: 301 });
  });
});
