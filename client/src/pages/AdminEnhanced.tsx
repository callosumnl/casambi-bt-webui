import { useMemo } from "react";
import { toast } from "sonner";
import { AwayDateSetsPanel } from "@/components/AwayDateSetsPanel";
import { SwitchRulesPanel } from "@/components/SwitchRulesPanel";
import { AuditLogPanel } from "@/components/AuditLogPanel";
import { LocalApi } from "@/lib/localApi";
import Admin from "./Admin";

/** Extends the Admin workspace with away-date sets, physical switch rules, and the audit log. */
export default function AdminEnhanced() {
  const api = useMemo(() => new LocalApi(), []);
  // These panels sit far below the Admin notice bar, so their messages appear as toasts, which are always in view.
  const notify = (message: string) => { toast(message); };
  return <><Admin /><div className="admin-page admin-away-sets"><AwayDateSetsPanel api={api} onNotice={notify} /></div><div className="admin-page admin-away-sets"><SwitchRulesPanel api={api} onNotice={notify} /></div><div className="admin-page admin-away-sets"><AuditLogPanel api={api} onNotice={notify} /></div></>;
}
