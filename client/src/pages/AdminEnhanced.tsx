import { useMemo, useState } from "react";
import { AwayDateSetsPanel } from "@/components/AwayDateSetsPanel";
import { SwitchRulesPanel } from "@/components/SwitchRulesPanel";
import { LocalApi } from "@/lib/localApi";
import Admin from "./Admin";

/** Extends the established Admin workspace with reusable away-date sets and physical switch rules. */
export default function AdminEnhanced() {
  const api = useMemo(() => new LocalApi(), []);
  const [notice, setNotice] = useState("");
  return <><Admin />{notice && <div className="admin-page"><p className="form-notice">{notice}</p></div>}<div className="admin-page admin-away-sets"><AwayDateSetsPanel api={api} onNotice={setNotice} /></div><div className="admin-page admin-away-sets"><SwitchRulesPanel api={api} onNotice={setNotice} /></div></>;
}
