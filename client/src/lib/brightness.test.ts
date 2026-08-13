import { describe, expect, it } from "vitest";
import { dimmerToPercent, percentToDimmer } from "./brightness";

describe("brightness presentation conversion", () => {
  it("never displays a protocol dimmer value beyond 100%", () => {
    expect(dimmerToPercent(0)).toBe(0);
    expect(dimmerToPercent(128)).toBe(50);
    expect(dimmerToPercent(255)).toBe(100);
    expect(dimmerToPercent(999)).toBe(100);
  });

  it("translates bounded percentages into the Casambi 0–255 command range", () => {
    expect(percentToDimmer(0)).toBe(0);
    expect(percentToDimmer(50)).toBe(128);
    expect(percentToDimmer(100)).toBe(255);
    expect(percentToDimmer(120)).toBe(255);
  });
});
