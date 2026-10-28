import { Archive, Download, Upload } from "lucide-react";
import { FormEvent, useState } from "react";
import { HudFrame } from "@/components/HudFrame";
import { clearSession, LocalApi } from "@/lib/localApi";

/** Downloads everything on the Pi as one passphrase-protected file, and restores such a file (also on a new Pi). */
export function BackupPanel({ api, onNotice }: { api: LocalApi; onNotice: (message: string) => void }) {
  const [passphrase, setPassphrase] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [restorePassphrase, setRestorePassphrase] = useState("");
  const [busy, setBusy] = useState<"backup" | "restore" | null>(null);

  const download = async (event: FormEvent) => {
    event.preventDefault();
    if (passphrase !== confirmation) { onNotice("The two passphrases differ."); return; }
    setBusy("backup");
    try {
      // The backup file is JSON; its header stays in the same order, so it still opens after this round trip.
      const file = await api.request<{ header: { createdAt: string } }>("/admin/backup", { method: "POST", body: JSON.stringify({ passphrase }) });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(new Blob([JSON.stringify(file)], { type: "application/json" }));
      link.download = `casambi-backup-${file.header.createdAt.slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(link.href);
      setPassphrase(""); setConfirmation("");
      onNotice("Backup downloaded. Keep the file and its passphrase somewhere safe; the passphrase cannot be recovered.");
    } catch (error) { onNotice(error instanceof Error ? error.message : "The backup failed."); } finally { setBusy(null); }
  };

  const restore = async (event: FormEvent) => {
    event.preventDefault();
    if (!restoreFile) return;
    if (!window.confirm("Restore this backup? It replaces all accounts, settings, rooms, timers, and scenes on this Pi, and everyone has to sign in again with an account from the backup.")) return;
    setBusy("restore");
    try {
      const result = await api.request<{ restored: { createdAt: string; users: number; rooms: number; timers: number } }>("/admin/restore", { method: "POST", body: restoreFile, headers: { "Content-Type": "application/octet-stream", "X-Backup-Passphrase": restorePassphrase } });
      window.alert(`Backup from ${new Date(result.restored.createdAt).toLocaleString()} restored: ${result.restored.users} account(s), ${result.restored.rooms} room(s), ${result.restored.timers} timer(s). Sign in with an account from the backup.`);
      clearSession();
      window.location.assign("/");
    } catch (error) { onNotice(error instanceof Error ? error.message : "The restore failed."); setBusy(null); }
  };

  return <HudFrame className="form-panel"><h3><Archive /> BACKUP AND RESTORE</h3>
    <p className="muted-copy">One file with everything on this Pi: accounts, API keys, the Casambi settings (including the network password), rooms, names, timers, scenes, switch rules, and the audit log. It is encrypted with a passphrase you choose, so it can be restored on another Pi.</p>
    <form onSubmit={event => void download(event)} className="admin-form">
      <div className="form-grid"><label>PASSPHRASE<input type="password" value={passphrase} minLength={10} onChange={event => setPassphrase(event.target.value)} autoComplete="new-password" required /></label><label>REPEAT PASSPHRASE<input type="password" value={confirmation} minLength={10} onChange={event => setConfirmation(event.target.value)} autoComplete="new-password" required /></label></div>
      <button className="neon-button" disabled={busy !== null || passphrase.length < 10}><Download /> {busy === "backup" ? "PREPARING…" : "DOWNLOAD BACKUP"}</button>
    </form>
    <form onSubmit={event => void restore(event)} className="admin-form backup-restore">
      <label>BACKUP FILE<input type="file" accept=".json,application/json" onChange={event => setRestoreFile(event.target.files?.[0] ?? null)} required /></label>
      <label>ITS PASSPHRASE<input type="password" value={restorePassphrase} onChange={event => setRestorePassphrase(event.target.value)} autoComplete="off" required /></label>
      <button className="outline-button danger" disabled={busy !== null || !restoreFile || !restorePassphrase}><Upload /> {busy === "restore" ? "RESTORING…" : "RESTORE BACKUP"}</button>
    </form>
  </HudFrame>;
}
