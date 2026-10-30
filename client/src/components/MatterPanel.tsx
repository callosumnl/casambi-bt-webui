import { CircleHelp, DoorOpen, RotateCcw, Speaker, Trash2 } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import { HudFrame } from "@/components/HudFrame";
import { MatterGuide } from "@/components/MatterGuide";
import { qrImageSource } from "@/lib/homekit";
import { t } from "@/lib/i18n";
import { LocalApi } from "@/lib/localApi";
import { describeMatter, describeMatterLights, fabricName, formatId, formatManualCode, isIphoneFabric, parseId, type MatterInfo } from "@/lib/matter";

/** Runs the Pi as a Matter bridge for Google Home, separate from HomeKit, and shows the code to add it. */
export function MatterPanel({ api, onNotice }: { api: LocalApi; onNotice: (message: string) => void }) {
  const [info, setInfo] = useState<MatterInfo | null>(null);
  const [form, setForm] = useState({ enabled: false, name: "", port: "", vendorId: "", productId: "" });
  const [busy, setBusy] = useState(false);
  const [guide, setGuide] = useState(false);
  const show = (next: MatterInfo) => { setInfo(next); setForm({ enabled: next.enabled, name: next.name, port: String(next.port), vendorId: formatId(next.vendorId), productId: formatId(next.productId) }); };
  useEffect(() => { void api.request<MatterInfo>("/admin/matter").then(show).catch(error => onNotice(error instanceof Error ? error.message : t("Unable to load the Matter settings."))); }, []);
  // Pairing happens in the Google Home app; check again while it can.
  useEffect(() => {
    if (!info || info.state !== "running" || (info.commissioned && !info.pairingWindowUntil)) return;
    const timer = window.setInterval(() => { void api.request<MatterInfo>("/admin/matter").then(setInfo).catch(() => undefined); }, 3_000);
    return () => window.clearInterval(timer);
  }, [info?.state, info?.commissioned, info?.pairingWindowUntil, info?.fabrics.length]);

  const run = async (request: () => Promise<MatterInfo>, done: string, failed: string) => {
    setBusy(true);
    try { show(await request()); onNotice(done); } catch (error) { onNotice(error instanceof Error ? error.message : failed); } finally { setBusy(false); }
  };
  const save = (event: FormEvent) => {
    event.preventDefault();
    const vendorId = parseId(form.vendorId);
    const productId = parseId(form.productId);
    if (Number.isNaN(vendorId) || Number.isNaN(productId)) { onNotice(t("Enter the vendor and product id as 0x… (hexadecimal) or as a number.")); return; }
    void run(() => api.request<MatterInfo>("/admin/matter", { method: "PUT", body: JSON.stringify({ enabled: form.enabled, name: form.name, port: Number(form.port), vendorId, productId }) }), t("Matter settings saved."), t("Unable to save the Matter settings."));
  };
  const openWindow = () => void run(() => api.request<MatterInfo>("/admin/matter/pairing-window", { method: "POST" }), t("Another app can now add the bridge with the code, for 15 minutes."), t("Unable to open a pairing window."));
  const remove = (fabric: { index: number; owner: string; vendorId: number }) => {
    const name = fabricName(fabric);
    const question = isIphoneFabric(fabric)
      ? t("Remove the iPhone's connection? If you added the bridge to Google Home with an iPhone, Google Home can lose it too. It costs nothing to keep.")
      : t("Remove {owner}? The lights disappear from that app, with their rooms and routines there.", { owner: name });
    if (!window.confirm(question)) return;
    void run(() => api.request<MatterInfo>(`/admin/matter/fabrics/${fabric.index}`, { method: "DELETE" }), t("{owner} removed.", { owner: name }), t("Unable to remove the connection."));
  };
  const reset = () => {
    if (!window.confirm(t("Reset the Matter bridge? Every app that added it loses it, with its rooms and routines. Remove it in the Google Home app as well, then add it again with the code."))) return;
    void run(() => api.request<MatterInfo>("/admin/matter/reset", { method: "POST" }), t("Matter bridge reset. Add it again in the Google Home app."), t("Unable to reset the Matter bridge."));
  };

  const changed = info && (form.enabled !== info.enabled || form.name !== info.name || Number(form.port) !== info.port || parseId(form.vendorId) !== info.vendorId || parseId(form.productId) !== info.productId);
  return <HudFrame className="form-panel"><h3><Speaker /> {t("GOOGLE HOME (MATTER)")}</h3>
    {!info && <p className="muted-copy">{t("Loading…")}</p>}
    {info && <>
      <p className="muted-copy">{t("Makes this Pi a Matter bridge, so a Google Nest speaker or display can switch these lights locally, by voice too. It is separate from HomeKit. Google Home only adds it when your Google Home Developer Console project has a Matter integration with the same vendor and product id (see the README).")}</p>
      <button type="button" className="outline-button guide-open" onClick={() => setGuide(true)}><CircleHelp /> {t("HOW DO I CONNECT GOOGLE HOME?")}</button>
      <MatterGuide open={guide} onClose={() => setGuide(false)} vendorId={info.vendorId} productId={info.productId} />
      <form onSubmit={save} className="admin-form">
        <label className="checkbox-row"><input type="checkbox" checked={form.enabled} onChange={event => setForm({ ...form, enabled: event.target.checked })} disabled={busy} /> {t("RUN THE MATTER BRIDGE")}</label>
        <div className="form-grid">
          <label>{t("NAME IN GOOGLE HOME")}<input value={form.name} maxLength={32} onChange={event => setForm({ ...form, name: event.target.value })} disabled={busy} required /></label>
          <label>{t("MATTER PORT (UDP)")}<input type="number" min={1024} max={65535} value={form.port} onChange={event => setForm({ ...form, port: event.target.value })} disabled={busy} required /></label>
        </div>
        <details className="admin-advanced"><summary>{t("ADVANCED")}</summary>
          <div className="form-grid">
            <label>{t("VENDOR ID")}<input value={form.vendorId} onChange={event => setForm({ ...form, vendorId: event.target.value })} disabled={busy} /></label>
            <label>{t("PRODUCT ID")}<input value={form.productId} onChange={event => setForm({ ...form, productId: event.target.value })} disabled={busy} /></label>
          </div>
          <p className="muted-copy">{t("They must match your Developer Console integration. Changing them on a paired bridge can make Google Home refuse it.")}</p>
        </details>
        <button className="neon-button" disabled={busy || !changed}>{t("SAVE")}</button>
      </form>
      <p role="status">{describeMatter(info)}</p>
      {describeMatterLights(info) && <p className="muted-copy">{describeMatterLights(info)}</p>}
      {info.manualPairingCode && <div className="homekit-pairing">
        {info.qrSvg && <img src={qrImageSource(info.qrSvg)} alt={t("Matter setup code {code} as a QR code", { code: formatManualCode(info.manualPairingCode) })} />}
        <div><p className="muted-copy">{t("SETUP CODE")}</p><code className="homekit-code">{formatManualCode(info.manualPairingCode)}</code></div>
      </div>}
      {info.fabrics.length > 0 && <div className="matter-fabrics"><p className="muted-copy">{t("CONNECTED APPS")}</p>
        {info.fabrics.some(isIphoneFabric) && <p className="muted-copy">{t("The Google Home app on an iPhone adds the bridge through the iPhone's own Matter connection. Keep it: removing it, here or under Settings → General → Matter Accessories on the iPhone, can remove the bridge from Google Home too.")}</p>}
        {info.fabrics.map(fabric => <div key={fabric.index} className="matter-fabric"><span>{fabricName(fabric)}</span><button className="outline-button danger" disabled={busy} onClick={() => remove(fabric)}><Trash2 /> {t("REMOVE")}</button></div>)}
      </div>}
      <div className="button-pair">
        {info.commissioned && <button className="outline-button" disabled={busy || info.state !== "running"} onClick={openWindow}><DoorOpen /> {t("LET ANOTHER APP ADD IT")}</button>}
        <button className="outline-button danger" disabled={busy || info.state !== "running"} onClick={reset}><RotateCcw /> {t("RESET")}</button>
      </div>
    </>}
  </HudFrame>;
}
