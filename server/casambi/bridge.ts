import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import { EventEmitter } from "events";
import { randomUUID } from "crypto";
import { existsSync } from "fs";
import { resolve } from "path";
import type { BridgeEvent, NetworkSnapshot } from "./types";

type BridgeResponse = { id: string; ok: true; result: unknown } | { id: string; ok: false; error: { code: string; message: string } };
type BridgeEnvelope = BridgeResponse | { event: BridgeEvent };

/**
 * Commands that legitimately outlast the default timeout. A connect runs a
 * 5 s BLE scan, several Casambi cloud requests, and a retrying BLE connect
 * plus key exchange; a discovery is a single 5 s scan.
 */
const LONG_COMMAND_TIMEOUTS_MS: Record<string, number> = { configure: 90_000, connect: 90_000, discover: 30_000 };
/** How long a worker restarted for not answering may take to disconnect and exit before it is killed. */
const FORCE_KILL_AFTER_MS = 8_000;
/** A worker line longer than this (far beyond any snapshot) is dropped instead of growing the buffer without bound. */
const MAX_LINE_CHARS = 4 * 1024 * 1024;
/** Commands waiting their turn beyond this are refused, so a flood of requests cannot hold up timers and switches for hours. */
const MAX_QUEUED_COMMANDS = 100;

/**
 * The worker script, found from this module instead of the working directory, so starting the server from
 * another folder cannot run a different script: it sits next to this file under tsx, and in server/casambi/
 * beside dist/ for the built app.
 */
export function workerScriptPath(moduleDirectory = import.meta.dirname): string {
  const candidates = [resolve(moduleDirectory, "casambi_worker.py"), resolve(moduleDirectory, "..", "server", "casambi", "casambi_worker.py")];
  return candidates.find(candidate => existsSync(candidate)) ?? candidates[0];
}

/**
 * The worker needs no server secrets (JWT secret, encryption key): it gets only what Python, BlueZ/D-Bus,
 * and its cache location need, so a compromised dependency in the Python process cannot read them.
 */
export function workerEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = /^(PATH|HOME|USER|LANG|LC_\w+|TZ|TMPDIR|NODE_ENV|VIRTUAL_ENV|PYTHON\w*|DBUS_\w+|XDG_\w+|CASAMBI_CACHE_PATH)$/;
  return { ...Object.fromEntries(Object.entries(source).filter(([name]) => allowed.test(name))), PYTHONUNBUFFERED: "1" };
}

/** Minimal child-process shape, kept small to enable deterministic bridge tests. */
export type BridgeChild = Pick<ChildProcessWithoutNullStreams, "stdin" | "stdout" | "stderr" | "on" | "kill" | "pid">;
/** Supervisor-side view of the worker, available even when the worker itself cannot answer. */
export type WorkerState = { running: boolean; pid: number | null; busy: { command: string; forMs: number } | null; lastAnswerAt: string | null; restarts: number };
export type BridgeChildFactory = () => BridgeChild;

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
};

export type BridgeOptions = {
  commandTimeoutMs?: number;
  mockMode?: boolean;
  createChild?: BridgeChildFactory;
};

/**
 * Supervises a JSON-lines Python worker. Commands are deliberately serialized,
 * avoiding overlapping Bluetooth writes to a single Casambi connection.
 */
export class JsonLineCasambiBridge extends EventEmitter {
  private child: BridgeChild | null = null;
  private buffer = "";
  /** Set while the rest of an oversized line is still arriving; it is dropped up to its line break. */
  private discardingLine = false;
  private readonly pending = new Map<string, PendingRequest>();
  private stopped = false;
  private restartAttempt = 0;
  /** Commands are serialized, so at most one is in flight at a time. */
  private inFlight: { command: string; startedAt: number } | null = null;
  private lastAnswerAt: number | null = null;
  private restarts = 0;
  private readonly commandTimeoutMs: number;
  private readonly createChild: BridgeChildFactory;
  private queue: Promise<unknown> = Promise.resolve();
  /** Commands queued but not yet started. */
  private queued = 0;
  /** The most recently queued coalescible command, while it has not been sent yet. */
  private coalescibleTail: { key: string; payload: Record<string, unknown>; result: Promise<unknown> } | null = null;

  public constructor(options: BridgeOptions = {}) {
    super();
    this.commandTimeoutMs = options.commandTimeoutMs ?? 12_000;
    const mockMode = options.mockMode ?? process.env.CASAMBI_MOCK_MODE === "true";
    this.createChild = options.createChild ?? (() => {
      const worker = workerScriptPath();
      return spawn(process.env.CASAMBI_PYTHON_COMMAND || "python3", [worker, ...(mockMode ? ["--mock"] : [])], {
        env: workerEnvironment(process.env),
        stdio: "pipe",
      });
    });
  }

