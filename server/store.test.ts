import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalStore } from "./store";

const folders: string[] = [];
function store(): LocalStore { const folder = mkdtempSync(join(tmpdir(), "casambi-store-")); folders.push(folder); return new LocalStore(join(folder, "state.db"), "test-key"); }
afterEach(() => folders.splice(0).forEach(folder => rmSync(folder, { recursive: true, force: true })));

describe("LocalStore", () => {
  it("creates a salted local admin and verifies its password", () => {
    const database = store();
    expect(database.needsBootstrap()).toBe(true);
    const admin = database.createUser("operator", "a-strong-password", "admin");
    expect(database.needsBootstrap()).toBe(false);
    expect(database.verifyUser("operator", "a-strong-password")).toMatchObject({ id: admin.id, role: "admin" });
    expect(database.verifyUser("operator", "incorrect-password")).toBeNull();
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
});
