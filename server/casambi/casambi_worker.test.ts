import { spawn } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
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
      child.stdin.write(`${JSON.stringify({ id: "cache-path", command: "configure", payload: { networkAddress: "00:11:22:33:44:55", networkPassword: "not-a-real-password" } })}\n`);
      await expect(response).resolves.toMatchObject({ id: "cache-path", ok: true, result: { connected: true } });
      expect(readFileSync(path.join(cachePath, "selected-path.txt"), "utf8")).toBe(cachePath);
    } finally {
      child.kill();
    }
  });
});
