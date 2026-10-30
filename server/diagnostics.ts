import { execFile } from "child_process";
import { readdir, readFile, statfs } from "fs/promises";
import { hostname, networkInterfaces } from "os";
import { resolve } from "path";

/** One line of the system check: what was checked, how it looks, and what to do about it. */
export type CheckStatus = "ok" | "warn" | "fail" | "info";
export type Check = { id: string; title: string; status: CheckStatus; detail: string; advice?: string };

/** Facts read from the Pi. Every field is null when it could not be read (not a Pi, a missing tool, a timeout). */
export type SystemFacts = {
  bluetoothService: { active: boolean; since: string | null } | null;
  bluetoothBlocked: boolean | null;
  adapterPowered: boolean | null;
  wifi: Array<{ interface: string; ssid: string | null; frequencyMhz: number | null }> | null;
  ethernetUp: boolean | null;
  clock: { synchronized: boolean | null; timezone: string | null } | null;
  disk: { freeBytes: number; totalBytes: number } | null;
  temperatureC: number | null;
  underVoltage: boolean | null;
  libraries: Record<string, string> | null;
  /** The Pi's name on the network (reachable as <hostname>.local) and its IPv4 addresses. */
  hostname: string | null;
  addresses: Array<{ interface: string; ipv4: string; mac: string | null }>;
};

/** What the application itself knows; supplied by the API from the service, store, and bridge. */
export type AppFacts = {
  connection: { phase: string; lastError?: string };
  lastConnect: { detail: string; at: string } | null;
  bluetoothTiming: { medianMs: number; p95Ms: number; recent: number } | null;
  workerRestarts: number;
  configured: { networkAddress: boolean; networkPassword: boolean; location: boolean };
  solarTimers: number;
  port: string;
  /** The HomeKit bridge's status; absent when the server runs without one. */
  homekit?: { enabled: boolean; state: string; error: string | null; port: number; advertised: boolean; advertiser: string; pairings: number; lights: number; lightsNotShown: number };
  /** The Matter bridge for Google Home; absent when the server runs without one. `ipv6` says whether the Pi has an IPv6 address. */
  matter?: { enabled: boolean; state: string; error: string | null; port: number; commissioned: boolean; owners: string[]; lights: number; ipv6: boolean };
};

/** Reads the system without privileges; each probe has a short timeout and returns null on any failure. */
export type Probes = {
  run(command: string, args: string[]): Promise<string | null>;
  read(path: string): Promise<string | null>;
  list(path: string): Promise<string[]>;
  diskSpace(path: string): Promise<{ freeBytes: number; totalBytes: number } | null>;
  network(): { hostname: string; interfaces: ReturnType<typeof networkInterfaces> };
};

const PROBE_TIMEOUT_MS = 3_000;

export const systemProbes: Probes = {
  run: (command, args) => new Promise(done => {
    execFile(command, args, { timeout: PROBE_TIMEOUT_MS, encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }, (error, stdout) => done(error ? null : stdout));
  }),
  read: path => readFile(path, "utf8").then(text => text.trim(), () => null),
  list: path => readdir(path).catch(() => []),
  diskSpace: path => statfs(path).then(stats => ({ freeBytes: stats.bavail * stats.bsize, totalBytes: stats.blocks * stats.bsize }), () => null),
  network: () => ({ hostname: hostname(), interfaces: networkInterfaces() }),
};

