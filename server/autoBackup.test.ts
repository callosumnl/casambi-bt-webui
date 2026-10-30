import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutoBackup, cronFor, type AutoBackupSettings, type WebdavClient } from "./autoBackup";
import { openBackup, sealBackup } from "./backup";
import { LocalStore } from "./store";

const folders: string[] = [];
afterEach(() => folders.splice(0).forEach(folder => rmSync(folder, { recursive: true, force: true })));
const folder = () => { const path = mkdtempSync(join(tmpdir(), "casambi-auto-backup-")); folders.push(path); return path; };
const pi = (key = "pi-key") => new LocalStore(join(folder(), "state.db"), key);

const SETTINGS: AutoBackupSettings = { frequency: "daily", time: "03:30", weekday: 0, monthDay: 1, keep: 2, toLocal: true, toWebdav: false, webdavUrl: null, webdavUser: null };

/** A WebDAV server in memory: path → body; `status` overrides the answer to a PUT. */
function fakeWebdav(status = 201) {
  const files = new Map<string, Buffer>();
  const requests: Array<{ method: string; url: string; auth: { user: string | null; password: string | null } }> = [];
  const client: WebdavClient = async (method, url, auth, body) => {
    requests.push({ method, url, auth });
    if (method === "PUT") { if (status < 300) files.set(url, body!); return status; }
    return files.delete(url) ? 204 : 404;
  };
  return { client, files, requests };
}

function setup(webdav = fakeWebdav(), times = ["2026-10-30T03:30:00", "2026-10-31T03:30:00", "2026-11-01T03:30:00"]) {
  const store = pi();
  const backups = folder();
  const notifier = { notify: vi.fn() };
  let index = 0;
  const auto = new AutoBackup(store, passphrase => sealBackup({ database: store.exportDatabase(), secrets: { networkPassword: null, apiKey: null }, homekit: null, matter: null, appVersion: null }, passphrase), notifier, backups, webdav.client, () => new Date(times[Math.min(index++, times.length - 1)]));
  return { store, backups, notifier, auto, webdav };
}

describe("automatic backup schedules", () => {
  it("run daily, weekly, monthly, or not at all", () => {
    expect(cronFor(SETTINGS)).toBe("30 3 * * *");
    expect(cronFor({ ...SETTINGS, frequency: "weekly", weekday: 6, time: "22:05" })).toBe("5 22 * * 6");
    expect(cronFor({ ...SETTINGS, frequency: "monthly", monthDay: 15 })).toBe("30 3 15 * *");
    expect(cronFor({ ...SETTINGS, frequency: "off" })).toBeNull();
  });

  it("are off by default, and only scheduled when on", () => {
    const { auto } = setup();
    expect(auto.status()).toMatchObject({ frequency: "off", toLocal: true, toWebdav: false, nextRun: null, hasPassphrase: false });
    auto.update({ ...SETTINGS, frequency: "weekly", passphrase: "a long passphrase" }, "chris");
    expect(new Date(auto.status().nextRun!).getDay()).toBe(0);
    auto.update({ ...SETTINGS, frequency: "off" }, "chris");
    expect(auto.status().nextRun).toBeNull();
    auto.stop();
  });

  it("refuse a schedule without a passphrase or a place, and WebDAV without a folder", () => {
    const { auto } = setup();
    expect(() => auto.update(SETTINGS, "chris")).toThrow("A passphrase is required");
    expect(() => auto.update({ ...SETTINGS, toLocal: false, passphrase: "a long passphrase" }, "chris")).toThrow("Backups must go somewhere");
    expect(() => auto.update({ ...SETTINGS, toWebdav: true, passphrase: "a long passphrase" }, "chris")).toThrow("A WebDAV folder is required");
    // Off needs neither: the settings can be kept for later.
    expect(auto.update({ ...SETTINGS, frequency: "off", toLocal: false }, "chris").frequency).toBe("off");
    auto.stop();
  });
});

