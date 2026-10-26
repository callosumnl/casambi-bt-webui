import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { rmSync, writeFileSync } from "fs";
import { join } from "path";

/**
 * One-time code that creating the first admin requires, so nobody else on the network can claim a fresh install
 * before its owner does. It is written to `setup-code` next to the database (readable only by the service account;
 * deploy/install.sh prints it) and deleted once the admin exists.
 */
export class SetupCode {
  private readonly value = randomBytes(6).toString("hex").toUpperCase().replace(/(.{4})(?!$)/g, "$1-");
  public readonly path: string;

  public constructor(dataDirectory: string, needed: boolean) {
    this.path = join(dataDirectory, "setup-code");
    if (needed) writeFileSync(this.path, `${this.value}\n`, { mode: 0o600 });
    else this.consume();
  }

  /** Compares in constant time; dashes, spaces, and letter case do not matter. */
  public matches(given: string): boolean {
    const digest = (text: string) => createHash("sha256").update(text.replace(/[\s-]/g, "").toUpperCase()).digest();
    return timingSafeEqual(digest(given), digest(this.value));
  }

  public consume(): void { rmSync(this.path, { force: true }); }

  /** For development logs only; production logs never contain the code. */
  public reveal(): string { return this.value; }
}
