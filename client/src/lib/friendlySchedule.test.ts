import { describe, expect, it } from "vitest";
import { describeCronExpression, fromCronExpression, toCronExpression } from "./friendlySchedule";

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

  it("reads back the editor's own cron expressions for editing, and rejects others", () => {
    expect(fromCronExpression("30 18 * * 1-5")).toEqual({ time: "18:30", repeat: "weekdays", days: ["1", "2", "3", "4", "5"] });
    expect(fromCronExpression("5 7 * * *")).toEqual({ time: "07:05", repeat: "daily", days: [] });
    expect(fromCronExpression("0 9 * * 1,3,5")).toEqual({ time: "09:00", repeat: "custom", days: ["1", "3", "5"] });
    expect(fromCronExpression("*/15 * * * *")).toBeNull();
    expect(fromCronExpression("0 9 1 * *")).toBeNull();
  });

  it("does not reorder the caller's day list", () => {
    const days = ["5", "1"];
    expect(toCronExpression("09:00", "custom", days)).toBe("0 9 * * 1,5");
    expect(days).toEqual(["5", "1"]);
  });
});

