import type { LightingSnapshot } from "./mapping";

/** Test data for the HomeKit tests. */
const dimmer = [{ type: "dimmer", min: 0, max: 255, readOnly: false }];
const unit = (id: number, options: { capabilities?: Array<{ type: string; min?: number; max?: number; readOnly: boolean }>; roomId?: number; dimmer?: number | null; on?: boolean; online?: boolean } = {}) => ({
  id, uuid: `uuid-${id}`, address: `a${id}`, name: `Lamp ${id}`, capabilities: options.capabilities ?? dimmer, ...(options.roomId ? { roomId: options.roomId } : {}),
  state: { dimmer: options.dimmer === undefined ? 255 : options.dimmer, on: options.on ?? true, online: options.online ?? true, sensors: [] },
});

/** Lamps 1 and 2 dim and sit in room 1 and group 7, lamp 3 only switches, unit 4 is a wall switch in group 7. */
export function fixture(overrides: Partial<LightingSnapshot> = {}): LightingSnapshot {
  return {
    connected: true, network: { id: "net", name: "Home" },
    units: [unit(1, { roomId: 1 }), unit(2, { roomId: 1, dimmer: 128 }), unit(3, { capabilities: [{ type: "onoff", readOnly: false }], dimmer: null, on: false }), unit(4, { capabilities: [{ type: "button", readOnly: true }], roomId: 1 })],
    groups: [{ id: 7, name: "Eiland (keuken)", unitIds: [1, 2, 4] }, { id: 8, name: "Switches", unitIds: [4] }],
    rooms: [{ id: 1, name: "Woonkamer", sortOrder: 0, defaultBrightnessPercent: 100 }, { id: 2, name: "Empty", sortOrder: 1, defaultBrightnessPercent: 100 }],
    ...overrides,
  };
}
