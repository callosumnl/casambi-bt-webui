import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { applyDemoCommand, applyDemoRoomDefault, createDemoNetwork } from "@/lib/demoNetwork";
import { LocalApi, NetworkSnapshot } from "@/lib/localApi";

/** Fetches the real network or runs a fully in-memory anonymous demo without API or SSE access. */
export function useNetwork(demo = false) {
  const api = useMemo(() => new LocalApi(), []);
  const [network, setNetwork] = useState<NetworkSnapshot | null>(() => demo ? createDemoNetwork() : null);
  const [loading, setLoading] = useState(!demo);
  const [error, setError] = useState<string | null>(null);
  // While the event stream is open it delivers every post-command snapshot, so the POST can skip its duplicate body.
  const live = useRef(false);
  const lastCommandError = useRef<string | null>(null);

  /** Surfaces a failed control in the dashboard warning, and clears it again after the next successful control. */
  const reportCommand = useCallback((reason: unknown) => {
    const message = reason === undefined ? null : reason instanceof Error ? reason.message : "The lighting command failed.";
    const previous = lastCommandError.current;
    lastCommandError.current = message;
    setError(current => message ?? (current === previous ? null : current));
  }, []);

  const refresh = useCallback(async () => {
    if (demo) { setError(null); setNetwork(current => current ? { ...current, updatedAt: new Date().toISOString() } : createDemoNetwork()); setLoading(false); return; }
    try { setError(null); setNetwork(await api.request<NetworkSnapshot>("/network")); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to load the Casambi network."); }
    finally { setLoading(false); }
  }, [api, demo]);

  const command = useCallback(async (payload: unknown) => {
    if (demo) { setNetwork(current => current ? applyDemoCommand(current, payload) : current); return; }
    try {
      const next = await api.request<NetworkSnapshot | undefined>("/control", { method: "POST", body: JSON.stringify(payload), headers: live.current ? { Prefer: "return=minimal" } : {} });
      if (next) setNetwork(current => current ? { ...next, rooms: current.rooms } : next);
      reportCommand(undefined);
    } catch (reason) { reportCommand(reason); }
  }, [api, demo, reportCommand]);

  const applyRoomDefault = useCallback(async (roomId: number, fadeDurationMs = 0) => {
    if (demo) { setNetwork(current => current ? applyDemoRoomDefault(current, roomId) : current); return; }
    try {
      const next = await api.request<NetworkSnapshot>(`/rooms/${roomId}/apply-default`, { method: "POST", body: JSON.stringify({ fadeDurationMs }) });
      setNetwork(current => current ? { ...next, rooms: current.rooms } : next);
      reportCommand(undefined);
    } catch (reason) { reportCommand(reason); }
  }, [api, demo, reportCommand]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (demo) return;
    const source = new EventSource(api.eventUrl());
    source.onopen = () => { live.current = true; };
    source.addEventListener("unit.state", event => {
      const unit = (JSON.parse(event.data) as { payload: NetworkSnapshot["units"][number] }).payload;
      setNetwork(current => current ? { ...current, units: current.units.map(item => item.id === unit.id ? { ...item, ...unit } : item) } : current);
    });
    source.addEventListener("network.snapshot", event => {
      const snapshot = (JSON.parse(event.data) as { payload: NetworkSnapshot }).payload;
      setNetwork(current => ({ ...snapshot, rooms: current?.rooms ?? [] }));
    });
    source.onerror = () => { live.current = false; setError(current => current || "Live connection interrupted; reconnecting automatically."); };
    return () => { live.current = false; source.close(); };
  }, [api, demo]);

  return { network, loading, error, refresh, command, applyRoomDefault, api };
}
