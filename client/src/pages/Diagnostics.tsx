import { AlertTriangle, CheckCircle2, Download, Info, Radio, RefreshCw, Stethoscope, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { HudFrame } from "@/components/HudFrame";
import { t } from "@/lib/i18n";
import { LocalApi } from "@/lib/localApi";
import { signalQuality, type SystemCheck } from "@/lib/diagnostics";
import "./Diagnostics.css";

const ICONS = { ok: CheckCircle2, warn: AlertTriangle, fail: XCircle, info: Info };

/** The system check: Bluetooth, Wi-Fi interference, the Casambi connection, and the Pi itself, each with advice. */
export default function Diagnostics() {
  const api = useMemo(() => new LocalApi(), []);
  const [report, setReport] = useState<SystemCheck | null>(null);
  const [busy, setBusy] = useState<"check" | "signal" | "download" | null>("check");
  const [signal, setSignal] = useState<Array<{ address: string; rssi: number | null }> | null>(null);
  const [error, setError] = useState("");

  const run = async () => {
    setBusy("check"); setError("");
    try { setReport(await api.request<SystemCheck>("/admin/diagnostics")); } catch (reason) { setError(reason instanceof Error ? reason.message : t("The system check failed.")); } finally { setBusy(null); }
  };
  useEffect(() => { void run(); }, []);
  const measure = async () => {
    setBusy("signal"); setError("");
    try { setSignal(await api.request<Array<{ address: string; rssi: number | null }>>("/admin/discovery")); } catch (reason) { setError(reason instanceof Error ? reason.message : t("The Bluetooth scan failed.")); } finally { setBusy(null); }
  };
  const download = async () => {
    setBusy("download"); setError("");
    try {
      const bundle = await api.request<{ generatedAt: string }>("/admin/diagnostics/bundle");
      const link = document.createElement("a");
      link.href = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" }));
      link.download = `casambi-diagnostics-${bundle.generatedAt.slice(0, 19).replace(/:/g, "-")}.json`;
      link.click();
      URL.revokeObjectURL(link.href);
    } catch (reason) { setError(reason instanceof Error ? reason.message : t("The diagnostics file could not be created.")); } finally { setBusy(null); }
  };

  const problems = report?.checks.filter(check => check.status === "fail" || check.status === "warn").length ?? 0;
  return <div className="admin-page diagnostics-page">
    <div className="section-heading"><div><p className="eyebrow"><Stethoscope /> {t("SYSTEM CHECK")}</p><h2>{t("DIAGNOSTICS")}</h2></div>
      <div className="button-pair"><button className="outline-button" disabled={busy !== null} onClick={() => void run()}><RefreshCw /> {busy === "check" ? t("CHECKING…") : t("CHECK AGAIN")}</button><button className="outline-button" disabled={busy !== null} onClick={() => void download()}><Download /> {busy === "download" ? t("PREPARING…") : t("DOWNLOAD DIAGNOSTICS FILE")}</button></div>
    </div>
    {error && <p className="live-warning"><AlertTriangle /> {error}</p>}
    {report && <p className="muted-copy">{problems === 0 ? t("Everything checked looks fine.") : problems === 1 ? t("{n} point needs attention.", { n: problems }) : t("{n} points need attention.", { n: problems })} {t("Checked {time}.", { time: new Date(report.generatedAt).toLocaleString() })} {t("The diagnostics file contains these checks, versions, and recent audit entries, but no passwords or keys.")}</p>}
    <HudFrame className="form-panel"><ul className="check-list">{report?.checks.map(check => { const Icon = ICONS[check.status]; return <li key={check.id} className={`check ${check.status}`}><Icon aria-hidden="true" /><div><strong>{check.title}</strong><p>{check.detail}</p>{check.advice && <p className="check-advice">{check.advice}</p>}</div></li>; })}</ul>
      {!report && busy === "check" && <p className="muted-copy">{t("Running the system check…")}</p>}
    </HudFrame>
    <HudFrame className="form-panel"><h3><Radio /> {t("BLUETOOTH SIGNAL")}</h3>
      <p className="muted-copy">{t("Scans for 5 seconds and shows how strongly the Pi receives each Casambi network. Light commands wait while the scan runs.")}</p>
      <button className="outline-button" disabled={busy !== null} onClick={() => void measure()}><Radio /> {busy === "signal" ? t("SCANNING…") : t("MEASURE SIGNAL")}</button>
      {signal && (signal.length === 0 ? <p className="muted-copy">{t("No Casambi network in range.")}</p> : <ul className="check-list">{signal.map(endpoint => { const quality = signalQuality(endpoint.rssi); return <li key={endpoint.address} className={`check ${quality.status}`}>{quality.status === "ok" ? <CheckCircle2 aria-hidden="true" /> : <AlertTriangle aria-hidden="true" />}<div><strong>{endpoint.address}</strong><p>{endpoint.rssi === null ? t("Signal strength not available.") : `${endpoint.rssi} dBm: ${quality.label}.`}</p></div></li>; })}</ul>)}
    </HudFrame>
    {report && <HudFrame className="form-panel"><h3>{t("VERSIONS")}</h3><dl className="version-list">{Object.entries(report.versions).map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value ?? t("unknown")}</dd></div>)}</dl></HudFrame>}
  </div>;
}
