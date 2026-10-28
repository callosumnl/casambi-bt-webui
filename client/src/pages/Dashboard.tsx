import { AlertTriangle, ChevronRight, Pencil, Plus, RefreshCw, Rocket, Search, X } from "lucide-react";
import { Link } from "wouter";
import { FormEvent, useState } from "react";
import "./Dashboard.css";
import { ConnectionStatusBar } from "@/components/ConnectionStatusBar";
import { DeviceControlCard } from "@/components/DeviceControlCard";
import { HudFrame } from "@/components/HudFrame";
import { useNetwork } from "@/hooks/useNetwork";
import { useSliderCommit } from "@/hooks/useSliderCommit";
import { percentToDimmer } from "@/lib/brightness";
import { getSession, type LocalScene, type SceneScope } from "@/lib/localApi";
import { averageBrightnessPercent, isLamp, lampsByScope, sameScope } from "@/lib/scenes";

type Chip = { key: string; label: string; kind?: "casambi" | "default"; scene?: LocalScene; apply: () => void };
/** Above this many lamps, or more than eight group and room rows, the dashboard adds a search and groups lamps by room. */
const LARGE_NETWORK_LAMPS = 12;
/** Room sections start open up to this many lamps; beyond it they start closed and render nothing until opened. */
const OPEN_SECTIONS_UP_TO = 24;

/** Lighting controls first: groups and rooms (with their scenes), then individual lamps. Switches are not shown here. */
export default function Dashboard() {
  const { network, loading, error, connection, command, applyRoomDefault, refresh, scenes, saveScene, updateScene, renameScene, deleteScene, applyScene } = useNetwork();
  const [query, setQuery] = useState("");
  const [toggledSections, setToggledSections] = useState<Set<string>>(new Set());
  if (loading) return <div className="loading-grid">CONNECTING TO LIGHTING GRID…</div>;
  if (!network) return <HudFrame className="empty-state"><AlertTriangle /><h2>NETWORK OFFLINE</h2><p>{error || "No Casambi snapshot is available yet."}</p><button className="neon-button" onClick={() => void refresh(true)}>RETRY LINK</button></HudFrame>;

  const lamps = network.units.filter(isLamp);
  const rowLamps = lampsByScope(network);
  const sensors = network.units.flatMap(unit => unit.state.sensors.map(sensor => ({ unit, sensor })));
  const sceneChips = (scope: SceneScope): Chip[] => scenes.filter(scene => sameScope(scene.scope, scope)).map(scene => ({ key: `scene-${scene.id}`, label: scene.name, scene, apply: () => void applyScene(scene.id) }));
  const rows = [
    { key: "network", tag: "ALL", name: "All lights", scope: { type: "network", id: null } as SceneScope, extra: network.scenes.map(scene => ({ key: `casambi-${scene.id}`, label: scene.name, kind: "casambi" as const, apply: () => void command({ targetType: "scene", targetId: scene.id, operation: "activate_scene" }) })) },
    ...network.groups.map(group => ({ key: `group-${group.id}`, tag: "GROUP", name: group.name, scope: { type: "group", id: group.id } as SceneScope, extra: [] as Chip[] })),
    ...network.rooms.map(room => ({ key: `room-${room.id}`, tag: "ROOM", name: room.name, scope: { type: "room", id: room.id } as SceneScope, extra: [{ key: `default-${room.id}`, label: `Default ${room.defaultBrightnessPercent}%`, kind: "default" as const, apply: () => void applyRoomDefault(room.id) }] })),
  ];

  const large = lamps.length > LARGE_NETWORK_LAMPS || rows.length > 9;
  const search = query.trim().toLowerCase();
  const matches = (text: string) => !search || text.toLowerCase().includes(search);
  const visibleRows = rows.filter(row => row.key === "network" || matches(row.name));
  const sections = [...network.rooms.map(room => ({ key: `room-${room.id}`, name: room.name, lamps: rowLamps({ type: "room", id: room.id }) })), { key: "unassigned", name: "Not in a room", lamps: lamps.filter(lamp => lamp.roomId == null) }]
    .map(section => ({ ...section, shown: matches(section.name) ? section.lamps : section.lamps.filter(lamp => matches(lamp.name)) }))
    .filter(section => section.shown.length > 0);
  const sectionOpen = (key: string) => Boolean(search) || (lamps.length <= OPEN_SECTIONS_UP_TO) !== toggledSections.has(key);
  const toggleSection = (key: string) => setToggledSections(current => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; });

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
    {large && <label className="dashboard-search"><Search aria-hidden="true" /><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Find a room, group, or lamp" aria-label="Find a room, group, or lamp" /></label>}

    <section aria-labelledby="collective-heading">
      <h2 id="collective-heading" className="section-label">GROUPS & ROOMS</h2>
      <div className="collective-list">{visibleRows.map(row => <CollectiveRow key={row.key} tag={row.tag} name={row.name} level={averageBrightnessPercent(rowLamps(row.scope))}
        send={(operation, value) => command({ targetType: row.scope.type, targetId: row.scope.id, operation, ...(value === undefined ? {} : { value }) })}
        chips={[...row.extra, ...sceneChips(row.scope)]} onSave={name => saveScene(name, row.scope)} onUpdate={id => void updateScene(id)} onRename={(id, name) => renameScene(id, name)} onDelete={id => void deleteScene(id)} />)}</div>
    </section>

    <section aria-labelledby="lamps-heading">
      <h2 id="lamps-heading" className="section-label">LAMPS</h2>
      {lamps.length === 0 ? (getSession()?.user.role === "admin"
        ? <p className="muted-copy">No lamps yet. <Link href="/setup" className="outline-button"><Rocket /> SET UP THE CASAMBI NETWORK</Link></p>
        : <p className="muted-copy">No lamps yet. Ask an admin to connect the Casambi Bluetooth bridge.</p>)
        : !large ? <div className="lamp-grid">{lamps.map(device => <DeviceControlCard key={device.id} device={device} onCommand={command} />)}</div>
          : sections.length === 0 ? <p className="muted-copy">Nothing matches “{query}”.</p>
            : sections.map(section => { const open = sectionOpen(section.key); return <div key={section.key} className="room-section">
              <button className="room-section-head" aria-expanded={open} disabled={Boolean(search)} onClick={() => toggleSection(section.key)}><ChevronRight aria-hidden="true" /><strong>{section.name}</strong><span>{section.lamps.filter(lamp => lamp.state.on).length}/{section.lamps.length} on</span></button>
              {open && <div className="lamp-grid">{section.shown.map(device => <DeviceControlCard key={device.id} device={device} onCommand={command} />)}</div>}
            </div>; })}
    </section>

    {sensors.length > 0 && <section aria-labelledby="sensors-heading">
      <h2 id="sensors-heading" className="section-label">SENSORS</h2>
      <ul className="sensor-list">{sensors.map(({ unit, sensor }) => <li key={`${unit.id}-${sensor.label}`}><span>{unit.name} · {sensor.label}</span><strong>{sensor.value ?? "—"}{sensor.unit ? ` ${sensor.unit}` : ""}</strong></li>)}</ul>
    </section>}
  </div>;
}

