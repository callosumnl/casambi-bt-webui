import { ArrowUpCircle, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { HudFrame } from "@/components/HudFrame";
import { t } from "@/lib/i18n";
import { LocalApi } from "@/lib/localApi";
import { describeUpdate, isUpdateBusy, type UpdateInfo } from "@/lib/updates";

/** Checks for and installs updates from the app; the Pi does the work in the background and restarts the service. */
export function UpdatePanel({ api, onNotice }: { api: LocalApi; onNotice: (message: string) => void }) {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const load = async () => {
    try { setInfo(await api.request<UpdateInfo>("/admin/update")); setUnreachable(false); }
    // During an update the service restarts; keep polling until it answers again (the page then reloads itself).
    catch { setUnreachable(true); }
  };
  useEffect(() => { void load(); }, []);
  const busy = info !== null && isUpdateBusy(info);
  useEffect(() => {
    if (!busy && !unreachable) return;
    const timer = window.setInterval(() => void load(), 3_000);
    return () => window.clearInterval(timer);
  }, [busy, unreachable]);

  const request = async (mode: "check" | "apply") => {
    if (mode === "apply" && !window.confirm(t("Update now? The service restarts on the new version; lights keep their state, but control is unavailable for a few minutes. If the update fails, the current version is restored."))) return;
    try { await api.request(`/admin/update/${mode}`, { method: "POST" }); await load(); }
    catch (error) { onNotice(error instanceof Error ? error.message : t("The update request failed.")); }
  };

  const view = info ? describeUpdate(info) : null;
  return <HudFrame className="form-panel update-panel"><h3><ArrowUpCircle /> {t("UPDATES")}</h3>
    {!info && !unreachable && <p className="muted-copy">{t("Loading…")}</p>}
    {unreachable && <p className="muted-copy">{t("The service is restarting, probably with a new version. This page reloads itself when it is back.")}</p>}
    {view && <>
      <p className="muted-copy">{view.running}</p>
      <p>{view.summary}</p>
      {view.changes.length > 0 && <ul className="update-changes">{view.changes.map((change, index) => <li key={`${index}-${change}`}>{change}</li>)}</ul>}
      {view.log && <details className="update-log"><summary>{t("Update log")}</summary><pre>{view.log}</pre></details>}
      {info?.supported && <div className="button-pair">
        <button className="outline-button" disabled={busy} onClick={() => void request("check")}><RefreshCw /> {info.pending.check || info.status.state === "checking" ? t("CHECKING…") : t("CHECK FOR UPDATES")}</button>
        {view.canApply && <button className="neon-button" disabled={busy} onClick={() => void request("apply")}><ArrowUpCircle /> {t("UPDATE NOW")}</button>}
      </div>}
    </>}
  </HudFrame>;
}
