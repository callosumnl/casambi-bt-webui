import { describe, expect, it } from "vitest";
import { controlRequestSchema, isLampUnit } from "./types";

describe("control request fade duration", () => {
  it("accepts a bounded optional fade duration for brightness transitions", () => {
    expect(controlRequestSchema.parse({ targetType: "room", targetId: 2, operation: "set_level", value: 128, fadeDurationMs: 1200 })).toMatchObject({ fadeDurationMs: 1200 });
  });

  it("rejects fade durations longer than one minute", () => {
    expect(() => controlRequestSchema.parse({ targetType: "unit", targetId: 1, operation: "off", fadeDurationMs: 60_001 })).toThrow();
  });
});

describe("saved scenes and lamp detection", () => {
  it("accepts activating a saved scene and rejects any other operation on it", () => {
    expect(controlRequestSchema.parse({ targetType: "local_scene", targetId: 3, operation: "activate_scene", fadeDurationMs: 2000 })).toMatchObject({ targetType: "local_scene" });
    expect(() => controlRequestSchema.parse({ targetType: "local_scene", targetId: 3, operation: "set_level", value: 10 })).toThrow();
  });

  it("treats units without a controllable capability, such as switches, as non-lamps", () => {
    expect(isLampUnit({ capabilities: [{ type: "dimmer", readOnly: false }] })).toBe(true);
    expect(isLampUnit({ capabilities: [{ type: "sensor", readOnly: true }] })).toBe(false);
    expect(isLampUnit({ capabilities: [] })).toBe(false);
  });
});


describe("wake-up light commands", () => {
  it("need minutes, a level, and colour temperatures in range, and no scene target", () => {
    expect(controlRequestSchema.parse({ targetType: "room", targetId: 2, operation: "wake_up", value: { minutes: 30, level: 255 } })).toMatchObject({ operation: "wake_up" });
    expect(() => controlRequestSchema.parse({ targetType: "room", targetId: 2, operation: "wake_up", value: { minutes: 90, level: 255 } })).toThrow("A wake-up light needs");
    expect(() => controlRequestSchema.parse({ targetType: "room", targetId: 2, operation: "wake_up", value: { minutes: 30, level: 255, warmKelvin: 1000 } })).toThrow("A wake-up light needs");
    expect(() => controlRequestSchema.parse({ targetType: "scene", targetId: 2, operation: "wake_up", value: { minutes: 30, level: 255 } })).toThrow("Scenes can only be activated.");
  });
});
