import { t } from "@/lib/i18n";

/** Mirrors `GET /admin/homekit`. */
export type HomeKitInfo = {
  enabled: boolean;
  name: string;
  port: number;
  state: "disabled" | "starting" | "published" | "failed";
  error: string | null;
  advertised: boolean;
  advertiser: string;
  pincode: string;
  setupUri: string | null;
  qrSvg: string | null;
  pairings: number;
};

/** The panel's status line. */
export function describeHomeKit(info: HomeKitInfo): string {
  if (info.state === "failed") return t("HomeKit could not start: {error}", { error: info.error ?? t("unknown error") });
  if (info.state === "disabled") return t("HomeKit is off.");
  if (info.state === "starting") return t("Starting HomeKit…");
  if (!info.advertised) return t("Published on port {port}, but not yet announced on the network ({advertiser}). The Home app cannot find it until it is.", { port: info.port, advertiser: info.advertiser });
  if (info.pairings === 0) return t("Ready to pair: in the Home app choose Add Accessory and scan the code.");
  return info.pairings === 1 ? t("Paired with Apple Home.") : t("Paired with Apple Home ({count} controllers).", { count: info.pairings });
}

/** The QR code as an image source; the page's Content-Security-Policy allows data: images. */
export function qrImageSource(svg: string): string { return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`; }
