import { CalendarOff, Plus, Trash2 } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import { HudFrame } from "@/components/HudFrame";
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
    } catch (error) { onNotice(error instanceof Error ? error.message : "Unable to load away-date sets."); }
  };
  useEffect(() => { void load(); }, []);

  const addDraftDate = () => { if (!draftDate || draftDates.includes(draftDate)) return; setDraftDates(current => [...current, draftDate].sort()); setDraftDate(""); };
  const removeDraftDate = (date: string) => setDraftDates(current => current.filter(candidate => candidate !== date));
  const createSet = async (event: FormEvent) => {
    event.preventDefault();
    try { await api.request("/admin/away-date-sets", { method: "POST", body: JSON.stringify({ name, dates: draftDates }) }); setName(""); setDraftDates([]); onNotice("Away-date set created. Select timers below to apply it."); await load(); }
    catch (error) { onNotice(error instanceof Error ? error.message : "Unable to create away-date set."); }
  };
  const updateDates = async (set: AwayDateSet, dates: string[]) => {
    try { await api.request(`/admin/away-date-sets/${set.id}`, { method: "PATCH", body: JSON.stringify({ dates }) }); onNotice(`${set.name} updated. Assigned timers will use the new dates.`); await load(); }
    catch (error) { onNotice(error instanceof Error ? error.message : "Unable to update away-date set."); }
  };
  const renameSet = async (set: AwayDateSet, name: string) => {
    if (!name.trim() || name.trim() === set.name) return;
    try { await api.request(`/admin/away-date-sets/${set.id}`, { method: "PATCH", body: JSON.stringify({ name: name.trim() }) }); onNotice(`Renamed to ${name.trim()}.`); await load(); }
    catch (error) { onNotice(error instanceof Error ? error.message : "Unable to rename away-date set."); await load(); }
  };
  const removeDate = (set: AwayDateSet, date: string) => {
    if (set.dates.length === 1) { onNotice("A set needs at least one date; delete the set instead."); return; }
    void updateDates(set, set.dates.filter(candidate => candidate !== date));
  };
  const removeSet = async (set: AwayDateSet) => {
    try { await api.request(`/admin/away-date-sets/${set.id}`, { method: "DELETE" }); onNotice(`${set.name} deleted and detached from its timers.`); await load(); }
    catch (error) { onNotice(error instanceof Error ? error.message : "Unable to delete away-date set."); }
  };
  const applyToSelected = async (set: AwayDateSet) => {
    if (selectedSchedules.length === 0) { onNotice("Choose one or more timers first."); return; }
    try { await Promise.all(selectedSchedules.map(id => api.request(`/schedules/${id}`, { method: "PATCH", body: JSON.stringify({ awayDateSetId: set.id }) }))); onNotice(`${set.name} applied to ${selectedSchedules.length} timer${selectedSchedules.length === 1 ? "" : "s"}.`); setSelectedSchedules([]); await load(); }
    catch (error) { onNotice(error instanceof Error ? error.message : "Unable to apply away-date set."); }
  };
  const toggleSchedule = (id: number) => setSelectedSchedules(current => current.includes(id) ? current.filter(candidate => candidate !== id) : [...current, id]);

  return <HudFrame className="form-panel away-set-manager"><h3><CalendarOff /> AWAY-DATE SETS</h3><p className="muted-copy">Create one shared date set, then apply it to several timers at once. Updating a set recalculates every assigned timer’s next run.</p>
    <form onSubmit={createSet} className="admin-form"><label>SET NAME<input value={name} onChange={event => setName(event.target.value)} placeholder="e.g. Summer break" required /></label><div className="away-date-add"><input type="date" value={draftDate} onChange={event => setDraftDate(event.target.value)} /><button type="button" className="outline-button" onClick={addDraftDate} disabled={!draftDate}>ADD DATE</button></div>{draftDates.length > 0 && <ul className="away-date-chips">{draftDates.map(date => <li key={date}>{date}<button type="button" aria-label={`Remove ${date}`} onClick={() => removeDraftDate(date)}>×</button></li>)}</ul>}<button className="neon-button" disabled={!name || draftDates.length === 0}><Plus /> CREATE SHARED SET</button></form>
    <div className="away-set-list">{sets.length === 0 ? <p className="muted-copy">No shared away-date sets yet.</p> : sets.map(set => <article key={set.id}><div><input className="set-name" aria-label={`Name of away-date set ${set.name}`} defaultValue={set.name} key={set.name} maxLength={96} onBlur={event => void renameSet(set, event.target.value)} onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }} /><ul className="away-date-chips">{set.dates.map(date => <li key={date}>{date}<button type="button" aria-label={`Remove ${date} from ${set.name}`} onClick={() => removeDate(set, date)}>×</button></li>)}</ul></div><div className="away-set-actions"><div><input type="date" value={addDate[set.id] || ""} onChange={event => setAddDate({ ...addDate, [set.id]: event.target.value })} /><button type="button" className="outline-button" disabled={!addDate[set.id]} onClick={() => { const date = addDate[set.id]; setAddDate({ ...addDate, [set.id]: "" }); void updateDates(set, set.dates.includes(date) ? set.dates : [...set.dates, date].sort()); }}>ADD</button></div><button type="button" className="outline-button" onClick={() => void applyToSelected(set)}>APPLY TO SELECTED ({selectedSchedules.length})</button><button type="button" className="icon-button danger" aria-label={`Delete ${set.name}`} onClick={() => void removeSet(set)}><Trash2 /></button></div></article>)}</div>
    <fieldset className="timer-assignment"><legend>SELECT TIMERS TO UPDATE</legend>{schedules.length === 0 ? <p className="muted-copy">Create a timer before assigning a shared set.</p> : schedules.map(schedule => <label key={schedule.id}><input type="checkbox" checked={selectedSchedules.includes(schedule.id)} onChange={() => toggleSchedule(schedule.id)} /><span>{schedule.name}<small>{schedule.awayDateSet ? `Currently: ${schedule.awayDateSet.name}` : "No shared set"}</small></span></label>)}</fieldset>
  </HudFrame>;
}
