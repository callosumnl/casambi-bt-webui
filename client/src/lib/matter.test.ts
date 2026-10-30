import { describe, expect, it } from "vitest";
import { describeMatterLights, fabricName, formatId, formatManualCode, isIphoneFabric, parseId, type MatterInfo } from "./matter";

describe("Matter panel helpers", () => {
  it("formats the setup code and vendor/product ids, and reads ids as hex or decimal", () => {
    expect(formatManualCode("34882334565")).toBe("3488-233-4565");
    expect(formatId(0xfff1)).toBe("0xFFF1");
    expect(parseId("0xfff1")).toBe(0xfff1);
    expect(parseId("32768")).toBe(0x8000);
    expect(parseId("FFF1")).toBeNaN();
  });

  it("names an iPhone's own Matter connection, and says 1 device in the singular", () => {
    expect(isIphoneFabric({ vendorId: 0x1384 })).toBe(true);
    expect(fabricName({ owner: "iPhone (Apple keychain)", vendorId: 0x1384 })).toBe("iPhone (Apple keychain)");
    expect(fabricName({ owner: "Google Home", vendorId: 0x6006 })).toBe("Google Home");
    const running = { state: "running", lights: 1 } as MatterInfo;
    expect(describeMatterLights(running)).toBe("1 device for Google Home.");
    expect(describeMatterLights({ ...running, lights: 3 })).toBe("3 devices (lamps, groups, rooms, and scenes) for Google Home.");
  });
});
