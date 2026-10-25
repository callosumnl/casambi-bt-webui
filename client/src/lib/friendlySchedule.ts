/** Supported repeat choices shown in the user-friendly schedule editor. */
export type RepeatPattern = "daily" | "weekdays" | "weekends" | "custom";

export const WEEKDAYS = [
  { value: "1", short: "Mon", full: "Monday" },
  { value: "2", short: "Tue", full: "Tuesday" },
  { value: "3", short: "Wed", full: "Wednesday" },
  { value: "4", short: "Thu", full: "Thursday" },
  { value: "5", short: "Fri", full: "Friday" },
  { value: "6", short: "Sat", full: "Saturday" },
  { value: "0", short: "Sun", full: "Sunday" },
] as const;

/** Turns a local time and plain-language repeat selection into the scheduler's five-field cron expression. */
export function toCronExpression(time: string, repeat: RepeatPattern, selectedDays: string[] = []): string {
  const matched = /^(\d{2}):(\d{2})$/.exec(time);
  if (!matched) throw new Error("Choose a valid time.");
  const hour = Number(matched[1]); const minute = Number(matched[2]);
  if (hour > 23 || minute > 59) throw new Error("Choose a valid time.");
  const days = repeat === "daily" ? "*" : repeat === "weekdays" ? "1-5" : repeat === "weekends" ? "0,6" : [...selectedDays].sort((a, b) => Number(a) - Number(b)).join(",");
  if (!days) throw new Error("Choose at least one day.");
  return `${minute} ${hour} * * ${days}`;
}

/** Reads back a cron expression made by this editor (time and weekdays); null for any other cron, which the editor cannot show. */
export function fromCronExpression(expression: string): { time: string; repeat: RepeatPattern; days: string[] } | null {
  const [minute, hour, dayOfMonth, month, dayOfWeek, extra] = expression.trim().split(/\s+/);
  if (extra !== undefined || dayOfMonth !== "*" || month !== "*" || !/^\d{1,2}$/.test(minute ?? "") || !/^\d{1,2}$/.test(hour ?? "") || Number(hour) > 23 || Number(minute) > 59) return null;
  const time = `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
  if (dayOfWeek === "*") return { time, repeat: "daily", days: [] };
  if (dayOfWeek === "1-5") return { time, repeat: "weekdays", days: defaultDaysForRepeat("weekdays") };
  if (dayOfWeek === "0,6" || dayOfWeek === "6,0") return { time, repeat: "weekends", days: defaultDaysForRepeat("weekends") };
  const days = (dayOfWeek ?? "").split(",").map(day => day === "7" ? "0" : day);
  return days.length && days.every(day => /^[0-6]$/.test(day)) ? { time, repeat: "custom", days } : null;
}

/** Produces a compact human-readable description for standard schedules made in this UI. */
export function describeCronExpression(expression: string): string {
  const [minute, hour, dayOfMonth, month, dayOfWeek] = expression.trim().split(/\s+/);
  if (!minute || !hour || dayOfMonth !== "*" || month !== "*" || !/^\d{1,2}$/.test(minute) || !/^\d{1,2}$/.test(hour)) return "Custom schedule";
  const time = `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
  if (dayOfWeek === "*") return `Every day at ${time}`;
  if (dayOfWeek === "1-5") return `Every weekday at ${time}`;
  if (dayOfWeek === "0,6" || dayOfWeek === "6,0") return `Every weekend at ${time}`;
  const names = dayOfWeek.split(",").map(day => WEEKDAYS.find(candidate => candidate.value === day)?.short).filter(Boolean);
  return names.length ? `${names.join(", ")} at ${time}` : `Scheduled at ${time}`;
}

/** Returns the selected days appropriate for a newly chosen repeat pattern. */
export function defaultDaysForRepeat(repeat: RepeatPattern): string[] {
  if (repeat === "weekdays") return ["1", "2", "3", "4", "5"];
  if (repeat === "weekends") return ["0", "6"];
  return [];
}
