import { getPosition, getTimes } from "suncalc";
import type { CasambiService } from "./casambi/service";
import { isLampUnit, type UnitSnapshot } from "./casambi/types";
import type { LocalStore } from "./store";

export type DaylightSettings = { roomIds: number[]; warmKelvin: number; coolKelvin: number };
export type DaylightRoomState = "on" | "paused" | "idle";
export type DaylightStatus = DaylightSettings & {
  /** False until a sunrise and sunset location is set; the rhythm waits for it. */
  hasLocation: boolean;
  /** What the lamps should show now; null without a location. */
  kelvin: number | null;
  rooms: Array<{ id: number; name: string; enabled: boolean; state: DaylightRoomState }>;
};

const DEFAULTS: DaylightSettings = { roomIds: [], warmKelvin: 2700, coolKelvin: 5000 };
const TICK_MS = 2 * 60_000;
/** After a state change (a lamp switched on), wait briefly so a burst of events gives one adjustment. */
const SETTLE_MS = 2_000;
/** Differences below this are not visible and Casambi rounds temperatures anyway. */
const STEP_KELVIN = 50;
/** A lamp further than this from what the rhythm sent was changed by someone else. */
const MANUAL_KELVIN = 150;

/**
 * The colour temperature for a moment: warm before sunrise and after sunset, coolest at solar noon, following the
 * sun's arc in between. Where the sun does not rise or set that day, its height decides.
 */
export function daylightKelvin(now: Date, location: { latitude: number; longitude: number }, warm: number, cool: number): number {
  const times = getTimes(now, location.latitude, location.longitude);
  const rise = times.sunrise?.getTime(), set = times.sunset?.getTime();
  if (!Number.isFinite(rise) || !Number.isFinite(set) || set! <= rise!) return getPosition(now, location.latitude, location.longitude).altitude > 0 ? cool : warm;
  const progress = (now.getTime() - rise!) / (set! - rise!);
  if (progress <= 0 || progress >= 1) return warm;
  return Math.round(warm + (cool - warm) * Math.sin(Math.PI * progress));
}

type Lighting = Pick<CasambiService, "cachedSnapshot" | "adjustTemperature" | "wakeUpActive" | "onStateChange">;

/**
 * The daylight rhythm: in the rooms an administrator chose, lamps with a colour temperature that are on follow the
 * day, from warm at night to cool at midday. Someone changing a lamp's colour or temperature pauses the room until
 * all its lamps are off; a wake-up light pauses all rooms while it runs. Adjustments are not audited one by one.
 */
export class Daylight {
  private timer: NodeJS.Timeout | null = null;
  private settle: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private readonly paused = new Set<number>();
  /** What the rhythm last sent each lamp, to tell its own changes from someone else's. */
  private readonly sent = new Map<number, number>();
  private readonly wasOn = new Map<number, boolean>();

  public constructor(private readonly store: LocalStore, private readonly lighting: Lighting, private readonly now: () => Date = () => new Date()) {}

  public settings(): DaylightSettings {
    try {
      const stored = JSON.parse(this.store.appSetting("daylight.settings") ?? "{}") as Partial<DaylightSettings>;
      return { ...DEFAULTS, ...stored, roomIds: Array.isArray(stored.roomIds) ? stored.roomIds.filter(Number.isInteger) : [] };
    } catch { return { ...DEFAULTS }; }
  }

  public status(): DaylightStatus {
    const settings = this.settings();
    const location = this.location();
    const snapshot = this.lighting.cachedSnapshot();
    return {
      ...settings, hasLocation: Boolean(location),
      kelvin: location ? daylightKelvin(this.now(), location, settings.warmKelvin, settings.coolKelvin) : null,
      rooms: this.store.listRooms().map(room => {
        const enabled = settings.roomIds.includes(room.id);
        const on = this.roomLamps(room.id, snapshot.units).some(unit => unit.state.on);
        return { id: room.id, name: room.name, enabled, state: !enabled || !on ? "idle" : this.paused.has(room.id) ? "paused" : "on" };
      }),
    };
  }

