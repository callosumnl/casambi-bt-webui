import { EventHub } from "../events";
import { CasambiConfig, LightSceneRecord, LocalStore, SceneLamp, SceneScope } from "../store";
import { controlRequestSchema, isLampUnit, type BridgeEvent, type ControlRequest, type NetworkSnapshot, type SwitchPress } from "./types";
import { JsonLineCasambiBridge, type WorkerState } from "./bridge";

/** Operations that set an absolute value, so a newer queued value can safely replace an unsent older one. */
const COALESCIBLE_OPERATIONS = new Set(["set_level", "set_temperature", "set_color", "set_white", "set_vertical", "set_slider", "set_xy"]);
/** Automatic reconnect delays: 15 s, 30 s, 60 s, … capped at 5 minutes. */
const RECONNECT_BASE_MS = 15_000;
const RECONNECT_MAX_MS = 300_000;
const SWITCH_ACTIVITY_LIMIT = 50;
const DIAGNOSTIC_LIMIT = 600;

/**
 * Shortens worker stderr for the audit log. A Python traceback puts the actual exception on its last
 * line, so a long multi-line message keeps its first line (the log message) and its tail, not its head.
 */
export function summarizeDiagnostic(detail: string, limit = DIAGNOSTIC_LIMIT): string {
  if (detail.length <= limit) return detail;
  const firstLine = detail.split("\n", 1)[0].slice(0, 160);
  return `${firstLine}\n…\n${detail.slice(-(limit - firstLine.length - 3))}`;
}
export type TimedSwitchPress = SwitchPress & { at: string };

/** What the service is doing about the Casambi connection, shown to users so a slow connect or retry is visible. */
export type ConnectionStatus =
  | { phase: "idle" }
  | { phase: "connecting"; attempt: number }
  | { phase: "connected" }
  | { phase: "retrying"; attempt: number; nextRetryAt: string; lastError: string }
  | { phase: "failed"; lastError: string };
type ServiceSnapshot = NetworkSnapshot & { rooms: ReturnType<LocalStore["listRooms"]>; connection: ConnectionStatus };

/** Normalizes bridge events, overlays local room metadata, and applies every control safely. */
export class CasambiService {
  private lastSnapshot: NetworkSnapshot = { connected: false, network: null, units: [], groups: [], scenes: [], updatedAt: new Date().toISOString() };
  private pollTimer: NodeJS.Timeout | null = null;
  private pollFailures = 0;
  /** True while the network should be connected: set by a connect intent, cleared by a manual disconnect. */
  private wantConnected = false;
  private connecting = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private connectionStatus: ConnectionStatus = { phase: "idle" };
  private readonly switchActivity: TimedSwitchPress[] = [];
  private readonly switchListeners: Array<(press: TimedSwitchPress) => void> = [];

  public constructor(private readonly store: LocalStore, private readonly bridge: JsonLineCasambiBridge, private readonly events: EventHub) {
    this.bridge.on("event", (event: BridgeEvent) => this.handleBridgeEvent(event));
    this.bridge.on("diagnostic", (detail: string) => this.store.audit("bridge", "bridge.diagnostic", { detail: summarizeDiagnostic(detail) }));
  }

  /** Starts supervision and conditionally reconnects only when local settings are complete. */
  public async initialize(): Promise<void> {
    this.bridge.start();
    const config = this.store.getCasambiConfig();
    if (config.networkAddress && config.networkPassword) {
      // Not awaited: a Casambi connect can take up to a minute and must not delay the HTTP server. The bridge queue still orders later commands behind it.
      this.wantConnected = true;
      void this.autoConnect("startup");
    }
    this.configurePolling();
  }

  /**
   * The last known network state, without waiting on the Bluetooth queue. It is kept current by
   * connects, controls, unit state events, disconnect events, and polling.
   */
  public cachedSnapshot(): ServiceSnapshot {
    return { ...this.withMetadata(this.lastSnapshot), rooms: this.store.listRooms(), connection: this.connectionStatus };
  }

  /** Returns a fresh snapshot from the bridge (queued behind any running command) with locally managed names and rooms. */
  public async snapshot(): Promise<ServiceSnapshot> {
    try { this.lastSnapshot = await this.bridge.snapshot(); } catch { /* The cached disconnected snapshot remains usable for status display. */ }
    return this.cachedSnapshot();
  }

