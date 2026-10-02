import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import { EventEmitter } from "events";
import { randomUUID } from "crypto";
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

/** Minimal child-process shape, kept small to enable deterministic bridge tests. */
export type BridgeChild = Pick<ChildProcessWithoutNullStreams, "stdin" | "stdout" | "stderr" | "on" | "kill">;
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
  private readonly pending = new Map<string, PendingRequest>();
  private stopped = false;
  private restartAttempt = 0;
  private readonly commandTimeoutMs: number;
  private readonly createChild: BridgeChildFactory;
  private queue: Promise<unknown> = Promise.resolve();
  /** The most recently queued coalescible command, while it has not been sent yet. */
  private coalescibleTail: { key: string; payload: Record<string, unknown>; result: Promise<unknown> } | null = null;

  public constructor(options: BridgeOptions = {}) {
    super();
    this.commandTimeoutMs = options.commandTimeoutMs ?? 12_000;
    const mockMode = options.mockMode ?? process.env.CASAMBI_MOCK_MODE === "true";
    this.createChild = options.createChild ?? (() => {
      const worker = resolve(process.cwd(), "server/casambi/casambi_worker.py");
      return spawn(process.env.CASAMBI_PYTHON_COMMAND || "python3", [worker, ...(mockMode ? ["--mock"] : [])], {
        env: { ...process.env, PYTHONUNBUFFERED: "1" },
        stdio: "pipe",
      });
    });
  }

  /** Starts the bridge worker if it is not already running. */
  public start(): void {
    if (this.child || this.stopped) return;
    this.emit("event", { type: "bridge", state: "starting" } satisfies BridgeEvent);
    const child = this.createChild();
    this.child = child;
    child.stdout.on("data", chunk => this.consumeStdout(chunk.toString()));
    child.stderr.on("data", chunk => this.emit("diagnostic", chunk.toString().trim()));
    // A write racing the worker's exit fails with EPIPE; unhandled, that would crash Node.
    child.stdin.on("error", error => this.emit("diagnostic", `Worker stdin error: ${error.message}`));
    child.on("exit", () => this.handleExit());
    child.on("error", error => this.handleFailure(error));
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
    const run = async () => this.send<T>(command, payload);
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
    const entry = { key, payload, result: Promise.resolve() as Promise<unknown> };
    const run = async () => { if (this.coalescibleTail === entry) this.coalescibleTail = null; return this.send<T>(command, entry.payload); };
    const next = this.queue.then(run, run);
    entry.result = next;
    this.queue = next.catch(() => undefined);
    this.coalescibleTail = entry;
    return next;
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
        rejectRequest(new Error(`Casambi bridge command '${command}' timed out.`));
        this.restartUnresponsiveWorker(command);
      }, LONG_COMMAND_TIMEOUTS_MS[command] ?? this.commandTimeoutMs);
      this.pending.set(id, { resolve: value => resolveRequest(value as T), reject: rejectRequest, timer });
      try {
        this.child?.stdin.write(`${JSON.stringify({ id, command, payload })}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
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
      if (line) this.consumeLine(line);
      newline = this.buffer.indexOf("\n");
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
      this.restartAttempt = 0;
      this.emit("event", envelope.event);
      return;
    }
    const request = this.pending.get(envelope.id);
    if (!request) return;
    clearTimeout(request.timer);
    this.pending.delete(envelope.id);
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
    child.kill("SIGTERM");
    setTimeout(() => { if (this.child === child) child.kill("SIGKILL"); }, FORCE_KILL_AFTER_MS).unref();
  }

  private handleFailure(error: Error): void {
    this.emit("diagnostic", error.message);
  }

  private handleExit(): void {
    this.child = null;
    this.rejectPending(new Error("Casambi bridge terminated unexpectedly."));
    if (this.stopped) return;
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
