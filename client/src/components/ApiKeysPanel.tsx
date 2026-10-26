import { Copy, KeyRound, Plus } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import { Link } from "wouter";
import { HudFrame } from "@/components/HudFrame";
import { ApiKey, LocalApi, Role } from "@/lib/localApi";

type Props = { api: LocalApi; onNotice: (message: string) => void };

/** Create, list, and revoke the keys external tools use for the REST API (header X-API-Key). */
export function ApiKeysPanel({ api, onNotice }: Props) {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [label, setLabel] = useState("");
  const [role, setRole] = useState<Role>("user");
  const [expiresInDays, setExpiresInDays] = useState("");
  const [created, setCreated] = useState<{ label: string; token: string } | null>(null);

  const load = async () => { try { setKeys(await api.request<ApiKey[]>("/admin/api-keys")); } catch (error) { onNotice(error instanceof Error ? error.message : "Unable to load API keys."); } };
  useEffect(() => { void load(); }, []);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const key = await api.request<ApiKey & { token: string }>("/admin/api-keys", { method: "POST", body: JSON.stringify({ label, role, ...(expiresInDays ? { expiresInDays: Number(expiresInDays) } : {}) }) });
      setCreated({ label: key.label, token: key.token }); setLabel("");
      onNotice("Copy the new API key now. It is shown only once.");
      await load();
    } catch (error) { onNotice(error instanceof Error ? error.message : "Unable to create API key."); }
  };
  const revoke = async (key: ApiKey) => {
    if (!window.confirm(`Revoke "${key.label}"? Tools using this key lose access immediately.`)) return;
    try { await api.request(`/admin/api-keys/${key.id}`, { method: "DELETE" }); onNotice(`${key.label} revoked.`); await load(); }
    catch (error) { onNotice(error instanceof Error ? error.message : "Unable to revoke API key."); }
  };
  const copy = async (token: string) => { try { await navigator.clipboard.writeText(token); onNotice("API key copied."); } catch { onNotice("Select the key and copy it manually."); } };
  const date = (value: string | null) => value ? new Date(value).toLocaleString() : "never";

  return <HudFrame className="form-panel api-keys"><h3><KeyRound /> REST API KEYS</h3>
    <p className="muted-copy">Keys let tools such as Home Assistant use the REST API with the header <code>X-API-Key</code>. A <b>user</b> key can control lights and scenes; an <b>admin</b> key can also change settings. See the <Link href="/api">API documentation</Link>.</p>
    <form onSubmit={event => void create(event)} className="admin-form"><div className="form-grid"><label>LABEL<input value={label} onChange={event => setLabel(event.target.value)} placeholder="e.g. Home Assistant" maxLength={96} required /></label><label>ROLE<select value={role} onChange={event => setRole(event.target.value as Role)}><option value="user">User: control lights</option><option value="admin">Admin: full access</option></select></label><label>VALID FOR<select value={expiresInDays} onChange={event => setExpiresInDays(event.target.value)}><option value="">No expiry</option><option value="30">30 days</option><option value="90">90 days</option><option value="365">1 year</option></select></label></div><button className="neon-button" disabled={!label.trim()}><Plus /> CREATE API KEY</button></form>
    {created && <div className="api-key-created" role="status"><p>New key for <b>{created.label}</b>; it is shown only once:</p><code className="secret-output">{created.token}</code><button type="button" className="outline-button" onClick={() => void copy(created.token)}><Copy /> COPY</button></div>}
    <div className="away-set-list">{keys.length === 0 ? <p className="muted-copy">No API keys yet.</p> : keys.map(key => <article key={key.id} className={key.revokedAt ? "revoked" : ""}><div><strong>{key.label}</strong><small>{key.role.toUpperCase()} · {key.prefix}… · created {date(key.createdAt)} · last used {date(key.lastUsedAt)}{key.revokedAt ? ` · revoked ${date(key.revokedAt)}` : ""}{!key.revokedAt && key.expiresAt ? ` · ${Date.parse(key.expiresAt) <= Date.now() ? "expired" : "expires"} ${date(key.expiresAt)}` : ""}</small></div>{!key.revokedAt && <div className="away-set-actions"><button type="button" className="outline-button danger" onClick={() => void revoke(key)}>REVOKE</button></div>}</article>)}</div>
  </HudFrame>;
}
