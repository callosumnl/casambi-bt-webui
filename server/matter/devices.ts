import { createHash } from "crypto";
import { Endpoint } from "@matter/main";
import { BridgedDeviceBasicInformationServer } from "@matter/main/behaviors/bridged-device-basic-information";
import { ColorControlServer } from "@matter/main/behaviors/color-control";
import { SwitchServer } from "@matter/main/behaviors/switch";
import { GenericSwitchDevice } from "@matter/main/devices/generic-switch";
import { ColorTemperatureLightDevice } from "@matter/main/devices/color-temperature-light";
import { ExtendedColorLightDevice } from "@matter/main/devices/extended-color-light";
import { DimmableLightDevice, DimmableLightRequirements } from "@matter/main/devices/dimmable-light";
import { OnOffLightDevice } from "@matter/main/devices/on-off-light";
import { OnOffPlugInUnitDevice } from "@matter/main/devices/on-off-plug-in-unit";
import { isScene, type LightDescriptor } from "../lighting/model";
import type { SwitchTrigger } from "../casambi/types";
import { matterLabel } from "./identity";

/**
 * A bridged device's state in Matter terms: `level` 1–254, `mired` the colour temperature, `hue` and `saturation`
 * 0–254, `colorMode` which of them the light shows; null when unknown or not supported.
 */
export type DeviceState = { reachable: boolean; on: boolean; level: number | null; mired: number | null; hue: number | null; saturation: number | null; colorMode: "temperature" | "color" | null };
/** What a controller (Google Home) asked for; only commands from a controller arrive here, never our own updates. */
export type DeviceHandlers = {
  onOn: (on: boolean) => void;
  onLevel: (level: number) => void;
  onMired: (mired: number) => void;
  /** Hue and saturation in Matter units (0–254); one of them may be missing when only the other changed. */
  onHueSaturation: (colour: { hue?: number; saturation?: number }) => void;
  /** CIE xy, 0–1. */
  onXy: (x: number, y: number) => void;
};

/** One bridged device, as far as MatterLights uses it; tests replace it. */
export interface MatterDevice {
  push(state: DeviceState): Promise<void>;
  rename(name: string): Promise<void>;
  remove(): Promise<void>;
  /** A wall switch button press, passed on as Matter switch events; wall switches only. */
  press?(button: number, trigger: SwitchTrigger): Promise<void>;
}
export interface DeviceFactory {
  add(descriptor: LightDescriptor, initial: DeviceState, handlers: DeviceHandlers): Promise<MatterDevice>;
}

const KIND_PRODUCT = { unit: "Casambi lamp", group: "Casambi group", room: "Room", scene: "Casambi scene", local_scene: "Saved scene", switch: "Casambi switch" } as const;

/** Casambi 0–255 → Matter 1–254, and back. */
export const toMatterLevel = (level: number) => Math.max(1, Math.min(254, Math.round((level / 255) * 254)));
export const fromMatterLevel = (level: number) => Math.max(1, Math.min(255, Math.round((level / 254) * 255)));

/** A stable endpoint id from the light's key; matter.js keeps the endpoint number by it, so controllers keep their setup. */
export const endpointId = (key: string) => key.replace(/[^A-Za-z0-9]+/g, "-");
/** Matter limits unique ids to 32 characters. */
const uniqueId = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 32);

/**
 * Level changes go to Casambi at once: Casambi has no transition time, and stepping through a transition would send a
 * Bluetooth command per step.
 */
class InstantLevelControlServer extends DimmableLightRequirements.LevelControlServer {
  override transition(...[targetLevel, , withOnOff, options]: Parameters<InstanceType<typeof DimmableLightRequirements.LevelControlServer>["transition"]>) {
    return super.transition(targetLevel, null, withOnOff, options);
  }
}

/** Hue, saturation, xy, and colour temperature for colour lamps; Matter's Extended Color Light needs xy and colour temperature. */
const ExtendedColorControlServer = ColorControlServer.with("HueSaturation", "Xy", "ColorTemperature").alter({ attributes: { remainingTime: { optional: false } } });
/** Matter's colour modes: 0 hue and saturation, 1 xy, 2 colour temperature. */
const COLOR_MODE = { color: 0, temperature: 2 } as const;
const XY_SCALE = 65536;

/**
 * A momentary switch with release and long-press events, as Google Home offers them as automation starters: press,
 * long press, and long-press release. matter.js derives the events from the switch position: 1 is pressed, 0 released.
 */
