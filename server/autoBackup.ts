import { Cron } from "croner";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { sealBackup } from "./backup";
import type { HomeKitBridge } from "./homekit/bridge";
import type { MatterBridge } from "./matter/bridge";
import type { Notifier } from "./notifications";
import type { LocalStore } from "./store";

/** Everything a backup file holds, encrypted with `passphrase`: the same for a download and an automatic backup. */
export async function createBackup(deps: { store: LocalStore; homekit?: HomeKitBridge; matter?: MatterBridge; appVersion: () => Promise<string | null> }, passphrase: string): Promise<Buffer> {
  const config = deps.store.getCasambiConfig();
  return sealBackup({
    database: deps.store.exportDatabase(),
    secrets: { networkPassword: config.networkPassword, apiKey: config.apiKey, other: deps.store.otherSecrets() },
    homekit: deps.homekit?.exportPairing() ?? null, matter: deps.matter?.exportPairing() ?? null,
    appVersion: await deps.appVersion(),
  }, passphrase);
}

/** "off" makes no automatic backups; a backup can still be made by hand. */
export type BackupFrequency = "off" | "daily" | "weekly" | "monthly";
export type AutoBackupSettings = {
  frequency: BackupFrequency; time: string;
  /** For "weekly": 0 is Sunday. */
  weekday: number;
  /** For "monthly": 1–28, so every month has it. */
  monthDay: number;
  keep: number;
  /** Where backups go: the SD card (data folder) and/or a WebDAV folder. */
  toLocal: boolean; toWebdav: boolean;
  webdavUrl: string | null; webdavUser: string | null;
};
export type AutoBackupRun = { at: string; ok: boolean; file: string | null; local: boolean; uploaded: boolean; message: string };
export type AutoBackupStatus = AutoBackupSettings & {
  hasPassphrase: boolean; hasWebdavPassword: boolean;
  lastRun: AutoBackupRun | null; nextRun: string | null;
  files: Array<{ name: string; size: number; createdAt: string }>;
};
/** A WebDAV request; tests replace it. */
export type WebdavClient = (method: "PUT" | "DELETE", url: string, auth: { user: string | null; password: string | null }, body?: Buffer) => Promise<number>;

const FILE_PATTERN = /^casambi-backup-\d{4}-\d{2}-\d{2}-\d{4}\.json$/;
const DEFAULTS: AutoBackupSettings = { frequency: "off", time: "03:30", weekday: 0, monthDay: 1, keep: 14, toLocal: true, toWebdav: false, webdavUrl: null, webdavUser: null };

/** The cron expression for a schedule, in the Pi's time zone; null when automatic backups are off. */
export function cronFor(settings: AutoBackupSettings): string | null {
  const [hour, minute] = settings.time.split(":").map(Number);
  switch (settings.frequency) {
    case "daily": return `${minute} ${hour} * * *`;
    case "weekly": return `${minute} ${hour} * * ${settings.weekday}`;
    case "monthly": return `${minute} ${hour} ${settings.monthDay} * *`;
    default: return null;
  }
}
const WEBDAV_TIMEOUT_MS = 60_000;

/** Sends a WebDAV request with basic authentication; redirects are not followed, so the backup only goes where it was told. */
export const webdavRequest: WebdavClient = async (method, url, auth, body) => {
  const headers: Record<string, string> = {};
  if (auth.user) headers.Authorization = `Basic ${Buffer.from(`${auth.user}:${auth.password ?? ""}`).toString("base64")}`;
  if (body) headers["Content-Type"] = "application/json";
  const response = await fetch(url, { method, headers, body: body ? new Uint8Array(body) : undefined, redirect: "manual", signal: AbortSignal.timeout(WEBDAV_TIMEOUT_MS) });
  return response.status;
};

/** A file URL inside the configured WebDAV folder. */
const remoteUrl = (folder: string, name: string) => `${folder.replace(/\/+$/, "")}/${encodeURIComponent(name)}`;
const describeStatus = (status: number) => status === 401 || status === 403 ? `the server refused the user name or password (HTTP ${status})` : status === 404 || status === 409 ? `the folder does not exist (HTTP ${status})` : `the server answered HTTP ${status}`;

/**
 * Makes an encrypted backup daily, weekly, or monthly (or never: "off"), to the data folder on the SD card and/or a
 * WebDAV folder (a NAS or Nextcloud), so a broken SD card need not take the backups along. The last `keep` of each
 * are kept. A failure is a notification (bell and webhook) and an audit entry. The passphrase and WebDAV password are
 * secret settings, so they survive a restore on another Pi.
 */
