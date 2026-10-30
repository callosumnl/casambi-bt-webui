import { bucketBy, planTargets } from "../casambi/commandPlan";
import { ControlRequest, isLampUnit, NetworkSnapshot, UnitSnapshot } from "../casambi/types";
import type { RoomRecord } from "../store";
import { HueSaturation, hueSaturationToRgb, kelvinToMired, miredRange, miredToHueSaturation, miredToKelvin, rgbToHueSaturation, rgbToXy, xyToRgb } from "./colour";

/** The snapshot HomeKit works from: units carry their local room (see CasambiService.withMetadata). */
export type LightingSnapshot = Pick<NetworkSnapshot, "connected" | "network" | "groups"> & Partial<Pick<NetworkSnapshot, "scenes">> & {
  units: Array<UnitSnapshot & { roomId?: number }>;
  rooms: RoomRecord[];
};

/**
 * What one HomeKit accessory stands for: a light (unit, group, room), a scene switch (a scene stored in the
 * Casambi network, or one saved on the Pi), or a Casambi wall switch with its `buttons`. `key` is stable across
 * restarts; HomeKit's accessory id is derived from it. `temperature` is the mired range when a lamp takes a colour
 * temperature; `color` says a lamp takes RGB or XY colour.
 */
export type LightDescriptor = { key: string; kind: "unit" | "group" | "room" | "scene" | "local_scene" | "switch"; id: number; name: string; dimmable: boolean; temperature: { minMired: number; maxMired: number } | null; color: boolean; buttons?: number[] };
/**
 * A light's state: `brightness` is 0–100 and `level` the Casambi level 0–255 (both null while off), so each platform
 * converts from the precision it needs; colour values are null when unknown.
 */
export type LightState = { available: boolean; on: boolean; brightness: number | null; level: number | null; mired: number | null; hue: number | null; saturation: number | null; colorMode: "temperature" | "color" | null };
/**
 * What a platform asked for one light; On, Brightness, Hue, and Saturation arrive as separate writes and are merged.
 * `level` is a Casambi level 0–255, for platforms with a finer scale than percent; it wins over `brightness`.
 */
export type LightWrite = { on?: boolean; brightness?: number; level?: number; mired?: number; hue?: number; saturation?: number };
type ColorSource = "temperature" | "rgb" | "xy";

/** Turns a Casambi or local name into one a smart home platform accepts; `fallback` when nothing is left. */
export type NameRule = (name: string, fallback: string) => string;
/** Collapsed whitespace, and the fallback for an empty name; platforms with stricter rules pass their own. */
export const plainName: NameRule = (name, fallback) => name.trim().replace(/\s+/g, " ") || fallback;

const FALLBACK_NAMES = { unit: "Lamp", group: "Group", room: "Room", scene: "Scene", switch: "Switch" } as const;
const NO_COLOUR = { dimmable: false, temperature: null, color: false };

export const isScene = (light: Pick<LightDescriptor, "kind">) => light.kind === "scene" || light.kind === "local_scene";
/** Where a wall switch's learned buttons are kept: by the unit's Casambi UUID, which survives a re-pairing of the network. */
export const switchKey = (unit: Pick<UnitSnapshot, "id" | "uuid">) => unit.uuid || String(unit.id);

/** Casambi 0–255 → HomeKit 0–100 %, never 0 for a lamp that is on. */
export function levelToPercent(level: number): number { return level <= 0 ? 0 : Math.max(1, Math.min(100, Math.round((level / 255) * 100))); }
/** HomeKit 0–100 % → Casambi 0–255, never 0 for a brightness above 0. */
export function percentToLevel(percent: number): number { return percent <= 0 ? 0 : Math.max(1, Math.min(255, Math.round((Math.min(100, percent) / 100) * 255))); }

