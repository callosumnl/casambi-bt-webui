import { ExternalLink, Server } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import { HudFrame } from "@/components/HudFrame";
import { LocalApi } from "@/lib/localApi";
import { addressOnPort, describeSettingsStatus, type ServerSettingsInfo } from "@/lib/serverSettings";

/**
 * Changes the port and the reverse-proxy setting; the Pi restarts the service and restores the previous settings if
 * the app does not come back. After a port change this page's origin stops answering (the page cannot probe the new
 * port: the CSP allows only its own origin), so it shows a link to the new address and keeps polling the old one:
 * if the old port answers again, the change was rolled back.
 */
export function ServerSettingsPanel({ api, onNotice }: { api: LocalApi; onNotice: (message: string) => void }) {
  const [info, setInfo] = useState<ServerSettingsInfo | null>(null);
  const [port, setPort] = useState("");
  const [trustProxy, setTrustProxy] = useState(false);
  const [movedTo, setMovedTo] = useState<number | null>(null);
  const [waiting, setWaiting] = useState(false);
  const load = async () => {
    try {
      const next = await api.request<ServerSettingsInfo>("/admin/server-settings");
      setInfo(next);
      if (!waiting || !next.pending) { setPort(String(next.port)); setTrustProxy(next.trustProxy); }
      if (waiting && !next.pending && next.status.state !== "applying") { setWaiting(false); setMovedTo(null); }
    } catch { /* Restarting, or moved to the new port. */ }
  };
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setInterval(() => void load(), 3_000);
    return () => window.clearInterval(timer);
  }, [waiting]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!info) return;
    const nextPort = Number(port);
    const moving = nextPort !== info.port;
    const warning = moving
      ? `Move the app to port ${nextPort}? The service restarts; afterwards open ${addressOnPort(window.location, nextPort)} and sign in again there. Bookmarks, Home Assistant, and a reverse proxy must use the new port too. If the app does not start on the new port, the previous settings come back within about two minutes.`
      : "Save and restart the service? Control is unavailable for a few seconds.";
    if (!window.confirm(warning)) return;
    try {
      await api.request("/admin/server-settings", { method: "PUT", body: JSON.stringify({ port: nextPort, trustProxy }) });
      setMovedTo(moving ? nextPort : null);
      setWaiting(true);
    } catch (error) { onNotice(error instanceof Error ? error.message : "Saving the server settings failed."); }
  };

  const statusLine = info ? (waiting ? "Applying the new settings… the service restarts." : describeSettingsStatus(info)) : null;
  return <HudFrame className="form-panel"><h3><Server /> SERVER</h3>
    {!info && <p className="muted-copy">Loading…</p>}
    {info && <>
      <p className="muted-copy">Other settings live in {info.readOnly.envFile} on the Pi and can only be changed there.</p>
      <form onSubmit={event => void save(event)} className="admin-form">
        <label>PORT<input type="number" min={1024} max={65535} value={port} onChange={event => setPort(event.target.value)} disabled={!info.supported || waiting} required /></label>
        <label className="checkbox-row"><input type="checkbox" checked={trustProxy} onChange={event => setTrustProxy(event.target.checked)} disabled={!info.supported || waiting} /> BEHIND A REVERSE PROXY</label>
        <p className="muted-copy">Only turn this on when a reverse proxy (for HTTPS, for example) is in front of the app on this Pi. Without one, any client could choose its own address and evade the sign-in rate limit.</p>
        <button className="neon-button" disabled={!info.supported || waiting || (Number(port) === info.port && trustProxy === info.trustProxy)}>SAVE AND RESTART</button>
      </form>
      {statusLine && <p role="status">{statusLine}</p>}
      {waiting && movedTo !== null && <p><a className="outline-button" href={addressOnPort(window.location, movedTo)}><ExternalLink /> OPEN {addressOnPort(window.location, movedTo)}</a></p>}
      <details className="update-log"><summary>Read-only settings</summary><pre>{[
        `NODE_ENV=${info.readOnly.nodeEnv ?? ""}`, `CASAMBI_MOCK_MODE=${info.readOnly.mockMode}`, `CASAMBI_DB_PATH=${info.readOnly.databasePath ?? "(default)"}`,
        `CASAMBI_CACHE_PATH=${info.readOnly.cachePath ?? "(default)"}`, `CASAMBI_PYTHON_COMMAND=${info.readOnly.pythonCommand ?? "(default)"}`,
      ].join("\n")}</pre></details>
    </>}
  </HudFrame>;
}
