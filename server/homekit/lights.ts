import * as hap from "hap-nodejs";
import type { ControlRequest } from "../casambi/types";
import type { LocalStore } from "../store";
import { describeLights, LightDescriptor, LightingSnapshot, lightState, LightState, lightUnitIds, LightWrite, planWrites } from "./mapping";

/** Where HomeKit lights read state and send commands; CasambiService in the app. */
export interface LightingSource {
  cachedSnapshot(): LightingSnapshot;
  control(command: ControlRequest, actor: string): Promise<unknown>;
  onStateChange(listener: () => void): void;
}

/** Adds and removes bridged accessories on the published bridge. */
export interface AccessoryHost {
  addAccessories(accessories: hap.Accessory[]): void;
  removeAccessories(accessories: hap.Accessory[]): void;
}

/** HomeKit allows 150 accessories per bridge, the bridge itself included. */
export const MAX_LIGHTS = 149;
const CACHE_KEY = "homekit.lights";
const KIND_MODEL = { unit: "Casambi lamp", group: "Casambi group", room: "Room" } as const;

type Options = {
  /** How long writes are collected before they are sent, so On + Brightness and a whole Home room become one batch. */
  flushMs: number;
  /** How long a lamp or group may be missing from a connected network before its HomeKit light is removed. */
  removeAfterMs: number;
  /** How long a write may take before HomeKit is told it succeeded anyway; the command keeps running. */
  writeTimeoutMs: number;
  now: () => number;
};
/** `last` holds the values HomeKit shows while a light is off or a value is unknown, so its controls do not jump. */
type Light = { descriptor: LightDescriptor; missingSince: number | null; accessory: hap.Accessory | null; pushed: LightState | null; last: { brightness: number; mired: number; hue: number; saturation: number } };
const newLight = (descriptor: LightDescriptor): Light => ({
  descriptor, missingSince: null, accessory: null, pushed: null,
  last: { brightness: 100, mired: descriptor.temperature ? Math.round((descriptor.temperature.minMired + descriptor.temperature.maxMired) / 2) : 300, hue: 0, saturation: 0 },
});

const communicationFailure = () => new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);

/**
 * The HomeKit lights for lamps, Casambi groups, and rooms. Reads answer from the cached snapshot and never wait for
 * Bluetooth; writes are collected for a moment and sent as planned Casambi commands. The list of lights is kept in
 * the settings table, so after a restart, or while the network is disconnected, Apple Home still finds every light
 * (showing "No Response") instead of deleting it together with its room and automations.
 */
export class HomeKitLights {
  private readonly lights = new Map<string, Light>();
  private host: AccessoryHost | null = null;
  private skipped = 0;
  private pending = new Map<string, LightWrite>();
  private waiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private syncTimer: NodeJS.Timeout | null = null;
  private readonly resyncTimer: NodeJS.Timeout;
  private sending: Promise<void> = Promise.resolve();

  public constructor(private readonly store: LocalStore, private readonly source: LightingSource, private readonly options: Options = { flushMs: 75, removeAfterMs: 10 * 60_000, writeTimeoutMs: 5_000, now: Date.now }) {
    for (const descriptor of this.loadCache()) this.lights.set(descriptor.key, newLight(descriptor));
    source.onStateChange(() => this.scheduleSync());
    // Room and name changes in the Admin panel do not reach the live state; pick them up within half a minute.
    this.resyncTimer = setInterval(() => this.scheduleSync(), 30_000);
    this.resyncTimer.unref();
  }

  /** Builds fresh accessories for a newly created bridge (HAP cannot move an accessory to another bridge), or drops them. */
  public attach(host: AccessoryHost | null): void {
    this.host = null;
    this.skipped = 0;
    for (const light of Array.from(this.lights.values())) { light.accessory = null; light.pushed = null; }
    // Bring the list up to date first, without a host, so every light is built exactly once below.
    this.sync();
    this.host = host;
    if (!host) return;
    const accessories = Array.from(this.lights.values()).flatMap(light => this.build(light));
    if (accessories.length) host.addAccessories(accessories);
    this.sync();
  }

  /** How many lights HomeKit shows, and how many did not fit on the bridge. */
  public status(): { lights: number; notShown: number } {
    return { lights: Array.from(this.lights.values()).filter(light => light.accessory).length, notShown: this.skipped };
  }

  /** Brings the lights in line with the network (new, renamed, and removed lamps, groups, rooms) and pushes their state. */
  public sync(): void {
    const snapshot = this.source.cachedSnapshot();
    if (snapshot.connected && snapshot.network) this.reconcile(snapshot);
    for (const light of Array.from(this.lights.values())) this.push(light, snapshot);
  }

