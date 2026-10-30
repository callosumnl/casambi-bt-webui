import { bucketBy, planTargets } from "../casambi/commandPlan";
import { ControlRequest, isLampUnit, NetworkSnapshot, UnitSnapshot } from "../casambi/types";
import type { RoomRecord } from "../store";
import { sanitizeName } from "./identity";

/** The snapshot HomeKit works from: units carry their local room (see CasambiService.withMetadata). */
export type LightingSnapshot = Pick<NetworkSnapshot, "connected" | "network" | "groups"> & {
  units: Array<UnitSnapshot & { roomId?: number }>;
  rooms: RoomRecord[];
};

/** What one HomeKit light stands for. `key` is stable across restarts; HomeKit's accessory id is derived from it. */
export type LightDescriptor = { key: string; kind: "unit" | "group" | "room"; id: number; name: string; dimmable: boolean };
/** A light's state in HomeKit terms; `brightness` is 0–100 and null while off. */
export type LightState = { available: boolean; on: boolean; brightness: number | null };
/** What HomeKit asked for one light; Brightness and On arrive as separate writes and are merged. */
export type LightWrite = { on?: boolean; brightness?: number };

const FALLBACK_NAMES = { unit: "Lamp", group: "Group", room: "Room" } as const;

/** Casambi 0–255 → HomeKit 0–100 %, never 0 for a lamp that is on. */
export function levelToPercent(level: number): number { return level <= 0 ? 0 : Math.max(1, Math.min(100, Math.round((level / 255) * 100))); }
/** HomeKit 0–100 % → Casambi 0–255, never 0 for a brightness above 0. */
export function percentToLevel(percent: number): number { return percent <= 0 ? 0 : Math.max(1, Math.min(255, Math.round((Math.min(100, percent) / 100) * 255))); }

const lamps = (snapshot: LightingSnapshot) => snapshot.units.filter(isLampUnit);
const isDimmable = (unit: UnitSnapshot) => unit.capabilities.some(capability => capability.type === "dimmer");

/**
 * The lights HomeKit should show for a connected network: every lamp, every Casambi group and every local room
 * with at least one lamp. Units are keyed by their Casambi UUID, groups by network and group id, rooms by their
 * local id.
 */
export function describeLights(snapshot: LightingSnapshot): LightDescriptor[] {
  const lampUnits = lamps(snapshot);
  const byId = new Map(lampUnits.map(unit => [unit.id, unit]));
  const units = lampUnits.map(unit => ({ key: `unit:${unit.uuid || unit.id}`, kind: "unit" as const, id: unit.id, name: sanitizeName(unit.name, FALLBACK_NAMES.unit), dimmable: isDimmable(unit) }));
  const groups = snapshot.network ? snapshot.groups.flatMap(group => {
    const members = group.unitIds.map(id => byId.get(id)).filter((unit): unit is UnitSnapshot => Boolean(unit));
    return members.length ? [{ key: `group:${snapshot.network!.id}:${group.id}`, kind: "group" as const, id: group.id, name: sanitizeName(group.name, FALLBACK_NAMES.group), dimmable: members.some(isDimmable) }] : [];
  }) : [];
  const rooms = snapshot.rooms.flatMap(room => {
    const members = lampUnits.filter(unit => unit.roomId === room.id);
    return members.length ? [{ key: `room:${room.id}`, kind: "room" as const, id: room.id, name: sanitizeName(room.name, FALLBACK_NAMES.room), dimmable: members.some(isDimmable) }] : [];
  });
  return [...units, ...groups, ...rooms];
}

/** The lamps a light controls. */
export function lightUnitIds(light: Pick<LightDescriptor, "kind" | "id">, snapshot: LightingSnapshot): number[] {
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
 * Unavailable ("No Response" in Apple Home) while the network is disconnected or none of its lamps is reachable.
 */
export function lightState(light: Pick<LightDescriptor, "kind" | "id">, snapshot: LightingSnapshot): LightState {
  const ids = new Set(lightUnitIds(light, snapshot));
  const members = snapshot.units.filter(unit => ids.has(unit.id) && unit.state.online);
  if (!snapshot.connected || members.length === 0) return { available: false, on: false, brightness: null };
  const lit = members.filter(unit => unit.state.on && (unit.state.dimmer ?? 255) > 0);
  if (lit.length === 0) return { available: true, on: false, brightness: null };
  const average = lit.reduce((sum, unit) => sum + (unit.state.dimmer ?? 255), 0) / lit.length;
  return { available: true, on: true, brightness: levelToPercent(average) };
}

/**
 * Turns HomeKit writes into as few Casambi commands as possible. Each write becomes on, off, or a level for its
 * lamps (a later write for the same lamp wins); lamps that get the same command are planned together, so "turn off
 * the living room" in Apple Home becomes one group or network command instead of one per lamp. On uses Casambi's own
 * `on`, which brings each lamp back to its last level.
 */
export function planWrites(writes: Array<{ unitIds: number[]; write: LightWrite }>, snapshot: LightingSnapshot): ControlRequest[] {
  const perUnit = new Map<number, { operation: "on" | "off" | "set_level"; value?: number }>();
  for (const { unitIds, write } of writes) {
    const command = write.on === false || write.brightness === 0 ? { operation: "off" as const }
      : write.brightness !== undefined ? { operation: "set_level" as const, value: percentToLevel(write.brightness) }
      : write.on === true ? { operation: "on" as const } : null;
    if (command) for (const unitId of unitIds) perUnit.set(unitId, command);
  }
  return bucketBy(perUnit, command => `${command.operation}:${command.value ?? ""}`).flatMap(bucket =>
    planTargets(bucket.unitIds, snapshot).map(target => ({ ...target, operation: bucket.value.operation, ...(bucket.value.value !== undefined ? { value: bucket.value.value } : {}) })));
}
