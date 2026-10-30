import type { LocalStore } from "../store";
import { fabricOwner, generateDiscriminator, generateNodeId, generatePasscode, isValidDiscriminator, isValidNodeId, isValidPasscode, matterLabel } from "./identity";
import { endpointFactory } from "./devices";
import type { MatterLights } from "./lights";
import { startError, type MatterHost, type MatterRuntime } from "./runtime";

export const DEFAULT_MATTER_NAME = "Casambi-bt-webui";
export const DEFAULT_MATTER_PORT = 5540;
/** The CSA test vendor id and a test product id; they must match the Google Home Developer Console integration. */
export const DEFAULT_VENDOR_ID = 0xfff1;
export const DEFAULT_PRODUCT_ID = 0x8000;
/** How long a pairing window for another ecosystem stays open (Matter's default for a commissioned node). */
const PAIRING_WINDOW_MS = 15 * 60_000;

export type MatterSettings = { enabled: boolean; name: string; port: number; vendorId: number; productId: number };
export type MatterState = "disabled" | "starting" | "running" | "failed";
/** What the Admin panel shows. The pairing codes are there only while a controller can use them; never audited. */
export type MatterStatus = MatterSettings & {
  state: MatterState; error: string | null; commissioned: boolean;
  fabrics: Array<{ index: number; owner: string }>;
  pairingWindowUntil: string | null;
  manualPairingCode: string | null; qrPairingCode: string | null;
  /** Lamps, groups, and rooms the bridge shows. */
  lights: number;
};

type Identity = { nodeId: string; passcode: number; discriminator: number };

/**
 * Publishes this Pi as a Matter bridge for Google Home (and any other Matter controller), separate from HomeKit:
 * its own settings ("matter.*"), identity, and storage. Start, stop, settings changes, pairing windows, removals, and
 * resets run one at a time; a failure is reported in the status and never stops the app.
 */
export class MatterBridge {
  private host: MatterHost | null = null;
  private state: MatterState = "disabled";
  private error: string | null = null;
  private pairingWindowUntil: number | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  public constructor(
    private readonly store: LocalStore,
    private readonly runtime: MatterRuntime,
    private readonly now: () => number = Date.now,
    /** The lamp, group, and room devices; without it the bridge shows none. */
    private readonly lights: MatterLights | null = null,
  ) {}

  public settings(): MatterSettings {
    const number = (key: string, fallback: number, min: number, max: number) => { const value = Number(this.store.appSetting(key)); return Number.isInteger(value) && value >= min && value <= max ? value : fallback; };
    return {
      enabled: this.store.appSetting("matter.enabled") === "true",
      name: this.store.appSetting("matter.name") || DEFAULT_MATTER_NAME,
      port: number("matter.port", DEFAULT_MATTER_PORT, 1024, 65535),
      vendorId: number("matter.vendorId", DEFAULT_VENDOR_ID, 1, 0xfffe),
      productId: number("matter.productId", DEFAULT_PRODUCT_ID, 1, 0xffff),
    };
  }

  public status(): MatterStatus {
    const host = this.state === "running" ? this.host : null;
    const commissioned = host?.commissioned() ?? false;
    const windowOpen = this.pairingWindowUntil !== null && this.pairingWindowUntil > this.now();
    // A new bridge can be paired until it is; a paired one only while an administrator opened a window.
    const codes = host && (!commissioned || windowOpen) ? host.pairingCodes() : null;
    return {
      ...this.settings(), state: this.state, error: this.error, commissioned,
      fabrics: host?.fabrics().map(fabric => ({ index: fabric.index, owner: fabricOwner(fabric.vendorId, fabric.label) })) ?? [],
      pairingWindowUntil: commissioned && windowOpen ? new Date(this.pairingWindowUntil!).toISOString() : null,
      manualPairingCode: codes?.manualPairingCode ?? null, qrPairingCode: codes?.qrPairingCode ?? null,
      lights: host ? this.lights?.status().lights ?? 0 : 0,
    };
  }

  /** Starts the bridge when it is turned on. A failure is reported in the status; it never stops the app. */
  public start(): Promise<void> { return this.serialized(() => this.startIfEnabled()); }

  /** Stops the bridge, so controllers see it go offline cleanly. */
  public stop(): Promise<void> { return this.serialized(() => this.close()); }

  public async update(input: MatterSettings, actor: string): Promise<MatterStatus> {
    const settings = { ...input, name: matterLabel(input.name, DEFAULT_MATTER_NAME) };
    for (const [key, value] of Object.entries(settings)) this.store.setAppSetting(`matter.${key}`, String(value));
    this.store.audit(actor, "matter.settings_changed", settings);
    await this.serialized(async () => { await this.close(); await this.startIfEnabled(); });
    return this.status();
  }

