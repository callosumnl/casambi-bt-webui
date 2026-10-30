import type { LocalStore } from "../store";
import { rgbToHueSaturation, xyToRgb } from "../lighting/colour";
import { LightDescriptor, LightingSnapshot, lightState, lightUnitIds, LightWrite } from "../lighting/model";
import { LightRegistry, LightingSource, RegistryChange } from "../lighting/registry";
import { WriteBatcher } from "../lighting/writes";
import { DeviceFactory, DeviceState, fromMatterLevel, MatterDevice, toMatterLevel } from "./devices";
import { matterLabel } from "./identity";

type Options = { flushMs: number; removeAfterMs: number; writeTimeoutMs: number; now: () => number };
/**
 * `lastLevel` is the Matter level shown while a light is off, so Google Home keeps its slider where it was; `colour`
 * the last hue (0–360) and saturation (0–100), for a command that changes only one of them.
 */
type Device = { descriptor: LightDescriptor; device: MatterDevice | null; pushed: DeviceState | null; lastLevel: number; colour: { hue: number; saturation: number } };
const newDevice = (descriptor: LightDescriptor): Device => ({ descriptor, device: null, pushed: null, lastLevel: 254, colour: { hue: 0, saturation: 0 } });
/** Matter hue and saturation are 0–254; the shared model uses degrees and percent. */
const toMatter = { hue: (degrees: number) => Math.round((degrees / 360) * 254), saturation: (percent: number) => Math.round((percent / 100) * 254) };
const fromMatter = { hue: (value: number) => (value / 254) * 360, saturation: (value: number) => (value / 254) * 100 };

/** Kinds the Matter bridge shows so far: lamps, Casambi groups, and rooms, with on/off, level, and colour. */
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
      currentColour: key => this.devices.get(key)?.colour ?? { hue: 0, saturation: 0 },
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
    for (const descriptor of this.registry.entries()) if (SUPPORTED.has(descriptor.kind)) this.devices.set(descriptor.key, newDevice(descriptor));
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
      const device = this.devices.get(descriptor.key) ?? newDevice(descriptor);
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
      const device = newDevice(descriptor);
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
      onMired: mired => this.write(key, { mired }),
      onHueSaturation: colour => this.write(key, { ...(colour.hue !== undefined ? { hue: fromMatter.hue(colour.hue) } : {}), ...(colour.saturation !== undefined ? { saturation: fromMatter.saturation(colour.saturation) } : {}) }),
      onXy: (x, y) => this.write(key, rgbToHueSaturation(xyToRgb([x, y]))),
    });
    device.pushed = state;
  }

  /** A command from Google Home; a failure is audited by the batcher and corrected by the next state push. */
  private write(key: string, write: LightWrite): void {
    try { void this.writes.write(key, write).catch(() => this.scheduleSync()); } catch { this.scheduleSync(); }
  }

  private state(device: Device, snapshot: LightingSnapshot): DeviceState {
    const { descriptor } = device;
    const state = lightState(descriptor, snapshot);
    if (state.level !== null) device.lastLevel = toMatterLevel(state.level);
    if (state.hue !== null && state.saturation !== null) device.colour = { hue: state.hue, saturation: state.saturation };
    const range = descriptor.temperature;
    const leveled = descriptor.dimmable || descriptor.color || Boolean(range);
    return {
      reachable: state.available, on: state.on, level: leveled ? device.lastLevel : null,
      mired: state.mired !== null && range ? Math.max(range.minMired, Math.min(range.maxMired, state.mired)) : null,
      hue: descriptor.color && state.hue !== null ? toMatter.hue(state.hue) : null,
      saturation: descriptor.color && state.saturation !== null ? toMatter.saturation(state.saturation) : null,
      colorMode: descriptor.color || range ? state.colorMode : null,
    };
  }

  private async push(device: Device, snapshot: LightingSnapshot): Promise<void> {
    if (!device.device) return;
    const state = this.state(device, snapshot);
    const previous = device.pushed;
    if (previous && JSON.stringify(previous) === JSON.stringify(state)) return;
    device.pushed = state;
    await device.device.push(state);
  }

  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }
}
