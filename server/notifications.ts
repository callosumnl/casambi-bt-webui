import { hostname } from "os";
import type { ConnectionStatus } from "./casambi/service";
import type { EventHub } from "./events";
import type { LocalStore, NotificationRecord } from "./store";
import type { UpdateStatus } from "./updates";

/** How long the Bluetooth connection may be down (while it should be up) before administrators are told. */
export const CONNECTION_DOWN_NOTIFY_MS = 5 * 60_000;
const TICK_MS = 60_000;
const WEBHOOK_TIMEOUT_MS = 10_000;
const WEBHOOK_SETTING = "notificationWebhookUrl";
const NOTIFIED_UPDATE_SETTING = "notifiedUpdateAt";
const TIMER_PROBLEMS = ["schedule.failed", "schedule.invalid", "schedule.solar.unavailable"];

type Sources = {
  connection: () => ConnectionStatus;
  update: () => UpdateStatus;
  /** Replaced in tests. */
  post?: (url: string, body: string) => Promise<{ status: number }>;
};

/**
 * Tells administrators about problems that need them, in the app (stored, and live over SSE) and optionally by a
 * webhook: a Bluetooth connection that stays down, timers that fail or cannot run, and failed updates. It checks
 * once a minute rather than hooking into each component, reading the connection status, the audit log (from where
 * it last looked), and the updater's status.
 */
export class Notifier {
  private timer: NodeJS.Timeout | null = null;
  private lastAuditId: number;
  private downSince: number | null = null;
  private downNotified = false;
  /** One notification per timer problem per day: an unusable timer reports itself on every reload. */
  private readonly timerProblemDays = new Map<string, string>();

  public constructor(private readonly store: LocalStore, private readonly events: EventHub, private readonly sources: Sources) {
    // Only what happens from now on; problems from before a restart were visible in the audit log already.
    this.lastAuditId = store.latestAuditId();
  }

