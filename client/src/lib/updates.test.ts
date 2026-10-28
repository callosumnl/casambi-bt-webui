import { describe, expect, it } from "vitest";
import { describeUpdate, isUpdateBusy, type UpdateInfo } from "./updates";

const now = Date.parse("2026-10-28T12:00:00Z");
const info = (status: UpdateInfo["status"], pending = { check: false, apply: false }, supported = true): UpdateInfo => ({ supported, running: { version: "1.0.0", commit: "2b0e1f8aaaa" }, pending, status });

describe("describeUpdate", () => {
  it("offers the update with its changes when one is available", () => {
    expect(describeUpdate(info({ state: "available", behind: 2, changes: ["Add backups", "Fix timers"], checkedAt: "2026-10-28T11:15:00Z" }), now))
      .toEqual({ running: "Running version 1.0.0 (2b0e1f8).", summary: "2 new changes available. Last checked 45 min ago.", changes: ["Add backups", "Fix timers"], log: null, canApply: true });
  });

  it("shows progress while checking or updating, and keeps polling", () => {
    expect(describeUpdate(info({ state: "available", behind: 1 }, { check: false, apply: true }), now).summary).toMatch(/^Updating…/);
    expect(isUpdateBusy(info({ state: "available" }, { check: false, apply: true }))).toBe(true);
    expect(isUpdateBusy(info({ state: "rolling_back" }))).toBe(true);
    expect(isUpdateBusy(info({ state: "up_to_date" }))).toBe(false);
  });

  it("explains a rolled-back update with its log and lets it be retried", () => {
    const view = describeUpdate(info({ state: "rolled_back", behind: 1, message: "The update failed, so 2b0e1f8 was restored and is running again.", logTail: "ERR_PNPM" }), now);
    expect(view).toMatchObject({ summary: "The update failed, so 2b0e1f8 was restored and is running again.", log: "ERR_PNPM", canApply: true });
  });

  it("tells how to enable updates on an older install", () => {
    expect(describeUpdate(info({}, undefined, false), now)).toMatchObject({ canApply: false, summary: expect.stringContaining("./deploy/install.sh") });
  });
});
