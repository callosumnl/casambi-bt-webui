import { AlertTriangle, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import type { ConnectionStatus } from "@/lib/localApi";

/** Shows a running connect, a pending automatic retry with a live countdown, or why the Pi gave up. Renders nothing when connected or idle. */
export function ConnectionStatusBar({ status }: { status: ConnectionStatus | null }) {
  const retryAt = status?.phase === "retrying" ? Date.parse(status.nextRetryAt) : null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (retryAt === null) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [retryAt]);
  if (!status || status.phase === "connected" || status.phase === "idle") return null;
  if (status.phase === "connecting") {
    return <p className="connection-status connecting" role="status"><span className="connection-pulse" aria-hidden="true" /> CONNECTING TO THE CASAMBI NETWORK…{status.attempt > 1 ? ` ATTEMPT ${status.attempt}` : ""} <small>This can take up to a minute.</small></p>;
  }
  if (status.phase === "retrying") {
    const seconds = Math.max(0, Math.ceil(((retryAt ?? 0) - now) / 1_000));
    return <p className="connection-status" role="status"><RefreshCw /> CONNECTION FAILED — {seconds > 0 ? `RETRYING IN ${seconds} S` : "RETRYING NOW…"} <small>Attempt {status.attempt}: {status.lastError}</small></p>;
  }
  return <p className="connection-status" role="alert"><AlertTriangle /> NOT CONNECTED <small>{status.lastError}</small></p>;
}
