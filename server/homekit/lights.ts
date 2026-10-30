import * as hap from "hap-nodejs";
import type { ControlRequest, SwitchPress } from "../casambi/types";
import type { LocalStore } from "../store";
import { isScene, switchKey, LightDescriptor, LightingSnapshot, lightState, LightState, lightUnitIds, LightWrite } from "../lighting/model";
import { LightRegistry, LightingSource, RegistryChange } from "../lighting/registry";
import { WriteBatcher } from "../lighting/writes";
import { sanitizeName } from "./identity";

export type { CatalogEntry, LightingSource } from "../lighting/registry";

/** Adds and removes bridged accessories on the published bridge. */
export interface AccessoryHost {
  addAccessories(accessories: hap.Accessory[]): void;
  removeAccessories(accessories: hap.Accessory[]): void;
}

/** HomeKit allows 150 accessories per bridge, the bridge itself included. */
export const MAX_LIGHTS = 149;
const KIND_MODEL = { unit: "Casambi lamp", group: "Casambi group", room: "Room", scene: "Casambi scene", local_scene: "Saved scene", switch: "Casambi switch" } as const;
/** How long a scene switch stays on in Apple Home after it activated its scene. */
const SCENE_SWITCH_MS = 1_000;

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
type Light = { descriptor: LightDescriptor; accessory: hap.Accessory | null; pushed: LightState | null; last: { brightness: number; mired: number; hue: number; saturation: number }; sceneOnUntil?: number };
const newLight = (descriptor: LightDescriptor): Light => ({
  descriptor, accessory: null, pushed: null,
  last: { brightness: 100, mired: descriptor.temperature ? Math.round((descriptor.temperature.minMired + descriptor.temperature.maxMired) / 2) : 300, hue: 0, saturation: 0 },
});

const communicationFailure = () => new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);

/**
 * The HomeKit accessories: lights for lamps, Casambi groups, and rooms, switches for scenes, and remotes for wall
 * switches. Which ones exist is the shared LightRegistry's job (kept in settings under "homekit.*", so Apple Home
 * keeps its setup across restarts and disconnects); this class builds the HAP accessories for them. Reads answer from
 * the cached snapshot and never wait for Bluetooth; light writes go through the shared WriteBatcher; a scene switch
 * activates its scene and turns itself off again.
 */
export class HomeKitLights {
  private readonly lights = new Map<string, Light>();
  private readonly registry: LightRegistry;
  private readonly writes: WriteBatcher;
  private host: AccessoryHost | null = null;
  private skipped = 0;
  private syncTimer: NodeJS.Timeout | null = null;
  private readonly resyncTimer: NodeJS.Timeout;

