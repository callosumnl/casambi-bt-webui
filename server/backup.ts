import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCallback, type ScryptOptions } from "crypto";

export const BACKUP_FORMAT = "casambi-bt-webgui-backup";
const KDF = { N: 2 ** 15, r: 8, p: 1 };

export type BackupSecrets = { networkPassword: string | null; apiKey: string | null };
export type BackupContents = { database: Buffer; secrets: BackupSecrets; createdAt: string; appVersion: string | null };
type Header = { format: typeof BACKUP_FORMAT; version: 1; createdAt: string; appVersion: string | null; kdf: { name: "scrypt"; N: number; r: number; p: number; salt: string }; cipher: { name: "aes-256-gcm"; iv: string } };

const scrypt = (password: string, salt: Buffer, options: ScryptOptions) => new Promise<Buffer>((resolve, reject) => scryptCallback(password, salt, 32, options, (error, key) => error ? reject(error) : resolve(key)));

/**
 * A backup is one JSON file: a readable header, and the database with the Casambi secrets encrypted with a
 * passphrase the admin chooses. The passphrase, not this Pi's encryption key, protects it, so it can be restored
 * on another Pi; scrypt makes guessing the passphrase slow, and the header is authenticated along with the data.
 */
export async function sealBackup(contents: Omit<BackupContents, "createdAt">, passphrase: string): Promise<Buffer> {
  const salt = randomBytes(16); const iv = randomBytes(12);
  const header: Header = { format: BACKUP_FORMAT, version: 1, createdAt: new Date().toISOString(), appVersion: contents.appVersion, kdf: { name: "scrypt", ...KDF, salt: salt.toString("base64") }, cipher: { name: "aes-256-gcm", iv: iv.toString("base64") } };
  const key = await scrypt(passphrase, salt, { ...KDF, maxmem: 128 * KDF.N * KDF.r * 2 });
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(JSON.stringify(header)));
  const plaintext = Buffer.from(JSON.stringify({ database: contents.database.toString("base64"), secrets: contents.secrets }));
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.from(JSON.stringify({ header, tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") }));
}

/** Opens a backup made by sealBackup; a wrong passphrase and a damaged file both fail the authentication check. */
export async function openBackup(file: Buffer, passphrase: string): Promise<BackupContents> {
  let parsed: { header?: Header; tag?: string; data?: string };
  try { parsed = JSON.parse(file.toString("utf8")) as typeof parsed; } catch { throw new Error("The file is invalid: it is not a Casambi BT WebGUI backup."); }
  const { header, tag, data } = parsed;
  if (header?.format !== BACKUP_FORMAT || header.version !== 1 || header.kdf?.name !== "scrypt" || header.cipher?.name !== "aes-256-gcm" || !tag || !data) throw new Error("The file is invalid: it is not a Casambi BT WebGUI backup.");
  // Bounded so a crafted header cannot make the Pi spend minutes or gigabytes on the key derivation.
  if (header.kdf.N > 2 ** 17 || header.kdf.r > 16 || header.kdf.p > 4) throw new Error("This backup's key settings are invalid.");
  const key = await scrypt(passphrase, Buffer.from(header.kdf.salt, "base64"), { N: header.kdf.N, r: header.kdf.r, p: header.kdf.p, maxmem: 128 * header.kdf.N * header.kdf.r * 2 });
  let plaintext: Buffer;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(header.cipher.iv, "base64"));
    decipher.setAAD(Buffer.from(JSON.stringify(header)));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    plaintext = Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]);
  } catch { throw new Error("The backup passphrase is invalid, or the file is damaged."); }
  const contents = JSON.parse(plaintext.toString("utf8")) as { database: string; secrets: BackupSecrets };
  return { database: Buffer.from(contents.database, "base64"), secrets: contents.secrets, createdAt: header.createdAt, appVersion: header.appVersion };
}
