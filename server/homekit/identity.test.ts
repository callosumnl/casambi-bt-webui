import { describe, expect, it } from "vitest";
import { generatePincode, generateSetupId, generateUsername, isValidPincode, isValidSetupId, isValidUsername, sanitizeName } from "./identity";

/** Plays back `values`, then repeats the last one. */
const sequence = (values: number[]) => { let index = 0; return () => values[Math.min(index++, values.length - 1)]; };

describe("HomeKit identity", () => {
  it("generates setup codes in HomeKit's format, never one HomeKit refuses", () => {
    expect(generatePincode(sequence([1, 2, 3, 4, 5, 6, 7, 8, 0, 3, 1, 4, 1, 5, 9, 2, 6]))).toBe("031-41-592");
    for (let i = 0; i < 200; i += 1) expect(isValidPincode(generatePincode())).toBe(true);
    expect(isValidPincode("123-45-678")).toBe(false);
    expect(isValidPincode("111-11-111")).toBe(false);
    expect(isValidPincode("12345679")).toBe(false);
  });

  it("generates MAC-style device ids and four-character setup ids", () => {
    expect(generateUsername(sequence([0, 1, 15, 16, 171, 255]))).toBe("00:01:0F:10:AB:FF");
    expect(isValidUsername(generateUsername())).toBe(true);
    expect(isValidUsername("00:01:0f:10:ab:ff")).toBe(false);
    expect(isValidSetupId(generateSetupId())).toBe(true);
    expect(isValidSetupId("ab12")).toBe(false);
  });

  it("makes names HomeKit accepts", () => {
    expect(sanitizeName("Casambi Bridge", "x")).toBe("Casambi Bridge");
    expect(sanitizeName("Casambi-bt-webui", "x")).toBe("Casambi-bt-webui");
    expect(sanitizeName("  -Woonkamer (eiland)!  ", "x")).toBe("Woonkamer eiland");
    expect(sanitizeName("Café's lamp", "x")).toBe("Café's lamp");
    expect(sanitizeName("💡💡", "Lamp")).toBe("Lamp");
  });
});
