import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

/** What deploy/update.sh last reported (its status.json); every field may be missing before the first check. */
export type UpdateStatus = {
  state?: "checking" | "available" | "up_to_date" | "updating" | "updated" | "rolling_back" | "rolled_back" | "failed";
  message?: string | null;
  current?: string | null; currentSubject?: string | null;
  latest?: string | null; latestSubject?: string | null;
  behind?: number | null; changes?: string[];
  checkedAt?: string | null; startedAt?: string | null; finishedAt?: string | null;
  logTail?: string | null;
};
export type UpdateMode = "check" | "apply";

/**
 * The web app's side of updates. It cannot update itself (it runs unprivileged on a read-only checkout), so it
 * only drops a request file that a systemd path unit turns into a run of deploy/update.sh as root, and reads the
 * status that script writes to a directory the service can read but not write.
 */
export class Updater {
  private readonly requestDirectory: string;

  public constructor(dataDirectory: string, private readonly stateDirectory = process.env.CASAMBI_UPDATER_STATE || "/var/lib/casambi-bt-webui-updater") {
    this.requestDirectory = join(dataDirectory, "update");
  }

  /** deploy/install.sh creates the state directory together with the systemd units that act on requests. */
  public get supported(): boolean { return existsSync(this.stateDirectory); }

  public status(): UpdateStatus {
    try { return JSON.parse(readFileSync(join(this.stateDirectory, "status.json"), "utf8")) as UpdateStatus; } catch { return {}; }
  }

  /** A request waits until update.sh starts and deletes it (normally within a second). */
  public pending(mode: UpdateMode): boolean { return existsSync(join(this.requestDirectory, `${mode}-request`)); }

  public request(mode: UpdateMode): void {
    if (!this.supported) throw new Error("Updates from the app are not set up on this Pi; deploy/install.sh must run once to enable them.");
    if (mode === "apply" && ["updating", "rolling_back"].includes(this.status().state ?? "")) throw new Error("An update is already running; it must finish first.");
    mkdirSync(this.requestDirectory, { recursive: true });
    writeFileSync(join(this.requestDirectory, `${mode}-request`), new Date().toISOString());
  }
}
