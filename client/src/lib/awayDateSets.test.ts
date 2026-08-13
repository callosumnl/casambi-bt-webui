import { describe, expect, it } from "vitest";
import { attachDemoAwayDateSet } from "./awayDateSets";
import type { AwayDateSet, Schedule } from "./localApi";

describe("Demo away-date set assignment", () => {
  it("attaches a reusable set only to the in-memory demo timer value", () => {
    const set: AwayDateSet = { id: 7001, name: "Summer break", dates: ["2026-08-17"] };
    const original: Schedule = { id: 1, name: "Demo", cronExpression: "0 18 * * *", timezone: "UTC", command: { targetType: "network", operation: "on" }, solar: null, holidayDates: [], awayDateSetId: null, awayDateSet: null, enabled: true, lastRunAt: null, nextRunAt: null };
    const assigned = attachDemoAwayDateSet(original, set);
    expect(assigned.awayDateSet).toEqual(set);
    expect(assigned.awayDateSetId).toBe(7001);
    expect(original.awayDateSet).toBeNull();
  });
});
