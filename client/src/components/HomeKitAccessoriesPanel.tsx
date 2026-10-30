import { ListChecks } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import { HudFrame } from "@/components/HudFrame";
import { accessoryKindLabel, groupAccessories, type HomeKitAccessory, type HomeKitInfo } from "@/lib/homekit";
import { t } from "@/lib/i18n";
import { LocalApi } from "@/lib/localApi";

/** Chooses which lamps, groups, rooms, and scenes appear in Apple Home. */
export function HomeKitAccessoriesPanel({ api, onNotice }: { api: LocalApi; onNotice: (message: string) => void }) {
  const [accessories, setAccessories] = useState<HomeKitAccessory[] | null>(null);
  const [shown, setShown] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const show = (info: HomeKitInfo) => { setAccessories(info.accessories); setShown(new Set(info.accessories.filter(entry => entry.shown).map(entry => entry.key))); };
  useEffect(() => { void api.request<HomeKitInfo>("/admin/homekit").then(show).catch(error => onNotice(error instanceof Error ? error.message : t("Unable to load the HomeKit settings."))); }, []);
  const toggle = (key: string, on: boolean) => setShown(current => { const next = new Set(current); if (on) next.add(key); else next.delete(key); return next; });
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!accessories) return;
    setBusy(true);
    try {
      show(await api.request<HomeKitInfo>("/admin/homekit/accessories", { method: "PUT", body: JSON.stringify({ hidden: accessories.filter(entry => !shown.has(entry.key)).map(entry => entry.key) }) }));
      onNotice(t("HomeKit accessories saved."));
    } catch (error) { onNotice(error instanceof Error ? error.message : t("Unable to save the HomeKit settings.")); } finally { setBusy(false); }
  };
  const changed = accessories?.some(entry => entry.shown !== shown.has(entry.key)) ?? false;
  return <HudFrame className="form-panel"><h3><ListChecks /> {t("IN APPLE HOME")}</h3>
    {!accessories && <p className="muted-copy">{t("Loading…")}</p>}
    {accessories && accessories.length === 0 && <p className="muted-copy">{t("Connect the Casambi network once to list its lamps, groups, rooms, and scenes here.")}</p>}
    {accessories && accessories.length > 0 && <form onSubmit={event => void save(event)} className="admin-form">
      <p className="muted-copy">{t("Clear a box to remove it from Apple Home, together with its place in rooms and automations there. A room with the same lamps as a Casambi group, and a group or room with a single lamp, are not listed: they would appear twice.")}</p>
      {groupAccessories(accessories).map(group => <fieldset key={group.kind} className="homekit-accessories"><legend>{accessoryKindLabel(group.kind)}</legend>
        {group.entries.map(entry => <label key={entry.key} className="checkbox-row"><input type="checkbox" checked={shown.has(entry.key)} onChange={event => toggle(entry.key, event.target.checked)} disabled={busy} /> {entry.name}</label>)}
      </fieldset>)}
      <p className="muted-copy">{t("A Casambi wall switch appears here after each of its buttons was pressed once while the Pi is connected; in the Home app you then choose what a tap or a hold of each button does.")}</p>
      <button className="neon-button" disabled={busy || !changed}>{t("SAVE")}</button>
      <p className="muted-copy">{t("{shown} of {total} shown.", { shown: shown.size, total: accessories.length })}</p>
    </form>}
  </HudFrame>;
}
