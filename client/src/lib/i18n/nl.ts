import { admin } from "./nl/admin";
import { adminSystem } from "./nl/adminSystem";
import { dashboard } from "./nl/dashboard";
import { schedules } from "./nl/schedules";
import { setup } from "./nl/setup";
import { shell } from "./nl/shell";

/** Every Dutch text, by its English original. Each part covers one area of the interface. */
export const nl: Record<string, string> = { ...shell, ...dashboard, ...schedules, ...admin, ...adminSystem, ...setup };
