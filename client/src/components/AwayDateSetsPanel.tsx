import { CalendarOff, Plus, Trash2 } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import { HudFrame } from "@/components/HudFrame";
import { t } from "@/lib/i18n";
import { AwayDateSet, LocalApi, Schedule } from "@/lib/localApi";

type Props = { api: LocalApi; onNotice: (message: string) => void };

/** Administrator editor for shared away periods that can be attached to many local lighting timers. */
export function AwayDateSetsPanel({ api, onNotice }: Props) {
  const [sets, setSets] = useState<AwayDateSet[]>([]);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [selectedSchedules, setSelectedSchedules] = useState<number[]>([]);
  const [name, setName] = useState("");
  const [draftDate, setDraftDate] = useState("");
  const [draftDates, setDraftDates] = useState<string[]>([]);
  const [addDate, setAddDate] = useState<Record<number, string>>({});

  const load = async () => {
    try {
      const [nextSets, nextSchedules] = await Promise.all([api.request<AwayDateSet[]>("/admin/away-date-sets"), api.request<Schedule[]>("/schedules")]);
      setSets(nextSets); setSchedules(nextSchedules);
    } catch (error) { onNotice(error instanceof Error ? error.message : t("Unable to load away-date sets.")); }
  };
  useEffect(() => { void load(); }, []);

  const addDraftDate = () => { if (!draftDate || draftDates.includes(draftDate)) return; setDraftDates(current => [...current, draftDate].sort()); setDraftDate(""); };
  const removeDraftDate = (date: string) => setDraftDates(current => current.filter(candidate => candidate !== date));
  const createSet = async (event: FormEvent) => {
    event.preventDefault();
    try { await api.request("/admin/away-date-sets", { method: "POST", body: JSON.stringify({ name, dates: draftDates }) }); setName(""); setDraftDates([]); onNotice(t("Away-date set created. Select timers below to apply it.")); await load(); }
    catch (error) { onNotice(error instanceof Error ? error.message : t("Unable to create away-date set.")); }
  };
  const updateDates = async (set: AwayDateSet, dates: string[]) => {
    try { await api.request(`/admin/away-date-sets/${set.id}`, { method: "PATCH", body: JSON.stringify({ dates }) }); onNotice(t("{name} updated. Assigned timers will use the new dates.", { name: set.name })); await load(); }
    catch (error) { onNotice(error instanceof Error ? error.message : t("Unable to update away-date set.")); }
  };
  const renameSet = async (set: AwayDateSet, name: string) => {
    if (!name.trim() || name.trim() === set.name) return;
    try { await api.request(`/admin/away-date-sets/${set.id}`, { method: "PATCH", body: JSON.stringify({ name: name.trim() }) }); onNotice(t("Renamed to {name}.", { name: name.trim() })); await load(); }
    catch (error) { onNotice(error instanceof Error ? error.message : t("Unable to rename away-date set.")); await load(); }
  };
  const removeDate = (set: AwayDateSet, date: string) => {
    if (set.dates.length === 1) { onNotice(t("A set needs at least one date; delete the set instead.")); return; }
    void updateDates(set, set.dates.filter(candidate => candidate !== date));
  };
  const removeSet = async (set: AwayDateSet) => {
    try { await api.request(`/admin/away-date-sets/${set.id}`, { method: "DELETE" }); onNotice(t("{name} deleted and detached from its timers.", { name: set.name })); await load(); }
    catch (error) { onNotice(error instanceof Error ? error.message : t("Unable to delete away-date set.")); }
  };
  const applyToSelected = async (set: AwayDateSet) => {
    if (selectedSchedules.length === 0) { onNotice(t("Choose one or more timers first.")); return; }
    try { await Promise.all(selectedSchedules.map(id => api.request(`/schedules/${id}`, { method: "PATCH", body: JSON.stringify({ awayDateSetId: set.id }) }))); onNotice(selectedSchedules.length === 1 ? t("{name} applied to {count} timer.", { name: set.name, count: selectedSchedules.length }) : t("{name} applied to {count} timers.", { name: set.name, count: selectedSchedules.length })); setSelectedSchedules([]); await load(); }
    catch (error) { onNotice(error instanceof Error ? error.message : t("Unable to apply away-date set.")); }
  };
  const toggleSchedule = (id: number) => setSelectedSchedules(current => current.includes(id) ? current.filter(candidate => candidate !== id) : [...current, id]);

  return <HudFrame className="form-panel away-set-manager"><h3><CalendarOff /> {t("AWAY-DATE SETS")}</h3><p className="muted-copy">{t("Create one shared date set, then apply it to several timers at once. Updating a set recalculates every assigned timer’s next run.")}</p>
    <form onSubmit={createSet} className="admin-form"><label>{t("SET NAME")}<input value={name} onChange={event => setName(event.target.value)} placeholder={t("e.g. Summer break")} required /></label><div className="away-date-add"><input type="date" value={draftDate} onChange={event => setDraftDate(event.target.value)} /><button type="button" className="outline-button" onClick={addDraftDate} disabled={!draftDate}>{t("ADD DATE")}</button></div>{draftDates.length > 0 && <ul className="away-date-chips">{draftDates.map(date => <li key={date}>{date}<button type="button" aria-label={t("Remove {date}", { date })} onClick={() => removeDraftDate(date)}>×</button></li>)}</ul>}<button className="neon-button" disabled={!name || draftDates.length === 0}><Plus /> {t("CREATE SHARED SET")}</button></form>
    <div className="away-set-list">{sets.length === 0 ? <p className="muted-copy">{t("No shared away-date sets yet.")}</p> : sets.map(set => <article key={set.id}><div><input className="set-name" aria-label={t("Name of away-date set {name}", { name: set.name })} defaultValue={set.name} key={set.name} maxLength={96} onBlur={event => void renameSet(set, event.target.value)} onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }} /><ul className="away-date-chips">{set.dates.map(date => <li key={date}>{date}<button type="button" aria-label={t("Remove {date} from {name}", { date, name: set.name })} onClick={() => removeDate(set, date)}>×</button></li>)}</ul></div><div className="away-set-actions"><div><input type="date" value={addDate[set.id] || ""} onChange={event => setAddDate({ ...addDate, [set.id]: event.target.value })} /><button type="button" className="outline-button" disabled={!addDate[set.id]} onClick={() => { const date = addDate[set.id]; setAddDate({ ...addDate, [set.id]: "" }); void updateDates(set, set.dates.includes(date) ? set.dates : [...set.dates, date].sort()); }}>{t("ADD")}</button></div><button type="button" className="outline-button" onClick={() => void applyToSelected(set)}>{t("APPLY TO SELECTED ({count})", { count: selectedSchedules.length })}</button><button type="button" className="icon-button danger" aria-label={t("Delete {name}", { name: set.name })} onClick={() => void removeSet(set)}><Trash2 /></button></div></article>)}</div>
    <fieldset className="timer-assignment"><legend>{t("SELECT TIMERS TO UPDATE")}</legend>{schedules.length === 0 ? <p className="muted-copy">{t("Create a timer before assigning a shared set.")}</p> : schedules.map(schedule => <label key={schedule.id}><input type="checkbox" checked={selectedSchedules.includes(schedule.id)} onChange={() => toggleSchedule(schedule.id)} /><span>{schedule.name}<small>{schedule.awayDateSet ? t("Currently: {name}", { name: schedule.awayDateSet.name }) : t("No shared set")}</small></span></label>)}</fieldset>
  </HudFrame>;
}