  /** Most recent switch messages first, including raw activity, so an administrator can identify a switch by pressing it. */
  public recentSwitchActivity(): TimedSwitchPress[] { return [...this.switchActivity]; }

  /** Registers a handler for every reported switch message; handlers must filter on `trigger` themselves. */
  public onSwitchPress(listener: (press: TimedSwitchPress) => void): void { this.switchListeners.push(listener); }

  /** The Python worker's state as seen by its supervisor; answers even when the worker is stuck. */
  public workerState(): WorkerState { return this.bridge.state(); }

  /** Restarts (or starts) the Python worker. If the network should be connected, the reconnect loop takes over. */
  public restartWorker(actor: string): WorkerState {
    this.store.audit(actor, "bridge.worker_restart_requested", {});
    // Drop a pending long backoff so the restart's "unavailable" event schedules a prompt (15 s) reconnect.
    if (this.wantConnected) this.cancelReconnect();
    this.bridge.restart();
    return this.bridge.state();
  }

  /** Discovers nearby Casambi networks using the actual Bluetooth adapter. */
  public discover(): Promise<Array<{ address: string }>> { return this.bridge.execute("discover"); }

  /** Manual connect: takes over from any pending automatic retry. A failure is reported to the caller and not retried. */
  public async connect(): Promise<NetworkSnapshot> {
    this.cancelReconnect();
    this.wantConnected = true;
    const startedAt = Date.now();
    try {
      const snapshot = await this.connectOnce();
      this.store.audit("bridge", "bridge.connected", { reason: "manual", attempt: 1, durationMs: Date.now() - startedAt });
      return snapshot;
    } catch (error) {
      this.store.audit("bridge", "bridge.connect_failed", { message: this.message(error), durationMs: Date.now() - startedAt });
      throw error;
    }
  }

  /** Connects from encrypted persisted credentials. Upstream requires address and network password. */
  private async connectOnce(): Promise<NetworkSnapshot> {
    const config = this.store.getCasambiConfig();
    if (!config.networkAddress || !config.networkPassword) throw new Error("Network address and network password must be configured before connecting.");
    const { solarLatitude: _solarLatitude, solarLongitude: _solarLongitude, ...bridgeConfig } = config;
    this.connecting = true;
    this.setConnectionStatus({ phase: "connecting", attempt: this.reconnectAttempt + 1 });
    try { this.lastSnapshot = await this.bridge.execute<NetworkSnapshot>("configure", bridgeConfig as unknown as Record<string, unknown>); }
    catch (error) { this.setConnectionStatus({ phase: "failed", lastError: this.message(error) }); throw error; }
    finally { this.connecting = false; }
    this.reconnectAttempt = 0;
    this.setConnectionStatus({ phase: "connected" });
    this.events.publish("network.snapshot", this.withMetadata(this.lastSnapshot));
    return this.lastSnapshot;
  }

  /** Connects without a user present (startup or after a dropped link), retrying with capped backoff until it succeeds. */
  private async autoConnect(reason: "startup" | "reconnect"): Promise<void> {
    const attempt = this.reconnectAttempt + 1;
    const startedAt = Date.now();
    try {
      await this.connectOnce();
      this.store.audit("bridge", "bridge.connected", { reason, attempt, durationMs: Date.now() - startedAt });
    } catch (error) {
      const message = this.message(error);
      this.store.audit("bridge", reason === "startup" ? "bridge.startup_connect_failed" : "bridge.reconnect_failed", { message, attempt, durationMs: Date.now() - startedAt });
      // A rejected password or incomplete settings will not fix themselves; wait for an administrator instead of retrying forever.
      if (message.startsWith("AuthenticationError") || message.includes("must be configured")) return;
      this.scheduleReconnect(reason, message);
    }
  }

