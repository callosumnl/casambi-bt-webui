/** Mirrors the server's `GET /admin/diagnostics`. */
export type SystemCheck = {
  generatedAt: string;
  checks: Array<{ id: string; title: string; status: "ok" | "warn" | "fail" | "info"; detail: string; advice?: string }>;
  versions: Record<string, string | null>;
};

/** How usable a Bluetooth signal is; Casambi connects reliably above about -80 dBm. */
export function signalQuality(rssi: number | null): { status: "ok" | "warn"; label: string } {
  if (rssi === null) return { status: "warn", label: "unknown" };
  if (rssi >= -67) return { status: "ok", label: "strong" };
  if (rssi >= -80) return { status: "ok", label: "good enough" };
  return { status: "warn", label: "weak; move the Pi closer to a Casambi unit or use a USB Bluetooth adapter with an antenna" };
}
