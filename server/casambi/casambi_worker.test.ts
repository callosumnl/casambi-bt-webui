import { spawn, spawnSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

const projectRoot = path.resolve(import.meta.dirname, "../..");
const workerPath = path.join(projectRoot, "server", "casambi", "casambi_worker.py");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function waitForResponse(child: ReturnType<typeof spawn>, id: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let pending = "";
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for the Casambi worker response.")), 5_000);
    child.stdout.on("data", chunk => {
      pending += chunk.toString();
      const lines = pending.split("\n");
      pending = lines.pop() || "";
      for (const line of lines.filter(Boolean)) {
        const payload = JSON.parse(line) as Record<string, unknown>;
        if (payload.id === id) {
          clearTimeout(timeout);
          resolve(payload);
        }
      }
    });
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    // Every connect reports its duration on stderr ("Connected in …"); anything else there is a failure.
    child.stderr.on("data", chunk => { const text = chunk.toString(); if (text.split("\n").every(line => !line || line.startsWith("Connected in "))) return; clearTimeout(timeout); reject(new Error(text)); });
  });
}

describe("casambi_worker upstream cache", () => {
  it("uses the configured writable data path instead of its read-only working directory", async () => {
    const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "casambi-worker-"));
    temporaryDirectories.push(temporaryDirectory);
    const fakePackageDirectory = path.join(temporaryDirectory, "CasambiBt");
    const cachePath = path.join(temporaryDirectory, "service-data", "casambi-bt-store");
    mkdirSync(fakePackageDirectory, { recursive: true });
    writeFileSync(path.join(fakePackageDirectory, "__init__.py"), `
from pathlib import Path
from types import SimpleNamespace

async def discover():
    return [SimpleNamespace(address="AB:CD:EF:01:23:45")]

class Casambi:
    def __init__(self, cachePath):
        self.cache_path = Path(cachePath)
        self.units = []
        self.groups = []
        self.scenes = []
        self.networkId = "test-network"
        self.networkName = "Test network"
    def registerUnitChangedHandler(self, handler): pass
    def registerSwitchEventHandler(self, handler): pass
    def registerDisconnectCallback(self, handler): pass
    async def connect(self, address, password, force_offline):
        self.cache_path.mkdir(mode=0o700, parents=True, exist_ok=True)
        (self.cache_path / "selected-path.txt").write_text(str(self.cache_path))
        (self.cache_path / "selected-address.txt").write_text(address.address)
    async def disconnect(self): pass
`);

    const child = spawn("python3", [workerPath], {
      cwd: projectRoot,
      env: {
        ...process.env,
        NODE_ENV: "production",
        CASAMBI_CACHE_PATH: cachePath,
        PYTHONPATH: `${temporaryDirectory}${path.delimiter}${process.env.PYTHONPATH || ""}`,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    try {
      const response = waitForResponse(child, "cache-path");
      child.stdin.write(`${JSON.stringify({ id: "cache-path", command: "configure", payload: { networkAddress: "abcdef012345", networkPassword: "not-a-real-password" } })}\n`);
      await expect(response).resolves.toMatchObject({ id: "cache-path", ok: true, result: { connected: true } });
      expect(readFileSync(path.join(cachePath, "selected-path.txt"), "utf8")).toBe(cachePath);
      expect(readFileSync(path.join(cachePath, "selected-address.txt"), "utf8")).toBe("AB:CD:EF:01:23:45");
    } finally {
      child.kill();
    }
  });
});

describe("casambi_worker shutdown", () => {
  /** Starts the real worker against a fake upstream package whose disconnect() leaves a marker file. */
  async function connectedWorker(disconnectDelaySeconds = 0) {
    const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "casambi-worker-shutdown-"));
    temporaryDirectories.push(temporaryDirectory);
    const marker = path.join(temporaryDirectory, "disconnected.txt");
    mkdirSync(path.join(temporaryDirectory, "CasambiBt"), { recursive: true });
    writeFileSync(path.join(temporaryDirectory, "CasambiBt", "__init__.py"), `
import asyncio
from types import SimpleNamespace

async def discover():
    return [SimpleNamespace(address="AB:CD:EF:01:23:45")]

class Casambi:
    def __init__(self, cachePath):
        self.units, self.groups, self.scenes = [], [], []
        self.networkId, self.networkName = "test-network", "Test network"
    def registerUnitChangedHandler(self, handler): pass
    def registerSwitchEventHandler(self, handler): pass
    def registerDisconnectCallback(self, handler): pass
    async def connect(self, address, password, force_offline): pass
    async def disconnect(self):
        await asyncio.sleep(${disconnectDelaySeconds})
        with open(${JSON.stringify(marker)}, "a") as handle: handle.write("disconnected\\n")
`);
    const child = spawn("python3", [workerPath], {
      cwd: projectRoot,
      env: { ...process.env, NODE_ENV: "production", CASAMBI_CACHE_PATH: path.join(temporaryDirectory, "cache"), PYTHONPATH: `${temporaryDirectory}${path.delimiter}${process.env.PYTHONPATH || ""}` },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const exited = new Promise<number | null>(resolve => child.once("exit", code => resolve(code)));
    const response = waitForResponse(child, "connect");
    child.stdin.write(`${JSON.stringify({ id: "connect", command: "configure", payload: { networkAddress: "abcdef012345", networkPassword: "not-a-real-password" } })}\n`);
    await expect(response).resolves.toMatchObject({ ok: true, result: { connected: true } });
    return { child, marker, exited };
  }

  it("disconnects Bluetooth and exits cleanly on SIGTERM", async () => {
    const { child, marker, exited } = await connectedWorker();
    expect(existsSync(marker)).toBe(false);
    child.kill("SIGTERM");
    await expect(exited).resolves.toBe(0);
    expect(readFileSync(marker, "utf8")).toBe("disconnected\n");
  });

  it("finishes a slow disconnect when SIGTERM arrives twice, as it does under systemd", async () => {
    const { child, marker, exited } = await connectedWorker(0.5);
    child.kill("SIGTERM");
    await new Promise(resolve => setTimeout(resolve, 50));
    child.kill("SIGTERM");
    await expect(exited).resolves.toBe(0);
    expect(readFileSync(marker, "utf8")).toBe("disconnected\n");
  });

  it("disconnects Bluetooth when Node closes its stdin", async () => {
    const { child, marker, exited } = await connectedWorker();
    child.stdin.end();
    await expect(exited).resolves.toBe(0);
    expect(readFileSync(marker, "utf8")).toBe("disconnected\n");
  });
});

describe("casambi_worker bounded reconnect steps", () => {
  /** Real worker with 0.2 s step limits, against a fake upstream whose disconnect() or discover() can hang forever. */
  function worker(hang: "disconnect" | "discover") {
    const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "casambi-worker-steps-"));
    temporaryDirectories.push(temporaryDirectory);
    mkdirSync(path.join(temporaryDirectory, "CasambiBt"), { recursive: true });
    writeFileSync(path.join(temporaryDirectory, "CasambiBt", "__init__.py"), `
import asyncio
from types import SimpleNamespace
HANG = ${JSON.stringify(hang)}

async def discover():
    if HANG == "discover":
        await asyncio.Event().wait()
    return [SimpleNamespace(address="AB:CD:EF:01:23:45")]

class Casambi:
    def __init__(self, cachePath):
        self.units, self.groups, self.scenes = [], [], []
        self.networkId, self.networkName = "test-network", "Test network"
    def registerUnitChangedHandler(self, handler): pass
    def registerSwitchEventHandler(self, handler): pass
    def registerDisconnectCallback(self, handler): pass
    async def connect(self, address, password, force_offline): pass
    async def disconnect(self):
        if HANG == "disconnect":
            await asyncio.Event().wait()
`);
    const harness = "import asyncio, sys; sys.path.insert(0, sys.argv[1]); import casambi_worker as w; w.PREVIOUS_DISCONNECT_TIMEOUT_SECONDS = 0.2; w.DISCOVERY_TIMEOUT_SECONDS = 0.2; w.SHUTDOWN_DISCONNECT_SECONDS = 0.2; asyncio.run(w.run_worker(False))";
    const child = spawn("python3", ["-c", harness, path.join(projectRoot, "server", "casambi")], {
      cwd: projectRoot,
      env: { ...process.env, NODE_ENV: "production", CASAMBI_CACHE_PATH: path.join(temporaryDirectory, "cache"), PYTHONPATH: `${temporaryDirectory}${path.delimiter}${process.env.PYTHONPATH || ""}` },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    const responses = new Map<string, (payload: Record<string, unknown>) => void>();
    let pending = "";
    child.stdout.on("data", chunk => {
      pending += chunk.toString();
      const lines = pending.split("\n"); pending = lines.pop() || "";
      for (const line of lines.filter(Boolean)) { const payload = JSON.parse(line) as Record<string, unknown>; responses.get(String(payload.id))?.(payload); }
    });
    const send = (id: string, command: string, payload: Record<string, unknown> = {}) => new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`No answer to ${command} within 3 s.`)), 3_000);
      responses.set(id, value => { clearTimeout(timeout); resolve(value); });
      child.stdin.write(`${JSON.stringify({ id, command, payload })}\n`);
    });
    const credentials = { networkAddress: "abcdef012345", networkPassword: "not-a-real-password" };
    return { child, send, credentials, stderr: () => stderr };
  }

  it("reconnects even when closing the previous connection never finishes", async () => {
    const { child, send, credentials, stderr } = worker("disconnect");
    try {
      await expect(send("first", "configure", credentials)).resolves.toMatchObject({ ok: true, result: { connected: true } });
      await expect(send("second", "configure", credentials)).resolves.toMatchObject({ ok: true, result: { connected: true } });
      expect(stderr()).toContain("Closing the previous Casambi connection did not finish");
    } finally { child.kill("SIGKILL"); }
  });

  it("fails a hanging scan with a clear message and keeps answering commands", async () => {
    const { child, send, credentials } = worker("discover");
    try {
      const connect = await send("connect", "configure", credentials);
      expect(connect).toMatchObject({ ok: false, error: { code: "RuntimeError" } });
      expect(String((connect.error as { message: string }).message)).toContain("Bluetooth scan timed out after 0.2 s");
      await expect(send("discover", "discover")).resolves.toMatchObject({ ok: false, error: { code: "RuntimeError" } });
      await expect(send("ping", "ping")).resolves.toMatchObject({ ok: true, result: { ok: true } });
    } finally { child.kill("SIGKILL"); }
  });
});

