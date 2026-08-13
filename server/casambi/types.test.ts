import { describe, expect, it } from "vitest";
import { controlRequestSchema } from "./types";

describe("control request fade duration", () => {
  it("accepts a bounded optional fade duration for brightness transitions", () => {
    expect(controlRequestSchema.parse({ targetType: "room", targetId: 2, operation: "set_level", value: 128, fadeDurationMs: 1200 })).toMatchObject({ fadeDurationMs: 1200 });
  });

  it("rejects fade durations longer than one minute", () => {
    expect(() => controlRequestSchema.parse({ targetType: "unit", targetId: 1, operation: "off", fadeDurationMs: 60_001 })).toThrow();
  });
});
