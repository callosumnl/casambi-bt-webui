import { describe, expect, it } from "vitest";
import { describeLights, levelToPercent, lightState, percentToLevel, planWrites } from "./mapping";
import { fixture } from "./testFixtures";

describe("HomeKit mapping", () => {
  it("shows every lamp, every group and room with lamps, and no switches", () => {
    expect(describeLights(fixture())).toEqual([
      { key: "unit:uuid-1", kind: "unit", id: 1, name: "Lamp 1", dimmable: true },
      { key: "unit:uuid-2", kind: "unit", id: 2, name: "Lamp 2", dimmable: true },
      { key: "unit:uuid-3", kind: "unit", id: 3, name: "Lamp 3", dimmable: false },
      { key: "group:net:7", kind: "group", id: 7, name: "Eiland keuken", dimmable: true },
      { key: "room:1", kind: "room", id: 1, name: "Woonkamer", dimmable: true },
    ]);
  });

  it("reports on at the average level of the lit lamps, and No Response when unreachable", () => {
    expect(lightState({ kind: "room", id: 1 }, fixture())).toEqual({ available: true, on: true, brightness: 75 });
    expect(lightState({ kind: "unit", id: 3 }, fixture())).toEqual({ available: true, on: false, brightness: null });
    expect(lightState({ kind: "unit", id: 1 }, fixture({ connected: false }))).toMatchObject({ available: false });
    const offline = fixture(); offline.units[0].state.online = false;
    expect(lightState({ kind: "unit", id: 1 }, offline)).toMatchObject({ available: false });
    expect(lightState({ kind: "group", id: 7 }, offline)).toEqual({ available: true, on: true, brightness: 50 });
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
});
