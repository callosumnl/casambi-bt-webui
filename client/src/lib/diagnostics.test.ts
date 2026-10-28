import { describe, expect, it } from "vitest";
import { signalQuality } from "./diagnostics";

describe("signalQuality", () => {
  it("rates the Bluetooth signal the way Casambi connects tolerate it", () => {
    expect(signalQuality(-43)).toEqual({ status: "ok", label: "strong" });
    expect(signalQuality(-75).label).toBe("good enough");
    expect(signalQuality(-88).status).toBe("warn");
    expect(signalQuality(null)).toEqual({ status: "warn", label: "unknown" });
  });
});