const ButtonSwitchServer = SwitchServer.with("MomentarySwitch", "MomentarySwitchRelease", "MomentarySwitchLongPress");
/** Casambi reports a hold once it decided it is one, so Matter's own long-press timer only needs to confirm it. */
const LONG_PRESS_MS = 100;
/** A hold whose release never arrives is released after this, so the button does not stay pressed. */
const STUCK_HOLD_MS = 10_000;

/**
 * A Casambi wall switch: one bridged Generic Switch per learned button, named "<switch> 1", "<switch> 2", …. A tap is a
 * short press, a hold a long press, and its release a long-press release.
 */
async function addWallSwitch(aggregator: Endpoint, descriptor: LightDescriptor, initial: DeviceState): Promise<MatterDevice> {
  const buttons = new Map<number, Endpoint>();
  const stuck = new Map<number, NodeJS.Timeout>();
  const name = (base: string, index: number) => `${matterLabel(base, "Switch").slice(0, 28).trim()} ${index + 1}`;
  const learned = descriptor.buttons ?? [];
  for (let index = 0; index < learned.length; index += 1) {
    const button = learned[index];
    const endpoint = new Endpoint(GenericSwitchDevice.with(BridgedDeviceBasicInformationServer, ButtonSwitchServer) as never, {
      id: `${endpointId(descriptor.key)}-b${button}`,
      bridgedDeviceBasicInformation: { nodeLabel: name(descriptor.name, index), productName: KIND_PRODUCT.switch, productLabel: KIND_PRODUCT.switch, uniqueId: uniqueId(`${descriptor.key}#${button}`), reachable: initial.reachable },
      switch: { numberOfPositions: 2, currentPosition: 0, longPressDelay: LONG_PRESS_MS },
    } as never);
    await aggregator.add(endpoint);
    buttons.set(button, endpoint);
  }
  const position = (endpoint: Endpoint, value: number) => endpoint.set({ switch: { currentPosition: value } } as never);
  const all = (work: (endpoint: Endpoint) => Promise<unknown>) => Promise.all(Array.from(buttons.values(), work)).then(() => undefined);
  return {
    push: state => all(endpoint => endpoint.set({ bridgedDeviceBasicInformation: { reachable: state.reachable } } as never)),
    rename: base => all(async endpoint => { const index = Array.from(buttons.values()).indexOf(endpoint); await endpoint.set({ bridgedDeviceBasicInformation: { nodeLabel: name(base, index) } } as never); }),
    remove: () => { stuck.forEach(timer => clearTimeout(timer)); return all(endpoint => endpoint.delete()); },
    async press(button, trigger) {
      const endpoint = buttons.get(button);
      if (!endpoint) return;
      clearTimeout(stuck.get(button));
      if (trigger === "tap") { await position(endpoint, 1); await position(endpoint, 0); return; }
      if (trigger === "hold") {
        await position(endpoint, 1);
        const timer = setTimeout(() => void position(endpoint, 0).catch(() => undefined), STUCK_HOLD_MS);
        timer.unref();
        stuck.set(button, timer);
        return;
      }
      await position(endpoint, 0);
    },
  };
}

/** A change came from a controller (it has a fabric), not from the bridge pushing Casambi state. */
const fromController = (context: unknown) => (context as { fabric?: unknown } | undefined)?.fabric !== undefined;

/** The ColorControl attributes for a state; only the ones of the light's mode, so the other keeps its last value. */
function colourAttributes(descriptor: LightDescriptor, state: DeviceState): Record<string, number> {
  const attributes: Record<string, number> = {};
  if (state.colorMode === "temperature" && state.mired !== null) Object.assign(attributes, { colorTemperatureMireds: state.mired, colorMode: COLOR_MODE.temperature, enhancedColorMode: COLOR_MODE.temperature });
  if (state.colorMode === "color" && descriptor.color && state.hue !== null && state.saturation !== null) Object.assign(attributes, { currentHue: state.hue, currentSaturation: state.saturation, colorMode: COLOR_MODE.color, enhancedColorMode: COLOR_MODE.color });
  return attributes;
}

/**
 * Bridged devices on the Matter node's aggregator endpoint: Extended Color Light for colour lamps, Color Temperature
 * Light for white lamps, Dimmable Light, or On/Off Light; scenes are On/Off Plug-in Units, so Google Home shows them
 * as switches and does not switch them with "all lights off".
 */
