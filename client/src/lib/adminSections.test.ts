import { describe, expect, it } from "vitest";
import { ADMIN_SECTIONS, adminSection, adminSectionLabel, adminSectionSummary } from "./adminSections";

describe("admin sections", () => {
  it("opens the section in the address, and the connection for /admin or an unknown one", () => {
    expect(adminSection("homekit")).toBe("homekit");
    expect(adminSection(undefined)).toBe("connection");
    expect(adminSection("nonsense")).toBe("connection");
  });

  it("has a label and a summary for every section", () => {
    for (const section of ADMIN_SECTIONS) {
      expect(adminSectionLabel(section)).not.toBe("");
      expect(adminSectionSummary(section)).not.toBe("");
    }
  });
});
