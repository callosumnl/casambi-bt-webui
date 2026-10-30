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
  lights: number;
  lightsNotShown: number;
  accessories: HomeKitAccessory[];
};

/** One lamp, group, room, or scene HomeKit can show. */
export type HomeKitAccessory = { key: string; kind: "unit" | "group" | "room" | "scene" | "local_scene" | "switch"; name: string; shown: boolean };
const KIND_ORDER: HomeKitAccessory["kind"][] = ["unit", "group", "room", "scene", "local_scene", "switch"];

export function accessoryKindLabel(kind: HomeKitAccessory["kind"]): string {
  switch (kind) {
    case "unit": return t("LAMPS");
    case "group": return t("CASAMBI GROUPS");
    case "room": return t("ROOMS");
    case "scene": return t("CASAMBI SCENES");
    case "local_scene": return t("SAVED SCENES");
    case "switch": return t("WALL SWITCHES");
  }
}

/** The accessories by kind, in a fixed order, each sorted by name; kinds without entries are left out. */
export function groupAccessories(accessories: HomeKitAccessory[]): Array<{ kind: HomeKitAccessory["kind"]; entries: HomeKitAccessory[] }> {
  return KIND_ORDER.map(kind => ({ kind, entries: accessories.filter(entry => entry.kind === kind).sort((left, right) => left.name.localeCompare(right.name)) }))
    .filter(group => group.entries.length > 0);
}

/** The panel's status line. */
export function describeHomeKit(info: HomeKitInfo): string {
  if (info.state === "failed") return t("HomeKit could not start: {error}", { error: info.error ?? t("unknown error") });
  if (info.state === "disabled") return t("HomeKit is off.");
  if (info.state === "starting") return t("Starting HomeKit…");
  if (!info.advertised) return t("Published on port {port}, but not yet announced on the network ({advertiser}). The Home app cannot find it until it is.", { port: info.port, advertiser: info.advertiser });
  if (info.pairings === 0) return t("Ready to pair: in the Home app choose Add Accessory and scan the code.");
  return info.pairings === 1 ? t("Paired with Apple Home.") : t("Paired with Apple Home ({count} controllers).", { count: info.pairings });
}

/** How many lamps, groups, rooms, and scenes HomeKit shows, or null while nothing is published. */
export function describeHomeKitLights(info: HomeKitInfo): string | null {
  if (info.state !== "published") return null;
  const shown = info.lights === 1 ? t("1 accessory in HomeKit.") : t("{count} accessories (lamps, groups, rooms, and scenes) in HomeKit.", { count: info.lights });
  return info.lightsNotShown ? `${shown} ${t("{count} more do not fit: HomeKit allows 149 per bridge.", { count: info.lightsNotShown })}` : shown;
}

/** The QR code as an image source; the page's Content-Security-Policy allows data: images. */
export function qrImageSource(svg: string): string { return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`; }
