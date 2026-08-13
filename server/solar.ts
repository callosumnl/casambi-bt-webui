import { getTimes } from "suncalc";

export type SolarEvent = "sunrise" | "sunset";
export type SolarSchedule = { event: SolarEvent; offsetMinutes: number };
export type SolarLocation = { latitude: number; longitude: number };

/** Validates location inputs before they are persisted for local sun-time calculation. */
export function validateSolarLocation(location: Partial<SolarLocation>): asserts location is SolarLocation {
  if (!Number.isFinite(location.latitude) || !Number.isFinite(location.longitude) || Math.abs(Number(location.latitude)) > 90 || Math.abs(Number(location.longitude)) > 180) {
    throw new Error("A valid latitude and longitude are required for sunrise and sunset timers.");
  }
}

/** Validates the compact solar metadata attached to a durable schedule. */
export function validateSolarSchedule(solar: SolarSchedule): void {
  if (!["sunrise", "sunset"].includes(solar.event) || !Number.isInteger(solar.offsetMinutes) || solar.offsetMinutes < -180 || solar.offsetMinutes > 180) {
    throw new Error("Solar timer offsets must be whole minutes from 180 before to 180 after sunrise or sunset.");
  }
}

type CalendarDay = { year: number; month: number; day: number };

/** Returns calendar parts at the configured lighting site's timezone without depending on host timezone. */
function calendarDay(date: Date, timezone: string): CalendarDay {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const value = (type: string) => Number(parts.find(part => part.type === type)?.value);
  return { year: value("year"), month: value("month"), day: value("day") };
}

function addDays(day: CalendarDay, amount: number): CalendarDay {
  const value = new Date(Date.UTC(day.year, day.month - 1, day.day + amount));
  return { year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: value.getUTCDate() };
}

/** Returns the next concrete sunrise or sunset instant for a location, including its bounded minute offset. */
export function nextSolarRun(solar: SolarSchedule, location: SolarLocation, timezone: string, from = new Date()): Date | null {
  validateSolarSchedule(solar); validateSolarLocation(location);
  const start = calendarDay(from, timezone);
  for (let offset = 0; offset <= 370; offset += 1) {
    const day = addDays(start, offset);
    // Midday UTC selects the intended civil date independently of the host system timezone.
    const sunTimes = getTimes(new Date(Date.UTC(day.year, day.month - 1, day.day, 12)), location.latitude, location.longitude);
    const source = sunTimes[solar.event];
    if (!source) continue;
    const candidate = new Date(source.getTime() + solar.offsetMinutes * 60_000);
    if (candidate.getTime() > from.getTime()) return candidate;
  }
  return null;
}

/** Converts a solar event and offset into a concise user-facing phrase. */
export function describeSolarSchedule(solar: SolarSchedule): string {
  const label = solar.event === "sunrise" ? "sunrise" : "sunset";
  if (solar.offsetMinutes === 0) return `At ${label}`;
  const minutes = Math.abs(solar.offsetMinutes);
  return `${minutes} min ${solar.offsetMinutes > 0 ? "after" : "before"} ${label}`;
}
