import type { Device, NetworkSnapshot } from "./localApi";

/** Creates the deterministic, non-persistent network shown to anonymous Demo visitors. */
export function createDemoNetwork(): NetworkSnapshot {
  return {
    connected: true,
    network: { id: "demo-grid", name: "Demo Gallery // Simulated" },
    units: [
      device(101, "Aurora pendant", "Gallery", 188, 3400, 520, "lux"),
      device(102, "North wallwash", "Gallery", 132, 3000, 385, "lux"),
      device(103, "Studio track", "Studio", 210, 4000, 610, "lux"),
    ],
    groups: [{ id: 201, name: "Gallery lighting", unitIds: [101, 102] }, { id: 202, name: "All demo lamps", unitIds: [101, 102, 103] }],
    scenes: [{ id: 301, name: "Gallery welcome" }, { id: 302, name: "Focus work" }, { id: 303, name: "Night close" }],
    rooms: [{ id: 401, name: "Gallery", sortOrder: 1 }, { id: 402, name: "Studio", sortOrder: 2 }],
    updatedAt: new Date().toISOString(),
  };
}

function device(id: number, name: string, roomName: string, dimmer: number, temperature: number, sensorValue: number, unit: string): Device {
  return { id, name, address: `DE:MO:00:00:00:${id - 100}`, model: "Simulated fixture", roomId: roomName === "Gallery" ? 401 : 402, roomName, capabilities: [{ type: "dimmer", min: 0, max: 255, readOnly: false }, { type: "temperature", min: 2700, max: 6500, readOnly: false }, { type: "onoff", readOnly: false }], state: { dimmer, temperature, sensors: [{ label: "Ambient illuminance", value: sensorValue, unit }], on: true, online: true } };
}

type DemoCommand = { targetType?: string; targetId?: number | string | null; operation?: string; value?: unknown };

/** Applies a dashboard command to a copy of the demo snapshot without any network request. */
export function applyDemoCommand(snapshot: NetworkSnapshot, input: unknown): NetworkSnapshot {
  const command = input as DemoCommand;
  const targetId = Number(command.targetId);
  const selected = command.targetType === "network" ? snapshot.units.map(unit => unit.id)
    : command.targetType === "group" ? snapshot.groups.find(group => group.id === targetId)?.unitIds ?? []
      : command.targetType === "room" ? snapshot.units.filter(unit => unit.roomId === targetId).map(unit => unit.id)
        : command.targetType === "unit" ? [targetId] : [];
  let units = snapshot.units;
  if (command.targetType === "scene") units = activateScene(snapshot.units, targetId);
  else if (selected.length) units = snapshot.units.map(unit => selected.includes(unit.id) ? applyToUnit(unit, command) : unit);
  return { ...snapshot, units, updatedAt: new Date().toISOString() };
}

function applyToUnit(unit: Device, command: DemoCommand): Device {
  const value = Number(command.value);
  const state = command.operation === "simulate_sensor" ? { ...unit.state, sensors: unit.state.sensors.map(sensor => ({ ...sensor, value: sensor.value === null ? 100 : (sensor.value + 37) % 1000 })) }
    : command.operation === "on" ? { ...unit.state, on: true, dimmer: unit.state.dimmer || 180 }
    : command.operation === "off" ? { ...unit.state, on: false, dimmer: 0 }
      : command.operation === "set_level" ? { ...unit.state, dimmer: Math.max(0, Math.min(255, value)), on: value > 0 }
        : command.operation === "set_temperature" ? { ...unit.state, temperature: Math.max(2700, Math.min(6500, value)) }
          : unit.state;
  return { ...unit, state };
}

function activateScene(units: Device[], sceneId: number): Device[] {
  const profiles: Record<number, { level: number; temperature: number }> = { 301: { level: 180, temperature: 3200 }, 302: { level: 230, temperature: 4300 }, 303: { level: 35, temperature: 2700 } };
  const profile = profiles[sceneId] ?? profiles[301];
  return units.map(unit => ({ ...unit, state: { ...unit.state, dimmer: profile.level, temperature: profile.temperature, on: profile.level > 0 } }));
}
