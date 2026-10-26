import { describe, expect, it, vi } from "vitest";
import { createBuildWatcher } from "./buildWatch";

describe("createBuildWatcher", () => {
  it("reloads only when a later stream reports a different build", () => {
    const reload = vi.fn(); const watch = createBuildWatcher(reload);
    watch(null); watch("aaa"); watch("aaa");
    expect(reload).not.toHaveBeenCalled();
    watch("bbb");
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
