import { afterEach, describe, expect, it, vi } from "vitest";
import type { Response } from "express";
import { EventHub, MAX_STREAMS_PER_PRINCIPAL } from "./events";

function client() {
  const writes: string[] = [];
  let ended = false;
  const response = { status: () => response, set: () => response, flushHeaders: () => undefined, write: (chunk: string) => { writes.push(chunk); return true; }, end: () => { ended = true; } };
  return { response: response as unknown as Response, writes, ended: () => ended };
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

  it("sends each event only to its audience and the build ID with every connection", () => {
    const hub = new EventHub("build-1");
    const admin = client(); const owner = client(); const other = client();
    hub.add(admin.response, { kind: "user", id: 1, name: "admin", role: "admin" });
    hub.add(owner.response, { kind: "user", id: 2, name: "owner", role: "user" });
    hub.add(other.response, { kind: "user", id: 3, name: "other", role: "user" });
    expect(owner.writes[0]).toContain('"build":"build-1"');
    hub.publish("schedule.executed", { scheduleId: 5 }, { ownerUserId: 2 });
    hub.publish("switch", { unitId: 9 }, "admins");
    hub.publish("unit.state", { id: 1 });
    const types = (writes: string[]) => writes.slice(1).map(chunk => chunk.split("\n")[0]);
    expect(types(admin.writes)).toEqual(["event: schedule.executed", "event: switch", "event: unit.state"]);
    expect(types(owner.writes)).toEqual(["event: schedule.executed", "event: unit.state"]);
    expect(types(other.writes)).toEqual(["event: unit.state"]);
  });

  it("caps streams per account and closes an account's streams on request", () => {
    const hub = new EventHub();
    const user = { kind: "user" as const, id: 2, name: "owner", role: "user" as const };
    const streams = Array.from({ length: MAX_STREAMS_PER_PRINCIPAL + 1 }, () => client());
    for (const stream of streams) hub.add(stream.response, user);
    expect(streams[0].ended()).toBe(true);
    expect(hub.clientCount).toBe(MAX_STREAMS_PER_PRINCIPAL);
    const key = client(); hub.add(key.response, { kind: "api_key", id: 2, name: "api-key:x", role: "user" });
    hub.disconnect({ kind: "user", id: 2 });
    expect(streams.every(stream => stream.ended())).toBe(true);
    expect(key.ended()).toBe(false);
    expect(hub.clientCount).toBe(1);
  });
});
