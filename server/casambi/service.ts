import { EventHub } from "../events";
import { CasambiConfig, LocalStore } from "../store";
import { controlRequestSchema, type BridgeEvent, type ControlRequest, type NetworkSnapshot } from "./types";
import { JsonLineCasambiBridge } from "./bridge";

/** Normalizes bridge events, overlays local room metadata, and applies every control safely. */
export class CasambiService {
  private lastSnapshot: NetworkSnapshot = { connected: false, network: null, units: [], groups: [], scenes: [], updatedAt: new Date().toISOString() };
  private pollTimer: NodeJS.Timeout | null = null;
  private pollFailures = 0;

  public constructor(private readonly store: LocalStore, private readonly bridge: JsonLineCasambiBridge, private readonly events: EventHub) {
    this.bridge.on("event", (event: BridgeEvent) => this.handleBridgeEvent(event));
    this.bridge.on("diagnostic", (detail: string) => this.store.audit("bridge", "bridge.diagnostic", { detail: detail.slice(0, 500) }));
  }

  /** Starts supervision and conditionally reconnects only when local settings are complete. */
  public async initialize(): Promise<void> {
    this.bridge.start();
    const config = this.store.getCasambiConfig();
    if (config.networkAddress && config.networkPassword) {
      try { await this.connect(); } catch (error) { this.store.audit("bridge", "bridge.startup_connect_failed", { message: this.message(error) }); }
    }
    this.configurePolling();
  }

  /** Returns a current snapshot with locally managed names and rooms. */
  public async snapshot(): Promise<NetworkSnapshot & { rooms: ReturnType<LocalStore["listRooms"]> }> {
    try { this.lastSnapshot = await this.bridge.snapshot(); } catch { /* The cached disconnected snapshot remains usable for status display. */ }
    return { ...this.withMetadata(this.lastSnapshot), rooms: this.store.listRooms() };
  }

  /** Discovers nearby Casambi networks using the actual Bluetooth adapter. */
  public discover(): Promise<Array<{ address: string }>> { return this.bridge.execute("discover"); }

  /** Connects from encrypted persisted credentials. Upstream requires address and network password. */
  public async connect(): Promise<NetworkSnapshot> {
    const config = this.store.getCasambiConfig();
    if (!config.networkAddress || !config.networkPassword) throw new Error("Network address and network password must be configured before connecting.");
    this.lastSnapshot = await this.bridge.execute<NetworkSnapshot>("configure", config as unknown as Record<string, unknown>);
    this.events.publish("network.snapshot", this.withMetadata(this.lastSnapshot));
    return this.lastSnapshot;
  }

  /** Disconnects Bluetooth without losing locally managed configuration. */
  public async disconnect(): Promise<NetworkSnapshot> {
    this.lastSnapshot = await this.bridge.execute<NetworkSnapshot>("disconnect");
    this.events.publish("network.snapshot", this.withMetadata(this.lastSnapshot));
    return this.lastSnapshot;
  }

