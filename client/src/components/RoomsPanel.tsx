import { Plus, Trash2 } from "lucide-react";
import { FormEvent, KeyboardEvent, useEffect, useState } from "react";
import { LocalApi, Room } from "@/lib/localApi";

type Props = { api: LocalApi; rooms: Room[]; onChanged: () => Promise<void> | void; onNotice: (message: string) => void };

/** Create, rename, and delete local rooms and set the brightness users can apply with one tap. */
export function RoomsPanel({ api, rooms, onChanged, onNotice }: Props) {
  const [name, setName] = useState("");
  const [percent, setPercent] = useState("100");
  const add = async (event: FormEvent) => {
    event.preventDefault();
    try { await api.request("/admin/rooms", { method: "POST", body: JSON.stringify({ name, defaultBrightnessPercent: Number(percent) }) }); setName(""); setPercent("100"); onNotice("Room created."); await onChanged(); }
    catch (error) { onNotice(error instanceof Error ? error.message : "Unable to add room."); }
  };
  return <section className="rooms-panel"><h3><Plus /> LOCAL ROOMS</h3>
    <form onSubmit={event => void add(event)} className="inline-form"><input value={name} onChange={event => setName(event.target.value)} placeholder="e.g. Studio" aria-label="New room name" required /><input aria-label="New room default brightness percent" type="number" min="0" max="100" value={percent} onChange={event => setPercent(event.target.value)} /><button className="neon-button">ADD</button></form>
    <p className="muted-copy">Rename a room or change its default brightness, then leave the field. A room used by a timer, switch rule, or scene cannot be deleted.</p>
    {rooms.length === 0 ? <p className="muted-copy">No rooms configured.</p> : <div className="room-list">{rooms.map(room => <RoomRow key={room.id} room={room} api={api} onChanged={onChanged} onNotice={onNotice} />)}</div>}
  </section>;
}

function RoomRow({ room, api, onChanged, onNotice }: { room: Room; api: LocalApi; onChanged: Props["onChanged"]; onNotice: Props["onNotice"] }) {
  const [name, setName] = useState(room.name);
  const [percent, setPercent] = useState(String(room.defaultBrightnessPercent));
  useEffect(() => { setName(room.name); setPercent(String(room.defaultBrightnessPercent)); }, [room.name, room.defaultBrightnessPercent]);
  // On a rejected value, show the saved value again instead of one the server refused.
  const save = async (path: string, method: string, body: object, done: string, revert: () => void) => {
    try { await api.request(path, { method, body: JSON.stringify(body) }); onNotice(done); await onChanged(); }
    catch (error) { revert(); onNotice(error instanceof Error ? error.message : "Unable to save the room."); }
  };
  const saveName = () => { if (name.trim() && name.trim() !== room.name) void save(`/admin/rooms/${room.id}`, "PATCH", { name: name.trim() }, "Room renamed.", () => setName(room.name)); else setName(room.name); };
  const savePercent = () => { if (Number(percent) !== room.defaultBrightnessPercent) void save(`/admin/rooms/${room.id}/default-brightness`, "PUT", { defaultBrightnessPercent: Number(percent) }, "Room default brightness saved.", () => setPercent(String(room.defaultBrightnessPercent))); };
  const remove = async () => {
    if (!window.confirm(`Delete the room "${room.name}"? Its lamps become unassigned.`)) return;
    try { await api.request(`/admin/rooms/${room.id}`, { method: "DELETE" }); onNotice(`${room.name} deleted.`); await onChanged(); }
    catch (error) { onNotice(error instanceof Error ? error.message : "Unable to delete the room."); }
  };
  const blurOnEnter = (event: KeyboardEvent<HTMLInputElement>) => { if (event.key === "Enter") event.currentTarget.blur(); };
  return <article className="room-row">
    <input aria-label={`Name of room ${room.name}`} value={name} maxLength={96} onChange={event => setName(event.target.value)} onBlur={saveName} onKeyDown={blurOnEnter} />
    <label><input aria-label={`${room.name} default brightness percent`} type="number" min="0" max="100" value={percent} onChange={event => setPercent(event.target.value)} onBlur={savePercent} onKeyDown={blurOnEnter} /><b>% DEFAULT</b></label>
    <button type="button" className="icon-button danger" aria-label={`Delete room ${room.name}`} onClick={() => void remove()}><Trash2 /></button>
  </article>;
}
