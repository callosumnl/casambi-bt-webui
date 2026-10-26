import { EventEmitter } from "events";
import { PassThrough, Writable } from "stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JsonLineCasambiBridge, workerEnvironment, workerScriptPath } from "./bridge";
import { resolve } from "path";

class FakeWorker extends EventEmitter {
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();
  public readonly commands: Array<Record<string, unknown>> = [];
  public readonly stdin = new Writable({ write: (chunk, _encoding, callback) => { this.commands.push(JSON.parse(chunk.toString())); callback(); } });
  public readonly signals: string[] = [];
  /** When true, behaves like a worker stuck in a blocking call: only SIGKILL ends it. */
  public ignoreSigterm = false;
  public kill(signal = "SIGTERM"): boolean { this.signals.push(signal); if (!(this.ignoreSigterm && signal === "SIGTERM")) this.emit("exit", 0); return true; }
}

describe("JsonLineCasambiBridge", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("gives a Casambi connect longer than the default command timeout", async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker(); const bridge = new JsonLineCasambiBridge({ createChild: () => worker as never });
    let settled = false;
    const result = bridge.execute("configure"); result.then(() => { settled = true; }, () => { settled = true; });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(settled).toBe(false);
    const rejection = expect(result).rejects.toThrow("Casambi bridge command 'configure' timed out.");
    await vi.advanceTimersByTimeAsync(60_000);
    await rejection; bridge.stop();
  });

  it("restarts a worker that stops answering, so a stuck command cannot block every later one", async () => {
    vi.useFakeTimers();
    const workers: FakeWorker[] = [];
    const bridge = new JsonLineCasambiBridge({ createChild: () => { const worker = new FakeWorker(); workers.push(worker); return worker as never; } });
    const states: string[] = [];
    bridge.on("event", event => { if ((event as { type: string }).type === "bridge") states.push((event as { state: string }).state); });
    const rejection = expect(bridge.execute("snapshot")).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(12_000);
    await rejection;
    expect(workers[0].signals).toEqual(["SIGTERM"]);
    expect(states).toContain("unavailable");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(workers).toHaveLength(2);
    bridge.stop();
  });

  it("kills a stuck worker that ignores SIGTERM", async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker(); worker.ignoreSigterm = true;
    const bridge = new JsonLineCasambiBridge({ createChild: () => worker as never });
    const rejection = expect(bridge.execute("snapshot")).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(12_000);
    await rejection;
    expect(worker.signals).toEqual(["SIGTERM"]);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(worker.signals).toEqual(["SIGTERM", "SIGKILL"]);
    bridge.stop();
  });

  it("reports the worker state without waiting on the worker", async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const bridge = new JsonLineCasambiBridge({ createChild: () => worker as never });
    expect(bridge.state()).toMatchObject({ running: false, busy: null, lastAnswerAt: null, restarts: 0 });
    const configure = bridge.execute("configure");
    await vi.advanceTimersByTimeAsync(47_000);
    expect(bridge.state()).toMatchObject({ running: true, busy: { command: "configure", forMs: 47_000 } });
    worker.stdout.write(`${JSON.stringify({ id: worker.commands[0].id, ok: true, result: {} })}\n`);
    await configure;
    expect(bridge.state().busy).toBeNull();
    expect(bridge.state().lastAnswerAt).toEqual(expect.any(String));
    bridge.stop();
  });

  it("restarts the worker on request, and starts one when none is running", async () => {
    vi.useFakeTimers();
    const workers: FakeWorker[] = [];
    const bridge = new JsonLineCasambiBridge({ createChild: () => { const worker = new FakeWorker(); workers.push(worker); return worker as never; } });
    bridge.restart();
    expect(workers).toHaveLength(1);
    bridge.restart();
    expect(workers[0].signals).toEqual(["SIGTERM"]);
    expect(bridge.state()).toMatchObject({ running: false, restarts: 1 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(workers).toHaveLength(2);
    expect(bridge.state().running).toBe(true);
    bridge.stop();
  });

  it("treats a worker that could not be spawned as exited, so it is retried instead of hanging", async () => {
    vi.useFakeTimers();
    const workers: FakeWorker[] = [];
    const bridge = new JsonLineCasambiBridge({ createChild: () => { const worker = new FakeWorker(); workers.push(worker); return worker as never; } });
    bridge.start();
    workers[0].emit("error", Object.assign(new Error("spawn python3 ENOENT"), { code: "ENOENT" }));
    expect(bridge.state().running).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(workers).toHaveLength(2);
    bridge.stop();
  });

  it("keeps a multi-byte character intact when it is split across two output chunks", async () => {
    const worker = new FakeWorker(); const bridge = new JsonLineCasambiBridge({ createChild: () => worker as never });
    const result = bridge.execute<{ name: string }>("ping");
    await new Promise(resolve => setImmediate(resolve));
    const line = Buffer.from(`${JSON.stringify({ id: worker.commands[0].id, ok: true, result: { name: "Caf\u00e9" } })}\n`);
    const split = line.indexOf(Buffer.from("\u00e9")) + 1;
    worker.stdout.write(line.subarray(0, split)); worker.stdout.write(line.subarray(split));
    await expect(result).resolves.toEqual({ name: "Caf\u00e9" });
    bridge.stop();
  });

  it("keeps the default timeout for ordinary commands", async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker(); const bridge = new JsonLineCasambiBridge({ createChild: () => worker as never });
    const rejection = expect(bridge.execute("snapshot")).rejects.toThrow("Casambi bridge command 'snapshot' timed out.");
    await vi.advanceTimersByTimeAsync(12_000);
    await rejection; bridge.stop();
  });

  it("replaces an unsent queued value for the same key and resolves both callers with the latest result", async () => {
    const worker = new FakeWorker(); const bridge = new JsonLineCasambiBridge({ createChild: () => worker as never });
    const first = bridge.executeLatest("unit:1:set_level", "control", { value: 10 });
    await new Promise(resolve => setImmediate(resolve)); // 10 is now sent, so it can no longer be replaced.
    const second = bridge.executeLatest("unit:1:set_level", "control", { value: 20 });
    const third = bridge.executeLatest("unit:1:set_level", "control", { value: 30 });
    await new Promise(resolve => setImmediate(resolve));
    expect(worker.commands.map(command => (command.payload as { value: number }).value)).toEqual([10]);
    worker.stdout.write(`${JSON.stringify({ id: worker.commands[0].id, ok: true, result: "sent-10" })}\n`);
    await expect(first).resolves.toBe("sent-10");
    await new Promise(resolve => setImmediate(resolve));
    expect(worker.commands.map(command => (command.payload as { value: number }).value)).toEqual([10, 30]);
    worker.stdout.write(`${JSON.stringify({ id: worker.commands[1].id, ok: true, result: "sent-30" })}\n`);
    await expect(second).resolves.toBe("sent-30");
    await expect(third).resolves.toBe("sent-30");
    bridge.stop();
  });

  it("never merges across another queued command, so ordering is preserved", async () => {
    const worker = new FakeWorker(); const bridge = new JsonLineCasambiBridge({ createChild: () => worker as never });
    const answer = async (index: number) => { while (worker.commands.length <= index) await new Promise(resolve => setImmediate(resolve)); worker.stdout.write(`${JSON.stringify({ id: worker.commands[index].id, ok: true, result: index })}\n`); };
    const results = [
      bridge.executeLatest("unit:1:set_level", "control", { operation: "set_level", value: 10 }),
      bridge.executeLatest("unit:1:set_level", "control", { operation: "set_level", value: 20 }),
      bridge.execute("control", { operation: "off" }),
      bridge.executeLatest("unit:1:set_level", "control", { operation: "set_level", value: 30 }),
      bridge.executeLatest("unit:2:set_level", "control", { operation: "set_level", value: 40 }),
    ];
    for (let index = 0; index < 4; index++) void answer(index);
    const settled = await Promise.all(results);
    // 10 and 20 merge (both unsent, adjacent); 30 must not jump ahead of "off"; unit 2 has its own key.
    expect(worker.commands.map(command => command.payload)).toEqual([
      { operation: "set_level", value: 20 }, { operation: "off" }, { operation: "set_level", value: 30 }, { operation: "set_level", value: 40 },
    ]);
    expect(settled[0]).toBe(settled[1]);
    bridge.stop();
  });

  it("correlates a JSON-lines response to the command that created it", async () => {
    const worker = new FakeWorker();
    const bridge = new JsonLineCasambiBridge({ createChild: () => worker as never, commandTimeoutMs: 200 });
    const result = bridge.execute<{ accepted: boolean }>("ping");
    await new Promise(resolve => setImmediate(resolve));
    const command = worker.commands[0];
    worker.stdout.write(`${JSON.stringify({ id: command.id, ok: true, result: { accepted: true } })}\n`);
    await expect(result).resolves.toEqual({ accepted: true });
    bridge.stop();
  });

  it("forwards asynchronous unit state events to the service layer", async () => {
    const worker = new FakeWorker(); const bridge = new JsonLineCasambiBridge({ createChild: () => worker as never });
    bridge.start();
    const event = new Promise(resolve => bridge.on("event", payload => { if ((payload as { type?: string }).type === "unit.state") resolve(payload); }));
    worker.stdout.write(`${JSON.stringify({ event: { type: "unit.state", unit: { id: 1, name: "Fixture", capabilities: [], state: { on: true, online: true } } } })}\n`);
    await expect(event).resolves.toMatchObject({ type: "unit.state", unit: { id: 1, state: { on: true } } }); bridge.stop();
  });

  it("refuses new commands once 100 are waiting, instead of queueing hours of Bluetooth writes", async () => {
    const worker = new FakeWorker(); const bridge = new JsonLineCasambiBridge({ createChild: () => worker as never, commandTimeoutMs: 60_000 });
    // Queued synchronously, so none of them has started yet.
    const waiting = Array.from({ length: 100 }, (_, index) => bridge.execute("control", { index }).catch(() => undefined));
    const busy = bridge.execute("control").catch((error: Error) => error.message);
    const busyLatest = bridge.executeLatest("unit:1", "control", {}).catch((error: Error) => error.message);
    expect(await Promise.all([busy, busyLatest])).toEqual(["The Casambi bridge is busy; try again in a moment.", "The Casambi bridge is busy; try again in a moment."]);
    bridge.stop(); await Promise.all(waiting);
  });

  it("starts the worker without the server's secrets", () => {
    const env = workerEnvironment({ PATH: "/usr/bin", LANG: "C.UTF-8", NODE_ENV: "production", CASAMBI_CACHE_PATH: "/var/lib/x", CASAMBI_JWT_SECRET: "jwt", CASAMBI_ENCRYPTION_KEY: "key", CASAMBI_DB_PATH: "/var/lib/x.db" });
    expect(env).toEqual({ PATH: "/usr/bin", LANG: "C.UTF-8", NODE_ENV: "production", CASAMBI_CACHE_PATH: "/var/lib/x", PYTHONUNBUFFERED: "1" });
  });

  it("drops malformed events and oversized lines instead of passing them on", async () => {
    const worker = new FakeWorker(); const bridge = new JsonLineCasambiBridge({ createChild: () => worker as never });
    const events: unknown[] = []; const diagnostics: string[] = [];
    bridge.on("event", event => events.push(event)); bridge.on("diagnostic", message => diagnostics.push(message));
    bridge.start(); events.length = 0;
    worker.stdout.write(`${JSON.stringify({ event: { type: "unit.state", unit: { name: "no id" } } })}\n`);
    worker.stdout.write(`${"x".repeat(4 * 1024 * 1024 + 1)}`);
    worker.stdout.write(`still the same line\n${JSON.stringify({ event: { type: "bridge", state: "connected" } })}\n`);
    await new Promise(resolve => setImmediate(resolve));
    expect(events).toEqual([{ type: "bridge", state: "connected" }]);
    expect(diagnostics.some(message => message.startsWith("Ignored malformed worker event"))).toBe(true);
    expect(diagnostics.some(message => message.startsWith("Dropped worker output"))).toBe(true);
    bridge.stop();
  });

  it("finds the worker script from the module, in the source tree and next to the built app", () => {
    const root = resolve(import.meta.dirname, "..", "..");
    const script = resolve(root, "server", "casambi", "casambi_worker.py");
    expect(workerScriptPath(resolve(root, "server", "casambi"))).toBe(script);
    expect(workerScriptPath(resolve(root, "dist"))).toBe(script);
  });
});
