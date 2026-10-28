import { RefreshCw, ScrollText } from "lucide-react";
import { useEffect, useState } from "react";
import { HudFrame } from "@/components/HudFrame";
import { t } from "@/lib/i18n";
import { AuditEntry, LocalApi } from "@/lib/localApi";

type Props = { api: LocalApi; onNotice: (message: string) => void };
const FILTERS = [
  ["", t("Everything")], ["bridge.", t("Bluetooth bridge")], ["lighting.", t("Lighting commands")], ["schedule.", t("Timers")], ["switch", t("Switches and rules")],
  ["scene.", t("Scenes")], ["auth.", t("Sign-ins")], ["user.", t("Accounts")], ["api_key.", t("API keys")], ["room.", t("Rooms")], ["notification.", t("Notifications")],
] as const;

/** Read-only view of the audit log, newest first, with a category filter. */
export function AuditLogPanel({ api, onNotice }: Props) {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [action, setAction] = useState("");
  const [limit, setLimit] = useState(100);
  const load = async () => {
    try { setEntries(await api.request<AuditEntry[]>(`/admin/audit?limit=${limit}${action ? `&action=${encodeURIComponent(action)}` : ""}`)); }
    catch (error) { onNotice(error instanceof Error ? error.message : t("Unable to load the audit log.")); }
  };
  useEffect(() => { void load(); }, [action, limit]);
  return <HudFrame className="form-panel audit-log"><h3><ScrollText /> {t("AUDIT LOG")}</h3>
    <div className="audit-controls">
      <select aria-label={t("Audit log category")} value={action} onChange={event => setAction(event.target.value)}>{FILTERS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
      <select aria-label={t("Number of entries")} value={limit} onChange={event => setLimit(Number(event.target.value))}>{[100, 250, 500].map(value => <option key={value} value={value}>{t("Last {count}", { count: value })}</option>)}</select>
      <button type="button" className="outline-button" onClick={() => void load()}><RefreshCw /> {t("REFRESH")}</button>
    </div>
    {entries.length === 0 ? <p className="muted-copy">{t("No entries.")}</p> : <div className="audit-table" role="table" aria-label={t("Audit log entries")}>{entries.map(entry => <div key={entry.id} role="row">
      <time role="cell" dateTime={entry.createdAt}>{new Date(entry.createdAt).toLocaleString()}</time>
      <span role="cell" className="audit-action">{entry.action}</span>
      <span role="cell" className="audit-actor">{entry.actor}</span>
      <code role="cell">{Object.keys(entry.detail).length ? JSON.stringify(entry.detail) : ""}</code>
    </div>)}</div>}
  </HudFrame>;
}
