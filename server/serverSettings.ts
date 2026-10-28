import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

/** The settings that live in /etc/casambi-bt-webui.env, as this process sees them; only port and proxy can change here. */
export type ServerSettings = {
  supported: boolean;
  port: number;
  trustProxy: boolean;
  pending: boolean;
  status: { state?: "applying" | "applied" | "rolled_back" | "failed"; message?: string; at?: string };
  readOnly: { nodeEnv: string | null; mockMode: boolean; databasePath: string | null; cachePath: string | null; pythonCommand: string | null; envFile: string };
};

/**
 * The service cannot write the root-owned env file. It writes a request that deploy/apply-settings.sh (started as root
 * by a systemd path unit) validates, applies, and checks by restarting; if the app does not come back on the new port,
 * the script restores the previous settings. deploy/install.sh creates the request directory with those units.
 */
export class ServerSettingsHelper {
  private readonly requestDirectory: string;

  public constructor(dataDirectory: string, private readonly stateDirectory = process.env.CASAMBI_UPDATER_STATE || "/var/lib/casambi-bt-webui-updater") {
    this.requestDirectory = join(dataDirectory, "settings");
  }

  public current(): ServerSettings {
    let status: ServerSettings["status"] = {};
    try { status = JSON.parse(readFileSync(join(this.stateDirectory, "settings-status.json"), "utf8")) as ServerSettings["status"]; } catch { status = {}; }
    return {
      supported: existsSync(this.requestDirectory),
      port: Number(process.env.PORT || 3000),
      trustProxy: process.env.CASAMBI_TRUST_PROXY === "true",
      pending: existsSync(join(this.requestDirectory, "request.json")),
      status,
      readOnly: {
        nodeEnv: process.env.NODE_ENV ?? null, mockMode: process.env.CASAMBI_MOCK_MODE === "true",
        databasePath: process.env.CASAMBI_DB_PATH ?? null, cachePath: process.env.CASAMBI_CACHE_PATH ?? null,
        pythonCommand: process.env.CASAMBI_PYTHON_COMMAND ?? null, envFile: "/etc/casambi-bt-webui.env",
      },
    };
  }

  public request(settings: { port: number; trustProxy: boolean }): void {
    if (!existsSync(this.requestDirectory)) throw new Error("Changing server settings from the app is not set up on this Pi; deploy/install.sh must run once to enable it.");
    if (existsSync(join(this.requestDirectory, "request.json"))) throw new Error("A settings change is already being applied; it must finish first.");
    writeFileSync(join(this.requestDirectory, "request.json"), JSON.stringify({ port: settings.port, trustProxy: settings.trustProxy }));
  }
}
