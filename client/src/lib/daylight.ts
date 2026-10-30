import { t } from "@/lib/i18n";

/** Mirrors `GET /admin/daylight`. */
export type DaylightInfo = {
  roomIds: number[];
  warmKelvin: number;
  coolKelvin: number;
  hasLocation: boolean;
  kelvin: number | null;
  rooms: Array<{ id: number; name: string; enabled: boolean; state: "on" | "paused" | "idle" }>;
};

/** A room's line in the panel. */
export function describeDaylightRoom(state: DaylightInfo["rooms"][number]["state"]): string {
  return state === "on" ? t("Following the day") : state === "paused" ? t("Paused: a colour was chosen by hand, until the lights go off") : t("Lights off");
}
