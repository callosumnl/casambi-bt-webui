import * as hap from "hap-nodejs";
import { mkdirSync } from "fs";
import net from "net";
import type { LocalStore } from "../store";
import { generatePincode, generateSetupId, generateUsername, isValidPincode, isValidSetupId, isValidUsername, sanitizeName } from "./identity";

export const DEFAULT_HOMEKIT_NAME = "Casambi-bt-webui";
/** Homebridge uses 51826; a different default lets both run on one Pi. */
export const DEFAULT_HOMEKIT_PORT = 51827;

export type HomeKitSettings = { enabled: boolean; name: string; port: number };
export type HomeKitState = "disabled" | "starting" | "published" | "failed";
/** What the Admin panel shows. `pincode` and `setupUri` let an administrator pair; they are never written to the audit log. */
export type HomeKitStatus = HomeKitSettings & {
  state: HomeKitState; error: string | null; advertised: boolean; advertiser: string;
  pincode: string; setupUri: string | null; pairings: number;
};

type Identity = { username: string; pincode: string; setupId: string };
type PublishInfo = Identity & { name: string; port: number; advertiser: string };

/** One published HAP bridge, as far as this module uses it; tests replace it. */
export interface HapHost {
  publish(info: PublishInfo): Promise<void>;
  unpublish(): Promise<void>;
  /** Unpublishes and deletes the bridge's keys and pairings from disk. */
  destroy(): Promise<void>;
  setupUri(): string | null;
  pairings(): number;
  on(event: "paired" | "unpaired" | "advertised", listener: () => void): void;
}

/** Creates HAP bridges and answers questions about HAP's own storage; tests replace it. */
export interface HapRuntime {
  create(name: string, username: string): HapHost;
  /** Whether HAP still has the keys for `username`; without them, controllers that paired with it cannot connect. */
  hasStoredIdentity(username: string): boolean;
  forgetIdentity(username: string): void;
  portAvailable(port: number): Promise<boolean>;
}

/**
 * Avahi already runs on the Pi (deploy/install.sh sets it up for the web app), and a second mDNS responder next to it
 * is a known source of trouble, so Linux uses avahi over D-Bus. HAP-NodeJS falls back to bonjour-hap by itself when
 * avahi is not reachable. Elsewhere (development on a Mac) ciao is HAP-NodeJS's recommended advertiser.
 * CASAMBI_HOMEKIT_ADVERTISER overrides the choice (ciao, avahi, resolved, bonjour-hap).
 */
export function defaultAdvertiser(platform = process.platform, override = process.env.CASAMBI_HOMEKIT_ADVERTISER): string {
  if (override && ["ciao", "avahi", "resolved", "bonjour-hap"].includes(override)) return override;
  return platform === "linux" ? hap.MDNSAdvertiser.AVAHI : hap.MDNSAdvertiser.CIAO;
}

/** HAP-NodeJS keeps its keys and pairings in one process-wide folder, which can only be set before first use. */
export function hapRuntime(storagePath: string): HapRuntime {
  mkdirSync(storagePath, { recursive: true, mode: 0o700 });
  hap.HAPStorage.setCustomStoragePath(storagePath);
  return {
    create(name, username) {
      const bridge = new hap.Bridge(name, hap.uuid.generate(`casambi-bt-webui:bridge:${username}`));
      bridge.getService(hap.Service.AccessoryInformation)!
        .setCharacteristic(hap.Characteristic.Manufacturer, "Casambi BT WebGUI")
        .setCharacteristic(hap.Characteristic.Model, "Casambi Bluetooth bridge")
        .setCharacteristic(hap.Characteristic.SerialNumber, username);
      return {
        publish: info => bridge.publish({
          username: info.username, pincode: info.pincode, setupID: info.setupId, port: info.port,
          category: hap.Categories.BRIDGE, advertiser: info.advertiser as hap.MDNSAdvertiser,
        }),
        unpublish: () => bridge.unpublish(),
        destroy: () => bridge.destroy(),
        setupUri: () => (bridge._accessoryInfo ? bridge.setupURI() : null),
        pairings: () => Object.keys(bridge._accessoryInfo?.pairedClients ?? {}).length,
        on: (event, listener) => {
          if (event === "paired") bridge.on(hap.AccessoryEventTypes.PAIRED, listener);
          else if (event === "unpaired") bridge.on(hap.AccessoryEventTypes.UNPAIRED, listener);
          else bridge.on(hap.AccessoryEventTypes.ADVERTISED, listener);
        },
      };
    },
    hasStoredIdentity: username => hap.AccessoryInfo.load(username) !== null,
    forgetIdentity: username => hap.Accessory.cleanupAccessoryData(username),
    portAvailable: port => new Promise(resolve => {
      const probe = net.createServer();
      probe.once("error", () => resolve(false));
      probe.listen(port, () => probe.close(() => resolve(true)));
    }),
  };
}

/**
 * Publishes this Pi as a HomeKit bridge, the way Homebridge does. Settings and the pairing identity (device id, setup
 * code, setup id) live in the settings table; HAP's own keys and pairings live in its storage folder.
 * Start, stop, settings changes, and resets run one at a time.
 */
export class HomeKitBridge {
  private host: HapHost | null = null;
  private state: HomeKitState = "disabled";
  private error: string | null = null;
  private advertised = false;
  private queue: Promise<unknown> = Promise.resolve();

  public constructor(
    private readonly store: LocalStore,
    private readonly runtime: HapRuntime,
    private readonly options: { appPort: () => number; advertiser: string } = { appPort: () => Number(process.env.PORT || 3000), advertiser: defaultAdvertiser() },
  ) {}

