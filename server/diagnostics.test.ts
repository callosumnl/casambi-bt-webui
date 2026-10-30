import { describe, expect, it } from "vitest";
import { AppFacts, appVersion, evaluateChecks, gatherSystemFacts, parseConnectDiagnostic, parseWifiLink, Probes, SystemFacts, wifiChannel } from "./diagnostics";

/** Probes that answer from fixed command output and files, the way a Raspberry Pi 5 answers. */
type Network = ReturnType<Probes["network"]>;
const piNetwork: Network = { hostname: "casambi", interfaces: {
  lo: [{ address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", mac: "00:00:00:00:00:00", internal: true, cidr: "127.0.0.1/8" }],
  eth0: [{ address: "192.168.1.40", netmask: "255.255.255.0", family: "IPv4", mac: "2c:cf:67:12:34:56", internal: false, cidr: "192.168.1.40/24" }, { address: "fe80::1", netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", mac: "2c:cf:67:12:34:56", internal: false, cidr: "fe80::1/64", scopeid: 2 }],
} };
function fakeProbes(commands: Record<string, string | null>, files: Record<string, string>, directories: Record<string, string[]>, network: Network = piNetwork): Probes {
  return {
    run: async (command, args) => commands[[command, ...args].join(" ")] ?? commands[`${command} *`] ?? null,
    read: async path => files[path] ?? null,
    list: async path => directories[path] ?? [],
    diskSpace: async () => ({ freeBytes: 20 * 1024 ** 3, totalBytes: 29 * 1024 ** 3 }),
    network: () => network,
  };
}

// Output captured from the real Pi while Wi-Fi was on 2.4 GHz channel 1.
const piCommands = {
  "systemctl show bluetooth.service -p ActiveState -p ActiveEnterTimestamp": "ActiveState=active\nActiveEnterTimestamp=Sat 2026-09-26 16:42:11 CEST\n",
  "busctl --json=short get-property org.bluez /org/bluez/hci0 org.bluez.Adapter1 Powered": '{"type":"b","data":true}\n',
  "iw dev wlan0 link": "Connected to 02:00:00:aa:bb:cc (on wlan0)\n\tSSID: HomeWiFi\n\tfreq: 2412.0\n\tsignal: -52 dBm\n",
  "timedatectl show -p NTPSynchronized -p Timezone": "Timezone=Europe/Amsterdam\nNTPSynchronized=yes\n",
  "/opt/casambi-bt-webui/.venv/bin/python *": '{"casambi-bt": "0.3.2", "bleak": "3.0.2"}\n',
};
const piFiles = {
  "/sys/class/rfkill/rfkill0/type": "bluetooth", "/sys/class/rfkill/rfkill0/soft": "0", "/sys/class/rfkill/rfkill0/hard": "0",
  "/sys/class/rfkill/rfkill1/type": "wlan", "/sys/class/rfkill/rfkill1/soft": "0", "/sys/class/rfkill/rfkill1/hard": "0",
  "/sys/class/net/eth0/carrier": "0",
  "/sys/class/thermal/thermal_zone0/temp": "52650",
  "/sys/class/hwmon/hwmon0/name": "cpu_thermal", "/sys/class/hwmon/hwmon1/name": "rpi_volt", "/sys/class/hwmon/hwmon1/in0_lcrit_alarm": "0",
};
const piDirectories = { "/sys/class/rfkill": ["rfkill0", "rfkill1"], "/sys/class/net": ["eth0", "lo", "wlan0"], "/sys/class/hwmon": ["hwmon0", "hwmon1"] };
const options = { adapter: "hci0", dataDirectory: "/var/lib/casambi-bt-webui", pythonCommand: "/opt/casambi-bt-webui/.venv/bin/python" };

const healthyApp: AppFacts = {
  connection: { phase: "connected" },
  lastConnect: { detail: "Connected in 7.4 s: Bluetooth scan 5.0 s, Casambi cloud and cache 0.2 s, Bluetooth connect 1.4 s, key exchange 0.6 s, authentication 0.2 s.", at: "2026-10-28T09:00:00Z" },
  bluetoothTiming: { medianMs: 80, p95Ms: 199, recent: 11 },
  workerRestarts: 0,
  configured: { networkAddress: true, networkPassword: true, location: true },
  solarTimers: 0,
  port: "3000",
};
const status = (checks: ReturnType<typeof evaluateChecks>, id: string) => checks.find(check => check.id === id);

describe("gatherSystemFacts", () => {
  it("reads a Raspberry Pi without privileges", async () => {
    const facts = await gatherSystemFacts(fakeProbes(piCommands, piFiles, piDirectories), options);
    expect(facts).toEqual({
      bluetoothService: { active: true, since: "Sat 2026-09-26 16:42:11 CEST" },
      bluetoothBlocked: false,
      adapterPowered: true,
      wifi: [{ interface: "wlan0", ssid: "HomeWiFi", frequencyMhz: 2412 }],
      ethernetUp: false,
      clock: { synchronized: true, timezone: "Europe/Amsterdam" },
      disk: { freeBytes: 20 * 1024 ** 3, totalBytes: 29 * 1024 ** 3 },
      temperatureC: 52.7,
      underVoltage: false,
      libraries: { "casambi-bt": "0.3.2", bleak: "3.0.2" },
      hostname: "casambi",
      addresses: [{ interface: "eth0", ipv4: "192.168.1.40", mac: "2c:cf:67:12:34:56" }],
    });
  });

  it("reports what it cannot read as unknown instead of failing", async () => {
    const facts = await gatherSystemFacts(fakeProbes({}, {}, {}, { hostname: "", interfaces: {} }), options);
    expect(facts).toMatchObject({ bluetoothService: null, bluetoothBlocked: null, adapterPowered: null, wifi: null, ethernetUp: null, clock: null, temperatureC: null, underVoltage: null, libraries: null });
    expect(evaluateChecks(facts, healthyApp).filter(check => check.status === "info").map(check => check.id)).toEqual(["bluetooth-service", "bluetooth-adapter", "radio", "clock"]);
  });
});

describe("evaluateChecks", () => {
  it("explains slow Bluetooth connects caused by 2.4 GHz Wi-Fi, as on the real Pi", async () => {
    const facts = await gatherSystemFacts(fakeProbes(piCommands, piFiles, piDirectories), options);
    const checks = evaluateChecks(facts, { ...healthyApp, lastConnect: { detail: "Connected in 61.1 s: Bluetooth scan 5.0 s, Casambi cloud and cache 0.2 s, Bluetooth connect 55.2 s (3 attempts: timed out, timed out), key exchange 0.6 s, authentication 0.2 s.", at: "2026-10-26T12:49:37Z" } });
    expect(status(checks, "radio")).toMatchObject({ status: "warn", detail: expect.stringContaining('"HomeWiFi", channel 1') });
    expect(status(checks, "radio")?.advice).toContain("Ethernet cable (best)");
    expect(status(checks, "radio")?.advice).toContain("lose access to the Pi");
    expect(status(checks, "connect-time")).toMatchObject({ status: "warn", advice: "Most likely caused by 2.4 GHz Wi-Fi (see above)." });
  });

  it("only suggests turning Wi-Fi off when an Ethernet cable is connected", () => {
    const facts: SystemFacts = { bluetoothService: { active: true, since: null }, bluetoothBlocked: false, adapterPowered: true, wifi: [{ interface: "wlan0", ssid: "Home", frequencyMhz: 2462 }], ethernetUp: true, clock: { synchronized: true, timezone: null }, disk: null, temperatureC: null, underVoltage: null, libraries: null, hostname: null, addresses: [] };
    const radio = status(evaluateChecks(facts, healthyApp), "radio");
    expect(radio?.detail).toContain("channel 11");
    expect(radio?.detail).not.toContain("which channel 11 overlaps");
    expect(radio?.advice).toBe("An Ethernet cable is connected: make sure you reach the Pi through it, then turn Wi-Fi off with: sudo nmcli radio wifi off");
  });

  it("passes a healthy Pi on Ethernet and flags the problems a user can fix", () => {
    const healthy: SystemFacts = { bluetoothService: { active: true, since: null }, bluetoothBlocked: false, adapterPowered: true, wifi: [], ethernetUp: true, clock: { synchronized: true, timezone: "Europe/Amsterdam" }, disk: { freeBytes: 8 * 1024 ** 3, totalBytes: 29 * 1024 ** 3 }, temperatureC: 48, underVoltage: false, libraries: null, hostname: "casambi", addresses: [{ interface: "eth0", ipv4: "192.168.1.40", mac: "2c:cf:67:12:34:56" }] };
    const checks = evaluateChecks(healthy, healthyApp);
    expect(checks.filter(check => check.id !== "address").every(check => check.status === "ok")).toBe(true);
    expect(status(checks, "address")).toEqual({ id: "address", title: "Address", status: "info", detail: "Open the app at http://casambi.local:3000 or http://192.168.1.40:3000 (Ethernet).", advice: "So the IP address never changes, reserve 192.168.1.40 for device 2c:cf:67:12:34:56 in your router's DHCP settings (often called a reserved or static lease)." });
    expect(status(checks, "radio")?.detail).toBe("Wi-Fi is not in use; the Pi is on Ethernet.");

    const broken = evaluateChecks({ ...healthy, bluetoothBlocked: true, clock: { synchronized: false, timezone: null }, disk: { freeBytes: 100 * 1024 ** 2, totalBytes: 29 * 1024 ** 3 }, temperatureC: 83, underVoltage: true },
      { ...healthyApp, connection: { phase: "failed", lastError: "Wrong password" }, configured: { networkAddress: true, networkPassword: true, location: false }, solarTimers: 2, workerRestarts: 1 });
    expect(Object.fromEntries(broken.filter(check => check.status !== "ok" && check.status !== "info").map(check => [check.id, check.status]))).toEqual({
      "bluetooth-adapter": "fail", "casambi-config": "fail", worker: "warn", clock: "warn", location: "warn", disk: "warn", temperature: "warn", power: "warn",
    });
    expect(status(broken, "bluetooth-adapter")?.advice).toBe("Run: sudo rfkill unblock bluetooth");
  });

  it("asks to set up the Casambi network before anything else", () => {
    const checks = evaluateChecks({ bluetoothService: null, bluetoothBlocked: null, adapterPowered: null, wifi: null, ethernetUp: null, clock: null, disk: null, temperatureC: null, underVoltage: null, libraries: null, hostname: null, addresses: [] },
      { ...healthyApp, connection: { phase: "idle" }, lastConnect: null, bluetoothTiming: null, configured: { networkAddress: false, networkPassword: false, location: false } });
    expect(status(checks, "casambi-config")).toMatchObject({ status: "fail", advice: "Under Admin → Connection, use Discover, enter the network password, and save." });
  });
});

describe("diagnostics helpers", () => {
  it("parses Wi-Fi links, channels, and connect diagnostics", () => {
    expect(parseWifiLink("Not connected.")).toBeNull();
    expect(parseWifiLink("Connected to aa:bb (on wlan0)\n\tSSID: Home 5G\n\tfreq: 5180.0\n")).toEqual({ ssid: "Home 5G", frequencyMhz: 5180 });
    expect([2412, 2437, 2462, 2484].map(wifiChannel)).toEqual([1, 6, 11, 14]);
    expect(parseConnectDiagnostic("Connect failed after 25.5 s: Bluetooth scan 5.0 s, Casambi cloud and cache 0.2 s, Bluetooth connect 20.3 s (4 attempts: timed out); stopped: x")).toEqual({ failed: true, bluetoothSeconds: 20.3, attempts: 4 });
    expect(parseConnectDiagnostic("Connected in 7.4 s: Bluetooth scan 5.0 s, Bluetooth connect 1.4 s, key exchange 0.6 s.")).toEqual({ failed: false, bluetoothSeconds: 1.4, attempts: null });
  });

  it("reads the version and the commit from a checkout without running git", async () => {
    const commit = "90f2cf3aaaa1111bbbb2222cccc3333dddd4444e";
    const read = async (path: string) => ({ "/app/package.json": '{"version":"1.0.0"}', "/app/.git/HEAD": "ref: refs/heads/main", "/app/.git/packed-refs": `# pack-refs\n${commit} refs/heads/main` } as Record<string, string>)[path] ?? null;
    expect(await appVersion({ read }, "/app")).toEqual({ version: "1.0.0", commit });
  });

  it("warns about the default host name, which clashes between Pis", () => {
    const facts = { bluetoothService: null, bluetoothBlocked: null, adapterPowered: null, wifi: null, ethernetUp: null, clock: null, disk: null, temperatureC: null, underVoltage: null, libraries: null, hostname: "raspberrypi", addresses: [{ interface: "wlan0", ipv4: "10.0.0.7", mac: null }] };
    expect(status(evaluateChecks(facts, healthyApp), "address")).toMatchObject({ status: "warn", detail: expect.stringContaining("http://raspberrypi.local:3000 or http://10.0.0.7:3000 (Wi-Fi)"), advice: expect.stringContaining("sudo raspi-config → System Options → Hostname") });
  });

  it("reports the HomeKit bridge, with advice for a busy port and a missing announcement", () => {
    const facts = { bluetoothService: null, bluetoothBlocked: null, adapterPowered: null, wifi: null, ethernetUp: null, clock: null, disk: null, temperatureC: null, underVoltage: null, libraries: null, hostname: null, addresses: [] };
    const homekit = { enabled: true, state: "published", error: null, port: 51827, advertised: true, advertiser: "avahi", pairings: 2, lights: 12, lightsNotShown: 0 };
    expect(status(evaluateChecks(facts, healthyApp), "homekit")).toBeUndefined();
    expect(status(evaluateChecks(facts, { ...healthyApp, homekit: { ...homekit, enabled: false } }), "homekit")).toBeUndefined();
    expect(status(evaluateChecks(facts, { ...healthyApp, homekit }), "homekit")).toMatchObject({ status: "ok", detail: "Paired with 2 Apple Home controllers; 12 accessories, announced via avahi." });
    expect(status(evaluateChecks(facts, { ...healthyApp, homekit: { ...homekit, pairings: 0 } }), "homekit")).toMatchObject({ status: "info" });
    expect(status(evaluateChecks(facts, { ...healthyApp, homekit: { ...homekit, advertised: false } }), "homekit")).toMatchObject({ status: "warn", advice: expect.stringContaining("CASAMBI_HOMEKIT_ADVERTISER=ciao") });
    expect(status(evaluateChecks(facts, { ...healthyApp, homekit: { ...homekit, state: "failed", error: "Port 51827 is already in use." } }), "homekit")).toMatchObject({ status: "fail", advice: expect.stringContaining("another HomeKit port") });
    expect(status(evaluateChecks(facts, { ...healthyApp, homekit: { ...homekit, lightsNotShown: 3 } }), "homekit")).toMatchObject({ status: "warn" });
  });

  it("reports the Matter bridge for Google Home, with advice for a busy port and missing IPv6", () => {
    const facts = { bluetoothService: null, bluetoothBlocked: null, adapterPowered: null, wifi: null, ethernetUp: null, clock: null, disk: null, temperatureC: null, underVoltage: null, libraries: null, hostname: null, addresses: [] };
    const matter = { enabled: true, state: "running", error: null, port: 5540, commissioned: true, owners: ["iPhone (Apple keychain)", "Google Home"], lights: 4, ipv6: true };
    expect(status(evaluateChecks(facts, healthyApp), "matter")).toBeUndefined();
    expect(status(evaluateChecks(facts, { ...healthyApp, matter }), "matter")).toMatchObject({ status: "ok", detail: "Paired with iPhone (Apple keychain), Google Home; 4 devices." });
    expect(status(evaluateChecks(facts, { ...healthyApp, matter: { ...matter, commissioned: false } }), "matter")).toMatchObject({ status: "info" });
    expect(status(evaluateChecks(facts, { ...healthyApp, matter: { ...matter, ipv6: false } }), "matter")).toMatchObject({ status: "warn", advice: expect.stringContaining("ipv6.disable") });
    expect(status(evaluateChecks(facts, { ...healthyApp, matter: { ...matter, state: "failed", error: "UDP port 5540 is already in use." } }), "matter")).toMatchObject({ status: "fail", advice: expect.stringContaining("Another Matter program") });
  });
});
