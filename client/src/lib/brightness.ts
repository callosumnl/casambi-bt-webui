/** Converts a Casambi protocol dimmer level (0–255) into a bounded display percentage. */
export function dimmerToPercent(level: number | null | undefined): number {
  return Math.max(0, Math.min(100, Math.round(((level ?? 0) / 255) * 100)));
}

/** Converts a user-selected percentage into the integer Casambi protocol dimmer level (0–255). */
export function percentToDimmer(percent: number): number {
  return Math.max(0, Math.min(255, Math.round((Math.max(0, Math.min(100, percent)) / 100) * 255)));
}
