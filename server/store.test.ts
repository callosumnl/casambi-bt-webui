import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUDIT_RETENTION, LocalStore } from "./store";

const folders: string[] = [];
function store(): LocalStore { const folder = mkdtempSync(join(tmpdir(), "casambi-store-")); folders.push(folder); return new LocalStore(join(folder, "state.db"), "test-key"); }
afterEach(() => folders.splice(0).forEach(folder => rmSync(folder, { recursive: true, force: true })));

describe("LocalStore", () => {
  it("creates a salted local admin and verifies its password", async () => {
    const database = store();
    expect(database.needsBootstrap()).toBe(true);
    const admin = database.createUser("operator", "a-strong-password", "admin");
    expect(database.needsBootstrap()).toBe(false);
    expect(await database.verifyUser("operator", "a-strong-password")).toMatchObject({ id: admin.id, role: "admin" });
    expect(await database.verifyUser("operator", "incorrect-password")).toBeNull();
  });

  it("creates, verifies, and revokes API keys without retaining their plaintext", () => {
    const database = store();
    const created = database.createApiKey("integration", "user");
    expect(created.token).toMatch(/^cbt_[a-f0-9]{8}_/);
    expect(database.listApiKeys()[0]).not.toHaveProperty("token");
    expect(database.authenticateApiKey(created.token)).toMatchObject({ label: "integration", role: "user" });
    database.revokeApiKey(created.id);
    expect(database.authenticateApiKey(created.token)).toBeNull();
  });

  it("stores Casambi secret configuration separately from the safe admin view", () => {
    const database = store();
    database.saveCasambiConfig({ networkAddress: "AA:BB:CC:DD:EE:FF", networkUuid: null, apiKey: "network-api", networkPassword: "network-password", btAdapter: "hci0", forceOffline: false, pollingEnabled: true, pollingIntervalSeconds: 30, solarLatitude: null, solarLongitude: null });
    expect(database.getSafeCasambiConfig()).toEqual(expect.objectContaining({ networkAddress: "AA:BB:CC:DD:EE:FF", hasApiKey: true, hasNetworkPassword: true }));
    expect(database.getSafeCasambiConfig()).not.toHaveProperty("networkPassword");
    expect(database.getCasambiConfig().networkPassword).toBe("network-password");
  });

  it("persists non-secret solar coordinates for local sunrise and sunset scheduling", () => {
    const database = store();
    database.saveCasambiConfig({ ...database.getCasambiConfig(), solarLatitude: 52.3676, solarLongitude: 4.9041 });
    expect(database.getSafeCasambiConfig()).toMatchObject({ solarLatitude: 52.3676, solarLongitude: 4.9041 });
  });

  it("stores bounded default brightness values for rooms", () => {
    const database = store();
    const room = database.createRoom("Studio", 65);
    expect(room).toMatchObject({ name: "Studio", defaultBrightnessPercent: 65 });
    expect(database.setRoomDefaultBrightness(room.id, 42)).toMatchObject({ id: room.id, defaultBrightnessPercent: 42 });
    expect(() => database.setRoomDefaultBrightness(room.id, 101)).toThrow("Default brightness");
  });

  it("persists reusable away-date sets and detaches them safely from linked timers", () => {
    const database = store();
    const owner = database.createUser("operator", "a-strong-password", "admin");
    const set = database.createAwayDateSet("Summer break", ["2026-08-17", "2026-08-18"]);
    const schedule = database.createSchedule({ name: "Morning", cronExpression: "0 9 * * *", timezone: "Europe/Amsterdam", command: { targetType: "network", operation: "on" }, solar: null, holidayDates: [], awayDateSetId: set.id, awayDateSet: set, enabled: true, ownerUserId: owner.id });
    expect(schedule.awayDateSet).toMatchObject({ id: set.id, name: "Summer break" });
    expect(database.updateAwayDateSet(set.id, { dates: ["2026-08-19"] }).dates).toEqual(["2026-08-19"]);
    expect(database.getSchedule(schedule.id)?.awayDateSet?.dates).toEqual(["2026-08-19"]);
    database.deleteAwayDateSet(set.id);
    expect(database.getSchedule(schedule.id)?.awayDateSetId).toBeNull();
    expect(database.getSchedule(schedule.id)?.awayDateSet).toBeNull();
  });

  it("stores, renames, recaptures, and deletes light scenes", () => {
    const database = store();
    const scene = database.createLightScene(" Dinner ", { type: "room", id: 3 }, [{ unitId: 1, level: 128, temperature: null }]);
    expect(scene).toMatchObject({ name: "Dinner", scope: { type: "room", id: 3 }, lamps: [{ unitId: 1, level: 128, temperature: null }] });
    expect(database.updateLightScene(scene.id, { name: "Late dinner", lamps: [{ unitId: 1, level: 40, temperature: 2700 }] })).toMatchObject({ name: "Late dinner", lamps: [{ level: 40 }] });
    expect(database.listLightScenes()).toHaveLength(1);
    database.deleteLightScene(scene.id);
    expect(() => database.deleteLightScene(scene.id)).toThrow("Scene does not exist.");
  });

  it("treats an empty secret as cleared instead of storing a value it can never decrypt", () => {
    const database = store();
    database.saveCasambiConfig({ ...database.getCasambiConfig(), networkAddress: "AB:CD:EF:01:23:45", networkPassword: "", apiKey: "" });
    expect(database.getCasambiConfig()).toMatchObject({ networkPassword: null, apiKey: null });
    database.saveCasambiConfig({ ...database.getCasambiConfig(), networkPassword: "secret" });
    expect(database.getCasambiConfig().networkPassword).toBe("secret");
  });

  it("reports deleting a missing room or revoking a missing API key", () => {
    const database = store();
    expect(() => database.deleteRoom(999)).toThrow("Room does not exist.");
    expect(() => database.revokeApiKey(999)).toThrow("API key does not exist.");
  });

  // These insert over 20,000 audit rows, which takes several seconds on a CI runner.
  it("prunes everyday events separately, so they cannot push security events out of the audit log", () => {
    const database = store();
    database.audit("admin", "user.deleted", { id: 7 });
    // 499 more than the budget, so the last entry (id 20,500) triggers the periodic prune.
    for (let index = 1; index <= AUDIT_RETENTION + 499; index += 1) database.audit("operator", "lighting.control", { index });
    expect(database.recentAudit(1, "user.")).toEqual([expect.objectContaining({ action: "user.deleted", detail: { id: 7 } })]);
    expect(database.recentAudit(AUDIT_RETENTION + 10, "lighting.")).toHaveLength(AUDIT_RETENTION);
  }, 30_000);

  it("prunes the audit log to the newest entries and matches action prefixes literally", () => {
    const database = store();
    for (let index = 1; index <= AUDIT_RETENTION + 500; index += 1) database.audit("test", index % 2 ? "bridge.poll_failed" : "lighting.control", { index });
    expect(database.recentAudit(500).length).toBe(500);
    expect(database.recentAudit(1)[0].detail).toEqual({ index: AUDIT_RETENTION + 500 });
    const count = (database as unknown as { db: { prepare(sql: string): { get(): { count: number } } } }).db.prepare("SELECT COUNT(*) AS count FROM audit_log").get().count;
    expect(count).toBe(AUDIT_RETENTION);
    expect(database.recentAudit(3, "bridge.").every(entry => entry.action === "bridge.poll_failed")).toBe(true);
    expect(database.recentAudit(3, "bridge_")).toEqual([]);
  }, 30_000);

  it("stops accepting an API key once it has expired", () => {
    vi.useFakeTimers({ now: new Date("2026-10-26T12:00:00Z") });
    try {
      const database = store();
      const key = database.createApiKey("Home Assistant", "user", 30);
      const forever = database.createApiKey("Script", "user");
      expect(key.expiresAt).toBe("2026-11-25T12:00:00.000Z");
      expect(database.authenticateApiKey(key.token)).not.toBeNull();
      vi.setSystemTime(new Date("2026-11-25T12:00:01Z"));
      expect(database.authenticateApiKey(key.token)).toBeNull();
      expect(database.authenticateApiKey(forever.token)).toMatchObject({ expiresAt: null });
    } finally { vi.useRealTimers(); }
  });
});