const lamps = (snapshot: LightingSnapshot) => snapshot.units.filter(isLampUnit);
const capability = (unit: UnitSnapshot, type: string) => unit.capabilities.find(item => item.type === type);
const isDimmable = (unit: UnitSnapshot) => Boolean(capability(unit, "dimmer"));
const takesColor = (unit: UnitSnapshot) => Boolean(capability(unit, "rgb") || capability(unit, "xy"));
/** A lamp's colour temperature range in kelvin; casambi-bt reports it on the control, with a common default. */
export function kelvinRange(unit: UnitSnapshot): { min: number; max: number } | null {
  const control = capability(unit, "temperature");
  if (!control) return null;
  const min = control.min && control.min >= 1000 ? control.min : 2700;
  const max = control.max && control.max <= 12000 && control.max > min ? control.max : 6500;
  return { min, max };
}
/** The colour features of a set of lamps: the widest mired range among them, and whether any takes colour. */
function colourFeatures(members: UnitSnapshot[]): Pick<LightDescriptor, "temperature" | "color"> {
  const ranges = members.map(kelvinRange).filter((range): range is { min: number; max: number } => Boolean(range)).map(range => miredRange(range.min, range.max));
  return {
    temperature: ranges.length ? { minMired: Math.min(...ranges.map(range => range.minMired)), maxMired: Math.max(...ranges.map(range => range.maxMired)) } : null,
    color: members.some(takesColor),
  };
}
/** Which colour a lamp shows: what it reports, otherwise its only colour control. */
function colorSource(unit: UnitSnapshot): ColorSource | null {
  if (unit.state.colorSource) return unit.state.colorSource;
  if (capability(unit, "temperature") && !takesColor(unit)) return "temperature";
  if (capability(unit, "rgb")) return "rgb";
  if (capability(unit, "xy")) return "xy";
  return capability(unit, "temperature") ? "temperature" : null;
}
/** The hue and saturation a lamp shows, also for white light, so Apple Home draws it right. */
function unitHueSaturation(unit: UnitSnapshot): HueSaturation | null {
  const source = colorSource(unit);
  if (source === "rgb" && unit.state.rgb) return rgbToHueSaturation(unit.state.rgb);
  if (source === "xy" && unit.state.xy) return rgbToHueSaturation(xyToRgb(unit.state.xy));
  if (source === "temperature" && unit.state.temperature) return miredToHueSaturation(kelvinToMired(unit.state.temperature));
  return null;
}

/**
 * The lights HomeKit should show for a connected network: every lamp, every Casambi group, and every local room.
 * Units are keyed by their Casambi UUID, groups by network and group id, rooms by their local id. Duplicates are
 * left out, because Apple Home would show them twice: a group or room with a single lamp (the lamp itself is
 * shown), and a room with exactly the lamps of a Casambi group, as the setup wizard creates them (the group is
 * kept: it is switched with one Bluetooth command).
 */
