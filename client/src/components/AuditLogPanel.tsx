import { RefreshCw, ScrollText } from "lucide-react";
import { useEffect, useState } from "react";
import { HudFrame } from "@/components/HudFrame";
import { AuditEntry, LocalApi } from "@/lib/localApi";

type Props = { api: LocalApi; onNotice: (message: string) => void };
const FILTERS = [
  ["", "Everything"], ["bridge.", "Bluetooth bridge"], ["lighting.", "Lighting commands"], ["schedule.", "Timers"], ["switch", "Switches and rules"],
  ["scene.", "Scenes"], ["auth.", "Sign-ins"], ["user.", "Accounts"], ["api_key.", "API keys"], ["room.", "Rooms"], ["notification.", "Notifications"],
] as const;

/** Read-only view of the audit log, newest first, with a category filter. */
export function AuditLogPanel({ api, onNotice }: Props) {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [action, setAction] = useState("");
  const [limit, setLimit] = useState(100);
  const load = async () => {
    try { setEntries(await api.request<AuditEntry[]>(`/admin/audit?limit=${limit}${action ? `&action=${encodeURIComponent(action)}` : ""}`)); }
    catch (error) { onNotice(error instanceof Error ? error.message : "Unable to load the audit log."); }
  };
  useEffect(() => { void load(); }, [action, limit]);
  return <HudFrame className="form-panel audit-log"><h3><ScrollText /> AUDIT LOG</h3>
    <div className="audit-controls">
      <select aria-label="Audit log category" value={action} onChange={event => setAction(event.target.value)}>{FILTERS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
      <select aria-label="Number of entries" value={limit} onChange={event => setLimit(Number(event.target.value))}>{[100, 250, 500].map(value => <option key={value} value={value}>Last {value}</option>)}</select>
      <button type="button" className="outline-button" onClick={() => void load()}><RefreshCw /> REFRESH</button>
    </div>
    {entries.length === 0 ? <p className="muted-copy">No entries.</p> : <div className="audit-table" role="table" aria-label="Audit log entries">{entries.map(entry => <div key={entry.id} role="row">
      <time role="cell" dateTime={entry.createdAt}>{new Date(entry.createdAt).toLocaleString()}</time>
      <span role="cell" className="audit-action">{entry.action}</span>
      <span role="cell" className="audit-actor">{entry.actor}</span>
      <code role="cell">{Object.keys(entry.detail).length ? JSON.stringify(entry.detail) : ""}</code>
    </div>)}</div>}
  </HudFrame>;
}
