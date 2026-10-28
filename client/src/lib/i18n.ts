import { nl } from "./i18n/nl";

/**
 * The interface in English or Dutch. The English text is the key, so untranslated text still reads well and the
 * source stays readable: `t("SAVE")`, `t("Move to port {port}?", { port })`. Dutch texts live in `i18n/nl/*.ts`;
 * `i18n.test.ts` fails when a `t("…")` text has no Dutch version, or when one is no longer used; so always pass t() a
 * literal (`n === 1 ? t("{n} lamp", { n }) : t("{n} lamps", { n })`, never `t(n === 1 ? … : …)` or a variable).
 * Messages from the server (errors, system check advice, notifications) stay English.
 */
export type Language = "en" | "nl";
export const LANGUAGES: Array<{ code: Language; label: string }> = [{ code: "en", label: "English" }, { code: "nl", label: "Nederlands" }];
const STORAGE_KEY = "casambi.language";

function detect(): Language {
  // Outside a browser (the unit tests), always English, whatever the machine's locale.
  if (typeof window === "undefined") return "en";
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === "en" || stored === "nl") return stored;
  } catch { /* Storage can be blocked; fall back to the browser language. */ }
  return (window.navigator.language ?? "").toLowerCase().startsWith("nl") ? "nl" : "en";
}

let current: Language = detect();
if (typeof document !== "undefined") document.documentElement.lang = current;

export function language(): Language { return current; }

/** Switches the language for this browser. The page reloads, so every text (and date format) follows at once. */
export function setLanguage(next: Language): void {
  try { window.localStorage.setItem(STORAGE_KEY, next); } catch { /* Only this page load then. */ }
  current = next;
  window.location.reload();
}

/** The text in the current language, with `{name}` placeholders filled in. */
export function t(text: string, values?: Record<string, string | number>): string {
  const translated = current === "nl" ? nl[text] ?? text : text;
  return values ? translated.replace(/\{(\w+)\}/g, (match, name: string) => name in values ? String(values[name]) : match) : translated;
}

/** For tests only. */
export function useLanguageForTest(next: Language): void { current = next; }
