import { describe, expect, it } from "vitest";
import { hueSaturationToRgb, kelvinToMired, miredRange, miredToHueSaturation, miredToKelvin, rgbToHueSaturation, rgbToXy, xyToRgb } from "./colour";

describe("HomeKit colour conversions", () => {
  it("converts kelvin and mired, and keeps lamp ranges within what HomeKit accepts", () => {
    expect(kelvinToMired(2700)).toBe(370);
    expect(miredToKelvin(250)).toBe(4000);
    expect(miredRange(2700, 6500)).toEqual({ minMired: 154, maxMired: 370 });
    expect(miredRange(1800, 10000)).toEqual({ minMired: 140, maxMired: 500 });
  });

  it("round-trips hue and saturation through RGB", () => {
    expect(rgbToHueSaturation([255, 0, 0])).toEqual({ hue: 0, saturation: 100 });
    expect(rgbToHueSaturation([0, 0, 255])).toEqual({ hue: 240, saturation: 100 });
    expect(rgbToHueSaturation([255, 255, 255])).toEqual({ hue: 0, saturation: 0 });
    expect(hueSaturationToRgb({ hue: 120, saturation: 100 })).toEqual([0, 255, 0]);
    expect(hueSaturationToRgb({ hue: 30, saturation: 50 })).toEqual([255, 191, 128]);
    for (const hue of [0, 45, 90, 200, 300]) expect(rgbToHueSaturation(hueSaturationToRgb({ hue, saturation: 80 }))).toEqual({ hue, saturation: 80 });
  });

  it("converts between sRGB and CIE xy", () => {
    expect(rgbToXy([255, 255, 255])).toEqual([0.3127, 0.329]);
    expect(xyToRgb([0.3127, 0.329])).toEqual([255, 255, 255]);
    const [r, g, b] = xyToRgb(rgbToXy([255, 0, 0]));
    expect(r).toBe(255); expect(g).toBeLessThan(5); expect(b).toBeLessThan(5);
  });

  it("gives white colour temperatures a low saturation", () => {
    expect(miredToHueSaturation(153).saturation).toBeLessThan(10);
    expect(miredToHueSaturation(500).saturation).toBeGreaterThan(40);
  });
});
