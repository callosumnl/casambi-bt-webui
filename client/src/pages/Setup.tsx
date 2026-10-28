import { AlertTriangle, ArrowRight, CheckCircle2, LayoutGrid, MapPin, Radio, Rocket, Stethoscope } from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { ConnectionStatusBar } from "@/components/ConnectionStatusBar";
import { HudFrame } from "@/components/HudFrame";
import { useNetwork } from "@/hooks/useNetwork";
import { signalQuality, type SystemCheck } from "@/lib/diagnostics";
import { t } from "@/lib/i18n";
import { LocalApi } from "@/lib/localApi";
import "./Setup.css";

const STEPS = [t("Check"), t("Network"), t("Rooms"), t("Location"), t("Done")];
type Endpoint = { address: string; rssi: number | null };

/** First-run guide: check the Pi, connect the Casambi network, make rooms, and set the location for solar timers. */
export default function Setup() {
  const api = useMemo(() => new LocalApi(), []);
  const { network, connection, refresh } = useNetwork();
  const [step, setStep] = useState(0);
  const next = () => setStep(current => Math.min(STEPS.length - 1, current + 1));
  return <div className="admin-page setup-page">
    <div className="section-heading"><div><p className="eyebrow"><Rocket /> {t("FIRST-RUN SETUP")}</p><h2>{t("SET UP")} <em>//</em> {t("YOUR LIGHTS")}</h2></div></div>
    <ol className="setup-steps" aria-label={t("Setup steps")}>{STEPS.map((label, index) => <li key={label} className={index === step ? "current" : index < step ? "done" : ""} aria-current={index === step ? "step" : undefined}><span>{index + 1}</span>{label}</li>)}</ol>
    {step === 0 && <CheckStep api={api} onNext={next} />}
    {step === 1 && <NetworkStep api={api} connected={Boolean(network?.connected)} connection={connection} onConnected={() => { void refresh(); next(); }} onSkip={next} />}
    {step === 2 && <RoomsStep api={api} groups={network?.groups ?? []} rooms={network?.rooms.length ?? 0} onDone={() => { void refresh(); next(); }} />}
    {step === 3 && <LocationStep api={api} onDone={next} />}
    {step === 4 && <HudFrame className="form-panel"><h3><CheckCircle2 /> {t("ALL SET")}</h3><p className="muted-copy">{t("Your lights are ready. Control them from the dashboard, add timers, and fine-tune rooms, names, and accounts under Admin. You can run this setup again from the Admin page at any time.")}</p><div className="button-pair"><Link href="/" className="neon-button">{t("GO TO CONTROL")} <ArrowRight /></Link><Link href="/schedules" className="outline-button">{t("ADD A TIMER")}</Link></div></HudFrame>}
  </div>;
}

/** Shows only what needs attention from the system check, so problems are fixed before connecting. */
function CheckStep({ api, onNext }: { api: LocalApi; onNext: () => void }) {
  const [report, setReport] = useState<SystemCheck | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { api.request<SystemCheck>("/admin/diagnostics").then(setReport, reason => setError(reason instanceof Error ? reason.message : t("The system check failed."))); }, [api]);
  // The Casambi network is set up in the next step; its "not set up yet" check is expected here.
  const problems = report?.checks.filter(check => (check.status === "fail" || check.status === "warn") && check.id !== "casambi-config") ?? [];
  return <HudFrame className="form-panel"><h3><Stethoscope /> {t("CHECK THE RASPBERRY PI")}</h3>
    {!report && !error && <p className="muted-copy">{t("Checking Bluetooth, Wi-Fi, and the clock…")}</p>}
    {error && <p className="live-warning"><AlertTriangle /> {error}</p>}
    {report && (problems.length === 0 ? <p className="setup-ok"><CheckCircle2 /> {t("Bluetooth, the clock, and the Pi itself look fine.")}</p>
      : <><p className="muted-copy">{t("These points can make the Casambi connection slow or unreliable. You can continue, but fixing them first saves trouble later.")}</p><ul className="check-list">{problems.map(check => <li key={check.id} className={`check ${check.status}`}><AlertTriangle aria-hidden="true" /><div><strong>{check.title}</strong><p>{check.detail}</p>{check.advice && <p className="check-advice">{check.advice}</p>}</div></li>)}</ul></>)}
    <p className="muted-copy">{t("Moving from another Pi? Restore its backup under Admin → BACKUP AND RESTORE instead of setting everything up again.")}</p>
    <div className="button-pair"><button className="neon-button" disabled={!report && !error} onClick={onNext}>{problems.length ? t("CONTINUE ANYWAY") : t("CONTINUE")} <ArrowRight /></button><Link href="/diagnostics" className="outline-button">{t("OPEN FULL SYSTEM CHECK")}</Link></div>
  </HudFrame>;
}

