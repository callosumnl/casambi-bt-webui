import { describe, expect, it } from "vitest";
import { describeWakeUp, WAKE_UP_DEFAULTS, wakeUpValue } from "./wakeUp";

describe("wake-up light form", () => {
  it("turns the fields into the command value and checks the ranges", () => {
    expect(wakeUpValue(WAKE_UP_DEFAULTS)).toEqual({ minutes: 30, level: 255, warmKelvin: 2200, coolKelvin: 4000 });
    expect(() => wakeUpValue({ ...WAKE_UP_DEFAULTS, minutes: "90" })).toThrow("5 to 60 minutes");
    expect(() => wakeUpValue({ ...WAKE_UP_DEFAULTS, percent: "0" })).toThrow("1 to 100%");
    expect(() => wakeUpValue({ ...WAKE_UP_DEFAULTS, coolKelvin: "9000" })).toThrow("1800 to 6500 K");
    expect(describeWakeUp({ minutes: 20, level: 255 })).toBe("Wake-up light 20 min to 100%");
  });
});
