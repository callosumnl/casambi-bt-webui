import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SliderCommitter } from "./sliderCommit";

describe("SliderCommitter", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("sends only the latest value of a continuous drag, on release", async () => {
    const send = vi.fn(); const settled = vi.fn();
    const committer = new SliderCommitter(send, settled);
    committer.press();
    for (let value = 10; value <= 60; value++) { committer.input(value); await vi.advanceTimersByTimeAsync(16); }
    expect(send).not.toHaveBeenCalled();
    committer.release();
    expect(send.mock.calls).toEqual([[60]]);
    await vi.runAllTimersAsync();
    expect(settled).toHaveBeenCalledOnce();
  });

  it("sends while the pointer is held once the drag pauses, without resending on release", async () => {
    const send = vi.fn(); const settled = vi.fn();
    const committer = new SliderCommitter(send, settled);
    committer.press(); committer.input(40); committer.input(45);
    await vi.advanceTimersByTimeAsync(300);
    expect(send.mock.calls).toEqual([[45]]);
    expect(settled).not.toHaveBeenCalled();
    committer.release();
    await vi.runAllTimersAsync();
    expect(send).toHaveBeenCalledOnce();
    expect(settled).toHaveBeenCalledOnce();
  });

  it("commits keyboard input after a pause without a pointer release", async () => {
    const send = vi.fn(); const settled = vi.fn();
    const committer = new SliderCommitter(send, settled);
    committer.input(51); committer.input(52);
    await vi.advanceTimersByTimeAsync(300);
    expect(send.mock.calls).toEqual([[52]]);
    await vi.runAllTimersAsync();
    expect(settled).toHaveBeenCalledOnce();
  });

  it("settles only after the last send finishes, even if it fails", async () => {
    let reject: (reason: Error) => void = () => undefined;
    const send = vi.fn(() => new Promise((_resolve, rejectSend) => { reject = rejectSend; })); const settled = vi.fn();
    const committer = new SliderCommitter(send, settled);
    committer.press(); committer.input(70); committer.release();
    await vi.runAllTimersAsync();
    expect(settled).not.toHaveBeenCalled();
    reject(new Error("bridge offline"));
    await vi.runAllTimersAsync();
    expect(settled).toHaveBeenCalledOnce();
  });

  it("allows the same value to be sent again in a later interaction", async () => {
    const send = vi.fn();
    const committer = new SliderCommitter(send, () => undefined);
    committer.input(30); committer.release(); await vi.runAllTimersAsync();
    committer.input(30); committer.release(); await vi.runAllTimersAsync();
    expect(send).toHaveBeenCalledTimes(2);
  });
});
