import { spawnSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { afterEach, describe, expect, it } from "vitest";

const script = resolve(import.meta.dirname, "..", "deploy", "update.sh");
const folders: string[] = [];
afterEach(() => folders.splice(0).forEach(folder => rmSync(folder, { recursive: true, force: true })));

/** A checkout with an upstream, plus a fake install.sh that fails while the checkout contains BROKEN. */
function setup() {
  const root = mkdtempSync(join(tmpdir(), "casambi-update-")); folders.push(root);
  const git = (cwd: string, ...args: string[]) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  const upstream = join(root, "upstream.git"); const app = join(root, "app"); const publisher = join(root, "publisher");
  git(root, "init", "--quiet", "--bare", "--initial-branch=main", upstream);
  git(root, "clone", "--quiet", upstream, publisher);
  writeFileSync(join(publisher, "README"), "v1\n");
  git(publisher, "add", "README"); git(publisher, "commit", "--quiet", "-m", "First version"); git(publisher, "push", "--quiet", "origin", "main");
  git(root, "clone", "--quiet", upstream, app);
  const install = join(root, "install.sh");
  writeFileSync(install, `#!/usr/bin/env bash\necho "installing $(cat "${app}/README")"\n[[ ! -e "${app}/BROKEN" ]]\n`, { mode: 0o755 });
  const state = join(root, "state"); const requests = join(root, "requests"); mkdirSync(requests);
  const publish = (file: string, content: string, message: string) => { writeFileSync(join(publisher, file), content); git(publisher, "add", file); git(publisher, "commit", "--quiet", "-m", message); git(publisher, "push", "--quiet", "origin", "main"); return git(publisher, "rev-parse", "HEAD"); };
  const run = (mode: string) => {
    writeFileSync(join(requests, `${mode}-request`), "");
    const result = spawnSync("bash", [script, mode], { encoding: "utf8", env: { ...process.env, APP_DIR: app, STATE_DIR: state, REQUEST_DIR: requests, INSTALL: install } });
    return { exit: result.status, status: JSON.parse(readFileSync(join(state, "status.json"), "utf8")) as Record<string, unknown>, requestLeft: existsSync(join(requests, `${mode}-request`)) };
  };
  return { app, run, publish, head: () => git(app, "rev-parse", "HEAD") };
}

describe("deploy/update.sh", () => {
  it("reports up to date, then the new changes, without touching the checkout", () => {
    const { run, publish, head } = setup();
    const before = head();
    expect(run("check")).toMatchObject({ exit: 0, requestLeft: false, status: { state: "up_to_date", behind: 0, changes: [] } });
    publish("README", "v2\n", "Second version");
    const checked = run("check");
    expect(checked).toMatchObject({ exit: 0, status: { state: "available", behind: 1, changes: ["Second version"], currentSubject: "First version", latestSubject: "Second version" } });
    expect(head()).toBe(before);
  });

  it("fast-forwards and installs the new version", () => {
    const { run, publish, head } = setup();
    const latest = publish("README", "v2\n", "Second version");
    const applied = run("apply");
    expect(applied).toMatchObject({ exit: 0, status: { state: "updated", current: latest, currentSubject: "Second version", behind: 0 } });
    expect(String(applied.status.logTail)).toContain("installing v2");
    expect(head()).toBe(latest);
  });

  it("goes back to the previous version when installing the new one fails", () => {
    const { run, publish, head } = setup();
    const before = head();
    publish("BROKEN", "", "A broken release");
    const applied = run("apply");
    expect(applied).toMatchObject({ exit: 1, status: { state: "rolled_back", message: expect.stringContaining(`${before.slice(0, 7)} was restored`) } });
    expect(String(applied.status.logTail)).toContain("Update failed; restoring");
    expect(head()).toBe(before);
  });

  it("refuses to update a checkout with local changes", () => {
    const { app, run, publish, head } = setup();
    const before = head();
    publish("README", "v2\n", "Second version");
    writeFileSync(join(app, "README"), "edited on the Pi\n");
    expect(run("apply")).toMatchObject({ exit: 1, status: { state: "failed", message: expect.stringContaining("local changes") } });
    expect(head()).toBe(before);
    expect(readFileSync(join(app, "README"), "utf8")).toBe("edited on the Pi\n");
  });
});