/** One group, room, or "all lights": on/off, a shared brightness slider, and its scenes as one-tap chips. */
function CollectiveRow({ tag, name, level, send, chips, onSave, onUpdate, onRename, onDelete }: { tag: string; name: string; level: number; send: (operation: string, value?: number) => Promise<void>; chips: Chip[]; onSave: (name: string) => Promise<void>; onUpdate: (id: number) => void; onRename: (id: number, name: string) => Promise<void>; onDelete: (id: number) => void }) {
  const brightness = useSliderCommit(level, percent => send("set_level", percentToDimmer(percent)));
  const [naming, setNaming] = useState(false);
  const [sceneName, setSceneName] = useState("");
  const [editing, setEditing] = useState(false);
  const [renaming, setRenaming] = useState<{ id: number; name: string } | null>(null);
  const submitRename = async (event: FormEvent) => { event.preventDefault(); if (!renaming?.name.trim()) return; await onRename(renaming.id, renaming.name.trim()); setRenaming(null); };
  const hasOwnScenes = chips.some(chip => chip.scene);
  const submit = async (event: FormEvent) => { event.preventDefault(); if (!sceneName.trim()) return; await onSave(sceneName.trim()); setSceneName(""); setNaming(false); };
  return <article className="collective-row">
    <div className="row-head"><span className="row-tag">{tag}</span><strong>{name}</strong><div className="row-switch"><button onClick={() => void send("on")}>ON</button><button onClick={() => void send("off")}>OFF</button></div></div>
    <label className="row-slider"><span className="sr-only">{name} brightness</span><input type="range" min="0" max="100" value={brightness.value} {...brightness.handlers} /><b>{brightness.value}%</b></label>
    <div className="scene-chips">
      {chips.map(chip => renaming && chip.scene?.id === renaming.id
        ? <form key={chip.key} className="scene-name" onSubmit={event => void submitRename(event)}><input autoFocus value={renaming.name} maxLength={64} onChange={event => setRenaming({ ...renaming, name: event.target.value })} aria-label={`New name for ${chip.label}`} /><button disabled={!renaming.name.trim()}>SAVE</button><button type="button" className="chip-icon" onClick={() => setRenaming(null)} aria-label="Cancel renaming"><X /></button></form>
        : <span key={chip.key} className={`scene-chip ${chip.kind ?? ""}`}>
        <button onClick={chip.apply} title={chip.kind === "casambi" ? "Scene stored in the Casambi network" : chip.kind === "default" ? "Room default brightness" : "Apply this scene"}>{chip.label}</button>
        {editing && chip.scene && <><button className="chip-icon" onClick={() => setRenaming({ id: chip.scene!.id, name: chip.label })} aria-label={`Rename ${chip.label}`} title="Rename"><Pencil /></button><button className="chip-icon" onClick={() => onUpdate(chip.scene!.id)} aria-label={`Update ${chip.label} to the current lights`} title="Update to the current lights"><RefreshCw /></button><button className="chip-icon" onClick={() => onDelete(chip.scene!.id)} aria-label={`Delete ${chip.label}`} title="Delete"><X /></button></>}
      </span>)}
      {naming
        ? <form className="scene-name" onSubmit={event => void submit(event)}><input autoFocus value={sceneName} maxLength={64} onChange={event => setSceneName(event.target.value)} placeholder="Scene name" aria-label={`Name for the new ${name} scene`} /><button disabled={!sceneName.trim()}>SAVE</button><button type="button" className="chip-icon" onClick={() => { setNaming(false); setSceneName(""); }} aria-label="Cancel"><X /></button></form>
        : <button className="scene-add" onClick={() => setNaming(true)} title="Save the current lights as a scene"><Plus /> SCENE</button>}
      {hasOwnScenes && !naming && <button className="scene-edit" aria-pressed={editing} onClick={() => setEditing(!editing)}>{editing ? "DONE" : "EDIT"}</button>}
    </div>
  </article>;
}
