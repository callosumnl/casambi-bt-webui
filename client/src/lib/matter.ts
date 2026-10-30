import { t } from "@/lib/i18n";

/** Mirrors `GET /admin/matter`. */
export type MatterInfo = {
  enabled: boolean;
  name: string;
  port: number;
  vendorId: number;
  productId: number;
  state: "disabled" | "starting" | "running" | "failed";
  error: string | null;
  commissioned: boolean;
  fabrics: Array<{ index: number; owner: string }>;
  pairingWindowUntil: string | null;
  manualPairingCode: string | null;
  qrPairingCode: string | null;
  qrSvg: string | null;
};

/** The panel's status line. */
export function describeMatter(info: MatterInfo): string {
  if (info.state === "failed") return t("The Matter bridge could not start: {error}", { error: info.error ?? t("unknown error") });
  if (info.state === "disabled") return t("The Matter bridge is off.");
  if (info.state === "starting") return t("Starting the Matter bridge…");
  if (!info.commissioned) return t("Ready to pair: in the Google Home app choose + → Device → Matter device, and scan the code.");
  if (info.pairingWindowUntil) return t("Another app can add the bridge with the code until {time}.", { time: new Date(info.pairingWindowUntil).toLocaleTimeString() });
  return info.fabrics.length === 1 ? t("Paired with {owner}.", { owner: info.fabrics[0].owner }) : t("Paired with {count} apps.", { count: info.fabrics.length });
}

/** The 11-digit manual code as the Google Home app shows it: 1234-567-8901. */
export function formatManualCode(code: string): string {
  return code.length === 11 ? `${code.slice(0, 4)}-${code.slice(4, 7)}-${code.slice(7)}` : code;
}

/** 0xFFF1 for the form. */
export function formatId(value: number): string { return `0x${value.toString(16).toUpperCase().padStart(4, "0")}`; }
/** Accepts 0xFFF1, FFF1 is not accepted (ambiguous), and plain decimal; NaN when invalid. */
export function parseId(text: string): number {
  const trimmed = text.trim();
  if (/^0x[0-9a-f]{1,4}$/i.test(trimmed)) return parseInt(trimmed.slice(2), 16);
  return /^\d{1,5}$/.test(trimmed) ? Number(trimmed) : Number.NaN;
}
