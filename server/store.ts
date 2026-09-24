import { createRequire } from "module";
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from "crypto";
import { dirname, resolve } from "path";
import { mkdirSync } from "fs";
import type { ControlRequest, SwitchTrigger } from "./casambi/types";
import type { SolarSchedule } from "./solar";

const runtimeRequire = createRequire(import.meta.url);
const { DatabaseSync } = runtimeRequire("node:sqlite") as typeof import("node:sqlite");

export type Role = "admin" | "user";
export type StoredUser = { id: number; username: string; role: Role; createdAt: string };
type UserRow = StoredUser & { passwordHash: string; passwordSalt: string };
export type ApiKeyRecord = { id: number; label: string; prefix: string; role: Role; createdAt: string; lastUsedAt: string | null; revokedAt: string | null };
export type RoomRecord = { id: number; name: string; sortOrder: number; defaultBrightnessPercent: number };
export type UnitMetadata = { unitId: number; customName: string | null; roomId: number | null };
/** A rule's action: any validated control, or a toggle resolved against current lamp state when it fires. */
export type SwitchRuleCommand = ControlRequest | { targetType: "unit" | "group" | "room" | "network"; targetId?: number | string | null; operation: "toggle" };
export type SwitchRuleRecord = { id: number; name: string; unitId: number; button: number; trigger: SwitchTrigger; command: SwitchRuleCommand; enabled: boolean; createdAt: string; updatedAt: string; lastTriggeredAt: string | null };
export type AwayDateSet = { id: number; name: string; dates: string[]; createdAt: string; updatedAt: string };
export type ScheduleRecord = {
  id: number; name: string; cronExpression: string; timezone: string; command: ControlRequest;
  solar: SolarSchedule | null; holidayDates: string[]; awayDateSetId: number | null; awayDateSet: AwayDateSet | null; enabled: boolean; ownerUserId: number; createdAt: string; updatedAt: string; lastRunKey: string | null; lastRunAt: string | null;
};

/** Local configuration with secret fields omitted unless explicitly requested. */
export type CasambiConfig = {
  networkAddress: string | null;
  networkUuid: string | null;
  apiKey: string | null;
  networkPassword: string | null;
  btAdapter: string | null;
  forceOffline: boolean;
  pollingEnabled: boolean;
  pollingIntervalSeconds: number;
  solarLatitude: number | null;
  solarLongitude: number | null;
};

const NOW = () => new Date().toISOString();

/**
 * SQLite repository for the Raspberry Pi appliance. The database contains no
 * plaintext password, API key, or Casambi network secret.
 */
export class LocalStore {
  private readonly db: InstanceType<typeof DatabaseSync>;
  private readonly encryptionKey: Buffer;