describe("casambi_worker switch events", () => {
  // Mirrors upstream's SwitchEvent dataclass and ButtonEventType enum, with the values captured from a real switch.
  const script = `
import json, sys
from dataclasses import dataclass
from enum import Enum
sys.path.insert(0, sys.argv[1])
from casambi_worker import normalize_switch_event

class ButtonEventType(Enum):
    PRESS = 0x01
    RELEASE = 0x02
    HOLD = 0x09
    RELEASE_AFTER_HOLD = 0x0C

@dataclass(frozen=True)
class SwitchEvent:
    message_type: int
    button: int
    unit_id: int
    action: int | None
    event: ButtonEventType
    flags: int
    extra_data: bytes

events = [
    SwitchEvent(0x10, 4, 2, 241, ButtonEventType.RELEASE, 2, b"\\x12\\x00"),
    SwitchEvent(0x10, 4, 2, 247, ButtonEventType.HOLD, 2, b"\\x12\\x00"),
    SwitchEvent(0x10, 4, 2, 123, ButtonEventType.RELEASE_AFTER_HOLD, 2, b"\\x12\\x00"),
    SwitchEvent(0x08, 4, 2, 187, ButtonEventType.RELEASE, 4, b"\\x02"),
]
print(json.dumps([normalize_switch_event(event) for event in events]))
`;

  it("derives triggers only from type 0x10 messages and keeps raw fields as JSON", () => {
    const result = spawnSync("python3", ["-c", script, path.join(projectRoot, "server", "casambi")], { encoding: "utf8" });
    expect(result.stderr).toBe("");
    const presses = JSON.parse(result.stdout) as Array<Record<string, unknown>>;
    expect(presses.map(press => press.trigger)).toEqual(["tap", "hold", "release_after_hold", null]);
    expect(presses[0]).toEqual({ unitId: 2, button: 4, trigger: "tap", raw: { messageType: 16, event: "RELEASE", action: 241, flags: 2, extraData: "1200" } });
    expect(presses[3].raw).toMatchObject({ messageType: 8, event: "RELEASE", extraData: "02" });
  });
});

