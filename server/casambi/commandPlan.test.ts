import { describe, expect, it } from "vitest";
import { bucketBy, planTargets } from "./commandPlan";
import type { NetworkSnapshot } from "./types";

const lamp = (id: number) => ({ id, uuid: `u${id}`, address: "", name: `Lamp ${id}`, capabilities: [{ type: "dimmer", readOnly: false }], state: { on: true, online: true, dimmer: 100, sensors: [] } });
const sensor = (id: number) => ({ ...lamp(id), capabilities: [] });
const network = (units: NetworkSnapshot["units"], groups: NetworkSnapshot["groups"]) => ({ units, groups });

describe("planTargets", () => {
  const snapshot = network([lamp(1), lamp(2), lamp(3), lamp(4), lamp(5), lamp(6), sensor(9)], [
    { id: 10, name: "Left", unitIds: [1, 2, 9] },
    { id: 11, name: "Right", unitIds: [3, 4] },
    { id: 12, name: "Overlap", unitIds: [2, 3] },
    { id: 13, name: "Wider", unitIds: [4, 5, 6, 7] },
  ]);

  it("uses one network command when the set is every lamp", () => {
    expect(planTargets([1, 2, 3, 4, 5, 6], snapshot)).toEqual([{ targetType: "network", targetId: null }]);
  });

  it("covers the set with groups that lie entirely inside it, then single lamps", () => {
    expect(planTargets([1, 2, 3, 4, 5], snapshot)).toEqual([
      { targetType: "group", targetId: 10 },
      { targetType: "group", targetId: 11 },
      { targetType: "unit", targetId: 5 },
    ]);
  });

  it("never uses a group that would also change lamps outside the set", () => {
    expect(planTargets([4, 5], snapshot)).toEqual([{ targetType: "unit", targetId: 4 }, { targetType: "unit", targetId: 5 }]);
    expect(planTargets([3], snapshot)).toEqual([{ targetType: "unit", targetId: 3 }]);
    expect(planTargets([], snapshot)).toEqual([]);
  });
});

describe("bucketBy", () => {
  it("groups lamps that get the same value", () => {
    expect(bucketBy([[1, 50], [2, 80], [3, 50]], value => String(value))).toEqual([{ value: 50, unitIds: [1, 3] }, { value: 80, unitIds: [2] }]);
  });
});
