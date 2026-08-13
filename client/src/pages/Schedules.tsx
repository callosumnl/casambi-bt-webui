import { CalendarClock, Check, Plus, Trash2 } from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { HudFrame } from "@/components/HudFrame";
import { useNetwork } from "@/hooks/useNetwork";
import { defaultDaysForRepeat, describeCronExpression, RepeatPattern, toCronExpression, WEEKDAYS } from "@/lib/friendlySchedule";
import { LocalApi, Schedule, SolarSchedule } from "@/lib/localApi";
import { percentToDimmer } from "@/lib/brightness";

type TimerCommand = Schedule["command"] & { fadeDurationMs?: number };
type TimerForm = { name: string; trigger: "time" | "sunrise" | "sunset"; time: string; repeat: RepeatPattern; days: string[]; solarOffsetMinutes: string; timezone: string; targetType: string; targetId: string; operation: string; value: string; fadeDurationSeconds: string; holidayDates: string[] };

const demoSchedules: Schedule[] = [{ id: 9001, name: "Gallery welcome", cronExpression: "0 9 * * 1-5", timezone: "Europe/Amsterdam", enabled: true, command: { targetType: "group", targetId: 201, operation: "on", fadeDurationMs: 1200 }, holidayDates: [], lastRunAt: null, nextRunAt: new Date(Date.now() + 3_600_000).toISOString() }];
const initialForm: TimerForm = { name: "Evening lights", trigger: "time", time: "18:00", repeat: "daily", days: [], solarOffsetMinutes: "0", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", targetType: "network", targetId: "", operation: "set_level", value: "50", fadeDurationSeconds: "0", holidayDates: [] };

/** Plain-language, database-backed timer editor that translates simple repeat choices into the durable scheduler format. */
export default function Schedules({ demo = false }: { demo?: boolean }) {
  const api = useMemo(() => new LocalApi(), []);
  const { network } = useNetwork(demo);
  const [schedules, setSchedules] = useState<Schedule[]>(() => demo ? demoSchedules : []);
  const [message, setMessage] = useState("");
  const [form, setForm] = useState<TimerForm>(initialForm);
  const [holidayInput, setHolidayInput] = useState("");
  const supportsFade = ["set_level", "on", "off"].includes(form.operation);
  const selectableTargets = [
    ...(network?.units.map(unit => ({ type: "unit", id: unit.id, label: unit.name })) ?? []),
    ...(network?.groups.map(group => ({ type: "group", id: group.id, label: group.name })) ?? []),
    ...(network?.rooms.map(room => ({ type: "room", id: room.id, label: room.name })) ?? []),
  ];

  const refresh = async () => {
    if (demo) return;
    try { setSchedules(await api.request<Schedule[]>("/schedules")); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Unable to load timers."); }
  };
  useEffect(() => { if (!demo) void refresh(); }, [demo]);

  const changeRepeat = (repeat: RepeatPattern) => setForm(current => ({ ...current, repeat, days: repeat === "custom" ? current.days : defaultDaysForRepeat(repeat) }));
  const toggleDay = (day: string) => setForm(current => ({ ...current, days: current.days.includes(day) ? current.days.filter(candidate => candidate !== day) : [...current.days, day] }));
  const toggleSpecificDay = (day: string) => setForm(current => ({ ...current, repeat: "custom", days: current.days.includes(day) ? current.days.filter(candidate => candidate !== day) : [...current.days, day] }));
  const addHoliday = () => { if (!holidayInput || form.holidayDates.includes(holidayInput)) return; setForm(current => ({ ...current, holidayDates: [...current.holidayDates, holidayInput].sort() })); setHolidayInput(""); };
  const removeHoliday = (date: string) => setForm(current => ({ ...current, holidayDates: current.holidayDates.filter(candidate => candidate !== date) }));
  const updateTargetType = (targetType: string) => setForm(current => ({ ...current, targetType, targetId: "" }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      if (!form.name.trim()) throw new Error("Give this timer a name.");
      if (form.targetType !== "network" && !form.targetId) throw new Error("Choose the lamp, group, or room to control.");
      const fadeDurationSeconds = supportsFade ? Number(form.fadeDurationSeconds) : 0;
      if (!Number.isFinite(fadeDurationSeconds) || fadeDurationSeconds < 0 || fadeDurationSeconds > 60) throw new Error("Fade duration must be from 0 to 60 seconds.");
      const command: TimerCommand = { targetType: form.targetType, targetId: form.targetType === "network" ? null : Number(form.targetId), operation: form.operation, ...(form.operation === "set_level" ? { value: percentToDimmer(Number(form.value)) } : {}), ...(fadeDurationSeconds > 0 ? { fadeDurationMs: Math.round(fadeDurationSeconds * 1000) } : {}) };
      const solar: SolarSchedule | null = form.trigger === "time" ? null : { event: form.trigger, offsetMinutes: Number(form.solarOffsetMinutes) };
      if (solar && (!Number.isInteger(solar.offsetMinutes) || solar.offsetMinutes < -180 || solar.offsetMinutes > 180)) throw new Error("Sunrise and sunset offsets must be whole minutes from 180 before to 180 after the event.");
      if (form.trigger === "time" && form.repeat === "custom" && form.days.length === 0) throw new Error("Choose at least one day, or select every day.");
      const schedule: Schedule = { id: Date.now(), name: form.name.trim(), cronExpression: solar ? "0 0 * * *" : toCronExpression(form.time, form.repeat, form.days), timezone: form.timezone, enabled: true, command, solar, holidayDates: form.holidayDates, lastRunAt: null, nextRunAt: demo ? new Date(Date.now() + 3_600_000).toISOString() : null };
      if (demo) { setSchedules(current => [schedule, ...current]); setMessage("Demo timer saved in this browser only."); return; }
      await api.request("/schedules", { method: "POST", body: JSON.stringify(schedule) });
      setMessage("Timer saved. Your Raspberry Pi will run it at the chosen time.");
      await refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Unable to create timer."); }
  };

  const remove = async (id: number) => {
    if (demo) { setSchedules(current => current.filter(schedule => schedule.id !== id)); setMessage("Demo timer removed from this browser only."); return; }
    try { await api.request(`/schedules/${id}`, { method: "DELETE" }); await refresh(); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Unable to delete timer."); }
  };

  const targetLabel = form.targetType === "network" ? "all lights" : selectableTargets.find(target => target.type === form.targetType && String(target.id) === form.targetId)?.label || `the selected ${form.targetType}`;
  const actionLabel = form.operation === "set_level" ? `set ${targetLabel} to ${form.value}%` : form.operation === "on" ? `turn on ${targetLabel}` : `turn off ${targetLabel}`;
  const solarPhrase = form.trigger === "sunrise" ? "at sunrise" : form.trigger === "sunset" ? "at sunset" : "";
  const formatNextRun = (value: string | null | undefined) => value ? new Date(value).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "Not available";
  return <div className="schedule-page">
    {demo && <p className="demo-banner"><CalendarClock /> DEMO MODE — timers below are interactive browser-only examples. No scheduler or Raspberry Pi data is changed.</p>}
    <div className="section-heading"><div><p className="eyebrow"><CalendarClock /> LIGHTING AUTOMATION</p><h2>SMART <em>//</em> TIMERS</h2></div></div>
    <div className="schedule-layout"><HudFrame className="form-panel timer-editor"><h3><Plus /> NEW TIMER</h3><p className="muted-copy">Choose when your lighting should change. The Raspberry Pi handles the timing in the background.</p><form onSubmit={submit} className="admin-form">
      <label>WHAT SHOULD WE CALL THIS TIMER?<input value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} placeholder="e.g. Evening lights" /></label>
      <label>WHEN SHOULD IT HAPPEN?<select value={form.trigger} onChange={event => setForm({ ...form, trigger: event.target.value as TimerForm["trigger"] })}><option value="time">At a time</option><option value="sunrise">At sunrise</option><option value="sunset">At sunset</option></select></label>
      {form.trigger === "time" ? <><label>AT WHAT TIME?<input type="time" value={form.time} onChange={event => setForm({ ...form, time: event.target.value })} /></label><fieldset className="day-picker"><legend>ON WHICH DAYS?</legend><div className="repeat-choice"><button type="button" aria-pressed={form.repeat === "daily"} className={form.repeat === "daily" ? "selected" : ""} onClick={() => changeRepeat("daily")}>EVERY DAY</button><button type="button" aria-pressed={form.repeat === "weekdays"} className={form.repeat === "weekdays" ? "selected" : ""} onClick={() => changeRepeat("weekdays")}>WEEKDAYS</button><button type="button" aria-pressed={form.repeat === "weekends"} className={form.repeat === "weekends" ? "selected" : ""} onClick={() => changeRepeat("weekends")}>WEEKENDS</button><button type="button" aria-pressed={form.repeat === "custom"} className={form.repeat === "custom" ? "selected" : ""} onClick={() => changeRepeat("custom")}>PICK DAYS</button></div><div className="weekday-choice">{WEEKDAYS.map(day => <button type="button" key={day.value} aria-pressed={form.repeat === "custom" && form.days.includes(day.value)} className={form.repeat === "custom" && form.days.includes(day.value) ? "selected" : ""} onClick={() => toggleSpecificDay(day.value)}>{day.short}</button>)}</div></fieldset></> : <label>MINUTES BEFORE (−) OR AFTER (+)<input type="number" min="-180" max="180" step="1" value={form.solarOffsetMinutes} onChange={event => setForm({ ...form, solarOffsetMinutes: event.target.value })} /><small>Runs every day. Your administrator sets the local solar location.</small></label>}
      <label>YOUR TIME ZONE<input value={form.timezone} onChange={event => setForm({ ...form, timezone: event.target.value })} /></label>
      <div className="form-grid"><label>WHICH LIGHTS?<select value={form.targetType} onChange={event => updateTargetType(event.target.value)}><option value="network">All lights</option><option value="unit">A lamp</option><option value="group">A group</option><option value="room">A room</option></select></label>{form.targetType !== "network" && <label>CHOOSE {form.targetType.toUpperCase()}<select value={form.targetId} onChange={event => setForm({ ...form, targetId: event.target.value })}><option value="">Select…</option>{selectableTargets.filter(target => target.type === form.targetType).map(target => <option key={`${target.type}-${target.id}`} value={target.id}>{target.label}</option>)}</select></label>}</div>
      <div className="form-grid"><label>WHAT SHOULD HAPPEN?<select value={form.operation} onChange={event => setForm({ ...form, operation: event.target.value })}><option value="set_level">Set brightness</option><option value="on">Turn on</option><option value="off">Turn off</option></select></label>{form.operation === "set_level" && <label>BRIGHTNESS<input type="number" min="0" max="100" value={form.value} onChange={event => setForm({ ...form, value: event.target.value })} /><small>0–100%</small></label>}</div>
      {supportsFade && <label>FADE GENTLY FOR<input type="number" min="0" max="60" step="0.1" value={form.fadeDurationSeconds} onChange={event => setForm({ ...form, fadeDurationSeconds: event.target.value })} /><small>Optional, from 0 to 60 seconds.</small></label>}
      <fieldset className="holiday-exclusions"><legend>SKIP WHEN YOU ARE AWAY (OPTIONAL)</legend><div><input type="date" value={holidayInput} onChange={event => setHolidayInput(event.target.value)} /><button type="button" className="outline-button" onClick={addHoliday} disabled={!holidayInput}>ADD DATE</button></div>{form.holidayDates.length > 0 ? <ul>{form.holidayDates.map(date => <li key={date}>{new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}<button type="button" onClick={() => removeHoliday(date)} aria-label={`Remove away date ${date}`}>×</button></li>)}</ul> : <small>Add the dates when this timer should stay quiet.</small>}</fieldset>
      <p className="timer-preview"><Check /> {actionLabel} {form.trigger === "time" ? `at ${form.time} ${form.repeat === "daily" ? "every day" : form.repeat === "weekdays" ? "on weekdays" : form.repeat === "weekends" ? "on weekends" : form.days.length ? `on ${form.days.map(day => WEEKDAYS.find(candidate => candidate.value === day)?.short).join(", ")}` : "on selected days"}` : `${solarPhrase}${Number(form.solarOffsetMinutes) ? ` ${Number(form.solarOffsetMinutes) > 0 ? `${form.solarOffsetMinutes} min after` : `${Math.abs(Number(form.solarOffsetMinutes))} min before`}` : ""} every day` }.{form.holidayDates.length ? ` It will skip ${form.holidayDates.length} away date${form.holidayDates.length === 1 ? "" : "s"}.` : ""}</p>
      <button className="neon-button">{demo ? "SAVE DEMO TIMER" : "SAVE TIMER"}</button>
    </form>{message && <p className="form-notice">{message}</p>}<p className="muted-copy">{demo ? "Demo timers are retained only in this browser session." : "Timers are saved locally on your Raspberry Pi and continue to run after a restart."}</p></HudFrame>
      <HudFrame className="schedule-list"><h3>YOUR TIMERS <span>{schedules.length}</span></h3>{schedules.length === 0 ? <p className="muted-copy">No timers yet. Create one to automate your lighting.</p> : schedules.map(schedule => { const fadeDurationMs = (schedule.command as TimerCommand).fadeDurationMs; const solarLabel = schedule.solar ? `${schedule.solar.offsetMinutes === 0 ? "At" : `${Math.abs(schedule.solar.offsetMinutes)} min ${schedule.solar.offsetMinutes > 0 ? "after" : "before"}`} ${schedule.solar.event}` : describeCronExpression(schedule.cronExpression); return <article key={schedule.id}><div><p>{schedule.name}</p><code>{solarLabel} · {schedule.timezone}</code><small>{schedule.command.operation === "set_level" ? "Set brightness" : schedule.command.operation === "on" ? "Turn on" : "Turn off"} · {schedule.command.targetType === "network" ? "All lights" : schedule.command.targetType}{fadeDurationMs ? ` · Fade ${fadeDurationMs / 1000}s` : ""}{schedule.lastRunAt ? ` · last ${new Date(schedule.lastRunAt).toLocaleString()}` : ""}</small>{schedule.holidayDates.length > 0 && <small className="holiday-summary">SKIPS · {schedule.holidayDates.join(", ")}</small>}<b className="next-run">NEXT RUN · {formatNextRun(schedule.nextRunAt)}</b></div><button className="icon-button danger" onClick={() => void remove(schedule.id)} aria-label={`Delete ${schedule.name}`}><Trash2 /></button></article>; })}</HudFrame></div>
  </div>;
}
