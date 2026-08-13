import { Cron } from "croner";
import { EventHub } from "./events";
import { CasambiConfig, LocalStore, ScheduleRecord } from "./store";
import type { ControlRequest } from "./casambi/types";
import { nextSolarRun, SolarLocation } from "./solar";

export type ScheduledControl = (command: ControlRequest, actor: string) => Promise<void>;

/** Validates the portable five-field schedule used internally by ordinary timer rules. */
export function validateCron(expression: string, timezone: string): void {
  if (expression.trim().split(/\s+/).length !== 5) throw new Error("Cron expression must contain five fields: minute hour day month weekday.");
  try { new Cron(expression, { timezone, paused: true }); } catch { throw new Error("The schedule or timezone is invalid."); }
}

/** Returns the next exact trigger time for a standard or dynamically calculated solar schedule. */
export function nextRunAt(schedule: ScheduleRecord, config: CasambiConfig, from = new Date()): Date | null {
  if (!schedule.enabled) return null;
  if (schedule.solar) {
    const location: SolarLocation = { latitude: config.solarLatitude ?? Number.NaN, longitude: config.solarLongitude ?? Number.NaN };
    return nextSolarRun(schedule.solar, location, schedule.timezone, from);
  }
  return new Cron(schedule.cronExpression, { timezone: schedule.timezone, paused: true }).nextRun(from) ?? null;
}

/** Reloads SQLite-backed schedules and routes executions through the same control service as the API. */
export class DurableScheduler {
  private readonly jobs = new Map<number, Cron>();
  private readonly solarTimers = new Map<number, NodeJS.Timeout>();
  public constructor(private readonly store: LocalStore, private readonly control: ScheduledControl, private readonly events: EventHub) {}

  /** Synchronizes enabled schedules at startup and after CRUD or location changes. */
  public reload(): void {
    Array.from(this.jobs.values()).forEach(job => job.stop());
    Array.from(this.solarTimers.values()).forEach(timer => clearTimeout(timer));
    this.jobs.clear(); this.solarTimers.clear();
    this.store.listSchedules().filter(schedule => schedule.enabled).forEach(schedule => this.schedule(schedule));
  }

  private schedule(schedule: ScheduleRecord): void {
    if (schedule.solar) { this.scheduleSolar(schedule); return; }
    validateCron(schedule.cronExpression, schedule.timezone);
    const job = new Cron(schedule.cronExpression, { timezone: schedule.timezone }, () => this.run(schedule.id));
    this.jobs.set(schedule.id, job);
  }

  /** Arms the next concrete solar event then recalculates after each execution because sun times vary by date. */
  private scheduleSolar(schedule: ScheduleRecord): void {
    let next: Date | null;
    try { next = nextRunAt(schedule, this.store.getCasambiConfig()); }
    catch (error) { this.store.audit(`schedule:${schedule.id}`, "schedule.solar.unavailable", { scheduleId: schedule.id, message: error instanceof Error ? error.message : "Invalid solar configuration." }); return; }
    if (!next) return;
    const delay = Math.max(1, next.getTime() - Date.now());
    // Node timers cap delays to roughly 24.8 days; re-evaluate long polar-day gaps safely.
    const cappedDelay = Math.min(delay, 24 * 60 * 60 * 1000);
    const timer = setTimeout(async () => {
      if (Date.now() + 1_000 < next!.getTime()) { this.scheduleSolar(schedule); return; }
      try { await this.run(schedule.id); }
      finally { const refreshed = this.store.getSchedule(schedule.id); if (refreshed?.enabled && refreshed.solar) this.scheduleSolar(refreshed); }
    }, cappedDelay);
    timer.unref(); this.solarTimers.set(schedule.id, timer);
  }

  private async run(scheduleId: number): Promise<void> {
    const schedule = this.store.getSchedule(scheduleId);
    if (!schedule?.enabled) return;
    const runKey = `${scheduleId}:${new Date().toISOString().slice(0, 16)}`;
    if (!this.store.claimScheduleRun(scheduleId, runKey)) return;
    try {
      await this.control(schedule.command, `schedule:${schedule.id}`);
      this.store.audit(`schedule:${schedule.id}`, "schedule.executed", { scheduleId, command: schedule.command });
      this.events.publish("schedule.executed", { scheduleId, name: schedule.name });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown schedule failure.";
      this.store.audit(`schedule:${schedule.id}`, "schedule.failed", { scheduleId, message });
      this.events.publish("schedule.failed", { scheduleId, name: schedule.name, message });
    }
  }
}
