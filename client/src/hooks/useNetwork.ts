import { useCallback, useEffect, useMemo, useState } from "react";
import { applyDemoCommand, createDemoNetwork } from "@/lib/demoNetwork";
import { LocalApi, NetworkSnapshot } from "@/lib/localApi";

/** Fetches the real network or runs a fully in-memory anonymous demo without API or SSE access. */
export function useNetwork(demo = false) {
  const api = useMemo(() => new LocalApi(), []);
  const [network, setNetwork] = useState<NetworkSnapshot | null>(() => demo ? createDemoNetwork() : null);
  const [loading, setLoading] = useState(!demo);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (demo) {
      setError(null);
      setNetwork(current => current ? { ...current, updatedAt: new Date().toISOString() } : createDemoNetwork());
      setLoading(false);
      return;
    }
    try { setError(null); setNetwork(await api.request<NetworkSnapshot>("/network")); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to load the Casambi network."); }
    finally { setLoading(false); }
  }, [api, demo]);

  const command = useCallback(async (payload: unknown) => {
    if (demo) {
      setNetwork(current => current ? applyDemoCommand(current, payload) : current);
      return;
    }
    const next = await api.request<NetworkSnapshot>("/control", { method: "POST", body: JSON.stringify(payload) });
    setNetwork(current => current ? { ...next, rooms: current.rooms } : next);
  }, [api, demo]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (demo) return;
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
  }, [api, demo]);

  return { network, loading, error, refresh, command, api };
}