  private scheduleReconnect(reason: "startup" | "reconnect", lastError: string): void {
    if (this.reconnectTimer || this.connecting || !this.wantConnected) return;
    const delayMs = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.reconnectAttempt++);
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; if (this.wantConnected) void this.autoConnect(reason); }, delayMs);
    this.reconnectTimer.unref();
    this.setConnectionStatus({ phase: "retrying", attempt: this.reconnectAttempt, nextRetryAt: new Date(Date.now() + delayMs).toISOString(), lastError });
  }

  private setConnectionStatus(status: ConnectionStatus): void {
    this.connectionStatus = status;
    this.events.publish("connection.status", status);
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
  }

  /** Disconnects Bluetooth without losing locally managed configuration. */
  public async disconnect(): Promise<NetworkSnapshot> {
    this.wantConnected = false;
    this.cancelReconnect();
    this.lastSnapshot = await this.bridge.execute<NetworkSnapshot>("disconnect");
    this.setConnectionStatus({ phase: "idle" });
    this.events.publish("network.snapshot", this.withMetadata(this.lastSnapshot));
    return this.lastSnapshot;
  }

  /** Saves local settings. Secrets remain encrypted and omitted fields preserve current values. */
  public saveConfiguration(input: Partial<CasambiConfig>): void {
    const existing = this.store.getCasambiConfig();
    this.store.saveCasambiConfig({ ...existing, ...Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) });
    this.configurePolling();
    // A changed address, password, or adapter only takes effect on a new connection; reconnect if one is wanted.
    const next = this.store.getCasambiConfig();
    const changed = (["networkAddress", "networkPassword", "apiKey", "btAdapter", "forceOffline"] as const).some(key => existing[key] !== next[key]);
    if (changed && this.wantConnected && next.networkAddress && next.networkPassword) void this.connect().catch(() => { /* connect() audits and reports the failure itself. */ });
  }

  /** Applies a control command to its actual Casambi target, expanding local room membership first. */
  public async control(input: ControlRequest, actor: string): Promise<NetworkSnapshot> {
    const command = controlRequestSchema.parse(input);
    if (command.targetType === "local_scene") return this.applyLightScene(Number(command.targetId), actor, command.fadeDurationMs ?? 0);
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
      // A Casambi group with exactly the room's lamps takes one BLE command instead of one per lamp.
      const roomUnits = new Set(unitIds);
      const group = this.lastSnapshot.groups.find(candidate => candidate.unitIds.length === roomUnits.size && candidate.unitIds.every(unitId => roomUnits.has(unitId)));
      if (group) this.lastSnapshot = await this.runControl({ ...command, targetType: "group", targetId: group.id });
      else {
        for (const unitId of unitIds) await this.runControl({ ...command, targetType: "unit", targetId: unitId });
        this.lastSnapshot = await this.bridge.snapshot();
      }
    } else {
      this.lastSnapshot = await this.runControl(command);
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
    // Only lamps can be dimmed; a switch or sensor in the target would make the worker reject a step mid-fade.
    const lamps = new Set(snapshot.units.filter(isLampUnit).map(unit => unit.id));
    const unitIds = this.targetUnitIds(command, snapshot).filter(unitId => lamps.has(unitId));
    if (unitIds.length === 0) throw new Error("The control target has no assigned lamps.");
    await this.fadeUnits(new Map(unitIds.map(unitId => [unitId, targetLevel])), command.fadeDurationMs || 0, snapshot);
  }

  /** Steps each unit from its current level to its own target level in bounded 200 ms increments. */
  private async fadeUnits(targets: Map<number, number>, fadeDurationMs: number, snapshot: NetworkSnapshot): Promise<void> {
    const startLevels = new Map(snapshot.units.map(unit => [unit.id, unit.state.dimmer ?? (unit.state.on ? 255 : 0)]));
    const steps = Math.max(1, Math.min(60, Math.ceil(fadeDurationMs / 200)));
    for (let step = 1; step <= steps; step += 1) {
      for (const [unitId, targetLevel] of Array.from(targets)) {
        const start = startLevels.get(unitId) ?? 0;
        const level = Math.round(start + ((targetLevel - start) * step) / steps);
        await this.bridge.execute("control", { targetType: "unit", targetId: unitId, operation: "set_level", value: level });
      }
      if (step < steps) await new Promise(resolve => setTimeout(resolve, 200));
    }
    this.lastSnapshot = await this.bridge.snapshot();
  }

  /** Saves the current setting of a group, room, or the whole network as a named scene. */
  public captureLightScene(name: string, scope: SceneScope): LightSceneRecord {
    return this.store.createLightScene(name, scope, this.captureSceneLamps(scope));
  }

  /** Overwrites a scene with its scope's current setting, keeping its name. */
  public recaptureLightScene(id: number): LightSceneRecord {
    const scene = this.store.getLightScene(id);
    if (!scene) throw new Error("Scene does not exist.");
    return this.store.updateLightScene(id, { lamps: this.captureSceneLamps(scene.scope) });
  }

  /** Restores every lamp of a scene: colour temperature first, then brightness, optionally as one smooth fade. */
  public async applyLightScene(id: number, actor: string, fadeDurationMs = 0): Promise<NetworkSnapshot> {
    const scene = this.store.getLightScene(id);
    if (!scene) throw new Error("Scene does not exist.");
    for (const lamp of scene.lamps) {
      if (lamp.temperature !== null && lamp.level > 0) await this.runControl({ targetType: "unit", targetId: lamp.unitId, operation: "set_temperature", value: lamp.temperature });
    }
    if (fadeDurationMs > 0) await this.fadeUnits(new Map(scene.lamps.map(lamp => [lamp.unitId, lamp.level])), fadeDurationMs, this.cachedSnapshot());
    else {
      for (const lamp of scene.lamps) await this.runControl({ targetType: "unit", targetId: lamp.unitId, operation: "set_level", value: lamp.level });
      this.lastSnapshot = await this.bridge.snapshot();
    }
    this.store.audit(actor, "lighting.scene_applied", { sceneId: id, fadeDurationMs });
    const snapshot = this.withMetadata(this.lastSnapshot);
    this.events.publish("network.snapshot", snapshot);
    return snapshot;
  }

  private captureSceneLamps(scope: SceneScope): SceneLamp[] {
    const scoped = new Set(this.targetUnitIds({ targetType: scope.type, targetId: scope.id, operation: "on" }, this.lastSnapshot));
    const lamps = this.lastSnapshot.units.filter(unit => scoped.has(unit.id) && isLampUnit(unit)).map(unit => ({
      unitId: unit.id,
      level: unit.state.on ? unit.state.dimmer ?? 255 : 0,
      temperature: unit.capabilities.some(capability => capability.type === "temperature") ? unit.state.temperature ?? null : null,
    }));
    if (lamps.length === 0) throw new Error("At least one connected lamp is required for a scene.");
    return lamps;
  }

  /** Sends one control command, letting a newer absolute value replace an unsent older one for the same target. */
  private runControl(command: ControlRequest): Promise<NetworkSnapshot> {
    const payload = command as unknown as Record<string, unknown>;
    if (!COALESCIBLE_OPERATIONS.has(command.operation)) return this.bridge.execute<NetworkSnapshot>("control", payload);
    return this.bridge.executeLatest<NetworkSnapshot>(`${command.targetType}:${command.targetId ?? ""}:${command.operation}`, "control", payload);
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
    } else if (event.type === "switch") {
      const press: TimedSwitchPress = { ...event.press, at: new Date().toISOString() };
      this.switchActivity.unshift(press);
      this.switchActivity.splice(SWITCH_ACTIVITY_LIMIT);
      // Only real triggers are audited; raw type 0x08 activity would double every press.
      if (press.trigger) this.store.audit("switch", "switch.pressed", { unitId: press.unitId, button: press.button, trigger: press.trigger });
      this.events.publish("switch", press);
      for (const listener of this.switchListeners) listener(press);
    } else {
      if (event.type === "bridge" && (event.state === "disconnected" || event.state === "unavailable")) {
        this.lastSnapshot = { ...this.lastSnapshot, connected: false, updatedAt: new Date().toISOString() };
        // Ignore the disconnect a (re)connect performs itself; otherwise reconnect an unexpected drop or worker restart.
        if (!this.connecting && this.wantConnected) {
          this.store.audit("bridge", "bridge.connection_lost", { state: event.state });
          this.scheduleReconnect("reconnect", "The Bluetooth connection was lost.");
        }
      }
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