/** Finds Casambi networks in range, then saves the chosen one with its password and connects. */
function NetworkStep({ api, connected, connection, onConnected, onSkip }: { api: LocalApi; connected: boolean; connection: ReturnType<typeof useNetwork>["connection"]; onConnected: () => void; onSkip: () => void }) {
  const [endpoints, setEndpoints] = useState<Endpoint[] | null>(null);
  const [address, setAddress] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<"scan" | "connect" | null>(null);
  const [error, setError] = useState("");
  const scan = async () => {
    setBusy("scan"); setError("");
    try { const found = await api.request<Endpoint[]>("/admin/discovery"); setEndpoints(found); if (found.length) setAddress(current => current || found[0].address); } catch (reason) { setError(reason instanceof Error ? reason.message : t("The Bluetooth scan failed.")); } finally { setBusy(null); }
  };
  useEffect(() => { void scan(); }, []);
  const connect = async (event: FormEvent) => {
    event.preventDefault(); setBusy("connect"); setError("");
    try {
      await api.request("/admin/config", { method: "PUT", body: JSON.stringify({ networkAddress: address, networkPassword: password }) });
      await api.request("/admin/connect", { method: "POST" });
      onConnected();
    } catch (reason) { setError(reason instanceof Error ? reason.message : t("Connecting failed.")); } finally { setBusy(null); }
  };
  return <HudFrame className="form-panel"><h3><Radio /> {t("CONNECT YOUR CASAMBI NETWORK")}</h3>
    {connected && <p className="setup-ok"><CheckCircle2 /> {t("A Casambi network is already connected. You can continue, or connect another one below.")}</p>}
    <p className="muted-copy">{t("The Pi scans for 5 seconds. Make sure the lights are powered and the Pi is near one of them.")}</p>
    {busy === "scan" && <p className="muted-copy">{t("Scanning…")}</p>}
    {endpoints && endpoints.length === 0 && <p className="live-warning"><AlertTriangle /> {t("No Casambi network found. Switch the lights on, move the Pi closer, and scan again. The system check shows whether Bluetooth works.")}</p>}
    <form onSubmit={event => void connect(event)} className="admin-form">
      {endpoints && endpoints.length > 0 && <fieldset className="setup-choices"><legend>{t("NETWORK")}</legend>{endpoints.map(endpoint => { const quality = signalQuality(endpoint.rssi); return <label key={endpoint.address} className="checkbox-row"><input type="radio" name="network" value={endpoint.address} checked={address === endpoint.address} onChange={() => setAddress(endpoint.address)} /> {endpoint.address} <small className={quality.status}>{endpoint.rssi === null ? "" : `${endpoint.rssi} dBm, ${quality.label}`}</small></label>; })}</fieldset>}
      <label>{t("NETWORK PASSWORD")}<input type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="off" required /></label>
      <p className="muted-copy">{t("The password of the Casambi network, as set in the Casambi app (network settings). It is stored encrypted on the Pi.")}</p>
      <ConnectionStatusBar status={busy === "connect" ? connection : null} />
      {error && <p className="form-error"><AlertTriangle /> {error}</p>}
      <div className="button-pair"><button className="neon-button" disabled={busy !== null || !address || !password}>{busy === "connect" ? t("CONNECTING… (UP TO A MINUTE)") : t("SAVE AND CONNECT")}</button><button type="button" className="outline-button" disabled={busy !== null} onClick={() => void scan()}>{t("SCAN AGAIN")}</button>{connected && <button type="button" className="outline-button" onClick={onSkip}>{t("CONTINUE")} <ArrowRight /></button>}</div>
    </form>
  </HudFrame>;
}

