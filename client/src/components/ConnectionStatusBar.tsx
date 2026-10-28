import { AlertTriangle, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import type { ConnectionStatus } from "@/lib/localApi";
import { t } from "@/lib/i18n";

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
    return <p className="connection-status connecting" role="status"><span className="connection-pulse" aria-hidden="true" /> {t("CONNECTING TO THE CASAMBI NETWORK…")}{status.attempt > 1 ? ` ${t("ATTEMPT {attempt}", { attempt: status.attempt })}` : ""} <small>{t("This can take up to a minute.")}</small></p>;
  }
  if (status.phase === "retrying") {
    const seconds = Math.max(0, Math.ceil(((retryAt ?? 0) - now) / 1_000));
    return <p className="connection-status" role="status"><RefreshCw /> {t("CONNECTION FAILED")} — {seconds > 0 ? t("RETRYING IN {seconds} S", { seconds }) : t("RETRYING NOW…")} <small>{t("Attempt {attempt}: {error}", { attempt: status.attempt, error: status.lastError })}</small></p>;
  }
  return <p className="connection-status" role="alert"><AlertTriangle /> {t("NOT CONNECTED")} <small>{status.lastError}</small></p>;
}
