import { Home, RotateCcw } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import { HudFrame } from "@/components/HudFrame";
import { describeHomeKit, qrImageSource, type HomeKitInfo } from "@/lib/homekit";
import { t } from "@/lib/i18n";
import { LocalApi } from "@/lib/localApi";

/** Publishes the Pi as a HomeKit bridge and shows the setup code to pair it with the Apple Home app. */
export function HomeKitPanel({ api, onNotice }: { api: LocalApi; onNotice: (message: string) => void }) {
  const [info, setInfo] = useState<HomeKitInfo | null>(null);
  const [form, setForm] = useState({ enabled: false, name: "", port: "" });
  const [busy, setBusy] = useState(false);
  const show = (next: HomeKitInfo) => { setInfo(next); setForm({ enabled: next.enabled, name: next.name, port: String(next.port) }); };
  const load = async () => {
    try { show(await api.request<HomeKitInfo>("/admin/homekit")); } catch (error) { onNotice(error instanceof Error ? error.message : t("Unable to load the HomeKit settings.")); }
  };
  useEffect(() => { void load(); }, []);
  // Announcing on the network and pairing happen after publishing; check again until both are done.
  useEffect(() => {
    if (!info || info.state === "disabled" || info.state === "failed" || (info.advertised && info.pairings > 0)) return;
    const timer = window.setInterval(() => { void api.request<HomeKitInfo>("/admin/homekit").then(setInfo).catch(() => undefined); }, 3_000);
    return () => window.clearInterval(timer);
  }, [info?.state, info?.advertised, info?.pairings]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      show(await api.request<HomeKitInfo>("/admin/homekit", { method: "PUT", body: JSON.stringify({ enabled: form.enabled, name: form.name, port: Number(form.port) }) }));
      onNotice(t("HomeKit settings saved."));
    } catch (error) { onNotice(error instanceof Error ? error.message : t("Unable to save the HomeKit settings.")); } finally { setBusy(false); }
  };
  const reset = async () => {
    if (!window.confirm(t("Reset HomeKit pairing? Every Apple Home that added this bridge loses it, with its rooms and automations for these lights. Remove the old bridge in the Home app, then add it again with the new code."))) return;
    setBusy(true);
    try { show(await api.request<HomeKitInfo>("/admin/homekit/reset", { method: "POST" })); onNotice(t("HomeKit pairing reset. Add the bridge again in the Home app.")); }
    catch (error) { onNotice(error instanceof Error ? error.message : t("Unable to reset HomeKit pairing.")); } finally { setBusy(false); }
  };

  const changed = info && (form.enabled !== info.enabled || form.name !== info.name || Number(form.port) !== info.port);
  return <HudFrame className="form-panel"><h3><Home /> {t("HOMEKIT")}</h3>
    {!info && <p className="muted-copy">{t("Loading…")}</p>}
    {info && <>
      <p className="muted-copy">{t("Makes this Pi a bridge in the Apple Home app, like Homebridge. Everyone in that Home can then switch these lights. The Home app calls it an uncertified accessory; that is expected.")}</p>
      <form onSubmit={event => void save(event)} className="admin-form">
        <label className="checkbox-row"><input type="checkbox" checked={form.enabled} onChange={event => setForm({ ...form, enabled: event.target.checked })} disabled={busy} /> {t("PUBLISH AS HOMEKIT BRIDGE")}</label>
        <div className="form-grid">
          <label>{t("NAME IN APPLE HOME")}<input value={form.name} maxLength={64} onChange={event => setForm({ ...form, name: event.target.value })} disabled={busy} required /></label>
          <label>{t("HOMEKIT PORT")}<input type="number" min={1024} max={65535} value={form.port} onChange={event => setForm({ ...form, port: event.target.value })} disabled={busy} required /></label>
        </div>
        <button className="neon-button" disabled={busy || !changed}>{t("SAVE")}</button>
      </form>
      <p role="status">{describeHomeKit(info)}</p>
      {info.state === "published" && <div className="homekit-pairing">
        {info.qrSvg && <img src={qrImageSource(info.qrSvg)} alt={t("HomeKit setup code {code} as a QR code", { code: info.pincode })} />}
        <div><p className="muted-copy">{t("SETUP CODE")}</p><code className="homekit-code">{info.pincode}</code></div>
      </div>}
      <div className="button-pair"><button className="outline-button danger" disabled={busy} onClick={() => void reset()}><RotateCcw /> {t("RESET PAIRING")}</button></div>
    </>}
  </HudFrame>;
}
