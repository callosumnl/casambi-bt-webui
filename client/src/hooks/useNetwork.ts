import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConnectionStatus, LocalApi, LocalScene, NetworkSnapshot, SceneScope } from "@/lib/localApi";

/** Loads the Casambi network and saved scenes, keeps them live over SSE, and sends controls. */
export function useNetwork() {
  const api = useMemo(() => new LocalApi(), []);
  const [network, setNetwork] = useState<NetworkSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connection, setConnection] = useState<ConnectionStatus | null>(null);
  const [scenes, setScenes] = useState<LocalScene[]>([]);
  // While the event stream is open it delivers every post-command snapshot, so the POST can skip its duplicate body.
  const live = useRef(false);
  const lastCommandError = useRef<string | null>(null);
  const LIVE_LOST = "Live connection interrupted; reconnecting automatically.";

  /** Surfaces a failed control in the dashboard warning, and clears it again after the next successful control. */
  const reportCommand = useCallback((reason: unknown) => {
    const message = reason === undefined ? null : reason instanceof Error ? reason.message : "The lighting command failed.";
    const previous = lastCommandError.current;
    lastCommandError.current = message;
    setError(current => message ?? (current === previous ? null : current));
  }, []);

  /** Loads the server's cached state instantly; `fresh` asks the bridge instead (explicit sync buttons). */
  const refresh = useCallback(async (fresh = false) => {
    try { setError(null); const next = await api.request<NetworkSnapshot & { connection?: ConnectionStatus }>(fresh ? "/network?fresh=1" : "/network"); setNetwork(next); if (next.connection) setConnection(next.connection); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to load the Casambi network."); }
    finally { setLoading(false); }
  }, [api]);

  const command = useCallback(async (payload: unknown) => {
    try {
      const next = await api.request<NetworkSnapshot | undefined>("/control", { method: "POST", body: JSON.stringify(payload), headers: live.current ? { Prefer: "return=minimal" } : {} });
      if (next) setNetwork(current => current ? { ...next, rooms: current.rooms } : next);
      reportCommand(undefined);
    } catch (reason) { reportCommand(reason); }
  }, [api, reportCommand]);

  const applyRoomDefault = useCallback(async (roomId: number, fadeDurationMs = 0) => {
    try {
      const next = await api.request<NetworkSnapshot>(`/rooms/${roomId}/apply-default`, { method: "POST", body: JSON.stringify({ fadeDurationMs }) });
      setNetwork(current => current ? { ...next, rooms: current.rooms } : next);
      reportCommand(undefined);
    } catch (reason) { reportCommand(reason); }
  }, [api, reportCommand]);

  const loadScenes = useCallback(async () => {
    try { setScenes(await api.request<LocalScene[]>("/local-scenes")); } catch { /* Scenes are optional; the controls still work without them. */ }
  }, [api]);

  /** Runs a scene mutation, then reloads the list; failures show in the dashboard warning. */
  const changeScenes = useCallback(async (path: string, init: RequestInit) => {
    try { await api.request(path, init); await loadScenes(); reportCommand(undefined); } catch (reason) { reportCommand(reason); }
  }, [api, loadScenes, reportCommand]);

  /** Saves the current setting of a group, room, or all lamps as a named scene. */
  const saveScene = useCallback((name: string, scope: SceneScope) => changeScenes("/local-scenes", { method: "POST", body: JSON.stringify({ name, scope }) }), [changeScenes]);
  /** Overwrites a scene with the current setting of its group. */
  const updateScene = useCallback((id: number) => changeScenes(`/local-scenes/${id}/capture`, { method: "POST" }), [changeScenes]);
  const renameScene = useCallback((id: number, name: string) => changeScenes(`/local-scenes/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }), [changeScenes]);
  const deleteScene = useCallback((id: number) => changeScenes(`/local-scenes/${id}`, { method: "DELETE" }), [changeScenes]);
  const applyScene = useCallback((id: number) => command({ targetType: "local_scene", targetId: id, operation: "activate_scene" }), [command]);

  useEffect(() => { void refresh(); void loadScenes(); }, [refresh, loadScenes]);
  useEffect(() => {
    let source: EventSource | undefined;
    let reopen: number | undefined;
    let lost = false;
    let closed = false;
    const open = async () => {
      let url: string;
      // A failed ticket request with an expired session ends it (LocalApi); otherwise try again shortly.
      try { url = await api.eventUrl(); } catch { if (!closed) reopen = window.setTimeout(() => void open(), 5_000); return; }
      if (closed) return;
      source = new EventSource(url);
      source.onopen = () => {
        live.current = true;
        // Changes made while the stream was down (other users, timers, switches) were missed: fetch them.
        if (lost) { lost = false; setError(current => current === LIVE_LOST ? null : current); void refresh(); }
      };
      source.addEventListener("unit.state", event => {
        const unit = (JSON.parse(event.data) as { payload: NetworkSnapshot["units"][number] }).payload;
        setNetwork(current => current ? { ...current, units: current.units.map(item => item.id === unit.id ? { ...item, ...unit } : item) } : current);
      });
      source.addEventListener("local_scenes.changed", () => void loadScenes());
      source.addEventListener("connection.status", event => { setConnection((JSON.parse(event.data) as { payload: ConnectionStatus }).payload); });
      source.addEventListener("network.snapshot", event => {
        const snapshot = (JSON.parse(event.data) as { payload: NetworkSnapshot }).payload;
        setNetwork(current => ({ ...snapshot, rooms: current?.rooms ?? [] }));
      });
      source.onerror = () => {
        live.current = false; lost = true;
        setError(current => current || LIVE_LOST);
        // The browser retries by itself, except after a non-200 answer (e.g. an expired ticket or a rate limit).
        // Then open a new stream with a new ticket a little later; fetching it also checks the session.
        if (source?.readyState === EventSource.CLOSED) reopen = window.setTimeout(() => void open(), 5_000);
      };
    };
    void open();
    return () => { closed = true; live.current = false; window.clearTimeout(reopen); source?.close(); };
  }, [api, loadScenes, refresh]);

  return { network, loading, error, connection, refresh, command, applyRoomDefault, scenes, saveScene, updateScene, renameScene, deleteScene, applyScene, api };
}
