import { CalendarClock, Check, Plus, Trash2 } from "lucide-react";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { HudFrame } from "@/components/HudFrame";
import { useNetwork } from "@/hooks/useNetwork";
import { defaultDaysForRepeat, describeCronExpression, fromCronExpression, RepeatPattern, toCronExpression, WEEKDAYS } from "@/lib/friendlySchedule";
import { t } from "@/lib/i18n";
import { AwayDateSet, LocalApi, Schedule, SolarSchedule } from "@/lib/localApi";
import { dimmerToPercent, percentToDimmer } from "@/lib/brightness";
import { isLamp, parseSceneTarget, sceneTargetOptions } from "@/lib/scenes";

type TimerCommand = Schedule["command"] & { fadeDurationMs?: number };
type TimerForm = { name: string; trigger: "time" | "sunrise" | "sunset"; time: string; repeat: RepeatPattern; days: string[]; solarOffsetMinutes: string; timezone: string; targetType: string; targetId: string; operation: string; value: string; fadeDurationSeconds: string; holidayDates: string[]; awayDateSetId: string };

const initialForm: TimerForm = { name: t("Evening lights"), trigger: "time", time: "18:00", repeat: "daily", days: [], solarOffsetMinutes: "0", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", targetType: "network", targetId: "", operation: "set_level", value: "50", fadeDurationSeconds: "0", holidayDates: [], awayDateSetId: "" };

/** Plain-language, database-backed timer editor that translates simple repeat choices into the durable scheduler format. */
export default function Schedules() {
  const api = useMemo(() => new LocalApi(), []);
  const { network, scenes } = useNetwork();
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [awayDateSets, setAwayDateSets] = useState<AwayDateSet[]>([]);
  const [message, setMessage] = useState("");
  const [form, setForm] = useState<TimerForm>(initialForm);
  const [holidayInput, setHolidayInput] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const editorRef = useRef<HTMLDivElement>(null);
  const isScene = form.targetType === "scene";
  // Saved (Pi) scenes can fade; scenes stored in the Casambi network switch instantly.
  const supportsFade = isScene ? form.targetId.startsWith("local_scene:") : ["set_level", "on", "off"].includes(form.operation);
  const sceneOptions = sceneTargetOptions(network, scenes);
  const selectableTargets = [
    ...(network?.units.filter(isLamp).map(unit => ({ type: "unit", id: unit.id, label: unit.name })) ?? []),
    ...(network?.groups.map(group => ({ type: "group", id: group.id, label: group.name })) ?? []),
    ...(network?.rooms.map(room => ({ type: "room", id: room.id, label: room.name })) ?? []),
  ];

  const refresh = async () => {
    try { const [nextSchedules, nextSets] = await Promise.all([api.request<Schedule[]>("/schedules"), api.request<AwayDateSet[]>("/away-date-sets")]); setSchedules(nextSchedules); setAwayDateSets(nextSets); }
    catch (error) { setMessage(error instanceof Error ? error.message : t("Unable to load timers.")); }
  };
  useEffect(() => { void refresh(); }, []);

  const changeRepeat = (repeat: RepeatPattern) => setForm(current => ({ ...current, repeat, days: repeat === "custom" ? current.days : defaultDaysForRepeat(repeat) }));
  const toggleDay = (day: string) => setForm(current => ({ ...current, days: current.days.includes(day) ? current.days.filter(candidate => candidate !== day) : [...current.days, day] }));
  const toggleSpecificDay = (day: string) => setForm(current => ({ ...current, repeat: "custom", days: current.days.includes(day) ? current.days.filter(candidate => candidate !== day) : [...current.days, day] }));
  const addHoliday = () => { if (!holidayInput || form.holidayDates.includes(holidayInput)) return; setForm(current => ({ ...current, holidayDates: [...current.holidayDates, holidayInput].sort() })); setHolidayInput(""); };
  const removeHoliday = (date: string) => setForm(current => ({ ...current, holidayDates: current.holidayDates.filter(candidate => candidate !== date) }));
  const updateTargetType = (targetType: string) => setForm(current => ({ ...current, targetType, targetId: "" }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    try {
      if (!form.name.trim()) throw new Error(t("Give this timer a name."));
      if (form.targetType !== "network" && !form.targetId) throw new Error(isScene ? t("Choose the scene to activate.") : t("Choose the lamp, group, or room to control."));
      const fadeDurationSeconds = supportsFade ? Number(form.fadeDurationSeconds) : 0;
      if (!Number.isFinite(fadeDurationSeconds) || fadeDurationSeconds < 0 || fadeDurationSeconds > 60) throw new Error(t("Fade duration must be from 0 to 60 seconds."));
      const fade = fadeDurationSeconds > 0 ? { fadeDurationMs: Math.round(fadeDurationSeconds * 1000) } : {};
      const command: TimerCommand = isScene ? { ...parseSceneTarget(form.targetId), operation: "activate_scene", ...fade } : { targetType: form.targetType, targetId: form.targetType === "network" ? null : Number(form.targetId), operation: form.operation, ...(form.operation === "set_level" ? { value: percentToDimmer(Number(form.value)) } : {}), ...fade };
      const solar: SolarSchedule | null = form.trigger === "time" ? null : { event: form.trigger, offsetMinutes: Number(form.solarOffsetMinutes) };
      if (solar && (!Number.isInteger(solar.offsetMinutes) || solar.offsetMinutes < -180 || solar.offsetMinutes > 180)) throw new Error(t("Sunrise and sunset offsets must be whole minutes from 180 before to 180 after the event."));
      if (form.trigger === "time" && form.repeat === "custom" && form.days.length === 0) throw new Error(t("Choose at least one day, or select every day."));
      const awayDateSet = awayDateSets.find(set => set.id === Number(form.awayDateSetId)) ?? null;
      // awayDateSetId null detaches a shared set when editing.
      const timer = { name: form.name.trim(), cronExpression: solar ? "0 0 * * *" : toCronExpression(form.time, form.repeat, form.days), timezone: form.timezone, command, solar, holidayDates: form.holidayDates, awayDateSetId: awayDateSet?.id ?? null };
      if (editingId === null) await api.request("/schedules", { method: "POST", body: JSON.stringify({ ...timer, enabled: true }) });
      else await api.request(`/schedules/${editingId}`, { method: "PATCH", body: JSON.stringify(timer) });
      setMessage(editingId === null ? t("Timer saved. Your Raspberry Pi will run it at the chosen time.") : t("Timer updated."));
      setEditingId(null); setForm(initialForm);
      await refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : t("Unable to save timer.")); }
    finally { setSaving(false); }
  };

  /** Loads a timer into the editor. Timers with a hand-written cron expression can only be paused or deleted here. */
  const editTimer = (schedule: Schedule) => {
    const when = schedule.solar ? null : fromCronExpression(schedule.cronExpression);
    if (!schedule.solar && !when) { setMessage(t("This timer uses a custom cron expression, which this editor cannot show. Pause or delete it here, or change it through the API.")); return; }
    const command = schedule.command as TimerCommand;
    const scene = command.targetType === "scene" || command.targetType === "local_scene";
    setForm({
      ...initialForm, name: schedule.name, trigger: schedule.solar ? schedule.solar.event : "time", time: when?.time ?? initialForm.time, repeat: when?.repeat ?? "daily", days: when?.days ?? [],
      solarOffsetMinutes: String(schedule.solar?.offsetMinutes ?? 0), timezone: schedule.timezone,
      targetType: scene ? "scene" : command.targetType, targetId: scene ? `${command.targetType}:${command.targetId}` : command.targetId == null ? "" : String(command.targetId),
      operation: scene ? "on" : command.operation, value: command.operation === "set_level" ? String(dimmerToPercent(Number(command.value))) : initialForm.value,
      fadeDurationSeconds: command.fadeDurationMs ? String(command.fadeDurationMs / 1000) : "0", holidayDates: schedule.holidayDates, awayDateSetId: schedule.awayDateSetId ? String(schedule.awayDateSetId) : "",
    });
    setEditingId(schedule.id); setMessage("");
    editorRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  };
  const cancelEdit = () => { setEditingId(null); setForm(initialForm); setMessage(""); };
  const setEnabled = async (schedule: Schedule, enabled: boolean) => {
    try { await api.request(`/schedules/${schedule.id}`, { method: "PATCH", body: JSON.stringify({ enabled }) }); await refresh(); }
    catch (error) { setMessage(error instanceof Error ? error.message : t("Unable to change the timer.")); }
  };

  const remove = async (id: number) => {
    try { await api.request(`/schedules/${id}`, { method: "DELETE" }); if (editingId === id) cancelEdit(); await refresh(); }
    catch (error) { setMessage(error instanceof Error ? error.message : t("Unable to delete timer.")); }
  };

  const targetLabel = form.targetType === "network" ? t("all lights") : isScene ? sceneOptions.find(option => option.value === form.targetId)?.label.split(" · ")[0] || t("the selected scene") : selectableTargets.find(target => target.type === form.targetType && String(target.id) === form.targetId)?.label || (form.targetType === "unit" ? t("the selected unit") : form.targetType === "group" ? t("the selected group") : t("the selected room"));
  const actionLabel = isScene ? t("activate scene {target}", { target: targetLabel }) : form.operation === "set_level" ? t("set {target} to {value}%", { target: targetLabel, value: form.value }) : form.operation === "on" ? t("turn on {target}", { target: targetLabel }) : t("turn off {target}", { target: targetLabel });
  const offset = Number(form.solarOffsetMinutes);
  const after = form.solarOffsetMinutes; const before = Math.abs(offset);
  const whenLabel = form.trigger === "time"
    ? form.repeat === "daily" ? t("at {time} every day", { time: form.time }) : form.repeat === "weekdays" ? t("at {time} on weekdays", { time: form.time }) : form.repeat === "weekends" ? t("at {time} on weekends", { time: form.time }) : form.days.length ? t("at {time} on {days}", { time: form.time, days: form.days.map(day => WEEKDAYS.find(candidate => candidate.value === day)?.short).join(", ") }) : t("at {time} on selected days", { time: form.time })
    : form.trigger === "sunrise" ? !offset ? t("at sunrise every day") : offset > 0 ? t("at sunrise {minutes} min after every day", { minutes: after }) : t("at sunrise {minutes} min before every day", { minutes: before })
    : !offset ? t("at sunset every day") : offset > 0 ? t("at sunset {minutes} min after every day", { minutes: after }) : t("at sunset {minutes} min before every day", { minutes: before });
  /** A timer's target by name, e.g. "All lights", "Kitchen", or "Dinner". */
  const describeTarget = (command: TimerCommand) => {
    if (command.targetType === "network") return t("All lights");
    if (command.targetType === "local_scene" || command.targetType === "scene") return sceneOptions.find(option => option.value === `${command.targetType}:${command.targetId}`)?.label.split(" · ")[0] ?? t("a deleted scene");
    return selectableTargets.find(target => target.type === command.targetType && target.id === Number(command.targetId))?.label ?? command.targetType;
  };
  const formatNextRun = (value: string | null | undefined) => value ? new Date(value).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : t("Not available");
  return <div className="schedule-page">
    <div className="section-heading"><div><p className="eyebrow"><CalendarClock /> {t("LIGHTING AUTOMATION")}</p><h2>{t("SMART")} <em>//</em> {t("TIMERS")}</h2></div></div>
    <div className="schedule-layout"><div ref={editorRef} className="timer-editor-anchor" /><HudFrame className="form-panel timer-editor"><h3><Plus /> {editingId === null ? t("NEW TIMER") : t("EDIT TIMER")}</h3><p className="muted-copy">{t("Choose when your lighting should change. The Raspberry Pi handles the timing in the background.")}</p><form onSubmit={submit} className="admin-form">
      <label>{t("WHAT SHOULD WE CALL THIS TIMER?")}<input value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} placeholder={t("e.g. Evening lights")} /></label>
      <label>{t("WHEN SHOULD IT HAPPEN?")}<select value={form.trigger} onChange={event => setForm({ ...form, trigger: event.target.value as TimerForm["trigger"] })}><option value="time">{t("At a time")}</option><option value="sunrise">{t("At sunrise")}</option><option value="sunset">{t("At sunset")}</option></select></label>
      {form.trigger === "time" ? <><label>{t("AT WHAT TIME?")}<input type="time" value={form.time} onChange={event => setForm({ ...form, time: event.target.value })} /></label><fieldset className="day-picker"><legend>{t("ON WHICH DAYS?")}</legend><div className="repeat-choice"><button type="button" aria-pressed={form.repeat === "daily"} className={form.repeat === "daily" ? "selected" : ""} onClick={() => changeRepeat("daily")}>{t("EVERY DAY")}</button><button type="button" aria-pressed={form.repeat === "weekdays"} className={form.repeat === "weekdays" ? "selected" : ""} onClick={() => changeRepeat("weekdays")}>{t("WEEKDAYS")}</button><button type="button" aria-pressed={form.repeat === "weekends"} className={form.repeat === "weekends" ? "selected" : ""} onClick={() => changeRepeat("weekends")}>{t("WEEKENDS")}</button><button type="button" aria-pressed={form.repeat === "custom"} className={form.repeat === "custom" ? "selected" : ""} onClick={() => changeRepeat("custom")}>{t("PICK DAYS")}</button></div><div className="weekday-choice">{WEEKDAYS.map(day => <button type="button" key={day.value} aria-pressed={form.repeat === "custom" && form.days.includes(day.value)} className={form.repeat === "custom" && form.days.includes(day.value) ? "selected" : ""} onClick={() => toggleSpecificDay(day.value)}>{day.short}</button>)}</div></fieldset></> : <label>{t("MINUTES BEFORE (−) OR AFTER (+)")}<input type="number" min="-180" max="180" step="1" value={form.solarOffsetMinutes} onChange={event => setForm({ ...form, solarOffsetMinutes: event.target.value })} /><small>{t("Runs every day. Your administrator sets the local solar location.")}</small></label>}
      <label>{t("YOUR TIME ZONE")}<input value={form.timezone} onChange={event => setForm({ ...form, timezone: event.target.value })} /></label>
      <div className="form-grid"><label>{t("WHICH LIGHTS?")}<select value={form.targetType} onChange={event => updateTargetType(event.target.value)}><option value="network">{t("All lights")}</option><option value="unit">{t("A lamp")}</option><option value="group">{t("A group")}</option><option value="room">{t("A room")}</option><option value="scene">{t("A scene")}</option></select></label>{form.targetType !== "network" && <label>{form.targetType === "unit" ? t("CHOOSE UNIT") : form.targetType === "group" ? t("CHOOSE GROUP") : form.targetType === "room" ? t("CHOOSE ROOM") : t("CHOOSE SCENE")}<select value={form.targetId} onChange={event => setForm({ ...form, targetId: event.target.value })}><option value="">{t("Select…")}</option>{isScene ? sceneOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>) : selectableTargets.filter(target => target.type === form.targetType).map(target => <option key={`${target.type}-${target.id}`} value={target.id}>{target.label}</option>)}</select></label>}</div>
      {!isScene && <div className="form-grid"><label>{t("WHAT SHOULD HAPPEN?")}<select value={form.operation} onChange={event => setForm({ ...form, operation: event.target.value })}><option value="set_level">{t("Set brightness")}</option><option value="on">{t("Turn on")}</option><option value="off">{t("Turn off")}</option></select></label>{form.operation === "set_level" && <label>{t("BRIGHTNESS")}<input type="number" min="0" max="100" value={form.value} onChange={event => setForm({ ...form, value: event.target.value })} /><small>0–100%</small></label>}</div>}
      {supportsFade && <label>{t("FADE GENTLY FOR")}<input type="number" min="0" max="60" step="0.1" value={form.fadeDurationSeconds} onChange={event => setForm({ ...form, fadeDurationSeconds: event.target.value })} /><small>{t("Optional, from 0 to 60 seconds.")}</small></label>}
      <fieldset className="holiday-exclusions"><legend>{t("SKIP WHEN YOU ARE AWAY (OPTIONAL)")}</legend><div><input type="date" value={holidayInput} onChange={event => setHolidayInput(event.target.value)} /><button type="button" className="outline-button" onClick={addHoliday} disabled={!holidayInput}>{t("ADD DATE")}</button></div>{form.holidayDates.length > 0 ? <ul>{form.holidayDates.map(date => <li key={date}>{new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}<button type="button" onClick={() => removeHoliday(date)} aria-label={t("Remove away date {date}", { date })}>×</button></li>)}</ul> : <small>{t("Add the dates when this timer should stay quiet.")}</small>}</fieldset>
      <label>{t("APPLY A SAVED AWAY SET")}<select value={form.awayDateSetId} onChange={event => setForm({ ...form, awayDateSetId: event.target.value })}><option value="">{t("No shared set")}</option>{awayDateSets.map(set => <option key={set.id} value={set.id}>{set.name} · {set.dates.length === 1 ? t("{count} date", { count: set.dates.length }) : t("{count} dates", { count: set.dates.length })}</option>)}</select><small>{t("A shared set keeps multiple timers in sync when its dates change.")}</small></label>
      <p className="timer-preview"><Check /> {actionLabel} {whenLabel}.{form.holidayDates.length ? ` ${form.holidayDates.length === 1 ? t("It will skip {count} away date.", { count: form.holidayDates.length }) : t("It will skip {count} away dates.", { count: form.holidayDates.length })}` : ""}</p>
      <button className="neon-button" disabled={saving}>{editingId === null ? t("SAVE TIMER") : t("SAVE CHANGES")}</button>{editingId !== null && <button type="button" className="outline-button" onClick={cancelEdit}>{t("CANCEL")}</button>}
    </form>{message && <p className="form-notice">{message}</p>}<p className="muted-copy">{t("Timers are saved locally on your Raspberry Pi and continue to run after a restart.")}</p></HudFrame>
      <HudFrame className="schedule-list"><h3>{t("YOUR TIMERS")} <span>{schedules.length}</span></h3>{schedules.length === 0 ? <p className="muted-copy">{t("No timers yet. Create one to automate your lighting.")}</p> : schedules.map(schedule => { const fadeDurationMs = (schedule.command as TimerCommand).fadeDurationMs; const solar = schedule.solar; const minutes = Math.abs(solar?.offsetMinutes ?? 0); const solarLabel = solar ? solar.offsetMinutes === 0 ? solar.event === "sunrise" ? t("At sunrise") : t("At sunset") : solar.offsetMinutes > 0 ? solar.event === "sunrise" ? t("{minutes} min after sunrise", { minutes }) : t("{minutes} min after sunset", { minutes }) : solar.event === "sunrise" ? t("{minutes} min before sunrise", { minutes }) : t("{minutes} min before sunset", { minutes }) : describeCronExpression(schedule.cronExpression); return <article key={schedule.id} className={schedule.enabled ? "" : "paused"}><div><p>{schedule.name}{!schedule.enabled && <span className="paused-label"> · {t("PAUSED")}</span>}</p><code>{solarLabel} · {schedule.timezone}</code><small>{schedule.command.operation === "activate_scene" ? t("Activate scene") : schedule.command.operation === "set_level" ? t("Set brightness") : schedule.command.operation === "on" ? t("Turn on") : t("Turn off")} · {describeTarget(schedule.command)}{fadeDurationMs ? ` · ${t("Fade {seconds}s", { seconds: fadeDurationMs / 1000 })}` : ""}{schedule.lastRunAt ? ` · ${t("last {time}", { time: new Date(schedule.lastRunAt).toLocaleString() })}` : ""}</small>{schedule.awayDateSet && <small className="holiday-summary">{t("SAVED SET")} · {schedule.awayDateSet.name}</small>}{schedule.holidayDates.length > 0 && <small className="holiday-summary">{t("EXTRA DATES")} · {schedule.holidayDates.join(", ")}</small>}{schedule.enabled && <b className="next-run">{t("NEXT RUN")} · {formatNextRun(schedule.nextRunAt)}</b>}</div><div className="timer-actions"><label className="switch-rule-enabled"><input type="checkbox" checked={schedule.enabled} onChange={event => void setEnabled(schedule, event.target.checked)} /> {t("On")}</label><button className="outline-button" aria-pressed={editingId === schedule.id} onClick={() => editTimer(schedule)}>{t("EDIT")}</button><button className="icon-button danger" onClick={() => void remove(schedule.id)} aria-label={t("Delete {name}", { name: schedule.name })}><Trash2 /></button></div></article>; })}</HudFrame></div>
  </div>;
}
