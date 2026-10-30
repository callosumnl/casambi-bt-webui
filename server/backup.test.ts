import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { openBackup, sealBackup } from "./backup";
import { LocalStore } from "./store";

const folders: string[] = [];
afterEach(() => folders.splice(0).forEach(folder => rmSync(folder, { recursive: true, force: true })));
/** A store on its own data folder, with its own encryption key, like a separate Raspberry Pi. */
function pi(key: string): LocalStore { const folder = mkdtempSync(join(tmpdir(), "casambi-backup-")); folders.push(folder); return new LocalStore(join(folder, "state.db"), key); }

describe("backup files", () => {
  it("only open with the passphrase they were made with, and refuse tampering", async () => {
    const file = await sealBackup({ database: Buffer.from("db bytes"), secrets: { networkPassword: "net-pass", apiKey: null }, homekit: null, matter: null, appVersion: "1.0.0" }, "correct horse battery");
    await expect(openBackup(file, "correct horse battery")).resolves.toMatchObject({ database: Buffer.from("db bytes"), secrets: { networkPassword: "net-pass", apiKey: null }, appVersion: "1.0.0" });
    await expect(openBackup(file, "wrong passphrase")).rejects.toThrow("The backup passphrase is invalid, or the file is damaged.");
    const tampered = JSON.parse(file.toString()) as { header: { appVersion: string } };
    tampered.header.appVersion = "9.9.9";
    await expect(openBackup(Buffer.from(JSON.stringify(tampered)), "correct horse battery")).rejects.toThrow("passphrase is invalid, or the file is damaged");
    await expect(openBackup(Buffer.from("PK\u0003\u0004 not a backup"), "x")).rejects.toThrow("The file is invalid: it is not a Casambi BT WebGUI backup.");
    expect(file.toString()).not.toContain("net-pass");
  });
});

describe("HomeKit pairing in backups", () => {
  it("carries the pairing encrypted, and opens older backups without one", async () => {
    const pairing = { username: "AA:BB:CC:DD:EE:FF", entries: { "AccessoryInfo.AABBCCDDEEFF.json": { signSk: "private-key-material" } } };
    const matter = { nodeId: "casambi-1", files: { "root.operationalCredentials.nocs": Buffer.from("matter-key-material").toString("base64") } };
    const file = await sealBackup({ database: Buffer.from("db"), secrets: { networkPassword: null, apiKey: null }, homekit: pairing, matter, appVersion: null }, "a passphrase");
    expect(file.toString()).not.toContain("private-key-material");
    await expect(openBackup(file, "a passphrase")).resolves.toMatchObject({ homekit: pairing, matter });
    expect(file.toString()).not.toContain(matter.files["root.operationalCredentials.nocs"]);
    // A backup made before HomeKit support: its encrypted part has no homekit field.
    const older = await sealBackup({ database: Buffer.from("db"), secrets: { networkPassword: null, apiKey: null }, appVersion: null } as unknown as Parameters<typeof sealBackup>[0], "a passphrase");
    await expect(openBackup(older, "a passphrase")).resolves.toMatchObject({ homekit: null, matter: null });
  });
});

describe("LocalStore restore", () => {
  it("moves everything to another Pi with a different encryption key and ends earlier sessions", async () => {
    const oldPi = pi("key-of-the-old-pi");
    oldPi.createUser("chris", "a-strong-password", "admin");
    oldPi.saveCasambiConfig({ ...oldPi.getCasambiConfig(), networkAddress: "AB:CD:EF:01:23:45", networkPassword: "casambi-network-pass", solarLatitude: 52.37, solarLongitude: 4.9 });
    const kitchen = oldPi.createRoom("Kitchen", 80);
    oldPi.setUnitMetadata(4, "Island", kitchen.id);
    const key = oldPi.createApiKey("Home Assistant", "user");
    const config = oldPi.getCasambiConfig();
    const file = await sealBackup({ database: oldPi.exportDatabase(), secrets: { networkPassword: config.networkPassword, apiKey: config.apiKey }, homekit: null, matter: null, appVersion: null }, "move to the new pi");

    const newPi = pi("key-of-the-new-pi");
    newPi.createUser("setup", "temporary-admin-pass", "admin");
    const epochBefore = newPi.sessionEpoch();
    const backup = await openBackup(file, "move to the new pi");
    const restoreFile = join(folders[1], "restore.db");
    writeFileSync(restoreFile, backup.database);
    newPi.restoreDatabase(restoreFile, backup.secrets);

    expect(newPi.listUsers().map(user => user.username)).toEqual(["chris"]);
    expect(await newPi.verifyUser("chris", "a-strong-password")).not.toBeNull();
    expect(newPi.getCasambiConfig()).toMatchObject({ networkAddress: "AB:CD:EF:01:23:45", networkPassword: "casambi-network-pass", solarLatitude: 52.37 });
    expect(newPi.listRooms()).toEqual([expect.objectContaining({ name: "Kitchen", defaultBrightnessPercent: 80 })]);
    expect(newPi.getUnitMetadata()).toEqual([{ unitId: 4, customName: "Island", roomId: kitchen.id }]);
    expect(newPi.authenticateApiKey(key.token)).toMatchObject({ label: "Home Assistant" });
    expect(newPi.sessionEpoch()).not.toBe(epochBefore);
    // The restore runs on the live database: new rooms still get fresh ids afterwards.
    expect(newPi.createRoom("Hall").id).toBeGreaterThan(kitchen.id);
  });

  it("leaves the data untouched when the backup is not a database", () => {
    const store = pi("key");
    store.createUser("chris", "a-strong-password", "admin");
    const file = join(folders[0], "broken.db");
    writeFileSync(file, "not sqlite");
    expect(() => store.restoreDatabase(file, { networkPassword: null, apiKey: null })).toThrow();
    expect(store.listUsers().map(user => user.username)).toEqual(["chris"]);
  });
});
