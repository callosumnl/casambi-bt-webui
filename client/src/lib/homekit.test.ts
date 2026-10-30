import { describe, expect, it } from "vitest";
import { groupAccessories } from "./homekit";

describe("HomeKit accessories list", () => {
  it("groups by kind in a fixed order and sorts by name", () => {
    const groups = groupAccessories([
      { key: "local_scene:1", kind: "local_scene", name: "Lezen", shown: true },
      { key: "unit:b", kind: "unit", name: "Spot", shown: true },
      { key: "unit:a", kind: "unit", name: "Bureau", shown: false },
      { key: "group:n:1", kind: "group", name: "Eiland", shown: true },
    ]);
    expect(groups.map(group => [group.kind, group.entries.map(entry => entry.name)])).toEqual([["unit", ["Bureau", "Spot"]], ["group", ["Eiland"]], ["local_scene", ["Lezen"]]]);
  });
});