/** `systemctl show` and `timedatectl show` print key=value lines. */
function keyValues(text: string | null): Map<string, string> | null {
  if (text === null) return null;
  return new Map(text.split("\n").filter(line => line.includes("=")).map(line => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
}

/** Parses `iw dev <interface> link`: "Not connected." or "Connected to …" with "SSID: …" and "freq: 2412.0". */
export function parseWifiLink(text: string): { ssid: string | null; frequencyMhz: number | null } | null {
  if (!text.startsWith("Connected")) return null;
  const ssid = /^\s*SSID: (.*)$/m.exec(text)?.[1] ?? null;
  const frequency = /^\s*freq: ([\d.]+)/m.exec(text)?.[1];
  return { ssid, frequencyMhz: frequency ? Math.round(Number(frequency)) : null };
}

/** Collects the facts in parallel; nothing here needs root, so it works inside the service's sandbox. */
export async function gatherSystemFacts(probes: Probes, options: { adapter: string; dataDirectory: string; pythonCommand: string }): Promise<SystemFacts> {
  const netDirectory = "/sys/class/net";
  const [service, adapter, rfkillEntries, interfaces, clock, disk, temperature, hwmons, libraries] = await Promise.all([
    probes.run("systemctl", ["show", "bluetooth.service", "-p", "ActiveState", "-p", "ActiveEnterTimestamp"]),
    probes.run("busctl", ["--json=short", "get-property", "org.bluez", `/org/bluez/${options.adapter}`, "org.bluez.Adapter1", "Powered"]),
    probes.list("/sys/class/rfkill"),
    probes.list(netDirectory),
    probes.run("timedatectl", ["show", "-p", "NTPSynchronized", "-p", "Timezone"]),
    probes.diskSpace(options.dataDirectory),
    probes.read("/sys/class/thermal/thermal_zone0/temp"),
    probes.list("/sys/class/hwmon"),
    probes.run(options.pythonCommand, ["-c", "import importlib.metadata as m, json\nversions = {}\nfor name in ('casambi-bt', 'bleak', 'bleak-retry-connector'):\n    try: versions[name] = m.version(name)\n    except Exception: pass\nprint(json.dumps(versions))"]),
  ]);

  const serviceValues = keyValues(service);
  const rfkill = await Promise.all(rfkillEntries.map(async entry => ({
    type: await probes.read(`/sys/class/rfkill/${entry}/type`),
    soft: await probes.read(`/sys/class/rfkill/${entry}/soft`),
    hard: await probes.read(`/sys/class/rfkill/${entry}/hard`),
  })));
  const bluetoothRadios = rfkill.filter(radio => radio.type === "bluetooth");
  const wirelessInterfaces = interfaces.filter(name => name.startsWith("wlan"));
  const wifi = await Promise.all(wirelessInterfaces.map(async name => {
    const link = await probes.run("iw", ["dev", name, "link"]);
    return link === null ? null : { interface: name, ...(parseWifiLink(link) ?? { ssid: null, frequencyMhz: null }) };
  }));
  const wired = interfaces.filter(name => name.startsWith("eth") || name.startsWith("en"));
  const carriers = await Promise.all(wired.map(name => probes.read(`${netDirectory}/${name}/carrier`)));
  const voltageSensor = (await Promise.all(hwmons.map(async name => ({ name, kind: await probes.read(`/sys/class/hwmon/${name}/name`) })))).find(sensor => sensor.kind === "rpi_volt");
  const lowVoltage = voltageSensor ? await probes.read(`/sys/class/hwmon/${voltageSensor.name}/in0_lcrit_alarm`) : null;
  const clockValues = keyValues(clock);
  let powered: boolean | null = null;
  try { powered = adapter === null ? null : Boolean((JSON.parse(adapter) as { data?: unknown }).data); } catch { powered = null; }
  let libraryVersions: Record<string, string> | null = null;
  try { libraryVersions = libraries === null ? null : JSON.parse(libraries) as Record<string, string>; } catch { libraryVersions = null; }

  const network = probes.network();
  const addresses = Object.entries(network.interfaces).flatMap(([name, entries]) => (entries ?? [])
    .filter(entry => entry.family === "IPv4" && !entry.internal && !name.startsWith("docker") && !name.startsWith("veth"))
    .map(entry => ({ interface: name, ipv4: entry.address, mac: entry.mac && entry.mac !== "00:00:00:00:00:00" ? entry.mac : null })));

  return {
    hostname: network.hostname || null,
    addresses,
    bluetoothService: serviceValues ? { active: serviceValues.get("ActiveState") === "active", since: serviceValues.get("ActiveEnterTimestamp") || null } : null,
    bluetoothBlocked: bluetoothRadios.length ? bluetoothRadios.some(radio => radio.soft === "1" || radio.hard === "1") : null,
    adapterPowered: powered,
    // Only interfaces `iw` could read; a connected one has a frequency.
    // No network interfaces listed means /sys could not be read (not Linux), which says nothing about Wi-Fi.
    wifi: interfaces.length === 0 ? null : wirelessInterfaces.length === 0 ? [] : wifi.every(link => link === null) ? null : wifi.filter((link): link is NonNullable<typeof link> => link !== null).filter(link => link.frequencyMhz !== null),
    ethernetUp: wired.length ? carriers.some(carrier => carrier === "1") : null,
    clock: clockValues ? { synchronized: clockValues.has("NTPSynchronized") ? clockValues.get("NTPSynchronized") === "yes" : null, timezone: clockValues.get("Timezone") || null } : null,
    disk,
    temperatureC: temperature !== null && Number.isFinite(Number(temperature)) ? Math.round(Number(temperature) / 100) / 10 : null,
    underVoltage: lowVoltage === null ? null : lowVoltage === "1",
    libraries: libraryVersions,
  };
}

/** The 2.4 GHz Wi-Fi channel for a frequency (channel 14 is 2484 MHz). */
export function wifiChannel(frequencyMhz: number): number { return frequencyMhz === 2484 ? 14 : Math.round((frequencyMhz - 2407) / 5); }

/** Reads "Bluetooth connect 17.1 s (3 attempts: …)" from the worker's last connect diagnostic. */
export function parseConnectDiagnostic(detail: string): { failed: boolean; bluetoothSeconds: number | null; attempts: number | null } {
  const bluetooth = /Bluetooth connect ([\d.]+) s(?: \((\d+) attempts)?/.exec(detail);
  return { failed: detail.startsWith("Connect failed"), bluetoothSeconds: bluetooth ? Number(bluetooth[1]) : null, attempts: bluetooth?.[2] ? Number(bluetooth[2]) : null };
}

const UNKNOWN = "Could not be read on this system.";

/** Turns the facts into the system check shown in the admin; pure, so every rule is tested without a Pi. */
export function evaluateChecks(system: SystemFacts, app: AppFacts): Check[] {
  const checks: Check[] = [];
  const add = (check: Check) => checks.push(check);

  // Bluetooth stack.
  if (!system.bluetoothService) add({ id: "bluetooth-service", title: "Bluetooth service", status: "info", detail: UNKNOWN });
  else if (!system.bluetoothService.active) add({ id: "bluetooth-service", title: "Bluetooth service", status: "fail", detail: "The Bluetooth service (BlueZ) is not running.", advice: "Run: sudo systemctl restart bluetooth" });
  else add({ id: "bluetooth-service", title: "Bluetooth service", status: "ok", detail: `Running${system.bluetoothService.since ? ` since ${system.bluetoothService.since}` : ""}.` });

  if (system.bluetoothBlocked) add({ id: "bluetooth-adapter", title: "Bluetooth adapter", status: "fail", detail: "Bluetooth is switched off (rfkill).", advice: "Run: sudo rfkill unblock bluetooth" });
  else if (system.adapterPowered === false) add({ id: "bluetooth-adapter", title: "Bluetooth adapter", status: "fail", detail: "The Bluetooth adapter is powered off.", advice: "Run: bluetoothctl power on" });
  else if (system.adapterPowered === null) add({ id: "bluetooth-adapter", title: "Bluetooth adapter", status: "info", detail: UNKNOWN });
  else add({ id: "bluetooth-adapter", title: "Bluetooth adapter", status: "ok", detail: "Powered on." });

  // The Pi's built-in Wi-Fi and Bluetooth share one chip and antenna; 2.4 GHz Wi-Fi slows Bluetooth connects.
  const crowded = system.wifi?.filter(link => link.frequencyMhz !== null && link.frequencyMhz < 2500) ?? [];
  if (system.wifi === null) add({ id: "radio", title: "Wi-Fi and Bluetooth", status: "info", detail: UNKNOWN });
  else if (crowded.length) {
    const link = crowded[0];
    const channel = wifiChannel(link.frequencyMhz!);
    add({
      id: "radio", title: "Wi-Fi and Bluetooth", status: "warn",
      detail: `Wi-Fi is connected on 2.4 GHz (${link.ssid ? `"${link.ssid}", ` : ""}channel ${channel}). The Pi's Wi-Fi and Bluetooth share one radio, and Bluetooth sets up connections on 2402, 2426, and 2480 MHz${channel <= 8 ? `, which channel ${channel} overlaps` : ""}. This makes Bluetooth connects slow or fail.`,
      advice: system.ethernetUp
        ? "An Ethernet cable is connected: make sure you reach the Pi through it, then turn Wi-Fi off with: sudo nmcli radio wifi off"
        : "Connect the Pi with an Ethernet cable (best), use a 5 GHz Wi-Fi network, or add a USB Bluetooth adapter. Change network settings only with a cable or screen attached, or you can lose access to the Pi.",
    });
  } else add({ id: "radio", title: "Wi-Fi and Bluetooth", status: "ok", detail: system.wifi.length ? `Wi-Fi uses ${Math.round(system.wifi[0].frequencyMhz! / 100) / 10} GHz, which does not disturb Bluetooth.` : `Wi-Fi is not in use${system.ethernetUp ? "; the Pi is on Ethernet" : ""}.` });

  // How to reach the app: a name that works without knowing the IP, and an IP that should not change.
  const primary = system.addresses.find(address => /^(eth|en)/.test(address.interface)) ?? system.addresses[0];
  if (system.hostname || primary) {
    const urls = [system.hostname ? `http://${system.hostname}.local:${app.port}` : null, primary ? `http://${primary.ipv4}:${app.port}` : null].filter(Boolean);
    const generic = system.hostname === "raspberrypi";
    add({
      id: "address", title: "Address", status: generic ? "warn" : "info",
      detail: `Open the app at ${urls.join(" or ")}${primary ? ` (${primary.interface.startsWith("wl") ? "Wi-Fi" : "Ethernet"})` : ""}.${generic ? " The Pi still has the default name \"raspberrypi\", which clashes when there is more than one Pi on the network." : ""}`,
      advice: [
        generic ? "Give the Pi its own name: sudo raspi-config → System Options → Hostname (for example casambi), then reboot." : null,
        primary ? `So the IP address never changes, reserve ${primary.ipv4}${primary.mac ? ` for device ${primary.mac}` : ""} in your router's DHCP settings (often called a reserved or static lease).` : null,
      ].filter(Boolean).join(" "),
    });
  }

  // The Casambi connection.
  if (!app.configured.networkAddress || !app.configured.networkPassword) add({ id: "casambi-config", title: "Casambi network", status: "fail", detail: "No Casambi network is set up yet.", advice: "Under Admin → Connection, use Discover, enter the network password, and save." });
  else if (app.connection.phase === "connected") add({ id: "casambi-config", title: "Casambi network", status: "ok", detail: "Connected." });
  else if (app.connection.phase === "failed" || app.connection.phase === "retrying") add({ id: "casambi-config", title: "Casambi network", status: app.connection.phase === "failed" ? "fail" : "warn", detail: `Not connected${app.connection.lastError ? `: ${app.connection.lastError}` : "."}`, advice: app.connection.phase === "retrying" ? "The service retries by itself; see the checks above for a likely cause." : "Check the network password, then use Connect under Admin → Connection." });
  else add({ id: "casambi-config", title: "Casambi network", status: "info", detail: app.connection.phase === "connecting" ? "Connecting…" : "Not connected." });

  if (app.lastConnect) {
    const connect = parseConnectDiagnostic(app.lastConnect.detail);
    const slow = connect.bluetoothSeconds !== null && connect.bluetoothSeconds > 10;
    const retried = connect.attempts !== null && connect.attempts > 1;
    add({
      id: "connect-time", title: "Last connect", status: connect.failed ? "fail" : slow || retried ? "warn" : "ok", detail: app.lastConnect.detail,
      ...(connect.failed || slow || retried ? { advice: crowded.length ? "Most likely caused by 2.4 GHz Wi-Fi (see above)." : "Bluetooth connects normally take 1–3 s. Check that nothing else (such as the Casambi app) holds a connection to the unit." } : {}),
    });
  }

  if (app.bluetoothTiming) add({ id: "bluetooth-latency", title: "Bluetooth commands", status: app.bluetoothTiming.medianMs > 250 ? "warn" : "ok", detail: `Median ${Math.round(app.bluetoothTiming.medianMs)} ms, 95% within ${Math.round(app.bluetoothTiming.p95Ms)} ms over the last ${app.bluetoothTiming.recent} commands.`, ...(app.bluetoothTiming.medianMs > 250 ? { advice: "Commands are slow; Casambi groups that match your rooms keep large changes fast." } : {}) });
  if (app.workerRestarts > 0) add({ id: "worker", title: "Bluetooth worker", status: "warn", detail: `Restarted ${app.workerRestarts} time${app.workerRestarts === 1 ? "" : "s"} since the service started.`, advice: "The audit log (bridge.*) shows why." });

  // Timers need the right time, and sunrise and sunset need a location.
  if (!system.clock) add({ id: "clock", title: "Clock", status: "info", detail: UNKNOWN });
  else if (system.clock.synchronized === false) add({ id: "clock", title: "Clock", status: "warn", detail: `The clock is not synchronized with a time server${system.clock.timezone ? ` (time zone ${system.clock.timezone})` : ""}; timers may run at the wrong time.`, advice: "Check the Pi's internet connection; it synchronizes automatically once online." });
  else add({ id: "clock", title: "Clock", status: "ok", detail: `Synchronized${system.clock.timezone ? `, time zone ${system.clock.timezone}` : ""}.` });
  if (app.solarTimers > 0 && !app.configured.location) add({ id: "location", title: "Location", status: "warn", detail: `${app.solarTimers} sunrise/sunset timer${app.solarTimers === 1 ? "" : "s"} but no location is set.`, advice: "Enter the solar latitude and longitude under Admin → Automation." });

  // HomeKit, when it is turned on.
  const homekit = app.homekit;
  if (homekit?.enabled) {
    const accessories = `${homekit.lights} accessor${homekit.lights === 1 ? "y" : "ies"}`;
    if (homekit.state === "failed") add({ id: "homekit", title: "HomeKit", status: "fail", detail: `The HomeKit bridge could not start: ${homekit.error ?? "unknown error"}`, advice: homekit.error?.includes("in use") ? "Choose another HomeKit port under Admin → HomeKit (Homebridge uses 51826)." : "Turn HomeKit off and on under Admin → HomeKit; the audit log (homekit.*) shows more." });
    else if (homekit.state !== "published") add({ id: "homekit", title: "HomeKit", status: "info", detail: "Starting…" });
    else if (!homekit.advertised) add({ id: "homekit", title: "HomeKit", status: "warn", detail: `Published on port ${homekit.port}, but not announced on the network (${homekit.advertiser}), so the Home app cannot find it.`, advice: "Check that avahi runs (sudo systemctl status avahi-daemon). If it does not help, set CASAMBI_HOMEKIT_ADVERTISER=ciao in /etc/casambi-bt-webui.env and restart the service." });
    else if (homekit.lightsNotShown > 0) add({ id: "homekit", title: "HomeKit", status: "warn", detail: `${accessories} in HomeKit; ${homekit.lightsNotShown} more do not fit (HomeKit allows 149 per bridge).`, advice: "Hide what you do not need in Apple Home under Admin → HomeKit." });
    else if (homekit.pairings === 0) add({ id: "homekit", title: "HomeKit", status: "info", detail: `Ready to pair on port ${homekit.port}, with ${accessories}.`, advice: "In the Home app choose Add Accessory and scan the code under Admin → HomeKit." });
    else add({ id: "homekit", title: "HomeKit", status: "ok", detail: `Paired with ${homekit.pairings} Apple Home controller${homekit.pairings === 1 ? "" : "s"}; ${accessories}, announced via ${homekit.advertiser}.` });
  }

  // Google Home through Matter, when it is turned on.
  const matter = app.matter;
  if (matter?.enabled) {
    const devices = `${matter.lights} device${matter.lights === 1 ? "" : "s"}`;
    if (matter.state === "failed") add({ id: "matter", title: "Google Home (Matter)", status: "fail", detail: `The Matter bridge could not start: ${matter.error ?? "unknown error"}`, advice: matter.error?.includes("in use") ? "Another Matter program on this Pi (a test bridge, Home Assistant) uses the port; stop it or choose another port under Admin → Google Home / Matter." : "Turn the bridge off and on under Admin → Google Home / Matter; the audit log (matter.*) shows more." });
    else if (matter.state !== "running") add({ id: "matter", title: "Google Home (Matter)", status: "info", detail: "Starting…" });
    else if (!matter.ipv6) add({ id: "matter", title: "Google Home (Matter)", status: "warn", detail: "The Pi has no IPv6 address; Matter needs IPv6 (a link-local address is enough), so Google Home cannot reach the bridge.", advice: "IPv6 is on by default on Raspberry Pi OS; check that it was not turned off (for example ipv6.disable=1 in /boot/firmware/cmdline.txt)." });
    else if (!matter.commissioned) add({ id: "matter", title: "Google Home (Matter)", status: "info", detail: `Ready to pair on UDP port ${matter.port}, with ${devices}.`, advice: "In the Google Home app choose + → Device → Matter device, and scan the code under Admin → Google Home / Matter." });
    else add({ id: "matter", title: "Google Home (Matter)", status: "ok", detail: `Paired with ${matter.owners.join(", ")}; ${devices}.` });
  }

  // The Pi itself.
  if (system.disk) {
    const freeMb = system.disk.freeBytes / 1_048_576;
    const low = freeMb < 1024;
    add({ id: "disk", title: "Storage", status: low ? "warn" : "ok", detail: `${freeMb >= 1024 ? `${(freeMb / 1024).toFixed(1)} GB` : `${Math.round(freeMb)} MB`} free.`, ...(low ? { advice: "Free up space on the SD card; the database and logs need room to grow." } : {}) });
  }
  if (system.temperatureC !== null) add({ id: "temperature", title: "Temperature", status: system.temperatureC >= 80 ? "warn" : "ok", detail: `${system.temperatureC} °C.`, ...(system.temperatureC >= 80 ? { advice: "The Pi is running hot; give it ventilation or a heatsink." } : {}) });
  if (system.underVoltage) add({ id: "power", title: "Power supply", status: "warn", detail: "The Pi reports low supply voltage.", advice: "Use the official Raspberry Pi power supply; low voltage causes random errors, including in Bluetooth." });

  return checks;
}

/** The application version: package.json and, for a git checkout, the commit it was built from. */
export async function appVersion(probes: Pick<Probes, "read">, root = resolve(import.meta.dirname, "..")): Promise<{ version: string | null; commit: string | null }> {
  let version: string | null = null;
  try { version = (JSON.parse((await probes.read(resolve(root, "package.json"))) ?? "{}") as { version?: string }).version ?? null; } catch { version = null; }
  // Read .git directly: running git as the service account fails on a checkout owned by another user.
  const head = await probes.read(resolve(root, ".git", "HEAD"));
  let commit: string | null = null;
  if (head?.startsWith("ref: ")) {
    const ref = head.slice(5);
    commit = await probes.read(resolve(root, ".git", ref));
    if (!commit) commit = (await probes.read(resolve(root, ".git", "packed-refs")))?.split("\n").find(line => line.endsWith(` ${ref}`))?.split(" ")[0] ?? null;
  } else if (head) commit = head;
  return { version, commit: commit && /^[0-9a-f]{40}$/.test(commit) ? commit : null };
}
