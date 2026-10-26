import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { EventHub } from "./events";
import { LocalStore } from "./store";
import { MAX_WAITING_PRESSES, resolveSwitchCommand, switchRuleSchema, SwitchRuleRunner } from "./switchRules";
import type { ControlRequest, NetworkSnapshot } from "./casambi/types";
import type { TimedSwitchPress } from "./casambi/service";

const folders: string[] = [];
function store(): LocalStore { const folder = mkdtempSync(join(tmpdir(), "casambi-switch-")); folders.push(folder); return new LocalStore(join(folder, "state.db"), "test-key"); }
afterEach(() => folders.splice(0).forEach(folder => rmSync(folder, { recursive: true, force: true })));

function unit(id: number, on: boolean) { return { id, uuid: `u${id}`, address: `a${id}`, name: `Lamp ${id}`, capabilities: [], state: { dimmer: on ? 255 : 0, sensors: [], on, online: true } }; }
function snapshot(units: ReturnType<typeof unit>[], groups: NetworkSnapshot["groups"] = []): NetworkSnapshot {
  return { connected: true, network: { id: "n", name: "N" }, units, groups, scenes: [], updatedAt: new Date().toISOString() };
}
const press = (trigger: TimedSwitchPress["trigger"], unitId = 2, button = 4): TimedSwitchPress => ({ unitId, button, trigger, raw: {}, at: new Date().toISOString() });

/** Applies on/off to an in-memory network so consecutive toggles observe each other. */
class FakeService {
  public readonly commands: ControlRequest[] = [];
  public failNext = false;
  public interrupted = 0;
  /** When set, control() waits for it, like a running fade. */
  public hold: Promise<void> | null = null;
  public constructor(public state: NetworkSnapshot) {}
  public interruptFade() { this.interrupted += 1; }
  public cachedSnapshot() { return { ...structuredClone(this.state), rooms: [], connection: { phase: "connected" as const } }; }
  public async control(command: ControlRequest): Promise<NetworkSnapshot> {
    if (this.failNext) { this.failNext = false; throw new Error("The Casambi bridge is not connected."); }
    this.commands.push(command);
    if (this.hold) await this.hold;
    for (const item of this.state.units) if (command.targetType === "network" || item.id === Number(command.targetId)) item.state.on = command.operation === "on";
    return this.state;
  }
}

describe("resolveSwitchCommand", () => {
  it("turns a toggle off when any targeted lamp is on, and on when none are", () => {
    const state = snapshot([unit(1, true), unit(2, false), unit(3, false)], [{ id: 9, name: "G", unitIds: [2, 3] }]);
    expect(resolveSwitchCommand({ targetType: "unit", targetId: 1, operation: "toggle" }, state, [])).toEqual({ targetType: "unit", targetId: 1, operation: "off" });
    expect(resolveSwitchCommand({ targetType: "group", targetId: 9, operation: "toggle" }, state, []).operation).toBe("on");
    expect(resolveSwitchCommand({ targetType: "room", targetId: 5, operation: "toggle" }, state, [{ unitId: 1, customName: null, roomId: 5 }]).operation).toBe("off");
    expect(resolveSwitchCommand({ targetType: "network", operation: "toggle" }, state, []).operation).toBe("off");
  });

  it("passes ordinary commands through unchanged", () => {
    const command = { targetType: "unit" as const, targetId: 1, operation: "set_level" as const, value: 128 };
    expect(resolveSwitchCommand(command, snapshot([]), [])).toBe(command);
  });
});

describe("switchRuleSchema", () => {
  it("accepts a toggle or any valid control command, and rejects unknown triggers", () => {
    expect(switchRuleSchema.parse({ name: "Eiland", unitId: 2, button: 4, trigger: "tap", command: { targetType: "unit", targetId: 1, operation: "toggle" } }).enabled).toBe(true);
    expect(() => switchRuleSchema.parse({ name: "Dim", unitId: 2, button: 4, trigger: "hold", command: { targetType: "unit", targetId: 1, operation: "set_level", value: 77 } })).not.toThrow();
    expect(() => switchRuleSchema.parse({ name: "Bad", unitId: 2, button: 4, trigger: "press", command: { targetType: "unit", targetId: 1, operation: "on" } })).toThrow();
    expect(() => switchRuleSchema.parse({ name: "Bad", unitId: 2, button: 4, trigger: "tap", command: { targetType: "unit", targetId: 1, operation: "set_level" } })).toThrow();
  });
});

