import { t } from "@/lib/i18n";

/** The Admin page's sections; each has its own address, /admin/<id>, so links and the back button work. */
export const ADMIN_SECTIONS = ["connection", "rooms", "automation", "access", "homekit", "google", "system"] as const;
export type AdminSection = (typeof ADMIN_SECTIONS)[number];

/** The section for an address part; /admin and unknown parts open the connection. */
export function adminSection(part: string | undefined): AdminSection {
  return (ADMIN_SECTIONS as readonly string[]).includes(part ?? "") ? part as AdminSection : "connection";
}

export function adminSectionLabel(section: AdminSection): string {
  switch (section) {
    case "connection": return t("CONNECTION");
    case "rooms": return t("ROOMS & LAMPS");
    case "automation": return t("AUTOMATION");
    case "access": return t("ACCESS");
    case "homekit": return t("HOMEKIT");
    case "google": return t("GOOGLE HOME / MATTER");
    case "system": return t("SYSTEM");
  }
}

/** One line under the tabs that says what a section is for. */
export function adminSectionSummary(section: AdminSection): string {
  switch (section) {
    case "connection": return t("The Casambi network this Pi controls, and the Bluetooth connection to it.");
    case "rooms": return t("Rooms, lamp names, and which lamps belong to which room.");
    case "automation": return t("Wall switch rules, away dates for timers, and the location for sunrise and sunset.");
    case "access": return t("Who can sign in, and keys for other apps that use the REST API.");
    case "homekit": return t("Control these lights and scenes from the Apple Home app and Siri, and choose what appears there.");
    case "google": return t("Control these lights and scenes from Google Home and a Google Nest, through Matter, and choose what appears there; separate from HomeKit.");
    case "system": return t("Notifications, updates, backups, the web server, and the audit log.");
  }
}
