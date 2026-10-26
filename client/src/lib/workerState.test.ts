import { describe, expect, it } from "vitest";
import { describeWorkerState } from "./workerState";

const now = Date.parse("2026-10-02T08:00:00.000Z");

describe("describeWorkerState", () => {
  it("describes an idle worker with its last answer and restarts", () => {
    expect(describeWorkerState({ running: true, pid: 812, busy: null, lastAnswerAt: "2026-10-02T07:59:57.000Z", restarts: 2 }, now))
      .toBe("Worker running (PID 812), idle. Last answer 3 s ago. Restarted 2 times since the service started.");
  });

  it("shows which command a busy worker is on and for how long", () => {
    expect(describeWorkerState({ running: true, pid: 812, busy: { command: "configure", forMs: 47_000 }, lastAnswerAt: "2026-10-02T06:00:00.000Z", restarts: 0 }, now))
      .toBe("Worker running (PID 812), busy with 'configure' for 47 s. Last answer 2 h ago.");
  });

  it("reports a stopped worker", () => {
    expect(describeWorkerState({ running: false, pid: null, busy: null, lastAnswerAt: null, restarts: 1 }, now)).toBe("Worker not running. Restarted 1 time since the service started.");
  });

  it("adds the Bluetooth send times of recent light commands", () => {
    expect(describeWorkerState({ running: true, pid: 812, busy: null, lastAnswerAt: "2026-10-02T07:59:57.000Z", restarts: 0, bluetooth: { commands: 950, recent: 200, lastMs: 31, medianMs: 34.6, p95Ms: 61.2, maxMs: 140 } }, now))
      .toBe("Worker running (PID 812), idle. Last answer 3 s ago. Bluetooth send time over the last 200 light commands: median 35 ms, 95% within 61 ms, slowest 140 ms.");
  });
});
