import { MousePointerClick, Plus, Trash2 } from "lucide-react";
import { FormEvent, useEffect, useRef, useState } from "react";
import { HudFrame } from "@/components/HudFrame";
import { dimmerToPercent, percentToDimmer } from "@/lib/brightness";
import { connectedBuild, watchBuild } from "@/lib/buildWatch";
import { LocalApi, LocalScene, NetworkSnapshot, SwitchPress, SwitchRule, SwitchTrigger } from "@/lib/localApi";
import { isLamp, parseSceneTarget, sceneTargetOptions } from "@/lib/scenes";

type Props = { api: LocalApi; onNotice: (message: string) => void };
type RuleForm = { name: string; unitId: string; button: string; trigger: SwitchTrigger; targetType: string; targetId: string; operation: string; value: string };

const TRIGGER_LABELS: Record<SwitchTrigger, string> = { tap: "Tap", hold: "Hold", release_after_hold: "Release after hold" };
const ACTIVITY_LIMIT = 50;
const initialForm: RuleForm = { name: "", unitId: "", button: "", trigger: "tap", targetType: "unit", targetId: "", operation: "toggle", value: "50" };

/** Live switch activity for identifying buttons, plus rules that run a lighting command when a button is used. */
export function SwitchRulesPanel({ api, onNotice }: Props) {
  const [network, setNetwork] = useState<NetworkSnapshot | null>(null);
  const [scenes, setScenes] = useState<LocalScene[]>([]);
  const [activity, setActivity] = useState<SwitchPress[]>([]);
  const [rules, setRules] = useState<SwitchRule[]>([]);
  const [showRaw, setShowRaw] = useState(false);
  const [form, setForm] = useState<RuleForm>(initialForm);
  const [editingId, setEditingId] = useState<number | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  const loadRules = async () => { try { setRules(await api.request<SwitchRule[]>("/admin/switch-rules")); } catch (error) { onNotice(error instanceof Error ? error.message : "Unable to load switch rules."); } };
  useEffect(() => {
    void (async () => {
      try {
        const [nextRules, nextActivity, nextNetwork, nextScenes] = await Promise.all([api.request<SwitchRule[]>("/admin/switch-rules"), api.request<SwitchPress[]>("/admin/switch-activity"), api.request<NetworkSnapshot>("/network"), api.request<LocalScene[]>("/local-scenes")]);
        setRules(nextRules); setActivity(nextActivity); setNetwork(nextNetwork); setScenes(nextScenes);
      } catch (error) { onNotice(error instanceof Error ? error.message : "Unable to load switch activity."); }
    })();
    let source: EventSource | undefined; let reopen: number | undefined; let closed = false;
    const open = async () => {
      let url: string;
      try { url = await api.eventUrl(); } catch { if (!closed) reopen = window.setTimeout(() => void open(), 5_000); return; }
      if (closed) return;
      source = new EventSource(url);
      source.addEventListener("connected", event => watchBuild(connectedBuild(event)));
      source.addEventListener("switch", event => { const press = (JSON.parse(event.data) as { payload: SwitchPress }).payload; setActivity(current => [press, ...current].slice(0, ACTIVITY_LIMIT)); });
      // Refresh "last triggered" after a rule runs.
      source.addEventListener("switch_rule.executed", () => void loadRules());
      // After a non-200 answer (e.g. an expired ticket) the browser stops retrying: reopen with a new ticket.
      source.onerror = () => { if (source?.readyState === EventSource.CLOSED) reopen = window.setTimeout(() => void open(), 5_000); };
    };
    void open();
    return () => { closed = true; window.clearTimeout(reopen); source?.close(); };
  }, []);

  const targets = [
    ...(network?.units.filter(isLamp).map(unit => ({ type: "unit", id: unit.id, label: unit.name })) ?? []),
    ...(network?.groups.map(group => ({ type: "group", id: group.id, label: group.name })) ?? []),
    ...(network?.rooms.map(room => ({ type: "room", id: room.id, label: room.name })) ?? []),
  ];
  const sceneOptions = sceneTargetOptions(network, scenes);
  const isScene = form.targetType === "scene";
  const targetLabel = (type: string, id: unknown) => type === "network" ? "all lights" : type === "scene" || type === "local_scene" ? `scene ${sceneOptions.find(option => option.value === `${type}:${id}`)?.label.split(" · ")[0] ?? "(deleted)"}` : targets.find(target => target.type === type && String(target.id) === String(id))?.label ?? `${type} ${id}`;
  const switchLabel = (unitId: number | null) => network?.units.find(unit => unit.id === unitId)?.name ?? `Switch ${unitId ?? "?"}`;
  const actionLabel = (command: SwitchRule["command"]) => {
    const target = targetLabel(command.targetType, command.targetId);
    if (command.operation === "toggle") return `toggle ${target}`;
    if (command.operation === "activate_scene") return `activate ${target}`;
    if (command.operation === "set_level") return `set ${target} to ${dimmerToPercent(Number(command.value))}%`;
    return `turn ${command.operation} ${target}`;
  };

  const selectPress = (press: SwitchPress) => {
    if (press.trigger === null || press.unitId === null || press.button === null) return;
    setForm(current => ({ ...current, unitId: String(press.unitId), button: String(press.button), trigger: press.trigger as SwitchTrigger }));
    onNotice(`${switchLabel(press.unitId)} · button ${press.button} · ${TRIGGER_LABELS[press.trigger].toLowerCase()} selected in the rule form.`);
  };
  const createRule = async (event: FormEvent) => {
    event.preventDefault();
    try {
      if (form.targetType !== "network" && !form.targetId) throw new Error(isScene ? "Choose the scene to activate." : "Choose the lamp, group, or room to control.");
      const command = isScene ? { ...parseSceneTarget(form.targetId), operation: "activate_scene" } : { targetType: form.targetType, targetId: form.targetType === "network" ? null : Number(form.targetId), operation: form.operation, ...(form.operation === "set_level" ? { value: percentToDimmer(Number(form.value)) } : {}) };
      const body = JSON.stringify({ name: form.name, unitId: Number(form.unitId), button: Number(form.button), trigger: form.trigger, command });
      if (editingId === null) { await api.request("/admin/switch-rules", { method: "POST", body }); onNotice("Switch rule created. It runs the next time that button is used."); }
      else { await api.request(`/admin/switch-rules/${editingId}`, { method: "PATCH", body }); onNotice("Switch rule saved."); setEditingId(null); }
      setForm(current => ({ ...current, name: "" }));
      await loadRules();
    } catch (error) { onNotice(error instanceof Error ? error.message : "Unable to save switch rule."); }
  };
  /** Loads a rule into the form for editing. */
  const editRule = (rule: SwitchRule) => {
    const { command } = rule;
    const scene = command.targetType === "scene" || command.targetType === "local_scene";
    setForm({
      name: rule.name, unitId: String(rule.unitId), button: String(rule.button), trigger: rule.trigger,
      targetType: scene ? "scene" : command.targetType, targetId: scene ? `${command.targetType}:${command.targetId}` : command.targetId == null ? "" : String(command.targetId),
      operation: scene ? "toggle" : command.operation, value: command.operation === "set_level" ? String(dimmerToPercent(Number(command.value))) : "50",
    });
    setEditingId(rule.id);
    formRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  };
  const cancelEdit = () => { setEditingId(null); setForm(initialForm); };
  const setEnabled = async (rule: SwitchRule, enabled: boolean) => {
    try { await api.request(`/admin/switch-rules/${rule.id}`, { method: "PATCH", body: JSON.stringify({ enabled }) }); await loadRules(); }
    catch (error) { onNotice(error instanceof Error ? error.message : "Unable to update switch rule."); }
  };
  const removeRule = async (rule: SwitchRule) => {
    try { await api.request(`/admin/switch-rules/${rule.id}`, { method: "DELETE" }); onNotice(`${rule.name} deleted.`); await loadRules(); }
    catch (error) { onNotice(error instanceof Error ? error.message : "Unable to delete switch rule."); }
  };

  const visibleActivity = activity.filter(press => showRaw || press.trigger !== null);
  return <HudFrame className="form-panel switch-manager"><h3><MousePointerClick /> SWITCH RULES</h3>
    <p className="muted-copy">Press a physical Casambi button to see it here, then choose USE to fill in the rule form. Rules run in addition to anything the button already does in the Casambi app.</p>
    <div className="switch-activity"><div className="switch-activity-heading"><strong>LIVE SWITCH ACTIVITY</strong><label><input type="checkbox" checked={showRaw} onChange={event => setShowRaw(event.target.checked)} /> Show raw messages</label></div>
      {visibleActivity.length === 0 ? <p className="muted-copy">No button presses yet. Press a switch while the bridge is connected.</p> : <ul>{visibleActivity.map((press, index) => <li key={`${press.at}-${index}`} className={press.trigger ? "" : "raw"}><time>{new Date(press.at).toLocaleTimeString()}</time><span>{switchLabel(press.unitId)} · button {press.button ?? "?"} · {press.trigger ? TRIGGER_LABELS[press.trigger] : `raw ${String(press.raw.event ?? "")} (type ${String(press.raw.messageType ?? "?")})`}</span>{press.trigger && <button type="button" className="outline-button" onClick={() => selectPress(press)}>USE</button>}</li>)}</ul>}
    </div>
    <form ref={formRef} onSubmit={createRule} className="admin-form">
      <label>RULE NAME<input value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} placeholder="e.g. Eiland toggle" required /></label>
      <div className="form-grid"><label>SWITCH UNIT ID<input type="number" min="0" value={form.unitId} onChange={event => setForm({ ...form, unitId: event.target.value })} required /></label><label>BUTTON<input type="number" min="0" value={form.button} onChange={event => setForm({ ...form, button: event.target.value })} required /></label></div>
      <label>WHEN THE BUTTON IS…<select value={form.trigger} onChange={event => setForm({ ...form, trigger: event.target.value as SwitchTrigger })}><option value="tap">Tapped (short press)</option><option value="hold">Held (fires after ~0.7 s)</option><option value="release_after_hold">Released after a hold</option></select></label>
      <div className="form-grid"><label>WHICH LIGHTS?<select value={form.targetType} onChange={event => setForm({ ...form, targetType: event.target.value, targetId: "" })}><option value="unit">A lamp</option><option value="group">A group</option><option value="room">A room</option><option value="network">All lights</option><option value="scene">A scene</option></select></label>{form.targetType !== "network" && <label>CHOOSE {form.targetType.toUpperCase()}<select value={form.targetId} onChange={event => setForm({ ...form, targetId: event.target.value })}><option value="">Select…</option>{isScene ? sceneOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>) : targets.filter(target => target.type === form.targetType).map(target => <option key={`${target.type}-${target.id}`} value={target.id}>{target.label}</option>)}</select></label>}</div>
      {!isScene && <div className="form-grid"><label>WHAT SHOULD HAPPEN?<select value={form.operation} onChange={event => setForm({ ...form, operation: event.target.value })}><option value="toggle">Toggle on/off</option><option value="on">Turn on</option><option value="off">Turn off</option><option value="set_level">Set brightness</option></select></label>{form.operation === "set_level" && <label>BRIGHTNESS<input type="number" min="0" max="100" value={form.value} onChange={event => setForm({ ...form, value: event.target.value })} /><small>0–100%</small></label>}</div>}
      <button className="neon-button" disabled={!form.name || form.unitId === "" || form.button === ""}><Plus /> {editingId === null ? "CREATE SWITCH RULE" : "SAVE CHANGES"}</button>{editingId !== null && <button type="button" className="outline-button" onClick={cancelEdit}>CANCEL</button>}
    </form>
    <div className="away-set-list">{rules.length === 0 ? <p className="muted-copy">No switch rules yet.</p> : rules.map(rule => <article key={rule.id}><div><strong>{rule.name}</strong><small>{switchLabel(rule.unitId)} · button {rule.button} · {TRIGGER_LABELS[rule.trigger]} → {actionLabel(rule.command)}{rule.lastTriggeredAt ? ` · last run ${new Date(rule.lastTriggeredAt).toLocaleString()}` : ""}</small></div><div className="away-set-actions"><label className="switch-rule-enabled"><input type="checkbox" checked={rule.enabled} onChange={event => void setEnabled(rule, event.target.checked)} /> Enabled</label><button type="button" className="outline-button" aria-pressed={editingId === rule.id} onClick={() => editRule(rule)}>EDIT</button><button type="button" className="icon-button danger" aria-label={`Delete ${rule.name}`} onClick={() => void removeRule(rule)}><Trash2 /></button></div></article>)}</div>
  </HudFrame>;
}
