import { ListChecks } from "lucide-react";
import { FormEvent, ReactNode, useEffect, useState } from "react";
import { HudFrame } from "@/components/HudFrame";
import { accessoryKindLabel, groupAccessories, type HomeKitAccessory } from "@/lib/homekit";
import { t } from "@/lib/i18n";
import { LocalApi } from "@/lib/localApi";

type Props = {
  api: LocalApi;
  onNotice: (message: string) => void;
  /** The smart home app, as the panel names it: "Apple Home", "Google Home". */
  app: string;
  title: string;
  /** Where the status with `accessories` comes from, and where the hidden keys go. */
  statusPath: string;
  savePath: string;
  /** Extra explanation under the list, for what only this platform does. */
  hint?: ReactNode;
};

/**
 * Chooses which lamps, groups, rooms, scenes, and (HomeKit) wall switches appear in a smart home app. Each platform
 * keeps its own choice.
 */
export function AccessoriesPanel({ api, onNotice, app, title, statusPath, savePath, hint }: Props) {
  const [accessories, setAccessories] = useState<HomeKitAccessory[] | null>(null);
  const [shown, setShown] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const show = (info: { accessories: HomeKitAccessory[] }) => { setAccessories(info.accessories); setShown(new Set(info.accessories.filter(entry => entry.shown).map(entry => entry.key))); };
  useEffect(() => { void api.request<{ accessories: HomeKitAccessory[] }>(statusPath).then(show).catch(error => onNotice(error instanceof Error ? error.message : t("Unable to load what {app} shows.", { app }))); }, [statusPath]);
  const toggle = (key: string, on: boolean) => setShown(current => { const next = new Set(current); if (on) next.add(key); else next.delete(key); return next; });
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!accessories) return;
    setBusy(true);
    try {
      show(await api.request<{ accessories: HomeKitAccessory[] }>(savePath, { method: "PUT", body: JSON.stringify({ hidden: accessories.filter(entry => !shown.has(entry.key)).map(entry => entry.key) }) }));
      onNotice(t("Saved what {app} shows.", { app }));
    } catch (error) { onNotice(error instanceof Error ? error.message : t("Unable to save what {app} shows.", { app })); } finally { setBusy(false); }
  };
  const changed = accessories?.some(entry => entry.shown !== shown.has(entry.key)) ?? false;
  return <HudFrame className="form-panel"><h3><ListChecks /> {title}</h3>
    {!accessories && <p className="muted-copy">{t("Loading…")}</p>}
    {accessories && accessories.length === 0 && <p className="muted-copy">{t("Connect the Casambi network once to list its lamps, groups, rooms, and scenes here.")}</p>}
    {accessories && accessories.length > 0 && <form onSubmit={event => void save(event)} className="admin-form">
      <p className="muted-copy">{t("Clear a box to remove it from {app}, together with its place in rooms and automations there. A room with the same lamps as a Casambi group, and a group or room with a single lamp, are not listed: they would appear twice.", { app })}</p>
      {groupAccessories(accessories).map(group => <fieldset key={group.kind} className="homekit-accessories"><legend>{accessoryKindLabel(group.kind)}</legend>
        {group.entries.map(entry => <label key={entry.key} className="checkbox-row"><input type="checkbox" checked={shown.has(entry.key)} onChange={event => toggle(entry.key, event.target.checked)} disabled={busy} /> {entry.name}</label>)}
      </fieldset>)}
      {hint}
      <button className="neon-button" disabled={busy || !changed}>{t("SAVE")}</button>
      <p className="muted-copy">{t("{shown} of {total} shown.", { shown: shown.size, total: accessories.length })}</p>
    </form>}
  </HudFrame>;
}
