import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import type { ControlRequest } from "../casambi/types";
import { LocalStore } from "../store";
import { lightUnitIds } from "./model";
import type { LightingSource } from "./registry";
import { fixture } from "./testFixtures";
import { WriteBatcher } from "./writes";

const folders: string[] = [];
afterEach(() => folders.splice(0).forEach(folder => rmSync(folder, { recursive: true, force: true })));
function setup(options: { fail?: boolean; connected?: boolean } = {}) {
  const folder = mkdtempSync(join(tmpdir(), "casambi-writes-")); folders.push(folder);
  const store = new LocalStore(join(folder, "state.db"), "test-key");
  const sent: ControlRequest[] = [];
  const source: LightingSource = {
    cachedSnapshot: () => fixture({ connected: options.connected ?? true }),
    control: async command => { if (options.fail) throw new Error("Bluetooth is busy."); sent.push(command); },
    onStateChange: () => undefined,
  };
  const lights: Record<string, { kind: "unit" | "group" | "room"; id: number }> = { a: { kind: "unit", id: 1 }, b: { kind: "unit", id: 2 }, colour: { kind: "unit", id: 1 } };
  const batcher = new WriteBatcher(store, source, {
    actor: "matter", flushMs: 5, writeTimeoutMs: 1_000, failure: () => new Error("no response"),
    unitIds: (key, snapshot) => (lights[key] ? lightUnitIds(lights[key], snapshot) : null),
    currentColour: () => ({ hue: 30, saturation: 50 }),
  });
  return { store, sent, batcher };
}

describe("write batcher", () => {
  it("sends a moment's writes as one planned batch, under its own actor", async () => {
    const { sent, batcher } = setup();
    await Promise.all([batcher.write("a", { on: false }), batcher.write("b", { on: false })]);
    expect(sent).toEqual([{ targetType: "group", targetId: 7, operation: "off" }]);
  });

  it("keeps the current other value when only hue or saturation changes, and lets the newest colour choice win", async () => {
    const { sent, batcher } = setup();
    await batcher.write("colour", { saturation: 100 });
    expect(sent).toEqual([]); // lamp 1 in the fixture takes no colour
    await Promise.all([batcher.write("a", { hue: 120 }), batcher.write("a", { mired: 300 })]);
    expect(sent).toEqual([]); // and no colour temperature either: nothing to send
  });

  it("audits a failure under its actor and rejects with the platform's error, and refuses while disconnected", async () => {
    const failing = setup({ fail: true });
    await expect(failing.batcher.write("a", { on: true })).rejects.toThrow("no response");
    expect(failing.store.auditSince(0, ["matter.control_failed"])).toHaveLength(1);
    expect(() => setup({ connected: false }).batcher.write("a", { on: true })).toThrow("no response");
  });
});
