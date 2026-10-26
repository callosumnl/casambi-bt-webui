import { useState } from "react";
import { HudFrame } from "@/components/HudFrame";
import { LocalApi, NetworkSnapshot } from "@/lib/localApi";
import { isLamp } from "@/lib/scenes";

const PAGE_SIZE = 50;
type Props = { api: LocalApi; network: NetworkSnapshot | null; refresh: () => Promise<void>; onNotice: (message: string) => void };

/**
 * Custom names and rooms for every unit. Large networks get a search, a room filter, pages of 50, and assigning
 * a selection to a room in one request.
 */
export function DeviceMetadataPanel({ api, network, refresh, onNotice }: Props) {
  const [query, setQuery] = useState("");
  const [roomFilter, setRoomFilter] = useState("all");
  const [shown, setShown] = useState(PAGE_SIZE);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [targetRoom, setTargetRoom] = useState("");
  const units = network?.units ?? [];
  const rooms = network?.rooms ?? [];
  const search = query.trim().toLowerCase();
  const matching = units.filter(unit => (roomFilter === "all" || (roomFilter === "none" ? !unit.roomId : unit.roomId === Number(roomFilter)))
    && (!search || `${unit.name} ${unit.roomName ?? ""}`.toLowerCase().includes(search)));
  const visible = matching.slice(0, shown);

  /** Sends only the changed field: re-saving an unchanged name would pin it and hide later renames made in the Casambi app. */
  const saveMetadata = async (unitId: number, change: { customName?: string | null; roomId?: number | null }) => { try { await api.request(`/admin/devices/${unitId}/metadata`, { method: "PUT", body: JSON.stringify(change) }); onNotice("Device metadata saved."); await refresh(); } catch (error) { onNotice(error instanceof Error ? error.message : "Unable to save device metadata."); } };
  const assignSelected = async () => {
    const roomId = targetRoom === "none" ? null : Number(targetRoom);
    try {
      await api.request("/admin/devices/room", { method: "PUT", body: JSON.stringify({ unitIds: Array.from(selected), roomId }) });
      onNotice(`${selected.size} ${selected.size === 1 ? "unit" : "units"} ${roomId === null ? "removed from their room" : `moved to ${rooms.find(room => room.id === roomId)?.name ?? "the room"}`}.`);
      setSelected(new Set()); await refresh();
    } catch (error) { onNotice(error instanceof Error ? error.message : "Unable to assign the units."); }
  };
  const toggle = (unitId: number, on: boolean) => setSelected(current => { const next = new Set(current); if (on) next.add(unitId); else next.delete(unitId); return next; });
  const allVisibleSelected = visible.length > 0 && visible.every(unit => selected.has(unit.id));
  const resetPaging = () => setShown(PAGE_SIZE);

  return <HudFrame className="device-metadata"><h3>DEVICE METADATA</h3><p className="muted-copy">Leave a name empty to use the name from the Casambi app.</p>
    {units.length > 0 && <div className="device-tools">
      <input type="search" value={query} onChange={event => { setQuery(event.target.value); resetPaging(); }} placeholder="Search units or rooms" aria-label="Search units or rooms" />
      <select value={roomFilter} onChange={event => { setRoomFilter(event.target.value); resetPaging(); }} aria-label="Show units in"><option value="all">All rooms ({units.length})</option><option value="none">Not in a room</option>{rooms.map(room => <option key={room.id} value={room.id}>{room.name}</option>)}</select>
      <label className="checkbox-row"><input type="checkbox" checked={allVisibleSelected} onChange={event => setSelected(current => { const next = new Set(current); for (const unit of visible) { if (event.target.checked) next.add(unit.id); else next.delete(unit.id); } return next; })} /> Select shown</label>
    </div>}
    {selected.size > 0 && <div className="device-bulk" role="group" aria-label="Assign selected units">
      <span>{selected.size} selected</span>
      <select value={targetRoom} onChange={event => setTargetRoom(event.target.value)} aria-label="Room for the selected units"><option value="" disabled>Move to room…</option><option value="none">No room</option>{rooms.map(room => <option key={room.id} value={room.id}>{room.name}</option>)}</select>
      <button type="button" className="outline-button" disabled={!targetRoom} onClick={() => void assignSelected()}>ASSIGN</button>
      <button type="button" className="outline-button" onClick={() => setSelected(new Set())}>CLEAR</button>
    </div>}
    {visible.map(unit => <article key={unit.id}><label className="device-pick"><input type="checkbox" checked={selected.has(unit.id)} onChange={event => toggle(unit.id, event.target.checked)} aria-label={`Select ${unit.name}`} /><strong>{unit.name}{!isLamp(unit) && <small> · switch or sensor</small>}</strong></label><div><input aria-label={`Custom name for ${unit.name}`} defaultValue={unit.name} key={unit.name} placeholder="Casambi name" onBlur={event => { const value = event.target.value.trim(); if (value !== unit.name) void saveMetadata(unit.id, { customName: value || null }); }} /><select aria-label={`Room of ${unit.name}`} value={unit.roomId ?? ""} onChange={event => void saveMetadata(unit.id, { roomId: event.target.value ? Number(event.target.value) : null })}><option value="">Unassigned</option>{rooms.map(room => <option key={room.id} value={room.id}>{room.name}</option>)}</select></div></article>)}
    {matching.length > visible.length && <button type="button" className="outline-button device-more" onClick={() => setShown(current => current + PAGE_SIZE)}>SHOW {Math.min(PAGE_SIZE, matching.length - visible.length)} MORE OF {matching.length - visible.length}</button>}
    {units.length > 0 && matching.length === 0 && <p className="muted-copy">No unit matches.</p>}
    {!units.length && <p className="muted-copy">Connect a network to manage discovered lamps.</p>}
  </HudFrame>;
}
