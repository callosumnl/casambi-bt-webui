import { createHash } from "crypto";
import { Endpoint } from "@matter/main";
import { BridgedDeviceBasicInformationServer } from "@matter/main/behaviors/bridged-device-basic-information";
import { DimmableLightDevice, DimmableLightRequirements } from "@matter/main/devices/dimmable-light";
import { OnOffLightDevice } from "@matter/main/devices/on-off-light";
import type { LightDescriptor } from "../lighting/model";

/** A bridged device's state in Matter terms: `level` is 1–254, null when unknown. */
export type DeviceState = { reachable: boolean; on: boolean; level: number | null };
/** What a controller (Google Home) asked for; only commands from a controller arrive here, never our own updates. */
export type DeviceHandlers = { onOn: (on: boolean) => void; onLevel: (level: number) => void };

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

/** A change came from a controller (it has a fabric), not from the bridge pushing Casambi state. */
const fromController = (context: unknown) => (context as { fabric?: unknown } | undefined)?.fabric !== undefined;

/** Bridged lights on the Matter node's aggregator endpoint: On/Off Light, or Dimmable Light when a lamp dims. */
export function endpointFactory(aggregator: Endpoint): DeviceFactory {
  return {
    async add(descriptor, initial, handlers) {
      const type = descriptor.dimmable
        ? DimmableLightDevice.with(BridgedDeviceBasicInformationServer, InstantLevelControlServer)
        : OnOffLightDevice.with(BridgedDeviceBasicInformationServer);
      const endpoint = new Endpoint(type as typeof OnOffLightDevice, {
        id: endpointId(descriptor.key),
        bridgedDeviceBasicInformation: { nodeLabel: descriptor.name, productName: KIND_PRODUCT[descriptor.kind], productLabel: KIND_PRODUCT[descriptor.kind], uniqueId: uniqueId(descriptor.key), reachable: initial.reachable },
        onOff: { onOff: initial.on },
        ...(descriptor.dimmable ? { levelControl: { currentLevel: initial.level ?? 254, minLevel: 1, maxLevel: 254 } } : {}),
      } as never);
      await aggregator.add(endpoint);
      const events = endpoint.events as unknown as {
        onOff: { onOff$Changed: { on(listener: (value: boolean, old: boolean, context: unknown) => void): void } };
        levelControl?: { currentLevel$Changed: { on(listener: (value: number | null, old: number | null, context: unknown) => void): void } };
      };
      events.onOff.onOff$Changed.on((value, _old, context) => { if (fromController(context)) handlers.onOn(value); });
      events.levelControl?.currentLevel$Changed.on((value, _old, context) => { if (value !== null && fromController(context)) handlers.onLevel(value); });
      return {
        push: state => endpoint.set({
          bridgedDeviceBasicInformation: { reachable: state.reachable }, onOff: { onOff: state.on },
          ...(descriptor.dimmable && state.level !== null ? { levelControl: { currentLevel: state.level } } : {}),
        } as never),
        rename: name => endpoint.set({ bridgedDeviceBasicInformation: { nodeLabel: name } } as never),
        remove: () => endpoint.delete(),
      };
    },
  };
}
