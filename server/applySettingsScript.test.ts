import { spawnSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { createServer } from "net";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { afterEach, describe, expect, it } from "vitest";

const script = resolve(import.meta.dirname, "..", "deploy", "apply-settings.sh");
const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) {
    const pid = join(folder, "server.pid");
    if (existsSync(pid)) spawnSync("kill", [readFileSync(pid, "utf8").trim()]);
    rmSync(folder, { recursive: true, force: true });
  }
});

const freePort = () => new Promise<number>(done => { const server = createServer(); server.listen(0, () => { const { port } = server.address() as { port: number }; server.close(() => done(port)); }); });

/** An env file, an avahi file, and a fake "restart" that serves /api/v1/health on the env file's PORT, except `brokenPort`. */
async function setup(brokenPort = 0) {
  const root = mkdtempSync(join(tmpdir(), "casambi-settings-")); folders.push(root);
  const oldPort = await freePort();
  const env = join(root, "casambi.env"); const avahi = join(root, "avahi.service"); const request = join(root, "settings", "request.json"); const state = join(root, "state");
  mkdirSync(join(root, "settings")); mkdirSync(join(root, "www", "api", "v1"), { recursive: true }); writeFileSync(join(root, "www", "api", "v1", "health"), "ok");
  writeFileSync(env, `PORT=${oldPort}\nNODE_ENV=production\nCASAMBI_JWT_SECRET=keep-me\n# CASAMBI_TRUST_PROXY=true\n`);
  writeFileSync(avahi, `<service><port>${oldPort}</port></service>\n`);
  const restart = join(root, "restart.sh");
  writeFileSync(restart, `#!/usr/bin/env bash
[[ -f "${root}/server.pid" ]] && kill "$(cat "${root}/server.pid")" 2>/dev/null; sleep 0.3
port="$(grep '^PORT=' "${env}" | cut -d= -f2)"
[[ "$port" == "${brokenPort}" ]] && exit 0
cd "${root}/www" || exit 1
# Started directly (not "cd && … &", which backgrounds a subshell that keeps the caller's output pipe open).
python3 -m http.server "$port" --bind 127.0.0.1 </dev/null >/dev/null 2>&1 &
echo $! > "${root}/server.pid"
`, { mode: 0o755 });
  spawnSync("bash", [restart], { stdio: "ignore" });
  const run = (body: string) => {
    writeFileSync(request, body);
    const result = spawnSync("bash", [script], { encoding: "utf8", env: { ...process.env, REQUEST: request, STATE_DIR: state, ENV_FILE: env, AVAHI_FILE: avahi, RESTART: restart, HEALTH_SECONDS: "5" } });
    return { exit: result.status, status: JSON.parse(readFileSync(join(state, "settings-status.json"), "utf8")) as { state: string; message: string }, env: readFileSync(env, "utf8"), avahi: readFileSync(avahi, "utf8"), requestLeft: existsSync(request) };
  };
  return { oldPort, run, request };
}

describe("deploy/apply-settings.sh", () => {
  it("moves the app to a new port and trusts the proxy, keeping the other settings", async () => {
    const { run } = await setup();
    const newPort = await freePort();
    const result = run(JSON.stringify({ port: newPort, trustProxy: true }));
    expect(result).toMatchObject({ exit: 0, requestLeft: false, status: { state: "applied", message: `Saved. The app now runs on port ${newPort}, trusting the reverse proxy's client addresses.` } });
    expect(result.env).toBe(`PORT=${newPort}\nNODE_ENV=production\nCASAMBI_JWT_SECRET=keep-me\nCASAMBI_TRUST_PROXY=true\n`);
    expect(result.avahi).toBe(`<service><port>${newPort}</port></service>\n`);
  }, 20_000);

  it("restores the previous settings when the app does not answer on the new port", async () => {
    const broken = await freePort();
    const { run, oldPort } = await setup(broken);
    const result = run(JSON.stringify({ port: broken, trustProxy: false }));
    expect(result).toMatchObject({ exit: 1, status: { state: "rolled_back", message: `The app did not start on port ${broken}, so the previous settings (port ${oldPort}) were restored.` } });
    expect(result.env).toContain(`PORT=${oldPort}\n`);
    expect(result.avahi).toContain(`<port>${oldPort}</port>`);
  }, 30_000);

  it("rejects anything but exactly a valid port and a boolean, and never follows a symlink", async () => {
    const { run, oldPort, request } = await setup();
    for (const body of [JSON.stringify({ port: 80, trustProxy: false }), JSON.stringify({ port: "4000", trustProxy: false }), JSON.stringify({ port: 4000, trustProxy: false, extra: 1 }), "not json"]) {
      const result = run(body);
      expect(result).toMatchObject({ exit: 1, requestLeft: false, status: { state: "failed", message: "The settings request was rejected as invalid." } });
      expect(result.env).toContain(`PORT=${oldPort}\n`);
    }
    rmSync(request, { force: true });
    symlinkSync("/etc/hosts", request);
    const result = spawnSync("bash", [script], { encoding: "utf8", env: { ...process.env, REQUEST: request, STATE_DIR: join(folders[0], "state") } });
    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain("localhost");
  }, 20_000);
});
