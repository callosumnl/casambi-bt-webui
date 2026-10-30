import * as hap from "hap-nodejs";

/** HomeKit's colour temperature range in mired (1,000,000 / kelvin): about 7,100 K to 2,000 K. */
export const HOMEKIT_MIRED_MIN = 140;
export const HOMEKIT_MIRED_MAX = 500;

export type HueSaturation = { hue: number; saturation: number };
type Rgb = [number, number, number];

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export function kelvinToMired(kelvin: number): number { return Math.round(1_000_000 / kelvin); }
export function miredToKelvin(mired: number): number { return Math.round(1_000_000 / mired); }

/** A lamp's kelvin range as a HomeKit mired range, within what HomeKit accepts. */
export function miredRange(minKelvin: number, maxKelvin: number): { minMired: number; maxMired: number } {
  const minMired = clamp(Math.ceil(1_000_000 / maxKelvin), HOMEKIT_MIRED_MIN, HOMEKIT_MIRED_MAX);
  const maxMired = clamp(Math.floor(1_000_000 / minKelvin), HOMEKIT_MIRED_MIN, HOMEKIT_MIRED_MAX);
  return minMired < maxMired ? { minMired, maxMired } : { minMired: HOMEKIT_MIRED_MIN, maxMired: HOMEKIT_MIRED_MAX };
}

/** RGB (0–255) → HomeKit hue (0–360) and saturation (0–100); brightness is a separate characteristic. */
export function rgbToHueSaturation([r, g, b]: Rgb): HueSaturation {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (max === 0 || delta === 0) return { hue: 0, saturation: 0 };
  const hue = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return { hue: Math.round((hue * 60 + 360) % 360), saturation: Math.round((delta / max) * 100) };
}

/** HomeKit hue and saturation → RGB (0–255) at full value, the form casambi-bt's setColor takes. */
export function hueSaturationToRgb({ hue, saturation }: HueSaturation): Rgb {
  const s = clamp(saturation, 0, 100) / 100;
  const h = ((hue % 360) + 360) % 360 / 60;
  const x = s * (1 - Math.abs((h % 2) - 1));
  const [r, g, b] = h < 1 ? [s, x, 0] : h < 2 ? [x, s, 0] : h < 3 ? [0, s, x] : h < 4 ? [0, x, s] : h < 5 ? [x, 0, s] : [s, 0, x];
  const m = 1 - s;
  return [r, g, b].map(channel => Math.round((channel + m) * 255)) as Rgb;
}

const linear = (channel: number) => { const c = channel / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const gamma = (channel: number) => { const c = channel <= 0.0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055; return Math.round(clamp(c, 0, 1) * 255); };

/** sRGB → CIE 1931 xy, for lamps that only take XY colour. */
export function rgbToXy([r, g, b]: Rgb): [number, number] {
  const [lr, lg, lb] = [linear(r), linear(g), linear(b)];
  const x = lr * 0.4124 + lg * 0.3576 + lb * 0.1805;
  const y = lr * 0.2126 + lg * 0.7152 + lb * 0.0722;
  const z = lr * 0.0193 + lg * 0.1192 + lb * 0.9505;
  const sum = x + y + z;
  return sum === 0 ? [0.3127, 0.329] : [Number((x / sum).toFixed(4)), Number((y / sum).toFixed(4))];
}

/** CIE 1931 xy → sRGB at full brightness. */
export function xyToRgb([x, y]: [number, number]): Rgb {
  if (y <= 0) return [255, 255, 255];
  const bigY = 1;
  const bigX = (x / y) * bigY;
  const bigZ = ((1 - x - y) / y) * bigY;
  const rgb = [
    bigX * 3.2406 - bigY * 1.5372 - bigZ * 0.4986,
    -bigX * 0.9689 + bigY * 1.8758 + bigZ * 0.0415,
    bigX * 0.0557 - bigY * 0.204 + bigZ * 1.057,
  ].map(channel => Math.max(0, channel));
  const max = Math.max(...rgb, 1e-9);
  return rgb.map(channel => gamma(channel / max)) as Rgb;
}

/** The hue and saturation HomeKit shows for a white colour temperature, so a white lamp is not drawn in colour. */
export function miredToHueSaturation(mired: number): HueSaturation {
  return hap.ColorUtils.colorTemperatureToHueAndSaturation(clamp(Math.round(mired), HOMEKIT_MIRED_MIN, HOMEKIT_MIRED_MAX));
}