  /** Stops the timers; for tests and shutdown. */
  public close(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.syncTimer) clearTimeout(this.syncTimer);
    clearInterval(this.resyncTimer);
  }

  private scheduleSync(): void {
    if (this.syncTimer) return;
    this.syncTimer = setTimeout(() => { this.syncTimer = null; this.sync(); }, 100);
    this.syncTimer.unref();
  }

  private reconcile(snapshot: LightingSnapshot): void {
    const now = this.options.now();
    const fresh = new Map(describeLights(snapshot).map(descriptor => [descriptor.key, descriptor]));
    const roomIds = new Set(snapshot.rooms.map(room => room.id));
    let changed = false;
    const added: hap.Accessory[] = [];
    const removed: hap.Accessory[] = [];
    for (const descriptor of Array.from(fresh.values())) {
      const light = this.lights.get(descriptor.key);
      if (!light) {
        const created = newLight(descriptor);
        this.lights.set(descriptor.key, created);
        if (this.host) added.push(...this.build(created));
        changed = true;
        continue;
      }
      light.missingSince = null;
      const features = (item: LightDescriptor) => JSON.stringify([item.id, item.dimmable, item.temperature, item.color]);
      if (features(light.descriptor) !== features(descriptor)) {
        // A characteristic set that changed needs a new accessory; HomeKit keeps it in place because its id stays.
        if (light.accessory) removed.push(light.accessory);
        light.descriptor = descriptor;
        light.accessory = null;
        light.pushed = null;
        if (this.host) added.push(...this.build(light));
        changed = true;
      } else if (light.descriptor.name !== descriptor.name) {
        light.descriptor = descriptor;
        light.accessory?.getService(hap.Service.Lightbulb)?.updateCharacteristic(hap.Characteristic.ConfiguredName, descriptor.name);
        changed = true;
      }
    }
    for (const [key, light] of Array.from(this.lights.entries())) {
      if (fresh.has(key)) continue;
      // A deleted room, or one left out as a duplicate (its lamps are known), is gone for sure; a lamp or group may
      // only be missing from one incomplete snapshot.
      const gone = light.descriptor.kind === "room" && (!roomIds.has(light.descriptor.id) || lightUnitIds(light.descriptor, snapshot).length > 0);
      light.missingSince ??= now;
      if (!gone && now - light.missingSince < this.options.removeAfterMs) continue;
      if (light.accessory) removed.push(light.accessory);
      this.lights.delete(key);
      changed = true;
    }
    if (this.host && removed.length) this.host.removeAccessories(removed);
    if (this.host && added.length) this.host.addAccessories(added);
    if (changed) this.saveCache();
  }

  /** Creates the accessory for a light, unless the bridge is full. */
  private build(light: Light): hap.Accessory[] {
    if (Array.from(this.lights.values()).filter(other => other.accessory).length >= MAX_LIGHTS) { this.skipped += 1; return []; }
    const { key, name, kind, dimmable, temperature, color } = light.descriptor;
    const accessory = new hap.Accessory(name, hap.uuid.generate(`casambi-bt-webui:${key}`));
    accessory.category = hap.Categories.LIGHTBULB;
    accessory.getService(hap.Service.AccessoryInformation)!
      .setCharacteristic(hap.Characteristic.Manufacturer, "Casambi BT WebGUI")
      .setCharacteristic(hap.Characteristic.Model, KIND_MODEL[kind])
      .setCharacteristic(hap.Characteristic.SerialNumber, key);
    const service = accessory.addService(hap.Service.Lightbulb, name);
    service.addOptionalCharacteristic(hap.Characteristic.ConfiguredName);
    service.setCharacteristic(hap.Characteristic.ConfiguredName, name);
    service.getCharacteristic(hap.Characteristic.On)
      .onGet(() => this.read(light).on)
      .onSet(value => this.write(light, { on: Boolean(value) }));
    if (dimmable) {
      service.getCharacteristic(hap.Characteristic.Brightness)
        .onGet(() => this.read(light).brightness ?? light.last.brightness)
        .onSet(value => this.write(light, { brightness: Number(value) }));
    }
    if (temperature) {
      service.getCharacteristic(hap.Characteristic.ColorTemperature)
        .setProps({ minValue: temperature.minMired, maxValue: temperature.maxMired })
        .updateValue(light.last.mired)
        .onGet(() => this.clampMired(light, this.read(light).mired ?? light.last.mired))
        .onSet(value => this.write(light, { mired: Number(value) }));
    }
    if (color) {
      service.getCharacteristic(hap.Characteristic.Hue)
        .onGet(() => this.read(light).hue ?? light.last.hue)
        .onSet(value => this.write(light, { hue: Number(value) }));
      service.getCharacteristic(hap.Characteristic.Saturation)
        .onGet(() => this.read(light).saturation ?? light.last.saturation)
        .onSet(value => this.write(light, { saturation: Number(value) }));
    }
    light.accessory = accessory;
    return [accessory];
  }

  private read(light: Light): LightState {
    const state = lightState(light.descriptor, this.source.cachedSnapshot());
    if (!state.available) throw communicationFailure();
    this.remember(light, state);
    return state;
  }

  private remember(light: Light, state: LightState): void {
    if (state.brightness) light.last.brightness = state.brightness;
    if (state.mired !== null) light.last.mired = this.clampMired(light, state.mired);
    if (state.hue !== null) light.last.hue = state.hue;
    if (state.saturation !== null) light.last.saturation = state.saturation;
  }

  private clampMired(light: Light, mired: number): number {
    const range = light.descriptor.temperature;
    return range ? Math.max(range.minMired, Math.min(range.maxMired, mired)) : mired;
  }

  /** The characteristics a light has besides On. */
  private valueCharacteristics(light: Light) {
    return [
      ...(light.descriptor.dimmable ? [hap.Characteristic.Brightness] : []),
      ...(light.descriptor.temperature ? [hap.Characteristic.ColorTemperature] : []),
      ...(light.descriptor.color ? [hap.Characteristic.Hue, hap.Characteristic.Saturation] : []),
    ];
  }

  /** Pushes a light's state to HomeKit when it changed, or "No Response" while it is unreachable. */
  private push(light: Light, snapshot: LightingSnapshot): void {
    const service = light.accessory?.getService(hap.Service.Lightbulb);
    if (!service) return;
    const state = lightState(light.descriptor, snapshot);
    const previous = light.pushed;
    light.pushed = state;
    if (!state.available) {
      if (previous?.available !== false) {
        for (const type of [hap.Characteristic.On, ...this.valueCharacteristics(light)]) service.getCharacteristic(type).updateValue(communicationFailure());
      }
      return;
    }
    this.remember(light, state);
    const fresh = previous?.available !== true;
    if (fresh || previous.on !== state.on) service.updateCharacteristic(hap.Characteristic.On, state.on);
    if (light.descriptor.dimmable && state.brightness !== null && (fresh || previous.brightness !== state.brightness)) service.updateCharacteristic(hap.Characteristic.Brightness, state.brightness);
    if (light.descriptor.temperature && state.mired !== null && (fresh || previous.mired !== state.mired)) service.updateCharacteristic(hap.Characteristic.ColorTemperature, this.clampMired(light, state.mired));
    if (light.descriptor.color && state.hue !== null && (fresh || previous.hue !== state.hue)) service.updateCharacteristic(hap.Characteristic.Hue, state.hue);
    if (light.descriptor.color && state.saturation !== null && (fresh || previous.saturation !== state.saturation)) service.updateCharacteristic(hap.Characteristic.Saturation, state.saturation);
  }

  /** Queues a write; it resolves when its batch was sent, or after the write timeout while Bluetooth is still busy. */
  private write(light: Light, write: LightWrite): Promise<void> {
    if (!this.source.cachedSnapshot().connected) throw communicationFailure();
    const merged: LightWrite = { ...this.pending.get(light.descriptor.key), ...write };
    // A colour temperature and a colour exclude each other; the newest choice wins.
    if (write.mired !== undefined) { delete merged.hue; delete merged.saturation; }
    if (write.hue !== undefined || write.saturation !== undefined) delete merged.mired;
    this.pending.set(light.descriptor.key, merged);
    const done = new Promise<void>((resolve, reject) => this.waiters.push({ resolve, reject }));
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => { this.flushTimer = null; this.flush(); }, this.options.flushMs);
      this.flushTimer.unref();
    }
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>(resolve => { timer = setTimeout(resolve, this.options.writeTimeoutMs); timer.unref(); });
    return Promise.race([done, timeout]).finally(() => clearTimeout(timer));
  }

  /** Sends the collected writes, one batch at a time, so a slow batch cannot interleave with the next. */
  private flush(): void {
    const writes = this.pending;
    const waiters = this.waiters;
    this.pending = new Map();
    this.waiters = [];
    this.sending = this.sending.then(async () => {
      const snapshot = this.source.cachedSnapshot();
      try {
        if (!snapshot.connected) throw communicationFailure();
        const commands = planWrites(Array.from(writes, ([key, write]) => {
          const light = this.lights.get(key);
          if (!light) return { unitIds: [], write };
          // Hue and Saturation usually arrive together; one alone keeps the light's current other value.
          const colour = write.hue !== undefined || write.saturation !== undefined ? { hue: write.hue ?? light.last.hue, saturation: write.saturation ?? light.last.saturation } : {};
          return { unitIds: lightUnitIds(light.descriptor, snapshot), write: { ...write, ...colour } };
        }), snapshot);
        for (const command of commands) await this.source.control(command, "homekit");
        waiters.forEach(waiter => waiter.resolve());
      } catch (error) {
        this.store.audit("homekit", "homekit.control_failed", { message: error instanceof Error ? error.message : "Unknown error." });
        waiters.forEach(waiter => waiter.reject(communicationFailure()));
      }
    });
  }

  private loadCache(): LightDescriptor[] {
    try {
      const cached = JSON.parse(this.store.appSetting(CACHE_KEY) || "[]") as unknown;
      if (!Array.isArray(cached)) return [];
      // Lights cached before colour support have no colour fields; they get them at the next connected sync.
      return cached.filter(item => Boolean(item) && typeof item.key === "string" && typeof item.name === "string" && ["unit", "group", "room"].includes(item.kind) && typeof item.id === "number" && typeof item.dimmable === "boolean")
        .map(item => ({ ...item, temperature: item.temperature ?? null, color: item.color === true }) as LightDescriptor);
    } catch { return []; }
  }

  private saveCache(): void {
    this.store.setAppSetting(CACHE_KEY, JSON.stringify(Array.from(this.lights.values(), light => light.descriptor)));
  }
}
