import { useCallback, useEffect, useMemo, useState } from "react";
import { LocalApi, NetworkSnapshot } from "@/lib/localApi";

/** Fetches the current state and reconciles SSE updates without manual refreshes. */
export function useNetwork() {
  const api = useMemo(() => new LocalApi(), []);
  const [network, setNetwork] = useState<NetworkSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try { setError(null); setNetwork(await api.request<NetworkSnapshot>("/network")); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to load the Casambi network."); }
    finally { setLoading(false); }
  }, [api]);

  const command = useCallback(async (payload: unknown) => {
    const next = await api.request<NetworkSnapshot>("/control", { method: "POST", body: JSON.stringify(payload) });
    setNetwork(current => current ? { ...next, rooms: current.rooms } : next);
  }, [api]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const source = new EventSource(api.eventUrl());
    source.addEventListener("unit.state", event => {
      const unit = (JSON.parse(event.data) as { payload: NetworkSnapshot["units"][number] }).payload;
      setNetwork(current => current ? { ...current, units: current.units.map(item => item.id === unit.id ? { ...item, ...unit } : item) } : current);
    });
    source.addEventListener("network.snapshot", event => {
      const snapshot = (JSON.parse(event.data) as { payload: NetworkSnapshot }).payload;
      setNetwork(current => ({ ...snapshot, rooms: current?.rooms ?? [] }));
    });
    source.onerror = () => setError(current => current || "Live connection interrupted; reconnecting automatically.");
    return () => source.close();
  }, [api]);

  return { network, loading, error, refresh, command, api };
}
