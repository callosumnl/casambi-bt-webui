import { Sunrise } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import { HudFrame } from "@/components/HudFrame";
import { t } from "@/lib/i18n";
import { LocalApi } from "@/lib/localApi";

/** The site's location for sunrise and sunset timers; saved on its own, so the Casambi settings stay untouched. */
export function SolarLocationPanel({ api, onNotice }: { api: LocalApi; onNotice: (message: string) => void }) {
  const [location, setLocation] = useState({ solarLatitude: "", solarLongitude: "" });
  useEffect(() => {
    void api.request<{ solarLatitude: number | null; solarLongitude: number | null }>("/admin/config")
      .then(config => setLocation({ solarLatitude: config.solarLatitude == null ? "" : String(config.solarLatitude), solarLongitude: config.solarLongitude == null ? "" : String(config.solarLongitude) }))
      .catch(error => onNotice(error instanceof Error ? error.message : t("Unable to load admin configuration.")));
  }, []);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await api.request("/admin/config", { method: "PUT", body: JSON.stringify({ solarLatitude: location.solarLatitude === "" ? null : Number(location.solarLatitude), solarLongitude: location.solarLongitude === "" ? null : Number(location.solarLongitude) }) });
      onNotice(t("Location for sunrise and sunset saved."));
    } catch (error) { onNotice(error instanceof Error ? error.message : t("Unable to save configuration.")); }
  };
  return <HudFrame className="form-panel"><h3><Sunrise /> {t("SUNRISE AND SUNSET")}</h3>
    <form onSubmit={event => void save(event)} className="admin-form">
      <div className="form-grid">
        <label>{t("SOLAR LATITUDE")}<input type="number" min="-90" max="90" step="0.0001" value={location.solarLatitude} onChange={event => setLocation({ ...location, solarLatitude: event.target.value })} placeholder={t("e.g. {value}", { value: "52.3676" })} /></label>
        <label>{t("SOLAR LONGITUDE")}<input type="number" min="-180" max="180" step="0.0001" value={location.solarLongitude} onChange={event => setLocation({ ...location, solarLongitude: event.target.value })} placeholder={t("e.g. {value}", { value: "4.9041" })} /></label>
      </div>
      <p className="muted-copy">{t("Used locally to calculate sunrise and sunset timers. No location service is contacted.")}</p>
      <button className="neon-button">{t("SAVE")}</button>
    </form>
  </HudFrame>;
}
