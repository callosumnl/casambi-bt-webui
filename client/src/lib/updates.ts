import { t } from "@/lib/i18n";

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
  const running = t("Running version {version}{commit}.", { version: info.running.version ?? t("unknown"), commit });
  if (!info.supported) return { running, summary: t("Updating from the app is set up by running deploy/install.sh once more on the Pi (cd /opt/casambi-bt-webui && git pull && ./deploy/install.sh). After that, updates are one click here."), changes: [], log: null, canApply: false };
  const { status } = info;
  const checked = status.checkedAt ? ` ${t("Last checked {ago}.", { ago: ago(Date.parse(status.checkedAt), now) })}` : "";
  if (info.pending.apply || status.state === "updating") return { running, summary: t("Updating… The Pi is downloading and building the new version, then restarts the service. This takes a few minutes."), changes: [], log: null, canApply: false };
  if (status.state === "rolling_back") return { running, summary: status.message ?? t("The update failed; restoring the previous version…"), changes: [], log: status.logTail ?? null, canApply: false };
  if (info.pending.check || status.state === "checking") return { running, summary: t("Checking for updates…"), changes: [], log: null, canApply: false };
  switch (status.state) {
    case "available": return { running, summary: `${status.behind === 1 ? t("{count} new change available.", { count: 1 }) : t("{count} new changes available.", { count: String(status.behind) })}${checked}`, changes: status.changes ?? [], log: null, canApply: true };
    case "up_to_date": return { running, summary: `${t("This is the latest version.")}${checked}`, changes: [], log: null, canApply: false };
    case "updated": return { running, summary: status.message ?? t("Updated."), changes: [], log: null, canApply: false };
    case "rolled_back": case "failed": return { running, summary: status.message ?? t("The update failed."), changes: [], log: status.logTail ?? null, canApply: (status.behind ?? 0) > 0 };
    default: return { running, summary: t("Not checked yet. The Pi also checks once a day by itself."), changes: [], log: null, canApply: false };
  }
}

function ago(then: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - then) / 60_000));
  if (minutes < 1) return t("just now");
  if (minutes < 60) return t("{minutes} min ago", { minutes });
  const hours = Math.round(minutes / 60);
  const days = Math.round(hours / 24);
  return hours < 24 ? t("{hours} h ago", { hours }) : days === 1 ? t("{days} day ago", { days }) : t("{days} days ago", { days });
}