describe("casambi_worker input handling", () => {
  it("answers malformed lines with an error and keeps serving commands", () => {
    const result = spawnSync("python3", [workerPath, "--mock"], { input: 'not json\n[1]\n{"id":"p","command":"ping"}\n', encoding: "utf8" });
    const lines = result.stdout.trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
    expect(result.status).toBe(0);
    expect(lines.filter(line => line.ok === false).map(line => line.id)).toEqual(["unknown", "unknown"]);
    expect(lines.at(-1)).toEqual({ id: "p", ok: true, result: { ok: true } });
  });

  it("answers a control command with only an ack when asked, so a series of commands skips the snapshots", () => {
    const control = (id: string, reply?: string) => JSON.stringify({ id, command: "control", payload: { targetType: "unit", targetId: 1, operation: "set_level", value: 40, ...(reply ? { reply } : {}) } });
    const result = spawnSync("python3", [workerPath, "--mock"], { input: `${control("ack", "ack")}\n${control("full")}\n`, encoding: "utf8" });
    const replies = result.stdout.trim().split("\n").map(line => JSON.parse(line) as { id?: string; result?: Record<string, unknown> }).filter(line => line.id);
    expect(replies[0]).toEqual({ id: "ack", ok: true, result: { ok: true } });
    expect(replies[1].result).toMatchObject({ units: expect.any(Array), groups: expect.any(Array) });
  });
});

