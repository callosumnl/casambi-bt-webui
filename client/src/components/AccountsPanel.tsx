import { Trash2, Users } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import { getSession, LocalApi, LocalUser, Role } from "@/lib/localApi";

type Props = { api: LocalApi; onNotice: (message: string) => void };

/** Local accounts: create, change role, set a new password, delete. Your own account cannot be demoted or deleted here. */
export function AccountsPanel({ api, onNotice }: Props) {
  const [users, setUsers] = useState<LocalUser[]>([]);
  const [draft, setDraft] = useState({ username: "", password: "", role: "user" as Role });
  const [resetting, setResetting] = useState<number | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const myId = getSession()?.user.id;

  const load = async () => { try { setUsers(await api.request<LocalUser[]>("/admin/users")); } catch (error) { onNotice(error instanceof Error ? error.message : "Unable to load accounts."); } };
  useEffect(() => { void load(); }, []);
  const run = async (action: () => Promise<unknown>, done: string) => { try { await action(); onNotice(done); await load(); return true; } catch (error) { onNotice(error instanceof Error ? error.message : "The account change failed."); return false; } };

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (await run(() => api.request("/admin/users", { method: "POST", body: JSON.stringify(draft) }), `Account ${draft.username} created.`)) setDraft({ username: "", password: "", role: "user" });
  };
  const setRole = (user: LocalUser, role: Role) => void run(() => api.request(`/admin/users/${user.id}`, { method: "PATCH", body: JSON.stringify({ role }) }), `${user.username} is now ${role === "admin" ? "an admin" : "a user"}.`);
  const savePassword = async (event: FormEvent, user: LocalUser) => {
    event.preventDefault();
    if (await run(() => api.request(`/admin/users/${user.id}`, { method: "PATCH", body: JSON.stringify({ password: newPassword }) }), `New password set for ${user.username}.`)) { setResetting(null); setNewPassword(""); }
  };
  const remove = (user: LocalUser) => {
    if (!window.confirm(`Delete the account "${user.username}"? Its timers move to your account.`)) return;
    void run(() => api.request(`/admin/users/${user.id}`, { method: "DELETE" }), `${user.username} deleted.`);
  };

  return <section className="accounts-panel"><h3 className="subheading"><Users /> LOCAL ACCOUNTS</h3>
    <div className="away-set-list">{users.map(user => <article key={user.id}>
      <div><strong>{user.username}{user.id === myId ? " (you)" : ""}</strong><small>since {new Date(user.createdAt).toLocaleDateString()}</small></div>
      <div className="away-set-actions">
        <select aria-label={`Role of ${user.username}`} value={user.role} disabled={user.id === myId} onChange={event => setRole(user, event.target.value as Role)}><option value="user">user</option><option value="admin">admin</option></select>
        {resetting === user.id
          ? <form className="password-reset" onSubmit={event => void savePassword(event, user)}><input type="password" autoComplete="new-password" minLength={12} value={newPassword} onChange={event => setNewPassword(event.target.value)} placeholder="new password (12+)" aria-label={`New password for ${user.username}`} autoFocus /><button className="outline-button" disabled={newPassword.length < 12}>SET</button><button type="button" className="outline-button" onClick={() => { setResetting(null); setNewPassword(""); }}>CANCEL</button></form>
          : <button type="button" className="outline-button" onClick={() => { setResetting(user.id); setNewPassword(""); }}>NEW PASSWORD</button>}
        {user.id !== myId && <button type="button" className="icon-button danger" aria-label={`Delete account ${user.username}`} onClick={() => remove(user)}><Trash2 /></button>}
      </div>
    </article>)}</div>
    <form onSubmit={event => void create(event)} className="admin-form"><input required minLength={3} value={draft.username} onChange={event => setDraft({ ...draft, username: event.target.value })} placeholder="username" aria-label="New username" /><input required minLength={12} type="password" autoComplete="new-password" value={draft.password} onChange={event => setDraft({ ...draft, password: event.target.value })} placeholder="temporary password (12+)" aria-label="Temporary password" /><select value={draft.role} onChange={event => setDraft({ ...draft, role: event.target.value as Role })} aria-label="New account role"><option value="user">user</option><option value="admin">admin</option></select><button className="outline-button">CREATE ACCOUNT</button></form>
  </section>;
}