export class AutoBackup {
  private cron: Cron | null = null;
  private running: Promise<AutoBackupRun> | null = null;

  public constructor(
    private readonly store: LocalStore,
    private readonly makeBackup: (passphrase: string) => Promise<Buffer>,
    private readonly notifier: Pick<Notifier, "notify"> | null,
    private readonly folder: string,
    private readonly webdav: WebdavClient = webdavRequest,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public settings(): AutoBackupSettings {
    const raw = this.store.appSetting("autoBackup.settings");
    try { return { ...DEFAULTS, ...(raw ? JSON.parse(raw) as Partial<AutoBackupSettings> : {}) }; } catch { return { ...DEFAULTS }; }
  }

  public status(): AutoBackupStatus {
    const settings = this.settings();
    const lastRun = (() => { try { return JSON.parse(this.store.appSetting("autoBackup.lastRun") ?? "null") as AutoBackupRun | null; } catch { return null; } })();
    return {
      ...settings, hasPassphrase: Boolean(this.store.secretSetting("autoBackup.passphrase")), hasWebdavPassword: Boolean(this.store.secretSetting("autoBackup.webdavPassword")),
      lastRun, nextRun: this.cron?.nextRun()?.toISOString() ?? null, files: this.localFiles(),
    };
  }

  /** Saves the settings; an empty passphrase or password keeps the stored one. Reschedules at once. */
  public update(input: AutoBackupSettings & { passphrase?: string; webdavPassword?: string }, actor: string): AutoBackupStatus {
    const { passphrase, webdavPassword, ...settings } = input;
    if (passphrase) this.store.setSecretSetting("autoBackup.passphrase", passphrase);
    if (webdavPassword) this.store.setSecretSetting("autoBackup.webdavPassword", webdavPassword);
    if (settings.toWebdav && !settings.webdavUrl) throw new Error("A WebDAV folder is required to back up to WebDAV.");
    if (settings.frequency !== "off" && !settings.toLocal && !settings.toWebdav) throw new Error("Backups must go somewhere: the SD card, a WebDAV folder, or both.");
    if (settings.frequency !== "off" && !this.store.secretSetting("autoBackup.passphrase")) throw new Error("A passphrase is required for automatic backups: without it they cannot be restored.");
    if (!settings.webdavUrl) this.store.setSecretSetting("autoBackup.webdavPassword", null);
    const saved: AutoBackupSettings = { ...settings, webdavUrl: settings.webdavUrl || null, webdavUser: settings.webdavUrl ? settings.webdavUser || null : null };
    this.store.setAppSetting("autoBackup.settings", JSON.stringify(saved));
    this.store.audit(actor, "auto_backup.settings_changed", { frequency: saved.frequency, time: saved.time, keep: saved.keep, local: saved.toLocal, webdav: saved.toWebdav });
    this.schedule();
    return this.status();
  }

  /** Schedules the runs in the Pi's time zone, or stops them when automatic backups are off. */
  public schedule(): void {
    this.cron?.stop();
    this.cron = null;
    const pattern = cronFor(this.settings());
    if (pattern) this.cron = new Cron(pattern, { protect: true }, () => { void this.run("schedule"); });
  }

  public stop(): void { this.cron?.stop(); this.cron = null; }

  /** Makes a backup now (also used by the schedule); runs one at a time. */
  public run(actor: string): Promise<AutoBackupRun> {
    this.running ??= this.runOnce(actor).finally(() => { this.running = null; });
    return this.running;
  }

  /** Checks that the WebDAV folder takes a file, by writing and deleting a small test file. */
  public async testWebdav(input: { webdavUrl: string; webdavUser: string | null; webdavPassword?: string }): Promise<{ ok: boolean; message: string }> {
    const auth = { user: input.webdavUser, password: input.webdavPassword || this.store.secretSetting("autoBackup.webdavPassword") };
    const url = remoteUrl(input.webdavUrl, ".casambi-backup-test.json");
    try {
      const status = await this.webdav("PUT", url, auth, Buffer.from("{}"));
      if (status < 200 || status >= 300) return { ok: false, message: `Writing a test file failed: ${describeStatus(status)}.` };
      await this.webdav("DELETE", url, auth).catch(() => 0);
      return { ok: true, message: "The WebDAV folder accepted a test file." };
    } catch (error) { return { ok: false, message: `The WebDAV folder could not be reached: ${error instanceof Error ? error.message : "unknown error"}.` }; }
  }

  /** A local backup file, for downloading; null for a name that is not one of ours. */
  public file(name: string): Buffer | null {
    if (!FILE_PATTERN.test(name)) return null;
    try { return readFileSync(join(this.folder, name)); } catch { return null; }
  }

  private async runOnce(actor: string): Promise<AutoBackupRun> {
    const settings = this.settings();
    const passphrase = this.store.secretSetting("autoBackup.passphrase");
    const at = this.now();
    // Local date and time, like the schedule, so the name says when it ran on the Pi's clock.
    const pad = (value: number) => String(value).padStart(2, "0");
    const name = `casambi-backup-${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}.json`;
    let run: AutoBackupRun;
    try {
      if (!passphrase) throw new Error("No passphrase is set for automatic backups.");
      const webdavUrl = settings.toWebdav ? settings.webdavUrl : null;
      if (!settings.toLocal && !webdavUrl) throw new Error("No place is chosen for the backups: the SD card, a WebDAV folder, or both.");
      const file = await this.makeBackup(passphrase);
      if (settings.toLocal) {
        mkdirSync(this.folder, { recursive: true, mode: 0o700 });
        writeFileSync(join(this.folder, name), file, { mode: 0o600 });
        this.prune(this.localFiles().map(item => item.name), settings.keep, item => rmSync(join(this.folder, item), { force: true }));
      }
      let uploaded = false;
      if (webdavUrl) {
        const auth = { user: settings.webdavUser, password: this.store.secretSetting("autoBackup.webdavPassword") };
        const status = await this.webdav("PUT", remoteUrl(webdavUrl, name), auth, file).catch(error => { throw new Error(`The WebDAV folder could not be reached: ${error instanceof Error ? error.message : "unknown error"}`); });
        if (status < 200 || status >= 300) throw new Error(settings.toLocal ? `The backup was saved on the Pi, but uploading it failed: ${describeStatus(status)}.` : `Uploading the backup failed: ${describeStatus(status)}.`);
        uploaded = true;
        const remote = [...this.remoteFiles().filter(item => item !== name), name];
        const kept = this.prune(remote, settings.keep, item => { void this.webdav("DELETE", remoteUrl(webdavUrl, item), auth).catch(() => undefined); });
        this.store.setAppSetting("autoBackup.remoteFiles", JSON.stringify(kept));
      }
      run = { at: at.toISOString(), ok: true, file: name, local: settings.toLocal, uploaded, message: settings.toLocal ? uploaded ? "Saved on the Pi and in the WebDAV folder." : "Saved on the Pi." : "Saved in the WebDAV folder." };
      this.store.audit(actor, "auto_backup.created", { file: name, bytes: file.length, local: settings.toLocal, uploaded });
    } catch (error) {
      const message = error instanceof Error ? error.message : "The backup failed.";
      run = { at: at.toISOString(), ok: false, file: null, local: false, uploaded: false, message };
      this.store.audit(actor, "auto_backup.failed", { message });
      this.notifier?.notify({ kind: "backup.failed", severity: "error", title: "Automatic backup failed", message });
    }
    this.store.setAppSetting("autoBackup.lastRun", JSON.stringify(run));
    return run;
  }

  /** Deletes the oldest names beyond `keep` and returns the ones kept; names sort by date. */
  private prune(names: string[], keep: number, remove: (name: string) => void): string[] {
    const sorted = [...names].sort();
    const excess = sorted.slice(0, Math.max(0, sorted.length - keep));
    excess.forEach(remove);
    return sorted.slice(excess.length);
  }

  private localFiles(): Array<{ name: string; size: number; createdAt: string }> {
    try {
      return readdirSync(this.folder).filter(name => FILE_PATTERN.test(name)).sort().reverse()
        .map(name => { const stats = statSync(join(this.folder, name)); return { name, size: stats.size, createdAt: stats.mtime.toISOString() }; });
    } catch { return []; }
  }

  private remoteFiles(): string[] {
    try { const list = JSON.parse(this.store.appSetting("autoBackup.remoteFiles") ?? "[]") as unknown; return Array.isArray(list) ? list.filter((name): name is string => typeof name === "string" && FILE_PATTERN.test(name)) : []; } catch { return []; }
  }
}