  public constructor(filename = process.env.CASAMBI_DB_PATH || resolve(process.cwd(), "data/casambi-bt-webui.db"), encryptionSecret = process.env.CASAMBI_ENCRYPTION_KEY || "development-only-change-me") {
    mkdirSync(dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.encryptionKey = createHash("sha256").update(encryptionSecret).digest();
    this.migrate();
  }

  /** Creates the durable schema. Migrations are idempotent for appliance upgrades. */
  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS local_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','user')), created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS api_keys (
        id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL, prefix TEXT NOT NULL UNIQUE, digest TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('admin','user')), created_at TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT
      );
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, encrypted INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS rooms (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, sort_order INTEGER NOT NULL DEFAULT 0, default_brightness_percent INTEGER NOT NULL DEFAULT 100 CHECK(default_brightness_percent BETWEEN 0 AND 100));
      CREATE TABLE IF NOT EXISTS unit_metadata (unit_id INTEGER PRIMARY KEY, custom_name TEXT, room_id INTEGER REFERENCES rooms(id) ON DELETE SET NULL);
      CREATE TABLE IF NOT EXISTS away_date_sets (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, dates_json TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS schedules (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, cron_expression TEXT NOT NULL, timezone TEXT NOT NULL,
        command_json TEXT NOT NULL, solar_json TEXT, holiday_dates_json TEXT, away_date_set_id INTEGER, enabled INTEGER NOT NULL DEFAULT 1, owner_user_id INTEGER NOT NULL REFERENCES local_users(id),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_run_key TEXT, last_run_at TEXT
      );
      CREATE TABLE IF NOT EXISTS switch_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, unit_id INTEGER NOT NULL, button INTEGER NOT NULL, trigger TEXT NOT NULL,
        command_json TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_triggered_at TEXT
      );
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT NOT NULL, action TEXT NOT NULL, detail_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
    `);
    const roomColumns = this.db.prepare("PRAGMA table_info(rooms)").all() as Array<{ name: string }>;
    if (!roomColumns.some(column => column.name === "default_brightness_percent")) this.db.exec("ALTER TABLE rooms ADD COLUMN default_brightness_percent INTEGER NOT NULL DEFAULT 100 CHECK(default_brightness_percent BETWEEN 0 AND 100)");
    const scheduleColumns = this.db.prepare("PRAGMA table_info(schedules)").all() as Array<{ name: string }>;
    if (!scheduleColumns.some(column => column.name === "solar_json")) this.db.exec("ALTER TABLE schedules ADD COLUMN solar_json TEXT");
    if (!scheduleColumns.some(column => column.name === "holiday_dates_json")) this.db.exec("ALTER TABLE schedules ADD COLUMN holiday_dates_json TEXT");
    if (!scheduleColumns.some(column => column.name === "away_date_set_id")) this.db.exec("ALTER TABLE schedules ADD COLUMN away_date_set_id INTEGER");
  }

  /** Returns whether an initial appliance administrator still needs to be created. */
  public needsBootstrap(): boolean {
    return (this.db.prepare("SELECT COUNT(*) AS count FROM local_users").get() as { count: number }).count === 0;
  }

  /** Creates a local user. Only the caller chooses which role is assigned. */
  public createUser(username: string, password: string, role: Role): StoredUser {
    const normalized = username.trim().toLowerCase();
    const passwordSalt = randomBytes(16).toString("hex");
    const passwordHash = this.hashPassword(password, passwordSalt);
    const info = this.db.prepare("INSERT INTO local_users (username,password_hash,password_salt,role,created_at) VALUES (?,?,?,?,?)")
      .run(normalized, passwordHash, passwordSalt, role, NOW());
    return this.getUserById(Number(info.lastInsertRowid))!;
  }

  /** Checks a password without exposing its stored digest. */
  public verifyUser(username: string, password: string): StoredUser | null {
    const row = this.db.prepare("SELECT id,username,password_hash AS passwordHash,password_salt AS passwordSalt,role,created_at AS createdAt FROM local_users WHERE username = ?")
      .get(username.trim().toLowerCase()) as UserRow | undefined;
    if (!row || !this.safeEqual(this.hashPassword(password, row.passwordSalt), row.passwordHash)) return null;
    return { id: row.id, username: row.username, role: row.role, createdAt: row.createdAt };
  }

  /** Lists users without any password material. */
  public listUsers(): StoredUser[] {
    return this.db.prepare("SELECT id,username,role,created_at AS createdAt FROM local_users ORDER BY username").all() as StoredUser[];
  }

  /** Updates a user role while forbidding accidental deletion of all administrators. */
  public setUserRole(id: number, role: Role): StoredUser {
    const current = this.getUserById(id);
    if (!current) throw new Error("User does not exist.");
    if (current.role === "admin" && role === "user" && this.adminCount() < 2) throw new Error("At least one admin account must remain.");
    this.db.prepare("UPDATE local_users SET role = ? WHERE id = ?").run(role, id);
    return this.getUserById(id)!;
  }

  /** Generates a revocable API key. The plaintext is returned only from this call. */
  public createApiKey(label: string, role: Role): ApiKeyRecord & { token: string } {
    const prefix = randomBytes(4).toString("hex");
    const secret = randomBytes(32).toString("base64url");
    const token = `cbt_${prefix}_${secret}`;
    const info = this.db.prepare("INSERT INTO api_keys (label,prefix,digest,role,created_at) VALUES (?,?,?,?,?)")
      .run(label.trim(), prefix, this.digest(token), role, NOW());
    const record = this.getApiKey(Number(info.lastInsertRowid))!;
    return { ...record, token };
  }

  /** Verifies an API key constant-time and records its latest use. */
  public authenticateApiKey(token: string): ApiKeyRecord | null {
    const match = /^cbt_([a-f0-9]{8})_[A-Za-z0-9_-]+$/.exec(token);
    if (!match) return null;
    const row = this.db.prepare("SELECT id,label,prefix,digest,role,created_at AS createdAt,last_used_at AS lastUsedAt,revoked_at AS revokedAt FROM api_keys WHERE prefix = ?")
      .get(match[1]) as (ApiKeyRecord & { digest: string }) | undefined;
    if (!row || row.revokedAt || !this.safeEqual(this.digest(token), row.digest)) return null;
    this.db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(NOW(), row.id);
    const { digest: _digest, ...record } = row;
    return { ...record, lastUsedAt: NOW() };
  }

  /** Lists API key metadata without ever returning a token or digest. */
  public listApiKeys(): ApiKeyRecord[] {
    return this.db.prepare("SELECT id,label,prefix,role,created_at AS createdAt,last_used_at AS lastUsedAt,revoked_at AS revokedAt FROM api_keys ORDER BY id DESC").all() as ApiKeyRecord[];
  }

  /** Makes an API key unusable while retaining its audit history. */
  public revokeApiKey(id: number): void { this.db.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ?").run(NOW(), id); }

  /** Stores Casambi settings, encrypting sensitive values with AES-256-GCM. */
  public saveCasambiConfig(input: CasambiConfig): void {
    const values: Array<[string, string | number | boolean | null, boolean]> = [
      ["networkAddress", input.networkAddress, false], ["networkUuid", input.networkUuid, false], ["btAdapter", input.btAdapter, false],
      ["forceOffline", input.forceOffline, false], ["apiKey", input.apiKey, true], ["networkPassword", input.networkPassword, true],
      ["pollingEnabled", input.pollingEnabled, false], ["pollingIntervalSeconds", input.pollingIntervalSeconds, false],
      ["solarLatitude", input.solarLatitude, false], ["solarLongitude", input.solarLongitude, false],
    ];
    const write = this.db.prepare("INSERT INTO settings (key,value,encrypted) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, encrypted=excluded.encrypted");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      values.forEach(([key, value, encrypted]) => write.run(key, value == null ? "" : encrypted ? this.encrypt(String(value)) : String(value), encrypted ? 1 : 0));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Gets the decrypted config for the bridge. Callers must not return it to clients. */
  public getCasambiConfig(): CasambiConfig {
    const rows = this.db.prepare("SELECT key,value,encrypted FROM settings").all() as Array<{ key: string; value: string; encrypted: number }>;
    const values = new Map(rows.map(row => [row.key, row.encrypted ? this.decrypt(row.value) : row.value]));
    return {
      networkAddress: values.get("networkAddress") || null, networkUuid: values.get("networkUuid") || null,
      apiKey: values.get("apiKey") || null, networkPassword: values.get("networkPassword") || null,
      btAdapter: values.get("btAdapter") || null, forceOffline: values.get("forceOffline") === "true",
      pollingEnabled: values.get("pollingEnabled") === "true", pollingIntervalSeconds: Math.max(5, Math.min(3600, Number(values.get("pollingIntervalSeconds") || 30))),
      solarLatitude: values.has("solarLatitude") && values.get("solarLatitude") !== "" ? Number(values.get("solarLatitude")) : null,
      solarLongitude: values.has("solarLongitude") && values.get("solarLongitude") !== "" ? Number(values.get("solarLongitude")) : null,
    };
  }

  /** Returns non-sensitive connection fields suitable for the Admin Panel. */
  public getSafeCasambiConfig(): Omit<CasambiConfig, "apiKey" | "networkPassword"> & { hasApiKey: boolean; hasNetworkPassword: boolean } {
    const config = this.getCasambiConfig();
    return { networkAddress: config.networkAddress, networkUuid: config.networkUuid, btAdapter: config.btAdapter, forceOffline: config.forceOffline, pollingEnabled: config.pollingEnabled, pollingIntervalSeconds: config.pollingIntervalSeconds, solarLatitude: config.solarLatitude, solarLongitude: config.solarLongitude, hasApiKey: Boolean(config.apiKey), hasNetworkPassword: Boolean(config.networkPassword) };
  }

  /** Creates a named room for local organization because rooms are not modeled upstream. */
  public createRoom(name: string, defaultBrightnessPercent = 100): RoomRecord {
    const info = this.db.prepare("INSERT INTO rooms (name,sort_order,default_brightness_percent) VALUES (?,?,?)").run(name.trim(), this.listRooms().length, this.normalizePercent(defaultBrightnessPercent));
    return this.getRoom(Number(info.lastInsertRowid))!;
  }

  public listRooms(): RoomRecord[] { return this.db.prepare("SELECT id,name,sort_order AS sortOrder,default_brightness_percent AS defaultBrightnessPercent FROM rooms ORDER BY sort_order,name").all() as RoomRecord[]; }
  public getRoom(id: number): RoomRecord | null { return (this.db.prepare("SELECT id,name,sort_order AS sortOrder,default_brightness_percent AS defaultBrightnessPercent FROM rooms WHERE id = ?").get(id) as RoomRecord | undefined) ?? null; }
  public setRoomDefaultBrightness(id: number, defaultBrightnessPercent: number): RoomRecord {
    if (!this.getRoom(id)) throw new Error("Room does not exist.");
    this.db.prepare("UPDATE rooms SET default_brightness_percent = ? WHERE id = ?").run(this.normalizePercent(defaultBrightnessPercent), id);
    return this.getRoom(id)!;
  }
  public deleteRoom(id: number): void { this.db.prepare("DELETE FROM rooms WHERE id = ?").run(id); }
  public setUnitMetadata(unitId: number, customName: string | null, roomId: number | null): void {
    this.db.prepare("INSERT INTO unit_metadata (unit_id,custom_name,room_id) VALUES (?,?,?) ON CONFLICT(unit_id) DO UPDATE SET custom_name=excluded.custom_name,room_id=excluded.room_id").run(unitId, customName?.trim() || null, roomId);
  }
  public getUnitMetadata(): UnitMetadata[] { return this.db.prepare("SELECT unit_id AS unitId,custom_name AS customName,room_id AS roomId FROM unit_metadata").all() as UnitMetadata[]; }

  /** Creates a durable automation rule. Cron syntax is validated by the scheduler before this call. */
  public createSchedule(input: Omit<ScheduleRecord, "id" | "createdAt" | "updatedAt" | "lastRunKey" | "lastRunAt">): ScheduleRecord {
    const now = NOW();
    const holidayDates = input.holidayDates ?? [];
    const awayDateSetId = input.awayDateSetId ?? null;
    const info = this.db.prepare("INSERT INTO schedules (name,cron_expression,timezone,command_json,solar_json,holiday_dates_json,away_date_set_id,enabled,owner_user_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(input.name.trim(), input.cronExpression, input.timezone, JSON.stringify(input.command), input.solar ? JSON.stringify(input.solar) : null, JSON.stringify(holidayDates), awayDateSetId, input.enabled ? 1 : 0, input.ownerUserId, now, now);
    return this.getSchedule(Number(info.lastInsertRowid))!;
  }
  public listSchedules(): ScheduleRecord[] { return (this.db.prepare("SELECT * FROM schedules ORDER BY id DESC").all() as Array<Record<string, unknown>>).map(row => this.mapSchedule(row)); }
  public getSchedule(id: number): ScheduleRecord | null { const row = this.db.prepare("SELECT * FROM schedules WHERE id = ?").get(id) as Record<string, unknown> | undefined; return row ? this.mapSchedule(row) : null; }
  public updateSchedule(id: number, patch: Partial<Pick<ScheduleRecord, "name" | "cronExpression" | "timezone" | "command" | "solar" | "holidayDates" | "awayDateSetId" | "enabled">>): ScheduleRecord {
    const existing = this.getSchedule(id); if (!existing) throw new Error("Schedule does not exist.");
    const next = { ...existing, ...patch, updatedAt: NOW() };
    this.db.prepare("UPDATE schedules SET name=?,cron_expression=?,timezone=?,command_json=?,solar_json=?,holiday_dates_json=?,away_date_set_id=?,enabled=?,updated_at=? WHERE id=?")
      .run(next.name, next.cronExpression, next.timezone, JSON.stringify(next.command), next.solar ? JSON.stringify(next.solar) : null, JSON.stringify(next.holidayDates), next.awayDateSetId, next.enabled ? 1 : 0, next.updatedAt, id);
    return this.getSchedule(id)!;
  }
  public deleteSchedule(id: number): void { this.db.prepare("DELETE FROM schedules WHERE id = ?").run(id); }
  /** Lists reusable administrator-maintained away periods without exposing unrelated appliance configuration. */
  public listAwayDateSets(): AwayDateSet[] { return (this.db.prepare("SELECT id,name,dates_json AS dates,created_at AS createdAt,updated_at AS updatedAt FROM away_date_sets ORDER BY name").all() as Array<{ id: number; name: string; dates: string; createdAt: string; updatedAt: string }>).map(row => ({ ...row, dates: JSON.parse(row.dates) as string[] })); }
  public getAwayDateSet(id: number): AwayDateSet | null { const row = this.db.prepare("SELECT id,name,dates_json AS dates,created_at AS createdAt,updated_at AS updatedAt FROM away_date_sets WHERE id = ?").get(id) as { id: number; name: string; dates: string; createdAt: string; updatedAt: string } | undefined; return row ? { ...row, dates: JSON.parse(row.dates) as string[] } : null; }
  public createAwayDateSet(name: string, dates: string[]): AwayDateSet { const now = NOW(); const info = this.db.prepare("INSERT INTO away_date_sets (name,dates_json,created_at,updated_at) VALUES (?,?,?,?)").run(name.trim(), JSON.stringify(dates), now, now); return this.getAwayDateSet(Number(info.lastInsertRowid))!; }
  public updateAwayDateSet(id: number, patch: { name?: string; dates?: string[] }): AwayDateSet { const existing = this.getAwayDateSet(id); if (!existing) throw new Error("Away-date set does not exist."); const next = { ...existing, ...patch, updatedAt: NOW() }; this.db.prepare("UPDATE away_date_sets SET name=?,dates_json=?,updated_at=? WHERE id=?").run(next.name.trim(), JSON.stringify(next.dates), next.updatedAt, id); return this.getAwayDateSet(id)!; }
  public deleteAwayDateSet(id: number): void { this.db.exec("BEGIN IMMEDIATE"); try { this.db.prepare("UPDATE schedules SET away_date_set_id = NULL WHERE away_date_set_id = ?").run(id); this.db.prepare("DELETE FROM away_date_sets WHERE id = ?").run(id); this.db.exec("COMMIT"); } catch (error) { this.db.exec("ROLLBACK"); throw error; } }
  /** Physical-switch automations, matched by the switch's unit id, button, and trigger. */
  public listSwitchRules(): SwitchRuleRecord[] { return (this.db.prepare("SELECT * FROM switch_rules ORDER BY unit_id,button,id").all() as Array<Record<string, unknown>>).map(row => this.mapSwitchRule(row)); }
  public getSwitchRule(id: number): SwitchRuleRecord | null { const row = this.db.prepare("SELECT * FROM switch_rules WHERE id = ?").get(id) as Record<string, unknown> | undefined; return row ? this.mapSwitchRule(row) : null; }
  public createSwitchRule(input: Pick<SwitchRuleRecord, "name" | "unitId" | "button" | "trigger" | "command" | "enabled">): SwitchRuleRecord {
    const now = NOW();
    const info = this.db.prepare("INSERT INTO switch_rules (name,unit_id,button,trigger,command_json,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)").run(input.name.trim(), input.unitId, input.button, input.trigger, JSON.stringify(input.command), input.enabled ? 1 : 0, now, now);
    return this.getSwitchRule(Number(info.lastInsertRowid))!;
  }
  public updateSwitchRule(id: number, patch: Partial<Pick<SwitchRuleRecord, "name" | "unitId" | "button" | "trigger" | "command" | "enabled">>): SwitchRuleRecord {
    const existing = this.getSwitchRule(id); if (!existing) throw new Error("Switch rule does not exist.");
    const next = { ...existing, ...patch, updatedAt: NOW() };
    this.db.prepare("UPDATE switch_rules SET name=?,unit_id=?,button=?,trigger=?,command_json=?,enabled=?,updated_at=? WHERE id=?").run(next.name.trim(), next.unitId, next.button, next.trigger, JSON.stringify(next.command), next.enabled ? 1 : 0, next.updatedAt, id);
    return this.getSwitchRule(id)!;
  }
  public deleteSwitchRule(id: number): void { if (this.db.prepare("DELETE FROM switch_rules WHERE id = ?").run(id).changes === 0) throw new Error("Switch rule does not exist."); }
  public markSwitchRuleTriggered(id: number): void { this.db.prepare("UPDATE switch_rules SET last_triggered_at = ? WHERE id = ?").run(NOW(), id); }

  /** Acquires a minute-specific schedule execution lock, giving at-least-once triggers idempotent effect. */
  public claimScheduleRun(id: number, runKey: string): boolean {
    const result = this.db.prepare("UPDATE schedules SET last_run_key=?,last_run_at=? WHERE id=? AND (last_run_key IS NULL OR last_run_key != ?)").run(runKey, NOW(), id, runKey);
    return result.changes === 1;
  }

  /** Appends an immutable operational event. Never pass secret material here. */
  public audit(actor: string, action: string, detail: Record<string, unknown>): void {
    this.db.prepare("INSERT INTO audit_log (actor,action,detail_json,created_at) VALUES (?,?,?,?)").run(actor, action, JSON.stringify(detail), NOW());
  }
  public recentAudit(): Array<{ id: number; actor: string; action: string; detail: Record<string, unknown>; createdAt: string }> {
    return (this.db.prepare("SELECT id,actor,action,detail_json AS detail,created_at AS createdAt FROM audit_log ORDER BY id DESC LIMIT 100").all() as Array<{ id: number; actor: string; action: string; detail: string; createdAt: string }>).map(row => ({ ...row, detail: JSON.parse(row.detail) }));
  }

  private getUserById(id: number): StoredUser | null { return (this.db.prepare("SELECT id,username,role,created_at AS createdAt FROM local_users WHERE id = ?").get(id) as StoredUser | undefined) ?? null; }
  private getApiKey(id: number): ApiKeyRecord | null { return (this.db.prepare("SELECT id,label,prefix,role,created_at AS createdAt,last_used_at AS lastUsedAt,revoked_at AS revokedAt FROM api_keys WHERE id = ?").get(id) as ApiKeyRecord | undefined) ?? null; }
  private normalizePercent(value: number): number { if (!Number.isInteger(value) || value < 0 || value > 100) throw new Error("Default brightness must be an integer from 0 to 100."); return value; }
  private adminCount(): number { return (this.db.prepare("SELECT COUNT(*) AS count FROM local_users WHERE role = 'admin'").get() as { count: number }).count; }
  private mapSwitchRule(row: Record<string, unknown>): SwitchRuleRecord {
    return { id: Number(row.id), name: String(row.name), unitId: Number(row.unit_id), button: Number(row.button), trigger: String(row.trigger) as SwitchTrigger, command: JSON.parse(String(row.command_json)) as SwitchRuleCommand, enabled: Boolean(row.enabled), createdAt: String(row.created_at), updatedAt: String(row.updated_at), lastTriggeredAt: row.last_triggered_at == null ? null : String(row.last_triggered_at) };
  }
  private mapSchedule(row: Record<string, unknown>): ScheduleRecord { const awayDateSetId = row.away_date_set_id == null ? null : Number(row.away_date_set_id); return { id: Number(row.id), name: String(row.name), cronExpression: String(row.cron_expression), timezone: String(row.timezone), command: JSON.parse(String(row.command_json)) as ControlRequest, solar: row.solar_json ? JSON.parse(String(row.solar_json)) as SolarSchedule : null, holidayDates: row.holiday_dates_json ? JSON.parse(String(row.holiday_dates_json)) as string[] : [], awayDateSetId, awayDateSet: awayDateSetId ? this.getAwayDateSet(awayDateSetId) : null, enabled: Boolean(row.enabled), ownerUserId: Number(row.owner_user_id), createdAt: String(row.created_at), updatedAt: String(row.updated_at), lastRunKey: row.last_run_key ? String(row.last_run_key) : null, lastRunAt: row.last_run_at ? String(row.last_run_at) : null }; }
  private hashPassword(password: string, salt: string): string { return scryptSync(password, salt, 64).toString("hex"); }
  private digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
  private safeEqual(left: string, right: string): boolean { const a = Buffer.from(left); const b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); }
  private encrypt(plaintext: string): string { const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", this.encryptionKey, iv); const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]); return `${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${ciphertext.toString("base64url")}`; }
  private decrypt(payload: string): string { if (!payload) return ""; const [ivText, tagText, ciphertextText] = payload.split("."); if (!ivText || !tagText || !ciphertextText) throw new Error("Stored secret cannot be decrypted."); const decipher = createDecipheriv("aes-256-gcm", this.encryptionKey, Buffer.from(ivText, "base64url")); decipher.setAuthTag(Buffer.from(tagText, "base64url")); return Buffer.concat([decipher.update(Buffer.from(ciphertextText, "base64url")), decipher.final()]).toString("utf8"); }
}