  public async update(input: DaylightSettings, actor: string): Promise<DaylightStatus> {
    if (input.coolKelvin < input.warmKelvin) throw new Error("The midday colour temperature must not be warmer than the night one.");
    const rooms = new Set(this.store.listRooms().map(room => room.id));
    const saved = { ...input, roomIds: Array.from(new Set(input.roomIds)).filter(id => rooms.has(id)) };
    this.store.setAppSetting("daylight.settings", JSON.stringify(saved));
    this.store.audit(actor, "daylight.settings_changed", { rooms: saved.roomIds.length, warmKelvin: saved.warmKelvin, coolKelvin: saved.coolKelvin });
    for (const roomId of Array.from(this.paused)) if (!saved.roomIds.includes(roomId)) this.paused.delete(roomId);
    await this.tick();
    return this.status();
  }

  /** Lets a paused room follow the day again at once. */
  public async resume(roomId: number, actor: string): Promise<DaylightStatus> {
    if (this.paused.delete(roomId)) this.store.audit(actor, "daylight.resumed", { roomId });
    for (const unit of this.roomLamps(roomId, this.lighting.cachedSnapshot().units)) this.sent.delete(unit.id);
    await this.tick();
    return this.status();
  }

  public start(): void {
    this.lighting.onStateChange(() => {
      if (!this.timer || this.settle) return;
      this.settle = setTimeout(() => { this.settle = null; void this.tick(); }, SETTLE_MS);
      this.settle.unref();
    });
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
  }

  public stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.settle) clearTimeout(this.settle);
    this.timer = this.settle = null;
  }

  /** One adjustment of every chosen room; runs one at a time. Failures wait for the next tick. */
  public tick(): Promise<void> {
    this.running ??= this.adjust().catch(() => undefined).finally(() => { this.running = null; });
    return this.running;
  }

  private async adjust(): Promise<void> {
    const settings = this.settings();
    const location = this.location();
    const snapshot = this.lighting.cachedSnapshot();
    if (!settings.roomIds.length || !location || !snapshot.connected) return;
    const lampsOn = (units: UnitSnapshot[]) => units.filter(unit => unit.state.on && unit.state.online);
    if (this.lighting.wakeUpActive()) { this.remember(snapshot.units); return; }
    const kelvin = daylightKelvin(this.now(), location, settings.warmKelvin, settings.coolKelvin);
    const due: number[] = [];
    for (const roomId of settings.roomIds) {
      const lamps = this.roomLamps(roomId, snapshot.units);
      const on = lampsOn(lamps);
      if (!on.length) {
        // Everything off: the room follows the day again next time it is switched on.
        this.paused.delete(roomId);
        lamps.forEach(unit => this.sent.delete(unit.id));
        continue;
      }
      if (!this.paused.has(roomId) && on.some(unit => this.changedByOthers(unit))) {
        this.paused.add(roomId);
        this.store.audit("daylight", "daylight.paused", { roomId });
      }
      if (this.paused.has(roomId)) continue;
      // A lamp showing a colour (RGB or XY) was given one on purpose; it keeps it.
      due.push(...on.filter(unit => (unit.state.colorSource ?? "temperature") === "temperature" && Math.abs((unit.state.temperature ?? 0) - kelvin) >= STEP_KELVIN).map(unit => unit.id));
    }
    this.remember(snapshot.units);
    if (due.length) (await this.lighting.adjustTemperature(due, kelvin)).forEach((value, unitId) => this.sent.set(unitId, value));
  }

  /** A lamp that stayed on but no longer shows what the rhythm sent it. One that just came on is the rhythm's to set. */
  private changedByOthers(unit: UnitSnapshot): boolean {
    const sent = this.sent.get(unit.id);
    if (sent === undefined || !this.wasOn.get(unit.id)) return false;
    if (unit.state.colorSource && unit.state.colorSource !== "temperature") return true;
    return unit.state.temperature != null && Math.abs(unit.state.temperature - sent) > MANUAL_KELVIN;
  }

  private remember(units: UnitSnapshot[]): void { for (const unit of units) this.wasOn.set(unit.id, unit.state.on && unit.state.online); }

  /** A room's lamps that take a colour temperature. */
  private roomLamps(roomId: number, units: UnitSnapshot[]): UnitSnapshot[] {
    const ids = new Set(this.store.getUnitMetadata().filter(item => item.roomId === roomId).map(item => item.unitId));
    return units.filter(unit => ids.has(unit.id) && isLampUnit(unit) && unit.capabilities.some(capability => capability.type === "temperature"));
  }

  private location(): { latitude: number; longitude: number } | null {
    const config = this.store.getCasambiConfig();
    return config.solarLatitude != null && config.solarLongitude != null ? { latitude: config.solarLatitude, longitude: config.solarLongitude } : null;
  }
}