export function describeLights(snapshot: LightingSnapshot, localScenes: Array<{ id: number; name: string }> = [], buttons: Record<string, number[]> = {}, nameOf: NameRule = plainName): LightDescriptor[] {
  const lampUnits = lamps(snapshot);
  const byId = new Map(lampUnits.map(unit => [unit.id, unit]));
  const units = lampUnits.map(unit => ({ key: `unit:${unit.uuid || unit.id}`, kind: "unit" as const, id: unit.id, name: nameOf(unit.name, FALLBACK_NAMES.unit), dimmable: isDimmable(unit), ...colourFeatures([unit]) }));
  const lampSet = (members: UnitSnapshot[]) => members.map(unit => unit.id).sort((left, right) => left - right).join(",");
  const groupLampSets = new Set<string>();
  const groups = snapshot.network ? snapshot.groups.flatMap(group => {
    const members = group.unitIds.map(id => byId.get(id)).filter((unit): unit is UnitSnapshot => Boolean(unit));
    if (members.length > 1) groupLampSets.add(lampSet(members));
    return members.length > 1 ? [{ key: `group:${snapshot.network!.id}:${group.id}`, kind: "group" as const, id: group.id, name: nameOf(group.name, FALLBACK_NAMES.group), dimmable: members.some(isDimmable), ...colourFeatures(members) }] : [];
  }) : [];
  const rooms = snapshot.rooms.flatMap(room => {
    const members = lampUnits.filter(unit => unit.roomId === room.id);
    return members.length > 1 && !groupLampSets.has(lampSet(members)) ? [{ key: `room:${room.id}`, kind: "room" as const, id: room.id, name: nameOf(room.name, FALLBACK_NAMES.room), dimmable: members.some(isDimmable), ...colourFeatures(members) }] : [];
  });
  const scenes = snapshot.network ? (snapshot.scenes ?? []).map(scene => ({ key: `scene:${snapshot.network!.id}:${scene.id}`, kind: "scene" as const, id: scene.id, name: nameOf(scene.name, FALLBACK_NAMES.scene), ...NO_COLOUR })) : [];
  const saved = localScenes.map(scene => ({ key: `local_scene:${scene.id}`, kind: "local_scene" as const, id: scene.id, name: nameOf(scene.name, FALLBACK_NAMES.scene), ...NO_COLOUR }));
  // A wall switch appears once its buttons were pressed: Casambi does not report how many buttons a switch has.
  const switches = snapshot.units.flatMap(unit => {
    const pressed = buttons[switchKey(unit)];
    return pressed?.length ? [{ key: `switch:${switchKey(unit)}`, kind: "switch" as const, id: unit.id, name: nameOf(unit.name, FALLBACK_NAMES.switch), ...NO_COLOUR, buttons: [...pressed].sort((left, right) => left - right) }] : [];
  });
  return [...units, ...groups, ...rooms, ...scenes, ...saved, ...switches];
}

/** The lamps a light controls. */
export function lightUnitIds(light: Pick<LightDescriptor, "kind" | "id">, snapshot: LightingSnapshot): number[] {
  if (isScene(light) || light.kind === "switch") return [];
  const lampUnits = lamps(snapshot);
  if (light.kind === "unit") return lampUnits.some(unit => unit.id === light.id) ? [light.id] : [];
  if (light.kind === "group") {
    const members = new Set(snapshot.groups.find(group => group.id === light.id)?.unitIds ?? []);
    return lampUnits.filter(unit => members.has(unit.id)).map(unit => unit.id);
  }
  return lampUnits.filter(unit => unit.roomId === light.id).map(unit => unit.id);
}

/**
 * A light's state: on when any of its reachable lamps is on, at the average level of the lamps that are on.
 * Colour temperature is the average of its lamps' (the lit ones, or all while off), hue and saturation those of its
 * first lamp that reports a colour. Unavailable ("No Response" in Apple Home) while the network is disconnected or
 * none of its lamps is reachable.
 */
export function lightState(light: Pick<LightDescriptor, "kind" | "id">, snapshot: LightingSnapshot): LightState {
  // A scene switch is always off (it only activates the scene) and works while the network is connected.
  if (isScene(light)) return { available: snapshot.connected, on: false, brightness: null, level: null, mired: null, hue: null, saturation: null, colorMode: null };
  // A wall switch has no state of its own; it is reachable while the network is connected and the unit online.
  if (light.kind === "switch") return { available: snapshot.connected && snapshot.units.some(unit => unit.id === light.id && unit.state.online), on: false, brightness: null, level: null, mired: null, hue: null, saturation: null, colorMode: null };
  const ids = new Set(lightUnitIds(light, snapshot));
  const members = snapshot.units.filter(unit => ids.has(unit.id) && unit.state.online);
  if (!snapshot.connected || members.length === 0) return { available: false, on: false, brightness: null, level: null, mired: null, hue: null, saturation: null, colorMode: null };
  const lit = members.filter(unit => unit.state.on && (unit.state.dimmer ?? 255) > 0);
  const shown = lit.length ? lit : members;
  const temperatures = shown.filter(unit => capability(unit, "temperature") && unit.state.temperature).map(unit => kelvinToMired(unit.state.temperature!));
  const colourUnit = shown.find(unit => unitHueSaturation(unit));
  const colour = colourUnit ? unitHueSaturation(colourUnit) : null;
  // Which colour the light shows: a colour when its first colour lamp shows RGB or XY, otherwise white.
  const source = colourUnit ? colorSource(colourUnit) : null;
  const colorMode = source === "rgb" || source === "xy" ? "color" as const : temperatures.length || source === "temperature" ? "temperature" as const : null;
  const colourState = { mired: temperatures.length ? Math.round(temperatures.reduce((sum, value) => sum + value, 0) / temperatures.length) : null, hue: colour?.hue ?? null, saturation: colour?.saturation ?? null, colorMode };
  if (lit.length === 0) return { available: true, on: false, brightness: null, level: null, ...colourState };
  const average = lit.reduce((sum, unit) => sum + (unit.state.dimmer ?? 255), 0) / lit.length;
  return { available: true, on: true, brightness: levelToPercent(average), level: Math.max(1, Math.min(255, Math.round(average))), ...colourState };
}