  public constructor(private readonly store: LocalStore, private readonly source: LightingSource, private readonly options: Options = { flushMs: 75, removeAfterMs: 10 * 60_000, writeTimeoutMs: 5_000, now: Date.now }) {
    this.registry = new LightRegistry(store, { prefix: "homekit", nameOf: sanitizeName, removeAfterMs: options.removeAfterMs, now: options.now });
    this.writes = new WriteBatcher(store, source, {
      actor: "homekit", flushMs: options.flushMs, writeTimeoutMs: options.writeTimeoutMs, failure: communicationFailure,
      unitIds: (key, snapshot) => { const light = this.lights.get(key); return light ? lightUnitIds(light.descriptor, snapshot) : null; },
      currentColour: key => { const last = this.lights.get(key)?.last; return { hue: last?.hue ?? 0, saturation: last?.saturation ?? 0 }; },
    });
    this.loadLights();
    source.onStateChange(() => this.scheduleSync());
    source.onSwitchPress?.(press => this.handlePress(press));
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

  /** Reads the list of lights and the hidden keys again, after a restore replaced the database. */
  public reload(): void {
    this.attach(null);
    this.registry.reload();
    this.loadLights();
  }

  /** Everything HomeKit can show, and whether it does; for the Admin panel. */
  public catalog() { return this.registry.catalog(); }

  /** Hides these keys from HomeKit and shows everything else; hidden accessories are removed at once. */
  public setHidden(keys: string[]): void {
    this.apply(this.registry.setHidden(keys));
    this.sync();
  }

  /** How many lights HomeKit shows, and how many did not fit on the bridge. */
  public status(): { lights: number; notShown: number } {
    return { lights: Array.from(this.lights.values()).filter(light => light.accessory).length, notShown: this.skipped };
  }

  /** Brings the lights in line with the network (new, renamed, and removed lamps, groups, rooms) and pushes their state. */
  public sync(): void {
    const snapshot = this.source.cachedSnapshot();
    if (snapshot.connected && snapshot.network) this.apply(this.registry.reconcile(snapshot));
    for (const light of Array.from(this.lights.values())) this.push(light, snapshot);
  }

  /** Stops the timers; for tests and shutdown. */
  public close(): void {
    this.writes.close();
    if (this.syncTimer) clearTimeout(this.syncTimer);
    clearInterval(this.resyncTimer);
  }

  private scheduleSync(): void {
    if (this.syncTimer) return;
    this.syncTimer = setTimeout(() => { this.syncTimer = null; this.sync(); }, 100);
    this.syncTimer.unref();
  }

  private loadLights(): void {
    this.lights.clear();
    for (const descriptor of this.registry.entries()) this.lights.set(descriptor.key, newLight(descriptor));
  }

  /** Turns a registry change into added, removed, rebuilt, and renamed accessories. */
  private apply(change: RegistryChange): void {
    const added: hap.Accessory[] = [];
    const removed: hap.Accessory[] = [];
    for (const descriptor of change.removed) {
      const light = this.lights.get(descriptor.key);
      if (light?.accessory) removed.push(light.accessory);
      this.lights.delete(descriptor.key);
    }
    for (const descriptor of change.rebuilt) {
      // A characteristic set that changed needs a new accessory; HomeKit keeps it in place because its id stays.
      const light = this.lights.get(descriptor.key) ?? newLight(descriptor);
      this.lights.set(descriptor.key, light);
      if (light.accessory) removed.push(light.accessory);
      light.descriptor = descriptor;
      light.accessory = null;
      light.pushed = null;
      if (this.host) added.push(...this.build(light));
    }
    for (const descriptor of change.renamed) {
      const light = this.lights.get(descriptor.key);
      if (!light) continue;
      light.descriptor = descriptor;
      this.serviceOf(light)?.updateCharacteristic(hap.Characteristic.ConfiguredName, descriptor.name);
    }
    for (const descriptor of change.added) {
      const light = newLight(descriptor);
      this.lights.set(descriptor.key, light);
      if (this.host) added.push(...this.build(light));
    }
    if (this.host && removed.length) this.host.removeAccessories(removed);
    if (this.host && added.length) this.host.addAccessories(added);
  }

  /** Creates the accessory for a light, unless the bridge is full. */
  private build(light: Light): hap.Accessory[] {
    if (Array.from(this.lights.values()).filter(other => other.accessory).length >= MAX_LIGHTS) { this.skipped += 1; return []; }
    const { key, name, kind, dimmable, temperature, color } = light.descriptor;
    const accessory = new hap.Accessory(name, hap.uuid.generate(`casambi-bt-webui:${key}`));
    accessory.category = isScene(light.descriptor) ? hap.Categories.SWITCH : kind === "switch" ? hap.Categories.PROGRAMMABLE_SWITCH : hap.Categories.LIGHTBULB;
    accessory.getService(hap.Service.AccessoryInformation)!
      .setCharacteristic(hap.Characteristic.Manufacturer, "Casambi BT WebGUI")
      .setCharacteristic(hap.Characteristic.Model, KIND_MODEL[kind])
      .setCharacteristic(hap.Characteristic.SerialNumber, key);
    if (kind === "switch") {
      // One stateless programmable switch per button, numbered in order, as HomeKit expects for a multi-button remote.
      accessory.addService(hap.Service.ServiceLabel, name).setCharacteristic(hap.Characteristic.ServiceLabelNamespace, hap.Characteristic.ServiceLabelNamespace.ARABIC_NUMERALS);
      (light.descriptor.buttons ?? []).forEach((button, index) => {
        const service = accessory.addService(hap.Service.StatelessProgrammableSwitch, `${name} ${index + 1}`, `button-${button}`);
        service.getCharacteristic(hap.Characteristic.ProgrammableSwitchEvent).setProps({ validValues: [hap.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS, hap.Characteristic.ProgrammableSwitchEvent.LONG_PRESS] });
        service.setCharacteristic(hap.Characteristic.ServiceLabelIndex, index + 1);
      });
      light.accessory = accessory;
      return [accessory];
    }
    if (isScene(light.descriptor)) {
      // A momentary switch, as Homebridge plugins expose scenes: switching it on activates the scene.
      const sceneSwitch = accessory.addService(hap.Service.Switch, name);
      sceneSwitch.addOptionalCharacteristic(hap.Characteristic.ConfiguredName);
      sceneSwitch.setCharacteristic(hap.Characteristic.ConfiguredName, name);
      sceneSwitch.getCharacteristic(hap.Characteristic.On)
        .onGet(() => { this.read(light); return this.options.now() < (light.sceneOnUntil ?? 0); })
        .onSet(value => (value ? this.activate(light) : undefined));
      light.accessory = accessory;
      return [accessory];
    }
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

  /**
   * A wall switch press: a button HomeKit does not know yet is learned (the switch appears or gets the button); a known
   * one is passed on as a single press (tap) or long press (hold), which Home automations can react to.
   */
  private handlePress(press: SwitchPress): void {
    if ((press.trigger !== "tap" && press.trigger !== "hold") || press.unitId === null || press.button === null) return;
    const unit = this.source.cachedSnapshot().units.find(item => item.id === press.unitId);
    if (!unit) return;
    if (this.registry.learnButton(unit, press.button)) { this.sync(); return; }
    const event = press.trigger === "hold" ? hap.Characteristic.ProgrammableSwitchEvent.LONG_PRESS : hap.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS;
    this.lights.get(`switch:${switchKey(unit)}`)?.accessory?.getServiceById(hap.Service.StatelessProgrammableSwitch, `button-${press.button}`)
      ?.getCharacteristic(hap.Characteristic.ProgrammableSwitchEvent).updateValue(event);
  }

  private serviceOf(light: Light): hap.Service | undefined {
    return light.accessory?.getService(isScene(light.descriptor) ? hap.Service.Switch : hap.Service.Lightbulb);
  }

  /** Activates a scene, then turns its switch off again; a failure answers "No Response" and is audited. */
  private async activate(light: Light): Promise<void> {
    if (!this.source.cachedSnapshot().connected) throw communicationFailure();
    const command = { targetType: light.descriptor.kind, targetId: light.descriptor.id, operation: "activate_scene" } as ControlRequest;
    light.sceneOnUntil = this.options.now() + SCENE_SWITCH_MS;
    const reset = setTimeout(() => this.serviceOf(light)?.updateCharacteristic(hap.Characteristic.On, false), SCENE_SWITCH_MS);
    reset.unref();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>(resolve => { timer = setTimeout(resolve, this.options.writeTimeoutMs); timer.unref(); });
    try {
      await Promise.race([this.source.control(command, "homekit"), timeout]);
    } catch (error) {
      this.store.audit("homekit", "homekit.control_failed", { message: error instanceof Error ? error.message : "Unknown error." });
      throw communicationFailure();
    } finally { clearTimeout(timer); }
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
    // A wall switch has no state to push; its button presses are events.
    if (light.descriptor.kind === "switch") return;
    const service = this.serviceOf(light);
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

  private write(light: Light, write: LightWrite): Promise<void> { return this.writes.write(light.descriptor.key, write); }
}