describe("casambi_worker Bluetooth diagnostics", () => {
  /** Real worker against a fake upstream: setLevel takes 20 ms, level 13 drops the link the way casambi-bt does, and one fixture type failed. */
  async function worker() {
    const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "casambi-worker-diagnostics-"));
    temporaryDirectories.push(temporaryDirectory);
    mkdirSync(path.join(temporaryDirectory, "CasambiBt"), { recursive: true });
    writeFileSync(path.join(temporaryDirectory, "CasambiBt", "__init__.py"), `
import asyncio, json
from pathlib import Path
from types import SimpleNamespace

async def discover():
    return [SimpleNamespace(address="AB:CD:EF:01:23:45")]

class Casambi:
    def __init__(self, cachePath):
        self.units, self.groups, self.scenes = [], [], []
        self.networkId, self.networkName = "test-network", "Test network"
        self.connected = False
        cache = SimpleNamespace(_cachePath=cachePath)
        self._casaNetwork = SimpleNamespace(_cache=cache, _uuid="abcdef012345", _id="net-1", _unitTypes={1: (object(), None), 2: (None, None)})
    def registerUnitChangedHandler(self, handler): pass
    def registerSwitchEventHandler(self, handler): pass
    def registerDisconnectCallback(self, handler): pass
    async def connect(self, address, password, force_offline):
        directory = Path(self._casaNetwork._cache._cachePath) / "abcdef012345"
        directory.mkdir(parents=True, exist_ok=True)
        units = [{"deviceID": 1, "type": 1, "name": "Desk"}, {"deviceID": 2, "type": 2, "name": "Hall spot"}]
        (directory / "net-1.json").write_text(json.dumps({"network": {"units": units}}))
        self.connected = True
    async def setLevel(self, target, level):
        await asyncio.sleep(0.02)
        if level == 13:
            self.connected = False  # casambi-bt marks the link down and returns without an error
    async def disconnect(self): pass
`);
    const child = spawn("python3", [workerPath], {
      cwd: projectRoot,
      env: { ...process.env, NODE_ENV: "production", CASAMBI_CACHE_PATH: path.join(temporaryDirectory, "cache"), PYTHONPATH: `${temporaryDirectory}${path.delimiter}${process.env.PYTHONPATH || ""}` },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    const responses = new Map<string, (payload: Record<string, unknown>) => void>();
    let pending = "";
    child.stdout.on("data", chunk => {
      pending += chunk.toString();
      const lines = pending.split("\n"); pending = lines.pop() || "";
      for (const line of lines.filter(Boolean)) { const payload = JSON.parse(line) as Record<string, unknown>; responses.get(String(payload.id))?.(payload); }
    });
    const send = (id: string, command: string, payload: Record<string, unknown> = {}) => new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`No answer to ${command} within 3 s.`)), 3_000);
      responses.set(id, value => { clearTimeout(timeout); resolve(value); });
      child.stdin.write(`${JSON.stringify({ id, command, payload })}\n`);
    });
    return { child, send, stderr: () => stderr, cache: path.join(temporaryDirectory, "cache", "abcdef012345") };
  }

  it("reports units that casambi-bt skipped because their fixture type failed to load", async () => {
    const { child, send, stderr, cache } = await worker();
    try {
      await expect(send("connect", "configure", { networkAddress: "abcdef012345", networkPassword: "not-a-real-password" })).resolves.toMatchObject({ ok: true });
      expect(stderr()).toContain(`1 Casambi unit(s) are missing (Hall spot): casambi-bt could not load their fixture type [2]`);
      expect(stderr()).toContain(`delete ${cache} and connect again`);
    } finally { child.kill(); }
  });

  it("reports the Bluetooth send time with each light command and fails a command the link dropped", async () => {
    const { child, send } = await worker();
    try {
      await send("connect", "configure", { networkAddress: "abcdef012345", networkPassword: "not-a-real-password" });
      const sent = await send("level", "control", { targetType: "network", operation: "set_level", value: 100, reply: "ack" });
      expect(sent).toMatchObject({ ok: true, result: { ok: true } });
      expect(sent.bleMs).toBeGreaterThanOrEqual(15);
      const lost = await send("lost", "control", { targetType: "network", operation: "set_level", value: 13, reply: "ack" });
      expect(lost).toMatchObject({ ok: false, error: { message: expect.stringContaining("connection was lost while sending") } });
    } finally { child.kill(); }
  });
});

