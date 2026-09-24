import { spawn, spawnSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";

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
    child.stderr.on("data", chunk => { clearTimeout(timeout); reject(new Error(chunk.toString())); });
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
