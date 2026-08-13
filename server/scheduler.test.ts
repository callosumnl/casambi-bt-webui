import { describe, expect, it } from "vitest";
import { validateCron } from "./scheduler";

describe("schedule validation", () => {
  it("accepts a portable five-field cron expression", () => expect(() => validateCron("0 18 * * 1-5", "Europe/Amsterdam")).not.toThrow());
  it("rejects malformed or six-field cron expressions", () => expect(() => validateCron("0 0 18 * * *", "UTC")).toThrow(/five fields/));
});