describe("casambi_worker connect steps and fast writes", () => {
  /** Real worker against a fake casambi-bt that logs its connect steps and writes commands through a fake BleakClient. */
  async function worker(maxUnacknowledgedBytes = 244, failConnect = false) {
    const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "casambi-worker-writes-"));
    temporaryDirectories.push(temporaryDirectory);
    const writes = path.join(temporaryDirectory, "writes.txt");
    mkdirSync(path.join(temporaryDirectory, "CasambiBt"), { recursive: true });
    writeFileSync(path.join(temporaryDirectory, "CasambiBt", "__init__.py"), `
import asyncio, logging
from types import SimpleNamespace

UUID = "c9ffde48-ca5a-0001-ab83-8f519b482f77"
client_log = logging.getLogger("CasambiBt._client")
retry_log = logging.getLogger("bleak_retry_connector")
FAIL = ${failConnect ? "True" : "False"}

class NetworkNotFoundError(Exception): pass

def retry(message):
    # Like bleak_retry_connector: these messages are only built when DEBUG is enabled for its logger.
    if retry_log.isEnabledFor(logging.DEBUG):
        retry_log.debug("Casambi Network - AB:CD:EF:01:23:45: " + message)

async def discover():
    return [SimpleNamespace(address="AB:CD:EF:01:23:45")]

class Gatt:
    def __init__(self, label):
        self.label = label
        characteristic = SimpleNamespace(properties=["read", "write", "write-without-response", "notify"], max_write_without_response_size=${maxUnacknowledgedBytes})
        self.services = SimpleNamespace(get_characteristic=lambda uuid: characteristic if uuid == UUID else None)
    async def write_gatt_char(self, char, data, response=None):
        with open(${JSON.stringify(writes)}, "a") as handle: handle.write(f"{self.label}:{response}\\n")

class Casambi:
    def __init__(self, cachePath):
        self.units, self.groups, self.scenes = [], [], []
        self.networkId, self.networkName = "test-network", "Test network"
        self.connected = False
        self._casaClient = SimpleNamespace(_gattClient=None)
    def registerUnitChangedHandler(self, handler): pass
    def registerSwitchEventHandler(self, handler): pass
    def registerDisconnectCallback(self, handler): pass
    async def connect(self, address, password, force_offline):
        await asyncio.sleep(0.05)
        client_log.info("Connection to AB:CD:EF:01:23:45")
        retry("unexpectedly connected, disconnecting")
        retry("Connection attempt: 1")
        retry("Failed to connect: [org.bluez.Error.Failed] le-connection-abort-by-local, device_missing: False, backing off: 0.25 (attempt: 1)")
        retry("Connection attempt: 2")
        await asyncio.sleep(0.2)
        if FAIL:
            retry("Timed out trying to connect (attempt: 2)")
            try:
                raise TimeoutError("Casambi Network - AB:CD:EF:01:23:45: Failed to connect after 2 attempt(s): TimeoutError")
            except TimeoutError as cause:
                raise NetworkNotFoundError() from cause
        client_log.info("Connected to AB:CD:EF:01:23:45")
        client_log.info("[CASAMBI_RAW_PACKET] Encrypted #1: 00ff")
        await asyncio.sleep(0.05)
        client_log.info("Key exchange sucessful")
        client_log.info("Authentication successful")
        self._casaClient._gattClient = Gatt("first")
        self.connected = True
    async def setLevel(self, target, level):
        if level == 99:  # casambi-bt reconnected on its own: a new BleakClient
            self._casaClient._gattClient = Gatt("second")
        await self._casaClient._gattClient.write_gatt_char(UUID, b"command")
    async def disconnect(self): pass
`);
    const child = spawn("python3", [workerPath], {
      cwd: projectRoot,
      env: { ...process.env, NODE_ENV: "production", CASAMBI_CACHE_PATH: path.join(temporaryDirectory, "cache"), PYTHONPATH: `${temporaryDirectory}${path.delimiter}${process.env.PYTHONPATH || ""}` },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    const responses = new Map<string, (payload: Record<string, unknown>) => void>();
    let pending = "";
    child.stdout.on("data", chunk => {
      pending += chunk.toString();
      const lines = pending.split("\n"); pending = lines.pop() || "";
      for (const line of lines.filter(Boolean)) { const payload = JSON.parse(line) as Record<string, unknown>; responses.get(String(payload.id))?.(payload); }
    });
    const send = (id: string, command: string, payload: Record<string, unknown> = {}) => new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`No answer to ${command} within 3 s.`)), 3_000);
      responses.set(id, value => { clearTimeout(timeout); resolve(value); });
      child.stdin.write(`${JSON.stringify({ id, command, payload })}\n`);
    });
    const level = (id: string, value: number) => send(id, "control", { targetType: "network", operation: "set_level", value, reply: "ack" });
    const written = () => existsSync(writes) ? readFileSync(writes, "utf8").trim().split("\n") : [];
    return { child, send, level, written, stderr: () => stderr };
  }
  const credentials = (fastWrites: boolean) => ({ networkAddress: "abcdef012345", networkPassword: "not-a-real-password", fastWrites });

  it("splits a connect into its steps without printing casambi-bt's own log lines", async () => {
    const { child, send, stderr } = await worker();
    try {
      await send("connect", "configure", credentials(false));
      expect(stderr()).toMatch(/Connected in [\d.]+ s: Bluetooth scan [\d.]+ s, Casambi cloud and cache 0\.\d s, Bluetooth connect 0\.[23] s \(2 attempts: \[org\.bluez\.Error\.Failed\] le-connection-abort-by-local; closed a connection BlueZ still had open first\), key exchange 0\.\d s, authentication 0\.0 s\./);
      expect(stderr()).not.toContain("CASAMBI_RAW_PACKET");
      expect(stderr()).not.toContain("Connection to 5E");
    } finally { child.kill(); }
  });

  it("reports why the Bluetooth connection failed instead of a generic message", async () => {
    const { child, send, stderr } = await worker(244, true);
    try {
      const failed = await send("connect", "configure", credentials(false));
      expect(failed).toMatchObject({ ok: false, error: { message: "The Raspberry Pi found Casambi BLE endpoint AB:CD:EF:01:23:45 but could not open a Bluetooth connection to it: Casambi Network - AB:CD:EF:01:23:45: Failed to connect after 2 attempt(s): TimeoutError" } });
      expect(stderr()).toMatch(/Connect failed after [\d.]+ s: Bluetooth scan [\d.]+ s, Casambi cloud and cache 0\.\d s, Bluetooth connect 0\.[23] s \(2 attempts: \[org\.bluez\.Error\.Failed\] le-connection-abort-by-local, timed out; closed a connection BlueZ still had open first\); stopped: Casambi Network/);
    } finally { child.kill(); }
  });

  it("sends without response only while fast writes are on, also after casambi-bt reconnects", async () => {
    const { child, send, level, written, stderr } = await worker();
    try {
      await send("connect", "configure", credentials(false));
      expect(await level("default", 10)).toMatchObject({ ok: true, bleFast: false });
      await expect(send("on", "options", { fastWrites: true })).resolves.toMatchObject({ ok: true, result: { fastWrites: true, active: true } });
      // The notice goes to stderr, a separate pipe from the answer, so it can arrive just after it.
      await vi.waitFor(() => expect(stderr()).toContain("Fast Bluetooth writes turned on (write without response, up to 244 bytes)."));
      expect(await level("fast", 20)).toMatchObject({ ok: true, bleFast: true });
      await level("reconnected", 99); // the new client is still on the safe default for this command
      expect(await level("fast-again", 30)).toMatchObject({ bleFast: true });
      await send("off", "options", { fastWrites: false });
      expect(await level("default-again", 40)).toMatchObject({ bleFast: false });
      expect(written()).toEqual(["first:None", "first:False", "second:None", "second:False", "second:None"]);
    } finally { child.kill(); }
  });

  it("keeps the acknowledged default when the link cannot carry a whole command unacknowledged", async () => {
    const { child, send, level, written, stderr } = await worker(20);
    try {
      await send("connect", "configure", credentials(true));
      expect(stderr()).toContain("fits only 20 bytes per unacknowledged write");
      expect(await level("default", 10)).toMatchObject({ ok: true, bleFast: false });
      expect(written()).toEqual(["first:None"]);
    } finally { child.kill(); }
  });
});

