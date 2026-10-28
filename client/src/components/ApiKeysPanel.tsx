import { Copy, KeyRound, Plus } from "lucide-react";
import { FormEvent, Fragment, ReactNode, useEffect, useState } from "react";
import { Link } from "wouter";
import { HudFrame } from "@/components/HudFrame";
import { ApiKey, LocalApi, Role } from "@/lib/localApi";
import { t } from "@/lib/i18n";

type Props = { api: LocalApi; onNotice: (message: string) => void };

/** A translated sentence with markup in it: each `{name}` in the text becomes the element given for it. */
function withParts(text: string, parts: Record<string, ReactNode>): ReactNode[] {
  return text.split(/\{(\w+)\}/).map((piece, index) => index % 2 ? <Fragment key={index}>{parts[piece]}</Fragment> : piece);
}

/** Create, list, and revoke the keys external tools use for the REST API (header X-API-Key). */
export function ApiKeysPanel({ api, onNotice }: Props) {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [label, setLabel] = useState("");
  const [role, setRole] = useState<Role>("user");
  const [expiresInDays, setExpiresInDays] = useState("");
  const [created, setCreated] = useState<{ label: string; token: string } | null>(null);

  const load = async () => { try { setKeys(await api.request<ApiKey[]>("/admin/api-keys")); } catch (error) { onNotice(error instanceof Error ? error.message : t("Unable to load API keys.")); } };
  useEffect(() => { void load(); }, []);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const key = await api.request<ApiKey & { token: string }>("/admin/api-keys", { method: "POST", body: JSON.stringify({ label, role, ...(expiresInDays ? { expiresInDays: Number(expiresInDays) } : {}) }) });
      setCreated({ label: key.label, token: key.token }); setLabel("");
      onNotice(t("Copy the new API key now. It is shown only once."));
      await load();
    } catch (error) { onNotice(error instanceof Error ? error.message : t("Unable to create API key.")); }
  };
  const revoke = async (key: ApiKey) => {
    if (!window.confirm(t("Revoke \"{label}\"? Tools using this key lose access immediately.", { label: key.label }))) return;
    try { await api.request(`/admin/api-keys/${key.id}`, { method: "DELETE" }); onNotice(t("{label} revoked.", { label: key.label })); await load(); }
    catch (error) { onNotice(error instanceof Error ? error.message : t("Unable to revoke API key.")); }
  };
  const copy = async (token: string) => { try { await navigator.clipboard.writeText(token); onNotice(t("API key copied.")); } catch { onNotice(t("Select the key and copy it manually.")); } };
  const date = (value: string | null) => value ? new Date(value).toLocaleString() : t("never");

  return <HudFrame className="form-panel api-keys"><h3><KeyRound /> {t("REST API KEYS")}</h3>
    <p className="muted-copy">{withParts(t("Keys let tools such as Home Assistant use the REST API with the header {header}. A {user} key can control lights and scenes; an {admin} key can also change settings. See the {docs}."), { header: <code>X-API-Key</code>, user: <b>{t("user")}</b>, admin: <b>{t("admin")}</b>, docs: <Link href="/api">{t("API documentation")}</Link> })}</p>
    <form onSubmit={event => void create(event)} className="admin-form"><div className="form-grid"><label>{t("LABEL")}<input value={label} onChange={event => setLabel(event.target.value)} placeholder={t("e.g. {value}", { value: "Home Assistant" })} maxLength={96} required /></label><label>{t("ROLE")}<select value={role} onChange={event => setRole(event.target.value as Role)}><option value="user">{t("User: control lights")}</option><option value="admin">{t("Admin: full access")}</option></select></label><label>{t("VALID FOR")}<select value={expiresInDays} onChange={event => setExpiresInDays(event.target.value)}><option value="">{t("No expiry")}</option><option value="30">{t("{n} days", { n: 30 })}</option><option value="90">{t("{n} days", { n: 90 })}</option><option value="365">{t("1 year")}</option></select></label></div><button className="neon-button" disabled={!label.trim()}><Plus /> {t("CREATE API KEY")}</button></form>
    {created && <div className="api-key-created" role="status"><p>{withParts(t("New key for {label}; it is shown only once:"), { label: <b>{created.label}</b> })}</p><code className="secret-output">{created.token}</code><button type="button" className="outline-button" onClick={() => void copy(created.token)}><Copy /> {t("COPY")}</button></div>}
    <div className="away-set-list">{keys.length === 0 ? <p className="muted-copy">{t("No API keys yet.")}</p> : keys.map(key => <article key={key.id} className={key.revokedAt ? "revoked" : ""}><div><strong>{key.label}</strong><small>{(key.role === "admin" ? t("admin") : t("user")).toUpperCase()} · {key.prefix}… · {t("created {date}", { date: date(key.createdAt) })} · {t("last used {date}", { date: date(key.lastUsedAt) })}{key.revokedAt ? ` · ${t("revoked {date}", { date: date(key.revokedAt) })}` : ""}{!key.revokedAt && key.expiresAt ? ` · ${Date.parse(key.expiresAt) <= Date.now() ? t("expired {date}", { date: date(key.expiresAt) }) : t("expires {date}", { date: date(key.expiresAt) })}` : ""}</small></div>{!key.revokedAt && <div className="away-set-actions"><button type="button" className="outline-button danger" onClick={() => void revoke(key)}>{t("REVOKE")}</button></div>}</article>)}</div>
  </HudFrame>;
}
