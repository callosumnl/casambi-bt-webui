import { EventEmitter } from "events";
import { PassThrough, Writable } from "stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JsonLineCasambiBridge } from "./bridge";

class FakeWorker extends EventEmitter {
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();
  public readonly commands: Array<Record<string, unknown>> = [];
  public readonly stdin = new Writable({ write: (chunk, _encoding, callback) => { this.commands.push(JSON.parse(chunk.toString())); callback(); } });
  public kill(): boolean { this.emit("exit", 0); return true; }
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

  it("keeps the default timeout for ordinary commands", async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker(); const bridge = new JsonLineCasambiBridge({ createChild: () => worker as never });
    const rejection = expect(bridge.execute("snapshot")).rejects.toThrow("Casambi bridge command 'snapshot' timed out.");
    await vi.advanceTimersByTimeAsync(12_000);
    await rejection; bridge.stop();
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
    worker.stdout.write(`${JSON.stringify({ event: { type: "unit.state", unit: { id: 1, name: "Fixture", state: { on: true, online: true } } } })}\n`);
    await expect(event).resolves.toMatchObject({ type: "unit.state", unit: { id: 1, state: { on: true } } }); bridge.stop();
  });
});