  /** Starts the bridge worker if it is not already running. */
  public start(): void {
    if (this.child || this.stopped) return;
    this.emit("event", { type: "bridge", state: "starting" } satisfies BridgeEvent);
    // A partial line from a worker that died mid-write must not be glued to the new worker's first line.
    this.buffer = ""; this.discardingLine = false;
    const child = this.createChild();
    this.child = child;
    // Decode as a stream so a multi-byte character split across two pipe chunks stays intact.
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => this.consumeStdout(chunk.toString()));
    child.stderr.on("data", chunk => this.emit("diagnostic", chunk.toString().trim()));
    // A write racing the worker's exit fails with EPIPE; unhandled, that would crash Node.
    child.stdin.on("error", error => this.emit("diagnostic", `Worker stdin error: ${error.message}`));
    child.on("exit", () => this.handleExit());
    child.on("error", error => {
      this.handleFailure(error);
      // A spawn failure (ENOENT for a wrong CASAMBI_PYTHON_COMMAND) emits "error" but never "exit".
      if (child.pid === undefined && this.child === child) this.handleExit();
    });
  }

  /** Stops the Python worker and prevents automatic restart. */
  public stop(): void {
    this.stopped = true;
    this.child?.kill();
    this.child = null;
    this.rejectPending(new Error("Casambi bridge stopped."));
  }

  /** Serializes a command so the upstream BLE client receives ordered requests. */
  public execute<T = unknown>(command: string, payload: Record<string, unknown> = {}): Promise<T> {
    if (this.queued >= MAX_QUEUED_COMMANDS) return Promise.reject(new Error("The Casambi bridge is busy; try again in a moment."));
    this.queued += 1;
    const run = async () => { this.queued -= 1; return this.send<T>(command, payload); };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    this.coalescibleTail = null;
    return next;
  }

  /**
   * Like `execute`, but when the last queued command has the same `key` and has
   * not been sent yet, its payload is replaced instead of queueing another
   * command; both callers receive the result of the latest value. Only the tail
   * is merged, so ordering relative to any other command is preserved.
   */
  public executeLatest<T = unknown>(key: string, command: string, payload: Record<string, unknown>): Promise<T> {
    const tail = this.coalescibleTail;
    if (tail && tail.key === key) { tail.payload = payload; return tail.result as Promise<T>; }
    if (this.queued >= MAX_QUEUED_COMMANDS) return Promise.reject(new Error("The Casambi bridge is busy; try again in a moment."));
    this.queued += 1;
    const entry = { key, payload, result: Promise.resolve() as Promise<unknown> };
    const run = async () => { this.queued -= 1; if (this.coalescibleTail === entry) this.coalescibleTail = null; return this.send<T>(command, entry.payload); };
    const next = this.queue.then(run, run);
    entry.result = next;
    this.queue = next.catch(() => undefined);
    this.coalescibleTail = entry;
    return next;
  }

  /** What the worker is doing, read from the supervisor: it never waits on the worker or its queue. */
  public state(now = Date.now()): WorkerState {
    return {
      running: this.child !== null,
      pid: this.child?.pid ?? null,
      busy: this.inFlight ? { command: this.inFlight.command, forMs: now - this.inFlight.startedAt } : null,
      lastAnswerAt: this.lastAnswerAt === null ? null : new Date(this.lastAnswerAt).toISOString(),
      restarts: this.restarts,
    };
  }

  /** Administrator restart: ends the current worker the same safe way as the watchdog, or starts one if none is running. */
  public restart(): void {
    if (this.stopped) return;
    this.restartAttempt = 0;
    if (!this.child) { this.start(); return; }
    this.emit("diagnostic", "Casambi worker restart requested by an administrator.");
    this.terminate(this.child);
  }

  /** Returns the current normalized network snapshot. */
  public snapshot(): Promise<NetworkSnapshot> {
    return this.execute<NetworkSnapshot>("snapshot");
  }

  private send<T>(command: string, payload: Record<string, unknown>): Promise<T> {
    this.start();
    if (!this.child) return Promise.reject(new Error("Casambi bridge is not available."));
    const id = randomUUID();
    return new Promise<T>((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.inFlight = null;
        rejectRequest(new Error(`Casambi bridge command '${command}' timed out.`));
        this.restartUnresponsiveWorker(command);
      }, LONG_COMMAND_TIMEOUTS_MS[command] ?? this.commandTimeoutMs);
      this.pending.set(id, { resolve: value => resolveRequest(value as T), reject: rejectRequest, timer });
      this.inFlight = { command, startedAt: Date.now() };
      try {
        this.child?.stdin.write(`${JSON.stringify({ id, command, payload })}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        this.inFlight = null;
        rejectRequest(error instanceof Error ? error : new Error("Unable to write to Casambi bridge."));
      }
    });
  }

  private consumeStdout(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (this.discardingLine) this.discardingLine = false;
      else if (line) this.consumeLine(line);
      newline = this.buffer.indexOf("\n");
    }
    if (this.buffer.length > MAX_LINE_CHARS) {
      this.emit("diagnostic", `Dropped worker output: a line exceeded ${MAX_LINE_CHARS} characters.`);
      this.buffer = "";
      this.discardingLine = true;
    }
  }

  private consumeLine(line: string): void {
    let envelope: BridgeEnvelope;
    try {
      envelope = JSON.parse(line) as BridgeEnvelope;
    } catch {
      this.emit("diagnostic", `Ignored non-JSON worker output: ${line.slice(0, 180)}`);
      return;
    }
    if ("event" in envelope) {
      if (!isBridgeEvent(envelope.event)) { this.emit("diagnostic", `Ignored malformed worker event: ${line.slice(0, 180)}`); return; }
      this.restartAttempt = 0;
      this.emit("event", envelope.event);
      return;
    }
    if (typeof envelope !== "object" || envelope === null || typeof (envelope as { id?: unknown }).id !== "string") { this.emit("diagnostic", `Ignored malformed worker output: ${line.slice(0, 180)}`); return; }
    const request = this.pending.get(envelope.id);
    if (!request) return;
    clearTimeout(request.timer);
    this.pending.delete(envelope.id);
    this.inFlight = null;
    this.lastAnswerAt = Date.now();
    if (envelope.ok) {
      this.restartAttempt = 0;
      request.resolve(envelope.result);
    } else {
      request.reject(new Error(`${envelope.error.code}: ${envelope.error.message}`));
    }
  }

  /**
   * The worker handles one command at a time, so a command that outlives its timeout means the worker
   * is stuck on it, and every later command would time out too while the process stays alive. Restart
   * it instead: SIGTERM lets it release the BLE link, SIGKILL follows if it cannot exit. The normal
   * exit handling then restarts the worker, and the service reconnects.
   */
  private restartUnresponsiveWorker(command: string): void {
    const child = this.child;
    if (!child || this.stopped) return;
    this.emit("diagnostic", `Casambi worker did not answer '${command}' in time; restarting it.`);
    this.terminate(child);
  }

  private terminate(child: BridgeChild): void {
    child.kill("SIGTERM");
    setTimeout(() => { if (this.child === child) child.kill("SIGKILL"); }, FORCE_KILL_AFTER_MS).unref();
  }

  private handleFailure(error: Error): void {
    this.emit("diagnostic", error.message);
  }

  private handleExit(): void {
    this.child = null;
    this.inFlight = null;
    this.rejectPending(new Error("Casambi bridge terminated unexpectedly."));
    if (this.stopped) return;
    this.restarts += 1;
    this.emit("event", { type: "bridge", state: "unavailable", detail: "Python bridge exited; reconnecting." } satisfies BridgeEvent);
    const delay = Math.min(30_000, 1_000 * 2 ** this.restartAttempt++);
    setTimeout(() => this.start(), delay).unref();
  }

  private rejectPending(error: Error): void {
    for (const request of Array.from(this.pending.values())) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }
}

/**
 * Checks the structure the service relies on, so malformed worker output is dropped instead of breaking it.
 * Deliberately not the full unit schema: real hardware may report values that schema has never been checked against.
 */
export function isBridgeEvent(value: unknown): value is BridgeEvent {
  const event = value as Record<string, unknown> | null;
  if (typeof event !== "object" || event === null) return false;
  const isObject = (field: unknown): field is Record<string, unknown> => typeof field === "object" && field !== null;
  if (event.type === "bridge") return typeof event.state === "string";
  if (event.type === "unit.state") return isObject(event.unit) && typeof event.unit.id === "number" && isObject(event.unit.state) && Array.isArray(event.unit.capabilities);
  if (event.type === "switch") return isObject(event.press) && isObject(event.press.raw);
  return false;
}
