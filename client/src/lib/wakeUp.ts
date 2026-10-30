import { dimmerToPercent, percentToDimmer } from "@/lib/brightness";
import { t } from "@/lib/i18n";

/** Mirrors the server's `wake_up` value: lamps rise from warm and dim to `level` and cool white over `minutes`. */
export type WakeUp = { minutes: number; level: number; warmKelvin: number; coolKelvin: number };
export const WAKE_UP_DEFAULTS = { minutes: "30", percent: "100", warmKelvin: "2200", coolKelvin: "4000" };

/** The form's text fields as a wake-up value; throws with a message the form shows. */
export function wakeUpValue(form: { minutes: string; percent: string; warmKelvin: string; coolKelvin: string }): WakeUp {
  const minutes = Number(form.minutes), percent = Number(form.percent), warmKelvin = Number(form.warmKelvin), coolKelvin = Number(form.coolKelvin);
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 60) throw new Error(t("A wake-up light lasts from 5 to 60 minutes."));
  if (!Number.isFinite(percent) || percent < 1 || percent > 100) throw new Error(t("The final brightness must be from 1 to 100%."));
  if (![warmKelvin, coolKelvin].every(kelvin => Number.isInteger(kelvin) && kelvin >= 1800 && kelvin <= 6500)) throw new Error(t("Colour temperatures must be from 1800 to 6500 K."));
  return { minutes, level: Math.max(1, percentToDimmer(percent)), warmKelvin, coolKelvin };
}

/** "Wake-up light 30 min to 100%". */
export function describeWakeUp(value: unknown): string {
  const wakeUp = value as Partial<WakeUp> | null;
  return t("Wake-up light {minutes} min to {percent}%", { minutes: wakeUp?.minutes ?? "?", percent: wakeUp?.level ? dimmerToPercent(wakeUp.level) : "?" });
}
