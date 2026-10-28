import { useState } from "react";
import { HudFrame } from "@/components/HudFrame";
import { LocalApi, NetworkSnapshot } from "@/lib/localApi";
import { isLamp } from "@/lib/scenes";
import { t } from "@/lib/i18n";

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
  const saveMetadata = async (unitId: number, change: { customName?: string | null; roomId?: number | null }) => { try { await api.request(`/admin/devices/${unitId}/metadata`, { method: "PUT", body: JSON.stringify(change) }); onNotice(t("Device metadata saved.")); await refresh(); } catch (error) { onNotice(error instanceof Error ? error.message : t("Unable to save device metadata.")); } };
  const assignSelected = async () => {
    const roomId = targetRoom === "none" ? null : Number(targetRoom);
    try {
      await api.request("/admin/devices/room", { method: "PUT", body: JSON.stringify({ unitIds: Array.from(selected), roomId }) });
      const count = selected.size;
      const room = rooms.find(candidate => candidate.id === roomId)?.name ?? t("the room");
      onNotice(roomId === null ? (count === 1 ? t("{count} unit removed from their room.", { count }) : t("{count} units removed from their room.", { count })) : (count === 1 ? t("{count} unit moved to {room}.", { count, room }) : t("{count} units moved to {room}.", { count, room })));
      setSelected(new Set()); await refresh();
    } catch (error) { onNotice(error instanceof Error ? error.message : t("Unable to assign the units.")); }
  };
  const toggle = (unitId: number, on: boolean) => setSelected(current => { const next = new Set(current); if (on) next.add(unitId); else next.delete(unitId); return next; });
  const allVisibleSelected = visible.length > 0 && visible.every(unit => selected.has(unit.id));
  const resetPaging = () => setShown(PAGE_SIZE);

  return <HudFrame className="device-metadata"><h3>{t("DEVICE METADATA")}</h3><p className="muted-copy">{t("Leave a name empty to use the name from the Casambi app.")}</p>
    {units.length > 0 && <div className="device-tools">
      <input type="search" value={query} onChange={event => { setQuery(event.target.value); resetPaging(); }} placeholder={t("Search units or rooms")} aria-label={t("Search units or rooms")} />
      <select value={roomFilter} onChange={event => { setRoomFilter(event.target.value); resetPaging(); }} aria-label={t("Show units in")}><option value="all">{t("All rooms ({count})", { count: units.length })}</option><option value="none">{t("Not in a room")}</option>{rooms.map(room => <option key={room.id} value={room.id}>{room.name}</option>)}</select>
      <label className="checkbox-row"><input type="checkbox" checked={allVisibleSelected} onChange={event => setSelected(current => { const next = new Set(current); for (const unit of visible) { if (event.target.checked) next.add(unit.id); else next.delete(unit.id); } return next; })} /> {t("Select shown")}</label>
    </div>}
    {selected.size > 0 && <div className="device-bulk" role="group" aria-label={t("Assign selected units")}>
      <span>{t("{count} selected", { count: selected.size })}</span>
      <select value={targetRoom} onChange={event => setTargetRoom(event.target.value)} aria-label={t("Room for the selected units")}><option value="" disabled>{t("Move to room…")}</option><option value="none">{t("No room")}</option>{rooms.map(room => <option key={room.id} value={room.id}>{room.name}</option>)}</select>
      <button type="button" className="outline-button" disabled={!targetRoom} onClick={() => void assignSelected()}>{t("ASSIGN")}</button>
      <button type="button" className="outline-button" onClick={() => setSelected(new Set())}>{t("CLEAR")}</button>
    </div>}
    {visible.map(unit => <article key={unit.id}><label className="device-pick"><input type="checkbox" checked={selected.has(unit.id)} onChange={event => toggle(unit.id, event.target.checked)} aria-label={t("Select {name}", { name: unit.name })} /><strong>{unit.name}{!isLamp(unit) && <small> · {t("switch or sensor")}</small>}</strong></label><div><input aria-label={t("Custom name for {name}", { name: unit.name })} defaultValue={unit.name} key={unit.name} placeholder={t("Casambi name")} onBlur={event => { const value = event.target.value.trim(); if (value !== unit.name) void saveMetadata(unit.id, { customName: value || null }); }} /><select aria-label={t("Room of {name}", { name: unit.name })} value={unit.roomId ?? ""} onChange={event => void saveMetadata(unit.id, { roomId: event.target.value ? Number(event.target.value) : null })}><option value="">{t("Unassigned")}</option>{rooms.map(room => <option key={room.id} value={room.id}>{room.name}</option>)}</select></div></article>)}
    {matching.length > visible.length && <button type="button" className="outline-button device-more" onClick={() => setShown(current => current + PAGE_SIZE)}>{t("SHOW {count} MORE OF {total}", { count: Math.min(PAGE_SIZE, matching.length - visible.length), total: matching.length - visible.length })}</button>}
    {units.length > 0 && matching.length === 0 && <p className="muted-copy">{t("No unit matches.")}</p>}
    {!units.length && <p className="muted-copy">{t("Connect a network to manage discovered lamps.")}</p>}
  </HudFrame>;
}
