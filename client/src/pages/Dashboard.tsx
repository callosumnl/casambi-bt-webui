import { AlertTriangle, Plus, RefreshCw, X } from "lucide-react";
import { FormEvent, useState } from "react";
import "./Dashboard.css";
import { ConnectionStatusBar } from "@/components/ConnectionStatusBar";
import { DeviceControlCard } from "@/components/DeviceControlCard";
import { HudFrame } from "@/components/HudFrame";
import { useNetwork } from "@/hooks/useNetwork";
import { useSliderCommit } from "@/hooks/useSliderCommit";
import { percentToDimmer } from "@/lib/brightness";
import type { LocalScene, SceneScope } from "@/lib/localApi";
import { averageBrightnessPercent, isLamp, sameScope, scopeLamps } from "@/lib/scenes";

type Chip = { key: string; label: string; kind?: "casambi" | "default"; scene?: LocalScene; apply: () => void };

/** Lighting controls first: groups and rooms (with their scenes), then individual lamps. Switches are not shown here. */
export default function Dashboard() {
  const { network, loading, error, connection, command, applyRoomDefault, refresh, scenes, saveScene, updateScene, deleteScene, applyScene } = useNetwork();
  if (loading) return <div className="loading-grid">CONNECTING TO LIGHTING GRID…</div>;
  if (!network) return <HudFrame className="empty-state"><AlertTriangle /><h2>NETWORK OFFLINE</h2><p>{error || "No Casambi snapshot is available yet."}</p><button className="neon-button" onClick={() => void refresh(true)}>RETRY LINK</button></HudFrame>;

  const lamps = network.units.filter(isLamp);
  const sensors = network.units.flatMap(unit => unit.state.sensors.map(sensor => ({ unit, sensor })));
  const sceneChips = (scope: SceneScope): Chip[] => scenes.filter(scene => sameScope(scene.scope, scope)).map(scene => ({ key: `scene-${scene.id}`, label: scene.name, scene, apply: () => void applyScene(scene.id) }));
  const rows = [
    { key: "network", tag: "ALL", name: "All lights", scope: { type: "network", id: null } as SceneScope, extra: network.scenes.map(scene => ({ key: `casambi-${scene.id}`, label: scene.name, kind: "casambi" as const, apply: () => void command({ targetType: "scene", targetId: scene.id, operation: "activate_scene" }) })) },
    ...network.groups.map(group => ({ key: `group-${group.id}`, tag: "GROUP", name: group.name, scope: { type: "group", id: group.id } as SceneScope, extra: [] as Chip[] })),
    ...network.rooms.map(room => ({ key: `room-${room.id}`, tag: "ROOM", name: room.name, scope: { type: "room", id: room.id } as SceneScope, extra: [{ key: `default-${room.id}`, label: `Default ${room.defaultBrightnessPercent}%`, kind: "default" as const, apply: () => void applyRoomDefault(room.id) }] })),
  ];

  return <div className="dashboard-page">
    <div className="status-strip">
      <span className={`status-light ${network.connected ? "on" : "off"}`} aria-hidden="true" />
      <strong>{network.connected ? "Online" : "Offline"}</strong>
      <span>{network.network?.name || "No network"}</span>
      <span>{lamps.filter(lamp => lamp.state.on).length}/{lamps.length} on</span>
      <button className="strip-sync" onClick={() => void refresh(true)} aria-label="Sync status with the lamps"><RefreshCw /></button>
    </div>
    <ConnectionStatusBar status={connection} />
    {error && <p className="live-warning"><AlertTriangle /> {error}</p>}

    <section aria-labelledby="collective-heading">
      <h2 id="collective-heading" className="section-label">GROUPS & ROOMS</h2>
      <div className="collective-list">{rows.map(row => <CollectiveRow key={row.key} tag={row.tag} name={row.name} level={averageBrightnessPercent(scopeLamps(network, row.scope))}
        send={(operation, value) => command({ targetType: row.scope.type, targetId: row.scope.id, operation, ...(value === undefined ? {} : { value }) })}
        chips={[...row.extra, ...sceneChips(row.scope)]} onSave={name => saveScene(name, row.scope)} onUpdate={id => void updateScene(id)} onDelete={id => void deleteScene(id)} />)}</div>
    </section>

    <section aria-labelledby="lamps-heading">
      <h2 id="lamps-heading" className="section-label">LAMPS</h2>
      {lamps.length === 0 ? <p className="muted-copy">No lamps yet. Ask an admin to connect the Casambi Bluetooth bridge.</p>
        : <div className="lamp-grid">{lamps.map(device => <DeviceControlCard key={device.id} device={device} onCommand={command} />)}</div>}
    </section>

    {sensors.length > 0 && <section aria-labelledby="sensors-heading">
      <h2 id="sensors-heading" className="section-label">SENSORS</h2>
      <ul className="sensor-list">{sensors.map(({ unit, sensor }) => <li key={`${unit.id}-${sensor.label}`}><span>{unit.name} · {sensor.label}</span><strong>{sensor.value ?? "—"}{sensor.unit ? ` ${sensor.unit}` : ""}</strong></li>)}</ul>
    </section>}
  </div>;
}