describe("SwitchRuleRunner", () => {
  it("runs only enabled rules matching unit, button, and trigger, and ignores raw activity", async () => {
    const database = store(); const service = new FakeService(snapshot([unit(1, false)]));
    database.createSwitchRule({ name: "Tap on", unitId: 2, button: 4, trigger: "tap", command: { targetType: "unit", targetId: 1, operation: "on" }, enabled: true });
    database.createSwitchRule({ name: "Hold", unitId: 2, button: 4, trigger: "hold", command: { targetType: "unit", targetId: 1, operation: "off" }, enabled: true });
    database.createSwitchRule({ name: "Other button", unitId: 2, button: 3, trigger: "tap", command: { targetType: "unit", targetId: 1, operation: "off" }, enabled: true });
    database.createSwitchRule({ name: "Disabled", unitId: 2, button: 4, trigger: "tap", command: { targetType: "unit", targetId: 1, operation: "off" }, enabled: false });
    const runner = new SwitchRuleRunner(database, service as never, new EventHub());

    await runner.handle(press(null));
    await runner.handle(press("tap"));

    expect(service.commands).toEqual([{ targetType: "unit", targetId: 1, operation: "on" }]);
    expect(database.listSwitchRules().find(rule => rule.name === "Tap on")?.lastTriggeredAt).toEqual(expect.any(String));
  });

  it("handles rapid taps in order so consecutive toggles alternate", async () => {
    const database = store(); const service = new FakeService(snapshot([unit(1, false)]));
    database.createSwitchRule({ name: "Toggle", unitId: 2, button: 4, trigger: "tap", command: { targetType: "unit", targetId: 1, operation: "toggle" }, enabled: true });
    const runner = new SwitchRuleRunner(database, service as never, new EventHub());

    await Promise.all([runner.handle(press("tap")), runner.handle(press("tap")), runner.handle(press("tap"))]);

    expect(service.commands.map(command => command.operation)).toEqual(["on", "off", "on"]);
  });

  it("audits a failed rule and keeps handling later presses", async () => {
    const database = store(); const service = new FakeService(snapshot([unit(1, false)]));
    const rule = database.createSwitchRule({ name: "On", unitId: 2, button: 4, trigger: "tap", command: { targetType: "unit", targetId: 1, operation: "on" }, enabled: true });
    const runner = new SwitchRuleRunner(database, service as never, new EventHub());
    service.failNext = true;

    await runner.handle(press("tap"));
    await runner.handle(press("tap"));

    expect(service.commands).toHaveLength(1);
    expect(database.recentAudit().find(entry => entry.action === "switch_rule.failed")?.detail).toEqual({ ruleId: rule.id, message: "The Casambi bridge is not connected." });
  });
});

describe("SwitchRuleRunner while a rule is still running", () => {
  it("interrupts the running fade for a new press and drops presses beyond the waiting limit", async () => {
    const database = store(); const service = new FakeService(snapshot([unit(1, false)]));
    database.createSwitchRule({ name: "Toggle", unitId: 2, button: 4, trigger: "tap", command: { targetType: "unit", targetId: 1, operation: "toggle" }, enabled: true });
    const runner = new SwitchRuleRunner(database, service as never, new EventHub());
    let release!: () => void; service.hold = new Promise(resolve => { release = resolve; });
    const presses = Array.from({ length: MAX_WAITING_PRESSES + 5 }, () => runner.handle(press("tap")));
    expect(service.interrupted).toBe(MAX_WAITING_PRESSES);
    service.hold = null; release();
    await Promise.all(presses);
    expect(service.commands).toHaveLength(MAX_WAITING_PRESSES + 1);
    expect(database.recentAudit(10, "switch_rule.failed").filter(entry => String(entry.detail.message).startsWith("Too many"))).toHaveLength(4);
  });
});

describe("LocalStore switch rules", () => {
  it("creates, updates, lists, and deletes rules", () => {
    const database = store();
    const rule = database.createSwitchRule({ name: " Eiland ", unitId: 2, button: 4, trigger: "tap", command: { targetType: "unit", targetId: 1, operation: "toggle" }, enabled: true });
    expect(rule).toMatchObject({ name: "Eiland", unitId: 2, button: 4, trigger: "tap", enabled: true, lastTriggeredAt: null });
    expect(database.updateSwitchRule(rule.id, { enabled: false, trigger: "hold" })).toMatchObject({ enabled: false, trigger: "hold" });
    expect(database.listSwitchRules()).toHaveLength(1);
    database.deleteSwitchRule(rule.id);
    expect(database.listSwitchRules()).toHaveLength(0);
    expect(() => database.deleteSwitchRule(rule.id)).toThrow("Switch rule does not exist.");
  });
});

describe("SwitchRuleRunner resilience", () => {
  it("keeps handling presses after one press failed outside a rule", async () => {
    const database = store(); const service = new FakeService(snapshot([unit(1, false)]));
    database.createSwitchRule({ name: "On", unitId: 2, button: 4, trigger: "tap", command: { targetType: "unit", targetId: 1, operation: "on" }, enabled: true });
    const runner = new SwitchRuleRunner(database, service as never, new EventHub());
    const original = database.listSwitchRules.bind(database);
    let failOnce = true;
    database.listSwitchRules = () => { if (failOnce) { failOnce = false; throw new Error("database is locked"); } return original(); };
    await expect(runner.handle(press("tap"))).resolves.toBeUndefined();
    await runner.handle(press("tap"));
    expect(service.commands).toEqual([{ targetType: "unit", targetId: 1, operation: "on" }]);
  });
});

