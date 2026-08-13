import { describe, expect, it } from "vitest";
import { localCalendarDate, nextRunAt } from "./scheduler";
import type { ScheduleRecord } from "./store";
import { describeSolarSchedule, nextSolarRun } from "./solar";

const location = { latitude: 52.3676, longitude: 4.9041 };

describe("local solar scheduling", () => {
  it("calculates a future sunrise without a network request", () => {
    const from = new Date("2026-06-21T00:00:00.000Z");
    const next = nextSolarRun({ event: "sunrise", offsetMinutes: 15 }, location, "Europe/Amsterdam", from);
    expect(next).not.toBeNull();
    expect(next!.getTime()).toBeGreaterThan(from.getTime());
    expect(describeSolarSchedule({ event: "sunset", offsetMinutes: -20 })).toBe("20 min before sunset");
  });

  it("returns the next concrete time for both standard and solar schedules", () => {
    const base: Omit<ScheduleRecord, "solar"> = { id: 1, name: "Morning", cronExpression: "0 18 * * *", timezone: "Europe/Amsterdam", command: { targetType: "network", operation: "on" }, holidayDates: [], enabled: true, ownerUserId: 1, createdAt: "", updatedAt: "", lastRunKey: null, lastRunAt: null };
    const config = { networkAddress: null, networkUuid: null, apiKey: null, networkPassword: null, btAdapter: null, forceOffline: false, pollingEnabled: false, pollingIntervalSeconds: 30, solarLatitude: location.latitude, solarLongitude: location.longitude };
    const from = new Date("2026-06-21T08:00:00.000Z");
    expect(nextRunAt({ ...base, solar: null }, config, from)?.getTime()).toBeGreaterThan(from.getTime());
    expect(nextRunAt({ ...base, solar: { event: "sunset", offsetMinutes: 0 } }, config, from)?.getTime()).toBeGreaterThan(from.getTime());
  });

  it("skips an explicit away date when calculating the next fixed-time run", () => {
    const from = new Date("2026-06-21T08:00:00.000Z");
    const schedule: ScheduleRecord = { id: 2, name: "Away", cronExpression: "0 18 * * *", timezone: "Europe/Amsterdam", command: { targetType: "network", operation: "on" }, solar: null, holidayDates: ["2026-06-21"], enabled: true, ownerUserId: 1, createdAt: "", updatedAt: "", lastRunKey: null, lastRunAt: null };
    const config = { networkAddress: null, networkUuid: null, apiKey: null, networkPassword: null, btAdapter: null, forceOffline: false, pollingEnabled: false, pollingIntervalSeconds: 30, solarLatitude: location.latitude, solarLongitude: location.longitude };
    const next = nextRunAt(schedule, config, from);
    expect(next).not.toBeNull();
    expect(localCalendarDate(next!, schedule.timezone)).toBe("2026-06-22");
  });
});
