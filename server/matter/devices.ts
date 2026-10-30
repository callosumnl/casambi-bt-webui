import { createHash } from "crypto";
import { Endpoint } from "@matter/main";
import { BridgedDeviceBasicInformationServer } from "@matter/main/behaviors/bridged-device-basic-information";
import { ColorControlServer } from "@matter/main/behaviors/color-control";
import { ColorTemperatureLightDevice } from "@matter/main/devices/color-temperature-light";
import { ExtendedColorLightDevice } from "@matter/main/devices/extended-color-light";
import { DimmableLightDevice, DimmableLightRequirements } from "@matter/main/devices/dimmable-light";
import { OnOffLightDevice } from "@matter/main/devices/on-off-light";
import { OnOffPlugInUnitDevice } from "@matter/main/devices/on-off-plug-in-unit";
import { isScene, type LightDescriptor } from "../lighting/model";

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
