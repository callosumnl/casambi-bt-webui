/** Mirrors `GET /admin/update`. */
export type UpdateInfo = {
  supported: boolean;
  running: { version: string | null; commit: string | null };
  pending: { check: boolean; apply: boolean };
  status: {
    state?: string; message?: string | null; current?: string | null; latest?: string | null; latestSubject?: string | null;
    behind?: number | null; changes?: string[]; checkedAt?: string | null; finishedAt?: string | null; logTail?: string | null;
  };
};

/** True while the Pi is (about to start) checking or updating, so the panel keeps polling. */
export function isUpdateBusy(info: UpdateInfo): boolean {
  return info.pending.check || info.pending.apply || ["checking", "updating", "rolling_back"].includes(info.status.state ?? "");
}

/** The panel's text for an update status, kept out of the component so every state is tested. */
export function describeUpdate(info: UpdateInfo, now = Date.now()): { running: string; summary: string; changes: string[]; log: string | null; canApply: boolean } {
  const commit = info.running.commit ? ` (${info.running.commit.slice(0, 7)})` : "";
  const running = `Running version ${info.running.version ?? "unknown"}${commit}.`;
  if (!info.supported) return { running, summary: "Updating from the app is set up by running deploy/install.sh once more on the Pi (cd /opt/casambi-bt-webui && git pull && ./deploy/install.sh). After that, updates are one click here.", changes: [], log: null, canApply: false };
  const { status } = info;
  const checked = status.checkedAt ? ` Last checked ${ago(Date.parse(status.checkedAt), now)}.` : "";
  if (info.pending.apply || status.state === "updating") return { running, summary: "Updating… The Pi is downloading and building the new version, then restarts the service. This takes a few minutes.", changes: [], log: null, canApply: false };
  if (status.state === "rolling_back") return { running, summary: status.message ?? "The update failed; restoring the previous version…", changes: [], log: status.logTail ?? null, canApply: false };
  if (info.pending.check || status.state === "checking") return { running, summary: "Checking for updates…", changes: [], log: null, canApply: false };
  switch (status.state) {
    case "available": return { running, summary: `${status.behind} new change${status.behind === 1 ? "" : "s"} available.${checked}`, changes: status.changes ?? [], log: null, canApply: true };
    case "up_to_date": return { running, summary: `This is the latest version.${checked}`, changes: [], log: null, canApply: false };
    case "updated": return { running, summary: status.message ?? "Updated.", changes: [], log: null, canApply: false };
    case "rolled_back": case "failed": return { running, summary: status.message ?? "The update failed.", changes: [], log: status.logTail ?? null, canApply: (status.behind ?? 0) > 0 };
    default: return { running, summary: "Not checked yet. The Pi also checks once a day by itself.", changes: [], log: null, canApply: false };
  }
}

function ago(then: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - then) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} day${Math.round(hours / 24) === 1 ? "" : "s"} ago`;
}
