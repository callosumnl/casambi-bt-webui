import type { LocalStore } from "../store";
import { LightDescriptor, LightingSnapshot, lightState, lightUnitIds } from "../lighting/model";
import { LightRegistry, LightingSource, RegistryChange } from "../lighting/registry";
import { WriteBatcher } from "../lighting/writes";
import { DeviceFactory, DeviceState, fromMatterLevel, MatterDevice, toMatterLevel } from "./devices";
import { matterLabel } from "./identity";

type Options = { flushMs: number; removeAfterMs: number; writeTimeoutMs: number; now: () => number };
/** `lastLevel` is the Matter level shown while a light is off, so Google Home keeps its slider where it was. */
type Device = { descriptor: LightDescriptor; device: MatterDevice | null; pushed: DeviceState | null; lastLevel: number };

/** Kinds the Matter bridge shows so far: lamps, Casambi groups, and rooms. */
const SUPPORTED = new Set<LightDescriptor["kind"]>(["unit", "group", "room"]);

const unreachable = () => new Error("The Casambi network cannot be reached.");

/**
 * The Matter bridge's lights for lamps, Casambi groups, and rooms, separate from HomeKit's: their own list, hidden
 * keys, and learned buttons under "matter.*". State goes to Matter as it changes (reachable, on, level); commands from
 * Google Home go through the shared write batcher as actor "matter". Work on the endpoints runs one step at a time.
 */
export class MatterLights {
  private readonly devices = new Map<string, Device>();
  private readonly registry: LightRegistry;
  private readonly writes: WriteBatcher;
  private factory: DeviceFactory | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private syncTimer: NodeJS.Timeout | null = null;
  private readonly resyncTimer: NodeJS.Timeout;

  public constructor(private readonly store: LocalStore, private readonly source: LightingSource, private readonly options: Options = { flushMs: 75, removeAfterMs: 10 * 60_000, writeTimeoutMs: 5_000, now: Date.now }) {
    this.registry = new LightRegistry(store, { prefix: "matter", nameOf: matterLabel, removeAfterMs: options.removeAfterMs, now: options.now });
    this.writes = new WriteBatcher(store, source, {
      actor: "matter", flushMs: options.flushMs, writeTimeoutMs: options.writeTimeoutMs, failure: unreachable,
      unitIds: (key, snapshot) => { const device = this.devices.get(key); return device ? lightUnitIds(device.descriptor, snapshot) : null; },
      currentColour: () => ({ hue: 0, saturation: 0 }),
    });
    this.loadDevices();
    source.onStateChange(() => this.scheduleSync());
    this.resyncTimer = setInterval(() => this.scheduleSync(), 30_000);
    this.resyncTimer.unref();
  }

  /** Adds the devices to a newly started node's aggregator, or forgets them when the node stops. */
  public attach(factory: DeviceFactory | null): Promise<void> {
    return this.serialized(async () => {
      this.factory = null;
      for (const device of Array.from(this.devices.values())) { device.device = null; device.pushed = null; }
      await this.syncNow();
      this.factory = factory;
      if (!factory) return;
      for (const device of Array.from(this.devices.values())) await this.build(device);
      await this.syncNow();
    });
  }

  /** Reads the list again after a restore replaced the database. */
  public async reload(): Promise<void> {
    await this.attach(null);
    this.registry.reload();
    this.loadDevices();
  }

  public catalog() { return this.registry.catalog().filter(entry => SUPPORTED.has(entry.kind)); }
  public status(): { lights: number } { return { lights: Array.from(this.devices.values()).filter(device => device.device).length }; }
  public sync(): Promise<void> { return this.serialized(() => this.syncNow()); }

  public close(): void {
    this.writes.close();
    if (this.syncTimer) clearTimeout(this.syncTimer);
    clearInterval(this.resyncTimer);
  }

  private scheduleSync(): void {
    if (this.syncTimer) return;
    this.syncTimer = setTimeout(() => { this.syncTimer = null; void this.sync(); }, 100);
    this.syncTimer.unref();
  }

  private loadDevices(): void {
    this.devices.clear();
    for (const descriptor of this.registry.entries()) if (SUPPORTED.has(descriptor.kind)) this.devices.set(descriptor.key, { descriptor, device: null, pushed: null, lastLevel: 254 });
  }

  private async syncNow(): Promise<void> {
    const snapshot = this.source.cachedSnapshot();
    if (snapshot.connected && snapshot.network) await this.apply(this.registry.reconcile(snapshot));
    for (const device of Array.from(this.devices.values())) await this.push(device, snapshot);
  }

  private async apply(change: RegistryChange): Promise<void> {
    const supported = (list: LightDescriptor[]) => list.filter(descriptor => SUPPORTED.has(descriptor.kind));
    for (const descriptor of change.removed) {
      const device = this.devices.get(descriptor.key);
      this.devices.delete(descriptor.key);
      await device?.device?.remove();
    }
    for (const descriptor of supported(change.rebuilt)) {
      // A device type that changed (a lamp that started to dim) needs a new endpoint; it gets the same endpoint id.
      const device = this.devices.get(descriptor.key) ?? { descriptor, device: null, pushed: null, lastLevel: 254 };
      this.devices.set(descriptor.key, device);
      await device.device?.remove();
      device.descriptor = descriptor;
      device.device = null;
      device.pushed = null;
      await this.build(device);
    }
    for (const descriptor of supported(change.renamed)) {
      const device = this.devices.get(descriptor.key);
      if (!device) continue;
      device.descriptor = descriptor;
      await device.device?.rename(descriptor.name);
    }
    for (const descriptor of supported(change.added)) {
      const device: Device = { descriptor, device: null, pushed: null, lastLevel: 254 };
      this.devices.set(descriptor.key, device);
      await this.build(device);
    }
  }

  private async build(device: Device): Promise<void> {
    if (!this.factory) return;
    const key = device.descriptor.key;
    const state = this.state(device, this.source.cachedSnapshot());
    device.device = await this.factory.add(device.descriptor, state, {
      onOn: on => this.write(key, { on }),
      onLevel: level => this.write(key, { level: fromMatterLevel(level) }),
    });
    device.pushed = state;
  }

  /** A command from Google Home; a failure is audited by the batcher and corrected by the next state push. */
  private write(key: string, write: { on?: boolean; level?: number }): void {
    try { void this.writes.write(key, write).catch(() => this.scheduleSync()); } catch { this.scheduleSync(); }
  }

  private state(device: Device, snapshot: LightingSnapshot): DeviceState {
    const state = lightState(device.descriptor, snapshot);
    if (state.level !== null) device.lastLevel = toMatterLevel(state.level);
    return { reachable: state.available, on: state.on, level: device.descriptor.dimmable ? device.lastLevel : null };
  }

  private async push(device: Device, snapshot: LightingSnapshot): Promise<void> {
    if (!device.device) return;
    const state = this.state(device, snapshot);
    const previous = device.pushed;
    if (previous && previous.reachable === state.reachable && previous.on === state.on && previous.level === state.level) return;
    device.pushed = state;
    await device.device.push(state);
  }

  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }
}
