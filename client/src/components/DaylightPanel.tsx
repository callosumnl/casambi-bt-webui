import { Sun } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import { HudFrame } from "@/components/HudFrame";
import { describeDaylightRoom, type DaylightInfo } from "@/lib/daylight";
import { t } from "@/lib/i18n";
import { LocalApi } from "@/lib/localApi";

/**
 * The daylight rhythm: lamps that are on in the chosen rooms follow the day, warm at night and cool at midday. Choosing
 * a colour by hand pauses a room until its lights go off.
 */
export function DaylightPanel({ api, onNotice }: { api: LocalApi; onNotice: (message: string) => void }) {
  const [info, setInfo] = useState<DaylightInfo | null>(null);
  const [form, setForm] = useState({ roomIds: [] as number[], warmKelvin: "2700", coolKelvin: "5000" });
  const [busy, setBusy] = useState(false);
  const show = (next: DaylightInfo) => { setInfo(next); setForm({ roomIds: next.roomIds, warmKelvin: String(next.warmKelvin), coolKelvin: String(next.coolKelvin) }); };
  const fail = (error: unknown, fallback: string) => onNotice(error instanceof Error ? error.message : fallback);
  useEffect(() => { void api.request<DaylightInfo>("/admin/daylight").then(show).catch(error => fail(error, t("Unable to load the daylight rhythm."))); }, []);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      show(await api.request<DaylightInfo>("/admin/daylight", { method: "PUT", body: JSON.stringify({ roomIds: form.roomIds, warmKelvin: Number(form.warmKelvin), coolKelvin: Number(form.coolKelvin) }) }));
      onNotice(t("Daylight rhythm saved."));
    } catch (error) { fail(error, t("Unable to save the daylight rhythm.")); } finally { setBusy(false); }
  };
  const resume = async (roomId: number) => {
    try { show(await api.request<DaylightInfo>(`/admin/daylight/rooms/${roomId}/resume`, { method: "POST" })); } catch (error) { fail(error, t("Unable to resume the daylight rhythm.")); }
  };
  const toggle = (roomId: number, on: boolean) => setForm({ ...form, roomIds: on ? [...form.roomIds, roomId] : form.roomIds.filter(id => id !== roomId) });

  return <HudFrame className="form-panel"><h3><Sun /> {t("DAYLIGHT RHYTHM")}</h3>
    {!info && <p className="muted-copy">{t("Loading…")}</p>}
    {info && <form onSubmit={event => void save(event)} className="admin-form">
      <p className="muted-copy">{t("Lamps with an adjustable white that are on follow the day in the rooms you choose: warm in the evening and at night, cool and fresh around midday. Choosing a colour by hand pauses the room until its lights go off.")}</p>
      {!info.hasLocation && <p className="muted-copy">{t("Set the sunrise and sunset location first; the rhythm follows the sun there.")}</p>}
      {info.kelvin !== null && <p role="status">{t("Now: {kelvin} K", { kelvin: info.kelvin })}</p>}
      <div className="form-grid">
        <label>{t("AT NIGHT (WARM)")}<input type="number" min={1800} max={6500} step={100} value={form.warmKelvin} onChange={event => setForm({ ...form, warmKelvin: event.target.value })} disabled={busy} required /><small>K</small></label>
        <label>{t("AT MIDDAY (COOL)")}<input type="number" min={1800} max={6500} step={100} value={form.coolKelvin} onChange={event => setForm({ ...form, coolKelvin: event.target.value })} disabled={busy} required /><small>K</small></label>
      </div>
      <fieldset className="admin-fieldset"><legend>{t("ROOMS")}</legend>
        {info.rooms.length === 0 && <p className="muted-copy">{t("No rooms yet. Create them under Rooms & lamps.")}</p>}
        {info.rooms.map(room => <div key={room.id} className="daylight-room">
          <label className="checkbox-row"><input type="checkbox" checked={form.roomIds.includes(room.id)} onChange={event => toggle(room.id, event.target.checked)} disabled={busy} /> {room.name}</label>
          {room.enabled && <small className="muted-copy">{describeDaylightRoom(room.state)}</small>}
          {room.state === "paused" && <button type="button" className="outline-button" onClick={() => void resume(room.id)}>{t("RESUME")}</button>}
        </div>)}
      </fieldset>
      <button className="neon-button" disabled={busy}>{busy ? t("SAVING…") : t("SAVE")}</button>
    </form>}
  </HudFrame>;
}
