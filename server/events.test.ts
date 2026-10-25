import { afterEach, describe, expect, it, vi } from "vitest";
import type { Response } from "express";
import { EventHub } from "./events";

function client() {
  const writes: string[] = [];
  const response = { status: () => response, set: () => response, flushHeaders: () => undefined, write: (chunk: string) => { writes.push(chunk); return true; } };
  return { response: response as unknown as Response, writes };
}

describe("EventHub", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("sends a heartbeat comment every 25 s while clients are connected and drops clients whose write fails", () => {
    vi.useFakeTimers();
    const hub = new EventHub();
    const alive = client(); const gone = client();
    hub.add(alive.response); const removeGone = hub.add(gone.response);
    (gone.response as unknown as { write: () => never }).write = () => { throw new Error("socket closed"); };
    vi.advanceTimersByTime(25_000);
    expect(alive.writes.filter(chunk => chunk === ": heartbeat\n\n")).toHaveLength(1);
    expect(hub.clientCount).toBe(1);
    removeGone();
  });
});