/** Offers a room for each Casambi group; rooms that match groups make room commands a single Bluetooth command. */
function RoomsStep({ api, groups, rooms, onDone }: { api: LocalApi; groups: Array<{ id: number; name: string; unitIds: number[] }>; rooms: number; onDone: () => void }) {
  const [result, setResult] = useState<{ created: number; assigned: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const create = async () => {
    setBusy(true); setError("");
    try { setResult(await api.request<{ created: number; assigned: number }>("/admin/rooms/from-groups", { method: "POST" })); } catch (reason) { setError(reason instanceof Error ? reason.message : t("Creating rooms failed.")); } finally { setBusy(false); }
  };
  return <HudFrame className="form-panel"><h3><LayoutGrid /> {t("ROOMS")}</h3>
    <p className="muted-copy">{t("Rooms group lamps on the dashboard and in timers. The quickest start is a room for each group you made in the Casambi app: switching a room is then one Bluetooth command instead of one per lamp.")}</p>
    {groups.length > 0 ? <ul className="setup-groups">{groups.map(group => <li key={group.id}><strong>{group.name || t("Group {id}", { id: group.id })}</strong> <small>{group.unitIds.length === 1 ? t("{n} unit", { n: group.unitIds.length }) : t("{n} units", { n: group.unitIds.length })}</small></li>)}</ul>
      : <p className="muted-copy">{t("This network has no groups. Create rooms and place lamps under Admin, or make groups in the Casambi app first.")}</p>}
    {rooms > 0 && !result && <p className="muted-copy">{rooms === 1 ? t("You already have {n} room; existing rooms and lamp placements are kept.", { n: rooms }) : t("You already have {n} rooms; existing rooms and lamp placements are kept.", { n: rooms })}</p>}
    {result && <p className="setup-ok"><CheckCircle2 /> {result.created === 1 ? t("{n} room created", { n: result.created }) : t("{n} rooms created", { n: result.created })}, {result.assigned === 1 ? t("{n} unit placed.", { n: result.assigned }) : t("{n} units placed.", { n: result.assigned })}</p>}
    {error && <p className="form-error"><AlertTriangle /> {error}</p>}
    <div className="button-pair">{groups.length > 0 && !result && <button className="neon-button" disabled={busy} onClick={() => void create()}>{busy ? t("CREATING…") : t("CREATE A ROOM FOR EACH GROUP")}</button>}<button className={result ? "neon-button" : "outline-button"} onClick={onDone}>{result ? t("CONTINUE") : t("SKIP FOR NOW")} <ArrowRight /></button></div>
  </HudFrame>;
}

/** Sunrise and sunset timers need the Pi's location; it is entered by hand because browsers only share it over HTTPS. */
function LocationStep({ api, onDone }: { api: LocalApi; onDone: () => void }) {
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");
  const [error, setError] = useState("");
  const save = async (event: FormEvent) => {
    event.preventDefault(); setError("");
    try { await api.request("/admin/config", { method: "PUT", body: JSON.stringify({ solarLatitude: Number(latitude), solarLongitude: Number(longitude) }) }); onDone(); } catch (reason) { setError(reason instanceof Error ? reason.message : t("Saving the location failed.")); }
  };
  return <HudFrame className="form-panel"><h3><MapPin /> {t("LOCATION FOR SUNRISE AND SUNSET")}</h3>
    <p className="muted-copy">{t("Only needed for timers that follow sunrise or sunset. It stays on the Pi; no location service is contacted. Find your coordinates by right-clicking your home in a map app; Amsterdam is about 52.37, 4.90.")}</p>
    <form onSubmit={event => void save(event)} className="admin-form">
      <div className="form-grid"><label>{t("LATITUDE")}<input type="number" min="-90" max="90" step="0.0001" value={latitude} onChange={event => setLatitude(event.target.value)} placeholder="52.3676" required /></label><label>{t("LONGITUDE")}<input type="number" min="-180" max="180" step="0.0001" value={longitude} onChange={event => setLongitude(event.target.value)} placeholder="4.9041" required /></label></div>
      {error && <p className="form-error"><AlertTriangle /> {error}</p>}
      <div className="button-pair"><button className="neon-button">{t("SAVE LOCATION")}</button><button type="button" className="outline-button" onClick={onDone}>{t("SKIP")} <ArrowRight /></button></div>
    </form>
  </HudFrame>;
}
