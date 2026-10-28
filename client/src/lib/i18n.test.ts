import { readdirSync, readFileSync, statSync } from "fs";
import { join, resolve } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { t, useLanguageForTest } from "./i18n";
import { nl } from "./i18n/nl";

const root = resolve(import.meta.dirname, "..");
function sources(folder: string): string[] {
  return readdirSync(folder).flatMap(name => {
    const path = join(folder, name);
    if (statSync(path).isDirectory()) return name === "i18n" || name === "ui" ? [] : sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && name !== "i18n.ts" ? [path] : [];
  });
}
/** Every literal text passed to t(…): "…" strings, and template literals without ${}. */
function usedTexts(): Map<string, string> {
  const used = new Map<string, string>();
  for (const file of sources(root)) {
    const code = readFileSync(file, "utf8");
    for (const match of code.matchAll(/\bt\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`([^`$]*)`)/g)) {
      const raw = match[1] ?? match[2] ?? match[3];
      used.set(match[1] !== undefined ? JSON.parse(`"${raw}"`) as string : raw.replace(/\\(.)/g, "$1"), file);
    }
  }
  return used;
}
const placeholders = (text: string) => Array.from(text.matchAll(/\{(\w+)\}/g), match => match[1]).sort();

afterEach(() => useLanguageForTest("en"));

describe("translations", () => {
  it("have a Dutch text for every text in the interface, and none that is no longer used", () => {
    const used = usedTexts();
    const missing = Array.from(used.keys()).filter(text => !(text in nl)).map(text => `${text}  (${used.get(text)!.slice(root.length + 1)})`);
    expect(missing).toEqual([]);
    expect(Object.keys(nl).filter(text => !used.has(text))).toEqual([]);
  });

  it("keep every placeholder", () => {
    expect(Object.entries(nl).filter(([english, dutch]) => placeholders(english).join() !== placeholders(dutch).join()).map(([english]) => english)).toEqual([]);
  });

  it("fill in placeholders, and fall back to English", () => {
    expect(t("{count} unread notifications", { count: 3 })).toBe("3 unread notifications");
    useLanguageForTest("nl");
    expect(t("{count} unread notifications", { count: 3 })).toBe("3 ongelezen meldingen");
    expect(t("Not translated")).toBe("Not translated");
  });
});