  /** Saves local settings. Secrets remain encrypted and omitted fields preserve current values. */
  public saveConfiguration(input: Partial<CasambiConfig>): void {
    const existing = this.store.getCasambiConfig();
    this.store.saveCasambiConfig({ ...existing, ...Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) });
    this.configurePolling();
  }

  /** Applies a control command to its actual Casambi target, expanding local room membership first. */
  public async control(input: ControlRequest, actor: string): Promise<NetworkSnapshot> {
    const command = controlRequestSchema.parse(input);
    if (command.fadeDurationMs && ["on", "off", "set_level"].includes(command.operation)) {
      await this.fadeToLevel(command);
      this.store.audit(actor, "lighting.control", { targetType: command.targetType, targetId: command.targetId ?? null, operation: command.operation, fadeDurationMs: command.fadeDurationMs });
      const faded = this.withMetadata(this.lastSnapshot);
      this.events.publish("network.snapshot", faded);
      return faded;
    }
    if (command.targetType === "room") {
      const roomId = Number(command.targetId);
      const unitIds = this.store.getUnitMetadata().filter(metadata => metadata.roomId === roomId).map(metadata => metadata.unitId);
      if (unitIds.length === 0) throw new Error("The room has no assigned lamps.");
      for (const unitId of unitIds) await this.bridge.execute("control", { ...command, targetType: "unit", targetId: unitId });
      this.lastSnapshot = await this.bridge.snapshot();
    } else {
      this.lastSnapshot = await this.bridge.execute<NetworkSnapshot>("control", command as unknown as Record<string, unknown>);
    }
    this.store.audit(actor, "lighting.control", { targetType: command.targetType, targetId: command.targetId ?? null, operation: command.operation });
    const snapshot = this.withMetadata(this.lastSnapshot);
    this.events.publish("network.snapshot", snapshot);
    return snapshot;
  }

  /** Applies a room's administrator-configured default brightness, optionally with a bounded smooth transition. */
  public async applyRoomPreset(roomId: number, actor: string, fadeDurationMs = 0): Promise<NetworkSnapshot> {
    const room = this.store.getRoom(roomId);
    if (!room) throw new Error("Room does not exist.");
    return this.control({ targetType: "room", targetId: room.id, operation: "set_level", value: Math.round((room.defaultBrightnessPercent / 100) * 255), ...(fadeDurationMs ? { fadeDurationMs } : {}) }, actor);
  }

  /** Uses bounded 200 ms software steps because upstream `setLevel(target, level)` has no duration argument. */
  private async fadeToLevel(command: ControlRequest): Promise<void> {
    if (command.targetType === "scene") throw new Error("Scenes cannot be faded by this bridge.");
    const snapshot = await this.snapshot();
    const targetLevel = command.operation === "off" ? 0 : command.operation === "on" ? 255 : Number(command.value);
    const unitIds = this.targetUnitIds(command, snapshot);
    if (unitIds.length === 0) throw new Error("The control target has no assigned lamps.");
    const startLevels = new Map(snapshot.units.map(unit => [unit.id, unit.state.dimmer ?? (unit.state.on ? 255 : 0)]));
    const steps = Math.max(1, Math.min(60, Math.ceil((command.fadeDurationMs || 0) / 200)));
    for (let step = 1; step <= steps; step += 1) {
      for (const unitId of unitIds) {
        const start = startLevels.get(unitId) ?? 0;
        const level = Math.round(start + ((targetLevel - start) * step) / steps);
        await this.bridge.execute("control", { targetType: "unit", targetId: unitId, operation: "set_level", value: level });
      }
      if (step < steps) await new Promise(resolve => setTimeout(resolve, 200));
    }
    this.lastSnapshot = await this.bridge.snapshot();
  }

  private targetUnitIds(command: ControlRequest, snapshot: NetworkSnapshot): number[] {
    if (command.targetType === "unit") return [Number(command.targetId)];
    if (command.targetType === "group") return snapshot.groups.find(group => group.id === Number(command.targetId))?.unitIds ?? [];
    if (command.targetType === "network") return snapshot.units.map(unit => unit.id);
    if (command.targetType === "room") return this.store.getUnitMetadata().filter(metadata => metadata.roomId === Number(command.targetId)).map(metadata => metadata.unitId);
    return [];
  }

  private handleBridgeEvent(event: BridgeEvent): void {
    if (event.type === "unit.state") {
      const unitIndex = this.lastSnapshot.units.findIndex(unit => unit.id === event.unit.id);
      if (unitIndex >= 0) this.lastSnapshot.units[unitIndex] = event.unit;
      else this.lastSnapshot.units.push(event.unit);
      this.lastSnapshot.updatedAt = new Date().toISOString();
      this.events.publish("unit.state", this.withMetadata({ ...this.lastSnapshot, units: [event.unit], groups: [], scenes: [] }).units[0]);
    } else {
      this.events.publish(event.type, event);
    }
  }

  /** Schedules bounded snapshot refreshes without overlapping Casambi Bluetooth requests. */
  private configurePolling(): void {
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null; }
    const config = this.store.getCasambiConfig();
    if (!config.pollingEnabled) return;
    const poll = async () => {
      try {
        this.lastSnapshot = await this.bridge.snapshot();
        this.pollFailures = 0;
        this.events.publish("network.snapshot", this.withMetadata(this.lastSnapshot));
      } catch (error) {
        this.pollFailures += 1;
        this.store.audit("bridge", "bridge.poll_failed", { failures: this.pollFailures, message: this.message(error) });
      } finally {
        const backoffSeconds = Math.min(300, config.pollingIntervalSeconds * 2 ** Math.min(this.pollFailures, 3));
        this.pollTimer = setTimeout(() => void poll(), backoffSeconds * 1000);
        this.pollTimer.unref();
      }
    };
    this.pollTimer = setTimeout(() => void poll(), config.pollingIntervalSeconds * 1000);
    this.pollTimer.unref();
  }

  private withMetadata(snapshot: NetworkSnapshot): NetworkSnapshot {
    const metadata = new Map(this.store.getUnitMetadata().map(item => [item.unitId, item]));
    const rooms = new Map(this.store.listRooms().map(room => [room.id, room]));
    return {
      ...snapshot,
      units: snapshot.units.map(unit => {
        const local = metadata.get(unit.id);
        const room = local?.roomId ? rooms.get(local.roomId) : undefined;
        return { ...unit, name: local?.customName || unit.name, ...(room ? { roomId: room.id, roomName: room.name } : {}) };
      }),
    };
  }

  private message(error: unknown): string { return error instanceof Error ? error.message : "Unknown error."; }
}