describe("automatic backup runs", () => {
  it("keep the last backups on the SD card, which open with the passphrase", async () => {
    const { auto, backups, store } = setup();
    auto.update({ ...SETTINGS, frequency: "off", passphrase: "a long passphrase" }, "chris");
    for (let run = 0; run < 3; run++) expect(await auto.run("chris")).toMatchObject({ ok: true, local: true, uploaded: false });
    expect(readdirSync(backups).sort()).toEqual(["casambi-backup-2026-10-31-0330.json", "casambi-backup-2026-11-01-0330.json"]);
    await expect(openBackup(auto.file("casambi-backup-2026-11-01-0330.json")!, "a long passphrase")).resolves.toMatchObject({ appVersion: null });
    expect(auto.file("../state.db")).toBeNull();
    expect(store.auditSince(0, ["auto_backup.created"])).toHaveLength(3);
    expect(JSON.stringify(store.auditSince(0, ["auto_backup.settings_changed"]))).not.toContain("a long passphrase");
  });

  it("go to a WebDAV folder only, keeping the last ones there", async () => {
    const webdav = fakeWebdav();
    const { auto, backups } = setup(webdav);
    auto.update({ ...SETTINGS, frequency: "off", toLocal: false, toWebdav: true, webdavUrl: "https://nas.local/backups/", webdavUser: "pi", webdavPassword: "nas-pass", passphrase: "a long passphrase" }, "chris");
    for (let run = 0; run < 3; run++) expect(await auto.run("chris")).toMatchObject({ ok: true, local: false, uploaded: true, message: "Saved in the WebDAV folder." });
    expect([...webdav.files.keys()]).toEqual(["https://nas.local/backups/casambi-backup-2026-10-31-0330.json", "https://nas.local/backups/casambi-backup-2026-11-01-0330.json"]);
    expect(webdav.requests[0].auth).toEqual({ user: "pi", password: "nas-pass" });
    expect(readdirSync(backups)).toEqual([]);
    expect(auto.status()).toMatchObject({ hasWebdavPassword: true, files: [] });
  });

  it("report a refused upload, keeping the copy on the SD card", async () => {
    const { auto, notifier, backups } = setup(fakeWebdav(401));
    auto.update({ ...SETTINGS, frequency: "off", toWebdav: true, webdavUrl: "https://nas.local/backups", passphrase: "a long passphrase" }, "chris");
    expect(await auto.run("chris")).toMatchObject({ ok: false, message: expect.stringContaining("saved on the Pi, but uploading it failed: the server refused the user name or password") });
    expect(readdirSync(backups)).toHaveLength(1);
    expect(notifier.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: "backup.failed", severity: "error" }));
    expect(auto.status().lastRun).toMatchObject({ ok: false });
  });

  it("test a WebDAV folder by writing and deleting a file", async () => {
    const webdav = fakeWebdav();
    const { auto } = setup(webdav);
    await expect(auto.testWebdav({ webdavUrl: "https://nas.local/backups", webdavUser: null, webdavPassword: "x" })).resolves.toEqual({ ok: true, message: "The WebDAV folder accepted a test file." });
    expect(webdav.requests.map(request => request.method)).toEqual(["PUT", "DELETE"]);
    expect(webdav.files.size).toBe(0);
    const missing = setup(fakeWebdav(409)).auto;
    await expect(missing.testWebdav({ webdavUrl: "https://nas.local/nope", webdavUser: null })).resolves.toMatchObject({ ok: false, message: expect.stringContaining("the folder does not exist") });
  });
});

describe("secret settings", () => {
  it("are stored encrypted and move to another Pi with a restore", async () => {
    const oldPi = pi("key-of-the-old-pi");
    oldPi.setSecretSetting("autoBackup.passphrase", "a long passphrase");
    expect(oldPi.secretSetting("autoBackup.passphrase")).toBe("a long passphrase");
    expect(oldPi.exportDatabase().toString("latin1")).not.toContain("a long passphrase");
    expect(oldPi.getCasambiConfig().apiKey).toBeNull();

    const newPi = pi("key-of-the-new-pi");
    newPi.setSecretSetting("autoBackup.webdavPassword", "stale");
    const file = join(folder(), "restore.db");
    writeFileSync(file, oldPi.exportDatabase());
    newPi.restoreDatabase(file, { networkPassword: null, apiKey: null, other: oldPi.otherSecrets() });
    expect(newPi.secretSetting("autoBackup.passphrase")).toBe("a long passphrase");
    expect(newPi.secretSetting("autoBackup.webdavPassword")).toBeNull();
  });
});