/** The colour command a lamp gets for a write, in the form it takes; null when the write has no colour or the lamp cannot show it. */
function colourCommand(unit: UnitSnapshot | undefined, write: LightWrite): { operation: "set_temperature" | "set_color" | "set_xy"; value: number | number[] } | null {
  if (!unit) return null;
  const range = kelvinRange(unit);
  let target: HueSaturation | null = null;
  if (write.hue !== undefined || write.saturation !== undefined) target = { hue: write.hue ?? 0, saturation: write.saturation ?? 100 };
  else if (write.mired !== undefined) {
    // A white lamp takes the temperature itself; a colour-only lamp in a group shows the matching white.
    if (range) return { operation: "set_temperature", value: Math.max(range.min, Math.min(range.max, miredToKelvin(write.mired))) };
    target = miredToHueSaturation(write.mired);
  }
  if (!target) return null;
  if (capability(unit, "rgb")) return { operation: "set_color", value: hueSaturationToRgb(target) };
  if (capability(unit, "xy")) return { operation: "set_xy", value: rgbToXy(hueSaturationToRgb(target)) };
  return null;
}

/**
 * Turns HomeKit writes into as few Casambi commands as possible. Each write becomes on, off, or a level for its
 * lamps, plus a colour in the form each lamp takes (a later write for the same lamp wins); lamps that get the same
 * command are planned together, so "turn off the living room" in Apple Home becomes one group or network command
 * instead of one per lamp. On uses Casambi's own `on`, which brings each lamp back to its last level. Colours go out
 * before power, so a lamp that is switched on in a new colour does not flash its old one.
 */
export function planWrites(writes: Array<{ unitIds: number[]; write: LightWrite }>, snapshot: LightingSnapshot): ControlRequest[] {
  type Command = { operation: ControlRequest["operation"]; value?: number | number[] };
  const units = new Map(snapshot.units.map(unit => [unit.id, unit]));
  const power = new Map<number, Command>();
  const colour = new Map<number, Command>();
  for (const { unitIds, write } of writes) {
    const command = write.on === false || write.brightness === 0 || write.level === 0 ? { operation: "off" as const }
      : write.level !== undefined ? { operation: "set_level" as const, value: Math.max(1, Math.min(255, Math.round(write.level))) }
      : write.brightness !== undefined ? { operation: "set_level" as const, value: percentToLevel(write.brightness) }
      : write.on === true ? { operation: "on" as const } : null;
    for (const unitId of unitIds) {
      if (command) power.set(unitId, command);
      const colourFor = colourCommand(units.get(unitId), write);
      if (colourFor) colour.set(unitId, colourFor);
    }
  }
  const plan = (commands: Map<number, Command>) => bucketBy(commands, command => `${command.operation}:${JSON.stringify(command.value ?? null)}`).flatMap(bucket =>
    planTargets(bucket.unitIds, snapshot).map(target => ({ ...target, operation: bucket.value.operation, ...(bucket.value.value !== undefined ? { value: bucket.value.value } : {}) })));
  return [...plan(colour), ...plan(power)];
}