/** One group, room, or "all lights": on/off, a shared brightness slider, and its scenes as one-tap chips. */
function CollectiveRow({ tag, name, level, send, chips, onSave, onUpdate, onDelete }: { tag: string; name: string; level: number; send: (operation: string, value?: number) => Promise<void>; chips: Chip[]; onSave: (name: string) => Promise<void>; onUpdate: (id: number) => void; onDelete: (id: number) => void }) {
  const brightness = useSliderCommit(level, percent => send("set_level", percentToDimmer(percent)));
  const [naming, setNaming] = useState(false);
  const [sceneName, setSceneName] = useState("");
  const [editing, setEditing] = useState(false);
  const hasOwnScenes = chips.some(chip => chip.scene);
  const submit = async (event: FormEvent) => { event.preventDefault(); if (!sceneName.trim()) return; await onSave(sceneName.trim()); setSceneName(""); setNaming(false); };
  return <article className="collective-row">
    <div className="row-head"><span className="row-tag">{tag}</span><strong>{name}</strong><div className="row-switch"><button onClick={() => void send("on")}>ON</button><button onClick={() => void send("off")}>OFF</button></div></div>
    <label className="row-slider"><span className="sr-only">{name} brightness</span><input type="range" min="0" max="100" value={brightness.value} {...brightness.handlers} /><b>{brightness.value}%</b></label>
    <div className="scene-chips">
      {chips.map(chip => <span key={chip.key} className={`scene-chip ${chip.kind ?? ""}`}>
        <button onClick={chip.apply} title={chip.kind === "casambi" ? "Scene stored in the Casambi network" : chip.kind === "default" ? "Room default brightness" : "Apply this scene"}>{chip.label}</button>
        {editing && chip.scene && <><button className="chip-icon" onClick={() => onUpdate(chip.scene!.id)} aria-label={`Update ${chip.label} to the current lights`} title="Update to the current lights"><RefreshCw /></button><button className="chip-icon" onClick={() => onDelete(chip.scene!.id)} aria-label={`Delete ${chip.label}`} title="Delete"><X /></button></>}
      </span>)}
      {naming
        ? <form className="scene-name" onSubmit={event => void submit(event)}><input autoFocus value={sceneName} maxLength={64} onChange={event => setSceneName(event.target.value)} placeholder="Scene name" aria-label={`Name for the new ${name} scene`} /><button disabled={!sceneName.trim()}>SAVE</button><button type="button" className="chip-icon" onClick={() => { setNaming(false); setSceneName(""); }} aria-label="Cancel"><X /></button></form>
        : <button className="scene-add" onClick={() => setNaming(true)} title="Save the current lights as a scene"><Plus /> SCENE</button>}
      {hasOwnScenes && !naming && <button className="scene-edit" aria-pressed={editing} onClick={() => setEditing(!editing)}>{editing ? "DONE" : "EDIT"}</button>}
    </div>
  </article>;
}
