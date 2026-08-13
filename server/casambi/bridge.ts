import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import { EventEmitter } from "events";
import { randomUUID } from "crypto";
import { resolve } from "path";
import type { BridgeEvent, NetworkSnapshot } from "./types";

type BridgeResponse = { id: string; ok: true; result: unknown } | { id: string; ok: false; error: { code: string; message: string } };
type BridgeEnvelope = BridgeResponse | { event: BridgeEvent };

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

  public constructor(options: BridgeOptions = {}) {
    super();
    this.commandTimeoutMs = options.commandTimeoutMs ?? 12_000;
    const mockMode = options.mockMode ?? (process.env.CASAMBI_MOCK_MODE === "true" || process.env.NODE_ENV !== "production");
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
      }, this.commandTimeoutMs);
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
