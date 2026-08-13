import { CalendarClock, Plus, Trash2 } from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { HudFrame } from "@/components/HudFrame";
import { LocalApi, Schedule } from "@/lib/localApi";
import { percentToDimmer } from "@/lib/brightness";

type TimerCommand = Schedule["command"] & { fadeDurationMs?: number };

const demoSchedules: Schedule[] = [{ id: 9001, name: "Gallery welcome", cronExpression: "0 9 * * 1-5", timezone: "Europe/Amsterdam", enabled: true, command: { targetType: "group", targetId: 201, operation: "on", fadeDurationMs: 1200 }, lastRunAt: null }];

/** Database-backed timer editor with optional, bounded software fade durations. */
export default function Schedules({ demo = false }: { demo?: boolean }) {
  const api = useMemo(() => new LocalApi(), []);
  const [schedules, setSchedules] = useState<Schedule[]>(() => demo ? demoSchedules : []);
  const [message, setMessage] = useState("");
  const [form, setForm] = useState({ name: "Evening dim", cronExpression: "0 18 * * *", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", targetType: "network", targetId: "", operation: "set_level", value: "50", fadeDurationSeconds: "0" });
  const supportsFade = ["set_level", "on", "off"].includes(form.operation);

  const refresh = async () => {
    if (demo) return;
    try { setSchedules(await api.request<Schedule[]>("/schedules")); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Unable to load schedules."); }
  };
  useEffect(() => { if (!demo) void refresh(); }, [demo]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const fadeDurationSeconds = supportsFade ? Number(form.fadeDurationSeconds) : 0;
    const command: TimerCommand = {
      targetType: form.targetType,
      targetId: form.targetType === "network" ? null : Number(form.targetId),
      operation: form.operation,
      ...(form.operation === "set_level" ? { value: percentToDimmer(Number(form.value)) } : {}),
      ...(fadeDurationSeconds > 0 ? { fadeDurationMs: Math.round(fadeDurationSeconds * 1000) } : {}),
    };
    const schedule: Schedule = { id: Date.now(), name: form.name, cronExpression: form.cronExpression, timezone: form.timezone, enabled: true, command, lastRunAt: null };
    if (demo) {
      setSchedules(current => [schedule, ...current]);
      setMessage("Demo timer saved in this browser only. It will disappear when you exit Demo mode.");
      return;
    }
    try {
      await api.request("/schedules", { method: "POST", body: JSON.stringify(schedule) });
      setMessage("Timer deployed to the local scheduler.");
      await refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Unable to create timer."); }
  };

  const remove = async (id: number) => {
    if (demo) { setSchedules(current => current.filter(schedule => schedule.id !== id)); setMessage("Demo timer removed from this browser only."); return; }
    try { await api.request(`/schedules/${id}`, { method: "DELETE" }); await refresh(); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Unable to delete timer."); }
  };

  return <div className="schedule-page">
    {demo && <p className="demo-banner"><CalendarClock /> DEMO MODE — timer rules below are interactive browser-only examples. No scheduler or Raspberry Pi data is changed.</p>}
    <div className="section-heading"><div><p className="eyebrow"><CalendarClock /> LOCAL AUTOMATION</p><h2>TIMERS <em>//</em> RULES</h2></div></div>
    <div className="schedule-layout"><HudFrame className="form-panel"><h3><Plus /> CREATE TIMER</h3><form onSubmit={submit} className="admin-form">
      <label>RULE NAME<input value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} /></label>
      <label>CRON (MIN HOUR DAY MONTH WEEKDAY)<input value={form.cronExpression} onChange={event => setForm({ ...form, cronExpression: event.target.value })} /></label>
      <label>TIMEZONE<input value={form.timezone} onChange={event => setForm({ ...form, timezone: event.target.value })} /></label>
      <div className="form-grid"><label>TARGET<select value={form.targetType} onChange={event => setForm({ ...form, targetType: event.target.value })}><option value="network">Network</option><option value="unit">Lamp ID</option><option value="group">Group ID</option><option value="room">Room ID</option></select></label><label>TARGET ID<input disabled={form.targetType === "network"} value={form.targetId} onChange={event => setForm({ ...form, targetId: event.target.value })} /></label></div>
      <div className="form-grid"><label>ACTION<select value={form.operation} onChange={event => setForm({ ...form, operation: event.target.value })}><option value="set_level">Set brightness</option><option value="on">Turn on</option><option value="off">Turn off</option></select></label>{form.operation === "set_level" && <label>BRIGHTNESS (0–100%)<input type="number" min="0" max="100" value={form.value} onChange={event => setForm({ ...form, value: event.target.value })} /></label>}</div>
      {supportsFade && <label>FADE DURATION (SECONDS)<input type="number" min="0" max="60" step="0.1" value={form.fadeDurationSeconds} onChange={event => setForm({ ...form, fadeDurationSeconds: event.target.value })} /><small>0–60 seconds. The bridge uses 200 ms control steps because the upstream library has no native fade argument.</small></label>}
      <button className="neon-button">{demo ? "SAVE DEMO TIMER" : "SAVE TIMER"}</button>
    </form>{message && <p className="form-notice">{message}</p>}<p className="muted-copy">{demo ? "Demo rules are retained only in the current browser session." : "Rules run locally on the Raspberry Pi. Five-field cron syntax and fade duration are validated before a rule is stored."}</p></HudFrame>
      <HudFrame className="schedule-list"><h3>DEPLOYED RULES <span>{schedules.length}</span></h3>{schedules.length === 0 ? <p className="muted-copy">No timer rules are active.</p> : schedules.map(schedule => { const fadeDurationMs = (schedule.command as TimerCommand).fadeDurationMs; return <article key={schedule.id}><div><p>{schedule.name}</p><code>{schedule.cronExpression} · {schedule.timezone}</code><small>{schedule.command.operation.replaceAll("_", " ")} → {schedule.command.targetType}{fadeDurationMs ? ` · ${fadeDurationMs / 1000}s fade` : ""}{schedule.lastRunAt ? ` · last ${new Date(schedule.lastRunAt).toLocaleString()}` : ""}</small></div><button className="icon-button danger" onClick={() => void remove(schedule.id)} aria-label={`Delete ${schedule.name}`}><Trash2 /></button></article>; })}</HudFrame></div>
  </div>;
}
