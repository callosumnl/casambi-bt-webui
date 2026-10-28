import { Trash2, Users } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import { getSession, LocalApi, LocalUser, Role } from "@/lib/localApi";
import { t } from "@/lib/i18n";

type Props = { api: LocalApi; onNotice: (message: string) => void };

/** Local accounts: create, change role, set a new password, delete. Your own account cannot be demoted or deleted here. */
export function AccountsPanel({ api, onNotice }: Props) {
  const [users, setUsers] = useState<LocalUser[]>([]);
  const [draft, setDraft] = useState({ username: "", password: "", role: "user" as Role });
  const [resetting, setResetting] = useState<number | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const myId = getSession()?.user.id;

  const load = async () => { try { setUsers(await api.request<LocalUser[]>("/admin/users")); } catch (error) { onNotice(error instanceof Error ? error.message : t("Unable to load accounts.")); } };
  useEffect(() => { void load(); }, []);
  const run = async (action: () => Promise<unknown>, done: string) => { try { await action(); onNotice(done); await load(); return true; } catch (error) { onNotice(error instanceof Error ? error.message : t("The account change failed.")); return false; } };

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (await run(() => api.request("/admin/users", { method: "POST", body: JSON.stringify(draft) }), t("Account {username} created.", { username: draft.username }))) setDraft({ username: "", password: "", role: "user" });
  };
  const setRole = (user: LocalUser, role: Role) => void run(() => api.request(`/admin/users/${user.id}`, { method: "PATCH", body: JSON.stringify({ role }) }), role === "admin" ? t("{username} is now an admin.", { username: user.username }) : t("{username} is now a user.", { username: user.username }));
  const savePassword = async (event: FormEvent, user: LocalUser) => {
    event.preventDefault();
    if (await run(() => api.request(`/admin/users/${user.id}`, { method: "PATCH", body: JSON.stringify({ password: newPassword }) }), t("New password set for {username}.", { username: user.username }))) { setResetting(null); setNewPassword(""); }
  };
  const remove = (user: LocalUser) => {
    if (!window.confirm(t("Delete the account \"{username}\"? Its timers move to your account.", { username: user.username }))) return;
    void run(() => api.request(`/admin/users/${user.id}`, { method: "DELETE" }), t("{name} deleted.", { name: user.username }));
  };

  return <section className="accounts-panel"><h3 className="subheading"><Users /> {t("LOCAL ACCOUNTS")}</h3>
    <div className="away-set-list">{users.map(user => <article key={user.id}>
      <div><strong>{user.username}{user.id === myId ? ` ${t("(you)")}` : ""}</strong><small>{t("since {date}", { date: new Date(user.createdAt).toLocaleDateString() })}</small></div>
      <div className="away-set-actions">
        <select aria-label={t("Role of {username}", { username: user.username })} value={user.role} disabled={user.id === myId} onChange={event => setRole(user, event.target.value as Role)}><option value="user">{t("user")}</option><option value="admin">{t("admin")}</option></select>
        {resetting === user.id
          ? <form className="password-reset" onSubmit={event => void savePassword(event, user)}><input type="password" autoComplete="new-password" minLength={12} value={newPassword} onChange={event => setNewPassword(event.target.value)} placeholder={t("new password (12+)")} aria-label={t("New password for {username}", { username: user.username })} autoFocus /><button className="outline-button" disabled={newPassword.length < 12}>{t("SET")}</button><button type="button" className="outline-button" onClick={() => { setResetting(null); setNewPassword(""); }}>{t("CANCEL")}</button></form>
          : <button type="button" className="outline-button" onClick={() => { setResetting(user.id); setNewPassword(""); }}>{t("NEW PASSWORD")}</button>}
        {user.id !== myId && <button type="button" className="icon-button danger" aria-label={t("Delete account {username}", { username: user.username })} onClick={() => remove(user)}><Trash2 /></button>}
      </div>
    </article>)}</div>
    <form onSubmit={event => void create(event)} className="admin-form"><input required minLength={3} value={draft.username} onChange={event => setDraft({ ...draft, username: event.target.value })} placeholder={t("username")} aria-label={t("New username")} /><input required minLength={12} type="password" autoComplete="new-password" value={draft.password} onChange={event => setDraft({ ...draft, password: event.target.value })} placeholder={t("temporary password (12+)")} aria-label={t("Temporary password")} /><select value={draft.role} onChange={event => setDraft({ ...draft, role: event.target.value as Role })} aria-label={t("New account role")}><option value="user">{t("user")}</option><option value="admin">{t("admin")}</option></select><button className="outline-button">{t("CREATE ACCOUNT")}</button></form>
  </section>;
}