  /** Lets another ecosystem add the bridge for 15 minutes, with the same setup code. */
  public async openPairingWindow(actor: string): Promise<MatterStatus> {
    await this.serialized(async () => {
      const host = this.running();
      if (!host.commissioned()) throw new Error("The bridge is not paired yet: add it with the setup code first.");
      await host.openPairingWindow();
      this.pairingWindowUntil = this.now() + PAIRING_WINDOW_MS;
      this.store.audit(actor, "matter.pairing_window_opened", {});
    });
    return this.status();
  }

  /** Removes one ecosystem's access; its devices disappear from that app. */
  public async removeFabric(index: number, actor: string): Promise<MatterStatus> {
    await this.serialized(async () => {
      const host = this.running();
      const fabric = host.fabrics().find(item => item.index === index);
      if (!fabric) throw new Error("That connection does not exist.");
      await host.removeFabric(index);
      this.store.audit(actor, "matter.fabric_removed", { owner: fabricOwner(fabric.vendorId, fabric.label) });
    });
    return this.status();
  }

  /** Removes every ecosystem and all Matter keys; the bridge can be added again with the same setup code. */
  public async reset(actor: string): Promise<MatterStatus> {
    await this.serialized(async () => {
      await this.running().reset();
      this.pairingWindowUntil = null;
      this.store.audit(actor, "matter.reset", {});
    });
    return this.status();
  }

  private running(): MatterHost {
    if (this.state !== "running" || !this.host) throw new Error("The Matter bridge must be turned on first.");
    return this.host;
  }

  private async startIfEnabled(): Promise<void> {
    const settings = this.settings();
    if (!settings.enabled) { this.state = "disabled"; this.error = null; return; }
    this.state = "starting";
    this.error = null;
    if (!(await this.runtime.portAvailable(settings.port))) { this.fail(`UDP port ${settings.port} is already in use.`); return; }
    try {
      const identity = this.identity();
      const host = await this.runtime.create({ id: identity.nodeId, name: settings.name, port: settings.port, vendorId: settings.vendorId, productId: settings.productId, passcode: identity.passcode, discriminator: identity.discriminator });
      host.onFabricsChanged((index, action) => {
        if (action === "updated") return;
        const fabric = host.fabrics().find(item => item.index === index);
        this.store.audit("matter", action === "added" ? "matter.fabric_added" : "matter.fabric_left", { owner: fabric ? fabricOwner(fabric.vendorId, fabric.label) : null, fabrics: host.fabrics().length });
        if (action === "added") this.pairingWindowUntil = null;
      });
      this.host = host;
      // The devices are added before the node starts, so a controller sees them in its first read.
      await this.lights?.attach(endpointFactory(host.aggregator()));
      await host.start();
      this.state = "running";
    } catch (error) {
      await this.lights?.attach(null);
      await this.host?.close().catch(() => undefined);
      this.host = null;
      this.fail(startError(error));
    }
  }

  private async close(): Promise<void> {
    const host = this.host;
    this.host = null;
    this.pairingWindowUntil = null;
    await this.lights?.attach(null);
    if (host) await host.close();
    if (this.state !== "failed") this.state = "disabled";
  }

  private fail(message: string): void {
    this.state = "failed";
    this.error = message;
    this.store.audit("matter", "matter.start_failed", { message });
  }

  /** The stored identity, creating whatever is missing or malformed. */
  private identity(): Identity {
    const stored = { nodeId: this.store.appSetting("matter.nodeId") ?? "", passcode: Number(this.store.appSetting("matter.passcode")), discriminator: Number(this.store.appSetting("matter.discriminator")) };
    const identity = {
      nodeId: isValidNodeId(stored.nodeId) ? stored.nodeId : generateNodeId(),
      passcode: isValidPasscode(stored.passcode) ? stored.passcode : generatePasscode(),
      // The setting is "" until one was made; Number("") is 0, a valid discriminator, so check the raw value.
      discriminator: this.store.appSetting("matter.discriminator") && isValidDiscriminator(stored.discriminator) ? stored.discriminator : generateDiscriminator(),
    };
    this.store.setAppSetting("matter.nodeId", identity.nodeId);
    this.store.setAppSetting("matter.passcode", String(identity.passcode));
    this.store.setAppSetting("matter.discriminator", String(identity.discriminator));
    return identity;
  }

  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }
}
