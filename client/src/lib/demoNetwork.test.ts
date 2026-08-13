import { describe, expect, it } from "vitest";
import { applyDemoCommand, applyDemoRoomDefault, createDemoNetwork } from "./demoNetwork";

describe("anonymous demo network", () => {
  it("creates a connected in-memory fixture set with sample rooms, groups, scenes, and sensors", () => {
    const network = createDemoNetwork();
    expect(network.connected).toBe(true);
    expect(network.units).toHaveLength(3);
    expect(network.groups).toHaveLength(2);
    expect(network.scenes).toHaveLength(3);
    expect(network.units[0]?.state.sensors[0]?.value).toBe(520);
  });

  it("changes only selected simulated units for group and direct controls", () => {
    const original = createDemoNetwork();
    const dimmed = applyDemoCommand(original, { targetType: "unit", targetId: 103, operation: "set_level", value: 48 });
    expect(dimmed.units.find(unit => unit.id === 103)?.state.dimmer).toBe(48);
    expect(original.units.find(unit => unit.id === 103)?.state.dimmer).toBe(210);
    const off = applyDemoCommand(dimmed, { targetType: "group", targetId: 201, operation: "off" });
    expect(off.units.filter(unit => [101, 102].includes(unit.id)).every(unit => !unit.state.on)).toBe(true);
    expect(off.units.find(unit => unit.id === 103)?.state.on).toBe(true);
  });

  it("activates a simulated scene without needing a bridge request", () => {
    const focused = applyDemoCommand(createDemoNetwork(), { targetType: "scene", targetId: 302, operation: "activate_scene" });
    expect(focused.units.every(unit => unit.state.dimmer === 230 && unit.state.temperature === 4300)).toBe(true);
  });

  it("pulses only the selected simulated sensor without a bridge request", () => {
    const next = applyDemoCommand(createDemoNetwork(), { targetType: "unit", targetId: 101, operation: "simulate_sensor" });
    expect(next.units.find(unit => unit.id === 101)?.state.sensors[0]?.value).toBe(557);
    expect(next.units.find(unit => unit.id === 102)?.state.sensors[0]?.value).toBe(385);
  });

  it("applies only the selected room's configured default brightness", () => {
    const next = applyDemoRoomDefault(createDemoNetwork(), 401);
    expect(next.units.find(unit => unit.id === 101)?.state.dimmer).toBe(173);
    expect(next.units.find(unit => unit.id === 102)?.state.dimmer).toBe(173);
    expect(next.units.find(unit => unit.id === 103)?.state.dimmer).toBe(210);
  });
});
