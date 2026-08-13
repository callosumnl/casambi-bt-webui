import { describe, expect, it } from "vitest";
import { describeCronExpression, toCronExpression } from "./friendlySchedule";

describe("friendly schedule translation", () => {
  it("turns a weekday time into a durable five-field cron expression", () => {
    expect(toCronExpression("18:30", "weekdays")).toBe("30 18 * * 1-5");
  });

  it("requires a day choice for a custom weekly schedule", () => {
    expect(() => toCronExpression("09:00", "custom", [])).toThrow("Choose at least one day");
    expect(toCronExpression("09:00", "custom", ["1", "3", "5"])).toBe("0 9 * * 1,3,5");
  });

  it("describes standard cron expressions without exposing cron syntax", () => {
    expect(describeCronExpression("0 9 * * 1-5")).toBe("Every weekday at 09:00");
    expect(describeCronExpression("15 7 * * 0,6")).toBe("Every weekend at 07:15");
  });
});