  public start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.check(), TICK_MS);
    this.timer.unref();
  }

  public stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  public check(now = Date.now()): void {
    this.checkConnection(now);
    this.checkTimers(now);
    this.checkUpdate();
  }

  public webhookUrl(): string | null { return this.store.appSetting(WEBHOOK_SETTING); }
  public setWebhookUrl(url: string | null): void { this.store.setAppSetting(WEBHOOK_SETTING, url); }

  /** Stores the notification, sends it live to administrators, and posts it to the webhook without waiting for it. */
  public notify(input: Pick<NotificationRecord, "kind" | "severity" | "title" | "message">): NotificationRecord {
    const notification = this.store.addNotification(input);
    this.events.publish("notification", notification, "admins");
    void this.sendWebhook(notification).catch(() => undefined);
    return notification;
  }

  /** Sends a test message to the webhook and reports the outcome, for the settings page. */
  public async testWebhook(): Promise<{ ok: boolean; status: number | null; message: string }> {
    if (!this.webhookUrl()) throw new Error("A webhook URL is required for a test.");
    const outcome = await this.sendWebhook({ id: 0, kind: "test", severity: "info", title: "Test notification", message: "Notifications from Casambi BT WebUI reach this webhook.", createdAt: new Date().toISOString(), readAt: null });
    return outcome ?? { ok: false, status: null, message: "No webhook URL is set." };
  }

  private checkConnection(now: number): void {
    const status = this.sources.connection();
    // "idle" means nobody wants a connection (not configured, or disconnected by hand): nothing is wrong then.
    const down = status.phase === "connecting" || status.phase === "retrying" || status.phase === "failed";
    if (!down) {
      if (this.downNotified && status.phase === "connected") {
        this.notify({ kind: "connection.restored", severity: "info", title: "Bluetooth connection restored", message: `The Casambi network is connected again after ${minutes(now - (this.downSince ?? now))}.` });
      }
      this.downSince = null; this.downNotified = false;
      return;
    }
    this.downSince ??= now;
    if (this.downNotified || now - this.downSince < CONNECTION_DOWN_NOTIFY_MS) return;
    this.downNotified = true;
    const reason = "lastError" in status && status.lastError ? ` Last error: ${status.lastError}` : "";
    const advice = status.phase === "failed" ? " It is not retrying by itself: check the network password and address under Admin, then connect." : " The app keeps retrying; lights cannot be controlled from it meanwhile. The system check under Admin can help.";
    this.notify({ kind: "connection.lost", severity: "error", title: "Bluetooth connection lost", message: `The Casambi network has not been connected for ${minutes(now - this.downSince)}.${advice}${reason}` });
  }

  private checkTimers(now: number): void {
    const entries = this.store.auditSince(this.lastAuditId, TIMER_PROBLEMS);
    for (const entry of entries) {
      this.lastAuditId = entry.id;
      const scheduleId = Number(entry.detail.scheduleId);
      const day = new Date(now).toISOString().slice(0, 10);
      const key = `${entry.action}:${scheduleId}`;
      if (entry.action !== "schedule.failed" && this.timerProblemDays.get(key) === day) continue;
      this.timerProblemDays.set(key, day);
      const name = this.store.getSchedule(scheduleId)?.name ?? `#${scheduleId}`;
      const detail = typeof entry.detail.message === "string" ? ` ${entry.detail.message}` : "";
      if (entry.action === "schedule.failed") this.notify({ kind: "timer.failed", severity: "warning", title: `Timer "${name}" failed`, message: `The timer ran but its command failed.${detail}` });
      else this.notify({ kind: "timer.unusable", severity: "warning", title: `Timer "${name}" cannot run`, message: `The timer is not scheduled until it is fixed.${detail}` });
    }
    if (!entries.length) this.lastAuditId = Math.max(this.lastAuditId, this.store.latestAuditId());
  }

  private checkUpdate(): void {
    const status = this.sources.update();
    if ((status.state !== "rolled_back" && status.state !== "failed") || !status.finishedAt) return;
    // Remembered in the database: the service restarts during an update, so this runs in a fresh process.
    if (this.store.appSetting(NOTIFIED_UPDATE_SETTING) === status.finishedAt) return;
    this.store.setAppSetting(NOTIFIED_UPDATE_SETTING, status.finishedAt);
    this.notify({ kind: "update.failed", severity: "error", title: status.state === "rolled_back" ? "Update failed and was undone" : "Update failed", message: status.message ?? "See Admin → Updates for the log." });
  }

  private async sendWebhook(notification: NotificationRecord): Promise<{ ok: boolean; status: number | null; message: string } | null> {
    const url = this.webhookUrl();
    if (!url) return null;
    // `text` is what Slack, Mattermost, and Google Chat show; the other fields are for Home Assistant, n8n, and the like.
    const body = JSON.stringify({ text: `${notification.title}: ${notification.message}`, title: notification.title, message: notification.message, severity: notification.severity, kind: notification.kind, at: notification.createdAt, host: hostname() });
    try {
      const { status } = await (this.sources.post ?? post)(url, body);
      if (status >= 200 && status < 300) return { ok: true, status, message: `The webhook answered ${status}.` };
      this.store.audit("notifier", "notification.webhook_failed", { kind: notification.kind, status });
      return { ok: false, status, message: `The webhook answered ${status}.` };
    } catch (error) {
      const message = error instanceof Error ? error.message : "The request failed.";
      this.store.audit("notifier", "notification.webhook_failed", { kind: notification.kind, message });
      return { ok: false, status: null, message: `The webhook could not be reached: ${message}` };
    }
  }
}

/** Redirects are not followed: the configured URL is the only place a notification goes. */
async function post(url: string, body: string): Promise<{ status: number }> {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body, redirect: "manual", signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS) });
  return { status: response.status };
}

function minutes(ms: number): string {
  const total = Math.max(1, Math.round(ms / 60_000));
  return total === 1 ? "1 minute" : total < 120 ? `${total} minutes` : `${Math.round(total / 60)} hours`;
}
