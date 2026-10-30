import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalStore } from "../store";
import { LightRegistry } from "./registry";
import { fixture } from "./testFixtures";

const folders: string[] = [];
afterEach(() => folders.splice(0).forEach(folder => rmSync(folder, { recursive: true, force: true })));
function newStore(): LocalStore {
  const folder = mkdtempSync(join(tmpdir(), "casambi-registry-")); folders.push(folder);
  return new LocalStore(join(folder, "state.db"), "test-key");
}
const registry = (store: LocalStore, prefix: string, now = () => 0) => new LightRegistry(store, { prefix, removeAfterMs: 60_000, now });
const keys = (change: { added: Array<{ key: string }> }) => change.added.map(item => item.key).sort();

describe("light registry", () => {
  it("keeps each platform's list, hidden keys, and learned buttons apart", () => {
    const store = newStore();
    const homekit = registry(store, "homekit");
    const matter = registry(store, "matter");
    homekit.reconcile(fixture()); matter.reconcile(fixture());
    homekit.setHidden(["unit:uuid-3"]);
    homekit.learnButton({ id: 4, uuid: "uuid-4" }, 1);
    expect(homekit.reconcile(fixture()).added.map(item => item.key)).toEqual(["switch:uuid-4"]);
    expect(matter.reconcile(fixture()).added).toEqual([]);
    expect(matter.catalog().every(entry => entry.shown)).toBe(true);
    expect(homekit.catalog().find(entry => entry.key === "unit:uuid-3")?.shown).toBe(false);
    expect(store.appSetting("matter.hidden")).toBeNull();
    expect(store.auditSince(0, ["homekit.button_learned"])).toHaveLength(1);
  });

  it("reports added, rebuilt, renamed, and removed devices, and keeps the list across a restart", () => {
    let now = 0;
    const store = newStore();
    const first = registry(store, "matter", () => now);
    expect(keys(first.reconcile(fixture()))).toEqual(["group:net:7", "room:1", "unit:uuid-1", "unit:uuid-2", "unit:uuid-3"]);
    const changed = fixture();
    changed.units[0].name = "Leeslamp";
    changed.units[1].capabilities = [{ type: "onoff", readOnly: false }];
    changed.units = changed.units.filter(unit => unit.id !== 3);
    const change = first.reconcile(changed);
    expect(change.renamed.map(item => item.key)).toEqual(["unit:uuid-1"]);
    expect(change.rebuilt.map(item => item.key)).toEqual(["unit:uuid-2"]);
    // Without lamp 3, room 1 has exactly group 7's lamps: a duplicate, removed at once. Lamp 3 gets a grace period.
    expect(change.removed.map(item => item.key)).toEqual(["room:1"]);
    now = 60_000;
    expect(first.reconcile(changed).removed.map(item => item.key)).toEqual(["unit:uuid-3"]);
    expect(registry(store, "matter").entries().map(item => item.key)).not.toContain("unit:uuid-3");
  });
});
