import type { Device, LocalScene, NetworkSnapshot, SceneScope } from "./localApi";

/** Capabilities that make a unit a controllable light; switches and sensors report none of them. */
const LAMP_CAPABILITIES = new Set(["dimmer", "onoff", "white", "rgb", "temperature", "vertical", "colorsource", "xy", "slider"]);
export function isLamp(device: Pick<Device, "capabilities">): boolean { return device.capabilities.some(capability => LAMP_CAPABILITIES.has(capability.type)); }

/** The lamps a group, room, or the whole network covers. */
export function scopeLamps(network: NetworkSnapshot, scope: SceneScope): Device[] {
  const ids = scope.type === "group" ? new Set(network.groups.find(group => group.id === scope.id)?.unitIds ?? []) : null;
  return network.units.filter(unit => isLamp(unit) && (scope.type === "network" || (scope.type === "room" ? unit.roomId === scope.id : ids!.has(unit.id))));
}

export function sameScope(a: SceneScope, b: SceneScope): boolean { return a.type === b.type && a.id === b.id; }

/** Average brightness (0-100 %) of the lamps that are on, for a collective slider's resting position. */
export function averageBrightnessPercent(lamps: Device[]): number {
  const lit = lamps.filter(lamp => lamp.state.on);
  if (lit.length === 0) return 0;
  return Math.round(lit.reduce((sum, lamp) => sum + (lamp.state.dimmer ?? 255), 0) / lit.length / 2.55);
}

/** Scenes a timer or switch rule can activate: Casambi network scenes and scenes saved on the Pi, as `type:id` option values. */
export function sceneTargetOptions(network: NetworkSnapshot | null, scenes: LocalScene[]): Array<{ value: string; label: string }> {
  const scopeName = (scope: SceneScope) => scope.type === "network" ? "All lights" : scope.type === "group" ? network?.groups.find(group => group.id === scope.id)?.name ?? `Group ${scope.id}` : network?.rooms.find(room => room.id === scope.id)?.name ?? `Room ${scope.id}`;
  return [
    ...scenes.map(scene => ({ value: `local_scene:${scene.id}`, label: `${scene.name} · ${scopeName(scene.scope)}` })),
    ...(network?.scenes ?? []).map(scene => ({ value: `scene:${scene.id}`, label: `${scene.name} · Casambi` })),
  ];
}

/** Splits a `type:id` scene option value into a control target. */
export function parseSceneTarget(value: string): { targetType: "scene" | "local_scene"; targetId: number } {
  const [type, id] = value.split(":");
  return { targetType: type === "scene" ? "scene" : "local_scene", targetId: Number(id) };
}
