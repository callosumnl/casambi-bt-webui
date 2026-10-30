import { describe, expect, it } from "vitest";
import { formatId, formatManualCode, parseId } from "./matter";

describe("Matter panel helpers", () => {
  it("formats the setup code and vendor/product ids, and reads ids as hex or decimal", () => {
    expect(formatManualCode("34882334565")).toBe("3488-233-4565");
    expect(formatId(0xfff1)).toBe("0xFFF1");
    expect(parseId("0xfff1")).toBe(0xfff1);
    expect(parseId("32768")).toBe(0x8000);
    expect(parseId("FFF1")).toBeNaN();
  });
});
