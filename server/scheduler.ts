import { Cron } from "croner";
import { EventHub } from "./events";
import { LocalStore, ScheduleRecord } from "./store";
import type { ControlRequest } from "./casambi/types";

export type ScheduledControl = (command: ControlRequest, actor: string) => Promise<void>;

/** Validates the portable five-field cron schedule entered by users. */
export function validateCron(expression: string, timezone: string): void {
  if (expression.trim().split(/\s+/).length !== 5) throw new Error("Cron expression must contain five fields: minute hour day month weekday.");
  try { new Cron(expression, { timezone, paused: true }); } catch { throw new Error("The cron expression or timezone is invalid."); }
}

/** Reloads SQLite-backed schedules and routes executions through the same control service as the API. */
export class DurableScheduler {
  private readonly jobs = new Map<number, Cron>();
  public constructor(private readonly store: LocalStore, private readonly control: ScheduledControl, private readonly events: EventHub) {}

  /** Synchronizes all enabled schedules after startup or a schedule CRUD operation. */
  public reload(): void {
    Array.from(this.jobs.values()).forEach(job => job.stop());
    this.jobs.clear();
    this.store.listSchedules().filter(schedule => schedule.enabled).forEach(schedule => this.schedule(schedule));
  }

  private schedule(schedule: ScheduleRecord): void {
    validateCron(schedule.cronExpression, schedule.timezone);
    const job = new Cron(schedule.cronExpression, { timezone: schedule.timezone }, () => this.run(schedule.id));
    this.jobs.set(schedule.id, job);
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