  public settings(): HomeKitSettings {
    const port = Number(this.store.appSetting("homekit.port"));
    return {
      enabled: this.store.appSetting("homekit.enabled") === "true",
      name: this.store.appSetting("homekit.name") || DEFAULT_HOMEKIT_NAME,
      port: Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : DEFAULT_HOMEKIT_PORT,
    };
  }

  public status(): HomeKitStatus {
    const identity = this.identity();
    return {
      ...this.settings(), state: this.state, error: this.error, advertised: this.advertised, advertiser: this.options.advertiser,
      pincode: identity.pincode, setupUri: this.state === "published" ? this.host?.setupUri() ?? null : null, pairings: this.host?.pairings() ?? 0,
    };
  }

  /** Publishes the bridge when HomeKit is turned on. A failure is reported in the status; it never stops the app. */
  public start(): Promise<void> { return this.serialized(() => this.publishIfEnabled()); }

  /** Unpublishes, so controllers see the bridge go away instead of timing out. */
  public stop(): Promise<void> { return this.serialized(() => this.unpublish()); }

  /** Saves the settings and republishes with them. */
  public async update(input: HomeKitSettings, actor: string): Promise<HomeKitStatus> {
    if (input.port === this.options.appPort()) throw new Error("The HomeKit port must differ from the web app's port.");
    const settings = { ...input, name: sanitizeName(input.name, DEFAULT_HOMEKIT_NAME) };
    this.store.setAppSetting("homekit.enabled", String(settings.enabled));
    this.store.setAppSetting("homekit.name", settings.name);
    this.store.setAppSetting("homekit.port", String(settings.port));
    this.store.audit(actor, "homekit.settings_changed", settings);
    await this.serialized(async () => { await this.unpublish(); await this.publishIfEnabled(); });
    return this.status();
  }

  /** Forgets every pairing and starts over with a new device id and setup code; Apple Home then sees a new bridge. */
  public async resetPairing(actor: string): Promise<HomeKitStatus> {
    await this.serialized(async () => {
      const { username } = this.identity();
      if (this.host) await this.host.destroy();
      else this.runtime.forgetIdentity(username);
      this.host = null;
      this.state = "disabled";
      this.advertised = false;
      this.saveIdentity({ username: generateUsername(), pincode: generatePincode(), setupId: generateSetupId() });
      this.store.audit(actor, "homekit.pairing_reset", {});
      await this.publishIfEnabled();
    });
    return this.status();
  }

  private async publishIfEnabled(): Promise<void> {
    const settings = this.settings();
    if (!settings.enabled) { this.state = "disabled"; this.error = null; return; }
    let identity = this.identity();
    // A device id without HAP's keys (a restore on another Pi, a deleted folder) cannot serve its old pairings, and
    // controllers that remember it would fail to connect; a new id makes it a clean new bridge in Apple Home.
    if (!this.runtime.hasStoredIdentity(identity.username)) {
      identity = { ...identity, username: generateUsername() };
      this.saveIdentity(identity);
    }
    this.state = "starting";
    this.error = null;
    this.advertised = false;
    // HAP-NodeJS has no error handler on its listening socket: a busy port would crash the whole service.
    if (!(await this.runtime.portAvailable(settings.port))) { this.fail(`Port ${settings.port} is already in use.`); return; }
    const host = this.runtime.create(settings.name, identity.username);
    host.on("paired", () => this.store.audit("homekit", "homekit.paired", { pairings: host.pairings() }));
    host.on("unpaired", () => this.store.audit("homekit", "homekit.unpaired", { pairings: host.pairings() }));
    host.on("advertised", () => { if (this.host === host) this.advertised = true; });
    // Current before publishing, so an announcement that completes during publish() is not dropped.
    this.host = host;
    try {
      await host.publish({ ...identity, name: settings.name, port: settings.port, advertiser: this.options.advertiser });
      this.state = "published";
    } catch (error) {
      this.host = null;
      await host.unpublish().catch(() => undefined);
      this.fail(error instanceof Error ? error.message : "Publishing the HomeKit bridge failed.");
    }
  }

  private async unpublish(): Promise<void> {
    const host = this.host;
    this.host = null;
    this.advertised = false;
    if (host) await host.unpublish();
    if (this.state !== "failed") this.state = "disabled";
  }

  private fail(message: string): void {
    this.state = "failed";
    this.error = message;
    this.store.audit("homekit", "homekit.publish_failed", { message });
  }

  /** The stored identity, creating whatever is missing or malformed. */
  private identity(): Identity {
    const stored = { username: this.store.appSetting("homekit.username") ?? "", pincode: this.store.appSetting("homekit.pincode") ?? "", setupId: this.store.appSetting("homekit.setupId") ?? "" };
    const identity = {
      username: isValidUsername(stored.username) ? stored.username : generateUsername(),
      pincode: isValidPincode(stored.pincode) ? stored.pincode : generatePincode(),
      setupId: isValidSetupId(stored.setupId) ? stored.setupId : generateSetupId(),
    };
    if (identity.username !== stored.username || identity.pincode !== stored.pincode || identity.setupId !== stored.setupId) this.saveIdentity(identity);
    return identity;
  }

  private saveIdentity(identity: Identity): void {
    this.store.setAppSetting("homekit.username", identity.username);
    this.store.setAppSetting("homekit.pincode", identity.pincode);
    this.store.setAppSetting("homekit.setupId", identity.setupId);
  }

  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }
}
