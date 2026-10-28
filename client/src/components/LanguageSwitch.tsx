import { Languages } from "lucide-react";
import { language, LANGUAGES, setLanguage, t } from "@/lib/i18n";

/** Switches between English and Dutch; shows the language it switches to. */
export function LanguageSwitch() {
  const next = LANGUAGES.find(candidate => candidate.code !== language())!;
  return <button type="button" className="language-switch" onClick={() => setLanguage(next.code)} title={`${t("Language")}: ${next.label}`} aria-label={`${t("Language")}: ${next.label}`}><Languages /><span>{next.code.toUpperCase()}</span></button>;
}
