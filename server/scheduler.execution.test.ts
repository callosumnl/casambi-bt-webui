import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { EventHub } from "./events";
import { DurableScheduler } from "./scheduler";
import { LocalStore } from "./store";

const folders: string[] = [];
function setup() {
  const folder = mkdtempSync(join(tmpdir(), "casambi-scheduler-")); folders.push(folder);
  const store = new LocalStore(join(folder, "state.db"), "scheduler-test-key");
  const user = store.createUser("operator", "a-strong-test-password", "user");
  const calls: string[] = [];
  const scheduler = new DurableScheduler(store, async (command, actor) => { calls.push(`${actor}:${command.operation}`); }, new EventHub());
  const schedule = store.createSchedule({ name: "Test on", cronExpression: "0 8 * * *", timezone: "UTC", command: { targetType: "network", operation: "on" }, enabled: true, ownerUserId: user.id });
  return { store, scheduler, schedule, calls };
}
afterEach(() => folders.splice(0).forEach(folder => rmSync(folder, { recursive: true, force: true })));

describe("DurableScheduler execution", () => {
  it("executes a stored rule once and prevents duplicate execution in the same minute", async () => {
    const { store, scheduler, schedule, calls } = setup();
    const run = (scheduler as unknown as { run: (id: number) => Promise<void> }).run.bind(scheduler);
    await run(schedule.id);
    await run(schedule.id);
    expect(calls).toEqual([`schedule:${schedule.id}:on`]);
    expect(store.getSchedule(schedule.id)?.lastRunAt).toEqual(expect.any(String));
  });
});