export function endpointFactory(aggregator: Endpoint): DeviceFactory {
  return {
    async add(descriptor, initial, handlers) {
      if (descriptor.kind === "switch") return addWallSwitch(aggregator, descriptor, initial);
      const range = descriptor.temperature ?? { minMired: 140, maxMired: 500 };
      const type = isScene(descriptor) ? OnOffPlugInUnitDevice.with(BridgedDeviceBasicInformationServer)
        : descriptor.color ? ExtendedColorLightDevice.with(BridgedDeviceBasicInformationServer, InstantLevelControlServer, ExtendedColorControlServer)
        : descriptor.temperature ? ColorTemperatureLightDevice.with(BridgedDeviceBasicInformationServer, InstantLevelControlServer)
        : descriptor.dimmable ? DimmableLightDevice.with(BridgedDeviceBasicInformationServer, InstantLevelControlServer)
        : OnOffLightDevice.with(BridgedDeviceBasicInformationServer);
      const leveled = descriptor.dimmable || descriptor.color || Boolean(descriptor.temperature);
      const coloured = descriptor.color || Boolean(descriptor.temperature);
      const mired = initial.mired ?? Math.round((range.minMired + range.maxMired) / 2);
      const endpoint = new Endpoint(type as typeof OnOffLightDevice, {
        id: endpointId(descriptor.key),
        bridgedDeviceBasicInformation: { nodeLabel: descriptor.name, productName: KIND_PRODUCT[descriptor.kind], productLabel: KIND_PRODUCT[descriptor.kind], uniqueId: uniqueId(descriptor.key), reachable: initial.reachable },
        onOff: { onOff: initial.on },
        ...(leveled ? { levelControl: { currentLevel: initial.level ?? 254, minLevel: 1, maxLevel: 254 } } : {}),
        ...(coloured ? { colorControl: {
          colorTempPhysicalMinMireds: range.minMired, colorTempPhysicalMaxMireds: range.maxMired, coupleColorTempToLevelMinMireds: range.minMired,
          colorTemperatureMireds: mired, colorMode: COLOR_MODE.temperature, enhancedColorMode: COLOR_MODE.temperature,
          ...(descriptor.color ? { currentHue: initial.hue ?? 0, currentSaturation: initial.saturation ?? 0, currentX: 20543, currentY: 21561 } : {}),
          ...colourAttributes(descriptor, initial),
        } } : {}),
      } as never);
      await aggregator.add(endpoint);
      type Listener<T> = { on(listener: (value: T, old: T, context: unknown) => void): void };
      const events = endpoint.events as unknown as {
        onOff: { onOff$Changed: Listener<boolean> };
        levelControl?: { currentLevel$Changed: Listener<number | null> };
        colorControl?: { colorTemperatureMireds$Changed: Listener<number>; currentHue$Changed?: Listener<number>; currentSaturation$Changed?: Listener<number>; currentX$Changed?: Listener<number>; currentY$Changed?: Listener<number> };
      };
      events.onOff.onOff$Changed.on((value, _old, context) => { if (fromController(context)) handlers.onOn(value); });
      events.levelControl?.currentLevel$Changed.on((value, _old, context) => { if (value !== null && fromController(context)) handlers.onLevel(value); });
      events.colorControl?.colorTemperatureMireds$Changed.on((value, _old, context) => { if (fromController(context)) handlers.onMired(value); });
      events.colorControl?.currentHue$Changed?.on((value, _old, context) => { if (fromController(context)) handlers.onHueSaturation({ hue: value }); });
      events.colorControl?.currentSaturation$Changed?.on((value, _old, context) => { if (fromController(context)) handlers.onHueSaturation({ saturation: value }); });
      // X and Y arrive as two changes of one command; the state already holds both when either one fires.
      const xy = () => { const state = (endpoint.state as unknown as { colorControl: { currentX: number; currentY: number } }).colorControl; handlers.onXy(state.currentX / XY_SCALE, state.currentY / XY_SCALE); };
      events.colorControl?.currentX$Changed?.on((_value, _old, context) => { if (fromController(context)) xy(); });
      events.colorControl?.currentY$Changed?.on((_value, _old, context) => { if (fromController(context)) xy(); });
      return {
        push: state => endpoint.set({
          bridgedDeviceBasicInformation: { reachable: state.reachable }, onOff: { onOff: state.on },
          ...(leveled && state.level !== null ? { levelControl: { currentLevel: state.level } } : {}),
          ...(coloured && Object.keys(colourAttributes(descriptor, state)).length ? { colorControl: colourAttributes(descriptor, state) } : {}),
        } as never),
        rename: name => endpoint.set({ bridgedDeviceBasicInformation: { nodeLabel: name } } as never),
        remove: () => endpoint.delete(),
      };
    },
  };
}
