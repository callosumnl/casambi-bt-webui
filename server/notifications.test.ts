import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import type { ConnectionStatus } from "./casambi/service";
import { EventHub } from "./events";
import { CONNECTION_DOWN_NOTIFY_MS, Notifier } from "./notifications";
import { LocalStore } from "./store";
import type { UpdateStatus } from "./updates";

const folders: string[] = [];
afterEach(() => folders.splice(0).forEach(folder => rmSync(folder, { recursive: true, force: true })));

function setup() {
  const folder = mkdtempSync(join(tmpdir(), "casambi-notify-")); folders.push(folder);
  const store = new LocalStore(join(folder, "state.db"), "key");
  const state: { connection: ConnectionStatus; update: UpdateStatus } = { connection: { phase: "idle" }, update: {} };
  const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
  let answer = 200;
  const events = new EventHub();
  const published: unknown[] = [];
  events.publish = (type, payload) => { if (type === "notification") published.push(payload); };
  const notifier = new Notifier(store, events, {
    connection: () => state.connection, update: () => state.update,
    post: async (url, body) => { posts.push({ url, body: JSON.parse(body) as Record<string, unknown> }); return { status: answer }; },
  });
  return { store, state, posts, published, notifier, setAnswer: (status: number) => { answer = status; } };
}
const titles = (store: LocalStore) => store.listNotifications().map(notification => notification.title).reverse();

describe("Notifier", () => {
  it("reports a connection that stays down once, and its recovery, but not a manual disconnect", () => {
    const { store, state, notifier, published } = setup();
    const start = Date.parse("2026-10-28T10:00:00Z");
    state.connection = { phase: "retrying", attempt: 3, nextRetryAt: "", lastError: "Device not found" };
    notifier.check(start);
    notifier.check(start + CONNECTION_DOWN_NOTIFY_MS - 1);
    expect(titles(store)).toEqual([]);
    notifier.check(start + CONNECTION_DOWN_NOTIFY_MS);
    notifier.check(start + CONNECTION_DOWN_NOTIFY_MS * 3);
    expect(store.listNotifications()[0]).toMatchObject({ kind: "connection.lost", severity: "error", message: expect.stringContaining("not been connected for 5 minutes. The app keeps retrying") });
    expect(store.listNotifications()[0].message).toContain("Last error: Device not found");
    state.connection = { phase: "connected" };
    notifier.check(start + CONNECTION_DOWN_NOTIFY_MS * 4);
    expect(titles(store)).toEqual(["Bluetooth connection lost", "Bluetooth connection restored"]);
    expect(published).toHaveLength(2);

    // A short drop, and a disconnect by hand ("idle"), stay quiet.
    state.connection = { phase: "connecting", attempt: 1 };
    notifier.check(start + CONNECTION_DOWN_NOTIFY_MS * 5);
    state.connection = { phase: "idle" };
    notifier.check(start + CONNECTION_DOWN_NOTIFY_MS * 20);
    expect(store.unreadNotificationCount()).toBe(2);
  });

  it("reports failed timers each time, and an unusable timer once a day", () => {
    const { store, notifier } = setup();
    const owner = store.createUser("chris", "a-strong-password", "admin");
    const schedule = store.createSchedule({ name: "Morning", cronExpression: "0 8 * * *", timezone: "UTC", command: { targetType: "network", operation: "on" }, solar: null, holidayDates: [], awayDateSetId: null, awayDateSet: null, enabled: true, ownerUserId: owner.id });
    store.audit(`schedule:${schedule.id}`, "schedule.failed", { scheduleId: schedule.id, message: "Not connected." });
    store.audit(`schedule:${schedule.id}`, "schedule.executed", { scheduleId: schedule.id });
    store.audit(`schedule:${schedule.id}`, "schedule.solar.unavailable", { scheduleId: schedule.id, message: "Set a location." });
    notifier.check(Date.parse("2026-10-28T10:00:00Z"));
    store.audit(`schedule:${schedule.id}`, "schedule.solar.unavailable", { scheduleId: schedule.id, message: "Set a location." });
    store.audit(`schedule:${schedule.id}`, "schedule.failed", { scheduleId: schedule.id, message: "Not connected." });
    notifier.check(Date.parse("2026-10-28T10:01:00Z"));
    expect(titles(store)).toEqual(['Timer "Morning" failed', 'Timer "Morning" cannot run', 'Timer "Morning" failed']);
    store.audit(`schedule:${schedule.id}`, "schedule.solar.unavailable", { scheduleId: schedule.id, message: "Set a location." });
    notifier.check(Date.parse("2026-10-29T10:00:00Z"));
    expect(store.listNotifications()[0]).toMatchObject({ title: 'Timer "Morning" cannot run', message: "The timer is not scheduled until it is fixed. Set a location." });
  });

  it("reports a failed update once, also after the restart that follows it", () => {
    const { store, state, notifier } = setup();
    state.update = { state: "rolled_back", message: "The build failed; the previous version was restored.", finishedAt: "2026-10-28T03:00:00Z" };
    notifier.check();
    notifier.check();
    const afterRestart = new Notifier(store, new EventHub(), { connection: () => ({ phase: "idle" }), update: () => state.update });
    afterRestart.check();
    expect(titles(store)).toEqual(["Update failed and was undone"]);
  });

  it("posts each notification to the webhook and records a webhook that refuses", async () => {
    const { store, notifier, posts, setAnswer } = setup();
    notifier.notify({ kind: "test.none", severity: "info", title: "Nothing sent", message: "No webhook yet." });
    await expect(notifier.testWebhook()).rejects.toThrow("A webhook URL is required");
    notifier.setWebhookUrl("https://hooks.example.test/abc-secret");
    await expect(notifier.testWebhook()).resolves.toEqual({ ok: true, status: 200, message: "The webhook answered 200." });
    expect(posts[0]).toMatchObject({ url: "https://hooks.example.test/abc-secret", body: { title: "Test notification", severity: "info", text: expect.stringContaining("Test notification: ") } });
    setAnswer(404);
    notifier.notify({ kind: "connection.lost", severity: "error", title: "Bluetooth connection lost", message: "Down." });
    await new Promise(resolve => setImmediate(resolve));
    expect(posts).toHaveLength(2);
    expect(store.recentAudit(5, "notification.")).toEqual([expect.objectContaining({ action: "notification.webhook_failed", detail: { kind: "connection.lost", status: 404 } })]);
    expect(JSON.stringify(store.recentAudit(5, "notification."))).not.toContain("abc-secret");
  });
});
