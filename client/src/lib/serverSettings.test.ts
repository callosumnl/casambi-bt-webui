import { describe, expect, it } from "vitest";
import { addressOnPort, describeSettingsStatus, type ServerSettingsInfo } from "./serverSettings";

const info = (overrides: Partial<ServerSettingsInfo>): ServerSettingsInfo => ({ supported: true, port: 3000, trustProxy: false, pending: false, status: {}, readOnly: { nodeEnv: "production", mockMode: false, databasePath: null, cachePath: null, pythonCommand: null, envFile: "/etc/casambi-bt-webui.env" }, ...overrides });

describe("server settings", () => {
  it("builds the new address on the same host, bracketing IPv6", () => {
    expect(addressOnPort({ protocol: "http:", hostname: "casambi.local" }, 8080)).toBe("http://casambi.local:8080/");
    expect(addressOnPort({ protocol: "http:", hostname: "fe80::1" }, 8080)).toBe("http://[fe80::1]:8080/");
  });

  it("explains setup, a running change, and the last result", () => {
    expect(describeSettingsStatus(info({ supported: false }))).toContain("deploy/install.sh");
    expect(describeSettingsStatus(info({ pending: true }))).toBe("Applying the new settings…");
    expect(describeSettingsStatus(info({ status: { state: "rolled_back", message: "Restored." } }))).toBe("Restored.");
    expect(describeSettingsStatus(info({}))).toBeNull();
  });
});
