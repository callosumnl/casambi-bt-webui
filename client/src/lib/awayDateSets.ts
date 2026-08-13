import type { AwayDateSet, Schedule } from "./localApi";

/** Attaches a shared away-date set to a browser-memory Demo timer without invoking any appliance API. */
export function attachDemoAwayDateSet(schedule: Schedule, set: AwayDateSet | null): Schedule {
  return { ...schedule, awayDateSetId: set?.id ?? null, awayDateSet: set };
}
