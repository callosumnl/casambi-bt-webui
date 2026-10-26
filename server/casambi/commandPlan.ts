import { isLampUnit, NetworkSnapshot } from "./types";

/** A Casambi target that one Bluetooth command can address. */
export type PlannedTarget = { targetType: "network"; targetId: null } | { targetType: "group" | "unit"; targetId: number };

/**
 * The fewest Bluetooth commands that give exactly `unitIds` the same setting: one network command when they are
 * all the lamps, otherwise every Casambi group whose lamps all belong to the set (largest first, without overlap),
 * and single units for the rest. Each command is flooded through the Casambi mesh, so a group command costs one
 * write where per-lamp commands cost one write per lamp. Non-lamp group members (switches, sensors) ignore light
 * commands, so they do not stop a group from being used.
 */
export function planTargets(unitIds: Iterable<number>, snapshot: Pick<NetworkSnapshot, "units" | "groups">): PlannedTarget[] {
  const wanted = new Set(unitIds);
  if (wanted.size === 0) return [];
  const lamps = new Set(snapshot.units.filter(isLampUnit).map(unit => unit.id));
  if (wanted.size > 1 && lamps.size === wanted.size && Array.from(lamps).every(id => wanted.has(id))) return [{ targetType: "network", targetId: null }];
  const remaining = new Set(wanted);
  const plan: PlannedTarget[] = [];
  const groups = snapshot.groups
    .map(group => ({ id: group.id, lamps: group.unitIds.filter(id => lamps.has(id)) }))
    .filter(group => group.lamps.length > 1 && group.lamps.every(id => wanted.has(id)))
    .sort((left, right) => right.lamps.length - left.lamps.length || left.id - right.id);
  for (const group of groups) {
    if (!group.lamps.every(id => remaining.has(id))) continue;
    plan.push({ targetType: "group", targetId: group.id });
    for (const id of group.lamps) remaining.delete(id);
  }
  for (const id of Array.from(remaining)) plan.push({ targetType: "unit", targetId: id });
  return plan;
}

/** Splits lamps by the value they should get, so each set can be planned as shared commands. */
export function bucketBy<T>(entries: Iterable<[number, T]>, key: (value: T) => string): Array<{ value: T; unitIds: number[] }> {
  const buckets = new Map<string, { value: T; unitIds: number[] }>();
  for (const [unitId, value] of Array.from(entries)) {
    const bucketKey = key(value);
    const bucket = buckets.get(bucketKey);
    if (bucket) bucket.unitIds.push(unitId);
    else buckets.set(bucketKey, { value, unitIds: [unitId] });
  }
  return Array.from(buckets.values());
}
